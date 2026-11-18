import { setTimeout as wait } from "node:timers/promises";
import { selectChatByLabel } from "./chat-selection.ts";
import { CollectionBackups, type BackupEvent } from "./collection-backup.ts";
import type { CollectOptions } from "./command-validation.ts";
import { collectionWindowMs } from "./config.ts";
import type { Credentials } from "./credentials.ts";
import { assertWindow } from "./date-window.ts";
import { AppError, errorMessage } from "./errors.ts";
import { HistoryStore, reserveCollection } from "./history-store.ts";
import type { Http, RequestStats } from "./http.ts";
import {
  historyProgress,
  listChats,
  readHistory,
  type HistoryPageProgress,
  type HistoryProgress,
} from "./teams.ts";

export type CollectionEvent =
  | { type: "chat"; chatId: string; current: number; total: number }
  | {
      type: "chat-complete";
      chatId: string;
      addedMessages: number;
      completedWindows: number;
    }
  | {
      type: "coverage";
      from: string;
      toExclusive: string;
      alreadyCollectedMilliseconds: number;
      remainingIntervals: number;
    }
  | { type: "warning"; message: string }
  | BackupEvent
  | { type: "window"; from: string; toExclusive: string }
  | { type: "history"; progress: HistoryPageProgress }
  | { type: "checkpoint"; messages: number; added: number };

export async function collectHistory(
  options: CollectOptions,
  credentials: Credentials,
  http: Http,
  stats: RequestStats,
  progress: HistoryProgress,
  signal?: AbortSignal,
  onProgress?: (event: CollectionEvent) => void,
) {
  if (options.allChats)
    throw new AppError("Use collectChats for --all-chats collection.");
  const { chats, ...result } = await collectChats(
    options,
    credentials,
    http,
    stats,
    progress,
    signal,
    onProgress,
  );
  return { ...result, ...chats[0]! };
}

