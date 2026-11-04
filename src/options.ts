import { z } from "zod";
import { AppError, validationError } from "./errors.ts";

const timestamp = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value),
  );
const exportOptions = z.strictObject({
  chat: z.string().min(1),
  credentials: z.string().min(1),
  out: z.string().min(1),
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

export function resolveExportOptions(
  input: unknown,
  now = Date.now(),
): ExportOptions {
  const result = exportOptions.safeParse(input);
  if (!result.success) throw validationError("Export options", result.error);
  const options = result.data;
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
      ? to - Number(options.last.slice(0, -1)) * 86_400_000
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
