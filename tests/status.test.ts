import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../src/archive.ts";
import { statusTable } from "../src/chat-table.ts";
import { HistoryStore } from "../src/history-store.ts";
import { requestStats } from "../src/http.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const day = 24 * 60 * 60 * 1000;
const start = Date.parse("2026-11-01T00:00:00Z");
const counters = { pages: 1, records: 1, duplicates: 0 };
const image = (id: string) =>
  `<img src="https://us-api.asm.skype.com/v1/objects/${id}/views/imgo">`;
const message = (id: string, at: number, content = "text"): Message => ({
  id,
  originalarrivaltime: new Date(at).toISOString(),
  messagetype: "RichText/Html",
  content,
});

/** Two chats: one with a coverage gap and mixed image states, one empty backfill. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "teams-status-test-"));
  directories.push(dir);
  const db = join(dir, "history.sqlite");
  const store = await HistoryStore.open(db, "fixture");
  store.commit(
    "19:alpha",
    "Project Alpha",
    { from: start, to: start + 7 * day },
    [
      message("1", start + day, image("one")),
      message("2", start + 2 * day, image("two")),
    ],
    counters,
    requestStats(),
  );
  store.commit(
    "19:alpha",
    "Project Alpha",
    { from: start + 14 * day, to: start + 21 * day },
    [message("3", start + 15 * day, image("three"))],
    counters,
    requestStats(),
  );
  store.commit(
    "19:quiet",
    undefined,
    { from: 1, to: start },
    [],
    counters,
    requestStats(),
  );
  const [first, second] = store.images("19:alpha");
  store.imageFailed(second!.key, "HTTP 500");
  store.close();
  const raw = new Database(db);
  raw.query("UPDATE images SET status='complete' WHERE key=?").run(first!.key);
  raw.close();
  return { dir, db };
}

test("chat summaries report messages, coverage, gaps and image states", async () => {
  const f = await fixture();
  const store = await HistoryStore.open(f.db);
  try {
    expect(store.chatSummaries()).toEqual([
      {
        chatId: "19:alpha",
        label: "Project Alpha",
        messages: 3,
        coverage: { from: start, to: start + 21 * day },
        gaps: 1,
        images: { complete: 1, pending: 1, failed: 1 },
      },
      {
        chatId: "19:quiet",
        label: undefined,
        messages: 0,
        coverage: { from: 1, to: start },
        gaps: 0,
        images: { complete: 0, pending: 0, failed: 0 },
      },
    ]);
    expect(store.imageCounts()).toEqual({ complete: 1, pending: 1, failed: 1 });
  } finally {
    store.close();
  }
});

test("status table lists labels, ranges and next steps", () => {
  const lines = statusTable(
    [
      {
        chatId: "19:quiet",
        messages: 0,
        coverage: { from: 1, to: start },
        gaps: 0,
        images: { complete: 0, pending: 0, failed: 0 },
      },
      {
        chatId: "19:alpha",
        label: "Project Alpha",
        messages: 1234,
        coverage: { from: start, to: start + 21 * day },
        gaps: 1,
        images: { complete: 1, pending: 1, failed: 1 },
      },
    ],
    { complete: 1, pending: 1, failed: 1 },
    "/data/history.sqlite",
  );
  // Rows depend on the local timezone, so check their stable parts.
  expect(lines[0]).toBe(
    "CHAT              MESSAGES  COLLECTED (LOCAL TIME)           GAPS  IMAGES TO GET  ID",
  );
  expect(lines[1]).toStartWith("(no saved label)  0         all history to ");
  expect(lines[1]).toEndWith("19:quiet");
  expect(lines[2]).toMatch(
    /^Project Alpha     1,234     2026-1[01]-\d\d to 2026-11-\d\d \d\d:\d\d   1     2              19:alpha$/,
  );
  expect(lines.slice(3)).toEqual([
    "",
    "2 saved chats in /data/history.sqlite.",
    "Chats with gaps are retried by catch-up: teams collect --all-chats",
    "2 images still to download (1 failed before): teams images",
  ]);
  expect(
    statusTable([], { complete: 0, pending: 0, failed: 0 }, "/data/h.sqlite"),
  ).toEqual([
    "No saved chats in /data/h.sqlite.",
    "Run teams chats --new to pick one, then collect it with --chat-label and --all-history.",
  ]);
});

async function cli(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const preload = join(dir, "no-http.ts");
  await writeFile(
    preload,
    'globalThis.fetch = async () => { throw new Error("status must not make HTTP requests"); };',
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      preload,
      join(import.meta.dir, "../src/cli.ts"),
      "status",
      ...args,
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        TZ: "UTC",
        TEAMS_DATA_DIR: "",
        XDG_STATE_HOME: join(dir, "state"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("status runs offline and read-only on an explicit or configured database", async () => {
  const f = await fixture();
  const before = (await readdir(f.dir)).sort();
  const explicit = await cli(f.dir, ["--db", f.db]);
  expect(explicit.stderr).toBe("");
  expect(explicit.code).toBe(0);
  expect(explicit.stdout).toContain(
    "Project Alpha     3         2026-11-01 to 2026-11-22 00:00   1     2              19:alpha",
  );
  expect(explicit.stdout).toContain(
    "(no saved label)  0         all history to 2026-11-01 00:00                       19:quiet",
  );
  expect(explicit.stdout).not.toContain("HTTP attempts");
  // No credentials, log directory or other files are created.
  expect((await readdir(f.dir)).sort()).toEqual(
    [...before, "no-http.ts"].sort(),
  );
  const configured = await cli(f.dir, [], { TEAMS_DATA_DIR: f.dir });
  expect(configured.code).toBe(0);
  expect(configured.stdout).toBe(explicit.stdout);
});

test("status explains a missing database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teams-status-test-"));
  directories.push(dir);
  const missing = await cli(dir, ["--db", join(dir, "missing.sqlite")]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("No collection database at --db path.");
  const undiscovered = await cli(dir, []);
  expect(undiscovered.code).toBe(1);
  expect(undiscovered.stderr).toContain("No default collection found");
});
