import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Archive } from "./archive.ts";
import { downloadArchiveMedia } from "./archive-media.ts";
import { convertArchive } from "./convert.ts";
import type { Credentials } from "./credentials.ts";
import { AppError } from "./errors.ts";
import { defaultExportDirectory } from "./export-path.ts";
import type { Http, RequestStats } from "./http.ts";
import type { MediaOutcome } from "./media.ts";
import type { ExportOptions } from "./command-validation.ts";
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
  | {
      type: "media-progress";
      current: number;
      total: number;
      outcome: MediaOutcome;
    }
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
  let chat = options.chat;
  let label: string | undefined;
  if (options.chatLabel !== undefined) {
    const requested = options.chatLabel.toLowerCase();
    if (
      requested === "untitled chat" ||
      requested === "unresolved one-to-one chat"
    )
      throw new AppError(
        "Generic fallback labels cannot select a chat; use --chat <id> from teams chats.",
      );
    const chats = await listChats(http, credentials, {
      warn: (message) => console.warn(message),
      signal,
    });
    const matches = chats.filter(
      (item) => item.label.trim().toLowerCase() === requested,
    );
    if (matches.length === 0)
      throw new AppError(
        "No chat matches --chat-label. Run teams chats to see current labels; use --refresh-names if a participant was renamed.",
      );
    if (matches.length > 1)
      throw new AppError(
        `Multiple chats match --chat-label; select one with --chat <id>:\n${matches.map((item) => `${JSON.stringify(item.label)}: ${JSON.stringify(item.id)}`).join("\n")}`,
      );
    const selected = matches[0]!;
    chat = selected.id;
    label = selected.label;
  }
  if (chat === undefined)
    throw new AppError(
      "Choose exactly one of --chat <id> or --chat-label <label>.",
    );
  let directory = options.out;
  if (directory === undefined) {
    if (label === undefined && credentials.directoryToken) {
      const chats = await listChats(http, credentials, {
        chatId: chat,
        warn: (message) => console.warn(message),
        signal,
      });
      label = chats[0]?.label;
    }
    if (label === undefined)
      console.warn(
        "Chat label unavailable; using a chat identifier in the directory name.",
      );
    directory = defaultExportDirectory({ ...options, chat }, label);
  }
  await checkOutput(directory);
  const out = join(directory, "chat.json");
  const messages = await readHistory(
    http,
    credentials,
    chat,
    options.window,
    progress,
    (h) => onProgress?.({ type: "history", ...h }),
    {
      pageDelayMin: options.pageDelayMin,
      pageDelayMax: options.pageDelayMax,
      signal,
    },
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
    const document = {
      version: 1,
      status: "complete",
      accountId: credentials.accountId,
      chatId: chat,
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
    published = true;
    onProgress?.({ type: "save", format: "json", destination: output });
    let markdown: string | undefined;
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
        markdown = converted.output;
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
    if (options.media)
      return await downloadArchiveMedia(
        {
          input: output,
          markdown: options.markdown,
          refreshMedia: options.refreshMedia,
        },
        credentials,
        http,
        stats,
        signal,
        onProgress,
      );
    return {
      output,
      messages: messages.length,
      ...(markdown ? { markdown } : {}),
    };
  } catch (error) {
    if (!published) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
