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
import { AppError } from "./errors.ts";

const timestampSchema = z.iso
  .datetime({ offset: true })
  .refine(
    (value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value),
  );
// A calendar date means local midnight, like --last's local calendar days.
// It becomes an offset timestamp so later parsing and logs stay unambiguous.
const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => dayjs(value).format("YYYY-MM-DD") === value)
  .transform((value) => dayjs(value).format());
const dateOrTimestampSchema = z.union([timestampSchema, localDateSchema]);
const timestampHint = (flag: string) =>
  `${flag} expects a date such as 2026-11-01 (local midnight) or a timestamp with Z or a UTC offset, such as 2026-11-01T09:00:00+07:00.`;
const strictTimestampHint = (flag: string) =>
  `${flag} expects a timestamp with Z or a UTC offset, such as 2026-11-01T00:00:00+07:00.`;
const pageDelayHint = (flag: string) =>
  `${flag} expects seconds from ${pageDelayLimits.min} to ${pageDelayLimits.max}.`;
// Format hints for options whose shape is not obvious from the flag name.
const optionHints: Partial<Record<string, string>> = {
  last: "--last expects a number of days with a d suffix, such as 7d.",
  since: timestampHint("--since"),
  from: timestampHint("--from"),
  to: timestampHint("--to"),
  pageDelayMin: pageDelayHint("--page-delay-min"),
  pageDelayMax: pageDelayHint("--page-delay-max"),
  timeout: `--timeout expects whole seconds from ${loginTimeout.min} to ${loginTimeout.max}.`,
  format: `--format supports only ${defaultOutputFormat}.`,
};

