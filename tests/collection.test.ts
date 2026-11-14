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
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchive } from "../src/archive.ts";
import { collectHistory } from "../src/collect.ts";
import {
  resolveCollectOptions,
  resolveDatabaseExportOptions,
} from "../src/command-validation.ts";
import { collectionWindowMs } from "../src/config.ts";
import { exportDatabase } from "../src/database-export.ts";
import { HistoryStore, uncovered } from "../src/history-store.ts";
import { createHttp, requestStats } from "../src/http.ts";
import { historyProgress } from "../src/teams.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "teams-collection-test-"));
  dirs.push(dir);
  const db = join(dir, "history.sqlite");
  const credentials = {
    version: 1 as const,
    accountId: "account",
    historyAuthentication: "secret-history",
  };
  const from = Date.parse("2026-09-01T00:00:00Z");
  const to = from + 2 * collectionWindowMs;
  const options = resolveCollectOptions({
    db,
    chat: "group",
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    pageDelayMin: 0,
    pageDelayMax: 0,
  });
  return { dir, db, credentials, from, to, options };
}
const message = (id: string, time: number) => ({
  id,
  originalarrivaltime: new Date(time).toISOString(),
  content: "<p>preserved</p>",
  properties: { unknown: [1, { nested: true }] },
});
const counters = { pages: 1, records: 1, duplicates: 0 };

test("coverage subtraction merges overlap, preserves holes, and clips to requested bounds", () => {
  expect(
    uncovered({ from: 10, to: 100 }, [
      { from: 0, to: 20 },
      { from: 18, to: 40 },
      { from: 60, to: 80 },
      { from: 100, to: 120 },
    ]),
  ).toEqual([
    { from: 40, to: 60 },
    { from: 80, to: 100 },
  ]);
  expect(uncovered({ from: 10, to: 100 }, [{ from: 0, to: 200 }])).toEqual([]);
  expect(uncovered({ from: 10, to: 100 }, [])).toEqual([{ from: 10, to: 100 }]);
});

test("a failed older window leaves the completed newer checkpoint; restart fetches only the hole", async () => {
  const f = await fixture();
  const stats = requestStats();
  const windows: number[] = [];
  const http = createHttp({
    stats,
    fetch: async (request) => {
      const start = Number(new URL(request.url).searchParams.get("startTime"));
      windows.push(start);
      if (start === f.from) return Response.json({}, { status: 401 });
      return Response.json({
        messages: [message("new", start)],
        _metadata: {},
      });
    },
  });
  await expect(
    collectHistory(f.options, f.credentials, http, stats, historyProgress()),
  ).rejects.toThrow("HTTP 401");
  let store = await HistoryStore.open(f.db);
  expect(store.missing("group", f.options.window)).toEqual([
    { from: f.from, to: f.from + collectionWindowMs },
  ]);
  expect(() => store.archive("group", f.options.window)).toThrow(
    "uncollected gaps",
  );
  store.close();
  expect(await readdir(f.dir)).toEqual(["history.sqlite"]);
  const resumedStats = requestStats();
  const resumedHttp = createHttp({
    stats: resumedStats,
    fetch: async (request) => {
      const start = Number(new URL(request.url).searchParams.get("startTime"));
      windows.push(start);
      return Response.json({
        messages: [message("old", start)],
        _metadata: {},
      });
    },
  });
  const result = await collectHistory(
    f.options,
    f.credentials,
    resumedHttp,
    resumedStats,
    historyProgress(),
  );
  expect(result.completedWindows).toBe(1);
  expect(resumedStats.history).toBe(1);
  expect(windows).toEqual([f.from + collectionWindowMs, f.from, f.from]);
  store = await HistoryStore.open(f.db);
  expect(store.archive("group").messages.map((m) => m.id)).toEqual([
    "old",
    "new",
  ]);
  store.close();
  const skipped = await collectHistory(
    f.options,
    f.credentials,
    resumedHttp,
    resumedStats,
    historyProgress(),
  );
  expect(skipped.completedWindows).toBe(0);
  expect(resumedStats.history).toBe(1);
});

