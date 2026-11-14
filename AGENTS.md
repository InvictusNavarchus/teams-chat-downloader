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
├── docs/                 # Authoritative research, protocol specs, and architecture plans
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
│   ├── collect.ts        # Backward collection, checkpoint pacing, and exclusive reservation
│   ├── collection-backup.ts # Verified SQLite/media snapshots and hourly collection backup scheduling
│   ├── command-validation.ts # Command schemas, inferred types, defaults application, and resolution
│   ├── config.ts         # Shared application defaults and command limits
│   ├── convert.ts        # Offline single-archive JSON-to-Markdown conversion
│   ├── convert-all.ts    # Batch offline JSON-to-Markdown conversion
│   ├── credentials.ts    # XDG state loading, credential validation, and file permission checks
│   ├── date-window.ts    # Shared history date-window contract and validation
│   ├── database-export.ts # Offline SQLite-to-JSON/Markdown bundle publication
│   ├── database-media.ts # Independent SQLite image queue downloads and per-image checkpoints
│   ├── errors.ts         # Domain error classes, validation errors, and sanitized formatters
│   ├── export.ts         # Label selection and chat export orchestration (history + text + media)
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
   - Sequential history requests must be paced with a delay (default 2–5 seconds) to avoid trigger-happy rate limiting on private consumer endpoints.
4. **Preserve Unknown Fields**:
   - Use `z.looseObject` in Zod schemas for Teams payloads. Never silently drop unknown fields from the JSON archive.
5. **No Barrel Exports**:
   - Use direct, explicit file imports (e.g. `import { exportChat } from "./export.ts"`).
6. **Zero Credential Leakage**:
   - Never print raw URLs containing auth tokens, cookies, or auth headers in logs, terminal summaries, or error messages.
7. **Unambiguous Chat Selection**:
   - Export requires exactly one of `--chat <raw-id>` or `--chat-label <label>`.
   - Match resolved `label`, including profile-derived one-to-one names when `title` is null, exactly after trimming surrounding whitespace and ignoring case. Generic fallback labels cannot select chats.
   - Resolve labels against the current directory with the existing profile cache. Missing or duplicate matches fail before history retrieval; duplicate errors list matching labels and raw IDs.
   - Reuse the matched label for folder naming. Raw-ID exports with explicit `--out` skip directory/profile lookup; label selection requires lookup even with `--out`. Archives always store the resolved raw chat ID.
   - Saved chat lists remain explicit `chats --out <file>` snapshots; selection does not read or automatically maintain them.
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

9. **Daily Export Refresh**:
   - Default `--last 1d` exports use `exports/<normalized-chat-label>/<local-YYYY-MM-DD>/`; other windows are timestamped snapshots under the chat folder. Existing exports are not migrated. Raw-ID hash fallbacks remain supported.
   - Re-fetch the whole local day through one captured invocation time; replace JSON and regenerate Markdown, without merging messages or retaining revisions. Explicit `--out` and all snapshot destinations retain no-overwrite protection.
   - Before refreshing an existing daily folder, validate its version 1 archive, exact account ID, raw chat ID, and start bound; reject an endpoint newer than the requested invocation. Reject symlinks and unexpected types in the default directory components, archive, Markdown, and media directory.
   - Hold `withArchiveLock` from `src/output.ts` across daily history retrieval, JSON/Markdown publication, and media work. Media commands share the existing `<input>.media.lock` path. `downloadLockedArchiveMedia` requires this reservation; ordinary media callers use `downloadArchiveMedia`.
   - Failed history retrieval leaves the previous daily export intact. Failed new daily retrieval removes only empty directories created by that run. JSON and Markdown replacements are individually atomic; later Markdown/media failures retain published JSON. `--no-markdown` removes an old daily transcript after JSON publication; unreferenced old media files remain on disk, while the manifest describes current references.
   - `src/export-discovery.ts` provides the bounded candidate layouts shared by default batch conversion and smoke discovery; callers lstat candidates and ignore symlinks. Arbitrary deeper conversion still requires `--recursive`.

---

## SQLite collection invariants

