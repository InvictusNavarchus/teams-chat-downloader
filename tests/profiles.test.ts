import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credentials } from "../src/credentials.ts";
import { createHttp, requestStats, type Fetch } from "../src/http.ts";
import { defaultProfileCachePath, resolveChatNames } from "../src/profiles.ts";
import { listChats } from "../src/teams.ts";

const credentials: Credentials = {
  version: 1,
  accountId: "fixture",
  directoryToken: "skype-secret",
  profileAuthorization: "Bearer profile-secret",
};
const now = Date.parse("2026-11-05T00:00:00Z");
const self = "8:live:self";
const personal = "8:live:other";
const org = "8:orgid:other";
const chat = (
  id: string,
  members: (string | undefined)[] = [self, personal],
) => ({
  id,
  title: null,
  label: "Unresolved one-to-one chat",
  isOneOnOne: true,
  members,
});
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "teams-profiles-test-"));
  dirs.push(dir);
  const cachePath = join(dir, "profiles.json");
  const calls: { path: string; members?: string[] }[] = [];
  const fetch: Fetch = async (request) => {
    const url = new URL(request.url);
    expect(request.redirect).toBe("manual");
    if (url.pathname.includes("/api/csa/")) {
      expect(request.headers.has("authorization")).toBe(false);
      return Response.json({
        chats: [
          {
            id: "dm",
            isOneOnOne: true,
            members: [{ mri: self }, { mri: personal }],
          },
          {
            id: "work",
            isOneOnOne: true,
            members: [{ mri: org }, { mri: self }],
          },
          {
            id: "group",
            title: "Named group",
            members: [{ mri: "8:orgid:unneeded" }],
          },
        ],
        metadata: { hasMoreChats: false, isPartialData: false },
      });
    }
    expect(request.headers.get("authorization")).toBe("Bearer profile-secret");
    expect(request.headers.get("x-skypetoken")).toBe("skype-secret");
    expect(request.headers.has("Authentication")).toBe(false);
    const path = url.pathname.split("/users/")[1]!;
    const members =
      request.method === "POST"
        ? ((await request.json()) as string[])
        : undefined;
    calls.push({ path, members });
    if (path === "me/")
      return Response.json({
        value: { mri: self, displayName: "Me", email: "must-not-cache" },
      });
    expect(request.method).toBe("POST");
    if (path === "fetchShortProfile")
      expect(url.searchParams.get("ggEnabled")).toBe("true");
    else expect(url.searchParams.get("edEnabled")).toBe("false");
    return Response.json({
      value: members!.map((mri) => ({
        mri,
        displayName: mri === personal ? "Personal name" : "Work name",
        status: 200,
        email: "must-not-cache",
      })),
    });
  };
  const stats = requestStats();
  const http = createHttp({ stats, fetch });
  return { cachePath, calls, stats, http, fetch, options: { cachePath, now } };
}

test("resolves directory counterparts in two batches, preserves titles, and persists a private token-free cache", async () => {
  const f = await fixture();
  const rows = await listChats(f.http, credentials, f.options);
  expect(rows.map((row) => row.label)).toEqual([
    "Personal name",
    "Work name",
    "Named group",
  ]);
  expect(rows[0]?.title).toBeNull();
  expect(rows[0]).not.toHaveProperty("members");
  expect(f.calls.map((call) => call.members)).toEqual([
    undefined,
    [personal],
    [org],
  ]);
  expect(f.stats).toEqual({
    total: 4,
    directory: 1,
    profiles: 3,
    media: 0,
    history: 0,
    retries: 0,
  });
  const raw = await readFile(f.cachePath, "utf8");
  expect(raw).not.toContain("secret");
  expect(raw).not.toContain("must-not-cache");
  if (process.platform !== "win32")
    expect((await stat(f.cachePath)).mode & 0o777).toBe(0o600);
  await listChats(f.http, credentials, f.options);
  expect(f.stats.total).toBe(5);
  expect(f.calls.length).toBe(3);
});

test("TTL expiry, explicit refresh and new credentials invalidate the cached snapshot", async () => {
  const f = await fixture();
  const chats = [chat("dm")];
  await resolveChatNames(f.http, credentials, chats, f.options);
  const first = f.calls.length;
  await resolveChatNames(f.http, credentials, chats, {
    ...f.options,
    now: now + 24 * 60 * 60 * 1000 - 1,
  });
  expect(f.calls.length).toBe(first);
  await resolveChatNames(f.http, credentials, chats, {
    ...f.options,
    now: now + 24 * 60 * 60 * 1000,
  });
  expect(f.calls.length).toBe(first + 2);
  await resolveChatNames(f.http, credentials, chats, {
    ...f.options,
    refresh: true,
  });
  expect(f.calls.length).toBe(first + 4);
  await resolveChatNames(
    f.http,
    { ...credentials, accountId: "another-account" },
    chats,
    f.options,
  );
  expect(f.calls.length).toBe(first + 6);
  expect(defaultProfileCachePath(credentials)).not.toBe(
    defaultProfileCachePath({ ...credentials, directoryToken: "renewed" }),
  );
  expect(defaultProfileCachePath(credentials)).not.toContain("secret");
});

test("self-chat, ambiguous members, missing MRIs and unknown families get honest labels", async () => {
  const f = await fixture();
  const warnings: string[] = [];
  const rows = await resolveChatNames(
    f.http,
    credentials,
    [
      chat("self", [self]),
      chat("ambiguous", [self, personal, org]),
      chat("missing", [self, undefined]),
      chat("unknown", [self, "8:unknown:other"]),
    ],
    { ...f.options, warn: (message) => warnings.push(message) },
  );
  expect(rows.map((row) => row.label)).toEqual([
    "Me (You)",
    ...Array(3).fill("Unresolved one-to-one chat"),
  ]);
  expect(f.calls.length).toBe(1);
  expect(warnings).toHaveLength(1);
});

