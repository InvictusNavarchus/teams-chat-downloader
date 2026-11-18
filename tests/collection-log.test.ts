import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCollectionLog,
  writeCommandContext,
} from "../src/collection-log.ts";
import { resolveCollectOptions } from "../src/command-validation.ts";

test("collection logs are private, unique, timestamped and immediately readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "collection-log-"));
  try {
    const warnings: string[] = [];
    const first = openCollectionLog(join(dir, "history.sqlite"), (s) =>
      warnings.push(s),
    )!;
    const second = openCollectionLog(join(dir, "history.sqlite"), (s) =>
      warnings.push(s),
    )!;
    first.write("checkpoint saved\nnext line");
    expect(readFileSync(first.path, "utf8")).toMatch(
      /^\d{4}-.*Z checkpoint saved next line\n$/,
    );
    if (process.platform !== "win32") {
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "history.sqlite.logs")).mode & 0o777).toBe(
        0o700,
      );
    }
    expect(first.path).not.toBe(second.path);
    first.close();
    second.close();
    first.close();
    expect(warnings).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsafe log destinations warn without failing collection", () => {
  const dir = mkdtempSync(join(tmpdir(), "collection-log-"));
  try {
    symlinkSync(
      dir,
      join(dir, "history.sqlite.logs"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const warnings: string[] = [];
    expect(
      openCollectionLog(join(dir, "history.sqlite"), (s) => warnings.push(s)),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collection file logging defaults on and supports opt out", () => {
  const options = { db: "history.sqlite", chat: "chat", allHistory: true };
  expect(resolveCollectOptions(options).log).toBe(true);
  expect(resolveCollectOptions({ ...options, log: false }).log).toBe(false);
});

test("invocation context escapes values and excludes unrecognized and credential fields", () => {
  const lines: string[] = [];
  const input = {
    chatLabel: 'Project "Alpha"\nnext line',
    credentials: "secret-credential-path",
    token: "private-token",
    "--": ["trailing-secret"],
    backup: false,
  };
  writeCommandContext({ write: (line) => lines.push(line) }, "collect", input, {
    ...input,
    window: { from: 1, to: 1000, secret: "window-secret" },
  });
  const text = lines.join("\n");
  expect(lines).toHaveLength(3);
  expect(lines.every((line) => !line.includes("\n"))).toBe(true);
  expect(text).toContain('--chat-label "Project \\"Alpha\\"\\nnext line"');
  expect(text).toContain("--no-backup");
  expect(text).toContain('--credentials "[REDACTED]"');
  expect(text).toContain('"toExclusive":"1970-01-01T00:00:01.000Z"');
  for (const secret of [
    "secret-credential-path",
    "private-token",
    "trailing-secret",
    "window-secret",
  ])
    expect(text).not.toContain(secret);
});

test("database command logs start with input, working directory and resolved defaults", async () => {
  const { readdirSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "invocation-log-"));
  try {
    const commands = [
      {
        name: "collect",
        args: [
          "--chat-label",
          "Project Alpha",
          "--last",
          "7d",
          "--no-backup",
          "--credentials",
          join(dir, "missing.json"),
        ],
      },
      {
        name: "media-db",
        args: [
          "--chat-label",
          "Project Alpha",
          "--refresh-media",
          "--credentials",
          join(dir, "missing.json"),
        ],
      },
      {
        name: "export-db",
        args: [
          "--chat-label",
          "Project Alpha",
          "--last",
          "7d",
          "--no-media",
          "--no-markdown",
        ],
      },
    ];
    for (const { name, args } of commands) {
      for (const enabled of [true, false]) {
        const db = join(dir, `${name}-${enabled}.sqlite`);
        const child = Bun.spawn(
          [
            process.execPath,
            "src/cli.ts",
            name,
            "--db",
            db,
            ...args,
            ...(enabled ? [] : ["--no-log"]),
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(await child.exited).toBe(1);
        if (!enabled) {
          expect(existsSync(`${db}.logs`)).toBe(false);
          continue;
        }
        const files = readdirSync(`${db}.logs`);
        const text = readFileSync(join(`${db}.logs`, files[0]!), "utf8");
        const lines = text.split("\n");
        expect(lines[0]).toContain(
          `[${name}] Input (normalized): teams ${name}`,
        );
        expect(lines[0]).toContain('--chat-label "Project Alpha"');
        expect(lines[1]).toContain(
          `Working directory: ${JSON.stringify(process.cwd())}`,
        );
        expect(lines[2]).toContain("Resolved options:");
        expect(text).toContain(`[${name}] Failed:`);
        if (name === "collect") {
          expect(lines[0]).toContain('--last "7d"');
          expect(lines[0]).toContain("--no-backup");
          expect(lines[2]).toContain('"pageDelayMin":1');
          expect(lines[2]).toContain('"toExclusive":');
        } else if (name === "export-db") {
          expect(lines[0]).toContain("--no-media");
          expect(lines[2]).toContain('"markdown":false');
        } else expect(lines[2]).toContain('"refreshMedia":true');
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI persists credential failures and honors --no-log", async () => {
  const { readdirSync, existsSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "collection-log-cli-"));
  try {
    for (const enabled of [true, false]) {
      const db = join(dir, enabled ? "enabled.sqlite" : "disabled.sqlite");
      const child = Bun.spawn(
        [
          process.execPath,
          "src/cli.ts",
          "collect",
          "--db",
          db,
          "--chat",
          "test",
          "--all-history",
          "--credentials",
          join(dir, "missing.json"),
          ...(enabled ? [] : ["--no-log"]),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      await new Response(child.stderr).text();
      expect(await child.exited).toBe(1);
      if (enabled) {
        expect(stdout).toContain("Collection log:");
        const files = readdirSync(`${db}.logs`);
        expect(files).toHaveLength(1);
        const log = readFileSync(join(`${db}.logs`, files[0]!), "utf8");
        expect(log).toContain("Requested");
        expect(log).toContain("Failed:");
        expect(log).not.toContain("Completed successfully");
      } else expect(existsSync(`${db}.logs`)).toBe(false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("media-db records cancellation with its own operation name", async () => {
  const { readdirSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "media-log-cancel-"));
  try {
    const credentials = join(dir, "credentials.json");
    writeFileSync(
      credentials,
      JSON.stringify({
        version: 1,
        accountId: "test",
        historyAuthentication: "private-token",
      }),
      { mode: 0o600 },
    );
    const preload = join(dir, "cancel.ts");
    writeFileSync(
      preload,
      `const original = process.on.bind(process); process.on = function(event, listener) { const result = original(event, listener); if (event === "SIGTERM") queueMicrotask(() => process.emit("SIGTERM")); return result; };`,
    );
    const db = join(dir, "history.sqlite");
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        "src/cli.ts",
        "media-db",
        "--db",
        db,
        "--credentials",
        credentials,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(130);
    const files = readdirSync(`${db}.logs`);
    const log = readFileSync(join(`${db}.logs`, files[0]!), "utf8");
    expect(log).toContain("[media-db] Cancelled:");
    expect(log).not.toContain("Completed successfully");
    expect(log).not.toContain("private-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logging accepts aliased parents but still rejects a linked log destination", () => {
  const root = mkdtempSync(join(tmpdir(), "log-parent-"));
  try {
    const real = join(root, "real");
    mkdirSync(real);
    const alias = join(root, "alias");
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    const warnings: string[] = [];
    const log = openCollectionLog(
      join(alias, "nested", "history.sqlite"),
      (message) => warnings.push(message),
    )!;
    expect(log).toBeDefined();
    log.write("through alias");
    expect(log.path.startsWith(realpathSync(real))).toBe(true);
    expect(readFileSync(log.path, "utf8")).toContain("through alias");
    log.close();
    expect(warnings).toEqual([]);
    symlinkSync(
      real,
      join(real, "linked.sqlite.logs"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      openCollectionLog(join(alias, "linked.sqlite"), (message) =>
        warnings.push(message),
      ),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "logging still refuses publicly accessible Unix log directories",
  () => {
    const root = mkdtempSync(join(tmpdir(), "log-permissions-"));
    try {
      const directory = join(root, "history.sqlite.logs");
      mkdirSync(directory);
      chmodSync(directory, 0o755);
      const warnings: string[] = [];
      expect(
        openCollectionLog(join(root, "history.sqlite"), (message) =>
          warnings.push(message),
        ),
      ).toBeUndefined();
      expect(warnings).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
