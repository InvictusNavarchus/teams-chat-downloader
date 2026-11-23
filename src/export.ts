import { mkdir, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readArchive, type Archive } from "./archive.ts";
import {
  downloadArchiveMedia,
  downloadLockedArchiveMedia,
} from "./archive-media.ts";
import {
  assertSelectableChatLabel,
  selectChatByLabel,
} from "./chat-selection.ts";
import { prepareDailyDirectory, assertDailyArchive } from "./daily-export.ts";
import { convertArchive } from "./convert.ts";
import type { Credentials } from "./credentials.ts";
import { AppError } from "./errors.ts";
import { defaultExportDirectory } from "./export-path.ts";
import type { Http, RequestStats } from "./http.ts";
import type { MediaItemProgress } from "./media.ts";
import { renderMarkdown } from "./markdown.ts";
import type { ExportOptions } from "./command-validation.ts";
import {
  checkOutput,
  updateExport,
  updateMarkdown,
  withArchiveLock,
  writeExport,
} from "./output.ts";
import {
  type HistoryPageProgress,
  type HistoryProgress,
  listChats,
  readHistory,
} from "./teams.ts";

export type ExportProgressEvent =
  | ({ type: "history" } & HistoryPageProgress)
  | { type: "media-start"; total: number }
  | ({ type: "media-progress" } & MediaItemProgress)
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
    assertSelectableChatLabel(options.chatLabel);
    const chats = await listChats(http, credentials, {
      warn: (message) => console.warn(message),
      signal,
    });
    const selected = selectChatByLabel(chats, options.chatLabel);
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
  const daily = options.out === undefined && options.last === "1d";
  if (!daily) await checkOutput(directory);
  const chatId = chat;
  const destination = directory;
  const out = join(directory, "chat.json");
  let published = false;
  if (!daily) return publish(false);

  // Reserve even first-time daily exports before history retrieval, so two
  // invocations cannot race to publish different endpoints for the same day.
  signal?.throwIfAborted();
  const createdPaths = await prepareDailyDirectory(directory);
  const created = createdPaths.includes(directory);
  let reserved = false;
  try {
    return await withArchiveLock(out, async () => {
      reserved = true;
      if (!created)
        await assertDailyArchive(
          directory,
          chat,
          credentials.accountId,
          options.window,
        );
      return publish(!created);
    });
  } finally {
    if (reserved && !published) {
      // Remove only empty directories we created. Another writer may have
      // acquired the lock after ours was released; never remove its files.
      for (const path of createdPaths.reverse()) {
        try {
          await rmdir(path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOTEMPTY" || code === "EEXIST") break;
          if (code !== "ENOENT")
            throw new AppError(
              "Could not clean up an empty daily export directory.",
            );
        }
      }
    }
  }

  async function publish(refresh: boolean) {
    const messages = await readHistory(
      http,
      credentials,
      chatId,
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
    if (!daily)
      try {
        await mkdir(dirname(resolve(destination)), {
          recursive: true,
          mode: 0o700,
        });
        await mkdir(destination, { mode: 0o700 });
      } catch (error) {
        throw new AppError(
          (error as NodeJS.ErrnoException).code === "EEXIST"
            ? "Export directory already exists; choose a new --out directory."
            : "Could not create the export directory.",
        );
      }
    try {
      const document = {
        version: 1,
        status: "complete",
        accountId: credentials.accountId,
        chatId,
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
      const output = await (refresh ? updateExport : writeExport)(
        out,
        document,
        signal,
      );
      published = true;
      onProgress?.({ type: "save", format: "json", destination: output });
      let markdown: string | undefined;
      if (options.markdown) {
        try {
          const converted = refresh
            ? {
                output: await updateMarkdown(
                  join(destination, "chat.md"),
                  renderMarkdown(await readArchive(output, signal)),
                  signal,
                ),
              }
            : await convertArchive(
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
      } else if (refresh) {
        // A previous transcript would describe stale history after this refresh.
        await unlink(join(destination, "chat.md")).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT")
              throw new AppError(
                "JSON export saved, but the previous Markdown could not be removed.",
              );
          },
        );
      }
      if (options.media)
        return await (daily
          ? downloadLockedArchiveMedia
          : downloadArchiveMedia)(
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
      if (!daily && !published)
        await rm(destination, { recursive: true, force: true });
      throw error;
    }
  }
}
