# AGENTS.md — Contributor & AI Agent Guide

## 1. Project Overview & Philosophy

`teams-chat-download` is a Bun-powered command-line interface (CLI) for exporting chat history and inline media from **Microsoft Teams Free with personal Microsoft accounts** (`teams.live.com`).

### Core Design Principles

1. **Direct HTTP Over Browser Automation**: Browser automation (via `playwright-core`) is strictly isolated to the interactive `login` command for credential capture. Listing chats, fetching history, and downloading media run entirely through direct HTTP calls using `ky`.
2. **Lossless Collection and Portable JSON Archives**: Resumable collection uses account-scoped SQLite with full original message JSON and explicit completed intervals. The portable export remains a Version 1 JSON archive (`chat.json`), retaining rich text, original arrival timestamps, message edit states, and unknown Teams API properties without loss. Analytics projections must remain derivable from the saved payloads.
3. **Sibling Markdown Representation**: A readable Markdown transcript (`chat.md`) is rendered alongside the JSON archive by default. Markdown is derived from the JSON and can be regenerated completely offline.
4. **Two-Tier Persistent Caching**:
   - **Profiles Cache**: `$XDG_CACHE_HOME/teams-chat-download/profiles/` caches participant display names for 24 hours to resolve one-to-one chat labels.
   - **Media Cache**: `$XDG_CACHE_HOME/teams-chat-download/media/` deduplicates images by account and media object key, supporting conditional HTTP 304 revalidation and offline local reuse.
5. **Defensive Output Operations**: Default `--last 1d` exports refresh one verified account/chat/local-date folder; snapshots and explicit `--out` exports refuse existing folders. File writes are atomic (written to temp files then renamed). Private file permissions (`0600`/`0700`) are strictly enforced for credentials and profiles.

---

## 2. Project Structure

