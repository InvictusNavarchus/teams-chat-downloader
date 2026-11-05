import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Archive } from "./archive.ts";
import { convertArchive } from "./convert.ts";
import type { Credentials } from "./credentials.ts";
import { AppError } from "./errors.ts";
import { defaultExportDirectory } from "./export-path.ts";
import type { Http, RequestStats } from "./http.ts";
import { downloadImages } from "./media.ts";
import type { ExportOptions } from "./options.ts";
import { checkOutput, writeExport } from "./output.ts";
import {
  type HistoryPageProgress,
  type HistoryProgress,
  listChats,
  readHistory,
} from "./teams.ts";

export type ExportProgressEvent =
  | ({ type: "history" } & HistoryPageProgress)
  | { type: "media-start"; total: number }
  | { type: "media-progress"; current: number; total: number; cached: boolean }
  | { type: "save"; format: "json"; destination: string }
  | { type: "convert"; format: "markdown"; destination: string };

export async function exportChat(
  options: ExportOptions,
  credentials: Credentials,
  http: Http,
  stats: RequestStats,
  progress: HistoryProgress,
  signal?: AbortSignal,
  onProgress?: (event: ExportProgressEvent) => void,
) {
  let directory = options.out;
  if (directory === undefined) {
    let label: string | undefined;
    if (credentials.directoryToken) {
      const chats = await listChats(http, credentials, {
        chatId: options.chat,
        warn: (message) => console.warn(message),
        signal,
      });
      label = chats[0]?.label;
    }
    if (label === undefined)
      console.warn(
        "Chat label unavailable; using a chat identifier in the directory name.",
      );
    directory = defaultExportDirectory(options, label);
  }
  await checkOutput(directory);
  const out = join(directory, "chat.json");
  const messages = await readHistory(
    http,
    credentials,
    options.chat,
    options.window,
    progress,
    (h) => onProgress?.({ type: "history", ...h }),
  );
  signal?.throwIfAborted();
  try {
    await mkdir(dirname(resolve(directory)), { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    throw new AppError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "Export directory already exists; choose a new --out directory."
        : "Could not create the export directory.",
    );
  }
  let published = false;
  try {
    const media = options.media
      ? await downloadImages(messages, out, credentials, http, {
          refresh: options.refreshMedia,
          signal,
          onProgress: (m) => {
            if (m.phase === "start") {
              onProgress?.({ type: "media-start", total: m.total });
            } else {
              onProgress?.({
                type: "media-progress",
                current: m.current,
                total: m.total,
                cached: m.cached,
              });
            }
          },
        })
      : { status: "not-downloaded" as const };
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
      media,
      messages,
    } satisfies Archive;
    const output = await writeExport(out, document, signal);
    published = true;
    onProgress?.({ type: "save", format: "json", destination: output });
    if (options.markdown) {
      try {
        const converted = await convertArchive(
          { input: output, format: "markdown" },
          signal,
        );
        onProgress?.({
          type: "convert",
          format: "markdown",
          destination: converted.output,
        });
        return {
          output,
          messages: messages.length,
          markdown: converted.output,
        };
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
  } catch (error) {
    if (!published) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
