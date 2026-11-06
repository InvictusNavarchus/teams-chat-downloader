import { cac } from "cac";
import { z } from "zod";
import { downloadArchiveMedia } from "./archive-media.ts";
import { convertAllArchives } from "./convert-all.ts";
import { convertArchive } from "./convert.ts";
import { loadCredentials } from "./credentials.ts";
import { AppError, errorMessage, validationError } from "./errors.ts";
import { exportChat, type ExportProgressEvent } from "./export.ts";
import { createHttp, requestStats } from "./http.ts";
import {
  resolveBatchConvertOptions,
  resolveConvertOptions,
  resolveExportOptions,
  resolveMediaOptions,
} from "./options.ts";
import { writeChatList } from "./output.ts";
import { historyProgress, listChats } from "./teams.ts";

export async function runCli(argv = process.argv): Promise<number> {
  const cli = cac("teams");
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
        console.log(
          `[history] Page ${event.page}: ${event.pageMessages} messages (total: ${event.totalMessages})${reach}${status}`,
        );
        break;
      }
      case "media-start":
        console.log(`[media] Found ${event.total} image(s); processing...`);
        break;
      case "media-progress": {
        const outcome = {
          cache: "reused from local cache",
          revalidated: "revalidated with Teams: HTTP 304; reused cached bytes",
          downloaded: "downloaded: HTTP 200",
        }[event.outcome];
        console.log(
          `[media] Image ${event.current}/${event.total} (${outcome})`,
        );
        break;
      }
      case "save":
        console.log(`[export] Saved JSON archive: ${event.destination}`);
        break;
      case "convert":
        console.log("[convert] Converted to Markdown.");
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
      "Login time budget, 1–3600 seconds (default: 600)",
    )
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const { login, resolveLoginOptions } = await import("./login.ts");
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
    .option("--no-media", "Skip image downloading and use placeholders")
    .option("--no-markdown", "Skip rendering Markdown transcript beside JSON")
    .option("--refresh-media", "Revalidate cached images with Teams")
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option(
      "--out <directory>",
      "New export directory (default: exports/<chat-label>--<period>)",
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
    .option("--no-markdown", "Skip regenerating sibling Markdown")
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
    .option("--format <format>", "Output format (default: markdown)")
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
    .option("--dir <directory>", "Directory of JSON exports (default: exports)")
    .option("--recursive", "Include exports nested beyond direct child folders")
    .option("--format <format>", "Output format (default: markdown)")
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
      const result = z
        .object({
          credentials: z.string().min(1).optional(),
          out: z.string().min(1).optional(),
          refreshNames: z.boolean().optional(),
        })
        .safeParse(raw);
      if (!result.success) throw validationError("Chat options", result.error);
      const options = result.data;
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
    return 0;
  } catch (error) {
    // CAC's syntax errors do not include remote bodies or credential values.
    const message =
      error instanceof Error && error.name === "CACError"
        ? error.message
        : errorMessage(error);
    console.error(message);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (stats.total > 0)
      console.log(
        `HTTP attempts: ${stats.total} (history: ${stats.history}, directory: ${stats.directory}, profiles: ${stats.profiles}, media: ${stats.media}); retries: ${stats.retries} included. History pages: ${progress.pages}.`,
      );
  }
}

if (import.meta.main) process.exitCode = await runCli();
