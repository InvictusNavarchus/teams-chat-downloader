import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { collectionBackupIntervalMs } from "./config.ts";
import { AppError } from "./errors.ts";
import {
  HistoryStore,
  collectionMediaDirectory,
  storedImageDescriptor,
} from "./history-store.ts";
import { readStoredImage } from "./media.ts";

async function privateDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) await privateDirectory(parent);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!(await lstat(path)).isDirectory())
    throw new AppError("Backup directories must not contain symbolic links.");
}

async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSynced(path: string, bytes: string | Uint8Array) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function checksum(path: string, signal?: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal }))
    hash.update(chunk);
  return hash.digest("hex");
}

function contains(directory: string, path: string) {
  const rel = relative(directory, path);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

// The caller must hold reserveCollection across this entire operation. Backups
// pause collection between commits, so the database and image files agree.
export async function backupLockedCollection(
  store: HistoryStore,
  database: string,
  backupDirectory: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const destination = resolve(backupDirectory);
  const source = await realpath(database);
  const mediaSource = collectionMediaDirectory(source);
  if (
    contains(destination, source) ||
    contains(destination, mediaSource) ||
    contains(mediaSource, destination)
  )
    throw new AppError(
      "Backup directory must be separate from the live database and media.",
    );
  await privateDirectory(destination);
  // Sibling staging keeps even an unfiltered rclone scan of destination safe.
  // Both directories must be on the same filesystem for atomic publication.
  const staging = await mkdtemp(
    join(dirname(destination), ".teams-backup-staging-"),
  );
  let published = false;
  try {
    const snapshot = join(staging, "history.sqlite");
    await writeSynced(snapshot, "");
    store.snapshotTo(snapshot);
    signal?.throwIfAborted();
    const check = new Database(snapshot, { readonly: true });
    try {
      const rows = check
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .all();
      if (rows.length !== 1 || rows[0]?.integrity_check !== "ok")
        throw new AppError("Backup database failed its integrity check.");
    } finally {
      check.close();
    }
    const saved = await HistoryStore.open(snapshot);
    let images;
    try {
      images = saved.images().filter((image) => image.status === "complete");
    } finally {
      saved.close();
    }
    const sums = [`${await checksum(snapshot, signal)}  history.sqlite`];
    const copied = new Set<string>();
    const mediaDestination = collectionMediaDirectory(snapshot);
    await mkdir(mediaDestination, { mode: 0o700 });
    for (const image of images) {
      signal?.throwIfAborted();
      const descriptor = storedImageDescriptor(image);
      // Validate every descriptor, even when two sources share one file.
      const bytes = await readStoredImage(mediaSource, descriptor);
      if (!bytes)
        throw new AppError(
          "A completed image is missing or corrupt; repair it with media-db before backing up.",
        );
      const name = basename(descriptor.path);
      if (copied.has(name)) continue;
      const target = join(mediaDestination, name);
      await writeSynced(target, bytes);
      const digest = await checksum(target, signal);
      if (digest !== descriptor.sha256)
        throw new AppError("Backup image checksum verification failed.");
      sums.push(`${digest}  history.sqlite.media/${name}`);
      copied.add(name);
    }
    await writeSynced(join(staging, "SHA256SUMS"), `${sums.join("\n")}\n`);
    await syncDirectory(mediaDestination);
    await syncDirectory(staging);
    signal?.throwIfAborted();
    const name = `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}`;
    const output = join(destination, name);
    await rename(staging, output);
    published = true;
    await syncDirectory(destination);
    await syncDirectory(dirname(destination));
    return output;
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

export type BackupEvent =
  | { type: "backup"; status: "saved"; path: string }
  | { type: "backup"; status: "failed"; reason: string };

export class CollectionBackups {
  private lastAttempt = Date.now();
  private dirty = true;
  readonly summary: { saved: number; failed: number; lastSnapshot?: string } = {
    saved: 0,
    failed: 0,
  };

  constructor(
    private database: string,
    private directory: string,
    private onProgress?: (event: BackupEvent) => void,
  ) {}

  async checkpoint(store: HistoryStore, signal?: AbortSignal) {
    this.dirty = true;
    await this.save(store, false, signal);
  }

  async finish(store: HistoryStore, signal?: AbortSignal) {
    await this.save(store, true, signal);
  }

  private async save(
    store: HistoryStore,
    force: boolean,
    signal?: AbortSignal,
  ) {
    if (
      !this.dirty ||
      (!force && Date.now() - this.lastAttempt < collectionBackupIntervalMs)
    )
      return;
    signal?.throwIfAborted();
    this.lastAttempt = Date.now();
    let path: string;
    try {
      path = await backupLockedCollection(
        store,
        this.database,
        this.directory,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      this.summary.failed++;
      this.onProgress?.({
        type: "backup",
        status: "failed",
        reason:
          error instanceof AppError
            ? error.message
            : "Check backup destination permissions, free space, and that its parent is on the same filesystem.",
      });
      return;
    }
    this.dirty = false;
    this.summary.saved++;
    this.summary.lastSnapshot = path;
    this.onProgress?.({ type: "backup", status: "saved", path });
  }
}
