import type { Archive } from "./archive.ts";
import { convertArchive, markdownPath } from "./convert.ts";
import type { Credentials } from "./credentials.ts";
import { AppError } from "./errors.ts";
import { defaultExportPath } from "./export-path.ts";
import type { Http, RequestStats } from "./http.ts";
import type { ExportOptions } from "./options.ts";
import { checkOutput, writeExport } from "./output.ts";
import { type HistoryProgress, listChats, readHistory } from "./teams.ts";

export async function exportChat(
  options: ExportOptions,
  credentials: Credentials,
  http: Http,
  stats: RequestStats,
  progress: HistoryProgress,
  signal?: AbortSignal,
) {
  let out = options.out;
  if (out === undefined) {
    let label: string | undefined;
    if (credentials.directoryToken) {
      const chats = await listChats(http, credentials, {
        chatId: options.chat,
        warn: (message) => console.error(message),
        signal,
      });
      label = chats[0]?.label;
    }
    if (label === undefined)
      console.error(
        "Chat label unavailable; using a chat identifier in the filename.",
      );
    out = defaultExportPath(options, label);
  }
  await checkOutput(out);
  if (options.format === "markdown") await checkOutput(markdownPath(out));
  const messages = await readHistory(
    http,
    credentials,
    options.chat,
    options.window,
    progress,
  );
  signal?.throwIfAborted();
  const document = {
    version: 1,
    status: "complete",
    accountId: credentials.accountId,
    chatId: options.chat,
    window: {
      from: new Date(options.window.from).toISOString(),
      toExclusive: new Date(options.window.to).toISOString(),
      timestampField: "originalarrivaltime",
    },
    completedAt: new Date().toISOString(),
    history: {
      ...progress,
      uniqueMessages: messages.length,
      serviceReportedExhaustion: true,
      duplicatePolicy: "identical records deduplicated; conflicts fail",
    },
    requests: {
      ...stats,
      scope:
        "HTTP client attempts; retries included; redirects refused; browser traffic excluded",
    },
    media: { status: "not-downloaded" },
    messages,
  } satisfies Archive;
  const output = await writeExport(out, document, signal);
  if (options.format === "markdown") {
    try {
      const converted = await convertArchive(
        { input: output, format: "markdown" },
        signal,
      );
      return { output, messages: messages.length, markdown: converted.output };
    } catch (error) {
      const reason =
        error instanceof AppError
          ? error.message
          : "Conversion could not finish.";
      throw new AppError(
        `JSON export saved to ${output}. Markdown conversion failed: ${reason} Retry conversion with teams convert --input <saved-json> --out <new-markdown-path>.`,
      );
    }
  }
  return { output, messages: messages.length };
}