test("continuation failure commits neither partial messages nor coverage, then retries from a fresh cursor", async () => {
  const f = await fixture();
  const requests: boolean[] = [];
  let fail = true;
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async (request) => {
      const url = new URL(request.url);
      const next = url.searchParams.has("testCursor");
      requests.push(next);
      const start = Number(url.searchParams.get("startTime"));
      if (next && fail) return Response.json({}, { status: 401 });
      if (next)
        return Response.json({
          messages: [message("b", start + 1)],
          _metadata: {},
        });
      url.searchParams.set("testCursor", "private-cursor");
      return Response.json({
        messages: [message("a", start)],
        _metadata: { backwardLink: url.href },
      });
    },
  });
  const options = {
    ...f.options,
    window: { from: f.from, to: f.from + collectionWindowMs },
  };
  await expect(
    collectHistory(options, f.credentials, http, stats, historyProgress()),
  ).rejects.toThrow("HTTP 401");
  let store = await HistoryStore.open(f.db);
  expect(store.missing("group", options.window)).toEqual([options.window]);
  expect(() => store.archive("group")).toThrow("No completed");
  store.close();
  const sql = new Database(f.db, { readonly: true });
  expect(sql.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({
    n: 0,
  });
  sql.close();
  fail = false;
  await collectHistory(options, f.credentials, http, stats, historyProgress());
  expect(requests).toEqual([false, true, false, true]);
  store = await HistoryStore.open(f.db);
  expect(store.archive("group").messages).toHaveLength(2);
  store.close();
  const file = await readFile(f.db);
  expect(file.includes(Buffer.from("secret-history"))).toBe(false);
  expect(file.includes(Buffer.from("private-cursor"))).toBe(false);
});

test("transaction rolls back new messages and coverage on conflicting IDs; unknown JSON and identical duplicates survive", async () => {
  const f = await fixture();
  const store = await HistoryStore.open(f.db, f.credentials.accountId);
  const original = message("a", f.from + 1);
  store.commit(
    "group",
    "Group",
    { from: f.from, to: f.from + 10 },
    [original],
    counters,
    requestStats(),
  );
  expect(
    store.commit(
      "group",
      undefined,
      { from: f.from, to: f.from + 11 },
      [original],
      counters,
      requestStats(),
    ),
  ).toBe(0);
  expect(() =>
    store.commit(
      "group",
      undefined,
      { from: f.from, to: f.to },
      [message("new", f.from + 2), { ...original, content: "changed" }],
      counters,
      requestStats(),
    ),
  ).toThrow("conflicting record");
  expect(store.missing("group", f.options.window)).toEqual([
    { from: f.from + 11, to: f.to },
  ]);
  expect(store.archive("group").messages).toEqual([original]);
  store.commit(
    "other-chat",
    undefined,
    { from: f.from, to: f.from + 10 },
    [{ ...original, content: "other chat" }],
    counters,
    requestStats(),
  );
  expect(store.archive("group").messages).toEqual([original]);
  store.close();
});

test("empty all-history intervals expand to epoch without assuming that the first empty week means no earlier history", async () => {
  const f = await fixture();
  const now = 8 * collectionWindowMs + 1;
  const options = resolveCollectOptions(
    { db: f.db, chat: "group", all: true, pageDelayMin: 0, pageDelayMax: 0 },
    now,
  );
  const windows: { from: number; to: number }[] = [];
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async (request) => {
      const url = new URL(request.url);
      const from = Number(url.searchParams.get("startTime")),
        to = Number(url.searchParams.get("endTime")) + 1;
      windows.push({ from, to });
      const data =
        windows.length === 2 ? [message("older-than-empty-week", from)] : [];
      return Response.json({ messages: data, _metadata: {} });
    },
  });
  await collectHistory(options, f.credentials, http, stats, historyProgress());
  expect(windows[0]).toEqual({ from: now - collectionWindowMs, to: now });
  expect(windows[1]!.to - windows[1]!.from).toBe(2 * collectionWindowMs);
  expect(windows[2]!.to - windows[2]!.from).toBe(collectionWindowMs);
  expect(windows.at(-1)!.from).toBe(1);
  const store = await HistoryStore.open(f.db);
  expect(store.missing("group", options.window)).toEqual([]);
  expect(store.archive("group").messages).toHaveLength(1);
  store.close();
});

