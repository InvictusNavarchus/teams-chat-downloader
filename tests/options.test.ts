import { describe, expect, test } from "bun:test";
import { resolveConvertOptions, resolveExportOptions } from "../src/options.ts";

const base = {
  chat: "synthetic-chat",
  credentials: "private.json",
  out: "export.json",
};
const now = Date.parse("2026-11-04T12:00:00Z");

describe("date options", () => {
  test("last 7d is one fixed 168-hour window", () => {
    expect(resolveExportOptions({ ...base, last: "7d" }, now).window).toEqual({
      from: now - 7 * 86_400_000,
      to: now,
    });
  });

  test("explicit offsets resolve to UTC milliseconds", () => {
    expect(
      resolveExportOptions({
        ...base,
        from: "2026-08-01T07:00:00+07:00",
        to: "2026-08-08T00:00:00Z",
      }).window,
    ).toEqual({ from: 1785542400000, to: 1786147200000 });
  });

  test("since ends at invocation time", () => {
    expect(
      resolveExportOptions({ ...base, since: "2026-11-01T00:00:00Z" }, now)
        .window.to,
    ).toBe(now);
  });

  test.each([
    {},
    { last: "7d", since: "2026-11-01T00:00:00Z" },
    { last: "0d" },
    { last: "-1d" },
    { last: "9999999999999999999999999d" },
    { from: "2026-08-01T00:00:00Z" },
    { from: "2026-08-01", to: "2026-08-08" },
    { from: "2026-08-08T00:00:00Z", to: "2026-08-01T00:00:00Z" },
    { from: "2026-08-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
    { from: "2026-02-30T00:00:00Z", to: "2026-03-05T00:00:00Z" },
    { last: "7d", to: "2026-08-08T00:00:00Z" },
    { from: "2026-08-01T00:00:00.0001Z", to: "2026-08-08T00:00:00Z" },
  ])("rejects invalid or ambiguous dates: %j", (dates) => {
    expect(() => resolveExportOptions({ ...base, ...dates }, now)).toThrow();
  });
});

test("export defaults to JSON and accepts Markdown as an additional output", () => {
  expect(resolveExportOptions({ ...base, last: "1d" }).format).toBe("json");
  expect(
    resolveExportOptions({ ...base, last: "1d", format: "markdown" }).format,
  ).toBe("markdown");
  expect(() =>
    resolveExportOptions({ ...base, last: "1d", format: "html" }),
  ).toThrow();
});

test.each([
  {},
  { input: "" },
  { input: "history.json", format: "html" },
  { input: "history.json", out: "" },
])("invalid convert options fail: %j", (options) => {
  expect(() => resolveConvertOptions(options)).toThrow();
});
