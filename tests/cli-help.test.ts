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

async function help(args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "teams-help-"));
  directories.push(directory);
  const preload = join(directory, "no-http.ts");
  await writeFile(
    preload,
    'globalThis.fetch = async () => { throw new Error("Help must not make HTTP requests"); };',
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
        // Exclude Bun's own transpiler cache from the application side-effect check.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
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
  expect(code).toBe(0);
  expect(stderr).toBe("");
  expect(await readdir(directory)).toEqual(["no-http.ts"]);
  return stdout;
}

test("top-level and no-argument help put common workflows before the complete command list", async () => {
  const stdout = await help(["--help"]);
  expect(await help([])).toBe(stdout);
  expect(stdout).toContain("teams collect --all-chats --images");
  expect(stdout).toContain(
    'teams collect --chat-label "Chat name" --all-history --images',
  );
  expect(stdout).toContain("teams export --all-chats --last 5d");
  expect(stdout.indexOf("Common workflows:")).toBeLessThan(
    stdout.indexOf("Common commands:"),
  );
  expect(stdout.indexOf("Common commands:")).toBeLessThan(
    stdout.indexOf("Other commands:"),
  );
  expect(stdout).toContain("teams <command> --help");
  expect(stdout).toContain("export-db -> export");
  expect(stdout).toContain("media-db -> images");
  for (const command of [
    "login",
    "chats",
    "collect",
    "images",
    "export",
    "download",
    "media",
    "convert",
    "convert-all",
  ])
    expect(stdout).toMatch(new RegExp(`^  ${command} +`, "m"));
});

test("collect help explains catch-up and keeps advanced options discoverable", async () => {
  const stdout = await help(["collect", "--help"]);
  expect(stdout).toContain("Without date flags, catch up");
  expect(stdout).toContain("New chats need --all-history or a date range");
  expect(stdout).toContain("Images are opt-in");
  expect(stdout).toContain("Export JSON/Markdown separately");
  expect(stdout.indexOf("Common usage:")).toBeLessThan(
    stdout.indexOf("Select chats (choose one):"),
  );
  expect(stdout.indexOf("Select chats (choose one):")).toBeLessThan(
    stdout.indexOf("Advanced:"),
  );
  for (const flag of [
    "--all-chats",
    "--chat-label",
    "--chat",
    "--images",
    "--all-history",
    "--last",
    "--since",
    "--from",
    "--to",
    "--db",
    "--no-log",
    "--backup-dir",
    "--no-backup",
    "--credentials",
    "--page-delay-min",
    "--page-delay-max",
  ])
    expect(stdout).toMatch(new RegExp(`^  ${flag}(?: |$)`, "m"));
  expect(stdout).not.toContain("(default: true)");
  expect(stdout).not.toContain("(default: false)");
});

test.each([
  "login",
  "chats",
  "collect",
  "images",
  "export",
  "download",
  "media",
  "convert",
  "convert-all",
  "export-db",
  "media-db",
])(
  "%s help is available without credentials, network or generated files and fits 88 columns",
  async (command) => {
    const stdout = await help([command, "--help"]);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("--help");
    for (const line of stdout.split("\n"))
      expect(line.length).toBeLessThanOrEqual(88);
    if (command === "export" || command === "export-db") {
      expect(stdout).toContain(
        "Offline: reads saved messages and images without credentials or HTTP",
      );
      expect(stdout).toContain("--out <directory>");
      expect(stdout).toContain("--all-chats");
      expect(stdout).toContain("no image downloads occur");
      expect(stdout).toContain("--no-media");
      expect(stdout).toContain("--no-markdown");
    }
  },
);
