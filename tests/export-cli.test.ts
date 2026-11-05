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
      if (url.pathname.endsWith("/messages")) return Response.json({ messages: [], _metadata: {} }, { status: fixtures.historyStatus });
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
    }: {
      chats?: unknown[];
      directoryStatus?: number;
      historyStatus?: number;
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
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
        "export",
        "--credentials",
        credentials,
        "--chat",
        "fixture",
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

test("export without --out publishes a label-based export folder and reports the saved path", async () => {
  const f = await fixture();
  const result = await f.run(["--last", "1d"]);
  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout);
  expect(basename(summary.output)).toBe("chat.json");
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
    await readFile(JSON.parse(result.stdout).output, "utf8"),
  );
  expect(basename(dirname(JSON.parse(result.stdout).output))).toStartWith(
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
  const summary = JSON.parse(result.stdout);
  expect(summary.output).toBe(join(f.dir, "custom", "chat.json"));
  expect(
    JSON.parse(await readFile(summary.output, "utf8")).requests,
  ).toMatchObject({ total: 1, directory: 0, profiles: 0 });
});

test("Markdown export saves both formats and reports both paths", async () => {
  const f = await fixture();
  const result = await f.run(["--last", "1d", "--format", "markdown"]);
  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout);
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
});

test("Markdown --out selects the export folder and skips label lookups", async () => {
  const f = await fixture();
  const result = await f.run(
    ["--last", "1d", "--format", "markdown", "--out", "custom"],
    { directoryStatus: 401 },
  );
  expect(result.code).toBe(0);
  const summary = JSON.parse(result.stdout);
  expect(summary.output).toBe(join(f.dir, "custom", "chat.json"));
  expect(summary.markdown).toBe(join(f.dir, "custom", "chat.md"));
  expect(
    JSON.parse(await readFile(summary.output, "utf8")).requests,
  ).toMatchObject({ total: 1, directory: 0 });
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
  const result = await f.run([
    "--last",
    "1d",
    "--format",
    "markdown",
    "--out",
    "custom",
  ]);
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
    expect(basename(dirname(JSON.parse(result.stdout).output))).toMatch(
      /^chat-[a-f0-9]{10}--last-1d--/,
    );
    expect(result.stderr).toContain("Chat label unavailable");
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
  const output = JSON.parse(first.stdout).output;
  expect(basename(dirname(output))).toBe(
    "cafe-project-alpha--from-2026-11-01T00-00-00-000Z--to-2026-11-05T00-00-00-000Z",
  );
  const bytes = await readFile(output, "utf8");
  const repeated = await f.run(args);
  expect(repeated.code).toBe(1);
  expect(repeated.stderr).toContain("already exists");
  expect(repeated.stderr).toContain("history: 0");
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
    expect(result.stdout).toBe("");
    expect(await readdir(f.dir)).not.toContain("exports");
  },
);
