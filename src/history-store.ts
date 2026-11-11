import { Database } from "bun:sqlite";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Archive, type Message, messageSchema } from "./archive.ts";
import { assertWindow, type Window } from "./date-window.ts";
import { AppError } from "./errors.ts";
import { requestStats, type RequestStats } from "./http.ts";
import type { HistoryProgress } from "./teams.ts";

type Coverage = { from_ms: number; to_ms: number; completed_at: string };
type Payload = { payload_json: string };

// Coverage is independent of message timestamps: an empty interval can be complete.
export function uncovered(window: Window, coverage: Window[]): Window[] {
  const gaps: Window[] = [];
  let from = window.from;
  for (const span of [...coverage].sort((a, b) => a.from - b.from)) {
    if (span.to <= from) continue;
    if (span.from >= window.to) break;
    if (span.from > from) gaps.push({ from, to: span.from });
    from = Math.max(from, span.to);
    if (from >= window.to) break;
  }
  if (from < window.to) gaps.push({ from, to: window.to });
  return gaps;
}

export class HistoryStore {
  private constructor(
    private db: Database,
    readonly accountId: string,
  ) {}

  // Supplying no account opens an existing collection read-only for offline export.
  static async open(path: string, accountId?: string): Promise<HistoryStore> {
    const file = resolve(path);
    let created = false;
    try {
      if (accountId !== undefined) {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        try {
          const handle = await open(file, "wx", 0o600);
          await handle.close();
          created = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const info = await lstat(file);
      if (
        !info.isFile() ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw new AppError(
          "Collection database must be a private regular file (mode 600), without symlinks.",
        );
      const db = new Database(file, {
        readonly: accountId === undefined,
        create: false,
        strict: true,
      });
      try {
        if (created) {
          db.transaction(() => {
            db.run(`
              CREATE TABLE collection_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, account_id TEXT NOT NULL);
              CREATE TABLE chats (chat_id TEXT PRIMARY KEY, label TEXT);
              CREATE TABLE messages (
                chat_id TEXT NOT NULL, message_id TEXT NOT NULL, arrival_ms INTEGER NOT NULL,
                payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
                PRIMARY KEY(chat_id, message_id)
              );
              CREATE INDEX messages_by_arrival ON messages(chat_id, arrival_ms, message_id);
              CREATE TABLE completed_windows (
                chat_id TEXT NOT NULL, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL CHECK(to_ms>from_ms),
                completed_at TEXT NOT NULL, history_json TEXT NOT NULL, requests_json TEXT NOT NULL,
                PRIMARY KEY(chat_id, from_ms, to_ms)
              );
            `);
            db.query("INSERT INTO collection_meta VALUES (1, 1, ?)").run(
              accountId!,
            );
          }).immediate();
        }
        const meta = db
          .query<{ version: number; account_id: string }, []>(
            "SELECT version, account_id FROM collection_meta WHERE id=1",
          )
          .get();
        if (!meta || meta.version !== 1)
          throw new AppError("Unsupported collection database version.");
        if (accountId !== undefined && meta.account_id !== accountId)
          throw new AppError(
            "Collection database belongs to a different account; choose another --db.",
          );
        if (accountId !== undefined) db.run("PRAGMA synchronous=FULL");
        return new HistoryStore(db, meta.account_id);
      } catch (error) {
        db.close();
        throw error;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "Could not open the collection database; expected a supported SQLite collection with safe permissions.",
      );
    }
  }

  close() {
    this.db.close();
  }

  private coverage(chat: string, window: Window): Coverage[] {
    return this.db
      .query<Coverage, [string, number, number]>(
        "SELECT from_ms, to_ms, completed_at FROM completed_windows WHERE chat_id=? AND to_ms>? AND from_ms<? ORDER BY from_ms, to_ms",
      )
      .all(chat, window.from, window.to);
  }

  missing(chat: string, window: Window): Window[] {
    assertWindow(window);
    return uncovered(
      window,
      this.coverage(chat, window).map((row) => ({
        from: row.from_ms,
        to: row.to_ms,
      })),
    );
  }

  commit(
    chat: string,
    label: string | undefined,
    window: Window,
    messages: Message[],
    history: HistoryProgress,
    requests: RequestStats,
  ): number {
    assertWindow(window);
    try {
      return this.db
        .transaction(() => {
          this.db
            .query(
              "INSERT INTO chats VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET label=COALESCE(excluded.label, chats.label)",
            )
            .run(chat, label ?? null);
          const previous = this.db.query<Payload, [string, string]>(
            "SELECT payload_json FROM messages WHERE chat_id=? AND message_id=?",
          );
          const insert = this.db.query(
            "INSERT INTO messages VALUES (?, ?, ?, ?)",
          );
          let added = 0;
          for (const message of messages) {
            const arrival = Date.parse(message.originalarrivaltime);
            if (
              !Number.isFinite(arrival) ||
              arrival < window.from ||
              arrival >= window.to
            )
              throw new AppError(
                "Cannot commit a message outside its collection window.",
              );
            const old = previous.get(chat, message.id);
            if (old) {
              if (!isDeepStrictEqual(JSON.parse(old.payload_json), message))
                throw new AppError(
                  "Collection contains a conflicting record for this message ID; saved data kept and window not completed. Revision selection is unresolved.",
                );
            } else {
              insert.run(chat, message.id, arrival, JSON.stringify(message));
              added++;
            }
          }
          this.db
            .query(
              "INSERT INTO completed_windows VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
            )
            .run(
              chat,
              window.from,
              window.to,
              new Date().toISOString(),
              JSON.stringify(history),
              JSON.stringify(requests),
            );
          return added;
        })
        .immediate();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "Could not commit the collection window; messages and coverage were rolled back together.",
      );
    }
  }

  archive(chat: string, requested?: Window): Archive {
    return this.db.transaction(() => {
      const bounds = this.db
        .query<{ from_ms: number | null; to_ms: number | null }, [string]>(
          "SELECT MIN(from_ms) AS from_ms, MAX(to_ms) AS to_ms FROM completed_windows WHERE chat_id=?",
        )
        .get(chat)!;
      if (bounds.from_ms === null || bounds.to_ms === null)
        throw new AppError("No completed history is stored for this chat.");
      const window = requested ?? { from: bounds.from_ms, to: bounds.to_ms };
      if (this.missing(chat, window).length)
        throw new AppError(
          "Requested range has uncollected gaps; run collect for that range before exporting.",
        );
      const messages = this.db
        .query<Payload, [string, number, number]>(
          "SELECT payload_json FROM messages WHERE chat_id=? AND arrival_ms>=? AND arrival_ms<? ORDER BY arrival_ms, message_id",
        )
        .all(chat, window.from, window.to)
        .map((row) => messageSchema.parse(JSON.parse(row.payload_json)));
      const label = this.db
        .query<{ label: string | null }, [string]>(
          "SELECT label FROM chats WHERE chat_id=?",
        )
        .get(chat)?.label;
      return {
        version: 1,
        status: "complete",
        accountId: this.accountId,
        chatId: chat,
        ...(label ? { chatLabel: label } : {}),
        window: {
          from: new Date(window.from).toISOString(),
          toExclusive: new Date(window.to).toISOString(),
          timestampField: "originalarrivaltime",
        },
        completedAt: new Date().toISOString(),
        history: {
          source: "sqlite",
          uniqueMessages: messages.length,
          serviceReportedExhaustion: true,
          duplicatePolicy: "identical records deduplicated; conflicts fail",
        },
        collection: {
          version: 1,
          completedWindows: this.coverage(chat, window).map((row) => ({
            from: new Date(row.from_ms).toISOString(),
            toExclusive: new Date(row.to_ms).toISOString(),
            completedAt: row.completed_at,
          })),
        },
        requests: {
          ...requestStats(),
          scope:
            "Offline database export; original HTTP counts are stored per completed window in SQLite",
        },
        media: { status: "not-downloaded" },
        messages,
      } satisfies Archive;
    })();
  }
}