```
teams-chat-download/
├── docs/                 # User guides, technical references, and historical research
│   ├── README.md                   # Documentation navigation and evidence categories
│   ├── user-guide.md               # Detailed current usage, backups, and recovery
│   ├── development.md              # Offline checks and opt-in live smoke verification
│   ├── 01-findings-and-evidence.md
│   ├── 02-http-protocol.md           # Authoritative Teams HTTP endpoints & observed quirks
│   ├── 03-authentication-and-browser.md
│   ├── 04-cli-design.md
│   ├── 07-architecture.md           # Stack choices, data flow, responsibilities
│   ├── 08-participant-profiles.md   # Profile lookup and name caching rules
│   ├── 09-browser-login.md          # Playwright login lifecycle and capture mechanics
│   ├── 10-image-export.md           # Media extraction, caching, and revalidation
│   └── 11-sqlite-collection.md      # SQLite schema, coverage, recovery, and offline export
├── exports/              # Default export output directory (git-ignored)
├── src/                  # Application source code
│   ├── archive.ts        # Version 1 JSON archive schema, serialization, and validation
│   ├── archive-media.ts  # Media download coordination for archives (inline and post-export)
│   ├── chat-selection.ts # Shared exact label matching, fallback rejection, and duplicate diagnostics
│   ├── cli.ts            # CAC argument parsing, command dispatch, terminal progress, and exit handling
│   ├── collect.ts        # Single/batch backward collection, checkpoint pacing, and exclusive reservation
│   ├── collection-backup.ts # Verified SQLite/media snapshots and hourly collection backup scheduling
│   ├── command-validation.ts # Command schemas, inferred types, defaults application, and resolution
│   ├── config.ts         # Shared application defaults and command limits
│   ├── convert.ts        # Offline single-archive JSON-to-Markdown conversion
│   ├── convert-all.ts    # Batch offline JSON-to-Markdown conversion
│   ├── credentials.ts    # XDG state loading, credential validation, and file permission checks
│   ├── date-window.ts    # Shared history date-window contract and validation
│   ├── daily-export.ts   # Shared daily directory and archive refresh validation
│   ├── database-export.ts # Offline SQLite-to-JSON/Markdown bundle publication
│   ├── database-media.ts # Independent SQLite image queue downloads and per-image checkpoints
│   ├── errors.ts         # Domain error classes, validation errors, and sanitized formatters
│   ├── export.ts         # Legacy internal archive helper; not a CLI download path
│   ├── download.ts       # Unified resumable collection, images, and portable export
│   ├── collection-path.ts # Per-account default database and offline discovery
│   ├── export-path.ts    # Chat/period layout, stable daily dates, and kebab-case label sanitization
│   ├── export-discovery.ts # Bounded legacy and grouped archive candidate discovery
│   ├── http.ts           # Ky HTTP client wrapper, retry policy, backoff, and request accounting
│   ├── history-store.ts  # Account-scoped SQLite payload storage, transactional coverage, and range reads
│   ├── login.ts          # Playwright helper for interactive browser sign-in and token capture
│   ├── live-smoke.ts     # Opt-in live HTTP probe, bounded sampling, temporary caches, and CLI
│   ├── markdown.ts       # Turndown-based HTML-to-Markdown conversion and transcript rendering
│   ├── media.ts          # Source/destination URI validation, regional image translation, ASM cookies, and cache lookup
│   ├── output.ts         # Atomic filesystem writes and directory permission enforcement
│   ├── profiles.ts       # Direct self/batch reads, shared name labeling, and 24-hour disk caching
│   ├── smoke-targets.ts  # Same-account archive discovery and safe smoke-test input extraction
│   └── teams.ts          # Teams API client (raw directory, validated page iterator, full history, pacing)
├── tests/                # Bun test suites (unit, mock HTTP, and integration flows)
│   ├── archive-media.test.ts
│   ├── chats-output.test.ts
│   ├── convert.test.ts
│   ├── convert-all.test.ts
│   ├── credentials.test.ts
│   ├── export-cli.test.ts
│   ├── export-path.test.ts
│   ├── export.test.ts
│   ├── http.test.ts
│   ├── login.test.ts
│   ├── live-smoke.test.ts # Synthetic coverage of live-runner budgets, checks, and credential isolation
│   ├── markdown.test.ts
│   ├── media.test.ts
│   ├── command-validation.test.ts
│   ├── collection.test.ts # SQLite recovery, rollback, account scope, CLI, and offline export
│   ├── collection-backup.test.ts # Snapshot restoration, WAL, publication, failure/cancellation, and scheduling
│   ├── database-media.test.ts # Image indexing, migration, retries, durable files, and portable exports
│   ├── profiles.test.ts
│   ├── smoke-targets.test.ts # Discovery ordering, account isolation, filesystem scope, and cancellation
│   └── teams.test.ts
├── biome.json            # Biome formatter and linter configuration
├── package.json          # Dependencies, scripts, and runtime engines
├── README.md             # End-user documentation and setup instructions
└── tsconfig.json         # Strict TypeScript configuration
```

---

## 3. Critical Protocol Invariants & Guardrails

When modifying or extending this codebase, agents **must** respect these domain rules:

1. **Authentication Headers Are Service-Specific**:
   - Chat History: Uses `Authentication` (not `Authorization: Bearer ...`).
   - Chat Directory: Uses `x-skypetoken`.
   - Profiles: Uses `Authorization: Bearer ...` paired with `x-skypetoken`.
   - Media (Images): Uses the `skypetoken_asm` cookie sent only to matching media origins.
   - Inline HTTPS `id-prod.asyncgw.teams.microsoft.com/v1/objects/{id}/views/imgo` sources are translated to the same path on `experimental-api.asm.skype.com`, using only that destination's media cookie. Never send credentials to the regional source host, infer other regions, or translate signed/query-bearing or namespaced regional URLs. `imageSourceUrl` recognizes source references for downloads and smoke sampling; `imageUrl` validates actual cookie destinations for login and HTTP. Preserve original source URLs and their digests in messages, cache keys, and Markdown mappings.
   - _Never merge these into a generic global credential bundle._
   - Login's direct self-profile verification uses `forceRefresh=false` to validate the captured pair and derive account identity without competing with the browser's forced refresh. Concurrent forced self-profile refreshes have reproduced HTTP 409; do not reintroduce forced refresh for login verification.
