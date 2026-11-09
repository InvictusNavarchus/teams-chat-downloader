import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  resolveConvertOptions,
  resolveExportOptions,
  resolveMediaOptions,
} from "../src/options.ts";

const base = {
  chat: "synthetic-chat",
  credentials: "private.json",
  out: "export.json",
};
const now = Date.parse("2026-11-04T12:00:00Z");

describe("history page delay options", () => {
  test("defaults to 2–5 seconds and accepts numeric CLI strings", () => {
    expect(resolveExportOptions({ ...base, last: "1d" }, now)).toMatchObject({
      pageDelayMin: 2,
      pageDelayMax: 5,
    });
    expect(
      resolveExportOptions({
        ...base,
        last: "1d",
        pageDelayMin: "0.05",
        pageDelayMax: "1.5",
      }),
    ).toMatchObject({ pageDelayMin: 0.05, pageDelayMax: 1.5 });
    expect(
      resolveExportOptions({
        ...base,
        last: "1d",
        pageDelayMin: 0,
        pageDelayMax: 0,
      }),
    ).toMatchObject({ pageDelayMin: 0, pageDelayMax: 0 });
  });

  test.each([-1, 3601, Infinity, NaN, "", " ", "slow", "1s", true, null])(
    "rejects invalid delay bounds: %s",
    (value) => {
      for (const name of ["pageDelayMin", "pageDelayMax"]) {
        expect(() =>
          resolveExportOptions({ ...base, last: "1d", [name]: value }),
        ).toThrow("Export options");
      }
    },
  );

  test("rejects a minimum above the maximum", () => {
    expect(() =>
      resolveExportOptions({
        ...base,
        last: "1d",
        pageDelayMin: "6",
        pageDelayMax: "3",
      }),
    ).toThrow("--page-delay-min must not exceed --page-delay-max");
  });
});

test("media options require an archive and support refresh and skipping Markdown", () => {
  expect(resolveMediaOptions({ input: "chat.json" })).toEqual({
    input: "chat.json",
    markdown: true,
    refreshMedia: false,
  });
  expect(
    resolveMediaOptions({
      input: "chat.json",
      refreshMedia: true,
      markdown: false,
    }),
  ).toMatchObject({ refreshMedia: true, markdown: false });
  for (const options of [{}, { input: "" }, { input: "chat.json", chat: "id" }])
    expect(() => resolveMediaOptions(options)).toThrow("Media options");
});

test("images default on, can be skipped, and refresh requires media", () => {
  expect(resolveExportOptions({ ...base, last: "1d" }, now).media).toBe(true);
  expect(
    resolveExportOptions({ ...base, last: "1d", media: false }, now).media,
  ).toBe(false);
  expect(
    resolveExportOptions({ ...base, last: "1d", refreshMedia: true }, now)
      .refreshMedia,
  ).toBe(true);
  expect(() =>
    resolveExportOptions(
      { ...base, last: "1d", media: false, refreshMedia: true },
      now,
    ),
  ).toThrow("cannot be combined");
});

describe("date options", () => {
  test.each([
    [
      "Asia/Jakarta",
      "1d",
      "2026-11-05T15:00:00+07:00",
      "2026-11-05T00:00:00+07:00",
    ],
    [
      "Asia/Jakarta",
      "2d",
      "2026-11-05T15:00:00+07:00",
      "2026-11-04T00:00:00+07:00",
    ],
    [
      "Asia/Jakarta",
      "7d",
      "2026-11-05T15:00:00+07:00",
      "2026-10-30T00:00:00+07:00",
    ],
    [
      "Asia/Jakarta",
      "1d",
      "2026-11-05T00:00:00.001+07:00",
      "2026-11-05T00:00:00+07:00",
    ],
    [
      "Asia/Jakarta",
      "1d",
      "2026-11-05T23:59:59.999+07:00",
      "2026-11-05T00:00:00+07:00",
    ],
    ["UTC", "2d", "2026-11-01T12:00:00Z", "2026-10-31T00:00:00Z"],
    ["UTC", "2d", "2026-01-01T12:00:00Z", "2025-12-31T00:00:00Z"],
    ["UTC", "2d", "2024-03-01T12:00:00Z", "2024-02-29T00:00:00Z"],
    [
      "America/New_York",
      "1d",
      "2026-03-08T12:00:00-04:00",
      "2026-03-08T00:00:00-05:00",
    ],
    [
      "America/New_York",
      "2d",
      "2026-03-09T12:00:00-04:00",
      "2026-03-08T00:00:00-05:00",
    ],
    [
      "America/New_York",
      "1d",
      "2026-11-01T12:00:00-05:00",
      "2026-11-01T00:00:00-04:00",
    ],
    [
      "America/New_York",
      "2d",
      "2026-11-02T12:00:00-05:00",
      "2026-11-01T00:00:00-04:00",
    ],
  ])(
    "%s --last %s at %s starts at %s and ends at invocation time",
    async (zone, last, invocation, start) => {
      // Isolate TZ so these cases cannot change the timezone of other tests.
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `import { resolveExportOptions } from ${JSON.stringify(fileURLToPath(new URL("../src/options.ts", import.meta.url)))};
      console.log(JSON.stringify(resolveExportOptions({ chat: "fixture", last: ${JSON.stringify(last)} }, ${Date.parse(invocation)}).window));`,
        ],
        {
          env: { ...process.env, TZ: zone },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({
        from: Date.parse(start),
        to: Date.parse(invocation),
      });
    },
  );

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

test("export defaults to Markdown and accepts skipping it with markdown: false", () => {
  expect(resolveExportOptions({ ...base, last: "1d" }).markdown).toBe(true);
  expect(
    resolveExportOptions({ ...base, last: "1d", markdown: false }).markdown,
  ).toBe(false);
  expect(() =>
    resolveExportOptions({ ...base, last: "1d", format: "markdown" }),
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
