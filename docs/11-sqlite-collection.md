# Resumable SQLite collection

Implemented for long historical downloads where an authentication or HTTP failure must not discard completed collection work. `collect` stores source data and image references; `media-db` independently downloads images; `export-db` generates portable version 1 JSON and Markdown with saved local images. Existing direct `export` and JSON `media` behavior is unchanged. Normalized analytics tables can be derived later without contacting Teams again.

## Commands

```sh
bun run teams collect --db exports/history.sqlite --chat-label 'Project Alpha' --all
bun run teams collect --db exports/history.sqlite --chat '<raw-id>' --since '2024-11-01T00:00:00Z'
bun run teams media-db --db exports/history.sqlite
bun run teams export-db --db exports/history.sqlite --chat '<raw-id>' --out exports/complete
```

Collection requires `--db`, one of `--chat` or `--chat-label`, and one of `--all`, `--last Nd`, `--since`, or paired `--from`/`--to`. Raw IDs do not require directory/profile lookup. Labels use the shared exact matcher and verified directory/name resolution. Credentials use the normal lookup or `--credentials`. Bounds are inclusive/exclusive millisecond instants; future ends fail. `--all` selects Unix millisecond 1 through one captured invocation time. Only the endpoint's accessible history can be recovered.

`media-db` requires an existing `--db` and credentials for its account (normal lookup or `--credentials`). It handles all chats by default; optional `--chat <raw-id>` limits the queue. `--refresh-media` revalidates through the shared cache. No JSON export or history/directory/profile request is needed.

`export-db` requires `--db`, a raw `--chat`, and a new `--out` directory. Optional `--from` and `--to` must appear together; otherwise use the minimum/maximum completed bounds. Any coverage gap fails before publication. Export is offline without credentials. `--no-markdown` creates JSON only; `--no-media` skips image copying and emits placeholders.

## Schema version 2

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

After account validation, writable opens transactionally migrate version 1: add image tables/indexes and unsupported counts, backfill saved message references, and advance the version together. Migration performs no HTTP and preserves messages and coverage; failures roll back the schema/backfill. Read-only version 1 exports remain supported without migration and retain their legacy not-downloaded media state. Unknown future versions fail. Database version 2 does not change portable JSON archive version 1.

## Retrieval and recovery

Subtract complete coverage from the requested range and visit gaps newest first in initially seven-day windows. Paginate each window to exhaustion, keeping it in memory until completion. Then commit messages, image references/links, unsupported counts, and coverage together in a synchronous immediate transaction. Any transaction error rolls everything back; no network work occurs inside it. `messageImageReferences` uses Bun's synchronous HTML parser and the same source rules as normal image downloads.

After a nonempty window, the next span is seven days. After an exhausted empty window, double the span. This makes progress through long empty periods before the chat's creation economical; it never treats an empty week as proof that all earlier history is absent. Each expanded window must still reach pagination exhaustion, and an expanded window containing data resets the next span to seven days. The page-delay options govern waits both within pagination and between windows.

On HTTP failure, credential rejection, cancellation, or conflicting messages, stop with a nonzero exit and retain completed checkpoints. Rerunning the request subtracts those checkpoints and re-fetches the unfinished window from a fresh date-bound request. A moving invocation-time endpoint also adds a new uncovered tail. No durable cursor or ordering relationship between pages is assumed.

An adjacent `.collection.lock` directory excludes collectors and database media updaters throughout HTTP work and migration. Handled exit releases it. After a crash, inspect active updaters before removing a stale reservation. SQLite rollback-journal transactions use full synchronization. Unrelated and unknown-version files fail. New database files use mode 600 and new parent directories mode 700; unsafe database permissions and symlinks fail. Back up the database and adjacent `<database>.media` directory together with updaters stopped.

## Independent image collection

`media-db` queries source references and reuses `downloadImages`: the same signature/size checks, origin restrictions, regional translation, destination-specific cookies, shared cache, and conditional refresh. It publishes durable files under `<absolute-database-path>.media/<sha256>.<extension>` and commits each successful image immediately after file publication. Table descriptors use portable `media/<sha256>.<extension>` paths, interpreted by basename inside that managed directory. No intermediate JSON file is created.

