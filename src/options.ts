import dayjs from "dayjs";
import { z } from "zod";
import { AppError, validationError } from "./errors.ts";

const timestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value),
  );
export const defaultPageDelay = { min: 2, max: 5 };
const pageDelay = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .transform(Number),
  ])
  .pipe(z.number().min(0).max(3600));
const exportOptions = z.strictObject({
  chat: z.string().min(1),
  credentials: z.string().min(1).optional(),
  out: z.string().min(1).optional(),
  markdown: z.boolean().default(true),
  media: z.boolean().default(true),
  refreshMedia: z.boolean().default(false),
  pageDelayMin: pageDelay.default(defaultPageDelay.min),
  pageDelayMax: pageDelay.default(defaultPageDelay.max),
  from: timestamp.optional(),
  to: timestamp.optional(),
  since: timestamp.optional(),
  last: z
    .string()
    .regex(/^[1-9]\d*d$/)
    .optional(),
});

export type Window = { from: number; to: number };
export type ExportOptions = z.infer<typeof exportOptions> & { window: Window };

const mediaOptions = z.strictObject({
  input: z.string().min(1),
  credentials: z.string().min(1).optional(),
  markdown: z.boolean().default(true),
  refreshMedia: z.boolean().default(false),
});

export type MediaOptions = z.infer<typeof mediaOptions>;

export function resolveMediaOptions(input: unknown): MediaOptions {
  const result = mediaOptions.safeParse(input);
  if (!result.success) throw validationError("Media options", result.error);
  return result.data;
}

const convertOptions = z.strictObject({
  input: z.string().min(1),
  out: z.string().min(1).optional(),
  format: z.literal("markdown").default("markdown"),
});

export type ConvertOptions = z.infer<typeof convertOptions>;

export function resolveConvertOptions(input: unknown): ConvertOptions {
  const result = convertOptions.safeParse(input);
  if (!result.success) throw validationError("Convert options", result.error);
  return result.data;
}

const batchConvertOptions = z.strictObject({
  dir: z.string().min(1).default("exports"),
  recursive: z.boolean().default(false),
  format: z.literal("markdown").default("markdown"),
});

export type BatchConvertOptions = z.infer<typeof batchConvertOptions>;

export function resolveBatchConvertOptions(
  input: unknown,
): BatchConvertOptions {
  const result = batchConvertOptions.safeParse(input);
  if (!result.success)
    throw validationError("Batch convert options", result.error);
  return result.data;
}

export function resolveExportOptions(
  input: unknown,
  now = Date.now(),
): ExportOptions {
  const result = exportOptions.safeParse(input);
  if (!result.success) throw validationError("Export options", result.error);
  const options = result.data;
  if (options.pageDelayMin > options.pageDelayMax)
    throw new AppError("--page-delay-min must not exceed --page-delay-max.");
  if (!options.media && options.refreshMedia)
    throw new AppError("--refresh-media cannot be combined with --no-media.");
  const modes =
    Number(options.last !== undefined) +
    Number(options.since !== undefined) +
    Number(options.from !== undefined);
  if (modes !== 1 || (options.to !== undefined && options.from === undefined)) {
    throw new AppError(
      "Choose exactly one of --last Nd, --since <timestamp>, or --from <timestamp> --to <timestamp>.",
    );
  }
  if (options.from !== undefined && options.to === undefined) {
    throw new AppError(
      "--from requires --to; use --since for a window ending now.",
    );
  }
  const to = options.to === undefined ? now : Date.parse(options.to);
  const from =
    options.last !== undefined
      ? dayjs(to)
          .subtract(Number(options.last.slice(0, -1)) - 1, "day")
          .startOf("day")
          .valueOf()
      : Date.parse(options.since ?? options.from ?? "");
  assertWindow({ from, to });
  return { ...options, window: { from, to } };
}

export function assertWindow(window: Window): void {
  if (
    !Number.isSafeInteger(window.from) ||
    !Number.isSafeInteger(window.to) ||
    window.from < 0 ||
    window.to > 8_640_000_000_000_000 ||
    window.from >= window.to
  ) {
    throw new AppError(
      "The date window must be nonempty, ordered, and representable as nonnegative millisecond timestamps.",
    );
  }
}
