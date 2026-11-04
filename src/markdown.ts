import TurndownService from "turndown";
import type { Archive, Message } from "./archive.ts";

export function renderMarkdown(archive: Archive): string {
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    preformattedCode: true,
  });
  const originalEscape = converter.escape.bind(converter);
  const escape = (value: string) =>
    value
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) =>
        originalEscape(
          line
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;"),
        ).replace(/\|/g, "\\|"),
      )
      .join("\n");
  const inline = (value: string) => escape(value.replace(/\s+/g, " ").trim());
  converter.escape = escape;
  converter.remove([
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
  ]);
  converter.addRule("code-block", {
    filter: "pre",
    replacement: (_content, node) => {
      const code = (node.textContent ?? "")
        .replace(/\r\n?/g, "\n")
        .replace(/\n$/, "");
      let fence = "```";
      for (const run of code.match(/`+/g) ?? []) {
        if (run.length >= fence.length) fence = "`".repeat(run.length + 1);
      }
      // Source class names must not inject Markdown fence syntax.
      const language =
        node.firstElementChild
          ?.getAttribute("class")
          ?.match(/\blanguage-([\w+-]+)/)?.[1] ?? "";
      return `\n\n${fence}${language}\n${code}\n${fence}\n\n`;
    },
  });
  converter.addRule("unavailable-image", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = node.getAttribute("alt");
      return `\\[Image not downloaded${alt ? `: ${inline(alt)}` : ""}\\]`;
    },
  });
  converter.addRule("safe-link", {
    filter: "a",
    replacement: (content, node) => {
      let url: URL;
      try {
        url = new URL(node.getAttribute("href") ?? "");
      } catch {
        return content;
      }
      if (
        !["http:", "https:", "mailto:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return content;
      const destination = url.href.replace(/[<>()\\\s]/g, (character) =>
        encodeURIComponent(character).replace("(", "%28").replace(")", "%29"),
      );
      return `[${content}](${destination})`;
    },
  });

  const sections = [
    "# Chat export",
    `Chat: ${inline(archive.chatId)}\n\nPeriod: ${inline(archive.window.from)} (inclusive) to ${inline(archive.window.toExclusive)} (exclusive)\n\nMessages: ${archive.messages.length}`,
    "Media files were not downloaded. Image placeholders refer to source records in the JSON export.",
  ];
  // Sort a copy so conversion never changes the source records or their order.
  const messages = [...archive.messages].sort(
    (a, b) =>
      Date.parse(a.originalarrivaltime) - Date.parse(b.originalarrivaltime) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  for (const message of messages) {
    const sender =
      field(message, "imdisplayname") ||
      field(message, "fromDisplayNameInToken") ||
      field(message, "from") ||
      "Unknown sender";
    const type = field(message, "messagetype");
    const contentType = field(message, "contenttype").toLowerCase();
    const source = field(message, "content");
    const html =
      type.toLowerCase() === "richtext/html" ||
      (!type && ["html", "text/html"].includes(contentType));
    const content = html
      ? converter.turndown(source)
      : escape(source).replace(/\n/g, "  \n");
    const details = [`Message ID: ${inline(message.id)}`];
    if (type) details.push(`Type: ${inline(type)}`);
    if (
      Array.isArray(message.amsreferences) &&
      message.amsreferences.length > 0
    )
      details.push("Media references retained in JSON; files not downloaded.");
    sections.push(
      `## ${inline(message.originalarrivaltime)} — ${inline(sender)}\n\n${details.join("\n\n")}\n\n${content.trim() || "_No renderable text; see the JSON source._"}`,
    );
  }
  if (messages.length === 0) sections.push("_No messages in this period._");
  return `${sections.join("\n\n")}\n`;
}

function field(message: Message, key: string): string {
  const value = message[key];
  return typeof value === "string" ? value : "";
}