2. **Preserve Date Bounds on History Pagination**:
   - The `backwardLink` returned by Teams pagination drops the `endTime` parameter. If sent without correction, Teams reverts to returning present-day messages. The client (`teams.ts`) **must** preserve the initial requested `endTime` on every pagination request.
3. **Pacing and Delay**:
   - Sequential history requests must be paced with a delay (default 1–2.5 seconds) to avoid trigger-happy rate limiting on private consumer endpoints.
4. **Preserve Unknown Fields**:
   - Use `z.looseObject` in Zod schemas for Teams payloads. Never silently drop unknown fields from the JSON archive.
5. **No Barrel Exports**:
   - Use direct, explicit file imports (e.g. `import { exportChat } from "./export.ts"`).
6. **Zero Credential Leakage**:
   - Never print raw URLs containing auth tokens, cookies, or auth headers in logs, terminal summaries, or error messages.
7. **Unified Collection Commands**:
   - `download` performs resumable collection, pending image downloads, and offline SQLite export. `collect` performs only collection. `export` is always offline; `images` handles saved image references. `export-db` and `media-db` remain aliases. Standalone `media --input` and conversion commands remain supported.
   - `download` and `collect` require exactly one chat selector and one date mode (`--all`, `--last`, `--since`, or paired bounds). `collect` additionally accepts `--all-chats` instead of a single selector, selecting only saved database IDs. Completed intervals are skipped; there is no history refresh or `--resume` flag. Preserve saved messages and conflict rejection. Do not synchronize later edits/deletions implicitly.
   - Online label selection uses the current directory and profile cache with exact trimmed case-insensitive matching and fallback/duplicate rejection. Raw IDs skip directory/profile lookup. Offline commands use saved labels only.
   - `src/download.ts` orchestrates existing collection, image, and export functions. `src/collection-path.ts` owns default account-hashed database paths in user state and unambiguous offline discovery. `--db` overrides the default; existing custom databases are not migrated. Offline export must not load credentials.
   - Download `--last Nd` without `--out` uses the same per-day folders as offline export. Explicit `--out` produces one new combined bundle; other date modes default to timestamped combined snapshots. Image failure attempts text publication and returns failure; cancellation stops publication. Failed history leaves old exports intact.

8. **Bounded Live Verification**:
   - `bun run test:live` defaults to automatic fixture discovery and requires no selector. Accept at most one explicit override: `--fixture <chat.json>`, `--chat <id>`, or `--chat-label <label>`. It is explicitly opt-in and must never run as part of ordinary `bun test`. Both export and smoke label selection use `src/chat-selection.ts` for exact matching, generic fallback rejection, and duplicate diagnostics.
   - With no date arguments, default to the last two local calendar days including today, matching `export --last 2d`: yesterday at local midnight to one captured invocation time. `src/config.ts` owns `defaultLiveSmokeDays`; command validation shares the calendar-day calculation with exports. Explicit overrides require both timezone-qualified `--from` and `--to`; reject single bounds and future ends. Print the resolved window before requests; never widen it automatically to satisfy pagination/media coverage.
   - Saved credentials use the normal lookup or explicit `--credentials`.
   - Validate a fixture with the shared archive reader and require an exact `accountId` match before HTTP. Read its raw chat ID, supported non-self sender, and supported inline image as known inputs. Never treat archived responses as live passes or change the default live date window to the archived window. Reject fixture/ID/label selector combinations rather than guessing a saved label mapping.
   - `src/smoke-targets.ts` discovers complete same-account archives under the configured default export root in the current working directory: root JSON files, legacy direct export-folder `chat.json`, and standard `<chat>/<date-or-period>/chat.json` bundles. Discovery is bounded to those layouts, without symlinks, media traversal, or deeper recursion. Prefer archives with useful sender/image inputs, then newer modification times and deterministic path ordering. Skip invalid/unreadable automatic candidates with a count, ignore other accounts, and print the selected path. Explicit fixtures bypass discovery and fail rather than falling back when invalid. Without any fixture or selector, use the first live directory chat if available.
   - An explicit raw ID or label controls history and must never be silently replaced by a discovered fixture chat. Automatically discovered account-scoped targets may still support participant/media checks; label mappings must come from verified live directory/name results, never archive filenames.
   - Share `readHistoryPages` between the smoke runner and full `readHistory`; only the runner stops after two pages. Report the first page and continuation as separate checks, so a failed continuation does not erase a successful first-page probe. Sampling must never publish a complete archive or alter export exhaustion semantics.
   - Read the directory once and probe the self profile independently through `readSelfProfile`. Query a known participant through `readParticipantProfiles`, using fixture senders before directory members. Login-generated account IDs allow self-MRI exclusion even when the self probe fails; legacy custom account labels need a successful self response to identify a non-self participant. Source sender URLs are parsed only as identities and never used as request destinations.
   - Profile probes never reuse cached names. Label selection resolves all required one-to-one names and uses the shared `labelChats` mapping; it still depends on live directory/name discovery. Fixture/raw-ID history probes must run independently, without a directory-membership veto. Prefer a fixture image reference over live history discovery, so media can run after directory or history failure. Download at most one supported image using private temporary media storage; clean it on handled completion/failure/cancellation.
   - Validate cold download, zero-request local reuse, and conditional refresh when validators exist. Report missing coverage as `UNVERIFIED` and exit 1 if any required check fails or remains unverified. A conditional HTTP 200 passes refresh validation but must explicitly say that the HTTP 304 branch was not verified.
   - Keep normal caches, credentials, and exports unchanged. Never log credentials, source URLs, or message bodies. Live coverage is limited to the sampled participant family and media origin; it does not verify login capture or full history exhaustion.

