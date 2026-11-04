import { expect, test } from "bun:test";
import type { Message } from "../src/archive.ts";
import { renderMarkdown } from "../src/markdown.ts";
import { archive } from "./fixtures/archive.ts";

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
  expect(result).toContain("2026-11-01T12:00:00Z — Example sender");
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
  expect(result).toContain("Media references retained in JSON");
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
  expect(result).toContain("Type: ThreadActivity/AddMember");
  expect(result).toContain("&lt;event&gt;Member joined&lt;/event&gt;");
  expect(result).toContain("— 8:live:example");
  expect(result).toContain("— Historical name");
  expect(result).toContain("— Unknown sender");
  expect(result).toContain("_No renderable text; see the JSON source._");
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
