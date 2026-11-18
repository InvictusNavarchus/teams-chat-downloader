import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { collectionLogSuffix } from "./config.ts";

// Explicitly select operational fields so new options cannot silently leak into logs.
const loggedOptions = [
  "db",
  "chat",
  "chatLabel",
  "allHistory",
  "allChats",
  "images",
  "last",
  "since",
  "from",
  "to",
  "pageDelayMin",
  "pageDelayMax",
  "backup",
  "backupDir",
  "log",
  "out",
  "markdown",
  "media",
  "refreshMedia",
] as const;

export function writeCommandContext(
  log: { write(message: string): void },
  command: string,
  input: Record<string, unknown>,
  resolved: Record<string, unknown>,
) {
  const select = (options: Record<string, unknown>) => {
    const selected: Record<string, string | number | boolean> = {};
    for (const key of loggedOptions) {
      const value = options[key];
      if (["string", "number", "boolean"].includes(typeof value))
        selected[key] = value as string | number | boolean;
    }
    if (options.credentials !== undefined) selected.credentials = "[REDACTED]";
    return selected;
  };
  const args = Object.entries(select(input)).map(([key, value]) => {
    const flag = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    return typeof value === "boolean"
      ? `--${value ? "" : "no-"}${flag}`
      : `--${flag} ${JSON.stringify(value)}`;
  });
  log.write(
    `[${command}] Input (normalized): teams ${command} ${args.join(" ")}`,
  );
  log.write(`[${command}] Working directory: ${JSON.stringify(process.cwd())}`);
  const settings: Record<string, unknown> = select(resolved);
  const window = resolved.window as { from: number; to: number } | undefined;
  if (window)
    settings.window = {
      from: new Date(window.from).toISOString(),
      toExclusive: new Date(window.to).toISOString(),
    };
  else if (typeof resolved.invocationTime === "number")
    settings.catchUpTo = new Date(resolved.invocationTime).toISOString();
  log.write(`[${command}] Resolved options: ${JSON.stringify(settings)}`);
}

// Synchronous, small event writes preserve ordering without a buffered shutdown queue.
// Logs are diagnostic evidence, not a durability or completion authority.
export function openCollectionLog(
  database: string,
  warn: (message: string) => void,
) {
  let fd: number | undefined;
  let failed = false;
  const failure = () => {
    if (!failed) {
      failed = true;
      warn(
        "[log] Could not write collection log; collection continues without file logging.",
      );
    }
  };
  const close = () => {
    const current = fd;
    fd = undefined;
    if (current !== undefined) {
      try {
        closeSync(current);
      } catch {
        failure();
      }
    }
  };
  try {
    const databasePath = resolve(database);
    // Match database access: parent directories may be aliases (e.g. macOS /var).
    // Canonicalize only the parent; the log destination itself must not be a link.
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    const directory = join(
      realpathSync(dirname(databasePath)),
      `${basename(databasePath)}${collectionLogSuffix}`,
    );
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe directory");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
      throw new Error("Unsafe log permissions");
    const path = join(
      directory,
      `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.log`,
    );
    fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    return {
      path,
      write(message: string) {
        if (fd === undefined) return;
        try {
          const data = Buffer.from(
            `${new Date().toISOString()} ${message.replace(/[\r\n]/g, " ")}\n`,
          );
          let offset = 0;
          while (offset < data.length) {
            const written = writeSync(fd, data, offset, data.length - offset);
            if (written === 0) throw new Error("Incomplete write");
            offset += written;
          }
        } catch {
          close();
          failure();
        }
      },
      close,
    };
  } catch {
    close();
    failure();
    return undefined;
  }
}
