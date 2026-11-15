import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DatabaseExportOptions } from "./command-validation.ts";
import { convertArchive } from "./convert.ts";
import { AppError } from "./errors.ts";
import { HistoryStore, collectionMediaDirectory } from "./history-store.ts";
import { readStoredImage } from "./media.ts";
import { checkOutput, writeExport } from "./output.ts";

export async function exportDatabase(
  options: DatabaseExportOptions,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
) {
  signal?.throwIfAborted();
  await checkOutput(options.out);
  const store = await HistoryStore.open(options.db);
  let archive;
  try {
    archive = store.archive(options.chat, options.window);
  } finally {
    store.close();
  }
  signal?.throwIfAborted();
  onProgress?.(
    `[export-db] Verified coverage; ${archive.messages.length} messages selected.`,
  );
  await mkdir(dirname(options.out), { recursive: true, mode: 0o700 });
  try {
    await mkdir(options.out, { mode: 0o700 });
  } catch {
    throw new AppError(
      "Could not create a new database export directory; choose a new --out.",
    );
  }
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
        await mkdir(join(options.out, "media"), {
          mode: 0o700,
          recursive: true,
        });
        await writeFile(
          join(options.out, "media", basename(image.path)),
          bytes,
          { mode: 0o600, flag: "wx", signal },
        );
        copied.add(image.path);
        onProgress?.(`[export-db] Copied ${copied.size} image(s).`);
      }
    }
    const output = await writeExport(
      join(options.out, "chat.json"),
      archive,
      signal,
    );
    published = true;
    onProgress?.("[export-db] Saved JSON archive.");
    const markdown = options.markdown
      ? (await convertArchive({ input: output, format: "markdown" }, signal))
          .output
      : undefined;
    if (markdown) onProgress?.("[export-db] Saved Markdown transcript.");
    return {
      output,
      messages: archive.messages.length,
      ...(markdown ? { markdown } : {}),
    };
  } catch (error) {
    if (!published) await rm(options.out, { recursive: true, force: true });
    else
      throw new AppError(
        "JSON database export was saved, but Markdown conversion failed; regenerate it with teams convert.",
      );
    throw error;
  }
}
