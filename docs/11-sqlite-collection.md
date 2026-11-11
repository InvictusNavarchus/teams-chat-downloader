# Resumable SQLite collection

Implemented for long historical downloads where an authentication or HTTP failure must not discard completed collection work. `collect` stores source data; `export-db` generates portable version 1 JSON and Markdown. Existing direct `export` behavior is unchanged. Normalized analytics tables can be derived later without contacting Teams again.

## Commands

```sh
bun run teams collect --db exports/history.sqlite --chat-label 'Project Alpha' --all
bun run teams collect --db exports/history.sqlite --chat '<raw-id>' --since '2024-11-01T00:00:00Z'
bun run teams export-db --db exports/history.sqlite --chat '<raw-id>' --out exports/complete
bun run teams media --input exports/complete/chat.json
```

Collection requires `--db`, one of `--chat` or `--chat-label`, and one of `--all`, `--last Nd`, `--since`, or paired `--from`/`--to`. Raw IDs do not require directory/profile lookup. Labels use the shared exact matcher and verified directory/name resolution. Credentials use the normal lookup or `--credentials`. Bounds are inclusive/exclusive millisecond instants; future ends fail. `--all` selects Unix millisecond 1 through one captured invocation time. Only the endpoint's accessible history can be recovered.

`export-db` requires `--db`, a raw `--chat`, and a new `--out` directory. Its optional `--from` and `--to` must appear together. Otherwise it selects the minimum/maximum completed bounds for the chat. Any gap inside the selected range fails before output publication. It does not read credentials or contact Teams. `--no-markdown` creates JSON only. Image source references survive; image bytes are populated later through `media`.

## Schema version 1

| Table | Stored fields |
| --- | --- |
| `collection_meta` | Singleton schema version and credential `account_id` |
| `chats` | Raw `chat_id`, optional resolved `label` |
| `messages` | `chat_id`, `message_id`, integer `arrival_ms`, complete `payload_json` |
| `completed_windows` | `chat_id`, `from_ms`, `to_ms`, `completed_at`, `history_json`, `requests_json` |

The messages primary key is `(chat_id, message_id)`; an index on `(chat_id, arrival_ms, message_id)` supports ordered range reads. Account isolation is at the database level: one file belongs to one exact account ID. Different chats may reuse IDs. SQLite JSON text retains nested/unknown Teams properties; extracted IDs/timestamps support indexing without replacing source fields. The original timestamp precision remains in the payload even though range indexing uses JavaScript millisecond precision, matching ordinary exports.

Coverage records are independent of message presence. A successful empty interval is covered; a failed request is not. History/request JSON contains counts only, never request headers or continuation state. Identical stored records are deduplicated using structural equality; conflicting payloads fail the whole window. The collector does not invent version ordering, preserve multiple observations as revisions, infer deletions, or automatically refresh completed ranges. Those policies require a separate design if synchronization is introduced.

## Retrieval and recovery

Subtract the union of saved complete coverage from the requested range. Visit gaps newest first. Begin each gap with a seven-day elapsed-time window, then use ordinary sequential history pagination to exhaustion inside that window. The entire window stays in memory until it completes. Only then commit its messages and coverage together using a synchronous immediate transaction. Any transaction error rolls back both. No network work occurs inside a SQLite transaction.

After a nonempty window, the next span is seven days. After an exhausted empty window, double the span. This makes progress through long empty periods before the chat's creation economical; it never treats an empty week as proof that all earlier history is absent. Each expanded window must still reach pagination exhaustion, and an expanded window containing data resets the next span to seven days. The page-delay options govern waits both within pagination and between windows.

On HTTP failure, credential rejection, cancellation, or conflicting messages, stop with a nonzero exit and retain completed checkpoints. Rerunning the request subtracts those checkpoints and re-fetches the unfinished window from a fresh date-bound request. A moving invocation-time endpoint also adds a new uncovered tail. No durable cursor or ordering relationship between pages is assumed.

An adjacent `.collection.lock` directory excludes other collectors for that file, including during HTTP work. Handled exit releases it. A hard crash may leave it: inspect active collectors before removing it. SQLite rollback-journal transactions with full synchronization protect committed data across crashes; file creation/schema initialization failures do not imply any saved coverage. Existing unrelated or unsupported databases are refused rather than migrated or overwritten. New databases use Unix mode 600 and parent directories are created with mode 700; unsafe existing database permissions and symlink database files fail. Back up a collection while its collector is stopped.

## Offline archive generation and analytics

Database export uses a read transaction so its coverage check and message read share one SQLite snapshot. It sorts by arrival timestamp and then message ID, keeps complete source payloads, and emits `media.status = not-downloaded`. The `collection` section lists overlapping completed windows and their completion times. `history.source` identifies SQLite; HTTP counters describe the offline export (zero), while original collection counts remain in `completed_windows`.

JSON is published before Markdown. An existing destination is refused, and a Markdown failure leaves the published JSON available for `convert`. Selected messages and rendered output currently reside in memory, so exporting an exceptionally large range may require smaller subrange exports even though collection checkpoints are incremental.

Simple analytics need no normalized schema: query indexed dates and IDs or use `json_extract(payload_json, ...)`. More specialized sender/member/content projections can be added later from source data. Treat the collection schema as versioned application storage rather than a public API.

## Validation

`tests/collection.test.ts` covers coverage union/subtraction, HTTP 401 after a saved window and during pagination, fresh-cursor retries, atomic rollback on conflicting records, identical deduplication, unknown/nested field preservation, empty-period expansion, cancellation cleanup, account/chat isolation, unsafe files and symlinks, concurrent reservations, offline gap rejection, sorted JSON/Markdown round trips, exact label selection, and real CLI collection/resume/offline export using synthetic HTTP. These tests run without saved user credentials or live requests. Ordinary `bun test` remains offline.

The earlier live experiments established consistent week-versus-day message sets, exact timestamp boundaries, interrupted restart, and no-cursor historical seeking on the sampled account. They support this retrieval strategy but do not constitute a public Teams contract, an authoritative completeness count, or proof of two-year retention.

Live collection verification on 2026-11-11 used a private temporary database and the previously tested October 26–November 2 window (Jakarta time). Two HTTP history requests saved 265 messages in one completed checkpoint. Repeating the same fixed range completed with zero HTTP requests. Offline JSON/Markdown export returned all 265 original payloads, structurally identical to the earlier independent download. Normal exports, caches, and credentials were unchanged; no full-history collection was started. Type checking and all 368 offline tests passed for this changeset.

Implementation references: [Bun SQLite](https://bun.sh/docs/runtime/sqlite) for the built-in driver and synchronous transactions; [SQLite JSON functions](https://sqlite.org/json1.html) for projections over stored payloads.
