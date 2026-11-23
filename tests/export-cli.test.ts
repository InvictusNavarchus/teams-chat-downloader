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
    Date.now = () => fixtures.now;
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/users/me")) return Response.json(fixtures.directory, { status: fixtures.directoryStatus });
      if (url.pathname.endsWith("/messages")) {
        if (fixtures.historyGate) {
          await Bun.write(fixtures.historyGate + ".started", "started");
          const deadline = performance.now() + 3000;
          while (!(await Bun.file(fixtures.historyGate).exists())) {
            if (performance.now() > deadline) throw new Error("History gate timed out");
            await Bun.sleep(5);
          }
        }
        if (fixtures.cancelHistory) process.emit("SIGINT");
        const chat = decodeURIComponent(url.pathname.split("/").at(-2));
        if (chat !== fixtures.expectedChat) throw new Error("History requested the wrong chat");
        const index = Number(url.searchParams.get("fixturePage") ?? 0);
        const messages = fixtures.historyPages?.[index] ?? fixtures.messages;
        const next = fixtures.historyPages && index + 1 < fixtures.historyPages.length;
        url.searchParams.set("fixturePage", String(index + 1));
        return Response.json({ messages, _metadata: next ? { backwardLink: url.href } : {} }, { status: fixtures.historyStatus });
      }
      if (url.origin === "https://us-api.asm.skype.com" && ["/v1/objects/fixture-image/views/imgo", "/v1/objects/second-image/views/imgo"].includes(url.pathname)) {
        if (fixtures.cancelImage) process.emit("SIGINT");
        const status = fixtures.imageStatuses?.[url.pathname.split("/")[3]] ?? fixtures.imageStatus;
        if (status === 304) {
          if (input.headers.get("if-none-match") !== '"fixture-image"') throw new Error("Expected conditional image request");
          return new Response(null, { status: 304 });
        }
        return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=", "base64"), {
          status,
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
      imageStatuses,
      command = "download",
      expectedChat = "fixture",
      now = Date.parse("2026-11-11T03:00:00Z"),
      historyGate,
      cancelHistory = false,
      cancelImage = false,
    }: {
      chats?: unknown[];
      directoryStatus?: number;
      historyStatus?: number;
      messages?: unknown[];
      historyPages?: unknown[][];
      imageStatus?: number;
      imageStatuses?: Record<string, number>;
      command?: "download" | "export" | "collect" | "images" | "media";
      expectedChat?: string;
      now?: number;
      historyGate?: string;
      cancelHistory?: boolean;
      cancelImage?: boolean;
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
        imageStatuses,
        expectedChat,
        now,
        historyGate,
        cancelHistory,
        cancelImage,
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        command,
        ...(command === "export" ? [] : ["--credentials", credentials]),
        ...(command === "download" || command === "collect"
          ? ["--no-backup", "--page-delay-min", "0", "--page-delay-max", "0"]
          : []),
        ...(command === "download" &&
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
          XDG_STATE_HOME: join(dir, "state"),
          XDG_CACHE_HOME: join(dir, "cache"),
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
    return { code, stdout, stderr };
  }
  return { dir, run, credentials };
}

const message = (id: string, content = "saved") => ({
  id,
  content,
  originalarrivaltime: "2026-11-11T01:00:00Z",
  messagetype: "Text",
});

const imageMessage = (id: string, object = "fixture-image") => ({
  ...message(
    id,
    `<img src="https://us-api.asm.skype.com/v1/objects/${object}/views/imgo">`,
  ),
  messagetype: "RichText/Html",
});

