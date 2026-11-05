import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { dirname, join, resolve } from "node:path";
import type { Message } from "../src/archive.ts";
import { readArchive } from "../src/archive.ts";
import { convertArchive } from "../src/convert.ts";
import type { Credentials } from "../src/credentials.ts";
import { exportChat } from "../src/export.ts";
import { createHttp, requestStats, type Fetch } from "../src/http.ts";
import {
  defaultMediaCache,
  downloadImages,
  imageUrl,
  mediaDirectory,
} from "../src/media.ts";
import { resolveExportOptions } from "../src/options.ts";
import { historyProgress } from "../src/teams.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);
const origin = "https://us-api.asm.skype.com";
const url = `${origin}/v1/objects/synthetic-object/views/imgo`;
const cookie = "media-secret";
const credentials: Credentials = {
  version: 1,
  accountId: "fixture-account",
  historyAuthentication: "history-secret",
  directoryToken: "directory-secret",
  profileAuthorization: "Bearer profile-secret",
  mediaCookies: { [origin]: cookie },
};
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
function message(
  content = `<p>Photo</p><img src="${url}" alt="A &amp; B">`,
  id = "1",
): Message {
  return {
    id,
    originalarrivaltime: "2026-11-01T12:00:00Z",
    messagetype: "RichText/Html",
    content,
    amsreferences: ["opaque-object-reference"],
  };
}
async function fixture(fetch?: Fetch) {
  const dir = await mkdtemp(join(tmpdir(), "teams-media-test-"));
  dirs.push(dir);
  const stats = requestStats();
  const http = createHttp({
    stats,
    retryDelay: () => 0,
    fetch:
      fetch ??
      (async (request) => {
        expect(request.url).toBe(url);
        expect(request.headers.get("cookie")).toBe(`skypetoken_asm=${cookie}`);
        for (const name of ["Authentication", "Authorization", "x-skypetoken"])
          expect(request.headers.has(name)).toBe(false);
        expect(request.redirect).toBe("manual");
        return new Response(png, {
          headers: {
            "content-type": "image/png",
            "last-modified": "Wed, 04 Nov 2026 00:00:00 GMT",
            etag: '"synthetic"',
          },
        });
      }),
  });
  const out = join(dir, "history", "chat.json");
  const options = { cacheRoot: join(dir, "cache") };
  return { dir, stats, http, out, options };
}

test("media cache defaults follow absolute XDG paths", () => {
  expect(defaultMediaCache({ XDG_CACHE_HOME: "/cache" }, "/home/fixture")).toBe(
    "/cache/teams-chat-download/media",
  );
  for (const value of [undefined, "", "relative"])
    expect(defaultMediaCache({ XDG_CACHE_HOME: value }, "/home/fixture")).toBe(
      "/home/fixture/.cache/teams-chat-download/media",
    );
});

test("downloads one copy per logical image, preserves source, and reuses cache with no credentials or requests", async () => {
  const f = await fixture();
  const messages = [
    message(`<IMG ALT='A &amp; B' SRC='${url}'><img src=${url}>`),
    message(undefined, "2"),
  ];
  const before = JSON.stringify(messages);
  const first = await downloadImages(
    messages,
    f.out,
    credentials,
    f.http,
    f.options,
  );
  expect(first).toMatchObject({
    status: "complete",
    downloaded: 1,
    cacheHits: 0,
    unsupported: 0,
  });
  expect(first.images).toHaveLength(2);
  expect(f.stats).toMatchObject({ total: 1, media: 1, history: 0 });
  expect(JSON.stringify(messages)).toBe(before);
  expect(await readdir(mediaDirectory(f.out))).toHaveLength(1);
  const file = join(dirname(f.out), first.images[0]!.path);
  expect(await readFile(file)).toEqual(png);
  if (process.platform !== "win32") {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(mediaDirectory(f.out))).mode & 0o777).toBe(0o700);
  }
  const accountCache = join(
    f.options.cacheRoot,
    createHash("sha256").update(credentials.accountId).digest("hex"),
  );
  const metadata = (await readdir(accountCache)).find((path) =>
    path.endsWith(".json"),
  )!;
  const raw = await readFile(join(accountCache, metadata), "utf8");
  for (const secret of [
    cookie,
    "history-secret",
    "directory-secret",
    "profile-secret",
    url,
  ])
    expect(raw).not.toContain(secret);
  const second = await downloadImages(
    messages,
    join(f.dir, "elsewhere", "overlap.json"),
    { ...credentials, mediaCookies: undefined },
    f.http,
    f.options,
  );
  expect(second).toMatchObject({ downloaded: 0, cacheHits: 1 });
  expect(f.stats.total).toBe(1);
  expect(
    await readFile(join(f.dir, "elsewhere", second.images[0]!.path)),
  ).toEqual(png);
});

