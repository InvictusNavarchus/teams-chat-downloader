import { cac } from "cac";
import { z } from "zod";
import { convertArchive } from "./convert.ts";
import { loadCredentials } from "./credentials.ts";
import { AppError, errorMessage, validationError } from "./errors.ts";
import { exportChat } from "./export.ts";
import { createHttp, requestStats } from "./http.ts";
import { resolveConvertOptions, resolveExportOptions } from "./options.ts";
import { writeChatList } from "./output.ts";
import { historyProgress, listChats } from "./teams.ts";

export async function runCli(argv = process.argv): Promise<number> {
  const cli = cac("teams");
  const stats = requestStats();
  const progress = historyProgress();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const http = createHttp({ stats, signal: controller.signal });
  cli
    .command("login", "Sign in in a visible browser and save fresh credentials")
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
        progress: (message) => console.error(message),
      });
      console.log(JSON.stringify(result));
    });
  cli
    .command(
      "export",
      "Save chat history as JSON and optionally render Markdown",
    )
    .option("--chat <id>", "Raw chat ID")
    .option("--credentials <file>", "Override automatic credential file lookup")
    .option(
      "--out <file>",
      "Output JSON file (default: exports/<chat-label>--<period>.json); never overwritten",
    )
    .option("--last <duration>", "Rolling duration, for example 7d")
    .option(
      "--format <format>",
      "json or markdown (always saves JSON; default: json)",
    )
    .option("--since <timestamp>", "Start timestamp through invocation time")
    .option("--from <timestamp>", "Inclusive start timestamp with Z or offset")
    .option("--to <timestamp>", "Exclusive end timestamp with Z or offset")
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const options = resolveExportOptions(input);
      const credentials = await loadCredentials(options.credentials);
      console.log(
        JSON.stringify(
          await exportChat(
            options,
            credentials,
            http,
            stats,
            progress,
            controller.signal,
          ),
        ),
      );
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
        warn: (message) => console.error(message),
        signal: controller.signal,
      });
      if (options.out !== undefined) {
        const path = await writeChatList(options.out, chats, controller.signal);
        console.error(`Saved chat list to ${path}.`);
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
      console.error(
        `HTTP attempts: ${stats.total} (history: ${stats.history}, directory: ${stats.directory}, profiles: ${stats.profiles}); retries: ${stats.retries} included. History pages: ${progress.pages}.`,
      );
  }
}

if (import.meta.main) process.exitCode = await runCli();
