import { join, resolve } from "node:path";

// Shared application defaults and command limits.
export const defaultPageDelay = { min: 1, max: 2.5 } as const;
export const pageDelayLimits = { min: 0, max: 3600 } as const;
export const loginTimeout = { default: 600, min: 1, max: 3600 } as const;
export const defaultOutputFormat = "markdown";
export const defaultLiveSmokeDays = 2;
export const collectionWindowMs = 7 * 24 * 60 * 60 * 1000;
export const collectionBackupIntervalMs = 60 * 60 * 1000;
export const collectionLogSuffix = ".logs";
export const collectionBackupSuffix = ".backups";
export const commandDefaults = {
  backup: true,
  log: true,
  markdown: true,
  media: true,
  images: false,
  refreshMedia: false,
  recursive: false,
  waitForMedia: false,
} as const;

export function configuredDataDirectory(): string | undefined {
  const directory = process.env.TEAMS_DATA_DIR;
  return directory ? resolve(directory) : undefined;
}

export function defaultExportRoot(): string {
  const directory = configuredDataDirectory();
  return directory === undefined ? "exports" : join(directory, "exports");
}