test("cancellation preserves completed coverage and releases the collector reservation", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const stats = requestStats();
  const http = createHttp({
    stats,
    signal: abort.signal,
    fetch: async (request) =>
      Response.json({
        messages: [
          message(
            "a",
            Number(new URL(request.url).searchParams.get("startTime")),
          ),
        ],
        _metadata: {},
      }),
  });
  await expect(
    collectHistory(
      f.options,
      f.credentials,
      http,
      stats,
      historyProgress(),
      abort.signal,
      (e) => {
        if (e.type === "checkpoint") abort.abort();
      },
    ),
  ).rejects.toThrow("checkpoints remain saved");
  const store = await HistoryStore.open(f.db);
  expect(store.missing("group", f.options.window)).toEqual([
    { from: f.from, to: f.from + collectionWindowMs },
  ]);
  store.close();
  expect(await readdir(f.dir)).toEqual(["history.sqlite"]);
});

test("account mismatch, unsafe files, symlinks, unrelated databases, and concurrent collectors fail before HTTP", async () => {
  const f = await fixture();
  (await HistoryStore.open(f.db, "other-account")).close();
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  await expect(
    collectHistory(f.options, f.credentials, http, stats, historyProgress()),
  ).rejects.toThrow("different account");
  expect(stats.total).toBe(0);
  expect((await stat(f.db)).mode & 0o777).toBe(0o600);
  await chmod(f.db, 0o644);
  await expect(HistoryStore.open(f.db)).rejects.toThrow("private regular file");
  await chmod(f.db, 0o600);
  const link = join(f.dir, "linked.sqlite");
  await symlink(f.db, link);
  await expect(HistoryStore.open(link, "other-account")).rejects.toThrow(
    "without symlinks",
  );
  const unrelated = join(f.dir, "unrelated.sqlite");
  const sql = new Database(unrelated);
  sql.run("CREATE TABLE unrelated (id INTEGER)");
  sql.close();
  await chmod(unrelated, 0o600);
  await expect(HistoryStore.open(unrelated, "account")).rejects.toThrow(
    "supported SQLite",
  );
  await mkdir(`${f.db}.collection.lock`);
  await expect(
    collectHistory(f.options, f.credentials, http, stats, historyProgress()),
  ).rejects.toThrow("already running");
  expect(stats.total).toBe(0);
});

test("offline exports require complete coverage, preserve payloads, sort ties, and integrate with JSON/Markdown readers", async () => {
  const f = await fixture();
  const store = await HistoryStore.open(f.db, "account");
  const msgs = [message("b", f.from + 1), message("a", f.from + 1)];
  store.commit(
    "group",
    "Group",
    f.options.window,
    msgs,
    counters,
    requestStats(),
  );
  store.close();
  const options = resolveDatabaseExportOptions({
    db: f.db,
    chat: "group",
    out: join(f.dir, "export"),
  });
  const result = await exportDatabase(options);
  const archive = await readArchive(result.output);
  expect(archive.messages).toEqual([msgs[1]!, msgs[0]!]);
  expect(archive.accountId).toBe("account");
  // No image references means media coverage is already complete.
  expect(archive.media.status).toBe("complete");
  expect(await readFile(result.markdown!, "utf8")).toContain("preserved");
  await expect(exportDatabase(options)).rejects.toThrow("already exists");
  await expect(
    exportDatabase({
      ...options,
      out: join(f.dir, "gap"),
      window: { from: f.from - 1, to: f.to },
    }),
  ).rejects.toThrow("uncollected gaps");
  const narrow = await exportDatabase({
    ...options,
    out: join(f.dir, "narrow"),
    markdown: false,
    window: { from: f.from + 2, to: f.to },
  });
  expect((await readArchive(narrow.output)).messages).toEqual([]);
  expect(await readdir(join(f.dir, "narrow"))).toEqual(["chat.json"]);
});

test("collection validation enforces selectors, date modes, nonfuture windows and pacing; database exports require paired bounds", () => {
  const now = Date.parse("2026-11-11T00:00:00Z");
  expect(
    resolveCollectOptions(
      { db: "history.sqlite", chat: "group", all: true },
      now,
    ).window,
  ).toEqual({ from: 1, to: now });
  for (const input of [
    { db: "history.sqlite", all: true },
    { db: "history.sqlite", chat: "a", chatLabel: "b", all: true },
    { db: "history.sqlite", chat: "a", all: true, last: "7d" },
    { db: "history.sqlite", chat: "a" },
    {
      db: "history.sqlite",
      chat: "a",
      from: "2026-11-01T00:00:00Z",
      to: "2027-01-01T00:00:00Z",
    },
    {
      db: "history.sqlite",
      chat: "a",
      last: "7d",
      pageDelayMin: 2,
      pageDelayMax: 1,
    },
  ])
    expect(() => resolveCollectOptions(input, now)).toThrow();
  expect(() =>
    resolveDatabaseExportOptions({
      db: "h",
      chat: "a",
      out: "o",
      from: "2026-11-01T00:00:00Z",
    }),
  ).toThrow("both");
});

