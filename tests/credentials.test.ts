import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultCredentialsPath } from "../src/credentials.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("default path respects absolute XDG state home and ignores empty or relative values", () => {
  expect(
    defaultCredentialsPath({ XDG_STATE_HOME: "/state" }, "/home/fixture"),
  ).toBe("/state/teams-chat-download/credentials.json");
  for (const value of [undefined, "", "relative/state"]) {
    expect(
      defaultCredentialsPath({ XDG_STATE_HOME: value }, "/home/fixture"),
    ).toBe("/home/fixture/.local/state/teams-chat-download/credentials.json");
  }
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "teams-credentials-test-"));
  directories.push(dir);
  // Isolate the installation fallback as well as user state from real credentials.
  const root = fileURLToPath(new URL("../", import.meta.url));
  await cp(join(root, "src"), join(dir, "src"), { recursive: true });
  await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  const cwd = join(dir, "unrelated");
  await mkdir(cwd);
  const state = join(dir, "state");
  const defaultPath = defaultCredentialsPath({ XDG_STATE_HOME: state });
  const fallback = join(dir, ".private", "credentials.json");
  const explicit = join(dir, "override.json");
  const preload = join(dir, "offline.ts");
  await writeFile(
    preload,
    `
    globalThis.fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const token = request.headers.get("x-skypetoken") ?? request.headers.get("Authentication");
      if (token !== process.env.FIXTURE_TOKEN) return new Response(null, { status: 401 });
      return Response.json(request.headers.has("x-skypetoken")
        ? { chats: [], metadata: { hasMoreChats: false, isPartialData: false } }
        : { messages: [], _metadata: {} });
    };
  `,
  );
  async function credentials(path: string, token: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        accountId: "fixture",
        directoryToken: token,
        historyAuthentication: token,
      }),
      { mode: 0o600 },
    );
  }
  async function run(args: string[], token = "default") {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(dir, "src", "cli.ts"),
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, XDG_STATE_HOME: state, FIXTURE_TOKEN: token },
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
  return { dir, defaultPath, fallback, explicit, credentials, run };
}

test("chats and download load user state without a flag from an unrelated cwd", async () => {
  const f = await fixture();
  await f.credentials(f.defaultPath, "default");
  await f.credentials(f.fallback, "wrong-account");
  const chats = await f.run(["chats"]);
  expect(chats.code).toBe(0);
  expect(JSON.parse(chats.stdout.split("\nHTTP attempts:")[0]!)).toEqual([]);
  const exported = await f.run([
    "download",
    "--chat",
    "fixture",
    "--last",
    "7d",
    "--out",
    join(f.dir, "export"),
  ]);
  expect(exported.code).toBe(0);
  expect(exported.stdout).toContain("history: 1");
  expect(exported.stderr).toBe("");
});

test("existing installation-private credentials work when user state is absent", async () => {
  const f = await fixture();
  await f.credentials(f.fallback, "fallback");
  const result = await f.run(["chats"], "fallback");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout.split("\nHTTP attempts:")[0]!)).toEqual([]);
});

test("explicit override wins and a missing explicit path never falls back", async () => {
  const f = await fixture();
  await f.credentials(f.defaultPath, "default");
  await f.credentials(f.explicit, "override");
  expect(
    (await f.run(["chats", "--credentials", f.explicit], "override")).code,
  ).toBe(0);
  const result = await f.run([
    "chats",
    "--credentials",
    join(f.dir, "missing.json"),
  ]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not found at --credentials path");
  expect(result.stderr).not.toContain("HTTP attempts");
});

test("broken default credentials stop lookup rather than switching accounts", async () => {
  const f = await fixture();
  await f.credentials(f.defaultPath, "default");
  await f.credentials(f.fallback, "fallback");
  for (const contents of ["invalid JSON", '{"version":2}']) {
    await writeFile(f.defaultPath, contents);
    const result = await f.run(["chats"], "fallback");
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain("HTTP attempts");
  }
  if (process.platform !== "win32") {
    await f.credentials(f.defaultPath, "default");
    await chmod(f.defaultPath, 0o644);
    const result = await f.run(["chats"], "fallback");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("chmod 600");
    expect(result.stderr).not.toContain("HTTP attempts");
  }
});

test("missing automatic credentials explain setup instead of reporting an invalid option", async () => {
  const f = await fixture();
  const result = await f.run(["chats"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(f.defaultPath);
  expect(result.stderr).toContain("--credentials <file>");
  expect(result.stderr).not.toContain("HTTP attempts");
});
