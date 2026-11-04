import { expect, test } from "bun:test";
import { basename, dirname } from "node:path";
import { defaultExportPath } from "../src/export-path.ts";
import { resolveExportOptions } from "../src/options.ts";

const now = Date.parse("2026-11-05T10:30:00.123Z");
const last = resolveExportOptions({ chat: "fixture", last: "1d" }, now);

test("out is optional but an explicitly empty output path is rejected", () => {
  expect(last.out).toBeUndefined();
  expect(() =>
    resolveExportOptions({ chat: "fixture", last: "1d", out: "" }),
  ).toThrow("out");
});

test("rolling filenames contain the normalized label, duration, and fixed endpoint", () => {
  const path = defaultExportPath(last, "  Café / Project_ALPHA! ");
  expect(dirname(path)).toBe("exports");
  expect(basename(path)).toBe(
    "cafe-project-alpha--last-1d--to-2026-11-05T10-30-00-123Z.json",
  );
  const later = resolveExportOptions({ chat: "fixture", last: "1d" }, now + 1);
  expect(defaultExportPath(later, "Café / Project_ALPHA!")).not.toBe(path);
});

test("explicit range filenames normalize offsets to UTC and preserve milliseconds", () => {
  const options = resolveExportOptions({
    chat: "fixture",
    from: "2026-11-01T07:00:00.001+07:00",
    to: "2026-11-05T07:00:00.002+07:00",
  });
  expect(basename(defaultExportPath(options, "Project Alpha"))).toBe(
    "project-alpha--from-2026-11-01T00-00-00-001Z--to-2026-11-05T00-00-00-002Z.json",
  );
});

test("since filenames record both the requested start and captured invocation time", () => {
  const options = resolveExportOptions(
    { chat: "fixture", since: "2026-11-01T00:00:00Z" },
    now,
  );
  expect(basename(defaultExportPath(options, "Project Alpha"))).toBe(
    "project-alpha--since-2026-11-01T00-00-00-000Z--to-2026-11-05T10-30-00-123Z.json",
  );
});

test.each([
  undefined,
  "💬 / ...",
  "Untitled chat",
  "Unresolved one-to-one chat",
])(
  "unavailable labels use a stable identifier without exposing the raw chat ID: %s",
  (label) => {
    const path = defaultExportPath(last, label);
    expect(basename(path)).toMatch(/^[a-z-]+-[a-f0-9]{10}--last-1d--/);
    expect(path).not.toContain(last.chat);
    expect(defaultExportPath(last, label)).toBe(path);
    expect(defaultExportPath({ ...last, chat: "other" }, label)).not.toBe(path);
  },
);

test("Unicode labels remain readable and cannot escape the exports directory", () => {
  const path = defaultExportPath(last, "../../研发 团队\\企画");
  expect(dirname(path)).toBe("exports");
  expect(basename(path)).toStartWith("研发-团队-企画--last-1d--");
});

test("long multibyte labels leave room for both timestamps in a filename component", () => {
  const options = resolveExportOptions({
    chat: "fixture",
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-05T00:00:00Z",
  });
  const name = basename(defaultExportPath(options, "𠮷".repeat(200)));
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
  expect(name).toEndWith("--to-2026-11-05T00-00-00-000Z.json");
});