test("label collection uses shared exact selection and stores raw identity; duplicate labels fail before history", async () => {
  const f = await fixture();
  const stats = requestStats();
  let duplicate = false;
  const credentials = { ...f.credentials, directoryToken: "secret-directory" };
  const http = createHttp({
    stats,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/users/me"))
        return Response.json({
          chats: [
            { id: "raw-group", title: "Project Alpha" },
            ...(duplicate ? [{ id: "duplicate", title: "Project Alpha" }] : []),
          ],
          metadata: { hasMoreChats: false, isPartialData: false },
        });
      expect(decodeURIComponent(url.pathname.split("/").at(-2)!)).toBe(
        "raw-group",
      );
      return Response.json({ messages: [], _metadata: {} });
    },
  });
  const options = resolveCollectOptions({
    db: f.db,
    chatLabel: "  project alpha ",
    from: new Date(f.from).toISOString(),
    to: new Date(f.to).toISOString(),
    pageDelayMin: 0,
    pageDelayMax: 0,
  });
  const result = await collectHistory(
    options,
    credentials,
    http,
    stats,
    historyProgress(),
  );
  expect(result.chatId).toBe("raw-group");
  const store = await HistoryStore.open(f.db);
  expect(store.archive("raw-group").chatLabel).toBe("Project Alpha");
  store.close();
  const historyRequests = stats.history;
  duplicate = true;
  await expect(
    collectHistory(options, credentials, http, stats, historyProgress()),
  ).rejects.toThrow("duplicate");
  expect(stats.history).toBe(historyRequests);
});

test("CLI collection resumes without HTTP and exports offline without credentials", async () => {
  const f = await fixture();
  const credentialsPath = join(f.dir, "credentials.json");
  await Bun.write(credentialsPath, JSON.stringify(f.credentials));
  await chmod(credentialsPath, 0o600);
  const preload = join(f.dir, "preload.ts");
  await Bun.write(
    preload,
    `globalThis.fetch = async input => {
    if(process.env.NO_COLLECTION_HTTP) throw new Error("No HTTP expected");
    const url = new URL(input.url);
    if(!url.pathname.endsWith("/messages")) throw new Error("Unexpected endpoint");
    return Response.json({messages:[{id:String(url.searchParams.get("startTime")),originalarrivaltime:new Date(Number(url.searchParams.get("startTime"))).toISOString(),custom:{preserved:true}}],_metadata:{}});
  };`,
  );
  async function cli(args: string[], noHttp = false) {
    const proc = Bun.spawn(
      [process.execPath, "--preload", preload, "src/cli.ts", ...args],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, ...(noHttp ? { NO_COLLECTION_HTTP: "1" } : {}) },
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
    "collect",
    "--db",
    f.db,
    "--backup-dir",
    join(f.dir, "backups"),
    "--chat",
    "group",
    "--credentials",
    credentialsPath,
    "--from",
    new Date(f.from).toISOString(),
    "--to",
    new Date(f.to).toISOString(),
    "--page-delay-min",
    "0",
    "--page-delay-max",
    "0",
  ];
  const first = await cli(args);
  expect(first.exit).toBe(0);
  expect(first.stdout).toContain('"completedWindows":2');
  expect(first.stdout).toContain("[backup] Saved verified snapshot:");
  expect(first.stdout).toContain('"saved":1,"failed":0');
  const second = await cli(args, true);
  expect(second.exit).toBe(0);
  expect(second.stdout).toContain('"completedWindows":0');
  expect(second.stdout).not.toContain("HTTP attempts:");
  expect(await readdir(join(f.dir, "backups"))).toHaveLength(2);
  const output = join(f.dir, "cli-export");
  const exported = await cli(
    ["export-db", "--db", f.db, "--chat", "group", "--out", output],
    true,
  );
  expect(exported.exit).toBe(0);
  expect(exported.stdout).not.toContain("HTTP attempts:");
  const archive = await readArchive(join(output, "chat.json"));
  expect(archive.messages).toHaveLength(2);
  expect(archive.messages[0]!.custom).toEqual({ preserved: true });
});
