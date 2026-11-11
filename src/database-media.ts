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
import type { Http } from "./http.ts";
import {
  downloadImages,
  imageSourceUrl,
  readStoredImage,
  type MediaProgress,
} from "./media.ts";

export async function downloadDatabaseMedia(
  options: DatabaseMediaOptions,
  credentials: Credentials,
  http: Http,
  signal?: AbortSignal,
  onProgress?: (event: MediaProgress) => void,
  cacheRoot?: string,
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
    const images = store.images(options.chat);
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
      if (!valid) store.imagePending(image.key);
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
    const completed = new Set<string>();
    const unsupported = store.unsupportedImages(options.chat);
    try {
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
          onProgress,
          onImage(image) {
            store!.saveImage(image);
            completed.add(image.key);
          },
        },
      );
      return {
        database: options.db,
        status: unsupported ? "partial" : "complete",
        images: images.length,
        alreadyDownloaded,
        saved: completed.size,
        downloaded: result.downloaded,
        cacheHits: result.cacheHits,
        unsupported,
      };
    } catch (error) {
      const active = pending.find((message) => !completed.has(message.id));
      if (active)
        store.imageFailed(
          active.id,
          signal?.aborted ? "Image download cancelled." : errorMessage(error),
          signal?.aborted,
        );
      throw error;
    }
  } catch (error) {
    throw new AppError(
      `${signal?.aborted ? "Database media download cancelled." : errorMessage(error)} Completed image files and database records remain saved; rerun media-db to continue.`,
    );
  } finally {
    store?.close();
    await release();
  }
}
