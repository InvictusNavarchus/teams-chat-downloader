import { expect, test } from "bun:test";
import type { Archive, Message } from "../src/archive.ts";
import { renderMarkdown as renderTranscript } from "../src/markdown.ts";
import { archive } from "./fixtures/archive.ts";

function renderMarkdown(source: Archive, timeZone = "UTC"): string {
  return renderTranscript(source, timeZone);
}

function message(
  content: string,
  extra: Record<string, unknown> = {},
): Message {
  return {
    id: "1",
    originalarrivaltime: "2026-11-01T12:00:00Z",
    messagetype: "RichText/Html",
    content,
    ...extra,
  };
}

test("rich text preserves emphasis, lists, quotes, code, and links", () => {
  const result = renderMarkdown(
    archive([
      message(
        '<p>Hello <strong>world</strong> &amp; <em>friends</em>.</p><ul><li>First</li><li>Second</li></ul><blockquote><p>Quoted reply</p></blockquote><p><code>x &lt; 2</code></p><pre><code class="language-ts">const x = 1;\n```\n</code></pre><p><a href="https://example.test/a(b)?x=1&amp;y=2">Example</a></p>',
        { imdisplayname: "Example sender" },
      ),
    ]),
  );
  expect(result).toContain("Hello **world** &amp; _friends_.");
  expect(result).toContain("-   First\n-   Second");
  expect(result).toContain("> Quoted reply");
  expect(result).toContain("`x < 2`");
  expect(result).toContain("````ts\nconst x = 1;\n```\n````");
  expect(result).toContain("[Example](https://example.test/a%28b%29?x=1&y=2)");
  expect(result).toContain("**Example sender · 12:00**");
});

test("Text messages preserve literal HTML and Markdown without interpreting them", () => {
  const result = renderMarkdown(
    archive([
      message(
        "<b>literal</b> &amp; **not bold**\n# not a heading\n![image](https://example.test/a)",
        {
          messagetype: "Text",
          contenttype: "html",
        },
      ),
    ]),
  );
  expect(result).toContain(
    "&lt;b&gt;literal&lt;/b&gt; &amp;amp; \\*\\*not bold\\*\\*",
  );
  expect(result).toContain("  \n\\# not a heading");
  expect(result).toContain("!\\[image\\]");
  expect(result).not.toContain("<b>");
});

test("source code language attributes cannot break Markdown fences", () => {
  const result = renderMarkdown(
    archive([
      message(
        '<pre><code class="language-js```">&lt;script&gt;doNotRun()&lt;/script&gt;</code></pre>',
      ),
    ]),
  );
  expect(result).toContain("```js\n<script>doNotRun()</script>\n```");
  expect(result).not.toContain("```js```");
});

test("preformatted text without a code child remains preformatted", () => {
  const result = renderMarkdown(
    archive([message("<pre>one\n  two &amp; three</pre>")]),
  );
  expect(result).toContain("```\none\n  two & three\n```");
});

test("HTML content type is supported when message type is absent", () => {
  const result = renderMarkdown(
    archive([
      message("<strong>Bold</strong>", {
        messagetype: null,
        contenttype: "text/html",
      }),
    ]),
  );
  expect(result).toContain("**Bold**");
});

test("images become explicit placeholders without copying authenticated URLs", () => {
  const result = renderMarkdown(
    archive([
      message(
        '<p>Photo:</p><img src="https://media.example.test/photo?token=secret" alt="A &amp; B"><img src="https://media.example.test/other">',
        {
          amsreferences: [{ opaqueReference: "secret-reference" }],
        },
      ),
    ]),
  );
  expect(result).toContain("\\[Image not downloaded: A &amp; B\\]");
  expect(result).toContain("\\[Image not downloaded\\]");
  expect(result).not.toContain("Media references retained in JSON");
  expect(result).not.toContain("\\[Media not downloaded\\]");
  expect(result).not.toContain("media.example.test");
  expect(result).not.toContain("secret");
});

