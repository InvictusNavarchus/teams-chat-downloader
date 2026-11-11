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
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertAllArchives } from "../src/convert-all.ts";
import { resolveBatchConvertOptions } from "../src/command-validation.ts";
import { archive } from "./fixtures/archive.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "teams-convert-all-test-"));
  directories.push(dir);
  const exports = join(dir, "exports");
  await mkdir(exports);
  const preload = join(dir, "offline.ts");
  await writeFile(
    preload,
    'globalThis.fetch = () => { throw new Error("Network forbidden"); };',
  );
  async function put(name: string, document: unknown = archive()) {
    const path = join(exports, name);
    const raw =
      typeof document === "string"
        ? document
        : JSON.stringify(document, null, 2);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, raw);
    return { path, raw };
  }
  async function run(args: readonly string[] = []) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "convert-all",
        ...args,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          XDG_STATE_HOME: join(dir, "missing-state"),
          TZ: "UTC",
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
  return { dir, exports, put, run };
}

test("convert-all defaults to exports, converts missing Markdown offline, and is safe to repeat", async () => {
  const f = await fixture();
  const first = await f.put("first.json");
  const second = await f.put("second.JSON");
  await f.put("done.json", "already-converted sources need not be parsed");
  await f.put("done.md", "Previous Markdown");
  await f.put("notes.txt", "Ignore this file");
  await f.put("nested/later.json");
  const result = await f.run();
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const summary = JSON.parse(result.stdout);
  expect(summary).toMatchObject({
    directory: f.exports,
    format: "markdown",
    recursive: false,
    converted: 2,
    skipped: 1,
    failed: 0,
  });
  expect(
    summary.files.map((file: { input: string; status: string }) => [
      basename(file.input),
      file.status,
    ]),
  ).toEqual([
    ["done.json", "skipped"],
    ["first.json", "converted"],
    ["second.JSON", "converted"],
  ]);
  const markdown = await readFile(join(f.exports, "first.md"), "utf8");
  expect(markdown).toContain("**Example sender · 12:00**");
  expect(await readFile(join(f.exports, "done.md"), "utf8")).toBe(
    "Previous Markdown",
  );
  expect(await readFile(first.path, "utf8")).toBe(first.raw);
  expect(await readFile(second.path, "utf8")).toBe(second.raw);
  expect(await Bun.file(join(f.exports, "nested/later.md")).exists()).toBe(
    false,
  );
  const repeated = await f.run();
  expect(repeated.code).toBe(0);
  expect(JSON.parse(repeated.stdout)).toMatchObject({
    converted: 0,
    skipped: 3,
    failed: 0,
  });
  expect(await readFile(join(f.exports, "first.md"), "utf8")).toBe(markdown);
});

test("default scanning converts direct export folders and recursion reaches deeper bundles", async () => {
  const f = await fixture();
  const source = await f.put("first/chat.json");
  await f.put("done/chat.json", "Already converted");
  await f.put("done/chat.md", "Previous Markdown");
  await f.put("nested/deeper/chat.json");
  const result = await f.run();
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    converted: 1,
    skipped: 1,
    failed: 0,
  });
  expect(await readFile(join(f.exports, "first/chat.md"), "utf8")).toContain(
    "Example sender",
  );
  expect(await readFile(source.path, "utf8")).toBe(source.raw);
  expect(
    await Bun.file(join(f.exports, "nested/deeper/chat.md")).exists(),
  ).toBe(false);
  const nested = await f.run(["--recursive"]);
  expect(nested.code).toBe(0);
  expect(JSON.parse(nested.stdout)).toMatchObject({
    converted: 1,
    skipped: 2,
    failed: 0,
  });
  expect(
    await Bun.file(join(f.exports, "nested/deeper/chat.md")).exists(),
  ).toBe(true);
});

test("default scanning finds grouped daily exports and snapshots alongside legacy folders", async () => {
  const f = await fixture();
  const names = [
    "legacy/chat.json",
    "alpha/2026-11-11/chat.json",
    "alpha/last-7d--to-2026-11-11T03-00-00-000Z/chat.json",
    "beta/from-2026-11-01T00-00-00-000Z--to-2026-11-02T00-00-00-000Z/chat.json",
  ];
  for (const name of names) await f.put(name);
  await f.put("alpha/2026-11-11/media/chat.json");
  await f.put("alpha/2026-11-11/nested/chat.json");
  const outside = await f.put("../outside/chat.json");
  await symlink(dirname(outside.path), join(f.exports, "alpha/2026-11-12"));
  await symlink(outside.path, join(f.exports, "alpha/2026-11-11/linked.json"));
  const result = await f.run();
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    converted: 4,
    skipped: 0,
    failed: 0,
  });
  for (const name of names)
    expect(
      await Bun.file(join(f.exports, name.replace(/\.json$/, ".md"))).exists(),
    ).toBe(true);
  expect(
    await Bun.file(join(f.exports, "alpha/2026-11-11/media/chat.md")).exists(),
  ).toBe(false);
  expect(
    await Bun.file(join(f.exports, "alpha/2026-11-11/nested/chat.md")).exists(),
  ).toBe(false);
  expect(await Bun.file(join(dirname(outside.path), "chat.md")).exists()).toBe(
    false,
  );
  expect(JSON.parse((await f.run()).stdout)).toMatchObject({
    converted: 0,
    skipped: 4,
    failed: 0,
  });
});

