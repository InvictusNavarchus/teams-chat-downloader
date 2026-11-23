import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
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
import { basename, join } from "node:path";
import { readArchive, type Message } from "../src/archive.ts";
import {
  resolveDatabaseExportOptions,
  resolveDatabaseMediaOptions,
} from "../src/command-validation.ts";
import { downloadDatabaseMedia } from "../src/database-media.ts";
import { exportDatabase } from "../src/database-export.ts";
import {
  HistoryStore,
  collectionMediaDirectory,
} from "../src/history-store.ts";
import { createHttp, requestStats } from "../src/http.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);
const origin = "https://us-api.asm.skype.com";
const imageUrl = (id = "first") => `${origin}/v1/objects/${id}/views/imgo`;
const from = Date.parse("2026-11-01T00:00:00Z"),
  to = from + 86400000;
const counts = { pages: 1, records: 1, duplicates: 0 };
function message(id = "1", content = `<img src="${imageUrl()}">`): Message {
  return {
    id,
    originalarrivaltime: new Date(from + 1).toISOString(),
    messagetype: "RichText/Html",
    content,
    unknown: { nested: [1, 2] },
  };
}
function response() {
  return new Response(png, {
    headers: { "content-type": "image/png", etag: '"fixture"' },
  });
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "teams-db-media-test-"));
  dirs.push(dir);
  const db = join(dir, "history.sqlite"),
    cacheRoot = join(dir, "cache");
  const credentials = {
    version: 1 as const,
    accountId: "account",
    historyAuthentication: "secret-history",
    directoryToken: "secret-directory",
    mediaCookies: { [origin]: "secret-cookie" },
  };
  const options = resolveDatabaseMediaOptions({ db });
  return { dir, db, cacheRoot, credentials, options };
}
async function seed(
  db: string,
  messages: Message[],
  chat = "group",
  label?: string,
) {
  const store = await HistoryStore.open(db, "account");
  store.commit(chat, label, { from, to }, messages, counts, requestStats());
  store.close();
}

test("saved labels scope image downloads and unsupported counts to one chat", async () => {
  const f = await fixture();
  await seed(f.db, [message()], "group", "Project Alpha");
  await seed(
    f.db,
    [
      message(
        "other",
        `<img src="${imageUrl("other")}"><img src="https://unsupported.invalid/x">`,
      ),
    ],
    "other",
    "Project Beta",
  );
  const stats = requestStats();
  const events: string[] = [];
  const result = await downloadDatabaseMedia(
    resolveDatabaseMediaOptions({ db: f.db, chatLabel: "  PROJECT alpha  " }),
    f.credentials,
    createHttp({
      stats,
      fetch: async (request) => {
        expect(request.url).toBe(imageUrl());
        return response();
      },
    }),
    undefined,
    (event) => {
      if (event.phase === "summary") events.push(event.message);
    },
    f.cacheRoot,
  );
  expect(result).toMatchObject({ saved: 1, images: 1, unsupported: 0 });
  expect(stats.total).toBe(1);
  expect(events).toContain('[images] Selected stored chat: "group".');
  const store = await HistoryStore.open(f.db);
  expect(store.images("group")[0]!.status).toBe("complete");
  expect(store.images("other")[0]!.status).toBe("pending");
  store.close();
});

test("invalid saved labels fail before HTTP and release the collection reservation", async () => {
  const f = await fixture();
  await seed(f.db, [message()], "group", "Project Alpha");
  await seed(f.db, [message()], "other", "project alpha");
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async () => {
      throw new Error("No HTTP expected");
    },
  });
  for (const [chatLabel, expected] of [
    ["Missing", "No saved chat matches"],
    ["Untitled chat", "Generic fallback labels"],
    ["Unresolved one-to-one chat", "Generic fallback labels"],
    ["Project Alpha", "Multiple chats match"],
  ]) {
    await expect(
      downloadDatabaseMedia(
        resolveDatabaseMediaOptions({ db: f.db, chatLabel }),
        f.credentials,
        http,
      ),
    ).rejects.toThrow(expected);
    expect((await readdir(f.dir)).some((name) => name.endsWith(".lock"))).toBe(
      false,
    );
  }
  expect(stats.total).toBe(0);
  expect(await readdir(f.dir)).not.toContain("history.sqlite.media");
});