test("untrusted HTML cannot introduce raw tags or executable link destinations", () => {
  const result = renderMarkdown(
    archive([
      message(
        '<script>script-secret</script><style>style-secret</style><iframe src="https://example.test">frame-secret</iframe><p>&lt;img src=x onerror=alert(1)&gt;</p><a href="javascript:alert(1)">bad link</a><a href="data:text/html,secret">data link</a><a href="file:///tmp/secret">local link</a><a href="https://user:password@example.test/">credential link</a><a href="mailto:hello@example.test">Email</a>',
        {
          imdisplayname: "<script>sender</script>\n## injected",
        },
      ),
    ]),
  );
  expect(result).toContain("bad link");
  expect(result).toContain("[Email](mailto:hello@example.test)");
  expect(result).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(result).toContain("&lt;script&gt;sender&lt;/script&gt; ## injected");
  for (const forbidden of [
    "<script",
    "<img",
    "script-secret",
    "style-secret",
    "frame-secret",
    "javascript:",
    "data:text",
    "file:///",
    "password",
  ]) {
    expect(result).not.toContain(forbidden);
  }
});

test("unknown types and missing content remain visible with sender fallbacks", () => {
  const result = renderMarkdown(
    archive([
      message("<event>Member joined</event>", {
        messagetype: "ThreadActivity/AddMember",
        from: "8:live:example",
      }),
      message("", {
        id: "2",
        messagetype: "Future/Unknown",
        fromDisplayNameInToken: "Historical name",
        content: { opaque: true },
      }),
      message("", { id: "3", messagetype: null }),
    ]),
  );
  expect(result).not.toContain("Type:");
  expect(result).toContain("&lt;event&gt;Member joined&lt;/event&gt;");
  expect(result).toContain("**8:live:example · 12:00**");
  expect(result).toContain("**Historical name · 12:00**");
  expect(result).toContain("**Unknown sender · 12:00**");
  expect(result).toContain("_No text available._");
});

test("conversion sorts deterministically without changing source records", () => {
  const source = archive([
    message("Later", { id: "z", originalarrivaltime: "2026-11-01T15:00:00Z" }),
    message("Tie B", { id: "b" }),
    message("Tie A", { id: "a", newField: { retained: true } }),
  ]);
  const before = JSON.stringify(source);
  const result = renderMarkdown(source);
  expect(result.indexOf("Tie A")).toBeLessThan(result.indexOf("Tie B"));
  expect(result.indexOf("Tie B")).toBeLessThan(result.indexOf("Later"));
  expect(JSON.stringify(source)).toBe(before);
  expect(renderMarkdown(source)).toBe(result);
});

test("an empty export explains the empty period", () => {
  const result = renderMarkdown(archive([]));
  expect(result).toContain("Messages: 0");
  expect(result).toContain("_No messages in this period._");
});

function chatMessage(
  id: string,
  sender: string,
  time: string,
  content: string,
): Message {
  return message(content, {
    id,
    from: `8:live:${sender.toLowerCase()}`,
    imdisplayname: sender,
    originalarrivaltime: `2026-11-01T${time}Z`,
  });
}

test("a transcript groups speaker turns under daily headings without record metadata", () => {
  const source = archive([
    chatMessage(
      "first-id",
      "Alice",
      "09:15:00",
      "<p>Can you check the latest version?</p>",
    ),
    chatMessage(
      "second-id",
      "Alice",
      "09:17:00",
      "<p>I've updated the introduction.</p>",
    ),
    chatMessage(
      "third-id",
      "Bob",
      "09:20:00",
      "<p>Looks good.</p><blockquote>Move setup above the examples.</blockquote>",
    ),
  ]);
  const before = JSON.stringify(source);
  expect(renderMarkdown(source)).toBe(`# Chat export

Period: 1 November 2026, 00:00 – 2 November 2026, 00:00 (end exclusive)

Timezone: UTC · Messages: 3

## 1 November 2026

**Alice · 09:15–09:17**

Can you check the latest version?

I've updated the introduction.

**Bob · 09:20**

Looks good.

> Move setup above the examples.
`);
  expect(JSON.stringify(source)).toBe(before);
});

test("grouping allows five minutes between messages and splits after longer pauses", () => {
  const result = renderMarkdown(
    archive([
      chatMessage("1", "Alice", "12:00:00", "First"),
      chatMessage("2", "Alice", "12:05:00", "Second"),
      chatMessage("3", "Alice", "12:10:00.001", "After a pause"),
    ]),
  );
  expect(result).toContain("**Alice · 12:00–12:05**\n\nFirst\n\nSecond");
  expect(result).toContain("**Alice · 12:10**\n\nAfter a pause");
});

