import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readArchive } from "../src/archive.ts";
import { HistoryStore } from "../src/history-store.ts";
import { requestStats } from "../src/http.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const now = Date.parse("2026-11-15T12:00:00Z");
const from = Date.parse("2026-11-11T00:00:00Z");
const day = 86400000;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);

async function fixture({
  gap = false,
  collision = false,
  empty = false,
  noOverlap = false,
  useDataDirectory = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "teams-batch-export-"));
  directories.push(dir);
  const account = "batch-account";
  const dataDirectory = useDataDirectory ? join(dir, "work data") : "";
  const db = dataDirectory
    ? join(dataDirectory, "history.sqlite")
    : join(
        dir,
        "state",
        "teams-chat-download",
        "collections",
        `${createHash("sha256").update(account).digest("hex")}.sqlite`,
      );
  await mkdir(dirname(db), { recursive: true, mode: 0o700 });
  const store = await HistoryStore.open(db, account);
  for (const chat of empty ? [] : ["a", "b", "c"]) {
    const label =
      chat === "a"
        ? "Project Alpha"
        : chat === "b"
          ? collision
            ? "Project/Alpha"
            : "Beta"
          : undefined;
    const end = chat === "b" ? (noOverlap ? from : now - day) : now - 3600000;
    const messages =
      chat === "c"
        ? []
        : [
            {
              id: "old",
              originalarrivaltime: new Date(from - day).toISOString(),
              content: "outside requested range",
            },
            {
              id: "image",
              originalarrivaltime: new Date(from + 1).toISOString(),
              messagetype: "RichText/Html",
              content:
                '<img src="https://us-api.asm.skype.com/v1/objects/batch-image/views/imgo">',
              unknown: { preserved: true },
            },
          ];
    store.commit(
      chat,
      label,
      { from: from - 2 * day, to: gap && chat === "b" ? from + day : end },
      messages.filter(
        (message) => Date.parse(message.originalarrivaltime) < end,
      ),
      { pages: 1, records: messages.length, duplicates: 0 },
      requestStats(),
    );
    if (gap && chat === "b")
      store.commit(
        chat,
        label,
        { from: from + 2 * day, to: end },
        [],
        { pages: 1, records: 0, duplicates: 0 },
        requestStats(),
      );
  }
  const hash = createHash("sha256").update(png).digest("hex");
  for (const image of store.images())
    store.saveImage({
      messageId: "image",
      key: image.key,
      path: `media/${hash}.png`,
      bytes: png.length,
      sha256: hash,
      mediaType: "image/png",
    });
  store.close();
  await mkdir(`${db}.media`, { mode: 0o700 });
  await writeFile(join(`${db}.media`, `${hash}.png`), png, { mode: 0o600 });
  const preload = join(dir, "offline.ts");
  await writeFile(
    preload,
    `Date.now = () => ${now};
globalThis.fetch = async () => { throw new Error("Offline export must not make requests"); };
if (process.env.CANCEL_BATCH) {
  const log = console.log;
  console.log = (...args) => {
    log(...args);
    if (String(args[0]).startsWith('[export] Chat "a" complete:')) process.emit("SIGINT");
  };
}`,
  );
  const run = async (
    extra: string[] = [],
    {
      implicitDb = false,
      alias = false,
      cancel = false,
      dataDir = dataDirectory,
    } = {},
  ) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(import.meta.dir, "../src/cli.ts"),
        alias ? "export-db" : "export",
        ...(implicitDb ? [] : ["--db", db]),
        "--all-chats",
        "--last",
        "5d",
        ...extra,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          TZ: "UTC",
          XDG_STATE_HOME: join(dir, "state"),
          XDG_CACHE_HOME: join(dir, "cache"),
          TEAMS_DATA_DIR: dataDir,
          CANCEL_BATCH: cancel ? "1" : "",
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
  };
  return { dir, db, hash, run };
}