Before skipping completed work, verify file/directory types (no symlinks), byte length, checksum, and signature. Valid completed bytes need neither HTTP nor the disposable shared cache. Missing/corrupt files become pending for cache restoration or download. Cache validators provide conditional refresh; absent cache entries receive normal downloads. A failed refresh preserves previously verified metadata/files. Old unreferenced content-addressed files are retained.

Successful images survive a later failure. The active unfinished resource is marked failed with a sanitized reason, or pending on cancellation; unstarted work remains pending. Rerun to continue. Unsupported references produce partial coverage. Cookies, request cursors, and raw HTTP error bodies are never stored or logged. Each database remains bound to one account, and image identities are shared across its chats.

## Offline archive generation and analytics

Database export reads coverage, messages, and image mappings in one SQLite snapshot and sorts payloads by arrival/ID. Verified downloaded files are copied into the new bundle's `media/` directory once per content-addressed path, with mappings for every referencing message. All downloaded/supported references yield complete media; a downloaded/pending mix or unsupported references yields partial media. All pending supported references retain not-downloaded placeholders; no image references is trivially complete. Missing/corrupt complete files fail before JSON publication: repair through `media-db` or use `--no-media`. Markdown uses local links or placeholders. Existing JSON `media` commands remain supported and update their bundles, not SQLite.

The `collection` section lists overlapping complete intervals. `history.source` identifies SQLite; HTTP export counters remain zero. Original history request counts stay in `completed_windows`.

JSON is published before Markdown. An existing destination is refused, and a Markdown failure leaves the published JSON available for `convert`. Selected messages and rendered output currently reside in memory, so exporting an exceptionally large range may require smaller subrange exports even though collection checkpoints are incremental.

Simple analytics need no normalized schema: query indexed dates and IDs or use `json_extract(payload_json, ...)`. More specialized sender/member/content projections can be added later from source data. Treat the collection schema as versioned application storage rather than a public API.

## Validation

`tests/collection.test.ts` covers coverage, HTTP failure recovery, rollback, payload preservation, identity isolation, reservations, and offline CLI exports. `tests/database-media.test.ts` adds atomic reference indexing, cross-chat deduplication, per-image failure/cancellation recovery, cache-independent reuse, corrupt-file repair, conditional refresh, regional cookie isolation, transactional migration/backfill, and CLI media/export flows without intermediate JSON. Ordinary `bun test` remains offline without saved credentials.

The earlier live experiments established consistent week-versus-day message sets, exact timestamp boundaries, interrupted restart, and no-cursor historical seeking on the sampled account. They support this retrieval strategy but do not constitute a public Teams contract, an authoritative completeness count, or proof of two-year retention.

Initial text-collection verification on 2026-11-11 used a private temporary database and the previously tested October 26–November 2 window (Jakarta time). Two HTTP history requests saved 265 messages in one completed checkpoint. Repeating the fixed range made zero requests. Offline export preserved all 265 payloads. That initial change passed type checking and 368 offline tests.

Direct SQLite image verification on 2026-11-11 selected the complete October 26 day (three messages, one supported image) from that earlier verified archive and indexed it in a private temporary database. A private cache forced one cold live HTTP 200 image request. Repeating `media-db` used the verified stored file with zero requests. Offline export copied the same 24,991 bytes and rendered a local Markdown image link. No intermediate archive was needed before download. Normal databases, exports, credentials, and caches remained unchanged; the image test made no history requests. This verifies one sampled image/origin, not every origin, conditional live 304 behavior, or full-history collection. The extended implementation passes type checking and all 379 offline tests.

Implementation references: [Bun SQLite](https://bun.sh/docs/runtime/sqlite) for the built-in driver and synchronous transactions; [SQLite JSON functions](https://sqlite.org/json1.html) for projections over stored payloads.