test("returning to a speaker starts a new turn even within five minutes", () => {
  const result = renderMarkdown(
    archive([
      chatMessage("1", "Alice", "12:00:00", "Question"),
      chatMessage("2", "Bob", "12:01:00", "Answer"),
      chatMessage("3", "Alice", "12:02:00", "Thanks"),
    ]),
  );
  expect(result).toContain("**Alice · 12:00**\n\nQuestion");
  expect(result).toContain("**Bob · 12:01**\n\nAnswer");
  expect(result).toContain("**Alice · 12:02**\n\nThanks");
});

test("matching names cannot merge different authors or messages without sender identity", () => {
  const result = renderMarkdown(
    archive([
      chatMessage("1", "Alex", "12:00:00", "First author"),
      {
        ...chatMessage("2", "Alex", "12:01:00", "Second author"),
        from: "8:live:other-alex",
      },
      {
        ...chatMessage("3", "Alex", "12:02:00", "Missing identity"),
        from: null,
      },
      {
        ...chatMessage("4", "Alex", "12:03:00", "Still missing identity"),
        from: null,
      },
    ]),
  );
  expect(result).toContain("**Alex · 12:00**\n\nFirst author");
  expect(result).toContain("**Alex · 12:01**\n\nSecond author");
  expect(result).toContain("**Alex · 12:02**\n\nMissing identity");
  expect(result).toContain("**Alex · 12:03**\n\nStill missing identity");
});

test("calendar boundaries use the selected timezone and always start a new turn", () => {
  const result = renderMarkdown(
    archive([
      chatMessage("1", "Alice", "16:59:00", "Before midnight"),
      chatMessage("2", "Alice", "17:01:00", "After midnight"),
    ]),
    "Asia/Jakarta",
  );
  expect(result).toContain(
    "## 1 November 2026\n\n**Alice · 23:59**\n\nBefore midnight",
  );
  expect(result).toContain(
    "## 2 November 2026\n\n**Alice · 00:01**\n\nAfter midnight",
  );
  expect(result.match(/Timezone:/g)).toHaveLength(1);
});

test("crossing UTC midnight does not split a turn on the same local day", () => {
  const source = archive([
    chatMessage("1", "Alice", "23:59:00", "First"),
    {
      ...chatMessage("2", "Alice", "00:01:00", "Second"),
      originalarrivaltime: "2026-11-02T00:01:00Z",
    },
  ]);
  source.window.toExclusive = "2026-11-03T00:00:00Z";
  const result = renderMarkdown(source, "Asia/Jakarta");
  expect(result).toContain(
    "## 2 November 2026\n\n**Alice · 06:59–07:01**\n\nFirst\n\nSecond",
  );
  expect(result.match(/^## /gm)).toHaveLength(1);
});

test("clock rollback does not produce a backwards time range", () => {
  const result = renderMarkdown(
    archive([
      chatMessage("1", "Alice", "05:59:00", "Before rollback"),
      chatMessage("2", "Alice", "06:01:00", "After rollback"),
    ]),
    "America/New_York",
  );
  expect(result).toContain("**Alice · 01:59**\n\nBefore rollback");
  expect(result).toContain("**Alice · 01:01**\n\nAfter rollback");
  expect(result).not.toContain("01:59–01:01");
});

test("messages in the same minute share a single compact time label", () => {
  const result = renderMarkdown(
    archive([
      chatMessage("1", "Alice", "12:00:01", "First"),
      chatMessage("2", "Alice", "12:00:59", "Second"),
    ]),
  );
  expect(result).toContain("**Alice · 12:00**\n\nFirst\n\nSecond");
  expect(result).not.toContain("12:00–12:00");
});

test("system events stay separate from surrounding chat messages", () => {
  const result = renderMarkdown(
    archive([
      chatMessage("1", "Alice", "12:00:00", "Before event"),
      {
        ...chatMessage("2", "Alice", "12:01:00", "Member joined"),
        messagetype: "ThreadActivity/AddMember",
      },
      chatMessage("3", "Alice", "12:02:00", "After event"),
    ]),
  );
  expect(result).toContain("**Alice · 12:00**\n\nBefore event");
  expect(result).toContain("**Alice · 12:01**\n\nMember joined");
  expect(result).toContain("**Alice · 12:02**\n\nAfter event");
  expect(result).not.toContain("ThreadActivity/AddMember");
});

test("media references without inline images get a readable placeholder", () => {
  const result = renderMarkdown(
    archive([
      message("", {
        amsreferences: [{ opaqueReference: "private-reference" }],
      }),
    ]),
  );
  expect(result).toContain("\\[Media not downloaded\\]");
  expect(result).not.toContain("private-reference");
  expect(result).not.toContain("_No text available._");
});
