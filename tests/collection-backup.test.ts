import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupLockedCollection,
  CollectionBackups,
  type BackupEvent,
} from "../src/collection-backup.ts";
import { collectHistory } from "../src/collect.ts";
import {
  resolveCollectOptions,
  resolveDatabaseExportOptions,
} from "../src/command-validation.ts";
import {
  collectionBackupIntervalMs,
  collectionWindowMs,
} from "../src/config.ts";
import { exportDatabase } from "../src/database-export.ts";
import {
  HistoryStore,
  collectionMediaDirectory,
  reserveCollection,
} from "../src/history-store.ts";
import { createHttp, requestStats } from "../src/http.ts";
import { historyProgress } from "../src/teams.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const from = Date.parse("2026-09-01T00:00:00Z");
const to = from + collectionWindowMs;
const message = {
  id: "1",
  originalarrivaltime: new Date(from).toISOString(),
  messagetype: "RichText/Html",
  content:
    '<img src="https://us-api.asm.skype.com/v1/objects/first/views/imgo">',
  unknown: { nested: [1, 2] },
};
const credentials = {
  version: 1 as const,
  accountId: "account",
  historyAuthentication: "secret",
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "teams-backup-test-"));
  directories.push(dir);
  const db = join(dir, "source.sqlite");
  const destination = join(dir, "backups");
  const store = await HistoryStore.open(db, credentials.accountId);
  store.commit(
    "chat",
    "Example",
    { from, to },
    [message],
    historyProgress(),
    requestStats(),
  );
  return { dir, db, destination, store };
}

async function addImage(f: Awaited<ReturnType<typeof fixture>>) {
  const media = collectionMediaDirectory(f.db);
  await mkdir(media, { mode: 0o700 });
  const name = `${hash(png)}.png`;
  await writeFile(join(media, name), png, { mode: 0o600 });
  f.store.saveImage({
    messageId: message.id,
    key: f.store.images()[0]!.key,
    path: `media/${name}`,
    bytes: png.length,
    sha256: hash(png),
    mediaType: "image/png",
  });
  return { media, name };
}

async function verifyManifest(snapshot: string) {
  const manifest = await readFile(join(snapshot, "SHA256SUMS"), "utf8");
  for (const line of manifest.trim().split("\n")) {
    const [digest, name] = line.split("  ");
    expect(hash(await readFile(join(snapshot, name!)))).toBe(digest!);
  }
  return manifest;
}

test("snapshot restores all chats, coverage, payloads and images without the live database or cache", async () => {
  const f = await fixture();
  const release = await reserveCollection(f.db);
  try {
    f.store.commit(
      "other",
      undefined,
      { from, to },
      [message],
      historyProgress(),
      requestStats(),
    );
    const { media, name } = await addImage(f);
    await writeFile(join(media, "unreferenced.bin"), "not part of a backup");
    const snapshot = await backupLockedCollection(f.store, f.db, f.destination);
    const manifest = await verifyManifest(snapshot);
    expect(manifest.trim().split("\n")).toHaveLength(2);
    expect((await stat(snapshot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(snapshot, "history.sqlite"))).mode & 0o777).toBe(
      0o600,
    );
    expect(
      await readdir(collectionMediaDirectory(join(snapshot, "history.sqlite"))),
    ).toEqual([name]);
    expect(
      (await readdir(f.dir)).some((name) =>
        name.startsWith(".teams-backup-staging-"),
      ),
    ).toBe(false);
    // Restore a copy: published snapshots must remain immutable for rclone.
    const restored = join(f.dir, "restored");
    await cp(snapshot, restored, { recursive: true });
    await rm(media, { recursive: true });
    const db = join(restored, "history.sqlite");
    const store = await HistoryStore.open(db);
    try {
      expect(store.archive("chat").messages).toEqual([message]);
      expect(store.archive("other").messages).toEqual([message]);
      expect(store.missing("chat", { from, to })).toEqual([]);
    } finally {
      store.close();
    }
    const result = await exportDatabase(
      resolveDatabaseExportOptions({
        db,
        chat: "chat",
        out: join(f.dir, "export"),
      }),
    );
    expect(result.messages).toBe(1);
    expect(await readFile(join(f.dir, "export", "media", name))).toEqual(png);
    expect(await readFile(join(snapshot, "SHA256SUMS"), "utf8")).toBe(manifest);
  } finally {
    f.store.close();
    await release();
  }
});

