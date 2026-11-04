import { dirname, relative, resolve, sep } from "node:path";
import { readArchive } from "./archive.ts";
import { AppError } from "./errors.ts";
import { renderMarkdown } from "./markdown.ts";
import type { ConvertOptions } from "./options.ts";
import { checkOutput, writeMarkdown } from "./output.ts";

export function markdownPath(input: string): string {
  return /\.json$/i.test(input) ? input.slice(0, -5) + ".md" : `${input}.md`;
}

export async function convertArchive(
  options: ConvertOptions,
  signal?: AbortSignal,
) {
  const out = options.out ?? markdownPath(options.input);
  await checkOutput(out);
  const archive = await readArchive(options.input, signal);
  signal?.throwIfAborted();
  let markdown: string;
  try {
    markdown = renderMarkdown(archive, undefined, (path) =>
      relative(
        dirname(resolve(out)),
        resolve(dirname(resolve(options.input)), path),
      )
        .split(sep)
        .join("/"),
    );
  } catch {
    throw new AppError("Could not render the JSON export as Markdown.");
  }
  const output = await writeMarkdown(out, markdown, signal);
  return {
    input: resolve(options.input),
    output,
    format: options.format,
    messages: archive.messages.length,
  };
}
