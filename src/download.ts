import type { DownloadOptions } from "./command-validation.ts";
import { collectHistory, type CollectionEvent } from "./collect.ts";
import type { Credentials } from "./credentials.ts";
import { downloadDatabaseMedia } from "./database-media.ts";
import { exportDatabase } from "./database-export.ts";
import { defaultExportDirectory } from "./export-path.ts";
import { HistoryStore } from "./history-store.ts";
import type { Http, RequestStats } from "./http.ts";
import type { HistoryProgress } from "./teams.ts";
import { checkOutput } from "./output.ts";
import { AppError, errorMessage } from "./errors.ts";

export async function downloadChat(
  options: DownloadOptions,
  credentials: Credentials,
  http: Http,
  stats: RequestStats,
  progress: HistoryProgress,
  signal?: AbortSignal,
  report: (message: string) => void = console.log,
  onCollection?: (event: CollectionEvent) => void,
) {
  if (options.out) await checkOutput(options.out);
  const collection = await collectHistory(
    options,
    credentials,
    http,
    stats,
    progress,
    signal,
    onCollection,
  );
  let mediaError: string | undefined;
  if (options.media) {
    try {
      const media = await downloadDatabaseMedia(
        {
          db: options.db,
          chat: collection.chatId,
          log: options.log,
          refreshMedia: options.refreshMedia,
        },
        credentials,
        http,
        signal,
        (event) => {
          if (event.phase === "summary") report(event.message);
          else if (event.phase === "start")
            report(`[images] Processing ${event.total} image(s).`);
          else {
            const outcome =
              event.outcome === "failed"
                ? `failed: ${event.reason}`
                : event.outcome;
            report(
              `[images] Image ${event.current}/${event.total} (${outcome})`,
            );
          }
        },
      );
      if (media.failed)
        mediaError = `${media.failed} image(s) failed. First failure: ${media.failureReason}`;
    } catch (error) {
      signal?.throwIfAborted();
      mediaError = errorMessage(error);
    }
    if (mediaError)
      report(
        "[download] Image downloading failed; exporting saved text and available images.",
      );
  }
  let out = options.out;
  // All calendar-day requests use the same daily layout as offline export.
  const daily = options.last !== undefined && out === undefined;
  if (!daily && out === undefined) {
    const store = await HistoryStore.open(options.db);
    try {
      const label = store.chatLabel(collection.chatId);
      out = defaultExportDirectory(
        { ...options, chat: collection.chatId },
        label,
      );
    } finally {
      store.close();
    }
  }
  const result = await exportDatabase(
    {
      db: options.db,
      chat: collection.chatId,
      allChats: false,
      log: options.log,
      out,
      last: daily ? options.last : undefined,
      window: options.window,
      media: options.media,
      markdown: options.markdown,
    },
    signal,
    report,
  );
  if (mediaError)
    throw new AppError(
      `${mediaError} Text export saved: ${result.output}. Retry with teams images${options.refreshMedia ? " --refresh-media" : ""} for the same database and chat, then regenerate the export.`,
    );
  return { ...result, database: options.db, collection };
}
