import TurndownService from "turndown";
import type { Archive, Message } from "./archive.ts";

type Turn = {
  day: string;
  sender: string;
  senderId: string;
  start: number;
  end: number;
  bodies: string[];
};

export function renderMarkdown(
  archive: Archive,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const dateFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const timeFormat = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const boundary = (value: string) => {
    const time = Date.parse(value);
    return `${dateFormat.format(time)}, ${timeFormat.format(time)}`;
  };
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
  let hasInlineImage = false;
  converter.addRule("unavailable-image", {
    filter: "img",
    replacement: (_content, node) => {
      hasInlineImage = true;
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
    `Period: ${boundary(archive.window.from)} – ${boundary(archive.window.toExclusive)} (end exclusive)`,
    `Timezone: ${inline(timeZone)} · Messages: ${archive.messages.length}`,
  ];
  // Sort a copy so conversion never changes the source records or their order.
  const messages = [...archive.messages].sort(
    (a, b) =>
      Date.parse(a.originalarrivaltime) - Date.parse(b.originalarrivaltime) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const turns: Turn[] = [];
  for (const message of messages) {
    const from = field(message, "from").trim();
    const sender =
      field(message, "imdisplayname").trim() ||
      field(message, "fromDisplayNameInToken").trim() ||
      from ||
      "Unknown sender";
    const type = field(message, "messagetype");
    const contentType = field(message, "contenttype").toLowerCase();
    const source = field(message, "content");
    const html =
      type.toLowerCase() === "richtext/html" ||
      (!type && ["html", "text/html"].includes(contentType));
    hasInlineImage = false;
    let content = (
      html ? converter.turndown(source) : escape(source).replace(/\n/g, "  \n")
    ).trim();
    if (
      !hasInlineImage &&
      Array.isArray(message.amsreferences) &&
      message.amsreferences.length > 0
    )
      content = [content, "\\[Media not downloaded\\]"]
        .filter(Boolean)
        .join("\n\n");

    const time = Date.parse(message.originalarrivaltime);
    const day = dateFormat.format(time);
    // Unknown authors and non-chat records must not be folded into a speaker turn.
    const senderId = ["", "text", "richtext/html"].includes(type.toLowerCase())
      ? from
      : "";
    const previous = turns.at(-1);
    const body = content || "_No text available._";
    if (
      previous &&
      senderId &&
      previous.senderId === senderId &&
      previous.sender === sender &&
      previous.day === day &&
      time - previous.end <= 5 * 60_000 &&
      // A daylight-saving clock rollback starts a new turn, not a backwards range.
      timeFormat.format(time) >= timeFormat.format(previous.end)
    ) {
      previous.end = time;
      previous.bodies.push(body);
    } else {
      turns.push({
        day,
        sender,
        senderId,
        start: time,
        end: time,
        bodies: [body],
      });
    }
  }
  let day: string | undefined;
  for (const turn of turns) {
    if (turn.day !== day) {
      sections.push(`## ${turn.day}`);
      day = turn.day;
    }
    const start = timeFormat.format(turn.start);
    const end = timeFormat.format(turn.end);
    const time = start === end ? start : `${start}–${end}`;
    sections.push(
      `**${inline(turn.sender)} · ${time}**\n\n${turn.bodies.join("\n\n")}`,
    );
  }
  if (messages.length === 0) sections.push("_No messages in this period._");
  return `${sections.join("\n\n")}\n`;
}

function field(message: Message, key: string): string {
  const value = message[key];
  return typeof value === "string" ? value : "";
}
