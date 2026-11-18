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
      command = "download",
      expectedChat = "fixture",
      now = Date.parse("2026-11-11T03:00:00Z"),
      historyGate,
      cancelHistory = false,
    }: {
      chats?: unknown[];
      directoryStatus?: number;
      historyStatus?: number;
      messages?: unknown[];
      historyPages?: unknown[][];
      imageStatus?: number;
      command?: "download" | "export" | "collect" | "images" | "media";
      expectedChat?: string;
      now?: number;
      historyGate?: string;
      cancelHistory?: boolean;
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
        now,
        historyGate,
        cancelHistory,
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

test("media failure still exports text; retry reuses collected history", async () => {
  const f = await fixture({ media: true });
  const messages = [
    {
      ...message("image"),
      messagetype: "RichText/Html",
      content:
        '<img src="https://us-api.asm.skype.com/v1/objects/fixture-image/views/imgo">',
    },
  ];
  const first = await f.run(["--last", "1d"], { messages, imageStatus: 401 });
  expect(first.code).toBe(1);
  expect(first.stderr).toContain("Text export saved:");
  const second = await f.run(["--last", "1d"], { messages });
  expect(second.code).toBe(0);
  expect(second.stdout).toContain("no history requests needed");
  const archive = JSON.parse(
    await readFile(readSummary(second.stdout).output, "utf8"),
  );
  expect(archive.media.status).toBe("complete");
  expect(archive.media.images).toHaveLength(1);
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