test("accounts do not share image cache entries", async () => {
  const f = await fixture();
  await downloadImages([message()], f.out, credentials, f.http, f.options);
  await expect(
    downloadImages(
      [message()],
      join(f.dir, "other", "chat.json"),
      { ...credentials, accountId: "other-account", mediaCookies: undefined },
      f.http,
      f.options,
    ),
  ).rejects.toThrow("Image credentials are missing");
  expect(f.stats.total).toBe(1);
});

test.each([
  "https://attacker.invalid/v1/objects/id/views/imgo",
  "http://us-api.asm.skype.com/v1/objects/id/views/imgo",
  "https://us-api.asm.skype.com.attacker.invalid/v1/objects/id/views/imgo",
  "https://user:password@us-api.asm.skype.com/v1/objects/id/views/imgo",
  `${url}?token=secret`,
  `${url}#fragment`,
  url.replace("imgo", "video"),
])(
  "refuses unsupported image destination without network: %s",
  async (source) => {
    expect(imageUrl(source)).toBeUndefined();
    const f = await fixture(async () => {
      throw new Error("must not fetch");
    });
    const result = await downloadImages(
      [message(`<img src="${source}">`)],
      f.out,
      credentials,
      f.http,
      f.options,
    );
    expect(result).toMatchObject({
      status: "partial",
      images: [],
      unsupported: 1,
    });
    expect(f.stats.total).toBe(0);
    expect(await readdir(f.dir)).toEqual([]);
  },
);

test("supports the observed namespaced URL and reports opaque-only references without guessing", async () => {
  expect(
    imageUrl(
      "https://experimental-api.asm.skype.com/v1/namespace/objects/id/views/imgo",
    ),
  ).toBeDefined();
  const f = await fixture();
  const result = await downloadImages(
    [
      message("<p>Attachment</p>"),
      { ...message(), id: "2", messagetype: "Text" },
    ],
    f.out,
    credentials,
    f.http,
    f.options,
  );
  expect(result).toMatchObject({
    status: "partial",
    unsupported: 2,
    images: [],
  });
  expect(f.stats.total).toBe(0);
});

test("explicit refresh reuses 304 bodies and preserves the cache after failed refresh", async () => {
  const f = await fixture();
  const initial = await downloadImages(
    [message()],
    f.out,
    credentials,
    f.http,
    f.options,
  );
  const http = createHttp({
    stats: f.stats,
    fetch: async (request) => {
      expect(request.headers.get("if-none-match")).toBe('"synthetic"');
      return new Response(null, { status: 304 });
    },
  });
  const refreshed = await downloadImages(
    [message()],
    join(f.dir, "refreshed", "chat.json"),
    credentials,
    http,
    { ...f.options, refresh: true },
  );
  expect(refreshed).toMatchObject({ downloaded: 0, cacheHits: 1 });
  expect(
    await readFile(join(f.dir, "refreshed", refreshed.images[0]!.path)),
  ).toEqual(png);
  expect(f.stats.media).toBe(2);
  const failedHttp = createHttp({
    stats: f.stats,
    fetch: async () => new Response("private", { status: 401 }),
  });
  await expect(
    downloadImages(
      [message()],
      join(f.dir, "failed", "chat.json"),
      credentials,
      failedHttp,
      { ...f.options, refresh: true },
    ),
  ).rejects.toThrow("HTTP 401");
  const reused = await downloadImages(
    [message()],
    join(f.dir, "retry", "chat.json"),
    credentials,
    failedHttp,
    f.options,
  );
  expect(reused.images[0]!.sha256).toBe(initial.images[0]!.sha256);
  expect(f.stats.media).toBe(3);
});

