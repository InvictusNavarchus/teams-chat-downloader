import { createHash } from "node:crypto";
import { readdir, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configuredDataDirectory } from "./config.ts";
import { defaultCredentialsPath } from "./credentials.ts";
import { AppError } from "./errors.ts";

export function defaultCollectionPath(accountId: string): string {
  return (
    configuredCollectionPath() ??
    join(
      collectionRoot(),
      `${createHash("sha256").update(accountId).digest("hex")}.sqlite`,
    )
  );
}

function configuredCollectionPath(): string | undefined {
  const directory = configuredDataDirectory();
  return directory === undefined
    ? undefined
    : join(directory, "history.sqlite");
}

function collectionRoot(): string {
  return join(dirname(defaultCredentialsPath()), "collections");
}

// Offline selection never reads credentials or guesses between accounts.
export async function findDefaultCollection(): Promise<string> {
  const configured = configuredCollectionPath();
  if (configured !== undefined) return configured;

  const root = collectionRoot();
  const candidates: string[] = [];
  try {
    for (const name of await readdir(root)) {
      if (!/^[a-f0-9]{64}\.sqlite$/.test(name)) continue;
      const path = join(root, name);
      if ((await lstat(path)).isFile()) candidates.push(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (candidates.length !== 1)
    throw new AppError(
      candidates.length === 0
        ? "No default collection found; run download or collect first, or specify --db."
        : "Multiple account collections found; specify --db to select one offline.",
    );
  return candidates[0]!;
}
