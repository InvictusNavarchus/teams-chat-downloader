import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  resolveConvertOptions,
  resolveCollectOptions,
  resolveDatabaseMediaOptions,
  resolveDownloadOptions,
  resolveExportOptions,
  resolveMediaOptions,
} from "../src/command-validation.ts";
import { defaultPageDelay } from "../src/config.ts";

const base = {
  chat: "synthetic-chat",
  credentials: "private.json",
  out: "export.json",
};
const now = Date.parse("2026-11-04T12:00:00Z");

describe("saved chat collection selection", () => {
  test("accepts all saved chats with all history or a bounded window", () => {
    expect(
      resolveCollectOptions(
        { db: "history.sqlite", allChats: true, all: true },
        now,
      ),
    ).toMatchObject({ allChats: true, window: { from: 1, to: now } });
    expect(
      resolveCollectOptions(
        { db: "history.sqlite", allChats: true, since: "2026-11-01T00:00:00Z" },
        now,
      ).window,
    ).toEqual({ from: Date.parse("2026-11-01T00:00:00Z"), to: now });
  });

  test.each([
    { chat: "a" },
    { chatLabel: "Alpha" },
    { chat: "a", chatLabel: "Alpha" },
  ])("rejects combining --all-chats with a single selector: %j", (selector) => {
    expect(() =>
      resolveCollectOptions(
        { db: "h", all: true, allChats: true, ...selector },
        now,
      ),
    ).toThrow("--all-chats cannot be combined");
  });

  test.each([
    { allChats: false, all: true },
    { allChats: true },
    { allChats: true, all: true, last: "1d" },
    { allChats: "true", all: true },
  ])(
    "rejects missing selectors, missing/combined date modes and invalid flags: %j",
    (input) => {
      expect(() => resolveCollectOptions({ db: "h", ...input }, now)).toThrow();
    },
  );

  test("download retains single-chat selection", () => {
    expect(() =>
      resolveDownloadOptions({ db: "h", allChats: true, all: true }, now),
    ).toThrow("Download options");
    expect(() => resolveDownloadOptions({ db: "h", all: true }, now)).toThrow(
      "Choose exactly one",
    );
  });
});

describe("database media chat selection", () => {
  test("allows all chats, a raw ID, or a trimmed label", () => {
    expect(
      resolveDatabaseMediaOptions({ db: "history.sqlite" }).chat,
    ).toBeUndefined();
    expect(
      resolveDatabaseMediaOptions({ db: "history.sqlite", chat: "group" }).chat,
    ).toBe("group");
    expect(
      resolveDatabaseMediaOptions({
        db: "history.sqlite",
        chatLabel: "  Project Alpha  ",
      }).chatLabel,
    ).toBe("Project Alpha");
  });

  test("rejects combined selectors", () => {
    expect(() =>
      resolveDatabaseMediaOptions({
        db: "history.sqlite",
        chat: "group",
        chatLabel: "Project Alpha",
      }),
    ).toThrow("Choose at most one");
  });

  test.each(["", "   ", true, 3])(
    "rejects an invalid label: %s",
    (chatLabel) => {
      expect(() =>
        resolveDatabaseMediaOptions({ db: "history.sqlite", chatLabel }),
      ).toThrow("Database media options");
    },
  );
});

describe("chat selection", () => {
  test("accepts a label without a raw ID and trims surrounding whitespace", () => {
    const options = resolveExportOptions(
      { chatLabel: "  Jane Doe  ", last: "1d" },
      now,
    );
    expect(options.chat).toBeUndefined();
    expect(options.chatLabel).toBe("Jane Doe");
  });

  test.each([{}, { chat: "fixture", chatLabel: "Jane Doe" }])(
    "requires exactly one selector: %j",
    (selection) => {
      expect(() =>
        resolveExportOptions({ ...selection, last: "1d" }, now),
      ).toThrow("Choose exactly one of --chat <id> or --chat-label <label>");
    },
  );

  test.each(["", "   ", true, 3])(
    "rejects an invalid chat label: %s",
    (chatLabel) => {
      expect(() =>
        resolveExportOptions({ chatLabel, last: "1d" }, now),
      ).toThrow("Export options");
    },
  );
});

describe("history page delay options", () => {
  test("uses configured defaults and accepts numeric CLI strings", () => {
    expect(resolveExportOptions({ ...base, last: "1d" }, now)).toMatchObject({
      pageDelayMin: defaultPageDelay.min,
      pageDelayMax: defaultPageDelay.max,
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
          `import { resolveExportOptions } from ${JSON.stringify(fileURLToPath(new URL("../src/command-validation.ts", import.meta.url)))};
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