test("collect --images saves history and images without exporting, then offline export reuses them", async () => {
  const f = await fixture({ media: true });
  const collected = await f.run(
    ["--chat-label", "Café / Project Alpha", "--last", "1d", "--images"],
    {
      command: "collect",
      messages: [imageMessage("image")],
    },
  );
  expect(collected.code).toBe(0);
  const result = readSummary(collected.stdout);
  expect(result.images).toMatchObject([
    { chatId: "fixture", saved: 1, downloaded: 1 },
  ]);
  expect(collected.stdout).toContain(
    "History collection complete; downloading pending images.",
  );
  expect(await readdir(f.dir)).not.toContain("exports");
  const logs = await readdir(`${result.database}.logs`);
  expect(logs).toHaveLength(1);
  const log = await readFile(join(`${result.database}.logs`, logs[0]!), "utf8");
  expect(log).toContain('"images":true');
  expect(log).toContain("[media] Image 1/1");
  expect(log).toContain("[collect] Completed successfully.");
  for (const secret of [
    "fixture-history",
    "fixture-media",
    "<img",
    "https://us-api.asm.skype.com",
  ])
    expect(log).not.toContain(secret);
  const exported = await f.run(["--chat", "fixture", "--out", "portable"], {
    command: "export",
  });
  expect(exported.code).toBe(0);
  expect(exported.stdout).not.toContain("HTTP attempts:");
  expect(await Bun.file(join(f.dir, "portable", "chat.md")).text()).toContain(
    "media/",
  );
  expect(
    (await Bun.file(join(f.dir, "portable", "chat.json")).json()).media.status,
  ).toBe("complete");
});