9. **Daily Export Regeneration**:
   - `download --last Nd` and offline `export --last Nd` regenerate one folder per local day from SQLite. Regeneration does not re-fetch completed history. Explicit download `--out` produces a new combined bundle instead.
   - Reuse `src/daily-export.ts` validation and `withArchiveLock` during per-day publication. Validate exact account/chat/start bounds and refuse newer endpoints, symlinks, and unexpected types. JSON and Markdown remain individually atomic; Markdown failure retains JSON.
   - `--no-markdown` removes stale daily transcripts after JSON publication. Unreferenced old media remains on disk. Failed history retrieval leaves existing bundles intact. Standalone JSON media shares the archive reservation.
   - `src/export-discovery.ts` remains the bounded discovery helper for conversion and smoke fixtures.

---

## SQLite collection invariants

- `collect [--db <file>]` requires exactly one of `--chat`, `--chat-label`, or `--all-chats` and one date mode (`--all`, `--last`, `--since`, or paired `--from`/`--to`). `--all` uses `[1, invocation-time)`; explicit future ends fail. Resolve through `src/command-validation.ts`. `src/config.ts` owns `collectionWindowMs`.
- `collect --all-chats` reads `HistoryStore.savedChatIds()` after account validation, including unlabeled/duplicate-label chats, in raw-ID order without directory/profile HTTP or label updates. Reject combining single selectors before credentials/database access; an empty database fails before history HTTP. `collectChats` shares the existing window loop with the single-chat `collectHistory` adapter; preserve the adapter's result shape for `download`. Hold one reservation/store across the batch, use one resolved window and shared backup scheduling, and pace windows across chat boundaries. Skip completed coverage independently per chat; `--all` catches new tails and older gaps. Log per-chat start/completion and include per-chat/aggregate counts in the final result. Stop on failure/cancellation, identify the active chat, retain checkpoints, release the lock, and skip final backup. `download` remains single-chat and rejects `--all-chats`.
- `src/collect.ts` processes uncovered intervals newest first using `readHistory`. Start at seven elapsed days; double the span only after an exhausted empty interval and reset on data. Never infer exhaustion from a single empty week or from the oldest saved timestamp. Apply the page-delay range between windows too.
- `src/history-store.ts` uses built-in `bun:sqlite` without an ORM or new dependency. One `collection_meta` row binds schema version 3 and exact credential account ID; reject other accounts before HTTP or migration. `chats`, `messages`, and `completed_windows` store labels, complete JSON payloads with indexed IDs/times, and coverage/provenance. `images` deduplicates validated original source identities across chats and tracks status/files; `message_images` links each source to messages. Do not normalize away unknown fields or persist request credentials/cursors. Writable opens transactionally migrate version 1 and backfill saved references without HTTP; read-only version 1 exports remain supported.
- Commit messages and coverage in one synchronous SQLite transaction only after full window exhaustion. A failed/cancelled window is retried in full, with no partial coverage. Empty completed windows still count. Deduplicate identical IDs per chat; conflicting payloads fail and roll back instead of replacing content or selecting opaque revisions. Completed coverage is not an edit/deletion synchronization guarantee.
- Database files must be private regular files without symlinks. `reserveCollection` holds an adjacent `.collection.lock` throughout collection or `media-db`, released on handled completion/failure. Hard-crash stale locks need operator inspection. Use full SQLite synchronization. Back up the database and adjacent `<database>.media` directory together with updaters stopped.
- `collect` enables automatic backups by default at `<database>.backups/`; `--backup-dir <directory>` overrides the destination, and `--no-backup` disables backups for the invocation. Reject combining those flags. Resolve the enabled destination to an absolute path in command validation; disabled backups have no resolved destination. `src/collection-backup.ts` runs between committed windows while holding the existing collection reservation. `src/config.ts` owns `commandDefaults.backup`, `collectionBackupSuffix`, and `collectionBackupIntervalMs` (one hour). Attempt on the first completed window after the interval, and on clean completion when dirty; a no-op run still backs up existing data. No final backup on failed/cancelled collection. Backup errors warn/count in `backups.failed` but do not fail successful collection or overwrite previous snapshots.
- `HistoryStore.snapshotTo` uses parameterized `VACUUM INTO` with full synchronization. Backups snapshot only the SQLite database (`history.sqlite`)—including every chat, coverage window, and image reference/metadata—without copying `<database>.media/`, credentials, or live journal files. Check snapshot integrity (`PRAGMA integrity_check`) and write `SHA256SUMS` for `history.sqlite`. Fsync files/directories before atomic publication from private sibling staging (same filesystem); reject destination symlinks and overlap with live database/media. Published timestamp/UUID directories are immutable and never automatically pruned, so independent `rclone copy` can overlap. Upload only the backup directory, excluding sibling staging, and back up `<database>.media/` separately. Remote folders can be partial until upload completes; restoration must verify `SHA256SUMS` and use a separate working copy paired with `<database>.media/`. `media-db` does not trigger backups.
- `messageImageReferences` in `src/media.ts` is the shared synchronous HTML parser/source classifier for archives, collection commits, and migration. Index references and unsupported counts in the message/coverage transaction. Preserve original regional URLs and digests; only the existing downloader translates actual destinations.
- `media-db --db <file> [--chat <raw-id> | --chat-label <label>]` downloads directly from the tables (all chats by default), with normal/explicit credentials and optional `--refresh-media`. Reject combining selectors. After account validation, resolve saved labels through `HistoryStore.chatIdForLabel` before media HTTP; reuse its exact trimmed case-insensitive matching and rejection of missing, duplicate, or generic fallback labels without directory/profile lookup. Apply the resolved raw ID to both image selection and unsupported counts, and log the requested selector and selected ID. Reuse `downloadImages`; its directory override writes durable content-addressed files under `<database>.media`, and its per-image callback commits successful metadata immediately. Never mark work complete before file publication. Verify saved files before skipping; missing/corrupt files are pending repair. Preserve successful rows/files on failure or cancellation; keep valid old metadata on a failed refresh. Cookies remain destination-specific, and shared-cache validators handle revalidation. Unsupported references are counted, not fetched.
- `export-db --db <file> --chat <id> --out <new-directory>` is read-only and offline, without credentials. Optional bounds must be paired; otherwise use stored coverage. Reject gaps before publishing. Copy verified downloaded images into portable `media/` paths, preserve pending placeholders, and emit truthful complete/partial/not-downloaded media status. Missing/corrupt complete files fail before JSON publication; `--no-media` exports placeholders. JSON archive version remains 1 with separate collection provenance and zero HTTP counters. Preserve JSON after Markdown failure. Combined database export loads its selected range into memory; daily mode loads one day at a time. Existing JSON media commands remain supported.
- Both `export-db` modes require exactly one of `--chat <id>` or `--chat-label <label>`. `HistoryStore.chatIdForLabel` reads saved SQLite labels and reuses `src/chat-selection.ts` for exact trimmed case-insensitive matching, generic fallback rejection, and duplicate label/ID diagnostics. Missing matches give database-specific guidance. Resolve before archive publication without credentials, HTTP, or name refresh; preserve raw IDs and saved labels in archives and daily folder naming. Logs record the requested selector and selected raw ID.
- `export-db --db <file> --chat <id> --last Nd` selects the last N local calendar days including today and exports the covered portion to `exports/<saved-chat-label>/<YYYY-MM-DD>/`, using existing raw-ID fallbacks without HTTP/profile lookup. Reject `--out` and explicit bounds in daily mode. Cap the requested end at the latest completed collection endpoint or captured invocation time, whichever is earlier, regardless of which day collection ended. Print that cutoff and report the skipped uncollected tail; omit days beyond it without requiring coverage today. Reject no overlap and internal gaps from the requested start through the cutoff before any daily publication; allow a partial final collected day and emit archives for covered empty days. Read one day at a time. Reuse `src/daily-export.ts` validation and `withArchiveLock` across per-day validation/media/JSON/Markdown; refuse other identities, start bounds, newer endpoints, symlinks, and unexpected types. Reruns replace matching archives and regenerate Markdown; `--no-markdown` removes stale transcripts after JSON. Preserve previously published days on later failure, JSON on Markdown failure, and unreferenced old media. Combined `--out` exports remain new-directory-only.

