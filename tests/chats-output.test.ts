import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryStore } from "../src/history-store.ts";
import { requestStats } from "../src/http.ts";
import { writeChatList } from "../src/output.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const directory = (title: string) => ({
  chats: [{ id: "synthetic-chat", title, isOneOnOne: false }],
  metadata: { hasMoreChats: false, isPartialData: false },
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "teams-chat-list-test-"));
  directories.push(dir);
  const credentials = join(dir, "credentials.json");
  await writeFile(
    credentials,
    JSON.stringify({
      version: 1,
      accountId: "fixture",
      directoryToken: "fixture-token",
    }),
    { mode: 0o600 },
  );
  const preload = join(dir, "offline.ts");
  const response = join(dir, "response.json");
  await writeFile(
    preload,
    `globalThis.fetch = async () => new Response(await Bun.file(process.env.FIXTURE_RESPONSE).text(), {
    status: Number(process.env.FIXTURE_STATUS), headers: { "content-type": "application/json" }
  });`,
  );
  async function run(
    args: string[],
    payload: unknown = directory("Example"),
    status = 200,
  ) {
    await writeFile(response, JSON.stringify(payload));
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "chats",
        "--credentials",
        credentials,
        ...args,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          FIXTURE_RESPONSE: response,
          FIXTURE_STATUS: String(status),
          // Activity dates are shown in local time; pin it for the fixtures.
          TZ: "UTC",
          // chats reads the default collection; keep it inside the fixture.
          TEAMS_DATA_DIR: "",
          XDG_STATE_HOME: join(dir, "state"),
          XDG_CACHE_HOME: join(dir, "cache"),
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
  return { dir, run };
}

test("chats --out saves JSON beside the table and the same command refreshes it", async () => {
  const f = await fixture();
  const out = join(f.dir, "reference", "chats.json");
  const first = await f.run(["--out", out], directory("First name"));
  expect(first.code).toBe(0);
  const saved = await readFile(out, "utf8");
  expect(first.stdout).toMatch(/^-\s+First name\s+synthetic-chat$/m);
  expect(JSON.parse(saved)[0].label).toBe("First name");
  expect(first.stdout).toContain(`Saved chat list to ${out}.`);
  expect(first.stdout).toContain("HTTP attempts: 1 (history: 0, directory: 1");
  expect(first.stderr).toBe("");
  const refreshed = await f.run(["--out", out], directory('Updated "name" ✓'));
  expect(refreshed.code).toBe(0);
  const updated = await readFile(out, "utf8");
  expect(refreshed.stdout).toContain('Updated "name" ✓');
  expect(JSON.parse(updated)[0].label).toBe('Updated "name" ✓');
  expect(refreshed.stderr).toBe("");
  expect(await readdir(join(f.dir, "reference"))).toEqual(["chats.json"]);
  if (process.platform !== "win32") {
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.dir, "reference"))).mode & 0o777).toBe(0o700);
  }
});

test.each([
  { payload: directory("Unauthorized"), status: 401 },
  {
    payload: {
      ...directory("Partial"),
      metadata: { hasMoreChats: true, isPartialData: false },
    },
    status: 200,
  },
  { payload: { chats: "invalid", metadata: {} }, status: 200 },
])(
  "failed listing preserves the previous reference file",
  async ({ payload, status }) => {
    const f = await fixture();
    const out = join(f.dir, "chats.json");
    const before = "previous-reference-bytes\n";
    await writeFile(out, before, { mode: 0o600 });
    const failed = await f.run(["--out", out], payload, status);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toStartWith("HTTP attempts: 1");
    expect(failed.stdout).not.toContain("Saved chat list");
    expect(failed.stderr).not.toBe("");
    expect(failed.stderr).not.toContain("HTTP attempts");
    expect(await readFile(out, "utf8")).toBe(before);
  },
);

