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
import { dirname, join } from "node:path";
import { downloadArchiveMedia } from "../src/archive-media.ts";
import { readArchive, type Message } from "../src/archive.ts";
import { convertArchive } from "../src/convert.ts";
import type { Credentials } from "../src/credentials.ts";
import { exportChat } from "../src/export.ts";
import { createHttp, requestStats, type Fetch } from "../src/http.ts";
import { resolveExportOptions, resolveMediaOptions } from "../src/options.ts";
import { updateExport, writeExport } from "../src/output.ts";
import { historyProgress } from "../src/teams.ts";
import { archive } from "./fixtures/archive.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);
const gif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const origin = "https://us-api.asm.skype.com";
const credentials: Credentials = {
  version: 1,
  accountId: "fixture",
  historyAuthentication: "fixture-history",
  mediaCookies: { [origin]: "fixture-media" },
};
const image = (id: string): Message => ({
  id,
  originalarrivaltime: "2026-11-01T12:00:00Z",
  messagetype: "RichText/Html",
  content: `<p>Saved text ${id}</p><img src="${origin}/v1/objects/${id}/views/imgo">`,
  unknownField: { retained: true },
});
const directories: string[] = [];
const previousCache = process.env.XDG_CACHE_HOME;
afterEach(async () => {
  if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = previousCache;
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(messages = [image("one")], fetch?: Fetch) {
  const dir = await mkdtemp(join(tmpdir(), "teams-archive-media-test-"));
  directories.push(dir);
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  const input = join(dir, "saved", "chat.json");
  await writeExport(input, archive(messages));
  const converted = await convertArchive({ input, format: "markdown" });
  const stats = requestStats();
  const http = createHttp({
    stats,
    retryLimit: 0,
    fetch:
      fetch ??
      (async (request) => {
        expect(new URL(request.url).origin).toBe(origin);
        return new Response(png, { headers: { "content-type": "image/png" } });
      }),
  });
  const options = resolveMediaOptions({ input });
  return { dir, input, markdown: converted.output, stats, http, options };
}

test("JSON and readable Markdown exist before the first media request", async () => {
  const f = await fixture();
  const out = join(f.dir, "export", "chat.json");
  const markdown = join(dirname(out), "chat.md");
  const http = createHttp({
    stats: f.stats,
    fetch: async (request) => {
      if (new URL(request.url).origin !== origin)
        return Response.json({ messages: [image("one")], _metadata: {} });
      const saved = await readArchive(out);
      expect(saved.media.status).toBe("not-downloaded");
      expect(saved.messages[0]!.unknownField).toEqual({ retained: true });
      const text = await readFile(markdown, "utf8");
      expect(text).toContain("Saved text one");
      expect(text).toContain("Image not downloaded");
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
  });
  await exportChat(
    resolveExportOptions({
      chat: "fixture",
      out: dirname(out),
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-02T00:00:00Z",
    }),
    credentials,
    http,
    f.stats,
    historyProgress(),
  );
  expect((await readArchive(out)).media.status).toBe("complete");
  expect(await readFile(markdown, "utf8")).toContain("](media/");
  expect(f.stats).toMatchObject({ history: 1, media: 1 });
});

test("media authentication failure preserves text, and saved history can be retried", async () => {
  const f = await fixture();
  const out = join(f.dir, "export", "chat.json");
  const http = createHttp({
    stats: f.stats,
    fetch: async () =>
      Response.json({ messages: [image("one")], _metadata: {} }),
  });
  await expect(
    exportChat(
      resolveExportOptions({
        chat: "fixture",
        out: dirname(out),
        from: "2026-11-01T00:00:00Z",
        to: "2026-11-02T00:00:00Z",
      }),
      { ...credentials, mediaCookies: undefined },
      http,
      f.stats,
      historyProgress(),
    ),
  ).rejects.toThrow("Saved chat text kept");
  const saved = await readArchive(out);
  expect(saved.media.status).toBe("not-downloaded");
  expect(await readFile(join(dirname(out), "chat.md"), "utf8")).toContain(
    "Saved text one",
  );
  expect(f.stats).toMatchObject({ history: 1, media: 0 });
  const result = await downloadArchiveMedia(
    { ...f.options, input: out },
    credentials,
    f.http,
    f.stats,
  );
  const updated = await readArchive(result.output);
  expect(updated.media.status).toBe("complete");
  expect(updated.messages).toEqual(saved.messages);
  expect(updated.history).toEqual(saved.history);
  expect(updated.completedAt).toBe(saved.completedAt);
  expect(updated.requests).toMatchObject({ history: 1, media: 1, total: 2 });
  expect(f.stats.history).toBe(1);
});

test("failed and cancelled media passes preserve text and reuse completed images on retry", async () => {
  let fail = true;
  const f = await fixture([image("one"), image("two")], async (request) =>
    fail && request.url.includes("/two/")
      ? new Response("private", { status: 403 })
      : new Response(png, { headers: { "content-type": "image/png" } }),
  );
  const raw = await readFile(f.input, "utf8");
  const text = await readFile(f.markdown, "utf8");
  await expect(
    downloadArchiveMedia(f.options, credentials, f.http, f.stats),
  ).rejects.toThrow("HTTP 403");
  expect(await readFile(f.input, "utf8")).toBe(raw);
  expect(await readFile(f.markdown, "utf8")).toBe(text);
  expect(await readdir(dirname(f.input))).not.toContain("chat.json.media.lock");
  expect(await readdir(join(dirname(f.input), "media"))).toHaveLength(1);

  const controller = new AbortController();
  await expect(
    downloadArchiveMedia(
      f.options,
      credentials,
      f.http,
      f.stats,
      controller.signal,
      (event) => {
        if (event.type === "media-progress") controller.abort();
      },
    ),
  ).rejects.toThrow("cancelled");
  expect(await readFile(f.input, "utf8")).toBe(raw);
  expect(await readFile(f.markdown, "utf8")).toBe(text);
  expect(f.stats.media).toBe(2);
  fail = false;
  await downloadArchiveMedia(f.options, credentials, f.http, f.stats);
  const updated = await readArchive(f.input);
  expect(updated.media).toMatchObject({
    status: "complete",
    downloaded: 1,
    cacheHits: 1,
  });
  expect(updated.futureManifestField).toEqual({ preserved: true });
  expect(f.stats).toMatchObject({ history: 0, media: 3 });
});

test("a failed refresh leaves previous manifests and image bytes valid", async () => {
  let refresh = false;
  const f = await fixture([image("one"), image("two")], async (request) => {
    if (refresh && request.url.includes("/two/"))
      return new Response("private", { status: 403 });
    return new Response(refresh ? gif : png, {
      headers: { "content-type": refresh ? "image/gif" : "image/png" },
    });
  });
  await downloadArchiveMedia(f.options, credentials, f.http, f.stats);
  const raw = await readFile(f.input, "utf8");
  const text = await readFile(f.markdown, "utf8");
  const before = await readArchive(f.input);
  refresh = true;
  await expect(
    downloadArchiveMedia(
      { ...f.options, refreshMedia: true },
      credentials,
      f.http,
      f.stats,
    ),
  ).rejects.toThrow("HTTP 403");
  expect(await readFile(f.input, "utf8")).toBe(raw);
  expect(await readFile(f.markdown, "utf8")).toBe(text);
  if (before.media.status === "not-downloaded")
    throw new Error("Missing images");
  for (const entry of before.media.images)
    expect(await readFile(join(dirname(f.input), entry.path))).toEqual(png);
  await downloadArchiveMedia(f.options, credentials, f.http, f.stats);
  const after = await readArchive(f.input);
  expect(after.media).toMatchObject({ cacheHits: 2, downloaded: 0 });
  if (after.media.status === "not-downloaded")
    throw new Error("Missing images");
  expect(
    await readFile(join(dirname(f.input), after.media.images[0]!.path)),
  ).toEqual(gif);
});

test("concurrent media updates are refused until the current pass releases its lock", async () => {
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const f = await fixture(undefined, async () => {
    entered.resolve();
    return response.promise;
  });
  const first = downloadArchiveMedia(f.options, credentials, f.http, f.stats);
  await entered.promise;
  try {
    await expect(
      downloadArchiveMedia(f.options, credentials, f.http, f.stats),
    ).rejects.toThrow("already running");
  } finally {
    response.resolve(
      new Response(png, { headers: { "content-type": "image/png" } }),
    );
    await first;
  }
  await downloadArchiveMedia(f.options, credentials, f.http, f.stats);
  expect(f.stats.media).toBe(1);
});

test.each([
  { accountId: "different-account" },
  { accountId: undefined },
  { requests: { total: -1 } },
  { version: 2 },
])(
  "invalid archives and account mismatches fail before HTTP: %j",
  async (override) => {
    const f = await fixture();
    await writeFile(
      f.input,
      JSON.stringify({ ...archive([image("one")]), ...override }),
    );
    const raw = await readFile(f.input, "utf8");
    await expect(
      downloadArchiveMedia(f.options, credentials, f.http, f.stats),
    ).rejects.toThrow();
    expect(f.stats.total).toBe(0);
    expect(await readFile(f.input, "utf8")).toBe(raw);
    expect((await readdir(dirname(f.input))).sort()).toEqual([
      "chat.json",
      "chat.md",
    ]);
  },
);

test("--no-markdown preserves existing Markdown and cancelled atomic updates keep JSON", async () => {
  const f = await fixture();
  await writeFile(f.markdown, "User-edited Markdown");
  await downloadArchiveMedia(
    { ...f.options, markdown: false },
    credentials,
    f.http,
    f.stats,
  );
  expect(await readFile(f.markdown, "utf8")).toBe("User-edited Markdown");
  const raw = await readFile(f.input, "utf8");
  await expect(
    updateExport(f.input, archive(), AbortSignal.abort()),
  ).rejects.toThrow("cancelled");
  expect(await readFile(f.input, "utf8")).toBe(raw);
  expect(await readdir(dirname(f.input))).not.toContain("chat.json.media.lock");
  expect(
    (await readdir(dirname(f.input))).some((name) => name.endsWith(".tmp")),
  ).toBe(false);
});

test("Markdown write failure keeps the updated JSON and supports a cached retry", async () => {
  const f = await fixture();
  await rm(f.markdown);
  await mkdir(f.markdown);
  await writeFile(join(f.markdown, "keep.txt"), "keep me");
  await expect(
    downloadArchiveMedia(f.options, credentials, f.http, f.stats),
  ).rejects.toThrow("Media manifest saved");
  expect((await readArchive(f.input)).media.status).toBe("complete");
  expect(await readFile(join(f.markdown, "keep.txt"), "utf8")).toBe("keep me");
  await rm(f.markdown, { recursive: true });
  await downloadArchiveMedia(f.options, credentials, f.http, f.stats);
  expect(await readFile(f.markdown, "utf8")).toContain("](media/");
  expect(f.stats.media).toBe(1);
});

test.skipIf(process.platform === "win32")(
  "media updates refuse a symlinked media directory",
  async () => {
    const f = await fixture();
    const elsewhere = join(f.dir, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "keep.txt"), "keep me");
    await symlink(elsewhere, join(dirname(f.input), "media"));
    const raw = await readFile(f.input, "utf8");
    await expect(
      downloadArchiveMedia(f.options, credentials, f.http, f.stats),
    ).rejects.toThrow("symbolic links are refused");
    expect(await readFile(f.input, "utf8")).toBe(raw);
    expect(await readdir(elsewhere)).toEqual(["keep.txt"]);
    expect(await readFile(join(elsewhere, "keep.txt"), "utf8")).toBe("keep me");
  },
);
