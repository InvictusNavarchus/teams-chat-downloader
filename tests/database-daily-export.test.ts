import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readArchive } from "../src/archive.ts";
import { resolveDatabaseExportOptions } from "../src/command-validation.ts";
import { HistoryStore } from "../src/history-store.ts";
import { requestStats } from "../src/http.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const now = new Date(2026, 10, 15, 12).getTime();
const start = new Date(2026, 10, 13).getTime();
const yesterday = new Date(2026, 10, 14).getTime();
const today = new Date(2026, 10, 15).getTime();
const cutoff = new Date(2026, 10, 15, 10).getTime();
const counters = { pages: 1, records: 1, duplicates: 0 };
async function fixture(end = cutoff, gap = false) {
  const dir = await mkdtemp(join(tmpdir(), "teams-daily-db-"));
  dirs.push(dir);
  const db = join(dir, "history.sqlite");
  const store = await HistoryStore.open(db, "account");
  store.commit(
    "group",
    "Project Alpha",
    { from: start, to: gap ? yesterday : end },
    [
      {
        id: "old",
        originalarrivaltime: new Date(start).toISOString(),
        content: "<p>original</p>",
        unknown: { preserved: true },
      },
    ],
    counters,
    requestStats(),
  );
  if (gap)
    store.commit(
      "group",
      "Project Alpha",
      { from: today, to: end },
      [],
      counters,
      requestStats(),
    );
  else if (end > today)
    store.commit(
      "group",
      "Project Alpha",
      { from: today, to: end },
      [
        {
          id: "boundary",
          originalarrivaltime: new Date(today).toISOString(),
          content: "<p>today</p>",
        },
      ],
      counters,
      requestStats(),
    );
  store.close();
  return {
    dir,
    db,
    day: (date: string) => join(dir, "exports", "project-alpha", date),
  };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, extra = {}) {
  const script = `import { exportDatabase } from ${JSON.stringify(join(import.meta.dir, "../src/database-export.ts"))};
import { resolveDatabaseExportOptions } from ${JSON.stringify(join(import.meta.dir, "../src/command-validation.ts"))};
const result = await exportDatabase(resolveDatabaseExportOptions(JSON.parse(process.env.DAILY_OPTIONS), ${now}), undefined, console.log);
console.log(JSON.stringify(result));`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: f.dir,
    env: {
      ...process.env,
      TZ: "UTC",
      DAILY_OPTIONS: JSON.stringify({
        db: f.db,
        chat: "group",
        last: "3d",
        ...extra,
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("daily database export splits boundaries, preserves empty days and fields, and reports today's cutoff", async () => {
  const f = await fixture();
  const result = await run(f);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(new Date(cutoff).toISOString());
  const first = await readArchive(join(f.day("2026-11-13"), "chat.json"));
  expect(first.messages.map((m) => m.id)).toEqual(["old"]);
  expect(first.messages[0]!.unknown).toEqual({ preserved: true });
  expect(first.window.toExclusive).toBe(new Date(yesterday).toISOString());
  expect(
    (await readArchive(join(f.day("2026-11-14"), "chat.json"))).messages,
  ).toEqual([]);
  const last = await readArchive(join(f.day("2026-11-15"), "chat.json"));
  expect(last.messages.map((m) => m.id)).toEqual(["boundary"]);
  expect(last.window.toExclusive).toBe(new Date(cutoff).toISOString());
  expect(
    await readFile(join(f.day("2026-11-15"), "chat.md"), "utf8"),
  ).toContain("today");
  expect((await run(f, { markdown: false, media: false })).code).toBe(0);
  expect(await readdir(f.day("2026-11-15"))).toEqual(["chat.json"]);
});

test("daily refresh advances the stored cutoff and rejects a newer existing archive", async () => {
  const f = await fixture();
  expect((await run(f)).code).toBe(0);
  const store = await HistoryStore.open(f.db, "account");
  store.commit(
    "group",
    "Project Alpha",
    { from: cutoff, to: now },
    [],
    counters,
    requestStats(),
  );
  store.close();
  expect((await run(f)).code).toBe(0);
  const path = join(f.day("2026-11-15"), "chat.json");
  const archive = await readArchive(path);
  expect(archive.window.toExclusive).toBe(new Date(now).toISOString());
  archive.window.toExclusive = new Date(now + 1).toISOString();
  await writeFile(path, JSON.stringify(archive));
  const result = await run(f);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("newer");
  expect((await readArchive(path)).window.toExclusive).toBe(
    archive.window.toExclusive,
  );
});

test("coverage gaps and stale collections fail before any daily folder is published", async () => {
  for (const f of [await fixture(cutoff, true), await fixture(today)]) {
    const result = await run(f);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/uncollected gaps|no completed coverage/);
    expect(
      await Bun.file(join(f.day("2026-11-13"), "chat.json")).exists(),
    ).toBe(false);
  }
});

test("daily refresh rejects wrong identity, symlinks, and an active archive lock", async () => {
  const f = await fixture();
  expect((await run(f)).code).toBe(0);
  const path = join(f.day("2026-11-13"), "chat.json");
  const original = await readFile(path, "utf8");
  const archive = JSON.parse(original);
  for (const field of ["accountId", "chatId"]) {
    await writeFile(path, JSON.stringify({ ...archive, [field]: "other" }));
    expect((await run(f)).stderr).toContain("another account, chat");
  }
  await writeFile(path, original);
  const md = join(f.day("2026-11-13"), "chat.md");
  await rm(md);
  await symlink(path, md);
  expect((await run(f)).stderr).toContain("symlinks");
  await rm(md);
  await mkdir(`${path}.media.lock`);
  expect((await run(f)).stderr).toContain("already running");
  expect(await readFile(path, "utf8")).toBe(original);
});

test("daily date validation rejects ambiguous modes and invalid day counts", () => {
  for (const extra of [
    {},
    { last: "0d" },
    { last: "1.5d" },
    { last: "999999999999999999999d" },
    { last: "3d", out: "dest" },
    { last: "3d", from: "2026-11-01T00:00:00Z" },
  ]) {
    expect(() =>
      resolveDatabaseExportOptions({ db: "db", chat: "chat", ...extra }, now),
    ).toThrow();
  }
  expect(
    resolveDatabaseExportOptions({ db: "db", chat: "chat", last: "3d" }, now)
      .window,
  ).toEqual({ from: start, to: now });
});

test("daily export follows local DST calendar boundaries", async () => {
  const f = await fixture();
  const store = await HistoryStore.open(f.db, "account");
  store.commit(
    "dst",
    "DST",
    {
      from: Date.parse("2026-10-31T04:00:00Z"),
      to: Date.parse("2026-11-02T15:00:00Z"),
    },
    [],
    counters,
    requestStats(),
  );
  store.close();
  const script = `import { exportDatabase } from ${JSON.stringify(join(import.meta.dir, "../src/database-export.ts"))};
import { resolveDatabaseExportOptions } from ${JSON.stringify(join(import.meta.dir, "../src/command-validation.ts"))};
await exportDatabase(resolveDatabaseExportOptions({ db: ${JSON.stringify(f.db)}, chat: "dst", last: "3d" }, Date.parse("2026-11-02T17:00:00Z")));`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: f.dir,
    env: { ...process.env, TZ: "America/New_York" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toBe("");
  expect(await child.exited).toBe(0);
  const archive = await readArchive(
    join(f.dir, "exports", "dst", "2026-11-01", "chat.json"),
  );
  expect(archive.window.from).toBe("2026-11-01T04:00:00.000Z");
  expect(archive.window.toExclusive).toBe("2026-11-02T05:00:00.000Z");
});

test("export-db CLI accepts --last and logs the cutoff and daily results", async () => {
  const f = await fixture();
  const invocation = Date.now();
  const midnight = new Date(invocation);
  midnight.setUTCHours(0, 0, 0, 0);
  const store = await HistoryStore.open(f.db, "account");
  store.commit(
    "cli",
    "CLI",
    { from: midnight.getTime() - 2 * 86400000, to: invocation },
    [],
    counters,
    requestStats(),
  );
  store.close();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "export-db",
      "--db",
      f.db,
      "--chat",
      "cli",
      "--last",
      "3d",
    ],
    {
      cwd: f.dir,
      env: { ...process.env, TZ: "UTC" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).days).toHaveLength(3);
  const files = await readdir(`${f.db}.logs`);
  const log = await readFile(join(`${f.db}.logs`, files[0]!), "utf8");
  expect(log).toContain("today's collected cutoff");
  expect(log).toContain("Saved JSON archive");
});

test("daily media export cleans failed first publication, retries, and repairs local copies on refresh", async () => {
  const f = await fixture();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
    "base64",
  );
  const sha256 = new Bun.CryptoHasher("sha256").update(png).digest("hex");
  const store = await HistoryStore.open(f.db, "account");
  store.commit(
    "group",
    "Project Alpha",
    { from: start, to: yesterday },
    [
      {
        id: "images",
        originalarrivaltime: new Date(start + 1).toISOString(),
        messagetype: "RichText/Html",
        content:
          '<img src="https://us-api.asm.skype.com/v1/objects/first/views/imgo"><img src="https://us-api.asm.skype.com/v1/objects/second/views/imgo">',
      },
    ],
    counters,
    requestStats(),
  );
  const images = store.images();
  for (const [index, image] of images.entries()) {
    const hash = index === 0 ? sha256 : "a".repeat(64);
    store.saveImage({
      messageId: "images",
      key: image.key,
      path: `media/${hash}.png`,
      bytes: png.length,
      sha256: hash,
      mediaType: "image/png",
    });
  }
  const media = `${f.db}.media`;
  await mkdir(media);
  await writeFile(join(media, `${sha256}.png`), png);
  expect((await run(f)).stderr).toContain("missing or corrupt");
  expect(await Bun.file(join(f.day("2026-11-13"), "chat.json")).exists()).toBe(
    false,
  );
  store.imagePending(images[1]!.key);
  store.close();
  expect((await run(f)).code).toBe(0);
  const local = join(f.day("2026-11-13"), "media", `${sha256}.png`);
  expect(await readFile(local)).toEqual(png);
  await writeFile(local, "corrupt");
  expect((await run(f)).code).toBe(0);
  expect(await readFile(local)).toEqual(png);
  const saved = await readFile(join(f.day("2026-11-13"), "chat.json"), "utf8");
  await writeFile(join(media, `${sha256}.png`), "corrupt");
  expect((await run(f)).stderr).toContain("missing or corrupt");
  expect(await readFile(join(f.day("2026-11-13"), "chat.json"), "utf8")).toBe(
    saved,
  );
});