## 4. Documentation Synchronization Protocol

> [!IMPORTANT]
> **Documentation ownership**: Keep `README.md` focused on setup, common workflows, and user-visible limits. Put detailed current usage in `docs/user-guide.md`, contributor verification in `docs/development.md`, and implementation contracts in the relevant technical references. Keep `docs/README.md` as the navigation index, clearly separating current behavior from historical proposals.
>
> **Rule for Agents and Contributors**:
> Whenever a change is made to:
> - CLI commands, options, default values, or exit codes
> - Credential loading, fallback paths, or browser login flags
> - Export formats, archive schema versions, or media handling logic
> - Architecture, dependencies, or storage policies
>
> You **MUST** update both `README.md` and `AGENTS.md` (plus relevant files under `docs/` if architectural) within the same changeset.
>
> **Checklist before completing any task**:
> 1. Does `README.md` accurately reflect all flag names, usage examples, and behavior?
> 2. Does `AGENTS.md` reflect any modified files, new modules, or updated invariants?
> 3. Does `bun run typecheck` pass with zero errors?
> 4. Does `bun test` pass completely?

---

## 5. Development & Testing Commands

`package.json` exposes `teams` through the executable Bun-shebang entry point `src/cli.ts`. After dependency installation, `bun link` makes it available through Bun's global executable directory on `PATH`; `bun unlink` removes the registration. Keep the caller's working directory unchanged: relative database/output paths and default `exports/` belong to the invoking workspace, not this tool's checkout. The linked command requires Bun and the checkout's dependencies and runs current source directly.