function optionFlag(key: string): string {
  return `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/**
 * Explains invalid command options by the flag the user typed, never by schema
 * field name. Parsed values are not echoed because some options name credential files.
 */
function optionsError(
  input: unknown,
  error: z.ZodError,
  hints = optionHints,
): AppError {
  const values =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const messages = error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys")
      return issue.keys.map((key) => `Unknown option ${optionFlag(key)}.`);
    const key = issue.path[0];
    if (typeof key !== "string") return ["Invalid options."];
    const flag = optionFlag(key);
    const value = values[key];
    if (value === undefined) return [`${flag} is required.`];
    // CAC parses a value option given without a value as boolean true.
    if (value === true || (typeof value === "string" && value.trim() === ""))
      return [`${flag} needs a value.`];
    return [hints[key] ?? `${flag} has an invalid value.`];
  });
  return new AppError([...new Set(messages)].join(" "));
}

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
  from: dateOrTimestampSchema.optional(),
  to: dateOrTimestampSchema.optional(),
  since: dateOrTimestampSchema.optional(),
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
  // The live smoke window stays explicitly timezone-qualified.
  if (!result.success)
    throw optionsError(input, result.error, {
      ...optionHints,
      from: strictTimestampHint("--from"),
      to: strictTimestampHint("--to"),
    });
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
  if (!result.success) throw optionsError(input, result.error);
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
  if (!result.success) throw optionsError(input, result.error);
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
  if (!result.success) throw optionsError(input, result.error);
  return result.data;
}

export function resolveExportOptions(
  input: unknown,
  now = Date.now(),
): ExportOptions {
  const result = exportOptionsSchema.safeParse(input);
  if (!result.success) throw optionsError(input, result.error);
  const options = result.data;
  assertChatSelection(options);
  if (!options.media && options.refreshMedia)
    throw new AppError("--refresh-media cannot be combined with --no-media.");
  return { ...options, window: resolveHistoryWindow(options, now) };
}

function resolveHistoryWindow(
  options: Pick<
    z.infer<typeof exportOptionsSchema>,
    "from" | "to" | "since" | "last" | "pageDelayMin" | "pageDelayMax"
  >,
  now: number,
): Window {
  if (options.pageDelayMin > options.pageDelayMax)
    throw new AppError("--page-delay-min must not exceed --page-delay-max.");
  const modes =
    Number(options.last !== undefined) +
    Number(options.since !== undefined) +
    Number(options.from !== undefined);
  if (modes !== 1 || (options.to !== undefined && options.from === undefined)) {
    throw new AppError(
      "Choose exactly one of --last Nd, --since <date>, or --from <date> --to <date>.",
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
  return { from, to };
}

const collectOptionsSchema = exportOptionsSchema
  .omit({ out: true, markdown: true, media: true, refreshMedia: true })
  .extend({
    db: z.string().min(1),
    allHistory: z.boolean().default(false),
    allChats: z.boolean().default(false),
    images: z.boolean().default(commandDefaults.images),
    log: z.boolean().default(commandDefaults.log),
    backup: z.boolean().default(commandDefaults.backup),
    backupDir: z.string().min(1).optional(),
  });

export type CollectOptions = z.infer<typeof collectOptionsSchema> & {
  window?: Window;
  invocationTime: number;
};

export function resolveCollectOptions(
  input: unknown,
  now = Date.now(),
): CollectOptions {
  const result = collectOptionsSchema.safeParse(input);
  if (!result.success) throw optionsError(input, result.error);
  const {
    db,
    allHistory,
    allChats,
    backup,
    backupDir,
    log: _log,
    ...options
  } = result.data;
  if (allChats) {
    if (options.chat !== undefined || options.chatLabel !== undefined)
      throw new AppError(
        "--all-chats cannot be combined with --chat or --chat-label.",
      );
  } else assertChatSelection(options, "--all-chats");
  if (!backup && backupDir !== undefined)
    throw new AppError("--no-backup cannot be combined with --backup-dir.");
  if (
    allHistory &&
    [options.last, options.since, options.from, options.to].some(
      (v) => v !== undefined,
    )
  )
    throw new AppError("--all-history cannot be combined with date options.");
  if (options.pageDelayMin > options.pageDelayMax)
    throw new AppError("--page-delay-min must not exceed --page-delay-max.");
  const explicitDates = [
    options.last,
    options.since,
    options.from,
    options.to,
  ].some((value) => value !== undefined);
  const window =
    allHistory || explicitDates
      ? resolveHistoryWindow(
          allHistory
            ? { ...options, since: new Date(1).toISOString() }
            : options,
          now,
        )
      : undefined;
  if (window && window.to > now)
    throw new AppError("Collection end cannot be in the future.");
  return {
    ...result.data,
    window,
    invocationTime: now,
    db: resolve(db),
    backupDir: backup
      ? resolve(backupDir ?? `${db}${collectionBackupSuffix}`)
      : undefined,
  };
}

const downloadOptionsSchema = collectOptionsSchema
  .omit({ allChats: true, images: true })
  .extend({
    out: exportOptionsSchema.shape.out,
    media: exportOptionsSchema.shape.media,
    markdown: exportOptionsSchema.shape.markdown,
    refreshMedia: exportOptionsSchema.shape.refreshMedia,
  });
export type DownloadOptions = z.infer<typeof downloadOptionsSchema> & {
  window: Window;
  allChats: false;
  images: false;
  invocationTime: number;
};

export function resolveDownloadOptions(
  input: unknown,
  now = Date.now(),
): DownloadOptions {
  const result = downloadOptionsSchema.safeParse(input);
  if (!result.success) throw optionsError(input, result.error);
  const { out, media, markdown, refreshMedia, ...collection } = result.data;
  // Check here so download never suggests collect's --all-chats selector.
  assertChatSelection(collection);
  if (!media && refreshMedia)
    throw new AppError("--refresh-media cannot be combined with --no-media.");
  const resolved = resolveCollectOptions(collection, now);
  if (!resolved.window)
    throw new AppError(
      "Choose --all-history or a date range for download; use collect to catch up saved history.",
    );
  return {
    ...resolved,
    window: resolved.window,
    allChats: false,
    images: false,
    out,
    media,
    markdown,
    refreshMedia,
  };
}

const databaseExportOptionsSchema = z.strictObject({
  log: z.boolean().default(commandDefaults.log),
  db: z.string().min(1),
  chat: z.string().min(1).optional(),
  chatLabel: exportOptionsSchema.shape.chatLabel,
  allChats: z.boolean().default(false),
  out: z.string().min(1).optional(),
  last: exportOptionsSchema.shape.last,
  from: dateOrTimestampSchema.optional(),
  to: dateOrTimestampSchema.optional(),
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
  if (!result.success) throw optionsError(input, result.error);
  const options = result.data;
  if (options.allChats) {
    if (options.chat !== undefined || options.chatLabel !== undefined)
      throw new AppError(
        "--all-chats cannot be combined with --chat or --chat-label.",
      );
    if (options.last === undefined)
      throw new AppError(
        "Use --all-chats with --last Nd for daily exports; combined --out exports require one chat.",
      );
  } else assertChatSelection(options, "--all-chats with --last Nd");
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
  if (!result.success) throw optionsError(input, result.error);
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

function assertChatSelection(
  options: { chat?: string; chatLabel?: string },
  allChats?: string,
): void {
  if (
    Number(options.chat !== undefined) +
      Number(options.chatLabel !== undefined) !==
    1
  )
    throw new AppError(
      allChats === undefined
        ? "Choose exactly one of --chat <id> or --chat-label <label>."
        : `Choose exactly one of --chat <id>, --chat-label <label>, or ${allChats}.`,
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
  if (!result.success) throw optionsError(input, result.error);
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
  if (!result.success) throw optionsError(input, result.error);
  return result.data;
}
