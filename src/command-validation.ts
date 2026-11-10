import { dirname, join, resolve } from "node:path";
import dayjs from "dayjs";
import { z } from "zod";
import {
  commandDefaults,
  defaultExportRoot,
  defaultOutputFormat,
  defaultPageDelay,
  loginTimeout,
  pageDelayLimits,
} from "./config.ts";
import { defaultCredentialsPath } from "./credentials.ts";
import { assertWindow, type Window } from "./date-window.ts";
import { AppError, validationError } from "./errors.ts";

const timestampSchema = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value),
  );
const pageDelaySchema = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .transform(Number),
  ])
  .pipe(z.number().min(pageDelayLimits.min).max(pageDelayLimits.max));
const exportOptionsSchema = z.strictObject({
  chat: z.string().min(1).optional(),
  chatLabel: z.string().trim().min(1).optional(),
  credentials: z.string().min(1).optional(),
  out: z.string().min(1).optional(),
  markdown: z.boolean().default(commandDefaults.markdown),
  media: z.boolean().default(commandDefaults.media),
  refreshMedia: z.boolean().default(commandDefaults.refreshMedia),
  pageDelayMin: pageDelaySchema.default(defaultPageDelay.min),
  pageDelayMax: pageDelaySchema.default(defaultPageDelay.max),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  since: timestampSchema.optional(),
  last: z
    .string()
    .regex(/^[1-9]\d*d$/)
    .optional(),
});

export type ExportOptions = z.infer<typeof exportOptionsSchema> & {
  window: Window;
};

const liveSmokeOptionsSchema = z.strictObject({
  chat: z.string().trim().min(1),
  from: timestampSchema,
  to: timestampSchema,
  credentials: z.string().min(1).optional(),
});

export type LiveSmokeOptions = z.infer<typeof liveSmokeOptionsSchema> & {
  window: Window;
};

export function resolveLiveSmokeOptions(
  input: unknown,
  now = Date.now(),
): LiveSmokeOptions {
  const result = liveSmokeOptionsSchema.safeParse(input);
  if (!result.success)
    throw validationError("Live smoke options", result.error);
  const options = result.data;
  const window = { from: Date.parse(options.from), to: Date.parse(options.to) };
  assertWindow(window);
  if (window.to > now)
    throw new AppError("Live smoke --to must be in the past.");
  return { ...options, window };
}

const mediaOptionsSchema = z.strictObject({
  input: z.string().min(1),
  credentials: z.string().min(1).optional(),
  markdown: z.boolean().default(commandDefaults.markdown),
  refreshMedia: z.boolean().default(commandDefaults.refreshMedia),
});

export type MediaOptions = z.infer<typeof mediaOptionsSchema>;

export function resolveMediaOptions(input: unknown): MediaOptions {
  const result = mediaOptionsSchema.safeParse(input);
  if (!result.success) throw validationError("Media options", result.error);
  return result.data;
}

const convertOptionsSchema = z.strictObject({
  input: z.string().min(1),
  out: z.string().min(1).optional(),
  format: z.literal(defaultOutputFormat).default(defaultOutputFormat),
});

export type ConvertOptions = z.infer<typeof convertOptionsSchema>;

export function resolveConvertOptions(input: unknown): ConvertOptions {
  const result = convertOptionsSchema.safeParse(input);
  if (!result.success) throw validationError("Convert options", result.error);
  return result.data;
}

const batchConvertOptionsSchema = z.strictObject({
  dir: z.string().min(1).default(defaultExportRoot),
  recursive: z.boolean().default(commandDefaults.recursive),
  format: z.literal(defaultOutputFormat).default(defaultOutputFormat),
});

export type BatchConvertOptions = z.infer<typeof batchConvertOptionsSchema>;

export function resolveBatchConvertOptions(
  input: unknown,
): BatchConvertOptions {
  const result = batchConvertOptionsSchema.safeParse(input);
  if (!result.success)
    throw validationError("Batch convert options", result.error);
  return result.data;
}

export function resolveExportOptions(
  input: unknown,
  now = Date.now(),
): ExportOptions {
  const result = exportOptionsSchema.safeParse(input);
  if (!result.success) throw validationError("Export options", result.error);
  const options = result.data;
  if (
    Number(options.chat !== undefined) +
      Number(options.chatLabel !== undefined) !==
    1
  )
    throw new AppError(
      "Choose exactly one of --chat <id> or --chat-label <label>.",
    );
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

const loginOptionsSchema = z.strictObject({
  credentials: z.string().min(1).optional(),
  browser: z.string().min(1).optional(),
  browserProfile: z.string().min(1).optional(),
  waitForMedia: z.boolean().default(commandDefaults.waitForMedia),
  timeout: z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(loginTimeout.min).max(loginTimeout.max))
    .default(loginTimeout.default),
});
export type LoginOptions = {
  credentials: string;
  browser?: string;
  browserProfile: string;
  timeout: number;
  waitForMedia?: boolean;
};
export function resolveLoginOptions(input: unknown): LoginOptions {
  const result = loginOptionsSchema.safeParse(input);
  if (!result.success) throw validationError("Login options", result.error);
  const options = result.data;
  return {
    credentials: resolve(options.credentials ?? defaultCredentialsPath()),
    browser:
      options.browser ??
      [
        "chromium-browser",
        "chromium",
        "google-chrome",
        "google-chrome-stable",
        "msedge",
      ]
        .map((name) => Bun.which(name))
        .find((path) => path !== null),
    browserProfile: resolve(
      options.browserProfile ??
        join(dirname(defaultCredentialsPath()), "browser"),
    ),
    timeout: options.timeout,
    waitForMedia: options.waitForMedia,
  };
}

const chatsOptionsSchema = z.object({
  credentials: z.string().min(1).optional(),
  out: z.string().min(1).optional(),
  refreshNames: z.boolean().optional(),
});

export type ChatsOptions = z.infer<typeof chatsOptionsSchema>;

export function resolveChatsOptions(input: unknown): ChatsOptions {
  const result = chatsOptionsSchema.safeParse(input);
  if (!result.success) throw validationError("Chat options", result.error);
  return result.data;
}