test("all-chat catch-up images include only saved chats and reuse a shared image without history HTTP", async () => {
  const f = await fixture({ media: true });
  for (const chat of ["a", "b"]) {
    const seeded = await f.run(["--chat", chat, "--last", "1d"], {
      command: "collect",
      expectedChat: chat,
      messages: [imageMessage("shared")],
    });
    expect(seeded.code).toBe(0);
    expect(seeded.stdout).not.toContain("[images]");
  }
  const result = await f.run(["--all-chats", "--images"], {
    command: "collect",
    historyStatus: 401,
    directoryStatus: 401,
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Chat 1/2: "a"');
  expect(result.stdout).toContain('Chat 2/2: "b"');
  const summary = readSummary(result.stdout);
  expect(summary.completedWindows).toBe(0);
  expect(summary.images).toMatchObject([
    { chatId: "a", downloaded: 1, alreadyDownloaded: 0 },
    { chatId: "b", downloaded: 0, alreadyDownloaded: 1 },
  ]);
  const rerun = await f.run(["--all-chats", "--images", "--no-log"], {
    command: "collect",
    historyStatus: 401,
    directoryStatus: 401,
    imageStatus: 401,
  });
  expect(rerun.code).toBe(0);
  expect(rerun.stdout).not.toContain("HTTP attempts:");
  expect(rerun.stdout).not.toContain("Collection log:");
  expect(await readdir(f.dir)).not.toContain("exports");
});

test("batch image collection continues to the next chat after an image failure", async () => {
  const f = await fixture({ media: true });
  for (const [chat, object] of [
    ["a", "fixture-image"],
    ["b", "second-image"],
  ] as const) {
    const seeded = await f.run(["--chat", chat, "--last", "1d"], {
      command: "collect",
      expectedChat: chat,
      messages: [imageMessage("image", object)],
    });
    expect(seeded.code).toBe(0);
  }
  const args = ["--all-chats", "--images"];
  const partial = await f.run(args, {
    command: "collect",
    historyStatus: 401,
    imageStatuses: { "fixture-image": 404 },
  });
  expect(partial.code).toBe(1);
  expect(partial.stdout).toContain("HTTP 404");
  expect(readSummary(partial.stdout).images).toMatchObject([
    { chatId: "a", saved: 0, failed: 1 },
    { chatId: "b", saved: 1, failed: 0 },
  ]);
  const retry = await f.run(args, { command: "collect", historyStatus: 401 });
  expect(retry.code).toBe(0);
  expect(readSummary(retry.stdout).images).toMatchObject([
    { chatId: "a", saved: 1, failed: 0 },
    { chatId: "b", alreadyDownloaded: 1, saved: 0, failed: 0 },
  ]);
});

test("single-chat image collection excludes other saved chats", async () => {
  const f = await fixture({ media: true });
  let database = "";
  for (const [chat, object] of [
    ["a", "fixture-image"],
    ["b", "second-image"],
  ]) {
    const seeded = await f.run(["--chat", chat!, "--last", "1d"], {
      command: "collect",
      expectedChat: chat,
      messages: [imageMessage("image", object)],
    });
    expect(seeded.code).toBe(0);
    database = readSummary(seeded.stdout).database;
  }
  const result = await f.run(["--db", database, "--chat", "a", "--images"], {
    command: "collect",
    historyStatus: 401,
    imageStatuses: { "second-image": 401 },
  });
  expect(result.code).toBe(0);
  expect(readSummary(result.stdout).images).toMatchObject([
    { chatId: "a", saved: 1 },
  ]);
  const other = await f.run(["--db", database, "--chat", "b"], {
    command: "images",
    imageStatus: 401,
  });
  expect(other.code).toBe(1);
});

test.each(["failure", "cancellation"])(
  "collect image %s keeps completed history and images for retry without exporting",
  async (mode) => {
    const f = await fixture({ media: true });
    // Separate chats make the successful first image independent of which image keys sort first.
    for (const [chat, object] of [
      ["a", "fixture-image"],
      ["b", "second-image"],
    ]) {
      const seeded = await f.run(["--chat", chat!, "--last", "1d"], {
        command: "collect",
        expectedChat: chat,
        messages: [imageMessage("image", object)],
      });
      expect(seeded.code).toBe(0);
    }
    const first = await f.run(["--chat", "a", "--images"], {
      command: "collect",
    });
    expect(first.code).toBe(0);
    const failed = await f.run(["--all-chats", "--images"], {
      command: "collect",
      historyStatus: 401,
      imageStatus: mode === "failure" ? 401 : 200,
      cancelImage: mode === "cancellation",
    });
    expect(failed.code).toBe(mode === "failure" ? 1 : 130);
    const database = readSummary(first.stdout).database;
    const logs = await readdir(`${database}.logs`);
    const text = (
      await Promise.all(
        logs.map((file) => readFile(join(`${database}.logs`, file), "utf8")),
      )
    ).find((log) =>
      log.includes(
        mode === "failure" ? "[collect] Failed:" : "[collect] Cancelled:",
      ),
    );
    expect(text).toBeDefined();
    expect(text).toContain("History collection complete");
    expect(text).not.toContain("[collect] Completed successfully.");
    const retried = await f.run(["--all-chats", "--images"], {
      command: "collect",
      historyStatus: 401,
    });
    expect(retried.code).toBe(0);
    expect(readSummary(retried.stdout).images).toMatchObject([
      { chatId: "a", alreadyDownloaded: 1, saved: 0 },
      { chatId: "b", saved: 1 },
    ]);
    expect(await readdir(f.dir)).not.toContain("exports");
  },
);

test("failed history collection does not start the requested image phase", async () => {
  const f = await fixture({ media: true });
  const failed = await f.run(
    ["--chat", "fixture", "--last", "1d", "--images"],
    { command: "collect", historyStatus: 401 },
  );
  expect(failed.code).toBe(1);
  expect(failed.stdout).not.toContain("[images]");
  expect(failed.stdout).not.toContain("History collection complete");
});

test("download collects, downloads and exports; repeat runs preserve saved edits and deletions", async () => {
  const f = await fixture();
  const args = ["--chat-label", "Café / Project Alpha", "--last", "1d"];
  const first = await f.run(args, { messages: [message("a"), message("b")] });
  expect(first.code).toBe(0);
  const summary = readSummary(first.stdout);
  expect(summary.output).toBe(
    join(f.dir, "exports/cafe-project-alpha/2026-11-11/chat.json"),
  );
  const second = await f.run(args, { messages: [message("a", "edited")] });
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("no history requests needed");
  const archive = JSON.parse(await readFile(summary.output, "utf8"));
  expect(archive.messages).toEqual([message("a"), message("b")]);
  expect(archive.requests.total).toBe(0);
  expect(archive.history.source).toBe("sqlite");
  expect(await readFile(summary.markdown, "utf8")).toContain("saved");
  const logs = await readdir(`${summary.database}.logs`);
  expect(logs).toHaveLength(2);
  const log = await readFile(
    join(`${summary.database}.logs`, logs[0]!),
    "utf8",
  );
  expect(log).toContain("[download]");
  expect(log).not.toContain("fixture-history");
});

test("offline export finds a single account database without credentials or HTTP", async () => {
  const f = await fixture();
  const first = await f.run(["--last", "1d"], { messages: [message("a")] });
  expect(first.code).toBe(0);
  await rm(f.credentials);
  const result = await f.run(["--chat", "fixture", "--last", "1d"], {
    command: "export",
    historyStatus: 401,
    directoryStatus: 401,
  });
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("HTTP attempts:");
  expect(readSummary(result.stdout).messages).toBe(1);
});

test("explicit combined download refuses overwrite before HTTP; offline export uses the same database", async () => {
  const f = await fixture();
  const args = ["--last", "1d", "--out", "combined"];
  const first = await f.run(args, { messages: [message("a")] });
  expect(first.code).toBe(0);
  const second = await f.run(args);
  expect(second.code).toBe(1);
  expect(second.stderr).toContain("already exists");
  expect(second.stdout).not.toContain("HTTP attempts:");
  const exported = await f.run(
    [
      "--db",
      readSummary(first.stdout).database,
      "--chat",
      "fixture",
      "--out",
      "offline",
    ],
    { command: "export" },
  );
  expect(exported.code).toBe(0);
  expect(readSummary(exported.stdout).messages).toBe(1);
  expect(exported.stdout).not.toContain("HTTP attempts:");
});

test("download rejects selectors, date conflicts and incompatible media flags before HTTP", async () => {
  const f = await fixture();
  for (const args of [
    ["--chat", "fixture", "--chat-label", "A", "--last", "1d"],
    ["--all-history", "--last", "1d"],
    ["--all"],
    ["--last", "1d", "--no-media", "--refresh-media"],
  ]) {
    const result = await f.run(args);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("HTTP attempts:");
  }
});

test("duplicate labels fail before history", async () => {
  const f = await fixture();
  const result = await f.run(["--chat-label", "Alpha", "--last", "1d"], {
    chats: [
      { id: "a", title: "Alpha", isOneOnOne: false },
      { id: "b", title: "ALPHA", isOneOnOne: false },
    ],
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Multiple chats match");
  expect(result.stdout).toContain("history: 0");
});

test("failed tail retrieval keeps saved database history and the previously published daily bundle", async () => {
  const f = await fixture();
  const first = await f.run(["--last", "1d"], { messages: [message("a")] });
  const summary = readSummary(first.stdout);
  const saved = await readFile(summary.output, "utf8");
  const failed = await f.run(["--last", "1d"], {
    now: Date.parse("2026-11-11T04:00:00Z"),
    historyStatus: 401,
  });
  expect(failed.code).toBe(1);
  expect(await readFile(summary.output, "utf8")).toBe(saved);
  expect(failed.stderr).toContain("checkpoints remain saved");
});

test("media failure still exports text and available images; retry reuses collected history", async () => {
  const f = await fixture({ media: true });
  const messages = [
    imageMessage("first", "fixture-image"),
    imageMessage("second", "second-image"),
  ];
  const first = await f.run(["--last", "1d"], {
    messages,
    imageStatuses: { "fixture-image": 404 },
  });
  expect(first.code).toBe(1);
  expect(first.stderr).toContain("Text export saved:");
  const [chatFolder] = await readdir(join(f.dir, "exports"));
  const partial = JSON.parse(
    await readFile(
      join(f.dir, "exports", chatFolder!, "2026-11-11", "chat.json"),
      "utf8",
    ),
  );
  expect(partial.media).toMatchObject({
    status: "partial",
    images: [{ messageId: "second" }],
  });
  const second = await f.run(["--last", "1d"], { messages });
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("no history requests needed");
  const archive = JSON.parse(
    await readFile(readSummary(second.stdout).output, "utf8"),
  );
  expect(archive.media.status).toBe("complete");
  expect(archive.media.images).toHaveLength(2);
  expect(second.stdout).toContain("media: 1");
});

test("calendar downloads and offline exports both publish one folder per day", async () => {
  const f = await fixture();
  const first = await f.run(["--last", "3d", "--no-media", "--no-markdown"]);
  expect(first.code).toBe(0);
  const summary = readSummary(first.stdout);
  expect(summary.days).toHaveLength(3);
  expect(summary.markdown).toBeUndefined();
  const exported = await f.run(
    ["--chat", "fixture", "--last", "3d", "--no-media"],
    { command: "export" },
  );
  expect(exported.code).toBe(0);
  expect(
    readSummary(exported.stdout).days.map((d: { output: string }) => d.output),
  ).toEqual(summary.days.map((d: { output: string }) => d.output));
});

test("collect uses the account default and leaves rendering to offline export", async () => {
  const f = await fixture();
  const first = await f.run(["--chat", "fixture", "--last", "1d"], {
    command: "collect",
    messages: [message("a")],
  });
  expect(first.code).toBe(0);
  expect(await readdir(f.dir)).not.toContain("exports");
  const result = await f.run(["--chat", "fixture", "--last", "1d"], {
    command: "export",
  });
  expect(result.code).toBe(0);
  expect(readSummary(result.stdout).messages).toBe(1);
});

test("offline defaults refuse multiple accounts and honor an explicit database", async () => {
  const f = await fixture();
  const first = await f.run(["--last", "1d"]);
  const db = readSummary(first.stdout).database;
  const { copyFile } = await import("node:fs/promises");
  await copyFile(db, join(dirname(db), `${"f".repeat(64)}.sqlite`));
  const ambiguous = await f.run(["--chat", "fixture", "--last", "1d"], {
    command: "export",
  });
  expect(ambiguous.code).toBe(1);
  expect(ambiguous.stderr).toContain("Multiple account collections");
  expect(ambiguous.stdout).not.toContain("HTTP attempts:");
  const explicit = await f.run(
    ["--db", db, "--chat", "fixture", "--last", "1d"],
    { command: "export" },
  );
  expect(explicit.code).toBe(0);
});

test("download daily publication refuses an archive lock or symlink without altering saved files", async () => {
  const f = await fixture();
  const first = await f.run(["--last", "1d"]);
  const output = readSummary(first.stdout).output;
  const bytes = await readFile(output, "utf8");
  await mkdir(`${output}.media.lock`);
  const locked = await f.run(["--last", "1d"]);
  expect(locked.code).toBe(1);
  expect(locked.stderr).toContain("already running");
  expect(await readFile(output, "utf8")).toBe(bytes);
  await rm(`${output}.media.lock`, { recursive: true });
  await rm(output);
  const target = join(f.dir, "untouched.json");
  await writeFile(target, bytes);
  await symlink(target, output);
  const linked = await f.run(["--last", "1d"]);
  expect(linked.code).toBe(1);
  expect(linked.stderr).toContain("symlink");
  expect(await readFile(target, "utf8")).toBe(bytes);
});

test("a later invocation fetches only the uncovered tail and cancellation keeps previous output", async () => {
  const f = await fixture();
  const first = await f.run(["--last", "1d"], { messages: [message("a")] });
  const output = readSummary(first.stdout).output;
  const bytes = await readFile(output, "utf8");
  const later = Date.parse("2026-11-11T04:00:00Z");
  const cancelled = await f.run(["--last", "1d"], {
    now: later,
    cancelHistory: true,
  });
  expect(cancelled.code).toBe(130);
  expect(await readFile(output, "utf8")).toBe(bytes);
  const next = await f.run(["--last", "1d"], {
    now: later,
    messages: [
      { ...message("b"), originalarrivaltime: "2026-11-11T03:30:00Z" },
    ],
  });
  expect(next.code).toBe(0);
  expect(next.stdout).toContain(
    "2026-11-11T03:00:00.000Z to 2026-11-11T04:00:00.000Z",
  );
  const archive = JSON.parse(await readFile(output, "utf8"));
  expect(archive.messages.map((m: { id: string }) => m.id)).toEqual(["a", "b"]);
});
