import { dirname } from "node:path";

// Final command summaries for people. Full JSON results go to the invocation log.

type ChatCollection = {
  chatId: string;
  completedWindows: number;
  addedMessages: number;
};
type Collection = {
  chats: ChatCollection[];
  backups?: { saved: number; failed: number; lastSnapshot?: string };
};
type Images = {
  saved: number;
  alreadyDownloaded: number;
  failed: number;
  unsupported: number;
};
type ArchiveExport = { output: string; messages: number };
type DailyExport = ArchiveExport & { days: ArchiveExport[] };

/** Chat names keyed by raw ID; IDs without a saved label are shown as-is. */
export type ChatNames = ReadonlyMap<string, string>;

function count(value: number, noun: string): string {
  return `${value.toLocaleString("en-US")} ${noun}${value === 1 ? "" : "s"}`;
}

function name(names: ChatNames, chatId: string): string {
  return JSON.stringify(names.get(chatId) ?? chatId);
}

export function collectionSummary(
  result: Collection,
  names: ChatNames,
): string[] {
  const lines: string[] = [];
  const [only] = result.chats;
  if (result.chats.length === 1 && only) {
    lines.push(
      only.completedWindows === 0
        ? `Collection complete: ${name(names, only.chatId)} was already up to date.`
        : `Collection complete: ${count(only.addedMessages, "new message")} for ${name(names, only.chatId)}; ${count(only.completedWindows, "window")} saved.`,
    );
  } else {
    const added = result.chats.reduce(
      (sum, chat) => sum + chat.addedMessages,
      0,
    );
    const windows = result.chats.reduce(
      (sum, chat) => sum + chat.completedWindows,
      0,
    );
    lines.push(
      `Collection complete: ${count(added, "new message")} across ${count(result.chats.length, "chat")}; ${count(windows, "window")} saved.`,
    );
    const updated = result.chats.filter((chat) => chat.addedMessages > 0);
    for (const chat of updated)
      lines.push(
        `  ${name(names, chat.chatId)}: ${count(chat.addedMessages, "new message")}`,
      );
    const unchanged = result.chats.length - updated.length;
    if (updated.length && unchanged)
      lines.push(`  ${count(unchanged, "other chat")} had no new messages.`);
  }
  const backups = result.backups;
  if (backups && (backups.saved || backups.failed))
    lines.push(
      `Backups: ${backups.saved} saved${backups.failed ? `, ${backups.failed} failed` : ""}${backups.lastSnapshot ? `; latest: ${backups.lastSnapshot}` : ""}.`,
    );
  return lines;
}

/** Totals across chats; each chat's own image line is printed as it finishes. */
export function imagesSummary(images: Images[]): string[] {
  if (images.length < 2) return [];
  const total = (key: keyof Images) =>
    images.reduce((sum, chat) => sum + chat[key], 0);
  return [
    `Images across ${count(images.length, "chat")}: ${total("saved")} saved, ${total("alreadyDownloaded")} already downloaded, ${total("failed")} failed, ${total("unsupported")} unsupported.`,
  ];
}

export function exportSummary(
  result: ArchiveExport | DailyExport,
  chat: string,
): string[] {
  if (!("days" in result))
    return [
      `Export complete: ${count(result.messages, "message")} written to ${dirname(result.output)}`,
    ];
  // Daily archives live at <export-root>/<chat>/<date>/chat.json.
  const [first] = result.days;
  return [
    `Export complete: ${count(result.messages, "message")} for ${JSON.stringify(chat)} in ${count(result.days.length, "daily folder")}${first ? ` under ${dirname(dirname(first.output))}` : ""}`,
  ];
}

export function savedChatsExportSummary(result: {
  messages: number;
  chats: (DailyExport & { chatId: string })[];
}): string[] {
  const days = result.chats.reduce((sum, chat) => sum + chat.days.length, 0);
  const first = result.chats[0]?.days[0];
  return [
    `Export complete: ${count(result.messages, "message")} across ${count(result.chats.length, "chat")} in ${count(days, "daily folder")}${first ? ` under ${dirname(dirname(dirname(first.output)))}` : ""}`,
  ];
}
