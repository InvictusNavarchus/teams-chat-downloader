import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  discoverSmokeFixture,
  sampleSmokeImage,
} from "../src/smoke-targets.ts";

const accountId = createHash("sha256").update("8:live:self").digest("hex");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "teams-target-discovery-"));
  roots.push(root);
  return root;
}
async function archive(
  root: string,
  name: string,
  settings: { modified?: number; rich?: boolean; account?: string } = {},
) {
  const path = join(root, name);
  await mkdir(dirname(path), { recursive: true });
  const content = {
    version: 1,
    status: "complete",
    chatId: name,
    accountId: settings.account ?? accountId,
    window: {
      from: "2026-08-01T00:00:00Z",
      toExclusive: "2026-08-08T00:00:00Z",
      timestampField: "originalarrivaltime",
    },
    media: { status: "not-downloaded" },
    messages:
      settings.rich === false
        ? []
        : [
            {
              id: "fixture",
              originalarrivaltime: "2026-08-03T00:00:00Z",
              from: "8:live:other",
              messagetype: "RichText/Html",
              content:
                '<img src="https://us-api.asm.skype.com/v1/objects/known/views/imgo">',
            },
          ],
  };
  await writeFile(path, JSON.stringify(content), { mode: 0o600 });
  await utimes(path, settings.modified ?? 100, settings.modified ?? 100);
  return path;
}

test("discovery prefers usable same-account targets over newer sparse, unrelated or invalid archives", async () => {
  const root = await temporary();
  const chosen = await archive(root, "older/chat.json", { modified: 100 });
  const before = await readFile(chosen, "utf8");
  await archive(root, "newer/chat.json", { rich: false, modified: 200 });
  await archive(root, "unrelated.json", {
    account: "another-account",
    modified: 300,
  });
  await writeFile(join(root, "invalid.json"), "malformed-with-private-content");
  const logs: string[] = [];
  const result = await discoverSmokeFixture(root, accountId, {
    log: (message) => logs.push(message),
  });
  expect(result?.path).toBe(chosen);
  expect(result?.archive.accountId).toBe(accountId);
  expect(await readFile(chosen, "utf8")).toBe(before);
  expect(logs.some((line) => line.includes("skipped 1"))).toBe(true);
  expect(logs.join("\n")).not.toContain("private-content");
});

test("smoke sampling retains a regional source URL for the real media adapter", async () => {
  const source =
    "https://id-prod.asyncgw.teams.microsoft.com/v1/objects/known/views/imgo";
  const sample = await sampleSmokeImage([
    {
      id: "regional",
      originalarrivaltime: "2026-08-03T00:00:00Z",
      messagetype: "RichText/Html",
      content: `<img src="${source}"><img src="https://external.invalid/private">`,
    },
  ]);
  expect(sample?.content).toBe(`<img src="${source}">`);
});

test("discovery uses modification time and deterministic path order among equally useful archives", async () => {
  const root = await temporary();
  await archive(root, "old.json", { modified: 100 });
  const chosen = await archive(root, "a/chat.json", { modified: 200 });
  await archive(root, "z.JSON", { modified: 200 });
  expect((await discoverSmokeFixture(root, accountId))?.path).toBe(chosen);
});

test("discovery scans only regular root JSON files and direct export folders, ignoring symlinks", async () => {
  const root = await temporary();
  const outside = await temporary();
  const outsideArchive = await archive(outside, "chat.json", { modified: 300 });
  const fallback = await archive(root, "local.json", { rich: false });
  await archive(root, "nested/deep/chat.json", { modified: 400 });
  await symlink(outsideArchive, join(root, "linked.json"));
  await symlink(outside, join(root, "linked-folder"));
  await mkdir(join(root, "linked-file"));
  await symlink(outsideArchive, join(root, "linked-file/chat.json"));
  expect((await discoverSmokeFixture(root, accountId))?.path).toBe(fallback);
  expect(
    await discoverSmokeFixture(join(root, "linked-folder"), accountId),
  ).toBeUndefined();
});

test("missing or non-matching exports leave discovery empty rather than switching accounts", async () => {
  const root = await temporary();
  expect(
    await discoverSmokeFixture(join(root, "missing"), accountId),
  ).toBeUndefined();
  await archive(root, "other.json", { account: "another-account" });
  expect(await discoverSmokeFixture(root, accountId)).toBeUndefined();
});

test("cancellation and non-directory roots leave live probes available", async () => {
  const root = await temporary();
  const path = await archive(root, "chat.json");
  expect(
    await discoverSmokeFixture(root, accountId, {
      signal: AbortSignal.abort(),
    }),
  ).toBeUndefined();
  const logs: string[] = [];
  expect(
    await discoverSmokeFixture(path, accountId, {
      log: (message) => logs.push(message),
    }),
  ).toBeUndefined();
  expect(logs.some((line) => line.includes("not a regular directory"))).toBe(
    true,
  );
});