test("all-chat daily export includes saved images and Markdown offline, with per-chat cutoffs and empty days", async () => {
  const f = await fixture();
  const before = await readFile(f.db);
  const result = await f.run();
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("HTTP attempts:");
  expect(result.stdout).toContain(
    `Export complete: 2 messages across 3 chats in 14 daily folders under ${join(f.dir, "exports")}`,
  );
  // The full result is kept in the invocation log rather than printed.
  const [logFile] = await readdir(`${f.db}.logs`);
  const resultLine = (await readFile(join(`${f.db}.logs`, logFile!), "utf8"))
    .split("\n")
    .find((line) => line.includes("] Result: {"))!;
  const summary = JSON.parse(resultLine.slice(resultLine.indexOf("{")));
  expect(summary).toMatchObject({ status: "complete", messages: 2 });
  expect(
    summary.chats.map((chat: { chatId: string; days: unknown[] }) => [
      chat.chatId,
      chat.days.length,
    ]),
  ).toEqual([
    ["a", 5],
    ["b", 4],
    ["c", 5],
  ]);
  expect(result.stdout).toContain("Skipping uncollected tail");
  for (const name of ["project-alpha", "beta"]) {
    const folder = join(f.dir, "exports", name, "2026-11-11");
    const archive = await readArchive(join(folder, "chat.json"));
    expect(archive.messages.map((message) => message.id)).toEqual(["image"]);
    expect(archive.messages[0]!.unknown).toEqual({ preserved: true });
    expect(archive.media.status).toBe("complete");
    expect(await readFile(join(folder, "media", `${f.hash}.png`))).toEqual(png);
    expect(await readFile(join(folder, "chat.md"), "utf8")).toContain("media/");
    expect(
      (
        await readArchive(
          join(f.dir, "exports", name, "2026-11-12", "chat.json"),
        )
      ).messages,
    ).toEqual([]);
  }
  expect(await readFile(f.db)).toEqual(before);
  const logs = await readdir(`${f.db}.logs`);
  expect(logs).toHaveLength(1);
  const log = await readFile(join(`${f.db}.logs`, logs[0]!), "utf8");
  for (const text of [
    "--all-chats",
    "Verified daily coverage for 3 saved chat(s)",
    'Chat 1/3: "a"',
    'Chat "b" complete',
    "Copied 1 image(s)",
    "Completed successfully",
  ])
    expect(log).toContain(text);
  expect(log).not.toContain("outside requested range");
  expect(log).not.toContain("https://us-api.asm.skype.com");
});

test("batch alias and default database discovery remain offline; reruns can disable Markdown and image copies", async () => {
  const f = await fixture();
  expect((await f.run([], { implicitDb: true, alias: true })).code).toBe(0);
  const rerun = await f.run(["--no-markdown", "--no-media", "--no-log"], {
    implicitDb: true,
  });
  expect(rerun.code).toBe(0);
  expect(rerun.stdout).not.toContain("HTTP attempts:");
  expect(rerun.stdout).not.toContain("Collection log:");
  expect(await readdir(`${f.db}.logs`)).toHaveLength(1);
  for (const name of ["project-alpha", "beta"]) {
    const folder = join(f.dir, "exports", name, "2026-11-11");
    expect(await readdir(folder)).not.toContain("chat.md");
    expect((await readArchive(join(folder, "chat.json"))).media.status).toBe(
      "not-downloaded",
    );
  }
});

test("configured data directory supplies the offline database and daily export root", async () => {
  const f = await fixture({ useDataDirectory: true });
  const result = await f.run(["--no-log"], { implicitDb: true });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const relativeArchive = join(
    "exports",
    "project-alpha",
    "2026-11-11",
    "chat.json",
  );
  expect((await readArchive(join(dirname(f.db), relativeArchive))).chatId).toBe(
    "a",
  );
  expect(await readdir(f.dir)).not.toContain("exports");

  const otherDataDir = join(f.dir, "other data");
  await mkdir(otherDataDir, { mode: 0o700 });
  const explicit = await f.run(["--no-log"], { dataDir: otherDataDir });
  expect(explicit.stderr).toBe("");
  expect(explicit.code).toBe(0);
  expect((await readArchive(join(otherDataDir, relativeArchive))).chatId).toBe(
    "a",
  );
});

test.each(["gap", "noOverlap", "empty", "collision"])(
  "batch %s fails preflight before any daily publication",
  async (problem) => {
    const f = await fixture({ [problem]: true });
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(await readdir(f.dir)).not.toContain("exports");
    expect(result.stdout).not.toContain("Saved JSON archive");
    expect(result.stderr).toContain(
      problem === "gap"
        ? "uncollected gaps"
        : problem === "noOverlap"
          ? "No completed history overlaps"
          : problem === "empty"
            ? "No saved chats"
            : "share an export folder",
    );
  },
);

test.each(["failure", "cancellation"])(
  "batch %s preserves published chats and stops later work",
  async (mode) => {
    const f = await fixture();
    const blocked = join(f.dir, "exports", "beta", "2026-11-11");
    if (mode === "failure") {
      await mkdir(blocked, { recursive: true });
      await writeFile(join(blocked, "chat.json"), "{}");
    }
    const result = await f.run([], { cancel: mode === "cancellation" });
    expect(result.code).toBe(mode === "failure" ? 1 : 130);
    expect(
      (
        await readArchive(
          join(f.dir, "exports", "project-alpha", "2026-11-15", "chat.json"),
        )
      ).chatId,
    ).toBe("a");
    expect(result.stdout).not.toContain('Chat "b" complete');
    expect((await readdir(join(f.dir, "exports"))).sort()).toEqual(
      mode === "failure" ? ["beta", "project-alpha"] : ["project-alpha"],
    );
    const logs = await readdir(`${f.db}.logs`);
    const log = await readFile(join(`${f.db}.logs`, logs[0]!), "utf8");
    expect(log).toContain(
      mode === "failure" ? "[export] Failed:" : "[export] Cancelled:",
    );
    expect(log).not.toContain("Completed successfully");
  },
);
