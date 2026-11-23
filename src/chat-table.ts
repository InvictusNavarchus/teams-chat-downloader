import dayjs from "dayjs";

type ListedChat = { id: string; label: string; lastActivity?: string | null };

const genericLabels = new Set(["untitled chat", "unresolved one-to-one chat"]);

const chatCount = (count: number) => `${count} chat${count === 1 ? "" : "s"}`;

/**
 * Renders the chat directory for people choosing what to collect: newest
 * activity first, saved status, and a note where --chat-label cannot select.
 */
export function chatTable(
  chats: ListedChat[],
  saved: ReadonlySet<string>,
  options: { onlyNew?: boolean } = {},
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
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  const lines = [line(header), ...rows.map(line), ""];
  if (options.onlyNew) {
    const [first] = shown;
    lines.push(
      `${shown.length} of ${chatCount(chats.length)} ${shown.length === 1 ? "is" : "are"} not saved. Start collecting one with:`,
    );
    if (first)
      lines.push(
        `  teams collect ${selectable(first) ? `--chat-label ${JSON.stringify(first.label)}` : `--chat ${JSON.stringify(first.id)}`} --all-history --images`,
      );
  } else
    lines.push(
      `${chatCount(chats.length)}; ${savedCount} saved. Use --new to list only unsaved chats.`,
    );
  return lines;
}
