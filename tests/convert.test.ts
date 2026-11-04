import { afterEach, expect, test } from "bun:test";
import {
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
import { readArchive } from "../src/archive.ts";
import { convertArchive } from "../src/convert.ts";
import { AppError } from "../src/errors.ts";
import { resolveConvertOptions } from "../src/options.ts";
import { archive } from "./fixtures/archive.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(document: unknown = archive()) {
  const dir = await mkdtemp(join(tmpdir(), "teams-convert-test-"));
  directories.push(dir);
  const input = join(dir, "history.json");
  const raw = JSON.stringify(document, null, 2);
  await writeFile(input, raw);
  return { dir, input, raw };
}

test("offline CLI converts saved JSON with no credentials or HTTP requests", async () => {
  const f = await fixture();
  const preload = join(f.dir, "offline.ts");
  await writeFile(
    preload,
    'globalThis.fetch = () => { throw new Error("Network forbidden"); };',
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      preload,
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
      "convert",
      "--input",
      "history.json",
      "--format",
      "markdown",
    ],
    {
      cwd: f.dir,
      env: {
        ...process.env,
        XDG_STATE_HOME: join(f.dir, "missing-state"),
        TZ: "Asia/Jakarta",
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
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    input: f.input,
    output: join(f.dir, "history.md"),
    format: "markdown",
    messages: 1,
  });
  const markdown = await readFile(join(f.dir, "history.md"), "utf8");
  expect(markdown).toContain("Hello **world** &amp; friends.");
  expect(markdown).toContain("Timezone: Asia/Jakarta");
  expect(markdown).toContain("**Example sender · 19:00**");
  expect(markdown).not.toContain("Message ID:");
  expect(markdown).not.toContain("Type:");
  expect(await readFile(f.input, "utf8")).toBe(f.raw);
});

test("explicit destinations create private directories and never overwrite output", async () => {
  const f = await fixture();
  const out = join(f.dir, "readable", "chat.md");
  const options = resolveConvertOptions({ input: f.input, out });
  await convertArchive(options);
  const markdown = await readFile(out, "utf8");
  if (process.platform !== "win32") {
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.dir, "readable"))).mode & 0o777).toBe(0o700);
  }
  await expect(convertArchive(options)).rejects.toThrow("already exists");
  expect(await readFile(out, "utf8")).toBe(markdown);
  expect(await readdir(join(f.dir, "readable"))).toEqual(["chat.md"]);
  expect(await readFile(f.input, "utf8")).toBe(f.raw);
});

test("the input JSON cannot be overwritten by an explicit output path", async () => {
  const f = await fixture();
  await expect(
    convertArchive(resolveConvertOptions({ input: f.input, out: f.input })),
  ).rejects.toThrow("already exists");
  expect(await readFile(f.input, "utf8")).toBe(f.raw);
});

test("reader retains unknown source and manifest fields", async () => {
  const f = await fixture();
  const result = await readArchive(f.input);
  expect(result.futureManifestField).toEqual({ preserved: true });
  expect(result.messages[0]?.futureField).toEqual({ preserved: true });
});

test.each([
  { version: 2 },
  { status: "partial" },
  { messages: [{ id: "1", originalarrivaltime: "bad-private-value" }] },
  { messages: [{ id: "1", originalarrivaltime: "2026-11-02T00:00:00Z" }] },
  { messages: [{ id: "1", originalarrivaltime: "2026-10-31T23:59:59Z" }] },
  {
    window: {
      from: "2026-11-02T00:00:00Z",
      toExclusive: "2026-11-01T00:00:00Z",
      timestampField: "originalarrivaltime",
    },
  },
  { media: { status: "unknown" } },
  { messages: null },
])(
  "invalid or unsupported archives produce no Markdown: %j",
  async (override) => {
    const f = await fixture({ ...archive(), ...override });
    const result = await convertArchive(
      resolveConvertOptions({ input: f.input }),
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AppError);
    expect(String(result)).not.toContain("bad-private-value");
    expect(await readdir(f.dir)).toEqual(["history.json"]);
    expect(await readFile(f.input, "utf8")).toBe(f.raw);
  },
);

test("malformed JSON and missing input fail without creating output", async () => {
  const f = await fixture();
  await writeFile(f.input, "{ private malformed content");
  await expect(
    convertArchive(resolveConvertOptions({ input: f.input })),
  ).rejects.toThrow("not valid JSON");
  await expect(
    convertArchive(
      resolveConvertOptions({ input: join(f.dir, "missing.json") }),
    ),
  ).rejects.toThrow("Could not read");
  expect(await readdir(f.dir)).toEqual(["history.json"]);
});

test("cancelled conversion leaves the JSON intact and publishes no Markdown", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    convertArchive(
      resolveConvertOptions({ input: f.input }),
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(await readdir(f.dir)).toEqual(["history.json"]);
  expect(await readFile(f.input, "utf8")).toBe(f.raw);
});
