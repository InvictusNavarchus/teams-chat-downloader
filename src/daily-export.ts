import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readArchive } from "./archive.ts";
import type { Window } from "./date-window.ts";
import { AppError } from "./errors.ts";

export async function prepareDailyDirectory(
  directory: string,
): Promise<string[]> {
  const created: string[] = [];
  // The default layout has exactly three components: exports/chat/date.
  // Reject symlinks rather than refreshing an archive outside that layout.
  for (const path of [
    dirname(dirname(directory)),
    dirname(directory),
    directory,
  ]) {
    try {
      await mkdir(path, { mode: 0o700 });
      created.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new AppError("Could not create the daily export directory.");
    }
    if (!(await lstat(path)).isDirectory())
      throw new AppError(
        "Daily export paths must be regular directories, without symlinks.",
      );
  }
  return created;
}

export async function assertDailyArchive(
  directory: string,
  chat: string,
  accountId: string,
  window: Window,
): Promise<void> {
  for (const [name, kind] of [
    ["chat.json", "file"],
    ["chat.md", "file"],
    ["media", "directory"],
  ] as const) {
    const info = await lstat(join(directory, name)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && name !== "chat.json") return;
        throw new AppError(
          "Cannot verify the existing daily export; choose a new --out directory.",
        );
      },
    );
    if (info && !(kind === "file" ? info.isFile() : info.isDirectory()))
      throw new AppError(
        "Daily export files and media must not be symlinks or unexpected file types.",
      );
  }
  const archive = await readArchive(join(directory, "chat.json"));
  if (
    archive.accountId !== accountId ||
    archive.chatId !== chat ||
    Date.parse(archive.window.from) !== window.from ||
    Date.parse(archive.window.toExclusive) > window.to
  )
    throw new AppError(
      "Existing daily export belongs to another account, chat, or date window, or is newer than this invocation; choose a new --out directory.",
    );
}