test("snapshot includes committed WAL data and contains no live journal sidecars", async () => {
  const f = await fixture();
  const connection = new Database(f.db);
  try {
    connection.run("PRAGMA journal_mode=WAL");
    connection.run("PRAGMA wal_autocheckpoint=0");
    connection
      .query("UPDATE chats SET label=? WHERE chat_id=?")
      .run("WAL-only update", "chat");
    expect((await stat(`${f.db}-wal`)).size).toBeGreaterThan(0);
    const snapshot = await backupLockedCollection(f.store, f.db, f.destination);
    const saved = await HistoryStore.open(join(snapshot, "history.sqlite"));
    try {
      expect(saved.archive("chat").chatLabel).toBe("WAL-only update");
    } finally {
      saved.close();
    }
    expect((await readdir(snapshot)).sort()).toEqual([
      "SHA256SUMS",
      "history.sqlite",
      "history.sqlite.media",
    ]);
    await verifyManifest(snapshot);
  } finally {
    connection.close();
    f.store.close();
  }
});

test("failed or cancelled snapshots never publish partial folders or replace earlier backups", async () => {
  const f = await fixture();
  try {
    const good = await backupLockedCollection(f.store, f.db, f.destination);
    const manifest = await verifyManifest(good);
    const { media, name } = await addImage(f);
    await writeFile(join(media, name), "corrupt");
    await expect(
      backupLockedCollection(f.store, f.db, f.destination),
    ).rejects.toThrow("missing or corrupt");
    expect(await readdir(f.destination)).toHaveLength(1);
    await writeFile(join(media, name), png);
    const controller = new AbortController();
    const original = f.store.snapshotTo.bind(f.store);
    const spy = spyOn(f.store, "snapshotTo").mockImplementation((path) => {
      original(path);
      controller.abort();
    });
    try {
      await expect(
        backupLockedCollection(f.store, f.db, f.destination, controller.signal),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(await readdir(f.destination)).toHaveLength(1);
    expect(
      (await readdir(f.dir)).some((name) =>
        name.startsWith(".teams-backup-staging-"),
      ),
    ).toBe(false);
    expect(await verifyManifest(good)).toBe(manifest);
  } finally {
    f.store.close();
  }
});

test("snapshot destination rejects source overlap and symlink components", async () => {
  const f = await fixture();
  try {
    for (const destination of [
      f.dir,
      f.db,
      collectionMediaDirectory(f.db),
      join(collectionMediaDirectory(f.db), "backups"),
    ]) {
      await expect(
        backupLockedCollection(f.store, f.db, destination),
      ).rejects.toThrow("separate");
    }
    await mkdir(f.destination);
    await symlink(f.destination, join(f.dir, "alias"));
    await expect(
      backupLockedCollection(f.store, f.db, join(f.dir, "alias", "child")),
    ).rejects.toThrow("symbolic links");
    expect(await readdir(f.destination)).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("rclone source sees only finished snapshots, and failed later history retains the hourly backup", async () => {
  const f = await fixture();
  await mkdir(f.destination);
  const original = f.store.snapshotTo.bind(f.store);
  let duringSnapshot: string[] = [];
  const spy = spyOn(f.store, "snapshotTo").mockImplementation((path) => {
    // The staging directory is a sibling, never inside the upload root.
    expect(path.startsWith(`${f.destination}/`)).toBe(false);
    original(path);
  });
  try {
    const creating = backupLockedCollection(f.store, f.db, f.destination);
    duringSnapshot = await readdir(f.destination);
    await creating;
    expect(duringSnapshot).toEqual([]);
  } finally {
    spy.mockRestore();
    f.store.close();
  }
  const options = resolveCollectOptions({
    db: f.db,
    backupDir: f.destination,
    chat: "new-chat",
    from: new Date(from).toISOString(),
    to: new Date(to + collectionWindowMs).toISOString(),
    pageDelayMin: 0,
    pageDelayMax: 0,
  });
  const stats = requestStats();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const events: BackupEvent[] = [];
  let requests = 0;
  const http = createHttp({
    stats,
    fetch: async (request) => {
      if (++requests === 2) return Response.json({}, { status: 401 });
      now += collectionBackupIntervalMs;
      const start = Number(new URL(request.url).searchParams.get("startTime"));
      return Response.json({
        messages: [
          { ...message, originalarrivaltime: new Date(start).toISOString() },
        ],
        _metadata: {},
      });
    },
  });
  try {
    await expect(
      collectHistory(
        options,
        credentials,
        http,
        stats,
        historyProgress(),
        undefined,
        (event) => {
          if (event.type === "backup") events.push(event);
        },
      ),
    ).rejects.toThrow("HTTP 401");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.status).toBe("saved");
    if (event.status !== "saved") throw new Error("Expected a saved backup");
    const saved = await HistoryStore.open(join(event.path, "history.sqlite"));
    try {
      expect(saved.missing("new-chat", options.window)).toEqual([{ from, to }]);
      expect(saved.archive("new-chat").messages).toHaveLength(1);
    } finally {
      saved.close();
    }
    expect(await readdir(f.destination)).toHaveLength(2);
  } finally {
    clock.mockRestore();
  }
});

test("hourly scheduling skips unchanged completion, retains snapshots, and retries failures without throwing", async () => {
  const f = await fixture();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const events: BackupEvent[] = [];
  const backups = new CollectionBackups(f.db, f.destination, (event) =>
    events.push(event),
  );
  try {
    await backups.checkpoint(f.store);
    expect(backups.summary.saved).toBe(0);
    now += collectionBackupIntervalMs;
    await backups.checkpoint(f.store);
    await backups.finish(f.store);
    expect(backups.summary.saved).toBe(1);
    await backups.checkpoint(f.store);
    await backups.finish(f.store);
    expect(backups.summary.saved).toBe(2);
    now += collectionBackupIntervalMs;
    const spy = spyOn(f.store, "snapshotTo").mockImplementation(() => {
      throw new Error("private details");
    });
    try {
      await backups.checkpoint(f.store);
    } finally {
      spy.mockRestore();
    }
    expect(backups.summary.failed).toBe(1);
    expect(JSON.stringify(events)).not.toContain("private details");
    await backups.finish(f.store);
    expect(backups.summary.saved).toBe(3);
    expect(await readdir(f.destination)).toHaveLength(3);
  } finally {
    clock.mockRestore();
    f.store.close();
  }
});

test("collect publishes on clean completion including no-op runs; backup failure preserves successful collection", async () => {
  const f = await fixture();
  f.store.close();
  const options = resolveCollectOptions({
    db: f.db,
    backupDir: f.destination,
    chat: "chat",
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    pageDelayMin: 0,
    pageDelayMax: 0,
  });
  expect(options.backupDir).toBe(f.destination);
  expect(() => resolveCollectOptions({ ...options, backupDir: "" })).toThrow();
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async () => {
      throw new Error("No HTTP expected");
    },
  });
  const result = await collectHistory(
    options,
    credentials,
    http,
    stats,
    historyProgress(),
  );
  expect(result.backups).toMatchObject({ saved: 1, failed: 0 });
  expect(result.completedWindows).toBe(0);
  expect(stats.total).toBe(0);
  const failed = await collectHistory(
    { ...options, backupDir: f.db },
    credentials,
    http,
    stats,
    historyProgress(),
  );
  expect(failed.status).toBe("complete");
  expect(failed.backups).toMatchObject({ saved: 0, failed: 1 });
  expect(await readdir(f.destination)).toHaveLength(1);
});
