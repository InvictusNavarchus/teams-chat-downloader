import { mkdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import dayjs from "dayjs";
import type { Archive } from "./archive.ts";
import type { DatabaseExportOptions } from "./command-validation.ts";
import { convertArchive } from "./convert.ts";
import { assertDailyArchive, prepareDailyDirectory } from "./daily-export.ts";
import { AppError } from "./errors.ts";
import { defaultExportDirectory } from "./export-path.ts";
import { HistoryStore, collectionMediaDirectory } from "./history-store.ts";
import { renderMarkdown } from "./markdown.ts";
import { readStoredImage } from "./media.ts";
import {
  checkOutput,
  updateExport,
  updateMarkdown,
  withArchiveLock,
  writeExport,
} from "./output.ts";

export async function exportDatabase(
  options: DatabaseExportOptions,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
) {
  signal?.throwIfAborted();
  if (options.last !== undefined)
    return exportDailyDatabase(options, signal, onProgress);
  const directory = options.out!;
  await checkOutput(directory);
  const store = await HistoryStore.open(options.db);
  let archive;
  try {
    const chat = options.chat ?? store.chatIdForLabel(options.chatLabel!);
    onProgress?.(`[export-db] Selected stored chat: ${JSON.stringify(chat)}.`);
    archive = store.archive(chat, options.window);
  } finally {
    store.close();
  }
  signal?.throwIfAborted();
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    throw new AppError(
      "Could not create a new database export directory; choose a new --out.",
    );
  }
  return publishDatabaseArchive(
    options,
    archive,
    directory,
    false,
    signal,
    onProgress,
  );
}

async function exportDailyDatabase(
  options: DatabaseExportOptions,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
) {
  const store = await HistoryStore.open(options.db);
  try {
    const chat = options.chat ?? store.chatIdForLabel(options.chatLabel!);
    onProgress?.(`[export-db] Selected stored chat: ${JSON.stringify(chat)}.`);
    const requested = options.window!;
    const bounds = store.completedBounds(chat);
    const to = Math.min(requested.to, bounds.to);
    if (to <= requested.from || bounds.from >= requested.to)
      throw new AppError(
        "No completed history overlaps the requested daily range; collect that range before exporting.",
      );
    if (store.missing(chat, { from: requested.from, to }).length)
      throw new AppError(
        "Requested daily range has uncollected gaps; run collect for that range before exporting.",
      );
    onProgress?.(
      `[export-db] Daily range verified; collected cutoff: ${new Date(to).toISOString()}.`,
    );
    if (to < requested.to)
      onProgress?.(
        `[export-db] Skipping uncollected tail: ${new Date(to).toISOString()} to ${new Date(requested.to).toISOString()}.`,
      );
    const days = [];
    for (let from = requested.from; from < to; ) {
      signal?.throwIfAborted();
      // Advance calendar boundaries rather than assuming every day is 24 hours.
      const end = Math.min(
        dayjs(from).add(1, "day").startOf("day").valueOf(),
        to,
      );
      const window = { from, to: end };
      const archive = store.archive(chat, window);
      const directory = defaultExportDirectory(
        { chat, last: "1d", window },
        typeof archive.chatLabel === "string" ? archive.chatLabel : undefined,
      );
      const created = await prepareDailyDirectory(directory);
      let published = false;
      let reserved = false;
      try {
        const result = await withArchiveLock(
          join(directory, "chat.json"),
          async () => {
            reserved = true;
            const refresh = !created.includes(directory);
            if (refresh)
              await assertDailyArchive(
                directory,
                chat,
                store.accountId,
                window,
              );
            onProgress?.(
              `[export-db] Exporting ${dayjs(from).format("YYYY-MM-DD")} to ${directory}.`,
            );
            return publishDatabaseArchive(
              options,
              archive,
              directory,
              refresh,
              signal,
              onProgress,
              () => {
                published = true;
              },
            );
          },
        );
        days.push(result);
      } finally {
        if (reserved && !published) {
          for (const path of created.reverse()) {
            try {
              await rmdir(path);
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "ENOTEMPTY" || code === "EEXIST") break;
              if (code !== "ENOENT") throw error;
            }
          }
        }
      }
      from = end;
    }
    return {
      ...days[days.length - 1]!,
      messages: days.reduce((sum, day) => sum + day.messages, 0),
      days,
    };
  } finally {
    store.close();
  }
}

async function publishDatabaseArchive(
  options: DatabaseExportOptions,
  archive: Archive,
  directory: string,
  refresh: boolean,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
  onPublished?: () => void,
) {
  onProgress?.(
    `[export-db] Verified coverage; ${archive.messages.length} messages selected.`,
  );
  let published = false;
  try {
    if (!options.media) archive.media = { status: "not-downloaded" };
    if (archive.media.status !== "not-downloaded") {
      const copied = new Set<string>();
      for (const image of archive.media.images) {
        signal?.throwIfAborted();
        if (copied.has(image.path)) continue;
        const bytes = await readStoredImage(
          collectionMediaDirectory(options.db),
          image,
        );
        if (!bytes)
          throw new AppError(
            "A collected image file is missing or corrupt; run media-db to repair it, or export-db --no-media for text only.",
          );
        const media = join(directory, "media");
        await mkdir(media, { mode: 0o700, recursive: true });
        if (!refresh || !(await readStoredImage(media, image))) {
          const destination = join(media, basename(image.path));
          const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
          try {
            await writeFile(temporary, bytes, {
              mode: 0o600,
              flag: "wx",
              signal,
            });
            signal?.throwIfAborted();
            await rename(temporary, destination);
          } finally {
            await unlink(temporary).catch(() => {});
          }
        }
        copied.add(image.path);
        onProgress?.(`[export-db] Copied ${copied.size} image(s).`);
      }
    }
    const output = await (refresh ? updateExport : writeExport)(
      join(directory, "chat.json"),
      archive,
      signal,
    );
    published = true;
    onPublished?.();
    onProgress?.("[export-db] Saved JSON archive.");
    const markdown = options.markdown
      ? refresh
        ? await updateMarkdown(
            join(directory, "chat.md"),
            renderMarkdown(archive),
            signal,
          )
        : (await convertArchive({ input: output, format: "markdown" }, signal))
            .output
      : undefined;
    if (!options.markdown && refresh)
      await unlink(join(directory, "chat.md")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    if (markdown) onProgress?.("[export-db] Saved Markdown transcript.");
    return {
      output,
      messages: archive.messages.length,
      ...(markdown ? { markdown } : {}),
    };
  } catch (error) {
    if (!published && options.last === undefined)
      await rm(directory, { recursive: true, force: true });
    if (!published && options.last !== undefined && !refresh)
      await rm(join(directory, "media"), { recursive: true, force: true });
    if (published)
      throw new AppError(
        "JSON database export was saved, but Markdown publication failed; regenerate it with teams convert.",
      );
    throw error;
  }
}
