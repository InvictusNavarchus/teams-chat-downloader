import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { Message } from "./archive.ts";
import type { DatabaseMediaOptions } from "./command-validation.ts";
import type { Credentials } from "./credentials.ts";
import { AppError, errorMessage } from "./errors.ts";
import {
  HistoryStore,
  collectionMediaDirectory,
  reserveCollection,
  storedImageDescriptor,
} from "./history-store.ts";
import type { Http, ImageResponseError } from "./http.ts";
import {
  downloadImages,
  imageSourceUrl,
  IncompleteImageDownload,
  readStoredImage,
  type MediaProgress,
} from "./media.ts";

export async function downloadDatabaseMedia(
  options: DatabaseMediaOptions,
  credentials: Credentials,
  http: Http,
  signal?: AbortSignal,
  onProgress?: (
    event: MediaProgress | { phase: "summary"; message: string },
  ) => void,
  cacheRoot?: string,
  unavailableOrigins?: Map<string, ImageResponseError>,
) {
  signal?.throwIfAborted();
  try {
    await lstat(options.db);
  } catch {
    throw new AppError("Collection database not found; run collect first.");
  }
  const release = await reserveCollection(options.db);
  let store: HistoryStore | undefined;
  try {
    store = await HistoryStore.open(options.db, credentials.accountId);
    const chat =
      options.chat ??
      (options.chatLabel === undefined
        ? undefined
        : store.chatIdForLabel(options.chatLabel));
    if (chat !== undefined)
      onProgress?.({
        phase: "summary",
        message: `[images] Selected stored chat: ${JSON.stringify(chat)}.`,
      });
    const images = store.images(chat);
    const pending: Message[] = [];
    const directory = collectionMediaDirectory(options.db);
    try {
      if (!(await lstat(directory)).isDirectory())
        throw new AppError(
          "Collection media path must be a directory; symbolic links are refused.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let alreadyDownloaded = 0;
    for (const image of images) {
      signal?.throwIfAborted();
      const valid =
        image.status === "complete" &&
        (await readStoredImage(directory, storedImageDescriptor(image)));
      if (valid && !options.refreshMedia) {
        alreadyDownloaded++;
        continue;
      }
      if (image.status === "complete" && !valid) store.imagePending(image.key);
      const source = imageSourceUrl(image.source_url);
      if (
        !source ||
        createHash("sha256").update(source.href).digest("hex") !== image.key
      )
        throw new AppError(
          "Stored image source identity is invalid; download refused.",
        );
      pending.push({
        id: image.key,
        originalarrivaltime: "1970-01-01T00:00:00.001Z",
        messagetype: "RichText/Html",
        content: `<img src="${source.href}">`,
      });
    }
    const unsupported = store.unsupportedImages(chat);
    onProgress?.({
      phase: "summary",
      message: `[images] Images: ${images.length}; already downloaded: ${alreadyDownloaded}; to process: ${pending.length}; unsupported: ${unsupported}.`,
    });
    if (pending.length === 0)
      onProgress?.({
        phase: "summary",
        message:
          "[images] No images need downloading; no media requests needed.",
      });
    let failed = 0;
    let failureReason: string | undefined;
    const result = await downloadImages(
      pending,
      options.db,
      credentials,
      http,
      {
        directory,
        unsupported,
        cacheRoot,
        refresh: options.refreshMedia,
        signal,
        unavailableOrigins,
        onProgress,
        onSummary: onProgress
          ? (message) => onProgress({ phase: "summary", message })
          : undefined,
        onImage: (image) => store!.saveImage(image),
        onImageFailure: (key, reason) => store!.imageFailed(key, reason),
      },
    ).catch((error: unknown) => {
      if (!(error instanceof IncompleteImageDownload)) throw error;
      failed = error.failedKeys.size;
      failureReason = error.reason;
      return error.media;
    });
    return {
      database: options.db,
      status: result.status,
      images: images.length,
      alreadyDownloaded,
      saved: result.downloaded + result.cacheHits,
      downloaded: result.downloaded,
      cacheHits: result.cacheHits,
      unsupported,
      failed,
      ...(failureReason === undefined ? {} : { failureReason }),
    };
  } catch (error) {
    throw new AppError(
      `${signal?.aborted ? "Database media download cancelled." : errorMessage(error)} Completed image files and database records remain saved; rerun images to continue.`,
    );
  } finally {
    store?.close();
    await release();
  }
}
