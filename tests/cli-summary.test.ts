import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  collectionSummary,
  exportSummary,
  imagesSummary,
  savedChatsExportSummary,
} from "../src/cli-summary.ts";

const names = new Map([["19:a@thread.v2", "Project Alpha"]]);
const chat = (chatId: string, addedMessages: number, completedWindows = 1) => ({
  chatId,
  addedMessages,
  completedWindows,
});

test("single-chat collection names the saved label and pluralizes counts", () => {
  expect(
    collectionSummary({ chats: [chat("19:a@thread.v2", 1)] }, names),
  ).toEqual([
    'Collection complete: 1 new message for "Project Alpha"; 1 window saved.',
  ]);
  expect(
    collectionSummary({ chats: [chat("19:a@thread.v2", 1234, 12)] }, names),
  ).toEqual([
    'Collection complete: 1,234 new messages for "Project Alpha"; 12 windows saved.',
  ]);
});

test("a chat with nothing left to collect is reported as up to date, falling back to its raw ID", () => {
  expect(
    collectionSummary({ chats: [chat("19:unlabeled", 0, 0)] }, names),
  ).toEqual(['Collection complete: "19:unlabeled" was already up to date.']);
});

test("batch collection lists only chats with new messages", () => {
  expect(
    collectionSummary(
      {
        chats: [
          chat("19:a@thread.v2", 3),
          chat("19:b", 0),
          chat("19:c", 0),
          chat("19:d", 1),
        ],
      },
      names,
    ),
  ).toEqual([
    "Collection complete: 4 new messages across 4 chats; 4 windows saved.",
    '  "Project Alpha": 3 new messages',
    '  "19:d": 1 new message',
    "  2 other chats had no new messages.",
  ]);
  expect(
    collectionSummary({ chats: [chat("19:b", 0), chat("19:c", 0)] }, names),
  ).toEqual([
    "Collection complete: 0 new messages across 2 chats; 2 windows saved.",
  ]);
});

test("backups are summarized only when attempted, including failures", () => {
  const chats = [chat("19:a@thread.v2", 1)];
  expect(
    collectionSummary({ chats, backups: { saved: 0, failed: 0 } }, names),
  ).toHaveLength(1);
  expect(
    collectionSummary(
      {
        chats,
        backups: { saved: 2, failed: 1, lastSnapshot: "/data/h.backups/x" },
      },
      names,
    ).at(-1),
  ).toBe("Backups: 2 saved, 1 failed; latest: /data/h.backups/x.");
});

test("image totals are added only across multiple chats", () => {
  const images = {
    saved: 2,
    alreadyDownloaded: 5,
    failed: 1,
    unsupported: 0,
  };
  expect(imagesSummary([images])).toEqual([]);
  expect(imagesSummary([images, images])).toEqual([
    "Images across 2 chats: 4 saved, 10 already downloaded, 2 failed, 0 unsupported.",
  ]);
});

test("exports name the folder people open, not chat.json", () => {
  const root = join("/data", "exports");
  expect(
    exportSummary(
      { output: join(root, "alpha-history", "chat.json"), messages: 7 },
      "Project Alpha",
    ),
  ).toEqual([
    `Export complete: 7 messages written to ${join(root, "alpha-history")}`,
  ]);
  const day = (date: string) => ({
    output: join(root, "project-alpha", date, "chat.json"),
    messages: 1,
  });
  const daily = {
    ...day("2026-11-02"),
    messages: 2,
    days: [day("2026-11-01"), day("2026-11-02")],
  };
  expect(exportSummary(daily, "Project Alpha")).toEqual([
    `Export complete: 2 messages for "Project Alpha" in 2 daily folders under ${join(root, "project-alpha")}`,
  ]);
  expect(
    savedChatsExportSummary({
      messages: 3,
      chats: [
        { chatId: "19:a", ...daily },
        { chatId: "19:b", ...day("2026-11-02"), days: [day("2026-11-02")] },
      ],
    }),
  ).toEqual([
    `Export complete: 3 messages across 2 chats in 3 daily folders under ${root}`,
  ]);
});