- `collect --db <file>` requires one chat selector and one date mode (`--all`, `--last`, `--since`, or paired `--from`/`--to`). `--all` uses `[1, invocation-time)`; explicit future ends fail. Resolve through `src/command-validation.ts`. `src/config.ts` owns `collectionWindowMs`.
- `src/collect.ts` processes uncovered intervals newest first using `readHistory`. Start at seven elapsed days; double the span only after an exhausted empty interval and reset on data. Never infer exhaustion from a single empty week or from the oldest saved timestamp. Apply the page-delay range between windows too.
- `src/history-store.ts` uses built-in `bun:sqlite` without an ORM or new dependency. One `collection_meta` row binds schema version 2 and exact credential account ID; reject other accounts before HTTP or migration. `chats`, `messages`, and `completed_windows` store labels, complete JSON payloads with indexed IDs/times, and coverage/provenance. `images` deduplicates validated original source identities across chats and tracks status/files; `message_images` links each source to messages. Do not normalize away unknown fields or persist request credentials/cursors. Writable opens transactionally migrate version 1 and backfill saved references without HTTP; read-only version 1 exports remain supported.
- Commit messages and coverage in one synchronous SQLite transaction only after full window exhaustion. A failed/cancelled window is retried in full, with no partial coverage. Empty completed windows still count. Deduplicate identical IDs per chat; conflicting payloads fail and roll back instead of replacing content or selecting opaque revisions. Completed coverage is not an edit/deletion synchronization guarantee.
- Database files must be private regular files without symlinks. `reserveCollection` holds an adjacent `.collection.lock` throughout collection or `media-db`, released on handled completion/failure. Hard-crash stale locks need operator inspection. Use full SQLite synchronization. Back up the database and adjacent `<database>.media` directory together with updaters stopped.
- Optional `collect --backup-dir <directory>` uses `src/collection-backup.ts` between committed windows while holding the existing collection reservation. `src/config.ts` owns `collectionBackupIntervalMs` (one hour). Attempt on the first completed window after the interval, and on clean completion when dirty; a no-op run still backs up existing data. No final backup on failed/cancelled collection. Backup errors warn/count in `backups.failed` but do not fail successful collection or overwrite previous snapshots.
- `HistoryStore.snapshotTo` uses parameterized `VACUUM INTO` with full synchronization. Backups include every chat and verified complete images, retaining pending references, without credentials or live journal files. Check snapshot integrity, verify copied image hashes, and write `SHA256SUMS`. Fsync files/directories before atomic publication from private sibling staging (same filesystem); reject destination symlinks and overlap with live database/media. Published timestamp/UUID directories are immutable and never automatically pruned, so independent `rclone copy` can overlap. Upload only the backup directory, excluding sibling staging. Remote folders can be partial until upload completes; restoration must verify all manifest checksums and use a separate working copy. `media-db` does not trigger backups; a repeated completed collection range can snapshot newly downloaded media without history HTTP.
- `messageImageReferences` in `src/media.ts` is the shared synchronous HTML parser/source classifier for archives, collection commits, and migration. Index references and unsupported counts in the message/coverage transaction. Preserve original regional URLs and digests; only the existing downloader translates actual destinations.
- `media-db --db <file> [--chat <raw-id>]` downloads directly from the tables (all chats by default), with normal/explicit credentials and optional `--refresh-media`. Reuse `downloadImages`; its directory override writes durable content-addressed files under `<database>.media`, and its per-image callback commits successful metadata immediately. Never mark work complete before file publication. Verify saved files before skipping; missing/corrupt files are pending repair. Preserve successful rows/files on failure or cancellation; keep valid old metadata on a failed refresh. Cookies remain destination-specific, and shared-cache validators handle revalidation. Unsupported references are counted, not fetched.
- `export-db --db <file> --chat <id> --out <new-directory>` is read-only and offline, without credentials. Optional bounds must be paired; otherwise use stored coverage. Reject gaps before publishing. Copy verified downloaded images into portable `media/` paths, preserve pending placeholders, and emit truthful complete/partial/not-downloaded media status. Missing/corrupt complete files fail before JSON publication; `--no-media` exports placeholders. JSON archive version remains 1 with separate collection provenance and zero HTTP counters. Preserve JSON after Markdown failure. Database export currently loads its selected range into memory. Existing JSON media commands remain supported.

## 4. Documentation Synchronization Protocol

> [!IMPORTANT]
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
