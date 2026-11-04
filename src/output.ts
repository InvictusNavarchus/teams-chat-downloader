import { access, link, mkdir, open, unlink } from "node:fs/promises";
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
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(document, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    // Atomic publication without replacing a destination created during retrieval.
    await link(temporary, destination);
  } catch (error) {
    if (signal?.aborted)
      throw new AppError("Export cancelled before output publication.");
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new AppError("Output already exists; choose a new --out path.");
    throw new AppError(
      "Could not publish the complete export; the destination was not overwritten.",
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return destination;
}