export async function collectChats(
  options: CollectOptions,
  credentials: Credentials,
  http: Http,
  stats: RequestStats,
  progress: HistoryProgress,
  signal?: AbortSignal,
  onProgress?: (event: CollectionEvent) => void,
) {
  signal?.throwIfAborted();
  const release = await reserveCollection(options.db);
  let store: HistoryStore | undefined;
  let activeChat: string | undefined;
  try {
    store = await HistoryStore.open(options.db, credentials.accountId);
    const backups =
      options.backupDir === undefined
        ? undefined
        : new CollectionBackups(options.db, options.backupDir, onProgress);
    let chat = options.chat;
    let label: string | undefined;
    if (!options.allChats && options.chatLabel !== undefined) {
      const selected = selectChatByLabel(
        await listChats(http, credentials, {
          signal,
          warn: (message) =>
            onProgress
              ? onProgress({ type: "warning", message })
              : console.warn(message),
        }),
        options.chatLabel,
      );
      chat = selected.id;
      label = selected.label;
    }
    const selected = options.allChats
      ? store.savedChatIds()
      : chat
        ? [chat]
        : [];
    if (selected.length === 0)
      throw new AppError(
        options.allChats
          ? "No saved chats in this database. Collect a chat with --chat or --chat-label first."
          : "Choose exactly one of --chat <id> or --chat-label <label>.",
      );
    const chats: {
      chatId: string;
      window: { from: string; toExclusive: string };
      completedWindows: number;
      addedMessages: number;
      alreadyCollectedMilliseconds: number;
    }[] = [];
    // Resolve every default range before history HTTP; never backfill a new chat implicitly.
    const targets = selected.map((chatId) => {
      let window = options.window;
      if (!window) {
        let from: number;
        try {
          from = store!.completedBounds(chatId).from;
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          throw new AppError(
            `No completed history for chat ${JSON.stringify(chatId)}. Choose --all-history or an explicit date range for its initial collection.`,
          );
        }
        window = { from, to: options.invocationTime };
        assertWindow(window);
      }
      return { chatId, window };
    });
    let totalCompletedWindows = 0;
    for (const { chatId: chat, window: requestedWindow } of targets) {
      signal?.throwIfAborted();
      activeChat = chat;
      if (options.allChats)
        onProgress?.({
          type: "chat",
          chatId: chat,
          current: chats.length + 1,
          total: selected.length,
        });
      const gaps = store.missing(chat, requestedWindow);
      const missingMs = gaps.reduce((sum, gap) => sum + gap.to - gap.from, 0);
      onProgress?.({
        type: "coverage",
        from: new Date(requestedWindow.from).toISOString(),
        toExclusive: new Date(requestedWindow.to).toISOString(),
        alreadyCollectedMilliseconds:
          requestedWindow.to - requestedWindow.from - missingMs,
        remainingIntervals: gaps.length,
      });
      let completedWindows = 0;
      let addedMessages = 0;
      for (const gap of gaps.reverse()) {
        let to = gap.to;
        let span = collectionWindowMs;
        while (to > gap.from) {
          signal?.throwIfAborted();
          if (totalCompletedWindows > 0) {
            const delay =
              (options.pageDelayMin +
                Math.random() * (options.pageDelayMax - options.pageDelayMin)) *
              1000;
            await wait(Math.round(delay), undefined, { signal });
          }
          const window = { from: Math.max(gap.from, to - span), to };
          onProgress?.({
            type: "window",
            from: new Date(window.from).toISOString(),
            toExclusive: new Date(to).toISOString(),
          });
          const windowProgress = historyProgress();
          const before = { ...stats };
          let messages;
          try {
            messages = await readHistory(
              http,
              credentials,
              chat,
              window,
              windowProgress,
              (event) => onProgress?.({ type: "history", progress: event }),
              {
                pageDelayMin: options.pageDelayMin,
                pageDelayMax: options.pageDelayMax,
                signal,
              },
            );
          } finally {
            progress.pages += windowProgress.pages;
            progress.records += windowProgress.records;
            progress.duplicates += windowProgress.duplicates;
          }
          signal?.throwIfAborted();
          const requests = { ...stats };
          for (const key of Object.keys(requests) as (keyof RequestStats)[])
            requests[key] -= before[key];
          const added = store.commit(
            chat,
            label,
            window,
            messages,
            windowProgress,
            requests,
          );
          addedMessages += added;
          completedWindows++;
          totalCompletedWindows++;
          onProgress?.({
            type: "checkpoint",
            messages: messages.length,
            added,
          });
          await backups?.checkpoint(store, signal);
          to = window.from;
          // All-history collection can span decades of emptiness before the chat
          // existed. Only exhausted empty intervals expand; data resets the week.
          span =
            messages.length === 0
              ? Math.min(span * 2, requestedWindow.to - requestedWindow.from)
              : collectionWindowMs;
        }
      }
      const result = {
        chatId: chat,
        window: {
          from: new Date(requestedWindow.from).toISOString(),
          toExclusive: new Date(requestedWindow.to).toISOString(),
        },
        completedWindows,
        addedMessages,
        alreadyCollectedMilliseconds:
          requestedWindow.to - requestedWindow.from - missingMs,
      };
      chats.push(result);
      if (options.allChats) onProgress?.({ type: "chat-complete", ...result });
    }
    signal?.throwIfAborted();
    await backups?.finish(store, signal);
    return {
      database: options.db,
      accountId: credentials.accountId,
      chats,
      window: options.window
        ? {
            from: new Date(options.window.from).toISOString(),
            toExclusive: new Date(options.window.to).toISOString(),
          }
        : undefined,
      status: "complete",
      completedWindows: totalCompletedWindows,
      addedMessages: chats.reduce((sum, chat) => sum + chat.addedMessages, 0),
      ...(backups ? { backups: backups.summary } : {}),
      alreadyCollectedMilliseconds: chats.reduce(
        (sum, chat) => sum + chat.alreadyCollectedMilliseconds,
        0,
      ),
    };
  } catch (error) {
    throw new AppError(
      `${signal?.aborted ? "Collection cancelled." : errorMessage(error)}${options.allChats && activeChat ? ` Active chat: ${JSON.stringify(activeChat)}.` : ""} Completed database checkpoints remain saved; rerun the same collection after resolving the error.`,
    );
  } finally {
    store?.close();
    await release();
  }
}