test.each(["missing", "corrupt"])(
  "a %s cached body is fetched unconditionally",
  async (kind) => {
    const f = await fixture();
    await downloadImages([message()], f.out, credentials, f.http, f.options);
    const accountCache = join(
      f.options.cacheRoot,
      createHash("sha256").update(credentials.accountId).digest("hex"),
    );
    const body = join(
      accountCache,
      (await readdir(accountCache)).find((path) => path.endsWith(".png"))!,
    );
    if (kind === "missing") await rm(body);
    else await writeFile(body, "corrupt");
    const http = createHttp({
      stats: f.stats,
      fetch: async (request) => {
        expect(request.headers.has("if-none-match")).toBe(false);
        expect(request.headers.has("if-modified-since")).toBe(false);
        return new Response(png, { headers: { "content-type": "image/png" } });
      },
    });
    const result = await downloadImages(
      [message()],
      join(f.dir, "retry", "chat.json"),
      credentials,
      http,
      f.options,
    );
    expect(result.downloaded).toBe(1);
    expect(f.stats.media).toBe(2);
  },
);

test.each([
  {
    status: 200,
    type: "text/html",
    body: Buffer.from("<html>private login</html>"),
  },
  { status: 200, type: "image/png", body: png.subarray(0, 20) },
  { status: 200, type: "image/svg+xml", body: Buffer.from("<svg/>") },
  { status: 206, type: "image/png", body: png },
  { status: 304, type: "image/png", body: null },
  { status: 302, type: "text/html", body: null },
])(
  "invalid media responses never publish successful cache entries: %j",
  async ({ status, type, body }) => {
    const f = await fixture(
      async () =>
        new Response(body, {
          status,
          headers: {
            "content-type": type,
            location: "https://attacker.invalid",
          },
        }),
    );
    await expect(
      downloadImages([message()], f.out, credentials, f.http, f.options),
    ).rejects.toThrow();
    expect(await readdir(f.dir)).toEqual([]);
    expect(f.stats.media).toBe(1);
  },
);

test("a later media failure removes partial output and keeps earlier cached images", async () => {
  const f = await fixture(async (request) =>
    request.url === url
      ? new Response(png, { headers: { "content-type": "image/png" } })
      : new Response("private", { status: 403 }),
  );
  await expect(
    downloadImages(
      [
        message(
          `<img src="${url}"><img src="${url.replace("synthetic-object", "other-object")}">`,
        ),
      ],
      f.out,
      credentials,
      f.http,
      f.options,
    ),
  ).rejects.toThrow("HTTP 403");
  expect(await Bun.file(mediaDirectory(f.out)).exists()).toBe(false);
  const result = await downloadImages(
    [message()],
    f.out,
    { ...credentials, mediaCookies: undefined },
    f.http,
    f.options,
  );
  expect(result.cacheHits).toBe(1);
  expect(f.stats.media).toBe(2);
});