`src/config.ts` owns shared command defaults and limits. Import those values in command validation, CLI help, and runtime fallbacks rather than duplicating literals. `src/command-validation.ts` owns all command input schemas, their types, and option resolution; `src/cli.ts` owns argument parsing and dispatch. `src/date-window.ts` owns the shared window contract so the Teams client does not depend on command validation. Resolve environment-dependent credential and media paths at invocation time in their existing helpers. Keep protocol constants in their domain modules.

Use caret (`^`) ranges for dependencies and dev dependencies in `package.json`. Keep the workspace ranges in `bun.lock` synchronized; its resolved package versions provide reproducible installs.

Always run scripts with `bun` or `bunx`:

```sh
# Run CLI in development
bun src/cli.ts --help
# Or via package.json script:
bun run teams --help

# Run all test suites
bun test

# Explicit live smoke check (requires suitable saved credentials and sample window)
bun run test:live
# Optional fixture or history-target override:
bun run test:live --fixture exports/example/chat.json
bun run test:live --chat '<raw-chat-id>'
bun run test:live --chat-label 'Project Alpha'
# Optional explicit window override (both bounds required):
bun run test:live --chat-label 'Project Alpha' --from '2026-08-01T00:00:00Z' --to '2026-08-08T00:00:00Z'

# Type checking (strict TypeScript, noEmit)
bun run typecheck

# Code formatting (Biome)
bun run format
```

