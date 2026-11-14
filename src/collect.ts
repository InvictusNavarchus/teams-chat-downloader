import { setTimeout as wait } from "node:timers/promises";
import { selectChatByLabel } from "./chat-selection.ts";
import { CollectionBackups, type BackupEvent } from "./collection-backup.ts";
import type { CollectOptions } from "./command-validation.ts";
import { collectionWindowMs } from "./config.ts";
import type { Credentials } from "./credentials.ts";
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
  signal?.throwIfAborted();
  const release = await reserveCollection(options.db);
  let store: HistoryStore | undefined;
  try {
    store = await HistoryStore.open(options.db, credentials.accountId);
    const backups =
      options.backupDir === undefined
        ? undefined
        : new CollectionBackups(options.db, options.backupDir, onProgress);
    let chat = options.chat;
    let label: string | undefined;
    if (options.chatLabel !== undefined) {
      const selected = selectChatByLabel(
        await listChats(http, credentials, {
          signal,
          warn: (message) => console.warn(message),
        }),
        options.chatLabel,
      );
      chat = selected.id;
      label = selected.label;
    }
    if (!chat)
      throw new AppError(
        "Choose exactly one of --chat <id> or --chat-label <label>.",
      );
    const gaps = store.missing(chat, options.window);
    const missingMs = gaps.reduce((sum, gap) => sum + gap.to - gap.from, 0);
    let completedWindows = 0;
    let addedMessages = 0;
    for (const gap of gaps.reverse()) {
      let to = gap.to;
      let span = collectionWindowMs;
      while (to > gap.from) {
        signal?.throwIfAborted();
        if (completedWindows > 0) {
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
        onProgress?.({ type: "checkpoint", messages: messages.length, added });
        await backups?.checkpoint(store, signal);
        to = window.from;
        // All-history collection can span decades of emptiness before the chat
        // existed. Only exhausted empty intervals expand; data resets the week.
        span =
          messages.length === 0
            ? Math.min(span * 2, options.window.to - options.window.from)
            : collectionWindowMs;
      }
    }
    await backups?.finish(store, signal);
    return {
      database: options.db,
      accountId: credentials.accountId,
      chatId: chat,
      window: {
        from: new Date(options.window.from).toISOString(),
        toExclusive: new Date(options.window.to).toISOString(),
      },
      status: "complete",
      completedWindows,
      addedMessages,
      ...(backups ? { backups: backups.summary } : {}),
      alreadyCollectedMilliseconds:
        options.window.to - options.window.from - missingMs,
    };
  } catch (error) {
    throw new AppError(
      `${signal?.aborted ? "Collection cancelled." : errorMessage(error)} Completed database checkpoints remain saved; rerun the same collection after resolving the error.`,
    );
  } finally {
    store?.close();
    await release();
  }
}