test("references are committed with messages, deduplicated across chats, and rolled back on message conflicts", async () => {
  const f = await fixture();
  const original = message();
  await seed(f.db, [original, message("2")]);
  await seed(f.db, [original], "other-chat");
  const store = await HistoryStore.open(f.db, "account");
  expect(store.images()).toHaveLength(1);
  expect(store.images()[0]).toMatchObject({
    source_url: imageUrl(),
    status: "pending",
  });
  expect(() =>
    store.commit(
      "group",
      undefined,
      { from, to: to + 1 },
      [
        message("3", `<img src="${imageUrl("rollback")}">`),
        { ...original, content: "conflict" },
      ],
      counts,
      requestStats(),
    ),
  ).toThrow("conflicting record");
  expect(store.images()).toHaveLength(1);
  store.close();
  const sql = new Database(f.db, { readonly: true });
  expect(sql.query("SELECT COUNT(*) AS n FROM message_images").get()).toEqual({
    n: 3,
  });
  expect(
    sql.query("SELECT COUNT(*) AS n FROM completed_windows").get(),
  ).toEqual({ n: 2 });
  sql.close();
});

test("downloads directly from SQLite, survives cache deletion, and exports portable offline images and Markdown", async () => {
  const f = await fixture();
  await seed(f.db, [message(), message("2")]);
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async (request) => {
      expect(request.url).toBe(imageUrl());
      expect(request.headers.get("cookie")).toBe(
        "skypetoken_asm=secret-cookie",
      );
      for (const name of ["Authentication", "Authorization", "x-skypetoken"])
        expect(request.headers.has(name)).toBe(false);
      return response();
    },
  });
  const first = await downloadDatabaseMedia(
    f.options,
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(first).toMatchObject({
    images: 1,
    saved: 1,
    downloaded: 1,
    status: "complete",
  });
  expect(stats.total).toBe(1);
  let store = await HistoryStore.open(f.db);
  const image = store.images()[0]!;
  expect(image.status).toBe("complete");
  expect(
    await readFile(
      join(collectionMediaDirectory(f.db), basename(image.file_path!)),
    ),
  ).toEqual(png);
  store.close();
  await rm(f.cacheRoot, { recursive: true });
  const second = await downloadDatabaseMedia(
    f.options,
    { version: 1, accountId: "account" },
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(second).toMatchObject({ alreadyDownloaded: 1, saved: 0 });
  expect(stats.total).toBe(1);
  const out = join(f.dir, "export");
  const exported = await exportDatabase(
    resolveDatabaseExportOptions({ db: f.db, chat: "group", out }),
  );
  const archive = await readArchive(exported.output);
  expect(archive.media.status).toBe("complete");
  if (archive.media.status === "not-downloaded")
    throw new Error("missing manifest");
  expect(archive.media.images).toHaveLength(2);
  expect(archive.media.images[0]!.key).toBe(image.key);
  expect(await readFile(join(out, archive.media.images[0]!.path))).toEqual(png);
  expect(await readdir(join(out, "media"))).toHaveLength(1);
  expect(await readFile(exported.markdown!, "utf8")).toContain(
    archive.media.images[0]!.path,
  );
  expect(archive.messages).toEqual([message(), message("2")]);
  expect(
    (
      await stat(
        join(collectionMediaDirectory(f.db), basename(image.file_path!)),
      )
    ).mode & 0o777,
  ).toBe(0o600);
  const raw = await readFile(f.db);
  for (const secret of ["secret-cookie", "secret-history", "secret-directory"])
    expect(raw.includes(Buffer.from(secret))).toBe(false);
});