test("cancellation after receiving a body publishes no image directory", async () => {
  const controller = new AbortController();
  const f = await fixture(async () => {
    controller.abort();
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  await expect(
    downloadImages([message()], f.out, credentials, f.http, {
      ...f.options,
      signal: controller.signal,
    }),
  ).rejects.toThrow("cancelled");
  expect(await readdir(f.dir)).not.toContain("history");
});

test("media shares HTTP retries, accounting, and body deadlines", async () => {
  const f = await fixture();
  const http = createHttp({
    stats: f.stats,
    retryDelay: () => 0,
    fetch: async () =>
      f.stats.media === 1
        ? new Response("temporary", { status: 503 })
        : new Response(png, { headers: { "content-type": "image/png" } }),
  });
  await downloadImages([message()], f.out, credentials, http, f.options);
  expect(f.stats).toMatchObject({ total: 2, media: 2, retries: 1 });
  const slow = createHttp({
    stats: requestStats(),
    totalTimeoutMs: 25,
    timeoutMs: 25,
    retryLimit: 0,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(png.subarray(0, 8));
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
  });
  await expect(slow.image(new URL(url), {}, () => {})).rejects.toThrow(
    "time budget",
  );
});

test("export saves portable images, offline conversion rebases links, and --no-media skips requests", async () => {
  const f = await fixture();
  const oldCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = f.options.cacheRoot;
  try {
    const http = createHttp({
      stats: f.stats,
      fetch: async (request) => {
        if (new URL(request.url).origin === origin)
          return new Response(png, {
            headers: { "content-type": "image/png" },
          });
        expect(request.headers.has("cookie")).toBe(false);
        return Response.json({ messages: [message()], _metadata: {} });
      },
    });
    const options = resolveExportOptions({
      chat: "fixture",
      out: dirname(f.out),
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-02T00:00:00Z",
    });
    const events: unknown[] = [];
    const result = await exportChat(
      options,
      credentials,
      http,
      f.stats,
      historyProgress(),
      undefined,
      (event) => events.push(event),
    );
    expect(events).toEqual([
      {
        type: "history",
        page: 1,
        pageMessages: 1,
        totalMessages: 1,
        earliestTimestamp: "2026-11-01T12:00:00Z",
        hasMore: false,
      },
      { type: "media-start", total: 1 },
      { type: "media-progress", current: 1, total: 1, cached: false },
      { type: "save", format: "json", destination: result.output },
      { type: "convert", format: "markdown", destination: result.markdown },
    ]);
    const archive = await readArchive(result.output);
    expect(archive.media.status).toBe("complete");
    if (archive.media.status === "not-downloaded")
      throw new Error("images missing");
    const image = archive.media.images[0]!;
    expect(image.path).toBe(`media/${image.key}.png`);
    expect((await readdir(dirname(result.output))).sort()).toEqual([
      "chat.json",
      "chat.md",
      "media",
    ]);
    expect(archive.messages[0]!.content).toBe(message().content);
    expect(await readFile(result.markdown!, "utf8")).toContain(
      `![A &amp; B](${image.path})`,
    );
    const converted = await convertArchive({
      input: result.output,
      out: join(dirname(f.out), "readable", "moved.md"),
      format: "markdown",
    });
    expect(await readFile(converted.output, "utf8")).toContain(
      `](../${image.path})`,
    );
    expect(archive.requests).toMatchObject({ history: 1, media: 1, total: 2 });
    const skipped = await exportChat(
      { ...options, media: false, out: join(f.dir, "text") },
      { ...credentials, mediaCookies: undefined },
      http,
      f.stats,
      historyProgress(),
    );
    expect((await readArchive(skipped.output)).media.status).toBe(
      "not-downloaded",
    );
    expect(await readFile(skipped.markdown!, "utf8")).toContain(
      "Image not downloaded",
    );
    expect(f.stats.media).toBe(1);
    expect(dirname(converted.output)).toBe(join(dirname(f.out), "readable"));
    const raceDirectory = join(f.dir, "race");
    const raceOutput = join(raceDirectory, "chat.json");
    const raceHttp = createHttp({
      stats: f.stats,
      fetch: async () => {
        await mkdir(raceDirectory);
        await writeFile(raceOutput, "another export won");
        return Response.json({ messages: [message()], _metadata: {} });
      },
    });
    await expect(
      exportChat(
        { ...options, out: raceDirectory },
        credentials,
        raceHttp,
        f.stats,
        historyProgress(),
      ),
    ).rejects.toThrow("already exists");
    expect(await readFile(raceOutput, "utf8")).toBe("another export won");
    expect(await readdir(raceDirectory)).toEqual(["chat.json"]);
    const failedDirectory = join(f.dir, "failed-export");
    const rejectedHttp = createHttp({
      stats: f.stats,
      fetch: async (request) =>
        new URL(request.url).origin === origin
          ? new Response("private", { status: 403 })
          : Response.json({
              messages: [
                message(
                  message()
                    .content!.toString()
                    .replace("synthetic-object", "uncached-object"),
                ),
              ],
              _metadata: {},
            }),
    });
    await expect(
      exportChat(
        { ...options, out: failedDirectory },
        credentials,
        rejectedHttp,
        f.stats,
        historyProgress(),
      ),
    ).rejects.toThrow("HTTP 403");
    expect(await readdir(f.dir)).not.toContain("failed-export");
    expect(await readFile(result.output, "utf8")).toContain(
      '"status": "complete"',
    );
    for (const path of [
      "../media/",
      "/media/",
      "media/../",
      "history.json.media/",
    ]) {
      const invalid = {
        ...archive,
        media: {
          ...archive.media,
          images: [{ ...image, path: `${path}${image.key}.png` }],
        },
      };
      const input = join(f.dir, "invalid.json");
      await writeFile(input, JSON.stringify(invalid));
      await expect(readArchive(input)).rejects.toThrow("Version 1 JSON export");
    }
    if (process.platform !== "win32") {
      const special = await exportChat(
        { ...options, out: join(f.dir, "chat (offline):photo") },
        credentials,
        http,
        f.stats,
        historyProgress(),
      );
      const content = await readFile(special.markdown!, "utf8");
      const destination = content.match(/!\[A &amp; B\]\(([^)]+)\)/)![1]!;
      expect(
        await readFile(
          resolve(dirname(special.markdown!), decodeURIComponent(destination)),
        ),
      ).toEqual(png);
    }
  } finally {
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
  }
});
