#!/usr/bin/env bun
import { cac } from "cac";
import { configureCliHelp } from "./cli-help.ts";
import { downloadArchiveMedia } from "./archive-media.ts";
import {
  resolveBatchConvertOptions,
  resolveChatsOptions,
  resolveCollectOptions,
  resolveDownloadOptions,
  resolveDatabaseExportOptions,
  resolveDatabaseMediaOptions,
  resolveConvertOptions,
  resolveLoginOptions,
  resolveMediaOptions,
} from "./command-validation.ts";
import {
  commandDefaults,
  collectionBackupSuffix,
  collectionLogSuffix,
  defaultOutputFormat,
  defaultPageDelay,
  loginTimeout,
} from "./config.ts";
import { convertAllArchives } from "./convert-all.ts";
import { convertArchive } from "./convert.ts";
import { openCollectionLog, writeCommandContext } from "./collection-log.ts";
import {
  defaultCollectionPath,
  findDefaultCollection,
} from "./collection-path.ts";
import { downloadChat } from "./download.ts";
import {
  collectChats,
  collectHistory,
  type CollectionEvent,
} from "./collect.ts";
import { exportDatabase, exportSavedChats } from "./database-export.ts";
import { downloadDatabaseMedia } from "./database-media.ts";
import { loadCredentials } from "./credentials.ts";
import {
  type ChatNames,
  collectionSummary,
  exportSummary,
  imagesSummary,
  savedChatsExportSummary,
} from "./cli-summary.ts";
import { AppError, errorMessage } from "./errors.ts";
import { HistoryStore } from "./history-store.ts";
import type { ExportProgressEvent } from "./export.ts";
import { createHttp, requestStats, type ImageResponseError } from "./http.ts";
import type { MediaProgress } from "./media.ts";
import { writeChatList } from "./output.ts";
import { historyProgress, listChats } from "./teams.ts";

