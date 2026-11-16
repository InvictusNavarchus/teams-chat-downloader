import { dirname, join, resolve } from "node:path";
import dayjs from "dayjs";
import { z } from "zod";
import { assertSelectableChatLabel } from "./chat-selection.ts";
import {
  commandDefaults,
  collectionBackupSuffix,
  defaultExportRoot,
  defaultLiveSmokeDays,
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
  chat: z.string().trim().min(1).optional(),
  chatLabel: z.string().trim().min(1).optional(),
  fixture: z.string().min(1).optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
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
  if (
    Number(options.chat !== undefined) +
      Number(options.chatLabel !== undefined) +
      Number(options.fixture !== undefined) >
    1
  )
    throw new AppError(
      "Choose at most one of --chat <id>, --chat-label <label>, or --fixture <archive>; omit all for automatic discovery.",
    );
  if (options.chatLabel !== undefined)
    assertSelectableChatLabel(options.chatLabel);
  if ((options.from === undefined) !== (options.to === undefined))
    throw new AppError(
      "Supply both --from and --to, or omit both to use the default live smoke window.",
    );
  const to = options.to === undefined ? now : Date.parse(options.to);
  const from =
    options.from === undefined
      ? calendarDayStart(to, defaultLiveSmokeDays)
      : Date.parse(options.from);
  const window = { from, to };
  assertWindow(window);
  if (window.to > now)
    throw new AppError("Live smoke --to must not be in the future.");
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
  assertChatSelection(options);
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
      ? calendarDayStart(to, Number(options.last.slice(0, -1)))
      : Date.parse(options.since ?? options.from ?? "");
  assertWindow({ from, to });
  return { ...options, window: { from, to } };
}

const collectOptionsSchema = exportOptionsSchema
  .omit({ out: true, markdown: true, media: true, refreshMedia: true })
  .extend({
    db: z.string().min(1),
    all: z.boolean().default(false),
    log: z.boolean().default(commandDefaults.log),
    backup: z.boolean().default(commandDefaults.backup),
    backupDir: z.string().min(1).optional(),
  });

export type CollectOptions = z.infer<typeof collectOptionsSchema> & {
  window: Window;
};

export function resolveCollectOptions(
  input: unknown,
  now = Date.now(),
): CollectOptions {
  const result = collectOptionsSchema.safeParse(input);
  if (!result.success)
    throw validationError("Collection options", result.error);
  const { db, all, backup, backupDir, log: _log, ...options } = result.data;
  if (!backup && backupDir !== undefined)
    throw new AppError("--no-backup cannot be combined with --backup-dir.");
  if (
    all &&
    [options.last, options.since, options.from, options.to].some(
      (v) => v !== undefined,
    )
  )
    throw new AppError("--all cannot be combined with date options.");
  const resolved = resolveExportOptions(
    all ? { ...options, since: new Date(1).toISOString() } : options,
    now,
  );
  if (resolved.window.to > now)
    throw new AppError("Collection end cannot be in the future.");
  return {
    ...result.data,
    window: resolved.window,
    db: resolve(db),
    backupDir: backup
      ? resolve(backupDir ?? `${db}${collectionBackupSuffix}`)
      : undefined,
  };
}

const databaseExportOptionsSchema = z.strictObject({
  log: z.boolean().default(commandDefaults.log),
  db: z.string().min(1),
  chat: z.string().min(1).optional(),
  chatLabel: exportOptionsSchema.shape.chatLabel,
  out: z.string().min(1).optional(),
  last: exportOptionsSchema.shape.last,
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  markdown: z.boolean().default(commandDefaults.markdown),
  media: z.boolean().default(commandDefaults.media),
});
export type DatabaseExportOptions = z.infer<
  typeof databaseExportOptionsSchema
> & { window?: Window };

export function resolveDatabaseExportOptions(
  input: unknown,
  now = Date.now(),
): DatabaseExportOptions {
  const result = databaseExportOptionsSchema.safeParse(input);
  if (!result.success)
    throw validationError("Database export options", result.error);
  const options = result.data;
  assertChatSelection(options);
  if (options.chatLabel !== undefined)
    assertSelectableChatLabel(options.chatLabel);
  if (
    options.last !== undefined &&
    [options.out, options.from, options.to].some((value) => value !== undefined)
  )
    throw new AppError(
      "Use --last Nd for daily folders, or --out with optional paired bounds for one combined archive.",
    );
  if (options.last === undefined && options.out === undefined)
    throw new AppError(
      "Supply --last Nd for daily folders, or --out for one combined archive.",
    );
  if ((options.from === undefined) !== (options.to === undefined))
    throw new AppError(
      "Supply both --from and --to, or omit both to export the collected range.",
    );
  const window =
    options.last !== undefined
      ? {
          from: calendarDayStart(now, Number(options.last.slice(0, -1))),
          to: now,
        }
      : options.from === undefined
        ? undefined
        : { from: Date.parse(options.from), to: Date.parse(options.to!) };
  if (window) assertWindow(window);
  return {
    ...options,
    db: resolve(options.db),
    out: options.out === undefined ? undefined : resolve(options.out),
    window,
  };
}

const databaseMediaOptionsSchema = z.strictObject({
  log: z.boolean().default(commandDefaults.log),
  db: z.string().min(1),
  chat: z.string().min(1).optional(),
  chatLabel: z.string().trim().min(1).optional(),
  credentials: z.string().min(1).optional(),
  refreshMedia: z.boolean().default(commandDefaults.refreshMedia),
});
export type DatabaseMediaOptions = z.infer<typeof databaseMediaOptionsSchema>;
export function resolveDatabaseMediaOptions(
  input: unknown,
): DatabaseMediaOptions {
  const result = databaseMediaOptionsSchema.safeParse(input);
  if (!result.success)
    throw validationError("Database media options", result.error);
  if (result.data.chat !== undefined && result.data.chatLabel !== undefined)
    throw new AppError(
      "Choose at most one of --chat <id> or --chat-label <label>.",
    );
  return { ...result.data, db: resolve(result.data.db) };
}

function calendarDayStart(to: number, days: number): number {
  return dayjs(to)
    .subtract(days - 1, "day")
    .startOf("day")
    .valueOf();
}

function assertChatSelection(options: {
  chat?: string;
  chatLabel?: string;
}): void {
  if (
    Number(options.chat !== undefined) +
      Number(options.chatLabel !== undefined) !==
    1
  )
    throw new AppError(
      "Choose exactly one of --chat <id> or --chat-label <label>.",
    );
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
