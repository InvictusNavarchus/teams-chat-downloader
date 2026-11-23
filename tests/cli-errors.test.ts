import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Runs an invalid command and proves it fails before HTTP or file creation. */
async function fail(args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "teams-errors-"));
  directories.push(directory);
  const preload = join(directory, "no-http.ts");
  await writeFile(
    preload,
    'globalThis.fetch = async () => { throw new Error("Invalid input must not make HTTP requests"); };',
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      preload,
      join(import.meta.dir, "../src/cli.ts"),
      ...args,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        TEAMS_DATA_DIR: "",
        XDG_STATE_HOME: join(directory, "state"),
        XDG_CACHE_HOME: join(directory, "cache"),
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
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(await readdir(directory)).toEqual(["no-http.ts"]);
  return stderr.trim();
}

test.each([
  [
    ["colect"],
    'Unknown command "colect". Did you mean "collect"? Run teams --help to see commands.',
  ],
  [["xyzzy"], 'Unknown command "xyzzy". Run teams --help to see commands.'],
  [
    ["collect", "--chat-labl", "Alpha"],
    "Unknown option --chat-labl. Did you mean --chat-label? Run teams collect --help to see options.",
  ],
  [
    ["export", "--all-chat", "--last", "1d"],
    "Unknown option --all-chat. Did you mean --all-chats? Run teams export --help to see options.",
  ],
])(
  "names unknown input as typed and suggests a close match: %j",
  async (args, message) => {
    expect(await fail(args)).toBe(message);
  },
);

test.each([
  [
    ["collect", "--chat", "a", "--last", "7"],
    "--last expects a number of days with a d suffix, such as 7d.",
  ],
  [
    ["collect", "--chat", "a", "--since", "yesterday"],
    "--since expects a date such as 2026-11-01 (local midnight) or a timestamp",
  ],
  [["collect", "--chat", "a", "--chat-label"], "value is missing"],
  [
    ["login", "--timeout", "0"],
    "--timeout expects whole seconds from 1 to 3600.",
  ],
  [["media"], "--input is required."],
])(
  "explains invalid option values by flag and format: %j",
  async (args, message) => {
    expect(await fail(args)).toContain(message);
  },
);

test.each([
  [
    ["collect"],
    "Choose exactly one of --chat <id>, --chat-label <label>, or --all-chats.",
  ],
  [
    ["export", "--last", "3d"],
    "Choose exactly one of --chat <id>, --chat-label <label>, or --all-chats with --last Nd.",
  ],
  // download is single-chat only, so it must not suggest --all-chats.
  [
    ["download", "--last", "1d"],
    "Choose exactly one of --chat <id> or --chat-label <label>.",
  ],
])(
  "selector errors list the selectors each command accepts: %j",
  async (args, message) => {
    expect(await fail(args)).toBe(message);
  },
);