test("--dir selects another directory and --recursive includes nested exports", async () => {
  const f = await fixture();
  await f.put("unselected.json");
  const first = await f.put("../custom/first.json");
  const nested = await f.put("../custom/nested/deeper/second.JSON");
  const result = await f.run([
    "--dir",
    "custom",
    "--recursive",
    "--format",
    "markdown",
  ]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    directory: join(f.dir, "custom"),
    recursive: true,
    converted: 2,
    skipped: 0,
    failed: 0,
  });
  expect(await Bun.file(join(f.dir, "custom/first.md")).exists()).toBe(true);
  expect(
    await Bun.file(join(f.dir, "custom/nested/deeper/second.md")).exists(),
  ).toBe(true);
  expect(await Bun.file(join(f.exports, "unselected.md")).exists()).toBe(false);
  expect(await readFile(first.path, "utf8")).toBe(first.raw);
  expect(await readFile(nested.path, "utf8")).toBe(nested.raw);
});

test("invalid exports are reported without stopping valid files, and retries skip completed files", async () => {
  const f = await fixture();
  await f.put("01-broken.json", "{ private-message-content");
  await f.put("02-unsupported.json", { ...archive(), version: 2 });
  await f.put("03-chat-list.json", []);
  const good = await f.put("04-valid.json");
  const result = await f.run();
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("3 JSON export(s) could not be converted");
  expect(result.stderr).not.toContain("HTTP attempts:");
  const summary = JSON.parse(result.stdout);
  expect(summary).toMatchObject({ converted: 1, skipped: 0, failed: 3 });
  expect(summary.files.map((file: { status: string }) => file.status)).toEqual([
    "failed",
    "failed",
    "failed",
    "converted",
  ]);
  expect(summary.files[0].error).toBe("Input export is not valid JSON.");
  expect(result.stdout).not.toContain("private-message-content");
  expect(await readFile(good.path, "utf8")).toBe(good.raw);
  const markdown = await readFile(join(f.exports, "04-valid.md"), "utf8");
  for (const name of ["01-broken", "02-unsupported", "03-chat-list"]) {
    expect(await Bun.file(join(f.exports, `${name}.md`)).exists()).toBe(false);
    await f.put(`${name}.json`);
  }
  const retry = await f.run();
  expect(retry.code).toBe(0);
  expect(JSON.parse(retry.stdout)).toMatchObject({
    converted: 3,
    skipped: 1,
    failed: 0,
  });
  expect(await readFile(join(f.exports, "04-valid.md"), "utf8")).toBe(markdown);
});

test("empty directories succeed, while missing or non-directory paths fail visibly", async () => {
  const f = await fixture();
  const empty = await f.run();
  expect(empty.code).toBe(0);
  expect(JSON.parse(empty.stdout)).toMatchObject({
    converted: 0,
    skipped: 0,
    failed: 0,
    files: [],
  });
  await f.put("file.json");
  for (const dir of ["missing", "exports/file.json"]) {
    const result = await f.run(["--dir", dir]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not read conversion directory");
  }
  expect(await readdir(f.exports)).toEqual(["file.json"]);
});

test.each([
  { args: ["--dir", ""] },
  { args: ["--format", "html"] },
  { args: ["--input", "exports/first.json"] },
  { args: ["--out", "all.md"] },
])("invalid batch arguments cannot produce output: %j", async ({ args }) => {
  const f = await fixture();
  await f.put("first.json");
  const result = await f.run(args);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(await readdir(f.exports)).toEqual(["first.json"]);
});

test.skipIf(process.platform === "win32")(
  "scans ignore symlinks and preserve a dangling Markdown destination",
  async () => {
    const f = await fixture();
    const outside = await f.put("../outside/source.json");
    await f.put("first.json");
    await f.put("done.json");
    await symlink(outside.path, join(f.exports, "linked.json"));
    await symlink(dirname(outside.path), join(f.exports, "linked-directory"));
    await symlink("missing-target", join(f.exports, "done.md"));
    const result = await f.run(["--recursive"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      converted: 1,
      skipped: 1,
      failed: 0,
    });
    expect(await Bun.file(join(f.exports, "linked.md")).exists()).toBe(false);
    expect(await Bun.file(join(f.dir, "outside/source.md")).exists()).toBe(
      false,
    );
    expect(await readFile(outside.path, "utf8")).toBe(outside.raw);
    expect(await readdir(f.exports)).not.toContain("missing-target");
  },
);

test("cancelled batches publish no new files and preserve source JSON", async () => {
  const f = await fixture();
  const source = await f.put("first.json");
  const controller = new AbortController();
  controller.abort();
  await expect(
    convertAllArchives(
      resolveBatchConvertOptions({ dir: f.exports }),
      controller.signal,
    ),
  ).rejects.toThrow("Batch conversion cancelled");
  expect(await readdir(f.exports)).toEqual(["first.json"]);
  expect(await readFile(source.path, "utf8")).toBe(source.raw);
});