test("empty directories refresh successfully to an empty array", async () => {
  const f = await fixture();
  const result = await f.run(["--out", "chats.json"], {
    chats: [],
    metadata: { hasMoreChats: false, isPartialData: false },
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(await readFile(join(f.dir, "chats.json"), "utf8"))).toEqual(
    [],
  );
});

test("plain chats prints a table without saving a reference file", async () => {
  const f = await fixture();
  const result = await f.run([]);
  expect(result.code).toBe(0);
  expect(result.stdout).toStartWith("LAST ACTIVITY  SAVED  CHAT     ID\n");
  expect(result.stdout).toContain("1 chat; 0 saved.");
  expect(result.stdout).not.toContain("Saved chat list");
  expect(result.stdout).toContain("HTTP attempts: 1");
  expect(result.stderr).toBe("");
  expect(await Bun.file(join(f.dir, "chats.json")).exists()).toBe(false);
});

test("chats marks saved chats from the database, sorts by activity and --new suggests the next collection", async () => {
  const f = await fixture();
  const db = join(f.dir, "history.sqlite");
  const store = await HistoryStore.open(db, "fixture");
  store.commit(
    "19:saved",
    "Saved chat",
    { from: 1, to: 2 },
    [],
    { pages: 1, records: 0, duplicates: 0 },
    requestStats(),
  );
  store.close();
  const payload = {
    chats: [
      { id: "19:saved", title: "Saved chat", isOneOnOne: false },
      {
        id: "19:recent",
        title: "Recent chat",
        isOneOnOne: false,
        // Directory previews use 7 fractional digits like history records.
        lastMessage: { originalArrivalTime: "2026-11-20T12:00:00.1230000Z" },
      },
      {
        id: "19:older",
        title: "Older chat",
        isOneOnOne: false,
        lastMessage: { composeTime: "2026-10-01T12:00:00Z" },
      },
      // An unexpected preview shape must not break the listing.
      { id: "19:odd", title: "Odd chat", isOneOnOne: false, lastMessage: 7 },
    ],
    metadata: { hasMoreChats: false, isPartialData: false },
  };
  const all = await f.run(["--db", db], payload);
  expect(all.code).toBe(0);
  expect(all.stderr).toBe("");
  expect(all.stdout.split("\nHTTP attempts:")[0]).toBe(
    [
      "LAST ACTIVITY  SAVED  CHAT         ID",
      "2026-11-20            Recent chat  19:recent",
      "2026-10-01            Older chat   19:older",
      "-                     Odd chat     19:odd",
      "-              yes    Saved chat   19:saved",
      "",
      "4 chats; 1 saved. Use --new to list only unsaved chats.",
    ].join("\n"),
  );
  const unsaved = await f.run(["--db", db, "--new"], payload);
  expect(unsaved.code).toBe(0);
  expect(unsaved.stdout).not.toContain("19:saved");
  expect(unsaved.stdout).toContain(
    "3 of 4 chats are not saved. Start collecting one with:\n  teams collect --chat-label 'Recent chat' --all-history --images",
  );
  const out = join(f.dir, "chats.json");
  await f.run(["--db", db, "--new", "--out", out], payload);
  // --out keeps the full directory, including saved chats and activity.
  expect(JSON.parse(await readFile(out, "utf8"))).toContainEqual({
    id: "19:saved",
    title: "Saved chat",
    label: "Saved chat",
    isOneOnOne: false,
    lastActivity: null,
  });
  expect(JSON.parse(await readFile(out, "utf8"))[1].lastActivity).toBe(
    "2026-11-20T12:00:00.123Z",
  );
});

test("chats refuses another account's database and a missing explicit --db", async () => {
  const f = await fixture();
  const other = join(f.dir, "other.sqlite");
  (await HistoryStore.open(other, "other-account")).close();
  const mismatch = await f.run(["--db", other]);
  expect(mismatch.code).toBe(1);
  expect(mismatch.stderr).toContain("belongs to a different account");
  expect(mismatch.stdout).not.toContain("HTTP attempts");
  const missing = await f.run(["--db", join(f.dir, "missing.sqlite")]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("No collection database at --db path.");
  expect(missing.stdout).not.toContain("HTTP attempts");
});

test("invalid --out is rejected before network activity", async () => {
  const f = await fixture();
  const result = await f.run(["--out", ""]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("out");
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain("HTTP attempts");
});

test("cancelled publication preserves existing bytes and removes its temporary file", async () => {
  const f = await fixture();
  const path = join(f.dir, "chats.json");
  await writeFile(path, "keep", { mode: 0o600 });
  const before = (await readdir(f.dir)).sort();
  const controller = new AbortController();
  controller.abort();
  await expect(writeChatList(path, [], controller.signal)).rejects.toThrow(
    "cancelled",
  );
  expect(await readFile(path, "utf8")).toBe("keep");
  expect((await readdir(f.dir)).sort()).toEqual(before);
});

test("publication failure reports failure and leaves no temporary file", async () => {
  const f = await fixture();
  const path = join(f.dir, "destination-directory");
  await mkdir(path);
  const before = (await readdir(f.dir)).sort();
  await expect(writeChatList(path, [])).rejects.toThrow(
    "Could not save the chat list",
  );
  expect((await readdir(f.dir)).sort()).toEqual(before);
});