export async function runCli(argv = process.argv): Promise<number> {
  const cli = cac("teams");
  let collectionLog: ReturnType<typeof openCollectionLog>;
  const output = (message: string) => {
    console.log(message);
    collectionLog?.write(message);
  };
  const warning = (message: string) => {
    console.warn(message);
    collectionLog?.write(message);
  };
  let operation = "collect";
  // People get a readable summary; the full result stays in the invocation log.
  const finish = (result: unknown, summary: string[]) => {
    collectionLog?.write(`[${operation}] Result: ${JSON.stringify(result)}`);
    for (const line of summary) output(line);
  };
  const startLog = (
    command: string,
    options: { db: string; log?: boolean } & Record<string, unknown>,
    input: Record<string, unknown>,
  ) => {
    operation = command;
    if (options.log) {
      collectionLog = openCollectionLog(options.db, (message) =>
        console.warn(message),
      );
      if (collectionLog) {
        writeCommandContext(collectionLog, command, input, options);
        output(`[log] Collection log: ${collectionLog.path}`);
      }
    }
    output(`[${command}] Started; database: ${options.db}`);
  };
  const stats = requestStats();
  const progress = historyProgress();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const http = createHttp({ stats, signal: controller.signal });
  const reportProgress = (event: ExportProgressEvent) => {
    switch (event.type) {
      case "history": {
        const reach = event.earliestTimestamp
          ? ` — reached ${event.earliestTimestamp}`
          : "";
        const status = event.hasMore ? "" : " (history complete)";
        output(
          `[history] Page ${event.page}: ${event.pageMessages} messages (total: ${event.totalMessages})${reach}${status}`,
        );
        break;
      }
      case "media-start":
        output(`[media] Found ${event.total} image(s); processing...`);
        break;
      case "media-progress": {
        const outcome =
          event.outcome === "failed"
            ? `failed: ${event.reason}`
            : {
                cache: "reused from local cache",
                revalidated:
                  "revalidated with Teams: HTTP 304; reused cached bytes",
                downloaded: "downloaded: HTTP 200",
              }[event.outcome];
        output(`[media] Image ${event.current}/${event.total} (${outcome})`);
        break;
      }
      case "save":
        output(`[export] Saved JSON archive: ${event.destination}`);
        break;
      case "convert":
        output("[convert] Converted to Markdown.");
        break;
    }
  };
  const reportDatabaseMedia = (
    event: MediaProgress | { phase: "summary"; message: string },
  ) => {
    if (event.phase === "summary") output(event.message);
    else if (event.phase === "start")
      reportProgress({ type: "media-start", total: event.total });
    else {
      const { phase: _phase, ...progress } = event;
      reportProgress({
        type: "media-progress",
        ...progress,
      });
    }
  };
  const reportCollection = (event: CollectionEvent) => {
    if (event.type === "warning") warning(event.message);
    else if (event.type === "chat")
      output(
        `[collect] Chat ${event.current}/${event.total}: ${JSON.stringify(event.chatId)}`,
      );
    else if (event.type === "chat-complete")
      output(
        `[collect] Chat ${JSON.stringify(event.chatId)} complete: ${event.addedMessages} new messages; ${event.completedWindows} windows saved.`,
      );
    else if (event.type === "coverage") {
      output(
        `[collect] Resolved range: ${event.from} to ${event.toExclusive} (exclusive)`,
      );
      output(
        `[collect] Already collected: ${event.alreadyCollectedMilliseconds} ms; remaining intervals: ${event.remainingIntervals}.`,
      );
      if (event.remainingIntervals === 0)
        output(
          "[collect] Requested range already collected; no history requests needed.",
        );
    } else if (event.type === "window")
      output(`[collect] ${event.from} to ${event.toExclusive} (exclusive)`);
    else if (event.type === "history")
      reportProgress({ type: "history", ...event.progress });
    else if (event.type === "backup") {
      if (event.status === "database")
        output("[backup] Snapshotting and verifying database...");
      else if (event.status === "finalizing")
        output("[backup] Writing manifest and syncing snapshot...");
      else if (event.status === "saved")
        output(
          `[backup] Saved verified snapshot: ${event.path} (${(event.durationMs / 1000).toFixed(1)}s)`,
        );
      else
        warning(
          `[backup] Snapshot failed. ${event.reason} Existing backups kept; collection continues.`,
        );
    } else
      output(
        `[collect] Checkpoint saved: ${event.messages} messages (${event.added} new).`,
      );
  };
  cli
    .command("login", "Sign in through a browser and save credentials")
    .option(
      "--wait-for-media",
      "Wait for an image cookie before saving credentials",
    )
    .option(
      "--credentials <file>",
      "Credential destination (default: per-user state file)",
    )
    .option(
      "--browser <path>",
      "Chromium executable (default: detect installed Chromium/Chrome/Edge)",
    )
    .option(
      "--browser-profile <dir>",
      "Dedicated persistent Teams browser profile",
    )
    .option(
      "--timeout <seconds>",
      `Login time budget, ${loginTimeout.min}–${loginTimeout.max} seconds (default: ${loginTimeout.default})`,
    )
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const { login } = await import("./login.ts");
      const result = await login(resolveLoginOptions(input), {
        stats,
        signal: controller.signal,
        progress: (message) => console.log(message),
      });
      console.log(JSON.stringify(result));
    });
  cli
    .command("media", "Download images into an existing JSON archive")
    .option("--input <file>", "Existing version 1 JSON export to update")
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option("--refresh-media", "Revalidate cached images with Teams")
    .option("--no-markdown", "Skip regenerating sibling Markdown", {
      default: commandDefaults.markdown,
    })
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const options = resolveMediaOptions(input);
      const credentials = await loadCredentials(options.credentials);
      const result = await downloadArchiveMedia(
        options,
        credentials,
        http,
        stats,
        controller.signal,
        reportProgress,
      );
      console.log(JSON.stringify(result));
    });
  cli
    .command("convert", "Render Markdown from an existing JSON archive")
    .option("--input <file>", "Existing version 1 JSON export")
    .option(
      "--format <format>",
      `Output format (default: ${defaultOutputFormat})`,
    )
    .option(
      "--out <file>",
      "Markdown destination (default: beside JSON); never overwritten",
    )
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const options = resolveConvertOptions(input);
      console.log(
        JSON.stringify(await convertArchive(options, controller.signal)),
      );
    });
  cli
    .command(
      "convert-all",
      "Render missing Markdown transcripts in an export folder",
    )
    .option(
      "--dir <directory>",
      "Directory of JSON exports (default: exports under TEAMS_DATA_DIR or cwd)",
    )
    .option(
      "--recursive",
      "Include JSON files beyond the standard export layouts",
    )
    .option(
      "--format <format>",
      `Output format (default: ${defaultOutputFormat})`,
    )
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const result = await convertAllArchives(
        resolveBatchConvertOptions(input),
        controller.signal,
      );
      console.log(JSON.stringify(result));
      if (result.failed > 0)
        throw new AppError(
          `${result.failed} JSON export(s) could not be converted; see failed files in the stdout summary.`,
        );
    });
  cli
    .command("chats", "List chat names and IDs as JSON")
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option("--out <file>", "Save or refresh the chat list as JSON")
    .option(
      "--refresh-names",
      "Refresh participant names instead of using cached profiles",
    )
    .action(async (raw: Record<string, unknown>) => {
      const options = resolveChatsOptions(raw);
      const credentials = await loadCredentials(options.credentials);
      const chats = await listChats(http, credentials, {
        refresh: options.refreshNames === true,
        warn: (message) => console.warn(message),
        signal: controller.signal,
      });
      if (options.out !== undefined) {
        const path = await writeChatList(options.out, chats, controller.signal);
        console.log(`Saved chat list to ${path}.`);
      }
      console.log(JSON.stringify(chats, null, 2));
    });
  cli
    .command("download", "Collect messages and images, then export in one step")
    .option("--db <file>", "Override the account or TEAMS_DATA_DIR database")
    .option(
      "--no-log",
      `Disable private logs in <database>${collectionLogSuffix}/`,
      {
        default: commandDefaults.log,
      },
    )
    .option(
      "--backup-dir <directory>",
      `Database snapshot folder (default: <database>${collectionBackupSuffix}/)`,
    )
    .option("--no-backup", "Disable automatic collection backups", {
      default: commandDefaults.backup,
    })
    .option("--chat <id>", "Chat ID (skips name lookup)")
    .option(
      "--chat-label <label>",
      "Exact chat name (case-insensitive; see teams chats)",
    )
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option("--all-history", "Backfill all accessible history through now")
    .option("--last <Nd>", "Last N local calendar days, including today")
    .option(
      "--since <date>",
      "Start date (local midnight) or timestamp with Z or offset, through now",
    )
    .option(
      "--from <date>",
      "Start date or timestamp (inclusive); requires --to",
    )
    .option("--to <date>", "End date or timestamp (exclusive); requires --from")
    .option(
      "--page-delay-min <seconds>",
      `Minimum pause between pages and collection windows (default: ${defaultPageDelay.min})`,
    )
    .option(
      "--page-delay-max <seconds>",
      `Maximum pause between pages and collection windows (default: ${defaultPageDelay.max})`,
    )
    .option(
      "--out <directory>",
      "New combined export directory (default: daily folders for --last)",
    )
    .option("--no-media", "Skip images", { default: commandDefaults.media })
    .option("--no-markdown", "Skip Markdown", {
      default: commandDefaults.markdown,
    })
    .option(
      "--refresh-media",
      "Revalidate saved images; history remains resumable",
    )
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const now = Date.now();
      let options = resolveDownloadOptions(
        { ...input, db: input.db ?? "default.sqlite" },
        now,
      );
      const defaultCredentials =
        input.db === undefined
          ? await loadCredentials(options.credentials)
          : undefined;
      if (defaultCredentials)
        options = resolveDownloadOptions(
          { ...input, db: defaultCollectionPath(defaultCredentials.accountId) },
          now,
        );
      startLog("download", options, input);
      output(
        `[collect] Requested ${new Date(options.window.from).toISOString()} to ${new Date(options.window.to).toISOString()} (exclusive)`,
      );
      const credentials =
        defaultCredentials ?? (await loadCredentials(options.credentials));
      const result = await downloadChat(
        options,
        credentials,
        http,
        stats,
        progress,
        controller.signal,
        output,
        reportCollection,
      );
      const names = await chatNames(options.db, [result.collection.chatId]);
      finish(result, [
        ...collectionSummary(
          { chats: [result.collection], ...result.collection },
          names,
        ),
        ...exportSummary(
          result,
          names.get(result.collection.chatId) ?? result.collection.chatId,
        ),
      ]);
    });
  cli
    .command("collect", "Save messages; add --images to download images too")
    .option("--db <file>", "Override the account or TEAMS_DATA_DIR database")
    .option(
      "--no-log",
      `Disable private logs in <database>${collectionLogSuffix}/`,
      {
        default: commandDefaults.log,
      },
    )
    .option(
      "--backup-dir <directory>",
      `Database snapshot folder (default: <database>${collectionBackupSuffix}/)`,
    )
    .option("--no-backup", "Disable automatic collection backups", {
      default: commandDefaults.backup,
    })
    .option("--chat <id>", "Chat ID (skips name lookup)")
    .option("--all-chats", "Every chat already saved in the database")
    .option("--images", "Also download pending images (off by default)", {
      default: commandDefaults.images,
    })
    .option(
      "--chat-label <label>",
      "Exact chat name (case-insensitive; see teams chats)",
    )
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option("--all-history", "Backfill all accessible history through now")
    .option("--last <Nd>", "Last N local calendar days, including today")
    .option(
      "--since <date>",
      "Start date (local midnight) or timestamp with Z or offset, through now",
    )
    .option(
      "--from <date>",
      "Start date or timestamp (inclusive); requires --to",
    )
    .option("--to <date>", "End date or timestamp (exclusive); requires --from")
    .option(
      "--page-delay-min <seconds>",
      `Minimum pause between pages and collection windows (default: ${defaultPageDelay.min})`,
    )
    .option(
      "--page-delay-max <seconds>",
      `Maximum pause between pages and collection windows (default: ${defaultPageDelay.max})`,
    )
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const now = Date.now();
      let options = resolveCollectOptions(
        { ...input, db: input.db ?? "default.sqlite" },
        now,
      );
      const defaultCredentials =
        input.db === undefined
          ? await loadCredentials(options.credentials)
          : undefined;
      if (defaultCredentials)
        options = resolveCollectOptions(
          { ...input, db: defaultCollectionPath(defaultCredentials.accountId) },
          now,
        );
      startLog("collect", options, input);
      output(
        options.window
          ? `[collect] Requested ${new Date(options.window.from).toISOString()} to ${new Date(options.window.to).toISOString()} (exclusive)`
          : `[collect] Catch up saved history through ${new Date(options.invocationTime).toISOString()} (exclusive); resolving each chat's saved start.`,
      );
      const credentials =
        defaultCredentials ?? (await loadCredentials(options.credentials));
      const result = await (options.allChats ? collectChats : collectHistory)(
        options,
        credentials,
        http,
        stats,
        progress,
        controller.signal,
        reportCollection,
      );
      // Single-chat results are flat; batch results list their chats.
      const summarizeCollection = async () => {
        const collection =
          "chats" in result ? result : { ...result, chats: [result] };
        return collectionSummary(
          collection,
          await chatNames(
            options.db,
            collection.chats.map((chat) => chat.chatId),
          ),
        );
      };
      if (options.images) {
        output(
          "[collect] History collection complete; downloading pending images.",
        );
        const selected = "chats" in result ? result.chats : [result];
        const images = [];
        const unavailableOrigins = new Map<string, ImageResponseError>();
        for (const [index, chat] of selected.entries()) {
          controller.signal.throwIfAborted();
          output(
            `[images] Chat ${index + 1}/${selected.length}: ${JSON.stringify(chat.chatId)}`,
          );
          const media = await downloadDatabaseMedia(
            {
              db: options.db,
              chat: chat.chatId,
              log: options.log,
              refreshMedia: false,
            },
            credentials,
            http,
            controller.signal,
            reportDatabaseMedia,
            undefined,
            unavailableOrigins,
          );
          images.push({ chatId: chat.chatId, ...media });
        }
        const failed = images.reduce((count, chat) => count + chat.failed, 0);
        finish({ ...result, images }, [
          ...(await summarizeCollection()),
          ...imagesSummary(images),
        ]);
        if (failed)
          throw new AppError(
            `${failed} image download(s) failed across the selected chats. Saved history and images remain available. Rerun collect --images or teams images to retry.`,
          );
      } else finish(result, await summarizeCollection());
    });
  cli
    .command("export", "Write JSON and Markdown from saved history, offline")
    .alias("export-db")
    .option("--all-chats", "Every saved chat (requires --last Nd)")
    .option(
      "--db <file>",
      "Override TEAMS_DATA_DIR or single-account database discovery",
    )
    .option(
      "--no-log",
      `Disable private logs in <database>${collectionLogSuffix}/`,
      { default: commandDefaults.log },
    )
    .option("--chat <id>", "Raw chat ID stored in the collection")
    .option(
      "--chat-label <label>",
      "Exact saved SQLite chat label (case-insensitive; offline)",
    )
    .option("--out <directory>", "New directory for one combined archive")
    .option(
      "--last <Nd>",
      "Last N local calendar days as daily folders, including today",
    )
    .option(
      "--from <date>",
      "Start date or timestamp (inclusive); requires --to (default: full collected range)",
    )
    .option("--to <date>", "End date or timestamp (exclusive); requires --from")
    .option("--no-markdown", "Skip rendering Markdown", {
      default: commandDefaults.markdown,
    })
    .option("--no-media", "Skip copying collected images; use placeholders", {
      default: commandDefaults.media,
    })
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const now = Date.now();
      let options = resolveDatabaseExportOptions(
        { ...input, db: input.db ?? "default.sqlite" },
        now,
      );
      if (input.db === undefined)
        options = resolveDatabaseExportOptions(
          { ...input, db: await findDefaultCollection() },
          now,
        );
      startLog(cli.matchedCommandName ?? "export", options, input);
      output(
        `[export] Requested chat: ${JSON.stringify(options.allChats ? "all saved chats" : (options.chat ?? options.chatLabel))}; range: ${options.window ? new Date(options.window.from).toISOString() : "stored coverage"} to ${options.window ? new Date(options.window.to).toISOString() : "stored coverage"}; media: ${options.media}; markdown: ${options.markdown}; destination: ${options.out ?? "daily folders"}`,
      );
      if (options.allChats) {
        const result = await exportSavedChats(
          options,
          controller.signal,
          output,
        );
        finish(result, savedChatsExportSummary(result));
      } else {
        const result = await exportDatabase(options, controller.signal, output);
        const chat =
          options.chatLabel ??
          (options.chat === undefined
            ? ""
            : ((await chatNames(options.db, [options.chat])).get(
                options.chat,
              ) ?? options.chat));
        finish(result, exportSummary(result, chat));
      }
    });
  cli
    .command("images", "Download pending images for saved history")
    .alias("media-db")
    .option("--db <file>", "Override the account or TEAMS_DATA_DIR database")
    .option(
      "--no-log",
      `Disable private logs in <database>${collectionLogSuffix}/`,
      { default: commandDefaults.log },
    )
    .option(
      "--chat <id>",
      "Limit to one raw chat ID (default: all collected chats)",
    )
    .option(
      "--chat-label <label>",
      "Exact saved SQLite chat label (case-insensitive; offline lookup)",
    )
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option(
      "--refresh-media",
      "Revalidate downloaded images using the shared cache",
    )
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      let options = resolveDatabaseMediaOptions({
        ...input,
        db: input.db ?? "default.sqlite",
      });
      const defaultCredentials =
        input.db === undefined
          ? await loadCredentials(options.credentials)
          : undefined;
      if (defaultCredentials)
        options = resolveDatabaseMediaOptions({
          ...input,
          db: defaultCollectionPath(defaultCredentials.accountId),
        });
      startLog(cli.matchedCommandName ?? "images", options, input);
      const credentials =
        defaultCredentials ?? (await loadCredentials(options.credentials));
      output(
        `[images] Requested chat: ${JSON.stringify(options.chat ?? options.chatLabel ?? "all chats")}; refresh: ${options.refreshMedia}`,
      );
      const result = await downloadDatabaseMedia(
        options,
        credentials,
        http,
        controller.signal,
        reportDatabaseMedia,
      );
      // The image summary line has already been printed by reportDatabaseMedia.
      finish(result, []);
      if (result.failed)
        throw new AppError(
          `${result.failed} image(s) failed. First failure: ${result.failureReason} Completed image files and database records remain saved. Rerun this command to retry.`,
        );
    });
  configureCliHelp(cli);
  cli.version("0.1.0");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    cli.parse(argv, { run: false });
    if (!cli.matchedCommand && !cli.options.help && !cli.options.version) {
      if (cli.args.length) {
        const name = String(cli.args[0]);
        const suggestion = closest(
          name,
          cli.commands.flatMap((command) => [
            command.name,
            ...command.aliasNames,
          ]),
        );
        throw new AppError(
          `Unknown command "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Run teams --help to see commands.`,
        );
      }
      cli.outputHelp();
      return 0;
    }
    await cli.runMatchedCommand();
    collectionLog?.write(`[${operation}] Completed successfully.`);
    return 0;
  } catch (error) {
    // CAC's syntax errors do not include remote bodies or credential values.
    const message =
      error instanceof Error && error.name === "CACError"
        ? syntaxErrorMessage(error.message, cli)
        : errorMessage(error);
    console.error(message);
    collectionLog?.write(
      `[${operation}] ${controller.signal.aborted ? "Cancelled" : "Failed"}: ${message}`,
    );
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (stats.total > 0)
      output(
        `HTTP attempts: ${stats.total} (history: ${stats.history}, directory: ${stats.directory}, profiles: ${stats.profiles}, media: ${stats.media}); retries: ${stats.retries} included. History pages: ${progress.pages}.`,
      );
    collectionLog?.close();
  }
}

