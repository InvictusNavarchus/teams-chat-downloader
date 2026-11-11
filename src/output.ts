import {
  access,
  link,
  mkdir,
  open,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AppError } from "./errors.ts";

export async function checkOutput(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new AppError("Cannot access the output destination.");
  }
  throw new AppError("Output already exists; choose a new --out path.");
}

export async function writeExport(
  path: string,
  document: unknown,
  signal?: AbortSignal,
): Promise<string> {
  return writeJson(path, document, "export", signal);
}

// Daily refreshes and media passes replace previously published archives.
export async function updateExport(
  path: string,
  document: unknown,
  signal?: AbortSignal,
): Promise<string> {
  return writeJson(path, document, "export", signal, true);
}

export async function writeChatList(
  path: string,
  document: unknown,
  signal?: AbortSignal,
): Promise<string> {
  return writeJson(path, document, "chat list", signal);
}

export async function writeMarkdown(
  path: string,
  markdown: string,
  signal?: AbortSignal,
): Promise<string> {
  return writeText(path, markdown, "export", signal);
}

export async function updateMarkdown(
  path: string,
  markdown: string,
  signal?: AbortSignal,
): Promise<string> {
  return writeText(path, markdown, "export", signal, true);
}

// Daily history refreshes and media updates share one reservation. Keep the
// established lock path so older media processes also exclude daily writers.
export async function withArchiveLock<T>(
  output: string,
  action: () => Promise<T>,
): Promise<T> {
  const lock = `${resolve(output)}.media.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    throw new AppError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "An archive update is already running. If it crashed, inspect and remove the adjacent .media.lock directory before retrying."
        : "Could not reserve the archive for an update.",
    );
  }
  try {
    return await action();
  } finally {
    await rmdir(lock);
  }
}

function writeJson(
  path: string,
  document: unknown,
  kind: "export" | "chat list",
  signal?: AbortSignal,
  replace = false,
): Promise<string> {
  return writeText(
    path,
    `${JSON.stringify(document, null, 2)}\n`,
    kind,
    signal,
    replace,
  );
}

async function writeText(
  path: string,
  text: string,
  kind: "export" | "chat list",
  signal?: AbortSignal,
  replace = false,
): Promise<string> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    if (kind === "chat list" || replace) {
      // Readers see either the complete previous file or the complete update.
      await rename(temporary, destination);
    } else {
      // History exports must not replace a destination created during retrieval.
      await link(temporary, destination);
    }
  } catch (error) {
    if (replace)
      throw new AppError(
        signal?.aborted
          ? "Export update cancelled; previous file kept."
          : "Could not update the saved export; previous file kept.",
      );
    if (signal?.aborted)
      throw new AppError(
        kind === "export"
          ? "Export cancelled before output publication."
          : "Chat list save cancelled; previous file kept.",
      );
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new AppError("Output already exists; choose a new --out path.");
    throw new AppError(
      kind === "export"
        ? "Could not publish the complete export; the destination was not overwritten."
        : "Could not save the chat list; previous file kept.",
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return destination;
}
