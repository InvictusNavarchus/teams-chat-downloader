import { expect, test } from "bun:test";
import dayjs from "dayjs";
import { chatTable, shellQuote } from "../src/chat-table.ts";

// The table shows local dates, so fixtures are local noon on each date.
const noon = (date: string) => dayjs(`${date}T12:00`).toISOString();

const chats = [
  { id: "19:old", label: "Old project", lastActivity: noon("2026-01-02") },
  { id: "19:none", label: "Quiet chat", lastActivity: null },
  { id: "19:new", label: "Project Beta", lastActivity: noon("2026-11-23") },
  { id: "19:mid", label: "Jane Doe", lastActivity: noon("2026-06-01") },
];

test("lists newest activity first, marks saved chats and counts them", () => {
  const lines = chatTable(chats, new Set(["19:mid"]));
  expect(lines).toEqual([
    "LAST ACTIVITY  SAVED  CHAT          ID",
    "2026-11-23            Project Beta  19:new",
    "2026-06-01     yes    Jane Doe      19:mid",
    "2026-01-02            Old project   19:old",
    "-                     Quiet chat    19:none",
    "",
    "4 chats; 1 saved. Use --new to list only unsaved chats.",
  ]);
});

test("--new shows only unsaved chats and suggests collecting the most recent", () => {
  expect(
    chatTable(chats, new Set(["19:new", "19:old"]), { onlyNew: true }),
  ).toEqual([
    "LAST ACTIVITY  CHAT        ID",
    "2026-06-01     Jane Doe    19:mid",
    "-              Quiet chat  19:none",
    "",
    "2 of 4 chats are not saved. Start collecting one with:",
    "  teams collect --chat-label 'Jane Doe' --all-history --images",
  ]);
});

test("generic and duplicate labels point to --chat, including the suggestion", () => {
  const lines = chatTable(
    [
      {
        id: "19:a",
        label: "Untitled chat",
        lastActivity: noon("2026-11-23"),
      },
      { id: "19:b", label: "Team", lastActivity: noon("2026-11-22") },
      { id: "19:c", label: "TEAM", lastActivity: noon("2026-11-21") },
    ],
    new Set(),
    { onlyNew: true },
  );
  expect(lines.slice(1, 4)).toEqual([
    "2026-11-23     Untitled chat (select with --chat)  19:a",
    "2026-11-22     Team (select with --chat)           19:b",
    "2026-11-21     TEAM (select with --chat)           19:c",
  ]);
  expect(lines.at(-2)).toBe(
    "3 of 3 chats are not saved. Start collecting one with:",
  );
  expect(
    chatTable(chats, new Set(["19:new", "19:old", "19:mid"]), {
      onlyNew: true,
    }).at(-2),
  ).toBe("1 of 4 chats is not saved. Start collecting one with:");
  expect(lines.at(-1)).toBe(
    "  teams collect --chat '19:a' --all-history --images",
  );
});

test("empty and fully saved directories get a plain sentence", () => {
  expect(chatTable([], new Set())).toEqual(["No chats found."]);
  expect(
    chatTable(chats.slice(0, 1), new Set(["19:old"]), { onlyNew: true }),
  ).toEqual(["Every chat is already saved (1 chat)."]);
});

test("suggested commands stay literal when pasted into a shell", () => {
  const suggest = (label: string) =>
    chatTable(
      [{ id: "19:x@thread.v2", label, lastActivity: null }],
      new Set(),
      { onlyNew: true },
    ).at(-1);
  // Single quotes keep $, backticks and ! literal in bash, zsh and fish.
  expect(suggest("Budget $5k `id` !!")).toBe(
    "  teams collect --chat-label 'Budget $5k `id` !!' --all-history --images",
  );
  // fish interprets \\ and \' inside single quotes, so such labels use the ID.
  for (const label of ["Jane's chat", "back\\slash"])
    expect(suggest(label)).toBe(
      "  teams collect --chat '19:x@thread.v2' --all-history --images",
    );
  expect(shellQuote("/data/it's here.sqlite")).toBe(
    "'/data/it'\\''s here.sqlite'",
  );
});

test("an explicit --db is repeated in the suggested command", () => {
  expect(
    chatTable([{ id: "19:x", label: "Alpha", lastActivity: null }], new Set(), {
      onlyNew: true,
      db: "/data/my history.sqlite",
    }).at(-1),
  ).toBe(
    "  teams collect --chat-label 'Alpha' --all-history --images --db '/data/my history.sqlite'",
  );
});