/** Saved chat labels for summaries; falls back to raw IDs if the store cannot be read. */
async function chatNames(db: string, ids: string[]): Promise<ChatNames> {
  const names = new Map<string, string>();
  let store: HistoryStore | undefined;
  try {
    store = await HistoryStore.open(db);
    for (const id of ids) {
      const label = store.chatLabel(id);
      if (label !== undefined) names.set(id, label);
    }
  } catch {
    // Names are cosmetic; the work already succeeded.
  } finally {
    store?.close();
  }
  return names;
}

/** Explains a CAC syntax error using the flag spelling the user typed. */
function syntaxErrorMessage(message: string, cli: ReturnType<typeof cac>) {
  // CAC reports unknown options by their camelCase parse key, e.g. `--chatLabl`.
  const unknown = /^Unknown option `--([^`]+)`$/.exec(message)?.[1];
  if (unknown === undefined) return message;
  const flag = `--${unknown.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  const command = cli.matchedCommand;
  const suggestion = closest(
    flag,
    [...(command?.options ?? []), ...cli.globalCommand.options].flatMap(
      (option) =>
        option.rawName.split(/[\s,]+/).filter((name) => name.startsWith("--")),
    ),
  );
  return `Unknown option ${flag}.${suggestion ? ` Did you mean ${suggestion}?` : ""} Run teams ${command?.name ?? ""}${command ? " " : ""}--help to see options.`;
}

/** Returns the candidate within two edits of the input, if any. */
function closest(input: string, candidates: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = editDistance(input, name);
    if (distance <= 2 && (best === undefined || distance < best.distance))
      best = { name, distance };
  }
  return best?.name;
}

/** Levenshtein distance, keeping one row of the edit table at a time. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (const [i, left] of [...a].entries()) {
    const current = [i + 1];
    for (const [j, right] of [...b].entries()) {
      const substitution = (previous[j] ?? 0) + (left === right ? 0 : 1);
      const deletion = (previous[j + 1] ?? 0) + 1;
      const insertion = (current[j] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

if (import.meta.main) process.exitCode = await runCli();
