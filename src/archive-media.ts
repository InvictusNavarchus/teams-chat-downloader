import { resolve } from "node:path";
import { z } from "zod";
import { readArchive } from "./archive.ts";
import { markdownPath } from "./convert.ts";
import type { Credentials } from "./credentials.ts";
import { AppError } from "./errors.ts";
import type { ExportProgressEvent } from "./export.ts";
import type { Http, RequestStats } from "./http.ts";
import { renderMarkdown } from "./markdown.ts";
import { downloadImages } from "./media.ts";
import type { MediaOptions } from "./command-validation.ts";
import { updateExport, updateMarkdown, withArchiveLock } from "./output.ts";

const countsSchema = z.looseObject({
  total: z.number().int().nonnegative().default(0),
  history: z.number().int().nonnegative().default(0),
  directory: z.number().int().nonnegative().default(0),
  profiles: z.number().int().nonnegative().default(0),
  media: z.number().int().nonnegative().default(0),
  retries: z.number().int().nonnegative().default(0),
});

export async function downloadArchiveMedia(
  options: MediaOptions,
  credentials: Credentials,
  http: Http,
  stats: RequestStats,
  signal?: AbortSignal,
  onProgress?: (event: ExportProgressEvent) => void,
) {
  const output = resolve(options.input);
  return withArchiveLock(output, () =>
    downloadLockedArchiveMedia(
      options,
      credentials,
      http,
      stats,
      signal,
      onProgress,
    ),
  );
}

// Callers must hold withArchiveLock for the entire read/modify/write lifecycle.
export async function downloadLockedArchiveMedia(
  options: MediaOptions,
  credentials: Credentials,
  http: Http,
  stats: RequestStats,
  signal?: AbortSignal,
  onProgress?: (event: ExportProgressEvent) => void,
) {
  const output = resolve(options.input);
  let loaded = false;
  try {
    const archive = await readArchive(output, signal);
    loaded = true;
    if (archive.accountId !== credentials.accountId)
      throw new AppError(
        "Archive account does not match the credentials; use credentials for the account that created this export.",
      );
    const counts = countsSchema.safeParse(archive.requests ?? {});
    if (!counts.success)
      throw new AppError("Input export has invalid request counts.");
    const before = { ...stats };
    archive.media = await downloadImages(
      archive.messages,
      output,
      credentials,
      http,
      {
        refresh: options.refreshMedia,
        signal,
        onProgress: (event) => {
          if (event.phase === "start")
            onProgress?.({ type: "media-start", total: event.total });
          else
            onProgress?.({
              type: "media-progress",
              current: event.current,
              total: event.total,
              outcome: event.outcome,
            });
        },
      },
    );
    // Add only this pass: export's history requests are already in the archive.
    const requests = counts.data;
    for (const key of Object.keys(before) as (keyof RequestStats)[])
      requests[key] += stats[key] - before[key];
    requests.scope =
      "HTTP client attempts for published history and media passes; retries included; failed media passes excluded; redirects refused; browser traffic excluded";
    archive.requests = requests;
    archive.mediaUpdatedAt = new Date().toISOString();
    await updateExport(output, archive, signal);
    onProgress?.({ type: "save", format: "json", destination: output });
    let markdown: string | undefined;
    if (options.markdown) {
      try {
        markdown = await updateMarkdown(
          markdownPath(output),
          renderMarkdown(archive),
          signal,
        );
        onProgress?.({
          type: "convert",
          format: "markdown",
          destination: markdown,
        });
      } catch {
        throw new AppError(
          "Media manifest saved, but Markdown could not be updated. Previous Markdown kept; retry this media command to regenerate it from the saved JSON.",
        );
      }
    }
    return {
      output,
      messages: archive.messages.length,
      ...(markdown ? { markdown } : {}),
    };
  } catch (error) {
    if (!loaded) throw error;
    const reason =
      error instanceof AppError
        ? error.message
        : "Media update could not finish.";
    throw new AppError(
      `Saved chat text kept at ${output}. ${reason} Retry images with teams media --input <saved-json>.`,
    );
  }
}
