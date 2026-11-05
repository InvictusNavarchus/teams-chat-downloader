import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { convertArchive, markdownPath } from "./convert.ts";
import { AppError } from "./errors.ts";
import type { BatchConvertOptions } from "./options.ts";

type FileResult = {
  input: string;
  output: string;
} & (
  | { status: "converted"; messages: number }
  | { status: "skipped" }
  | { status: "failed"; error: string }
);

export async function convertAllArchives(
  options: BatchConvertOptions,
  signal?: AbortSignal,
) {
  const directory = resolve(options.dir);
  const files: FileResult[] = [];
  const summary = {
    directory,
    format: options.format,
    recursive: options.recursive,
    converted: 0,
    skipped: 0,
    failed: 0,
    files,
  };
  const checkCancellation = () => {
    if (signal?.aborted)
      throw new AppError(
        "Batch conversion cancelled; completed files were kept.",
      );
  };
  checkCancellation();
  for await (const input of jsonFiles(directory, options.recursive)) {
    checkCancellation();
    const output = markdownPath(input);
    try {
      if (await destinationExists(output)) {
        files.push({ input, output, status: "skipped" });
        summary.skipped++;
        continue;
      }
      const result = await convertArchive(
        { input, format: options.format },
        signal,
      );
      files.push({
        input,
        output,
        status: "converted",
        messages: result.messages,
      });
      summary.converted++;
    } catch (error) {
      checkCancellation();
      files.push({
        input,
        output,
        status: "failed",
        error:
          error instanceof AppError
            ? error.message
            : "Could not convert this export.",
      });
      summary.failed++;
    }
  }
  checkCancellation();
  return summary;
}

async function* jsonFiles(
  directory: string,
  recursive: boolean,
): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => {
      throw new AppError(`Could not read conversion directory: ${directory}.`);
    },
  );
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (recursive) yield* jsonFiles(path, recursive);
      else {
        const input = join(path, "chat.json");
        const info = await lstat(input).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return;
            throw new AppError(`Could not inspect export folder: ${path}.`);
          },
        );
        if (info?.isFile()) yield input;
      }
    } else if (entry.isFile() && /\.json$/i.test(entry.name)) yield path;
  }
}

async function destinationExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AppError("Cannot access the Markdown destination.");
  }
}
