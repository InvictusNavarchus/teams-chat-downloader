import { setTimeout as wait } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { type Message, messageSchema } from "./archive.ts";
import { defaultPageDelay } from "./config.ts";
import type { Credentials } from "./credentials.ts";
import { assertWindow, type Window } from "./date-window.ts";
import { AppError, validationError } from "./errors.ts";
import type { Http } from "./http.ts";
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
  const route =
    url.origin === "https://teams.live.com"
      ? /^\/api\/chatsvc\/consumer\/v1\/users\/ME\/conversations\/([^/]+)\/messages$/
      : url.origin === "https://msgapi.teams.live.com"
        ? /^\/v1\/users\/ME\/conversations\/([^/]+)\/messages$/
        : undefined;
  const segment = route?.exec(url.pathname)?.[1];
  let matchesChat = false;
  if (segment !== undefined) {
    try {
      // Decode only the chat-ID segment; route separators stay literal.
      matchesChat = decodeURIComponent(segment) === chat;
    } catch {
      // Malformed percent encoding is an invalid destination.
    }
  }
  if (!matchesChat || url.username || url.password || url.hash) {
    throw new AppError(
      "Refused an unexpected history destination or chat identity.",
    );
  }
}

type HistoryOptions = {
  pageDelayMin?: number;
  pageDelayMax?: number;
  signal?: AbortSignal;
};

// Stopping iteration bounds a probe without treating sampled history as an export.
// Each page contains only new records, after the same validation used by exports.
export async function* readHistoryPages(
  http: Http,
  credentials: Credentials,
  chat: string,
  window: Window,
  progress = historyProgress(),
  onProgress?: (progress: HistoryPageProgress) => void,
  options: HistoryOptions = {},
): AsyncGenerator<Message[]> {
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
    if (seenPages.size > 1) {
      const min = options.pageDelayMin ?? defaultPageDelay.min;
      const max = options.pageDelayMax ?? defaultPageDelay.max;
      const delayMs = Math.round((min + Math.random() * (max - min)) * 1000);
      try {
        await wait(delayMs, undefined, { signal: options.signal });
      } catch (error) {
        if (options.signal?.aborted) throw new AppError("Export cancelled.");
        throw error;
      }
    }
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
    const added: Message[] = [];
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
        added.push(message);
      }
    }
    progress.pages++;
    progress.records += page.messages.length;
    next = page._metadata.backwardLink;
    if (next !== undefined && added.length === 0)
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
    yield added;
  }
}

export async function readHistory(
  http: Http,
  credentials: Credentials,
  chat: string,
  window: Window,
  progress = historyProgress(),
  onProgress?: (progress: HistoryPageProgress) => void,
  options: HistoryOptions = {},
): Promise<Message[]> {
  const messages: Message[] = [];
  for await (const page of readHistoryPages(
    http,
    credentials,
    chat,
    window,
    progress,
    onProgress,
    options,
  )) {
    messages.push(...page);
  }
  return messages.sort(
    (a, b) =>
      Date.parse(a.originalarrivaltime) - Date.parse(b.originalarrivaltime) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export async function readChatDirectory(http: Http, credentials: Credentials) {
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
  return result.data.chats.map((chat) => ({
    id: chat.id,
    title: chat.title || null,
    label:
      chat.title ||
      (chat.isOneOnOne ? "Unresolved one-to-one chat" : "Untitled chat"),
    isOneOnOne: chat.isOneOnOne ?? null,
    members: chat.members?.map((member) => member.mri) ?? [],
  }));
}

export async function listChats(
  http: Http,
  credentials: Credentials,
  options: ProfileOptions & { chatId?: string } = {},
) {
  const chats = await readChatDirectory(http, credentials);
  return resolveChatNames(
    http,
    credentials,
    chats.filter(
      (chat) => options.chatId === undefined || chat.id === options.chatId,
    ),
    options,
  );
}
