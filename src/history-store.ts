import { Database } from "bun:sqlite";
import { lstat, mkdir, open, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type Archive,
  type ArchiveImage,
  type Message,
  messageSchema,
} from "./archive.ts";
import { assertWindow, type Window } from "./date-window.ts";
import { AppError } from "./errors.ts";
import { requestStats, type RequestStats } from "./http.ts";
import type { HistoryProgress } from "./teams.ts";
import { messageImageReferences } from "./media.ts";

type Coverage = { from_ms: number; to_ms: number; completed_at: string };
type Payload = { payload_json: string };
export type StoredImage = {
  key: string;
  source_url: string;
  status: "pending" | "complete" | "failed";
  file_path: string | null;
  bytes: number | null;
  sha256: string | null;
  media_type: ArchiveImage["mediaType"] | null;
};

export function storedImageDescriptor(image: StoredImage): ArchiveImage {
  return {
    messageId: image.key,
    key: image.key,
    path: image.file_path!,
    bytes: image.bytes!,
    sha256: image.sha256!,
    mediaType: image.media_type!,
  };
}

export function collectionMediaDirectory(database: string): string {
  return `${resolve(database)}.media`;
}

export async function reserveCollection(
  database: string,
): Promise<() => Promise<void>> {
  await mkdir(dirname(database), { recursive: true, mode: 0o700 });
  const lock = `${database}.collection.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    throw new AppError(
      (error as NodeJS.ErrnoException).code === "EEXIST"
        ? "A collection or database media update is already running. After a crash, verify no updater is running before removing the adjacent .collection.lock directory."
        : "Could not reserve the collection database.",
    );
  }
  return () => rmdir(lock);
}

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
    readonly version: number,
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
        if (!meta || ![1, 2].includes(meta.version))
          throw new AppError("Unsupported collection database version.");
        if (accountId !== undefined && meta.account_id !== accountId)
          throw new AppError(
            "Collection database belongs to a different account; choose another --db.",
          );
        if (accountId !== undefined) db.run("PRAGMA synchronous=FULL");
        const store = new HistoryStore(
          db,
          meta.account_id,
          accountId !== undefined ? 2 : meta.version,
        );
        if (accountId !== undefined && meta.version === 1)
          store.migrateImages();
        return store;
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

  private migrateImages() {
    this.db
      .transaction(() => {
        this.db.run(`
        ALTER TABLE messages ADD COLUMN unsupported_images INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE images (
          key TEXT PRIMARY KEY, source_url TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','failed')),
          file_path TEXT, bytes INTEGER, sha256 TEXT, media_type TEXT,
          downloaded_at TEXT, last_error TEXT
        );
        CREATE TABLE message_images (
          chat_id TEXT NOT NULL, message_id TEXT NOT NULL, image_key TEXT NOT NULL,
          PRIMARY KEY(chat_id,message_id,image_key)
        );
        CREATE INDEX message_images_by_key ON message_images(image_key);
      `);
        for (const row of this.db
          .query<{ chat_id: string; payload_json: string }, []>(
            "SELECT chat_id, payload_json FROM messages",
          )
          .iterate()) {
          this.indexImages(
            row.chat_id,
            messageSchema.parse(JSON.parse(row.payload_json)),
          );
        }
        this.db.run("UPDATE collection_meta SET version=2 WHERE id=1");
      })
      .immediate();
  }

  private indexImages(chat: string, message: Message) {
    const references = messageImageReferences(message);
    this.db
      .query(
        "UPDATE messages SET unsupported_images=? WHERE chat_id=? AND message_id=?",
      )
      .run(references.unsupported, chat, message.id);
    for (const image of references.images) {
      this.db
        .query(
          "INSERT INTO images (key,source_url) VALUES (?,?) ON CONFLICT DO NOTHING",
        )
        .run(image.key, image.sourceUrl);
      this.db
        .query(
          "INSERT INTO message_images VALUES (?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(chat, message.id, image.key);
    }
  }

  images(chat?: string): StoredImage[] {
    if (this.version < 2) return [];
    if (chat === undefined)
      return this.db
        .query<StoredImage, []>("SELECT * FROM images ORDER BY key")
        .all();
    if (!this.db.query("SELECT 1 FROM chats WHERE chat_id=?").get(chat))
      throw new AppError("No collected chat matches --chat in this database.");
    return this.db
      .query<StoredImage, [string]>(
        "SELECT * FROM images WHERE key IN (SELECT image_key FROM message_images WHERE chat_id=?) ORDER BY key",
      )
      .all(chat);
  }

  unsupportedImages(chat?: string): number {
    if (this.version < 2) return 0;
    if (chat === undefined)
      return this.db
        .query<{ n: number }, []>(
          "SELECT COALESCE(SUM(unsupported_images),0) AS n FROM messages",
        )
        .get()!.n;
    return this.db
      .query<{ n: number }, [string]>(
        "SELECT COALESCE(SUM(unsupported_images),0) AS n FROM messages WHERE chat_id=?",
      )
      .get(chat)!.n;
  }

  saveImage(image: ArchiveImage) {
    this.db
      .query(
        "UPDATE images SET status='complete', file_path=?, bytes=?, sha256=?, media_type=?, downloaded_at=?, last_error=NULL WHERE key=?",
      )
      .run(
        image.path,
        image.bytes,
        image.sha256,
        image.mediaType,
        new Date().toISOString(),
        image.key,
      );
  }

  imagePending(key: string) {
    this.db.query("UPDATE images SET status='pending' WHERE key=?").run(key);
  }

  imageFailed(key: string, reason: string, cancelled = false) {
    // A failed refresh keeps a previously verified file usable by offline export.
    this.db
      .query(
        "UPDATE images SET status=CASE WHEN status='complete' THEN status ELSE ? END, last_error=? WHERE key=?",
      )
      .run(cancelled ? "pending" : "failed", reason, key);
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
            "INSERT INTO messages (chat_id,message_id,arrival_ms,payload_json) VALUES (?, ?, ?, ?)",
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
            this.indexImages(chat, message);
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
      const images =
        this.version < 2
          ? []
          : this.db
              .query<
                {
                  message_id: string;
                  key: string;
                  status: string;
                  file_path: string | null;
                  bytes: number | null;
                  sha256: string | null;
                  media_type: ArchiveImage["mediaType"] | null;
                },
                [string, number, number]
              >(`
        SELECT mi.message_id, i.key, i.status, i.file_path, i.bytes, i.sha256, i.media_type
        FROM message_images mi JOIN images i ON i.key=mi.image_key
        JOIN messages m ON m.chat_id=mi.chat_id AND m.message_id=mi.message_id
        WHERE m.chat_id=? AND m.arrival_ms>=? AND m.arrival_ms<?
      `)
              .all(chat, window.from, window.to);
      const unsupported =
        this.version < 2
          ? 0
          : this.db
              .query<{ n: number }, [string, number, number]>(
                "SELECT COALESCE(SUM(unsupported_images),0) AS n FROM messages WHERE chat_id=? AND arrival_ms>=? AND arrival_ms<?",
              )
              .get(chat, window.from, window.to)!.n;
      const downloaded = images
        .filter((image) => image.status === "complete")
        .map((image) => ({
          messageId: image.message_id,
          key: image.key,
          path: image.file_path!,
          bytes: image.bytes!,
          sha256: image.sha256!,
          mediaType: image.media_type!,
        }));
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
          version: this.version,
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
        media:
          this.version < 2 ||
          (downloaded.length === 0 && images.length > 0 && unsupported === 0)
            ? { status: "not-downloaded" }
            : {
                status:
                  unsupported > 0 || downloaded.length !== images.length
                    ? "partial"
                    : "complete",
                images: downloaded,
                unsupported,
                downloaded: 0,
                cacheHits: 0,
              },
        messages,
      } satisfies Archive;
    })();
  }
}
