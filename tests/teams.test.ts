import { describe, expect, test } from "bun:test";
import type { Credentials } from "../src/credentials.ts";
import { createHttp, requestStats } from "../src/http.ts";
import {
  type HistoryPageProgress,
  historyProgress,
  listChats,
  readHistory,
} from "../src/teams.ts";

const chat = "synthetic:/chat?@thread.v2";
const credentials: Credentials = {
  version: 1,
  accountId: "fixture",
  historyAuthentication: "history-fixture",
  directoryToken: "directory-fixture",
};
const window = { from: 1785542400000, to: 1786147200000 };
const message = (id: string, time = "2026-08-03T00:00:00Z") => ({
  id,
  originalarrivaltime: time,
  content: "synthetic",
  extra: { keep: true },
});
const continuation = (state: string, id = chat) =>
  `https://msgapi.teams.live.com/v1/users/ME/conversations/${encodeURIComponent(id)}/messages?syncState=${state}`;
const page = (messages: unknown[], backwardLink?: string) =>
  Response.json({ messages, _metadata: backwardLink ? { backwardLink } : {} });

describe("bounded history", () => {
  test("seeks directly, preserves bounds on a short continuing page, sorts and preserves fields", async () => {
    const stats = requestStats();
    const progress = historyProgress();
    const calls: URL[] = [];
    const http = createHttp({
      stats,
      fetch: async (request) => {
        const url = new URL(request.url);
        calls.push(url);
        expect(url.searchParams.get("startTime")).toBe(String(window.from));
        expect(url.searchParams.get("endTime")).toBe(String(window.to - 1));
        expect(url.searchParams.get("pageSize")).toBe("200");
        expect(request.headers.get("Authentication")).toBe("history-fixture");
        expect(request.headers.has("x-skypetoken")).toBe(false);
        expect(request.redirect).toBe("manual");
        return calls.length === 1
          ? page(
              [
                message("b", "2026-08-05T00:00:00Z"),
                message("c", "2026-08-02T00:00:00Z"),
              ],
              continuation("opaque"),
            )
          : page([
              message("a", "2026-08-02T00:00:00Z"),
              message("b", "2026-08-05T00:00:00Z"),
            ]);
      },
    });
    const updates: HistoryPageProgress[] = [];
    const messages = await readHistory(
      http,
      credentials,
      chat,
      window,
      progress,
      (update) => updates.push(update),
    );
    expect(calls[0]?.searchParams.has("syncState")).toBe(false);
    expect(calls[0]?.pathname).toContain(encodeURIComponent(chat));
    expect(calls[1]?.searchParams.get("syncState")).toBe("opaque");
    expect(messages.map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(messages[0]?.extra).toEqual({ keep: true });
    expect(stats).toEqual({
      total: 2,
      history: 2,
      directory: 0,
      profiles: 0,
      media: 0,
      retries: 0,
    });
    expect(progress).toEqual({ pages: 2, records: 4, duplicates: 1 });
    expect(updates).toEqual([
      {
        page: 1,
        pageMessages: 2,
        totalMessages: 2,
        earliestTimestamp: "2026-08-02T00:00:00Z",
        hasMore: true,
      },
      {
        page: 2,
        pageMessages: 2,
        totalMessages: 3,
        earliestTimestamp: "2026-08-02T00:00:00Z",
        hasMore: false,
      },
    ]);
  });

  test("accepts a valid empty window as exhausted", async () => {
    const http = createHttp({
      stats: requestStats(),
      fetch: async () => page([]),
    });
    expect(await readHistory(http, credentials, chat, window)).toEqual([]);
  });

  test.each(
    [
      "https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/",
      "https://msgapi.teams.live.com/v1/users/ME/conversations/",
    ].flatMap((prefix) =>
      [
        "19:example@thread.v2",
        "19%3Aexample%40thread.v2",
        "19%3aexample%40thread.v2",
        "19:example%40thread.v2",
      ].map((segment) => `${prefix}${segment}/messages?syncState=opaque`),
    ),
  )("follows equivalent chat-ID encodings: %s", async (link) => {
    const stats = requestStats();
    const http = createHttp({
      stats,
      fetch: async (request) => {
        const url = new URL(request.url);
        expect(request.headers.get("Authentication")).toBe("history-fixture");
        expect(url.searchParams.get("startTime")).toBe(String(window.from));
        expect(url.searchParams.get("endTime")).toBe(String(window.to - 1));
        if (stats.history === 1) return page([message("a")], link);
        expect(url.searchParams.get("syncState")).toBe("opaque");
        return page([message("b")]);
      },
    });
    const messages = await readHistory(
      http,
      credentials,
      "19:example@thread.v2",
      window,
    );
    expect(messages.map((item) => item.id)).toEqual(["a", "b"]);
    expect(stats.history).toBe(2);
  });

  test.each([
    "https://attacker.invalid/messages",
    continuation("opaque", "different-chat"),
    continuation("opaque").replace("https:", "http:"),
    continuation("opaque").replace("https://", "https://user:password@"),
    `${continuation("opaque")}#fragment`,
    continuation("opaque", chat.replace("synthetic", "Synthetic")),
    continuation("opaque", encodeURIComponent(chat)),
    continuation("opaque").replace(encodeURIComponent(chat), "%ZZ"),
    continuation("opaque").replace("/messages?", "/extra/messages?"),
    continuation("opaque").replace("/v1/", "/api/chatsvc/consumer/v1/"),
    continuation("opaque").replace("msgapi.teams.live.com", "teams.live.com"),
  ])(
    "rejects an unsafe continuation before forwarding credentials: %s",
    async (url) => {
      const stats = requestStats();
      const http = createHttp({
        stats,
        fetch: async () => page([message("a")], url),
      });
      await expect(
        readHistory(http, credentials, chat, window),
      ).rejects.toThrow("Refused");
      expect(stats.total).toBe(1);
    },
  );

  test("detects a repeated cursor", async () => {
    let calls = 0;
    const stats = requestStats();
    const http = createHttp({
      stats,
      fetch: async () => page([message(String(++calls))], continuation("same")),
    });
    await expect(readHistory(http, credentials, chat, window)).rejects.toThrow(
      "repeated continuation",
    );
    expect(stats.total).toBe(2);
  });

  test("fails on a continuation without progress", async () => {
    const http = createHttp({
      stats: requestStats(),
      fetch: async () => page([], continuation("next")),
    });
    await expect(readHistory(http, credentials, chat, window)).rejects.toThrow(
      "no progress",
    );
  });

  test.each([
    { messages: [] },
    { messages: "not-an-array", _metadata: {} },
    { messages: [{ id: "missing-time" }], _metadata: {} },
    { messages: [message("a")], _metadata: { backwardLink: null } },
  ])(
    "rejects invalid response shapes instead of reporting an empty result",
    async (response) => {
      const http = createHttp({
        stats: requestStats(),
        fetch: async () => Response.json(response),
      });
      await expect(
        readHistory(http, credentials, chat, window),
      ).rejects.toThrow("History response");
    },
  );

  test("does not silently pick a conflicting revision", async () => {
    const http = createHttp({
      stats: requestStats(),
      fetch: async () =>
        page([message("a"), { ...message("a"), content: "edited" }]),
    });
    await expect(readHistory(http, credentials, chat, window)).rejects.toThrow(
      "conflicting records",
    );
  });

  test("rejects a message exactly at the exclusive end", async () => {
    const http = createHttp({
      stats: requestStats(),
      fetch: async () =>
        page([message("a", new Date(window.to).toISOString())]),
    });
    await expect(readHistory(http, credentials, chat, window)).rejects.toThrow(
      "outside",
    );
  });

  test("includes the exact start and last millisecond", async () => {
    const http = createHttp({
      stats: requestStats(),
      fetch: async () =>
        page([
          message("a", new Date(window.from).toISOString()),
          message("b", new Date(window.to - 1).toISOString()),
        ]),
    });
    expect(
      (await readHistory(http, credentials, chat, window)).map(
        (item) => item.id,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("directory", () => {
  test("uses only the directory token and shows truthful label fallbacks", async () => {
    const stats = requestStats();
    const http = createHttp({
      stats,
      fetch: async (request) => {
        expect(request.headers.get("x-skypetoken")).toBe("directory-fixture");
        expect(request.headers.has("Authentication")).toBe(false);
        expect(
          new URL(request.url).searchParams.get("enableMembershipSummary"),
        ).toBe("true");
        return Response.json({
          chats: [
            { id: "dm", title: "", isOneOnOne: true },
            { id: "group", title: "Example" },
          ],
          metadata: { hasMoreChats: false, isPartialData: false },
        });
      },
    });
    const chats = await listChats(http, credentials);
    expect(chats[0]?.label).toBe("Unresolved one-to-one chat");
    expect(chats[1]?.label).toBe("Example");
    expect(stats).toEqual({
      total: 1,
      history: 0,
      directory: 1,
      profiles: 0,
      media: 0,
      retries: 0,
    });
  });

  test("surfaces partial listing rather than returning a complete-looking list", async () => {
    const http = createHttp({
      stats: requestStats(),
      fetch: async () =>
        Response.json({
          chats: [],
          metadata: { hasMoreChats: true, isPartialData: false },
        }),
    });
    await expect(listChats(http, credentials)).rejects.toThrow("partial");
  });
});
