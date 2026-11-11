import { expect, test } from "bun:test";
import { basename, dirname } from "node:path";
import dayjs from "dayjs";
import { defaultExportDirectory } from "../src/export-path.ts";
import { resolveExportOptions } from "../src/command-validation.ts";

const now = Date.parse("2026-11-05T10:30:00.123Z");
const last = resolveExportOptions({ chat: "fixture", last: "1d" }, now);

test("out is optional but an explicitly empty output path is rejected", () => {
  expect(last.out).toBeUndefined();
  expect(() =>
    resolveExportOptions({ chat: "fixture", last: "1d", out: "" }),
  ).toThrow("out");
});

test("daily directory names group the normalized label and local date without an invocation timestamp", () => {
  const path = defaultExportDirectory(last, "  Café / Project_ALPHA! ");
  expect(dirname(path)).toBe("exports/cafe-project-alpha");
  expect(basename(path)).toBe(dayjs(now).format("YYYY-MM-DD"));
  const later = resolveExportOptions({ chat: "fixture", last: "1d" }, now + 1);
  expect(defaultExportDirectory(later, "Café / Project_ALPHA!")).toBe(path);
  const tomorrow = resolveExportOptions(
    { chat: "fixture", last: "1d" },
    dayjs(now).add(1, "day").valueOf(),
  );
  expect(defaultExportDirectory(tomorrow, "Café / Project_ALPHA!")).not.toBe(
    path,
  );
});

test("longer last-N-days exports remain timestamped snapshots under the chat", () => {
  const options = resolveExportOptions({ chat: "fixture", last: "7d" }, now);
  const path = defaultExportDirectory(options, "Project Alpha");
  expect(dirname(path)).toBe("exports/project-alpha");
  expect(basename(path)).toBe("last-7d--to-2026-11-05T10-30-00-123Z");
});

test("explicit range directory names normalize offsets to UTC and preserve milliseconds", () => {
  const options = resolveExportOptions({
    chat: "fixture",
    from: "2026-11-01T07:00:00.001+07:00",
    to: "2026-11-05T07:00:00.002+07:00",
  });
  expect(basename(defaultExportDirectory(options, "Project Alpha"))).toBe(
    "from-2026-11-01T00-00-00-001Z--to-2026-11-05T00-00-00-002Z",
  );
});

test("since directory names record both the requested start and captured invocation time", () => {
  const options = resolveExportOptions(
    { chat: "fixture", since: "2026-11-01T00:00:00Z" },
    now,
  );
  expect(basename(defaultExportDirectory(options, "Project Alpha"))).toBe(
    "since-2026-11-01T00-00-00-000Z--to-2026-11-05T10-30-00-123Z",
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
    const path = defaultExportDirectory(last, label);
    expect(basename(dirname(path))).toMatch(/^[a-z-]+-[a-f0-9]{10}$/);
    expect(path).not.toContain(last.chat);
    expect(defaultExportDirectory(last, label)).toBe(path);
    expect(defaultExportDirectory({ ...last, chat: "other" }, label)).not.toBe(
      path,
    );
  },
);

test("Unicode labels remain readable and cannot escape the exports directory", () => {
  const path = defaultExportDirectory(last, "../../研发 团队\\企画");
  expect(dirname(path)).toBe("exports/研发-团队-企画");
});

test("long multibyte labels leave room for both timestamps in a directory component", () => {
  const options = resolveExportOptions({
    chat: "fixture",
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-05T00:00:00Z",
  });
  const name = basename(defaultExportDirectory(options, "𠮷".repeat(200)));
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
  expect(
    Buffer.byteLength(
      basename(dirname(defaultExportDirectory(options, "𠮷".repeat(200)))),
    ),
  ).toBeLessThanOrEqual(255);
  expect(name).toEndWith("--to-2026-11-05T00-00-00-000Z");
});
