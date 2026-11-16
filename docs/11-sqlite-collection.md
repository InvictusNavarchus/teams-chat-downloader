> Current command interface: `download` collects missing intervals, downloads images, and exports through SQLite; `collect` saves history only; `export` is offline; `images` downloads saved references. `export-db`/`media-db` are aliases. Repeated collection preserves saved history and does not synchronize edits or deletions. Default databases are account-scoped under user state; offline default discovery requires exactly one database. See the [user guide](user-guide.md#default-collections-and-command-migration).

# Resumable SQLite collection

Implemented for long historical downloads where an authentication or HTTP failure must not discard completed collection work. `collect` stores source data and image references; `media-db` independently downloads images; `export-db` generates portable version 1 JSON and Markdown with saved local images. `download` orchestrates these phases; `export` is offline. Standalone JSON `media` remains supported. Normalized analytics tables can be derived later without contacting Teams again.

## Commands

```sh
bun run teams collect --db exports/history.sqlite --chat-label 'Project Alpha' --all
bun run teams collect --db exports/history.sqlite --chat '<raw-id>' --since '2024-11-01T00:00:00Z'
bun run teams media-db --db exports/history.sqlite
bun run teams export-db --db exports/history.sqlite --chat '<raw-id>' --out exports/complete
```

Collection accepts an optional `--db`, requires one of `--chat` or `--chat-label`, and one of `--all`, `--last Nd`, `--since`, or paired `--from`/`--to`. Raw IDs do not require directory/profile lookup. Labels use the shared exact matcher and verified directory/name resolution. Credentials use the normal lookup or `--credentials`. Bounds are inclusive/exclusive millisecond instants; future ends fail. `--all` selects Unix millisecond 1 through one captured invocation time. Only the endpoint's accessible history can be recovered.

`media-db` requires an existing explicit or default database and credentials for its account (normal lookup or `--credentials`). It handles all chats by default; optional `--chat <raw-id>` or `--chat-label <label>` limits the queue and unsupported counts. Reject combining the selectors. After account validation, resolve labels through `HistoryStore.chatIdForLabel`, reusing the saved-label matching and diagnostics described below before media HTTP. Logs record the requested selector and selected raw ID. `--refresh-media` revalidates through the shared cache. No JSON export or history/directory/profile request is needed.

`export-db` accepts optional `--db` and requires exactly one of `--chat <raw-id>` or `--chat-label <label>`, and either `--last Nd` for daily folders or a new `--out` directory for one combined archive. In combined mode, optional `--from` and `--to` must appear together; otherwise use the minimum/maximum completed bounds. Any coverage gap fails before publication. Export is offline without credentials. `--no-markdown` creates JSON only; `--no-media` skips image copying and emits placeholders.

`--chat-label` resolves exclusively against saved SQLite labels using the shared exact, trimmed, case-insensitive matcher. Reject generic fallback labels, missing matches, and duplicates before archive publication. Missing-match guidance refers to saved database labels; duplicates list saved labels and raw IDs. `HistoryStore.chatIdForLabel` uses a read-only query; neither export mode requests credentials or live directory/profile data. Archives and daily naming use the resolved raw chat ID and saved label. Logs record both the requested selector and selected raw chat ID.

Daily mode rejects `--out` and explicit bounds, splits at local calendar midnights, and uses saved labels with the shared export-path naming rules. Cap the requested endpoint to the latest completed collection endpoint or invocation time, whichever is earlier, even when collection ended on an earlier day. Reject no overlap and internal gaps between the requested start and capped endpoint before publication. Print the cutoff, report the skipped uncollected tail, and preserve the cutoff in the final archive window. Only the last exported day can be partial; days after it are omitted, and covered empty days produce empty archives. Each day's archive is read in a SQLite transaction without loading the whole requested range into memory.

`src/daily-export.ts` shares directory/type validation and existing-archive identity/window checks for unified download and offline daily exports. Database publication holds `withArchiveLock` across validation, local media copying, JSON replacement, and Markdown regeneration. Existing newer endpoints cannot be shortened. New media files are published from sibling temporary files; prior unreferenced files remain. Failed new daily media publication removes its unpublished media files; JSON remains after Markdown failure. Previously completed days remain if a later day fails. Combined export retains new-directory-only behavior.

## Schema version 3

| Table | Stored fields |
| --- | --- |
| `collection_meta` | Singleton schema version and credential `account_id` |
| `chats` | Raw `chat_id`, optional resolved `label` |
| `messages` | `chat_id`, `message_id`, integer `arrival_ms`, complete `payload_json`, `unsupported_images` count |
| `completed_windows` | `chat_id`, `from_ms`, `to_ms`, `completed_at`, `history_json`, `requests_json` |
| `images` | Source-digest `key`, validated original `source_url`, pending/complete/failed `status`, `file_path`, `bytes`, `sha256`, `media_type`, `downloaded_at`, sanitized `last_error` |
| `message_images` | Unique `(chat_id, message_id, image_key)` relationships |

The messages primary key is `(chat_id, message_id)`; an index on `(chat_id, arrival_ms, message_id)` supports ordered range reads. Account isolation is at the database level: one file belongs to one exact account ID. Different chats may reuse IDs. SQLite JSON text retains nested/unknown Teams properties; extracted IDs/timestamps support indexing without replacing source fields. The original timestamp precision remains in the payload even though range indexing uses JavaScript millisecond precision, matching ordinary exports.

Coverage records are independent of message presence. A successful empty interval is covered; a failed request is not. History/request JSON contains counts only, never request headers or continuation state. Identical stored records are deduplicated using structural equality; conflicting payloads fail the whole window. The collector does not invent version ordering, preserve multiple observations as revisions, infer deletions, or automatically refresh completed ranges. Those policies require a separate design if synchronization is introduced.

One source may link to multiple messages and chats, with one account-scoped download record. Original regional URLs retain their digests; destination translation occurs only inside the shared downloader. Unsupported references remain in original payloads and are counted, not queued for arbitrary requests.

After account validation, writable opens transactionally migrate version 1: add image tables/indexes and unsupported counts, backfill saved message references, and advance the version together. Migration performs no HTTP and preserves messages and coverage; failures roll back the schema/backfill. Read-only version 1 exports remain supported without migration and retain their legacy not-downloaded media state. Unknown future versions fail. Database version 3 does not change portable JSON archive version 1.

## Retrieval and recovery

Subtract complete coverage from the requested range and visit gaps newest first in initially seven-day windows. Paginate each window to exhaustion, keeping it in memory until completion. Then commit messages, image references/links, unsupported counts, and coverage together in a synchronous immediate transaction. Any transaction error rolls everything back; no network work occurs inside it. `messageImageReferences` uses Bun's synchronous HTML parser and the same source rules as normal image downloads.

After a nonempty window, the next span is seven days. After an exhausted empty window, double the span. This makes progress through long empty periods before the chat's creation economical; it never treats an empty week as proof that all earlier history is absent. Each expanded window must still reach pagination exhaustion, and an expanded window containing data resets the next span to seven days. The page-delay options govern waits both within pagination and between windows.

On HTTP failure, credential rejection, cancellation, or conflicting messages, stop with a nonzero exit and retain completed checkpoints. Rerunning the request subtracts those checkpoints and re-fetches the unfinished window from a fresh date-bound request. A moving invocation-time endpoint also adds a new uncovered tail. No durable cursor or ordering relationship between pages is assumed.

An adjacent `.collection.lock` directory excludes collectors and database media updaters throughout HTTP work and migration. Handled exit releases it. After a crash, inspect active updaters before removing a stale reservation. SQLite rollback-journal transactions use full synchronization. Unrelated and unknown-version files fail. New database files use mode 600 and new parent directories mode 700; unsafe database permissions and symlinks fail. Back up the database and adjacent `<database>.media` directory together with updaters stopped.

## Automatic collection backups

`collect` automatically publishes local snapshots to `<database>.backups/`, without a separate scheduler, SQLite schema change, or dependency. `--backup-dir <directory>` overrides this location; `--no-backup` disables snapshot creation for the invocation while retaining collection checkpoints and previous snapshots. Combining the two flags is rejected. Command validation resolves the enabled path absolutely, using `commandDefaults.backup` and `collectionBackupSuffix` from `src/config.ts`; disabled backups have no resolved destination. `collectionBackupIntervalMs` defaults to one hour; after that elapsed time, the next successfully committed window triggers an attempt. Further attempts are spaced from the previous attempt, including failures, to avoid repeatedly copying a large database after every window. Clean completion backs up remaining changes; a no-op run creates a backup of the existing database. Failed/cancelled collection does not start a final backup. `media-db` does not trigger snapshots: after media collection, repeating a completed fixed history range with backups enabled backs up the newly stored images without requesting history.

The collector keeps its exclusive `.collection.lock` reservation through backup work, pausing the next window. `HistoryStore.snapshotTo` uses bound-parameter `VACUUM INTO` to a private empty file, with `synchronous=FULL`. This includes committed WAL contents if the source has been put in WAL mode; no live database or journal files are copied. The normal database journal mode is unchanged. The snapshot includes all chats and coverage, rather than only the active collection range. Backups may contain incomplete historical coverage, faithfully preserving the checkpoints from which collection can resume.

`src/collection-backup.ts` performs `PRAGMA integrity_check` on the snapshot, reads image descriptors from that snapshot, and copies verified complete images once per content-addressed filename. Missing/corrupt complete files fail the backup; repair them with `media-db`. Pending/failed sources remain in the snapshot for later download. Unreferenced old image files and disposable caches are not copied. The bundle contains `history.sqlite`, `history.sqlite.media/`, and a SHA-256 checksum list named `SHA256SUMS`. Restoring requires no conversion or schema rebuilding. No credentials are included.

Staging uses a fresh mode-700 sibling `.teams-backup-staging-*` directory outside the configured backup root. Files are mode 600. After synchronizing the files/directories and verifying media checksums, rename the entire staging directory atomically into a unique timestamp/UUID directory under the root, then synchronize the parent directories. Require the root and its parent to share a local filesystem; reject symlink components and overlap with live database/media. Handled failures remove only their own staging directory, preserving previous backups. A hard crash may leave staging for manual cleanup after confirming the collector has stopped.

Published backups are never modified or deleted automatically. This intentionally replaces the proposed two-copy rotation: an independent uploader could still be reading an older snapshot when rotation deletes it. Target exactly the published backup root with `rclone copy`, excluding its parent/staging, and coordinate any later retention policy with the uploader. Each snapshot duplicates the database and complete media, so both local and remote storage grow. Rclone may miss a newly published directory until its next scan. A remote folder is not an atomic upload and may be partial; a manifest arriving first is not a completion marker. Download one snapshot into a separate working directory and require `sha256sum -c SHA256SUMS` to pass before restoration. Keep the database and its adjacent media directory together; never resume collection directly inside a published backup.

Backup failures emit a warning and increment the final result's `backups.failed`; they do not turn successful history collection into a nonzero exit. The result also reports `backups.saved` and, when present, `backups.lastSnapshot`. Cancellation still follows normal collection cancellation semantics. An hourly successful snapshot followed by a later HTTP failure remains available alongside live database checkpoints.

Implementation reference: [SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause) documents consistent live snapshots and synchronization of completed output with FULL/NORMAL synchronous settings; [rclone copy](https://rclone.org/commands/rclone_copy/) documents its non-deleting transfer semantics.

## Independent image collection

`media-db` queries source references and reuses `downloadImages`: the same signature/size checks, origin restrictions, regional translation, destination-specific cookies, shared cache, and conditional refresh. It publishes durable files under `<absolute-database-path>.media/<sha256>.<extension>` and commits each successful image immediately after file publication. Table descriptors use portable `media/<sha256>.<extension>` paths, interpreted by basename inside that managed directory. No intermediate JSON file is created.

Before skipping completed work, verify file/directory types (no symlinks), byte length, checksum, and signature. Valid completed bytes need neither HTTP nor the disposable shared cache. Missing/corrupt files become pending for cache restoration or download. Cache validators provide conditional refresh; absent cache entries receive normal downloads. A failed refresh preserves previously verified metadata/files. Old unreferenced content-addressed files are retained.

Successful images survive a later failure. The active unfinished resource is marked failed with a sanitized reason, or pending on cancellation; unstarted work remains pending. Rerun to continue. Unsupported references produce partial coverage. Cookies, request cursors, and raw HTTP error bodies are never stored or logged. Each database remains bound to one account, and image identities are shared across its chats.

## Offline archive generation and analytics

Database export reads coverage, messages, and image mappings in one SQLite snapshot and sorts payloads by arrival/ID. Verified downloaded files are copied into the new bundle's `media/` directory once per content-addressed path, with mappings for every referencing message. All downloaded/supported references yield complete media; a downloaded/pending mix or unsupported references yields partial media. All pending supported references retain not-downloaded placeholders; no image references is trivially complete. Missing/corrupt complete files fail before JSON publication: repair through `media-db` or use `--no-media`. Markdown uses local links or placeholders. Existing JSON `media` commands remain supported and update their bundles, not SQLite.

The `collection` section lists overlapping complete intervals. `history.source` identifies SQLite; HTTP export counters remain zero. Original history request counts stay in `completed_windows`.

JSON is published before Markdown. An existing destination is refused, and a Markdown failure leaves the published JSON available for `convert`. Selected messages and rendered output currently reside in memory, so exporting an exceptionally large range may require smaller subrange exports even though collection checkpoints are incremental.

Simple analytics need no normalized schema: query indexed dates and IDs or use `json_extract(payload_json, ...)`. More specialized sender/member/content projections can be added later from source data. Treat the collection schema as versioned application storage rather than a public API.

For example, count messages per UTC day in a SQLite client (replace the chat ID):

```sql
SELECT date(arrival_ms / 1000, 'unixepoch') AS utc_day, count(*) AS messages
FROM messages WHERE chat_id = '<raw-chat-id>'
GROUP BY utc_day ORDER BY utc_day;
```

## Validation

`tests/collection.test.ts` covers coverage, HTTP failure recovery, rollback, payload preservation, identity isolation, reservations, and offline CLI exports. `tests/database-media.test.ts` adds atomic reference indexing, cross-chat deduplication, per-image failure/cancellation recovery, cache-independent reuse, corrupt-file repair, conditional refresh, regional cookie isolation, transactional migration/backfill, and CLI media/export flows without intermediate JSON. Ordinary `bun test` remains offline without saved credentials.

`tests/collection-backup.test.ts` covers multi-chat restoration with media, checksum manifests, uncheckpointed WAL data, private permissions, publication outside staging, unsafe destinations, cancellation/failure cleanup, hourly scheduling, continued collection after backup failure, and retention of an hourly snapshot after a later history error. The collection CLI integration test exercises default backups on new work and no-op resume, a custom destination, disabling backups without deleting existing snapshots, and rejection of conflicting backup flags.

The earlier live experiments established consistent week-versus-day message sets, exact timestamp boundaries, interrupted restart, and no-cursor historical seeking on the sampled account. They support this retrieval strategy but do not constitute a public Teams contract, an authoritative completeness count, or proof of two-year retention.

Initial text-collection verification on 2026-11-11 used a private temporary database and the previously tested October 26–November 2 window (Jakarta time). Two HTTP history requests saved 265 messages in one completed checkpoint. Repeating the fixed range made zero requests. Offline export preserved all 265 payloads. That initial change passed type checking and 368 offline tests.

Direct SQLite image verification on 2026-11-11 selected the complete October 26 day (three messages, one supported image) from that earlier verified archive and indexed it in a private temporary database. A private cache forced one cold live HTTP 200 image request. Repeating `media-db` used the verified stored file with zero requests. Offline export copied the same 24,991 bytes and rendered a local Markdown image link. No intermediate archive was needed before download. Normal databases, exports, credentials, and caches remained unchanged; the image test made no history requests. This verifies one sampled image/origin, not every origin, conditional live 304 behavior, or full-history collection. The extended implementation passes type checking and all 379 offline tests.

Implementation references: [Bun SQLite](https://bun.sh/docs/runtime/sqlite) for the built-in driver and synchronous transactions; [SQLite JSON functions](https://sqlite.org/json1.html) for projections over stored payloads.

### Collection execution logs

`collect`, `media-db`, and `export-db` automatically write a private, timestamped log per invocation in `<database>.logs/` and print its path. Use `--no-log` to disable file logging. Logs include the requested range, already-collected duration and remaining gap count, fetched pages and checkpoints, profile warnings, backup outcomes, final results, and handled failures or cancellation. Fully covered ranges explicitly report that no history requests are needed. Skipped intervals are summarized rather than listed individually.

Each log starts with the normalized command input, working directory, and resolved options, including defaults and ISO date bounds when available. Input uses parsed flags (including parser defaults), so shell quoting, flag order, launcher details, and ignored arguments after `--` are not preserved. Credential-file arguments are shown as `[REDACTED]`; only explicitly selected operational fields are recorded. The header is saved to the log file only, before credential or database access.

Logs contain operational metadata, including paths and account/chat identifiers, but no message bodies, credentials, or raw HTTP URLs. They are separate from SQLite checkpoints and backup snapshots; coverage in SQLite remains authoritative. Logging failures warn and collection continues. On Unix, files are mode 600 in a mode-700 log directory. Windows privacy depends on filesystem ACLs; the CLI does not validate or configure those ACLs. Database parent directories may be symlink aliases; the log directory itself must not be a symlink. Logs are not automatically pruned; remove old logs when no longer needed. Invalid command options fail before log creation. Hard crashes may leave a log without a final status, and logs are not fsynced per event.

Collection workflow logs identify the command that ran. `media-db` records verified downloaded-image skips, pending work, refresh mode, per-image outcomes, and the final image summary even on handled download failure. `export-db` records the requested chat/range and media/Markdown options, coverage verification, copied-image progress, and JSON/Markdown publication. All three commands support `--no-log`. The export database remains read-only and offline; its diagnostic log is a separate sibling file. Standalone JSON commands (`export`, `media`, `convert`) do not write these database workflow logs.

Version 3 recalculates every stored unsupported-image count using standard Teams emoji recognition. Writable opens migrate version 2 atomically; version 1 upgrades include both image indexing and count repair in one transaction. Original payloads, coverage, and downloaded image metadata remain unchanged. Failed parsing rolls back the upgrade. Read-only version 1/2 opens remain supported without writes; version 2 retains its old counts until a writable collection or media operation migrates it.
