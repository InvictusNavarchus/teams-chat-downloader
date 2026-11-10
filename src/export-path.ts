import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultExportRoot } from "./config.ts";
import { AppError } from "./errors.ts";
import type { ExportOptions } from "./command-validation.ts";

export function defaultExportDirectory(
  options: ExportOptions,
  label?: string,
): string {
  if (options.chat === undefined)
    throw new AppError(
      "Resolve the chat label to a raw ID before naming an export.",
    );
  const normalized = (label ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-");
  // Bound even multibyte labels so the directory name fits a filesystem component.
  const slug = Array.from(normalized)
    .slice(0, 40)
    .join("")
    .replace(/^-+|-+$/g, "");
  const unresolved =
    !slug ||
    label === "Untitled chat" ||
    label === "Unresolved one-to-one chat";
  const name = unresolved
    ? `${slug || "chat"}-${createHash("sha256").update(options.chat).digest("hex").slice(0, 10)}`
    : slug;
  const from = filenameTimestamp(options.window.from);
  const to = filenameTimestamp(options.window.to);
  const period = options.last
    ? `last-${options.last}--to-${to}`
    : `${options.since ? "since" : "from"}-${from}--to-${to}`;
  return join(defaultExportRoot, `${name}--${period}`);
}

function filenameTimestamp(value: number): string {
  return new Date(value).toISOString().replace(/[:.]/g, "-");
}