test("missing authorization keeps directory listing usable and warns without profile traffic", async () => {
  const f = await fixture();
  const warnings: string[] = [];
  const rows = await listChats(
    f.http,
    { ...credentials, profileAuthorization: undefined },
    { ...f.options, warn: (message) => warnings.push(message) },
  );
  expect(rows[0]?.label).toBe("Unresolved one-to-one chat");
  expect(warnings[0]).toContain("profileAuthorization");
  expect(f.stats.total).toBe(1);
});

test("invalid cache is replaced, while unsafe cache permissions fail explicitly", async () => {
  const f = await fixture();
  await writeFile(f.cachePath, "invalid", { mode: 0o600 });
  const warnings: string[] = [];
  await resolveChatNames(f.http, credentials, [chat("dm")], {
    ...f.options,
    warn: (message) => warnings.push(message),
  });
  expect(warnings[0]).toContain("Invalid profile cache");
  expect(JSON.parse(await readFile(f.cachePath, "utf8")).version).toBe(1);
  if (process.platform !== "win32") {
    await chmod(f.cachePath, 0o644);
    await expect(
      resolveChatNames(f.http, credentials, [chat("dm")], f.options),
    ).rejects.toThrow("chmod 600");
  }
});

test.each([
  { value: [{ mri: personal, status: 404 }] },
  { value: [] },
  { value: [{ mri: personal, status: 200, displayName: " " }] },
])(
  "missing and unsuccessful individual profiles keep unresolved labels",
  async (body) => {
    const f = await fixture();
    const http = createHttp({
      stats: requestStats(),
      fetch: (request) =>
        request.method === "GET"
          ? f.fetch(request)
          : Promise.resolve(Response.json(body)),
    });
    const rows = await resolveChatNames(
      http,
      credentials,
      [chat("dm")],
      f.options,
    );
    expect(rows[0]?.label).toBe("Unresolved one-to-one chat");
  },
);

test.each([
  { value: "invalid" },
  { value: [{ mri: "unrequested", displayName: "wrong", status: 200 }] },
  {
    value: [
      { mri: personal, displayName: "first", status: 200 },
      { mri: personal, displayName: "second", status: 200 },
    ],
  },
])(
  "invalid and conflicting profile responses fail without publishing a cache",
  async (body) => {
    const f = await fixture();
    const http = createHttp({
      stats: requestStats(),
      fetch: (request) =>
        request.method === "GET"
          ? f.fetch(request)
          : Promise.resolve(Response.json(body)),
    });
    await expect(
      resolveChatNames(http, credentials, [chat("dm")], f.options),
    ).rejects.toThrow();
    expect(await Bun.file(f.cachePath).exists()).toBe(false);
  },
);

test("profile authentication failure is visible and leaves existing cached state unchanged", async () => {
  const f = await fixture();
  await resolveChatNames(f.http, credentials, [chat("dm")], f.options);
  const before = await readFile(f.cachePath, "utf8");
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async () => new Response("private secret body", { status: 401 }),
  });
  await expect(
    resolveChatNames(http, credentials, [chat("dm")], {
      ...f.options,
      refresh: true,
    }),
  ).rejects.toThrow("profiles request failed (HTTP 401)");
  expect(stats.profiles).toBe(1);
  expect(await readFile(f.cachePath, "utf8")).toBe(before);
});

test("personal lookups deduplicate and split batches at 50 without fetching group members", async () => {
  const f = await fixture();
  const chats = Array.from({ length: 51 }, (_, i) =>
    chat(String(i), [self, `8:live:${i}`]),
  );
  chats.push(chat("duplicate", [self, "8:live:0"]));
  await resolveChatNames(f.http, credentials, chats, f.options);
  expect(f.calls.map((call) => call.members?.length)).toEqual([
    undefined,
    50,
    1,
  ]);
});

test("invalid self identity fails before requesting any counterpart", async () => {
  const f = await fixture();
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async () =>
      Response.json({ value: { displayName: "Missing identity" } }),
  });
  await expect(
    resolveChatNames(http, credentials, [chat("dm")], f.options),
  ).rejects.toThrow("Self profile");
  expect(stats.profiles).toBe(1);
  expect(await Bun.file(f.cachePath).exists()).toBe(false);
});

test("cancelled profile lookup publishes no cache", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const http = createHttp({
    stats: requestStats(),
    signal: controller.signal,
    fetch: async (request) => {
      const response = await f.fetch(request);
      controller.abort();
      return response;
    },
  });
  await expect(
    resolveChatNames(http, credentials, [chat("dm")], {
      ...f.options,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(await Bun.file(f.cachePath).exists()).toBe(false);
});

test("read-only profile POST retries preserve JSON bodies and count every attempt", async () => {
  const stats = requestStats();
  const bodies: unknown[] = [];
  const http = createHttp({
    stats,
    retryDelay: () => 0,
    fetch: async (request) => {
      bodies.push(await request.json());
      return stats.total === 1
        ? new Response(null, { status: 503 })
        : Response.json({ value: [] });
    },
  });
  await http.json(
    new URL("https://teams.live.com/api/mt/beta/users/fetchShortProfile"),
    "profiles",
    {},
    () => {},
    [personal],
  );
  expect(bodies).toEqual([[personal], [personal]]);
  expect(stats.profiles).toBe(2);
  expect(stats.retries).toBe(1);
});
