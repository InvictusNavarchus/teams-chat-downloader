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

test("chats --out saves JSON without terminal messages and the same command refreshes it", async () => {
  const f = await fixture();
  const out = join(f.dir, "reference", "chats.json");
  const first = await f.run(["--out", out], directory("First name"));
  expect(first.code).toBe(0);
  const saved = await readFile(out, "utf8");
  expect(first.stdout).toContain(saved);
  expect(JSON.parse(saved)[0].label).toBe("First name");
  expect(first.stdout).toContain(`Saved chat list to ${out}.`);
  expect(first.stdout).toContain("HTTP attempts: 1 (history: 0, directory: 1");
  expect(first.stderr).toBe("");
  const refreshed = await f.run(["--out", out], directory('Updated "name" ✓'));
  expect(refreshed.code).toBe(0);
  const updated = await readFile(out, "utf8");
  expect(refreshed.stdout).toContain(updated);
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

test("plain chats still prints JSON without saving a reference file", async () => {
  const f = await fixture();
  const result = await f.run([]);
  expect(result.code).toBe(0);
  const chats = JSON.parse(result.stdout.split("\nHTTP attempts:")[0]!);
  expect(chats[0].id).toBe("synthetic-chat");
  expect(result.stdout).not.toContain("Saved chat list");
  expect(result.stdout).toContain("HTTP attempts: 1");
  expect(result.stderr).toBe("");
  expect(await Bun.file(join(f.dir, "chats.json")).exists()).toBe(false);
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
