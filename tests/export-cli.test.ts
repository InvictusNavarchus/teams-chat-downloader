import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directories: string[] = [];

function readSummary(stdout: string) {
  const line = stdout.split("\n").find((line) => line.startsWith("{"));
  expect(line).toBeDefined();
  return JSON.parse(line!);
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture({
  directoryToken = true,
  profileAuthorization = false,
  media = false,
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "teams-export-cli-test-"));
  directories.push(dir);
  const credentials = join(dir, "credentials.json");
  await writeFile(
    credentials,
    JSON.stringify({
      version: 1,
      accountId: "fixture",
      historyAuthentication: "fixture-history",
      ...(media
        ? { mediaCookies: { "https://us-api.asm.skype.com": "fixture-media" } }
        : {}),
      ...(directoryToken ? { directoryToken: "fixture-directory" } : {}),
      ...(profileAuthorization
        ? { profileAuthorization: "Bearer fixture-profile" }
        : {}),
    }),
    { mode: 0o600 },
  );
  const responses = join(dir, "responses.json");
  const preload = join(dir, "offline.ts");
  await writeFile(
    preload,
    `
    const fixtures = await Bun.file(process.env.EXPORT_FIXTURES).json();
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/users/me")) return Response.json(fixtures.directory, { status: fixtures.directoryStatus });
      if (url.pathname.endsWith("/messages")) {
        const chat = decodeURIComponent(url.pathname.split("/").at(-2));
        if (chat !== fixtures.expectedChat) throw new Error("History requested the wrong chat");
        const index = Number(url.searchParams.get("fixturePage") ?? 0);
        const messages = fixtures.historyPages?.[index] ?? fixtures.messages;
        const next = fixtures.historyPages && index + 1 < fixtures.historyPages.length;
        url.searchParams.set("fixturePage", String(index + 1));
        return Response.json({ messages, _metadata: next ? { backwardLink: url.href } : {} }, { status: fixtures.historyStatus });
      }
      if (url.origin === "https://us-api.asm.skype.com" && url.pathname === "/v1/objects/fixture-image/views/imgo") {
        if (fixtures.imageStatus === 304) {
          if (input.headers.get("if-none-match") !== '"fixture-image"') throw new Error("Expected conditional image request");
          return new Response(null, { status: 304 });
        }
        return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=", "base64"), {
          status: fixtures.imageStatus,
          headers: { "content-type": "image/png", etag: '"fixture-image"' },
        });
      }
      if (url.pathname.endsWith("/me/")) return Response.json({ value: { mri: "8:live:self", displayName: "Me" } });
      if (url.pathname.endsWith("/fetchShortProfile")) {
        const members = await input.clone().json();
        if (JSON.stringify(members) !== JSON.stringify(["8:live:other"])) throw new Error("Unexpected profile lookup");
        return Response.json({ value: [{ mri: "8:live:other", displayName: "Jane Doe", status: 200 }] });
      }
      throw new Error("Unexpected fixture URL");
    };
  `,
  );
  async function run(
    args: string[],
    {
      chats = [
        { id: "fixture", title: "Café / Project Alpha", isOneOnOne: false },
      ],
      directoryStatus = 200,
      historyStatus = 200,
      messages = [],
      historyPages,
      imageStatus = 200,
      command = "export",
      expectedChat = "fixture",
    }: {
      chats?: unknown[];
      directoryStatus?: number;
      historyStatus?: number;
      messages?: unknown[];
      historyPages?: unknown[][];
      imageStatus?: number;
      command?: "export" | "media";
      expectedChat?: string;
    } = {},
  ) {
    await writeFile(
      responses,
      JSON.stringify({
        directory: {
          chats,
          metadata: { hasMoreChats: false, isPartialData: false },
        },
        directoryStatus,
        historyStatus,
        messages,
        historyPages,
        imageStatus,
        expectedChat,
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        command,
        "--credentials",
        credentials,
        ...(command === "export" &&
        !args.includes("--chat-label") &&
        !args.includes("--chat")
          ? ["--chat", "fixture"]
          : []),
        ...args,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          EXPORT_FIXTURES: responses,
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

test("export selects a group label case-insensitively and reuses it for naming", async () => {
  const f = await fixture();
  const chat = "19:opaque-long-group-id@thread.v2";
  const result = await f.run(
    ["--chat-label", "  CAFÉ / project alpha  ", "--last", "1d"],
    {
      chats: [{ id: chat, title: "Café / Project Alpha", isOneOnOne: false }],
      expectedChat: chat,
    },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const summary = readSummary(result.stdout);
  expect(basename(dirname(summary.output))).toStartWith(
    "cafe-project-alpha--last-1d--",
  );
  const archive = JSON.parse(await readFile(summary.output, "utf8"));
  expect(archive.chatId).toBe(chat);
  expect(archive.requests).toMatchObject({
    total: 2,
    directory: 1,
    history: 1,
    profiles: 0,
  });
});

test("export selects an untitled direct chat by its resolved participant label with --out", async () => {
  const f = await fixture({ profileAuthorization: true });
  const chats = [
    {
      id: "fixture",
      title: null,
      isOneOnOne: true,
      members: [{ mri: "8:live:self" }, { mri: "8:live:other" }],
    },
  ];
  for (const [out, profiles] of [
    ["cold", 2],
    ["warm", 0],
  ] as const) {
    const result = await f.run(
      ["--chat-label", "jane doe", "--last", "1d", "--out", out],
      { chats },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const summary = readSummary(result.stdout);
    expect(summary.output).toBe(join(f.dir, out, "chat.json"));
    const archive = JSON.parse(await readFile(summary.output, "utf8"));
    expect(archive.chatId).toBe("fixture");
    expect(archive.requests).toMatchObject({
      total: 2 + profiles,
      directory: 1,
      history: 1,
      profiles,
    });
  }
});

test("duplicate labels report matching IDs without fetching history or writing an export", async () => {
  const f = await fixture();
  const result = await f.run(
    ["--chat-label", "project alpha", "--last", "1d"],
    {
      chats: [
        { id: "group-a", title: "Project Alpha", isOneOnOne: false },
        { id: "group-b", title: "PROJECT ALPHA", isOneOnOne: false },
      ],
    },
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Multiple chats match --chat-label");
  expect(result.stderr).toContain('"Project Alpha": "group-a"');
  expect(result.stderr).toContain('"PROJECT ALPHA": "group-b"');
  expect(result.stdout).toContain("history: 0, directory: 1");
  expect(await readdir(f.dir)).not.toContain("exports");
});

test("partial label matches fail with guidance before fetching history", async () => {
  const f = await fixture();
  const result = await f.run([
    "--chat-label",
    "Project",
    "--last",
    "1d",
    "--out",
    "missing",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("No chat matches --chat-label");
  expect(result.stderr).toContain("--refresh-names");
  expect(result.stdout).toContain("history: 0, directory: 1");
  expect(await readdir(f.dir)).not.toContain("missing");
});

test.each(["Untitled chat", "UNRESOLVED ONE-TO-ONE CHAT"])(
  "generic label %s cannot select a chat",
  async (label) => {
    const f = await fixture();
    const result = await f.run(["--chat-label", label, "--last", "1d"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "Generic fallback labels cannot select a chat",
    );
    expect(result.stdout).not.toContain("HTTP attempts:");
    expect(await readdir(f.dir)).not.toContain("exports");
  },
);

test("label selection requires directory credentials even with an explicit output folder", async () => {
  const f = await fixture({ directoryToken: false });
  const result = await f.run([
    "--chat-label",
    "Project Alpha",
    "--last",
    "1d",
    "--out",
    "custom",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Credential file lacks directoryToken");
  expect(result.stdout).not.toContain("HTTP attempts:");
  expect(await readdir(f.dir)).not.toContain("custom");
});

test("conflicting chat selectors fail before any HTTP requests", async () => {
  const f = await fixture();
  const result = await f.run([
    "--chat",
    "fixture",
    "--chat-label",
    "Project Alpha",
    "--last",
    "1d",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "Choose exactly one of --chat <id> or --chat-label <label>",
  );
  expect(result.stdout).not.toContain("HTTP attempts:");
});

test("export accepts page delay flags and retrieves multiple history pages", async () => {
  const f = await fixture();
  const result = await f.run(
    [
      "--from",
      "2026-11-01T00:00:00Z",
      "--to",
      "2026-11-02T00:00:00Z",
      "--out",
      "paced",
      "--page-delay-min",
      "0.04",
      "--page-delay-max",
      "0.08",
      "--no-media",
    ],
    {
      historyPages: [
        [{ id: "1", originalarrivaltime: "2026-11-01T12:00:00Z" }],
        [{ id: "2", originalarrivaltime: "2026-11-01T11:00:00Z" }],
      ],
    },
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(readSummary(result.stdout).messages).toBe(2);
  expect(result.stdout).toContain("[history] Page 2:");
  expect(result.stdout).toContain("HTTP attempts: 2 (history: 2, directory: 0");
});

test("export rejects reversed page delay bounds before making requests", async () => {
  const f = await fixture();
  const result = await f.run([
    "--last",
    "7d",
    "--page-delay-min",
    "6",
    "--page-delay-max",
    "3",
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(
    "--page-delay-min must not exceed --page-delay-max",
  );
  expect(result.stdout).not.toContain("HTTP attempts:");
  expect(await readdir(f.dir)).not.toContain("exports");
});

test("export without --out publishes a label-based export folder and reports the saved path", async () => {
  const f = await fixture();
  const result = await f.run(["--last", "1d"]);
  expect(result.code).toBe(0);
  const summary = readSummary(result.stdout);
  expect(result.stdout).toContain(
    "[history] Page 1: 0 messages (total: 0) (history complete)",
  );
  expect(result.stdout).toContain("[export] Saved JSON archive:");
  expect(result.stdout).toContain("[convert] Converted to Markdown.");
  expect(result.stdout).toContain(
    "Images: 0 reused from local cache, 0 revalidated with Teams (HTTP 304), 0 downloaded (HTTP 200)",
  );
  expect(result.stdout).toContain("HTTP attempts: 2 (history: 1, directory: 1");
  expect(result.stderr).toBe("");
  expect(basename(summary.output)).toBe("chat.json");
  expect(summary.markdown).toBe(join(dirname(summary.output), "chat.md"));
  expect((await readdir(dirname(summary.output))).sort()).toEqual([
    "chat.json",
    "chat.md",
  ]);
  expect(basename(dirname(summary.output))).toMatch(
    /^cafe-project-alpha--last-1d--to-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
  );
  expect(summary.messages).toBe(0);
  const document = JSON.parse(await readFile(summary.output, "utf8"));
  expect(document.status).toBe("complete");
  expect(basename(dirname(summary.output))).toContain(
    document.window.toExclusive.replace(/[:.]/g, "-"),
  );
  expect(document.requests).toMatchObject({
    total: 2,
    directory: 1,
    history: 1,
    profiles: 0,
  });
});

test("media logs distinguish local reuse, HTTP 304 revalidation, and HTTP 200 downloads", async () => {
  const f = await fixture({ media: true });
  const messages = [
    {
      id: "image-message",
      originalarrivaltime: "2026-11-01T12:00:00Z",
      messagetype: "RichText/Html",
      content:
        '<img src="https://us-api.asm.skype.com/v1/objects/fixture-image/views/imgo">',
    },
  ];
  for (const scenario of [
    {
      name: "cold",
      refresh: false,
      status: 200,
      outcome: "downloaded: HTTP 200",
      local: 0,
      revalidated: 0,
      downloaded: 1,
      requests: 1,
    },
    {
      name: "warm",
      refresh: false,
      status: 401,
      outcome: "reused from local cache",
      local: 1,
      revalidated: 0,
      downloaded: 0,
      requests: 0,
    },
    {
      name: "revalidated",
      refresh: true,
      status: 304,
      outcome: "revalidated with Teams: HTTP 304; reused cached bytes",
      local: 0,
      revalidated: 1,
      downloaded: 0,
      requests: 1,
    },
    {
      name: "replaced",
      refresh: true,
      status: 200,
      outcome: "downloaded: HTTP 200",
      local: 0,
      revalidated: 0,
      downloaded: 1,
      requests: 1,
    },
  ]) {
    const result = await f.run(
      [
        "--from",
        "2026-11-01T00:00:00Z",
        "--to",
        "2026-11-02T00:00:00Z",
        "--out",
        scenario.name,
        ...(scenario.refresh ? ["--refresh-media"] : []),
      ],
      { messages, imageStatus: scenario.status },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`[media] Image 1/1 (${scenario.outcome})`);
    expect(result.stdout).toContain(
      `Images: ${scenario.local} reused from local cache, ${scenario.revalidated} revalidated with Teams (HTTP 304), ${scenario.downloaded} downloaded (HTTP 200), 0 unfinished; unsupported media references: 0.`,
    );
    expect(result.stdout).toContain(`media: ${scenario.requests}); retries: 0`);
    const archive = JSON.parse(
      await readFile(readSummary(result.stdout).output, "utf8"),
    );
    expect(archive.requests.media).toBe(scenario.requests);
    expect(archive.media).toMatchObject({
      cacheHits: scenario.local + scenario.revalidated,
      downloaded: scenario.downloaded,
    });
  }
});

test("media command enriches a text-only archive, reuses cache, and never fetches history", async () => {
  const f = await fixture({ media: true });
  const result = await f.run(
    [
      "--from",
      "2026-11-01T00:00:00Z",
      "--to",
      "2026-11-02T00:00:00Z",
      "--out",
      "later",
      "--no-media",
    ],
    {
      messages: [
        {
          id: "image-message",
          originalarrivaltime: "2026-11-01T12:00:00Z",
          messagetype: "RichText/Html",
          content:
            '<p>Text first</p><img src="https://us-api.asm.skype.com/v1/objects/fixture-image/views/imgo">',
        },
      ],
    },
  );
  expect(result.code).toBe(0);
  const saved = readSummary(result.stdout);
  expect(await readFile(saved.markdown, "utf8")).toContain(
    "Image not downloaded",
  );

  const enriched = await f.run(["--input", saved.output], {
    command: "media",
    historyStatus: 401,
    directoryStatus: 401,
  });
  expect(enriched.code).toBe(0);
  expect(enriched.stderr).toBe("");
  expect(enriched.stdout).toContain(
    "HTTP attempts: 1 (history: 0, directory: 0, profiles: 0, media: 1)",
  );
  expect(enriched.stdout).toContain("[media] Image 1/1 (downloaded: HTTP 200)");
  expect(readSummary(enriched.stdout)).toEqual(saved);
  expect(await readFile(saved.markdown, "utf8")).toContain("](media/");

  const cached = await f.run(["--input", saved.output], {
    command: "media",
    imageStatus: 401,
    historyStatus: 401,
  });
  expect(cached.code).toBe(0);
  expect(cached.stdout).toContain("reused from local cache");
  expect(cached.stdout).not.toContain("HTTP attempts:");
  const refreshed = await f.run(
    ["--input", saved.output, "--refresh-media", "--no-markdown"],
    { command: "media", imageStatus: 304 },
  );
  expect(refreshed.code).toBe(0);
  expect(refreshed.stdout).toContain("revalidated with Teams: HTTP 304");
  expect(refreshed.stdout).not.toContain("[convert]");
  const document = JSON.parse(await readFile(saved.output, "utf8"));
  expect(document.requests).toMatchObject({ total: 3, history: 1, media: 2 });
});

test("automatic naming resolves only the selected chat's participant label", async () => {
  const f = await fixture({ profileAuthorization: true });
  const result = await f.run(["--last", "1d"], {
    chats: [
      {
        id: "fixture",
        title: null,
        isOneOnOne: true,
        members: [{ mri: "8:live:self" }, { mri: "8:live:other" }],
      },
      {
        id: "unrelated",
        title: null,
        isOneOnOne: true,
        members: [{ mri: "8:live:self" }, { mri: "8:live:unrelated" }],
      },
    ],
  });
  expect(result.code).toBe(0);
  const document = JSON.parse(
    await readFile(readSummary(result.stdout).output, "utf8"),
  );
  expect(basename(dirname(readSummary(result.stdout).output))).toStartWith(
    "jane-doe--last-1d--",
  );
  expect(document.requests).toMatchObject({
    directory: 1,
    profiles: 2,
    history: 1,
  });
});

test("explicit --out overrides automatic naming without any directory or profile lookup", async () => {
  const f = await fixture();
  const result = await f.run(["--last", "1d", "--out", "custom"], {
    directoryStatus: 401,
  });
  expect(result.code).toBe(0);
  const summary = readSummary(result.stdout);
  expect(summary.output).toBe(join(f.dir, "custom", "chat.json"));
  expect(
    JSON.parse(await readFile(summary.output, "utf8")).requests,
  ).toMatchObject({ total: 1, directory: 0, profiles: 0 });
});

test("Markdown export saves both JSON and Markdown by default, and --no-markdown skips it", async () => {
  const f = await fixture();
  const result = await f.run(["--last", "1d"]);
  expect(result.code).toBe(0);
  const summary = readSummary(result.stdout);
  expect(result.stdout).toContain("[convert] Converted to Markdown.");
  expect(summary.output).toEndWith(".json");
  expect(summary.markdown).toBe(summary.output.replace(/\.json$/, ".md"));
  expect((await readdir(dirname(summary.output))).sort()).toEqual([
    "chat.json",
    "chat.md",
  ]);
  expect(JSON.parse(await readFile(summary.output, "utf8")).media.status).toBe(
    "complete",
  );
  expect(await readFile(summary.markdown, "utf8")).toContain(
    "_No messages in this period._",
  );

  const skipped = await f.run([
    "--last",
    "1d",
    "--out",
    "no-md",
    "--no-markdown",
  ]);
  expect(skipped.code).toBe(0);
  const skippedSummary = readSummary(skipped.stdout);
  expect(skipped.stdout).not.toContain("[convert] Converted to Markdown.");
  expect(skippedSummary.markdown).toBeUndefined();
  expect((await readdir(dirname(skippedSummary.output))).sort()).toEqual([
    "chat.json",
  ]);
});

test("custom --out selects the export folder and skips label lookups", async () => {
  const f = await fixture();
  const result = await f.run(["--last", "1d", "--out", "custom"], {
    directoryStatus: 401,
  });
  expect(result.code).toBe(0);
  const summary = readSummary(result.stdout);
  expect(summary.output).toBe(join(f.dir, "custom", "chat.json"));
  expect(summary.markdown).toBe(join(f.dir, "custom", "chat.md"));
  expect(
    JSON.parse(await readFile(summary.output, "utf8")).requests,
  ).toMatchObject({ total: 1, directory: 0 });
});

test("removed --format flag is rejected on export", async () => {
  const f = await fixture();
  const result = await f.run(["--last", "1d", "--format", "markdown"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown option `--format`");
});

test("--no-media retains the text-only manifest and incompatible refresh flags fail early", async () => {
  const f = await fixture();
  const skipped = await f.run(["--last", "1d", "--out", "text", "--no-media"]);
  expect(skipped.code).toBe(0);
  const archive = JSON.parse(
    await readFile(join(f.dir, "text", "chat.json"), "utf8"),
  );
  expect(archive.media).toEqual({ status: "not-downloaded" });
  expect(archive.requests.media).toBe(0);
  const conflict = await f.run([
    "--last",
    "1d",
    "--no-media",
    "--refresh-media",
  ]);
  expect(conflict.code).toBe(1);
  expect(conflict.stderr).toContain("cannot be combined");
  expect(conflict.stderr).not.toContain("HTTP attempts");
});

test("an existing Markdown destination stops export before history retrieval", async () => {
  const f = await fixture();
  await mkdir(join(f.dir, "custom"));
  await writeFile(join(f.dir, "custom", "chat.md"), "previous Markdown");
  const result = await f.run(["--last", "1d", "--out", "custom"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("already exists");
  expect(result.stderr).not.toContain("HTTP attempts:");
  expect(await Bun.file(join(f.dir, "custom", "chat.json")).exists()).toBe(
    false,
  );
  expect(await readFile(join(f.dir, "custom", "chat.md"), "utf8")).toBe(
    "previous Markdown",
  );
});

test.each([true, false])(
  "missing labels fall back to an identifier (directory token: %s)",
  async (directoryToken) => {
    const f = await fixture({ directoryToken });
    const result = await f.run(["--last", "1d"], { chats: [] });
    expect(result.code).toBe(0);
    expect(basename(dirname(readSummary(result.stdout).output))).toMatch(
      /^chat-[a-f0-9]{10}--last-1d--/,
    );
    expect(result.stderr).toContain("Chat label unavailable");
    expect(result.stdout).not.toContain("Chat label unavailable");
    expect(result.stderr).not.toContain("HTTP attempts");
    expect(result.stderr).not.toContain("Images:");
  },
);

test("repeating an explicit range preserves the previous export and stops before history retrieval", async () => {
  const f = await fixture();
  const args = [
    "--from",
    "2026-11-01T07:00:00+07:00",
    "--to",
    "2026-11-05T07:00:00+07:00",
  ];
  const first = await f.run(args);
  expect(first.code).toBe(0);
  const output = readSummary(first.stdout).output;
  expect(basename(dirname(output))).toBe(
    "cafe-project-alpha--from-2026-11-01T00-00-00-000Z--to-2026-11-05T00-00-00-000Z",
  );
  const bytes = await readFile(output, "utf8");
  const repeated = await f.run(args);
  expect(repeated.code).toBe(1);
  expect(repeated.stderr).toContain("already exists");
  expect(repeated.stdout).toContain("history: 0");
  expect(repeated.stderr).not.toContain("HTTP attempts");
  expect(await readFile(output, "utf8")).toBe(bytes);
  expect(await readdir(join(f.dir, "exports"))).toEqual([
    basename(dirname(output)),
  ]);
});

test.each([{ directoryStatus: 401 }, { historyStatus: 401 }])(
  "remote failures leave no automatic export: %j",
  async (status) => {
    const f = await fixture();
    const result = await f.run(["--last", "1d"], status);
    expect(result.code).toBe(1);
    expect(result.stdout).toStartWith("HTTP attempts:");
    expect(result.stderr).toContain("HTTP 401");
    expect(result.stderr).not.toContain("HTTP attempts");
    expect(await readdir(f.dir)).not.toContain("exports");
  },
);
