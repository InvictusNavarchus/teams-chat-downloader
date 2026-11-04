import type { Archive, Message } from "../../src/archive.ts";

export function archive(
  messages: Message[] = [
    {
      id: "1",
      originalarrivaltime: "2026-11-01T12:00:00Z",
      imdisplayname: "Example sender",
      from: "8:live:example",
      messagetype: "RichText/Html",
      content: "<p>Hello <strong>world</strong> &amp; friends.</p>",
      futureField: { preserved: true },
    },
  ],
): Archive {
  return {
    version: 1,
    status: "complete",
    accountId: "fixture",
    chatId: "fixture-chat",
    window: {
      from: "2026-11-01T00:00:00Z",
      toExclusive: "2026-11-02T00:00:00Z",
      timestampField: "originalarrivaltime",
    },
    completedAt: "2026-11-02T00:00:00Z",
    history: {
      pages: 1,
      records: messages.length,
      duplicates: 0,
      uniqueMessages: messages.length,
      serviceReportedExhaustion: true,
      duplicatePolicy: "identical records deduplicated; conflicts fail",
    },
    requests: {
      total: 1,
      history: 1,
      directory: 0,
      profiles: 0,
      retries: 0,
      scope: "HTTP client attempts; browser traffic excluded",
    },
    media: { status: "not-downloaded" },
    messages,
    futureManifestField: { preserved: true },
  };
}
