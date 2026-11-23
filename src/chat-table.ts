import dayjs from "dayjs";
import type { ChatSummary, ImageCounts } from "./history-store.ts";

type ListedChat = { id: string; label: string; lastActivity?: string | null };

const genericLabels = new Set(["untitled chat", "unresolved one-to-one chat"]);

const chatCount = (count: number) => `${count} chat${count === 1 ? "" : "s"}`;

// Suggested commands are pasted into a shell, and labels are chat titles that
// any participant can set. Single quotes stop bash and zsh from expanding $,
// backticks or !, but fish still interprets \\ and \' inside them, so labels
// containing ' or \ are suggested by their raw ID instead.
const labelIsPasteSafe = (label: string) => !/['\\]/.test(label);

/**
 * Repeats an explicit --db in suggested commands so they use the database that
 * was inspected; without one, the default lookup already finds the same file.
 */
const dbArg = (db?: string) =>
  db === undefined ? "" : ` --db ${shellQuote(db)}`;

/** Quotes a value for bash, zsh and fish; IDs and paths only, see above. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Renders the chat directory for people choosing what to collect: newest
 * activity first, saved status, and a note where --chat-label cannot select.
 */
export function chatTable(
  chats: ListedChat[],
  saved: ReadonlySet<string>,
  options: { onlyNew?: boolean; db?: string } = {},
): string[] {
  const shown = chats
    .filter((chat) => !options.onlyNew || !saved.has(chat.id))
    .sort(
      (a, b) =>
        (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") ||
        a.label.localeCompare(b.label),
    );
  const savedCount = chats.filter((chat) => saved.has(chat.id)).length;
  if (!chats.length) return ["No chats found."];
  if (!shown.length)
    return [`Every chat is already saved (${chatCount(chats.length)}).`];

  // Labels that are generic or shared by several chats need --chat <id>.
  const labelCounts = new Map<string, number>();
  for (const chat of chats) {
    const key = chat.label.trim().toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const selectable = (chat: ListedChat) => {
    const key = chat.label.trim().toLowerCase();
    return !genericLabels.has(key) && labelCounts.get(key) === 1;
  };
  const header = options.onlyNew
    ? ["LAST ACTIVITY", "CHAT", "ID"]
    : ["LAST ACTIVITY", "SAVED", "CHAT", "ID"];
  const rows = shown.map((chat) => {
    const activity = chat.lastActivity
      ? dayjs(chat.lastActivity).format("YYYY-MM-DD")
      : "-";
    const label = selectable(chat)
      ? chat.label
      : `${chat.label} (select with --chat)`;
    return options.onlyNew
      ? [activity, label, chat.id]
      : [activity, saved.has(chat.id) ? "yes" : "", label, chat.id];
  });
  const lines = [...columns(header, rows), ""];
  if (options.onlyNew) {
    const [first] = shown;
    lines.push(
      `${shown.length} of ${chatCount(chats.length)} ${shown.length === 1 ? "is" : "are"} not saved. Start collecting one with:`,
    );
    if (first)
      lines.push(
        `  teams collect ${selectable(first) && labelIsPasteSafe(first.label) ? `--chat-label '${first.label}'` : `--chat ${shellQuote(first.id)}`} --all-history --images${dbArg(options.db)}`,
      );
  } else
    lines.push(
      `${chatCount(chats.length)}; ${savedCount} saved. Use --new to list only unsaved chats.`,
    );
  return lines;
}

/**
 * Renders what the collection holds, offline: saved labels, collected range,
 * internal gaps, and images still to download.
 */
export function statusTable(
  chats: ChatSummary[],
  images: ImageCounts,
  database: string,
  options: { db?: string; imagesIndexed?: boolean } = {},
): string[] {
  const db = dbArg(options.db);
  // Version 1 collections predate the image index; read-only status cannot
  // migrate them, so their image counts are unknown rather than zero.
  const indexed = options.imagesIndexed ?? true;
  if (!chats.length)
    return [
      `No saved chats in ${database}.`,
      `Run teams chats --new${db} and follow the collect command it prints.`,
    ];
  const sorted = [...chats].sort(
    (a, b) =>
      (a.label ?? "").localeCompare(b.label ?? "") ||
      a.chatId.localeCompare(b.chatId),
  );
  const rows = sorted.map((chat) => [
    chat.label ?? "(no saved label)",
    chat.messages.toLocaleString("en-US"),
    chat.coverage
      ? `${chat.coverage.from <= 1 ? "all history" : dayjs(chat.coverage.from).format("YYYY-MM-DD")} to ${dayjs(chat.coverage.to).format("YYYY-MM-DD HH:mm")}`
      : "nothing yet",
    chat.gaps ? String(chat.gaps) : "",
    indexed ? String(chat.images.pending + chat.images.failed || "") : "?",
    chat.chatId,
  ]);
  const lines = [
    ...columns(
      [
        "CHAT",
        "MESSAGES",
        "COLLECTED (LOCAL TIME)",
        "GAPS",
        "IMAGES TO GET",
        "ID",
      ],
      rows,
    ),
    "",
    `${chats.length} saved chat${chats.length === 1 ? "" : "s"} in ${database}.`,
  ];
  if (chats.some((chat) => chat.gaps))
    lines.push(
      `Chats with gaps are retried by catch-up: teams collect --all-chats${db}`,
    );
  if (!indexed)
    lines.push(
      `Images are not indexed in this older database yet; run teams images${db} once to index and download them.`,
    );
  const toGet = images.pending + images.failed;
  if (toGet)
    lines.push(
      `${toGet} image${toGet === 1 ? "" : "s"} still to download${images.failed ? ` (${images.failed} failed before)` : ""}: teams images${db}`,
    );
  return lines;
}

function columns(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)];
}
