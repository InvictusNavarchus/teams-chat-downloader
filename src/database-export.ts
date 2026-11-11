import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseExportOptions } from "./command-validation.ts";
import { convertArchive } from "./convert.ts";
import { AppError } from "./errors.ts";
import { HistoryStore } from "./history-store.ts";
import { checkOutput, writeExport } from "./output.ts";

export async function exportDatabase(
  options: DatabaseExportOptions,
  signal?: AbortSignal,
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
    const output = await writeExport(
      join(options.out, "chat.json"),
      archive,
      signal,
    );
    published = true;
    const markdown = options.markdown
      ? (await convertArchive({ input: output, format: "markdown" }, signal))
          .output
      : undefined;
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
