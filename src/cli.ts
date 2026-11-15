import { cac } from "cac";
import { downloadArchiveMedia } from "./archive-media.ts";
import {
  resolveBatchConvertOptions,
  resolveChatsOptions,
  resolveCollectOptions,
  resolveDatabaseExportOptions,
  resolveDatabaseMediaOptions,
  resolveConvertOptions,
  resolveExportOptions,
  resolveLoginOptions,
  resolveMediaOptions,
} from "./command-validation.ts";
import {
  commandDefaults,
  collectionBackupIntervalMs,
  collectionBackupSuffix,
  collectionLogSuffix,
  defaultExportRoot,
  defaultOutputFormat,
  defaultPageDelay,
  loginTimeout,
  pageDelayLimits,
} from "./config.ts";
import { convertAllArchives } from "./convert-all.ts";
import { convertArchive } from "./convert.ts";
import { openCollectionLog } from "./collection-log.ts";
import { collectHistory } from "./collect.ts";
import { exportDatabase } from "./database-export.ts";
import { downloadDatabaseMedia } from "./database-media.ts";
import { loadCredentials } from "./credentials.ts";
import { AppError, errorMessage } from "./errors.ts";
import { exportChat, type ExportProgressEvent } from "./export.ts";
import { createHttp, requestStats } from "./http.ts";
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
  const startLog = (
    command: string,
    options: { db: string; log?: boolean },
  ) => {
    operation = command;
    if (options.log) {
      collectionLog = openCollectionLog(options.db, (message) =>
        console.warn(message),
      );
      if (collectionLog) output(`[log] Collection log: ${collectionLog.path}`);
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
        const outcome = {
          cache: "reused from local cache",
          revalidated: "revalidated with Teams: HTTP 304; reused cached bytes",
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
  cli
    .command("login", "Sign in in a visible browser and save fresh credentials")
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
    .command(
      "export",
      "Save chat history as JSON and render Markdown transcript",
    )
    .option("--chat <id>", "Raw chat ID")
    .option(
      "--chat-label <label>",
      "Exact resolved chat label (case-insensitive)",
    )
    .option("--no-media", "Skip image downloading and use placeholders", {
      default: commandDefaults.media,
    })
    .option("--no-markdown", "Skip rendering Markdown transcript beside JSON", {
      default: commandDefaults.markdown,
    })
    .option("--refresh-media", "Revalidate cached images with Teams")
    .option(
      "--page-delay-min <seconds>",
      `Minimum pause between history pages, ${pageDelayLimits.min}–${pageDelayLimits.max} seconds (default: ${defaultPageDelay.min})`,
    )
    .option(
      "--page-delay-max <seconds>",
      `Maximum pause between history pages, ${pageDelayLimits.min}–${pageDelayLimits.max} seconds (default: ${defaultPageDelay.max})`,
    )
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option(
      "--out <directory>",
      `New export directory (default: ${defaultExportRoot}/<chat-label>/<period>; --last 1d refreshes today's folder)`,
    )
    .option(
      "--last <Nd>",
      "Last N calendar days including today, through now (local timezone; TZ overrides)",
    )
    .option("--since <timestamp>", "Start timestamp through invocation time")
    .option("--from <timestamp>", "Inclusive start timestamp with Z or offset")
    .option("--to <timestamp>", "Exclusive end timestamp with Z or offset")
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const options = resolveExportOptions(input);
      const credentials = await loadCredentials(options.credentials);
      const result = await exportChat(
        options,
        credentials,
        http,
        stats,
        progress,
        controller.signal,
        reportProgress,
      );
      console.log(JSON.stringify(result));
    });
  cli
    .command(
      "media",
      "Download images for a saved JSON export without fetching history",
    )
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
    .command("convert", "Convert a saved JSON export without contacting Teams")
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
      "Convert JSON exports that have no sibling Markdown destination",
    )
    .option(
      "--dir <directory>",
      `Directory of JSON exports (default: ${defaultExportRoot})`,
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
    .command("chats", "List chat IDs and available titles as JSON")
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
    .command(
      "collect",
      "Collect resumable chat history into SQLite (text and source image references)",
    )
    .option("--db <file>", "SQLite collection file; one account per database")
    .option(
      "--no-log",
      `Disable automatic private logs in <database>${collectionLogSuffix}/`,
      {
        default: commandDefaults.log,
      },
    )
    .option(
      "--backup-dir <directory>",
      `Override backup directory (default: <database>${collectionBackupSuffix}); snapshots every ${collectionBackupIntervalMs / 3600000} hour(s) and on completion; no automatic deletion`,
    )
    .option("--no-backup", "Disable automatic collection backups", {
      default: commandDefaults.backup,
    })
    .option("--chat <id>", "Raw chat ID; skips directory/profile lookup")
    .option(
      "--chat-label <label>",
      "Exact resolved chat label (case-insensitive)",
    )
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option(
      "--all",
      "Collect all accessible history from Unix millisecond 1 through now",
    )
    .option("--last <Nd>", "Last N calendar days including today")
    .option(
      "--since <timestamp>",
      "Inclusive start timestamp through invocation time",
    )
    .option("--from <timestamp>", "Inclusive start timestamp with Z or offset")
    .option("--to <timestamp>", "Exclusive end timestamp with Z or offset")
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
      const options = resolveCollectOptions(input);
      startLog("collect", options);
      output(
        `[collect] Requested ${new Date(options.window.from).toISOString()} to ${new Date(options.window.to).toISOString()} (exclusive)`,
      );
      const credentials = await loadCredentials(options.credentials);
      const result = await collectHistory(
        options,
        credentials,
        http,
        stats,
        progress,
        controller.signal,
        (event) => {
          if (event.type === "warning") warning(event.message);
          else if (event.type === "coverage") {
            output(
              `[collect] Already collected: ${event.alreadyCollectedMilliseconds} ms; remaining intervals: ${event.remainingIntervals}.`,
            );
            if (event.remainingIntervals === 0)
              output(
                "[collect] Requested range already collected; no history requests needed.",
              );
          } else if (event.type === "window")
            output(
              `[collect] ${event.from} to ${event.toExclusive} (exclusive)`,
            );
          else if (event.type === "history")
            reportProgress({ type: "history", ...event.progress });
          else if (event.type === "backup") {
            if (event.status === "saved")
              output(`[backup] Saved verified snapshot: ${event.path}`);
            else
              warning(
                `[backup] Snapshot failed. ${event.reason} Existing backups kept; collection continues.`,
              );
          } else
            output(
              `[collect] Checkpoint saved: ${event.messages} messages (${event.added} new).`,
            );
        },
      );
      output(JSON.stringify(result));
    });
  cli
    .command(
      "export-db",
      "Export a fully collected SQLite range to JSON and Markdown, offline",
    )
    .option("--db <file>", "Existing SQLite collection file")
    .option(
      "--no-log",
      `Disable automatic private logs in <database>${collectionLogSuffix}/`,
      { default: commandDefaults.log },
    )
    .option("--chat <id>", "Raw chat ID stored in the collection")
    .option("--out <directory>", "New directory for chat.json and chat.md")
    .option(
      "--from <timestamp>",
      "Inclusive start; requires --to (default: full collected range)",
    )
    .option("--to <timestamp>", "Exclusive end; requires --from")
    .option("--no-markdown", "Skip rendering Markdown", {
      default: commandDefaults.markdown,
    })
    .option("--no-media", "Skip copying collected images; use placeholders", {
      default: commandDefaults.media,
    })
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const options = resolveDatabaseExportOptions(input);
      startLog("export-db", options);
      output(
        `[export-db] Requested chat: ${options.chat}; range: ${options.from ?? "stored coverage"} to ${options.to ?? "stored coverage"}; media: ${options.media}; markdown: ${options.markdown}; destination: ${options.out}`,
      );
      output(
        JSON.stringify(
          await exportDatabase(options, controller.signal, output),
        ),
      );
    });
  cli
    .command(
      "media-db",
      "Download pending SQLite image references without a JSON export",
    )
    .option("--db <file>", "Existing SQLite collection file")
    .option(
      "--no-log",
      `Disable automatic private logs in <database>${collectionLogSuffix}/`,
      { default: commandDefaults.log },
    )
    .option(
      "--chat <id>",
      "Limit to one raw chat ID (default: all collected chats)",
    )
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option(
      "--refresh-media",
      "Revalidate downloaded images using the shared cache",
    )
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const options = resolveDatabaseMediaOptions(input);
      startLog("media-db", options);
      output(
        `[media-db] Requested chat: ${options.chat ?? "all chats"}; refresh: ${options.refreshMedia}`,
      );
      const credentials = await loadCredentials(options.credentials);
      output(
        JSON.stringify(
          await downloadDatabaseMedia(
            options,
            credentials,
            http,
            controller.signal,
            (event) => {
              if (event.phase === "summary") output(event.message);
              else if (event.phase === "start")
                reportProgress({ type: "media-start", total: event.total });
              else
                reportProgress({
                  type: "media-progress",
                  current: event.current,
                  total: event.total,
                  outcome: event.outcome,
                });
            },
          ),
        ),
      );
    });
  cli.help();
  cli.version("0.1.0");
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    cli.parse(argv, { run: false });
    if (!cli.matchedCommand && !cli.options.help && !cli.options.version) {
      if (cli.args.length) throw new AppError("Unknown command; use --help.");
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
        ? error.message
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

if (import.meta.main) process.exitCode = await runCli();
