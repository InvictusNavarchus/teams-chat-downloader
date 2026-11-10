import { AppError } from "./errors.ts";

export function assertSelectableChatLabel(label: string): void {
  const requested = label.trim().toLowerCase();
  if (
    requested === "untitled chat" ||
    requested === "unresolved one-to-one chat"
  )
    throw new AppError(
      "Generic fallback labels cannot select a chat; use --chat <id> from teams chats.",
    );
}

export function selectChatByLabel<T extends { id: string; label: string }>(
  chats: T[],
  label: string,
): T {
  assertSelectableChatLabel(label);
  const requested = label.trim().toLowerCase();
  const matches = chats.filter(
    (chat) => chat.label.trim().toLowerCase() === requested,
  );
  if (matches.length === 0)
    throw new AppError(
      "No chat matches --chat-label. Run teams chats to see current labels; use --refresh-names if a participant was renamed.",
    );
  if (matches.length > 1)
    throw new AppError(
      `Multiple chats match --chat-label; select one with --chat <id>:\n${matches.map((chat) => `${JSON.stringify(chat.label)}: ${JSON.stringify(chat.id)}`).join("\n")}`,
    );
  return matches[0]!;
}