### Collection execution logs

`download`, `collect`, `images`, and `export` automatically write a private, timestamped log per invocation in `<database>.logs/` and print its path. Use `--no-log` to disable file logging. Logs include the requested range, already-collected duration and remaining gap count, fetched pages and checkpoints, profile warnings, backup outcomes, final results, and handled failures or cancellation. Fully covered ranges explicitly report that no history requests are needed. Skipped intervals are summarized rather than listed individually.

Each log starts with the normalized command input, working directory, and resolved options, including defaults and ISO date bounds when available. Input uses parsed flags (including parser defaults), so shell quoting, flag order, launcher details, and ignored arguments after `--` are not preserved. Credential-file arguments are shown as `[REDACTED]`; only explicitly selected operational fields are recorded. The header is saved to the log file only, before database access. With explicit --db it also precedes credential access; default-path selection first needs the credential account ID.

Logs contain operational metadata, including paths and account/chat identifiers, but no message bodies, credentials, or raw HTTP URLs. They are separate from SQLite checkpoints and backup snapshots; coverage in SQLite remains authoritative. Logging failures warn and collection continues. On Unix, files are mode 600 in a mode-700 log directory. Windows privacy depends on filesystem ACLs; the CLI does not validate or configure those ACLs. Database parent directories may be symlink aliases; the log directory itself must not be a symlink. Logs are not automatically pruned; remove old logs when no longer needed. Invalid command options fail before log creation. Hard crashes may leave a log without a final status, and logs are not fsynced per event.

`src/collection-log.ts` owns private per-invocation event files; CLI output is mirrored without globally replacing console methods. `src/config.ts` owns the log default and suffix. Keep logging independent of collection success and never use logs to determine resumable coverage.

Collection workflow logs identify the command that ran. `media-db` records verified downloaded-image skips, pending work, refresh mode, per-image outcomes, and the final image summary even on handled download failure. `export-db` records the requested chat/range and media/Markdown options, coverage verification, copied-image progress, and JSON/Markdown publication. All three commands support `--no-log`. The export database remains read-only and offline; its diagnostic log is a separate sibling file. Standalone JSON commands (`media`, `convert`) do not write these database workflow logs.

### Teams emoji classification

`src/teams-emoji.ts` shares recognition between Markdown and media indexing: only images with exact `itemtype="http://schema.skype.com/Emoji"` and nonblank `alt` become escaped text. Exclude them from attachment counts and inline-attachment suppression of opaque references. Custom emoji, missing alt text, and ordinary images retain attachment handling. Writable opens migrate versions 1/2 to version 3 transactionally after account validation, recalculating unsupported counts from all saved payloads without changing coverage or image metadata. Read-only older databases retain stored counts until migrated.

### Unified command lifecycle

The public CLI has one history pipeline through SQLite. `download` never rewrites completed intervals. `src/export.ts` remains an internal compatibility helper for archive tests, without CLI registration. Default account paths hash the exact credential account ID under the XDG state collections directory; offline discovery accepts exactly one regular default database and never loads credentials. Explicit `--db` remains supported for every database workflow. Invalid options fail before default discovery or credential access. Resolve one invocation time for every stage. Default-path credential failures happen before a log path is known; explicit database logs start before credential access. Download collection backups precede its media phase, so newly downloaded media enters the next successful collection backup.
