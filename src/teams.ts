import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type Message, messageSchema } from "./archive.ts";
import type { Credentials } from "./credentials.ts";
import { AppError, validationError } from "./errors.ts";
import type { Http } from "./http.ts";
import { assertWindow, type Window } from "./options.ts";
import { resolveChatNames, type ProfileOptions } from "./profiles.ts";

const view =
  "msnp24Equivalent|supportsMessageProperties|supportsExtendedHistory";
const pageSchema = z.looseObject({
  messages: z.array(messageSchema),
  _metadata: z.looseObject({ backwardLink: z.string().min(1).optional() }),
});
const directorySchema = z.looseObject({
  chats: z.array(
    z.looseObject({
      id: z.string().min(1),
      title: z.string().nullish(),
      isOneOnOne: z.boolean().optional(),
      members: z
        .array(z.looseObject({ mri: z.string().min(1).optional() }))
        .optional(),
    }),
  ),
  metadata: z.looseObject({
    hasMoreChats: z.boolean(),
    isPartialData: z.boolean(),
  }),
});

export type HistoryProgress = {
  pages: number;
  records: number;
  duplicates: number;
};

export type HistoryPageProgress = {
  page: number;
  pageMessages: number;
  totalMessages: number;
  earliestTimestamp?: string;
  hasMore: boolean;
};

export function historyProgress(): HistoryProgress {
  return { pages: 0, records: 0, duplicates: 0 };
}

export function validateHistoryUrl(url: URL, chat: string): void {
  const segment = encodeURIComponent(chat);
  const valid =
    (url.origin === "https://teams.live.com" &&
      url.pathname ===
        `/api/chatsvc/consumer/v1/users/ME/conversations/${segment}/messages`) ||
    (url.origin === "https://msgapi.teams.live.com" &&
      url.pathname === `/v1/users/ME/conversations/${segment}/messages`);
  if (!valid || url.username || url.password || url.hash) {
    throw new AppError(
      "Refused an unexpected history destination or chat identity.",
    );
  }
}

export async function readHistory(
  http: Http,
  credentials: Credentials,
  chat: string,
  window: Window,
  progress = historyProgress(),
  onProgress?: (progress: HistoryPageProgress) => void,
): Promise<Message[]> {
  assertWindow(window);
  if (!chat) throw new AppError("A chat ID is required.");
  if (!credentials.historyAuthentication)
    throw new AppError("Credential file lacks historyAuthentication.");
  let next: string | undefined =
    `https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/${encodeURIComponent(chat)}/messages`;
  const seenPages = new Set<string>();
  const messages = new Map<string, Message>();
  while (next !== undefined) {
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      throw new AppError("Invalid history continuation URL.");
    }
    validateHistoryUrl(url, chat);
    url.searchParams.set("startTime", String(window.from));
    url.searchParams.set("endTime", String(window.to - 1));
    url.searchParams.set("pageSize", "200");
    url.searchParams.set("view", view);
    // Query ordering is not part of cursor identity.
    url.searchParams.sort();
    if (seenPages.has(url.href))
      throw new AppError(
        "History returned a repeated continuation; export stopped.",
      );
    seenPages.add(url.href);
    const data = await http.json(
      url,
      "history",
      { Authentication: credentials.historyAuthentication },
      (destination) => validateHistoryUrl(destination, chat),
    );
    const result = pageSchema.safeParse(data);
    if (!result.success)
      throw validationError("History response", result.error);
    const page = result.data;
    let added = 0;
    for (const message of page.messages) {
      const time = Date.parse(message.originalarrivaltime);
      if (time < window.from || time >= window.to)
        throw new AppError(
          "History returned a message outside the fixed date window; export stopped.",
        );
      const previous = messages.get(message.id);
      if (previous !== undefined) {
        if (!isDeepStrictEqual(previous, message))
          throw new AppError(
            "History returned conflicting records for one message ID; revision selection is unresolved.",
          );
        progress.duplicates++;
      } else {
        messages.set(message.id, message);
        added++;
      }
    }
    progress.pages++;
    progress.records += page.messages.length;
    next = page._metadata.backwardLink;
    if (next !== undefined && added === 0)
      throw new AppError(
        "History continuation made no progress; export stopped.",
      );
    let earliestTimestamp: string | undefined;
    for (const message of page.messages) {
      if (
        earliestTimestamp === undefined ||
        message.originalarrivaltime < earliestTimestamp
      ) {
        earliestTimestamp = message.originalarrivaltime;
      }
    }
    onProgress?.({
      page: progress.pages,
      pageMessages: page.messages.length,
      totalMessages: messages.size,
      earliestTimestamp,
      hasMore: next !== undefined,
    });
  }
  return [...messages.values()].sort(
    (a, b) =>
      Date.parse(a.originalarrivaltime) - Date.parse(b.originalarrivaltime) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export async function listChats(
  http: Http,
  credentials: Credentials,
  options: ProfileOptions & { chatId?: string } = {},
) {
  if (!credentials.directoryToken)
    throw new AppError("Credential file lacks directoryToken.");
  const url = new URL("https://teams.live.com/api/csa/api/v3/teams/users/me");
  url.search = new URLSearchParams({
    isPrefetch: "false",
    enableMembershipSummary: "true",
    supportsAdditionalSystemGeneratedFolders: "true",
    enableEngageCommunities: "false",
  }).toString();
  const validate = (destination: URL) => {
    if (
      destination.origin !== url.origin ||
      destination.pathname !== url.pathname ||
      destination.username ||
      destination.password ||
      destination.hash
    )
      throw new AppError("Refused an unexpected directory destination.");
  };
  const result = directorySchema.safeParse(
    await http.json(
      url,
      "directory",
      { "x-skypetoken": credentials.directoryToken },
      validate,
    ),
  );
  if (!result.success)
    throw validationError("Directory response", result.error);
  if (result.data.metadata.hasMoreChats || result.data.metadata.isPartialData)
    throw new AppError(
      "Directory is partial; directory continuation is not yet supported.",
    );
  return resolveChatNames(
    http,
    credentials,
    result.data.chats
      .filter(
        (chat) => options.chatId === undefined || chat.id === options.chatId,
      )
      .map((chat) => ({
        id: chat.id,
        title: chat.title || null,
        label:
          chat.title ||
          (chat.isOneOnOne ? "Unresolved one-to-one chat" : "Untitled chat"),
        isOneOnOne: chat.isOneOnOne ?? null,
        members: chat.members?.map((member) => member.mri) ?? [],
      })),
    options,
  );
}