test("failed images leave retryable checkpoints while later images are saved", async () => {
  const f = await fixture();
  await seed(f.db, [
    message("a"),
    message("b", `<img src="${imageUrl("second")}">`),
    message("c", `<img src="${imageUrl("third")}">`),
  ]);
  const stats = requestStats();
  let calls = 0;
  const http = createHttp({
    stats,
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response("private", { status: 404 });
      if (calls === 2) return new Response("invalid image", { status: 200 });
      return response();
    },
  });
  const partialResult = await downloadDatabaseMedia(
    f.options,
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(partialResult).toMatchObject({
    status: "partial",
    saved: 1,
    failed: 2,
  });
  expect(partialResult.failureReason).toContain("HTTP 404");
  let store = await HistoryStore.open(f.db);
  expect(
    store
      .images()
      .map((i) => i.status)
      .sort(),
  ).toEqual(["complete", "failed", "failed"]);
  store.close();
  expect((await readdir(f.dir)).some((p) => p.endsWith(".lock"))).toBe(false);
  const partial = await exportDatabase(
    resolveDatabaseExportOptions({
      db: f.db,
      chat: "group",
      out: join(f.dir, "partial"),
    }),
  );
  expect((await readArchive(partial.output)).media.status).toBe("partial");
  const retry = await downloadDatabaseMedia(
    f.options,
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(retry).toMatchObject({ alreadyDownloaded: 1, saved: 2, failed: 0 });
  expect(stats.total).toBe(5);
  store = await HistoryStore.open(f.db);
  expect(store.images().every((i) => i.status === "complete")).toBe(true);
  store.close();
});

test("cancellation after one image keeps that checkpoint and leaves remaining work pending", async () => {
  const f = await fixture();
  await seed(f.db, [
    message("a"),
    message("b", `<img src="${imageUrl("second")}">`),
  ]);
  const stats = requestStats(),
    abort = new AbortController();
  const http = createHttp({
    stats,
    signal: abort.signal,
    fetch: async () => response(),
  });
  await expect(
    downloadDatabaseMedia(
      f.options,
      f.credentials,
      http,
      abort.signal,
      (e) => {
        if (e.phase === "progress") abort.abort();
      },
      f.cacheRoot,
    ),
  ).rejects.toThrow("cancelled");
  const store = await HistoryStore.open(f.db);
  expect(
    store
      .images()
      .map((i) => i.status)
      .sort(),
  ).toEqual(["complete", "pending"]);
  store.close();
  expect(stats.total).toBe(1);
});

test("missing or corrupt saved bytes are repaired from cache; export refuses falsely complete files and supports text-only override", async () => {
  const f = await fixture();
  await seed(f.db, [message()]);
  const stats = requestStats();
  const http = createHttp({ stats, fetch: async () => response() });
  await downloadDatabaseMedia(
    f.options,
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  const name = (await readdir(collectionMediaDirectory(f.db)))[0]!;
  await writeFile(join(collectionMediaDirectory(f.db), name), "corrupt");
  const options = resolveDatabaseExportOptions({
    db: f.db,
    chat: "group",
    out: join(f.dir, "bad-export"),
  });
  await expect(exportDatabase(options)).rejects.toThrow("missing or corrupt");
  expect(await readdir(f.dir)).not.toContain("bad-export");
  const text = await exportDatabase({
    ...options,
    out: join(f.dir, "text-only"),
    media: false,
  });
  expect((await readArchive(text.output)).media.status).toBe("not-downloaded");
  const repair = await downloadDatabaseMedia(
    f.options,
    { version: 1, accountId: "account" },
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(repair.cacheHits).toBe(1);
  expect(stats.total).toBe(1);
  expect(await readFile(join(collectionMediaDirectory(f.db), name))).toEqual(
    png,
  );
  await rm(join(collectionMediaDirectory(f.db), name));
  await downloadDatabaseMedia(
    f.options,
    { version: 1, accountId: "account" },
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(stats.total).toBe(1);
});

test("refresh honors validators, and a failed refresh keeps verified old bytes exportable", async () => {
  const f = await fixture();
  await seed(f.db, [message()]);
  const stats = requestStats();
  let mode = 200;
  const http = createHttp({
    stats,
    fetch: async (request) => {
      if (mode === 304) {
        expect(request.headers.get("if-none-match")).toBe('"fixture"');
        return new Response(null, { status: 304 });
      }
      return mode === 401 ? Response.json({}, { status: 401 }) : response();
    },
  });
  await downloadDatabaseMedia(
    f.options,
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  mode = 304;
  const refresh = await downloadDatabaseMedia(
    { ...f.options, refreshMedia: true },
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(refresh.cacheHits).toBe(1);
  mode = 401;
  const failed = await downloadDatabaseMedia(
    { ...f.options, refreshMedia: true },
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(failed).toMatchObject({ status: "partial", failed: 1, saved: 0 });
  expect(failed.failureReason).toContain("HTTP 401");
  const store = await HistoryStore.open(f.db);
  expect(store.images()[0]!.status).toBe("complete");
  store.close();
  const exported = await exportDatabase(
    resolveDatabaseExportOptions({
      db: f.db,
      chat: "group",
      out: join(f.dir, "after-refresh"),
    }),
  );
  expect((await readArchive(exported.output)).media.status).toBe("complete");
});

test("chat selection, account isolation, shared reservations, unsafe paths and unsupported references are enforced", async () => {
  const f = await fixture();
  await seed(f.db, [
    message(
      "a",
      `<img src="${imageUrl()}"><img src="https://unsupported.invalid/x">`,
    ),
  ]);
  await seed(f.db, [message("b", `<img src="${imageUrl("other")}">`)], "other");
  const beforeDownload = await HistoryStore.open(f.db);
  expect(beforeDownload.archive("group").media.status).toBe("partial");
  beforeDownload.close();
  const stats = requestStats();
  const http = createHttp({ stats, fetch: async () => response() });
  await expect(
    downloadDatabaseMedia(
      f.options,
      { ...f.credentials, accountId: "wrong" },
      http,
      undefined,
      undefined,
      f.cacheRoot,
    ),
  ).rejects.toThrow("different account");
  await expect(
    downloadDatabaseMedia(
      { ...f.options, chat: "missing" },
      f.credentials,
      http,
    ),
  ).rejects.toThrow("No collected chat");
  expect(stats.total).toBe(0);
  await mkdir(`${f.db}.collection.lock`);
  await expect(
    downloadDatabaseMedia(f.options, f.credentials, http),
  ).rejects.toThrow("already running");
  await rm(`${f.db}.collection.lock`, { recursive: true });
  const target = join(f.dir, "elsewhere");
  await mkdir(target);
  await symlink(target, collectionMediaDirectory(f.db));
  await expect(
    downloadDatabaseMedia(
      { ...f.options, chat: "group" },
      f.credentials,
      http,
      undefined,
      undefined,
      f.cacheRoot,
    ),
  ).rejects.toThrow("symbolic links");
  await rm(collectionMediaDirectory(f.db));
  expect(await readdir(target)).toEqual([]);
  const result = await downloadDatabaseMedia(
    { ...f.options, chat: "group" },
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  expect(result).toMatchObject({
    status: "partial",
    unsupported: 1,
    images: 1,
  });
  expect(stats.total).toBe(1);
  const store = await HistoryStore.open(f.db);
  expect(store.images("other")[0]!.status).toBe("pending");
  store.close();
});

test("regional sources retain their keys and only send the destination's media cookie", async () => {
  const f = await fixture();
  const regional =
    "https://id-prod.asyncgw.teams.microsoft.com/v1/objects/regional/views/imgo";
  await seed(f.db, [message("regional", `<img src="${regional}">`)]);
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async (request) => {
      expect(request.url).toBe(
        "https://experimental-api.asm.skype.com/v1/objects/regional/views/imgo",
      );
      expect(request.headers.get("cookie")).toBe(
        "skypetoken_asm=destination-cookie",
      );
      return response();
    },
  });
  await downloadDatabaseMedia(
    f.options,
    {
      ...f.credentials,
      mediaCookies: {
        "https://experimental-api.asm.skype.com": "destination-cookie",
      },
    },
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  const store = await HistoryStore.open(f.db);
  expect(store.images()[0]!.source_url).toBe(regional);
  expect(store.archive("group").messages[0]!.content).toContain(regional);
  store.close();
});

async function legacy(db: string, account = "account") {
  const sql = new Database(db);
  sql.run(`
    CREATE TABLE collection_meta(id INTEGER PRIMARY KEY,version INTEGER,account_id TEXT);
    CREATE TABLE chats(chat_id TEXT PRIMARY KEY,label TEXT);
    CREATE TABLE messages(chat_id TEXT,message_id TEXT,arrival_ms INTEGER,payload_json TEXT,PRIMARY KEY(chat_id,message_id));
    CREATE TABLE completed_windows(chat_id TEXT,from_ms INTEGER,to_ms INTEGER,completed_at TEXT,history_json TEXT,requests_json TEXT,PRIMARY KEY(chat_id,from_ms,to_ms));
  `);
  sql.query("INSERT INTO collection_meta VALUES(1,1,?)").run(account);
  sql.run("INSERT INTO chats VALUES('group','Group')");
  sql
    .query("INSERT INTO messages VALUES('group',?,?,?)")
    .run("1", from + 1, JSON.stringify(message()));
  sql
    .query("INSERT INTO completed_windows VALUES('group',?,?,?,?,?)")
    .run(
      from,
      to,
      new Date().toISOString(),
      JSON.stringify(counts),
      JSON.stringify(requestStats()),
    );
  sql.close();
  await chmod(db, 0o600);
}

test("version 1 remains readable offline; writable migration backfills image references without history requests or data loss", async () => {
  const f = await fixture();
  await legacy(f.db);
  let store = await HistoryStore.open(f.db);
  expect(store.version).toBe(1);
  expect(store.archive("group").messages).toEqual([message()]);
  store.close();
  await expect(HistoryStore.open(f.db, "wrong")).rejects.toThrow(
    "different account",
  );
  const before = new Database(f.db, { readonly: true });
  expect(before.query("SELECT version FROM collection_meta").get()).toEqual({
    version: 1,
  });
  before.close();
  const stats = requestStats();
  const http = createHttp({ stats, fetch: async () => response() });
  await downloadDatabaseMedia(
    f.options,
    f.credentials,
    http,
    undefined,
    undefined,
    f.cacheRoot,
  );
  store = await HistoryStore.open(f.db);
  expect(store.version).toBe(3);
  expect(store.archive("group").messages).toEqual([message()]);
  expect(store.missing("group", { from, to })).toEqual([]);
  expect(store.images()[0]!.status).toBe("complete");
  store.close();
  expect(stats).toMatchObject({ history: 0, directory: 0, media: 1 });
});

test("a failed version 1 backfill rolls back schema migration", async () => {
  const f = await fixture();
  await legacy(f.db);
  const sql = new Database(f.db);
  sql.run("UPDATE messages SET payload_json='{}'");
  sql.close();
  await expect(HistoryStore.open(f.db, "account")).rejects.toThrow(
    "Could not open",
  );
  const check = new Database(f.db, { readonly: true });
  expect(check.query("SELECT version FROM collection_meta").get()).toEqual({
    version: 1,
  });
  expect(
    check.query("SELECT name FROM sqlite_master WHERE name='images'").get(),
  ).toBeNull();
  check.close();
});

test("media-db CLI downloads without JSON and export-db links its saved images offline", async () => {
  const f = await fixture();
  await seed(f.db, [message()], "group", "Project Alpha");
  const credentialsPath = join(f.dir, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify(f.credentials), {
    mode: 0o600,
  });
  const preload = join(f.dir, "preload.ts");
  await writeFile(
    preload,
    `globalThis.fetch=async request=>{
    if(process.env.NO_MEDIA_HTTP)throw new Error("No network expected");
    if(request.url!==${JSON.stringify(imageUrl())})throw new Error("Unexpected destination");
    return new Response(Buffer.from(${JSON.stringify(png.toString("base64"))},"base64"),{headers:{"content-type":"image/png"}});
  };`,
  );
  async function cli(args: string[], offline = false) {
    const proc = Bun.spawn(
      [process.execPath, "--preload", preload, "src/cli.ts", ...args],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          XDG_CACHE_HOME: join(f.dir, "xdg-cache"),
          ...(offline ? { NO_MEDIA_HTTP: "1" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exit };
  }
  const args = [
    "media-db",
    "--db",
    f.db,
    "--chat-label",
    "  PROJECT alpha  ",
    "--credentials",
    credentialsPath,
  ];
  const conflicting = await cli([...args, "--chat", "group"], true);
  expect(conflicting.exit).toBe(1);
  expect(conflicting.stderr).toContain("Choose at most one");
  expect(await readdir(f.dir)).not.toContain("history.sqlite.logs");
  const first = await cli(args);
  expect(first.exit).toBe(0);
  expect(first.stdout).toContain("Images: 1 saved, 0 failed");
  expect(first.stdout).toContain('Selected stored chat: "group"');
  expect(
    (await readdir(f.dir)).some(
      (name) => name.endsWith(".json") && name !== "credentials.json",
    ),
  ).toBe(false);
  const second = await cli(args, true);
  expect(second.exit).toBe(0);
  expect(second.stdout).toContain("already downloaded: 1;");
  expect(second.stdout).not.toContain("HTTP attempts:");
  expect(second.stdout).toContain("No images need downloading");
  const mediaLogs = await readdir(`${f.db}.logs`);
  expect(mediaLogs).toHaveLength(2);
  for (const file of mediaLogs) {
    const log = await readFile(join(`${f.db}.logs`, file), "utf8");
    expect(log).toContain("[media-db] Completed successfully.");
    expect(log).toContain('Requested chat: "PROJECT alpha"');
    expect(log).toContain('Selected stored chat: "group"');
    expect(log).toContain("Images:");
    expect(log).not.toContain(imageUrl());
    expect(log).not.toContain(f.credentials.historyAuthentication);
  }
  const disabled = await cli([...args, "--no-log"], true);
  expect(disabled.exit).toBe(0);
  expect(await readdir(`${f.db}.logs`)).toHaveLength(2);

  const output = join(f.dir, "cli-export");
  const exported = await cli(
    ["export-db", "--db", f.db, "--chat", "group", "--out", output],
    true,
  );
  expect(exported.exit).toBe(0);
  const exportLogs = (await readdir(`${f.db}.logs`)).filter(
    (file) => !mediaLogs.includes(file),
  );
  expect(exportLogs).toHaveLength(1);
  const exportLog = await readFile(
    join(`${f.db}.logs`, exportLogs[0]!),
    "utf8",
  );
  expect(exportLog).toContain("[export-db] Completed successfully.");
  expect(exportLog).toContain("Saved JSON archive");
  expect(exportLog).toContain("Copied 1 image");
  const failed = await cli(
    ["export-db", "--db", f.db, "--chat", "group", "--out", output],
    true,
  );
  expect(failed.exit).toBe(1);
  const failedFile = (await readdir(`${f.db}.logs`)).find(
    (file) => ![...mediaLogs, ...exportLogs].includes(file),
  )!;
  expect(await readFile(join(`${f.db}.logs`, failedFile), "utf8")).toContain(
    "[export-db] Failed:",
  );

  expect((await readArchive(join(output, "chat.json"))).media.status).toBe(
    "complete",
  );
  expect(await readdir(join(output, "media"))).toHaveLength(1);
  const text = await cli(
    [
      "export-db",
      "--db",
      f.db,
      "--chat",
      "group",
      "--out",
      join(f.dir, "cli-text"),
      "--no-log",
      "--no-media",
    ],
    true,
  );
  expect(text.exit).toBe(0);
  expect(await readdir(`${f.db}.logs`)).toHaveLength(4);
  const mediaFailure = await cli([...args, "--refresh-media"], true);
  expect(mediaFailure.exit).toBe(1);
  const failureLogs = await Promise.all(
    (await readdir(`${f.db}.logs`)).map((file) =>
      readFile(join(`${f.db}.logs`, file), "utf8"),
    ),
  );
  const failureLog = failureLogs.find((log) =>
    log.includes("[media-db] Failed:"),
  )!;
  expect(failureLog).toContain("Images:");
  expect(failureLog).toContain(
    "Completed image files and database records remain saved",
  );
  expect(failureLog).not.toContain("Completed successfully");
  expect(failureLog).not.toContain(imageUrl());

  expect(
    (await readArchive(join(f.dir, "cli-text", "chat.json"))).media.status,
  ).toBe("not-downloaded");
});

test("version 2 migration repairs emoji counts and preserves attachments and payloads", async () => {
  const f = await fixture();
  const messages = [
    message("emoji", '<img itemtype="http://schema.skype.com/Emoji" alt="🎉">'),
    message("unsupported", '<img src="https://example.test/file">'),
    message("photo"),
  ];
  await seed(f.db, messages);
  const sql = new Database(f.db);
  sql.run("UPDATE collection_meta SET version=2");
  sql.run("UPDATE messages SET unsupported_images=1 WHERE message_id='emoji'");
  sql.close();
  await expect(HistoryStore.open(f.db, "wrong")).rejects.toThrow(
    "different account",
  );
  let store = await HistoryStore.open(f.db);
  expect(store.version).toBe(2);
  expect(store.unsupportedImages()).toBe(2);
  store.close();
  store = await HistoryStore.open(f.db, "account");
  expect(store.version).toBe(3);
  expect(store.unsupportedImages()).toBe(1);
  expect(store.images()).toHaveLength(1);
  expect(store.archive("group").messages).toEqual(
    [...messages].sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect(store.missing("group", { from, to })).toEqual([]);
  store.close();
  store = await HistoryStore.open(f.db, "account");
  expect(store.unsupportedImages()).toBe(1);
  store.close();
});

test("failed version 2 count repair rolls back counts and version", async () => {
  const f = await fixture();
  await seed(f.db, [message()]);
  const sql = new Database(f.db);
  sql.run("UPDATE collection_meta SET version=2");
  sql.run("UPDATE messages SET payload_json='{}', unsupported_images=17");
  sql.close();
  await expect(HistoryStore.open(f.db, "account")).rejects.toThrow(
    "Could not open",
  );
  const check = new Database(f.db, { readonly: true });
  expect(check.query("SELECT version FROM collection_meta").get()).toEqual({
    version: 2,
  });
  expect(check.query("SELECT unsupported_images FROM messages").get()).toEqual({
    unsupported_images: 17,
  });
  check.close();
});
