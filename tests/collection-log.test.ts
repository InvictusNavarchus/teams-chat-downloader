import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCollectionLog } from "../src/collection-log.ts";
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
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "history.sqlite.logs")).mode & 0o777).toBe(0o700);
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
    symlinkSync(dir, join(dir, "history.sqlite.logs"));
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
  const options = { db: "history.sqlite", chat: "chat", all: true };
  expect(resolveCollectOptions(options).log).toBe(true);
  expect(resolveCollectOptions({ ...options, log: false }).log).toBe(false);
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
          "--all",
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
