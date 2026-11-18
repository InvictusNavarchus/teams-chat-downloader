# User guide

[Project overview](../README.md) · [Documentation index](README.md)

This guide describes the implemented CLI. Run commands from the project directory; relative output paths are resolved from your current working directory. Use `bun run teams <command> --help` for command options.

- [Sign in and manage credentials](#sign-in-and-manage-credentials)
- [Find and select a chat](#find-and-select-a-chat)
- [Choose dates and export history](#choose-dates-and-export-history)
- [Collect long histories](#collect-long-histories)
- [Back up and restore collections](#back-up-and-restore-collections)
- [Download and retry images](#download-and-retry-images)
- [Markdown and offline conversion](#markdown-and-offline-conversion)
- [Progress and recovery](#progress-and-recovery)

## Sign in and manage credentials

Install dependencies with `bun install --frozen-lockfile`, then run:

```sh
bun run teams login
bun run teams chats
```

Login needs an installed Chromium, Chrome, or Edge and opens a visible browser with a dedicated profile. Complete sign-in and verification in that window. If capture waits for history, open a chat. The CLI saves credentials after checking access and closes its browser; it does not capture passwords or verification codes. Ordinary listing, collection, and export do not need an open browser.

Run `login` again when credentials expire, then retry the failed command. The dedicated browser session is reused, but Microsoft may require sign-in again. There is no background renewal or automatic import of your everyday browser session. Closing the window, timeout, cancellation, or failed validation leaves previous credentials intact.

If image credentials are missing, run:

```sh
bun run teams login --wait-for-media
```

Open an image-containing chat when prompted. Login may succeed without image credentials unless this option is used; image access is checked when downloading.

### Browser and credential locations

Credentials default to `$XDG_STATE_HOME/teams-chat-download/credentials.json`, falling back to `~/.local/state/teams-chat-download/credentials.json`. The dedicated browser profile is `browser/` beside that default file. Empty or relative `XDG_STATE_HOME` values are ignored.

```sh
bun run teams login --browser /path/to/chromium --browser-profile /private/teams-browser --credentials /private/credentials.json --timeout 600
```

The timeout defaults to 600 seconds. `--credentials` changes the credential destination, not the default browser-profile path. Use a dedicated private profile, and never open it in two browser processes at once. The CLI does not install a browser.

Commands that need credentials look in this order:

1. Explicit `--credentials <file>`, with no fallback when supplied.
2. The per-user state file above.
3. The legacy `.private/credentials.json` inside this CLI installation, independent of the working directory.

Only a missing file permits fallback. Invalid, unreadable, or insecure files stop lookup. Login writes the per-user file by default, so it takes precedence over an older project-private file after login. Credential files must be private on Unix (mode 600), and browser profiles must be private directories (mode 700). Keep custom paths outside version control.

Manual input is supported using the [credential template](../examples/credentials.example.json). See the [manual credential reference](09-browser-login.md#manual-credential-files) for service-specific header values and the [login reference](09-browser-login.md) for capture, validation, and browser troubleshooting. Login derives a stable account identity; a manual `accountId` is a local account label. Collections and media operations require the same account identity that created the saved data.

## Find and select a chat

```sh
bun run teams chats
bun run teams chats --out .private/chats.json
bun run teams chats --refresh-names
```

`chats` prints IDs and labels. Named groups keep their titles; one-to-one chats use the other participant's name when available. Names are cached for 24 hours. Use `--refresh-names` after a rename. Without profile credentials, listing can still work with unresolved names; profile authentication failures and incomplete directory responses fail explicitly.

`--out` saves a clean JSON array, replacing an earlier chat list only after a successful write. Saved lists are reference snapshots: selection always uses the current directory and does not read this file. Terminal output includes progress and summaries, so use the saved file for machine-readable JSON.

For `download` and `collect`, choose exactly one selector:

```sh
bun run teams download --chat-label 'Project Alpha' --last 7d
bun run teams download --chat '<raw-chat-id>' --last 7d
```

Labels match exactly after trimming surrounding whitespace and ignoring case; partial matches are not supported. Generic labels `Untitled chat` and `Unresolved one-to-one chat` cannot select a chat. If a name is duplicated, use the raw ID shown in the error or chat list. IDs are preferable for scripts because labels can change.

Label selection requires a current directory lookup and any needed participant names, even with an explicit output path. Raw-ID downloads and collection skip that lookup, using any saved label for output naming. Offline `export` and `images` label lookup use only saved labels. Profile cache locations and lookup mechanics are documented in the [participant profile reference](08-participant-profiles.md).

## Choose dates and export history

`download` requires one date mode. `collect` accepts the same modes, or defaults to catching up saved history when date flags are omitted (`--all-history` explicitly backfills older history):

| Option                                | Range                                                         |
| ------------------------------------- | ------------------------------------------------------------- |
| `--last 1d`                           | Today from local midnight through invocation time             |
| `--last 7d`                           | Six days ago at local midnight through invocation time        |
| `--since <timestamp>`                 | The supplied instant through invocation time                  |
| `--from <timestamp> --to <timestamp>` | The supplied start, inclusive, to the supplied end, exclusive |

`--last Nd` means calendar days, including today, rather than N × 24 hours. The machine's local timezone applies; set `TZ` to override it. Explicit timestamps require `Z` or a timezone offset and at most millisecond precision. Date-only values are rejected. Filtering uses the original message arrival time.

```sh
bun run teams download --chat-label 'Project Alpha' --last 7d
bun run teams download --chat '<raw-chat-id>' --since '2026-11-01T00:00:00+07:00'
bun run teams download --chat '<raw-chat-id>' \
  --from '2026-10-01T00:00:00Z' --to '2026-11-01T00:00:00Z'
TZ=Asia/Jakarta bun run teams download --chat-label 'Project Alpha' --last 2d
```

### Output folders and saved history

`download` collects missing history, downloads pending images, then calls the same offline exporter used by `export`. Collection is always resumable: completed intervals are skipped. A later edit or deletion in a completed interval does not replace or remove saved messages. There is no history refresh or `--resume` flag.

Without `--out`, `--last Nd` writes one folder per local calendar day under `exports/<saved-chat-label>/<YYYY-MM-DD>/`. Reruns regenerate matching JSON and Markdown from SQLite. Raw IDs use an existing saved label or a hashed ID fallback; they do not trigger a name lookup. Other date modes create one timestamped snapshot. An explicit `--out` creates one combined bundle and refuses an existing directory.

```sh
teams download --chat-label 'Project Alpha' --last 7d
teams download --chat-label 'Project Alpha' --last 7d --out exports/alpha-week
teams export --chat-label 'Project Alpha' --last 7d
```

Daily publication validates account, chat, start bound, and endpoint, refusing newer archives, symlinks, and unexpected types. JSON and Markdown are individually atomic. `--no-markdown` removes a stale daily transcript after JSON publication. Unreferenced media files remain on disk. Failed history retrieval preserves previously exported bundles and completed SQLite checkpoints. After a media failure, download attempts to export text and available images before returning failure; cancellation stops further publication.

### Default collections and command migration

Online `download`, `collect`, and `images` use an account-specific database at `$XDG_STATE_HOME/teams-chat-download/collections/<account-SHA256>.sqlite`, falling back to `~/.local/state`. The account ID is hashed solely to form a safe filename. `--db` overrides this location and remains relative to the invoking directory when given a relative path. Existing custom databases are not relocated.

Offline `export` never loads credentials. Without `--db` it discovers exactly one regular default account database; no candidate or several candidates requires an explicit `--db`. It never guesses an account from filenames or current credentials.

Former online `export` invocations must use `download`. `export-db` and `media-db` remain compatibility aliases for `export` and `images`. `media --input` still operates on standalone JSON archives. `export --last Nd` cannot combine `--out` with daily mode; for a combined offline export use `--out` with optional paired bounds.

## Collect long histories

Collection saves completed intervals in SQLite so interruptions do not discard earlier work. Each database belongs to one account and can contain multiple chats.

```sh
bun run teams collect --db exports/history.sqlite --chat-label 'Project Alpha' --all-history
# Or choose a bounded period:
bun run teams collect --db exports/history.sqlite --chat '<raw-chat-id>' \
  --from '2024-11-01T00:00:00+07:00' --to '2026-11-01T00:00:00+07:00'
```

Choose one selector (`--chat`, `--chat-label`, or collect-only `--all-chats`) and optionally one date mode: `--all-history`, `--last Nd`, `--since`, or paired `--from`/`--to`. Explicit future ends are rejected. `--all-history` requests all history the endpoint exposes, working backward from now; it cannot recover deleted or unavailable messages.

Rerun the command after interruption or credential refresh. Completed intervals are skipped; the unfinished interval is fetched again in full. A range ending at invocation time also collects the newly uncovered tail. `--credentials` and the page-delay options work as with downloads.

Catch up every saved chat with no per-chat selectors or day count:

```sh
teams collect --all-chats --images
# For a custom database, reuse its original path:
teams collect --db exports/history.sqlite --all-chats --images
```

`--all-chats` reads IDs already present in the account's database, including chats without labels or with duplicate labels. It does not discover new chats, refresh labels, or request the directory/profiles. It cannot be combined with `--chat` or `--chat-label`, and an empty database fails with guidance to collect a chat first. `download` remains single-chat.

Chats run sequentially in raw-ID order with one captured endpoint, one collection reservation, shared backup scheduling, and normal pacing between windows even across chat boundaries. Without date flags, each chat starts at its earliest completed interval and ends at the captured invocation time, skipping completed intervals and retrying internal gaps. This uses saved coverage even when it contains no messages; it does not infer a start from message timestamps. It does not backfill before that saved start. For an initial collection without completed coverage, choose an explicit range or `--all-history`. Use `--all-history` to include older history down to Unix millisecond 1. The old `--all` flag is no longer accepted on `collect` or `download`. Per-chat progress and a final result with per-chat and aggregate counts appear in the terminal and automatic log; `--no-log` disables the log. History failure or cancellation stops the batch, retains earlier checkpoints, and does not start a final history backup. Rerun the same command to resume. For images afterward, `teams images` handles all saved chats; pass the same `--db` for a custom database.

**Collection is not ongoing synchronization:** completed intervals are not refreshed for later edits or deletions. Conflicting content for an already saved message fails the current interval rather than overwriting the saved record. See the [SQLite reference](11-sqlite-collection.md) for schema, migration, and checkpoint behavior.

### Download collected images

Add `--images` to `collect` to download pending image files after successful history collection, without exporting JSON/Markdown:

```sh
teams collect --all-chats --images
teams collect --chat-label 'Project Alpha' --images
```

Image downloading is opt-in; omitting `--images` collects history and source references only. After all selected history succeeds (including automatic database backups), the CLI runs the existing image downloader sequentially for those exact resolved chat IDs. It handles pending references across their entire saved history, not only the requested history dates. Images shared by chats are downloaded once and verified on reuse. Each image phase acquires its own database reservation after the history reservation is released. The same invocation log records history and image progress, final per-chat image results, and any failure/cancellation; `--no-log` covers both phases.

History failure/cancellation prevents the image phase. Image failure/cancellation stops remaining chats, preserves completed history/files/metadata, and exits with failure/130 respectively. Rerun `collect --images` to reuse history coverage and resume pending images, or use `images` alone. No archive is published in either case. Use `images --refresh-media` for deliberate revalidation. `export` remains an independent offline step and copies the saved image files into its portable bundle. Database backups contain only SQLite, so back up the adjacent media directory separately.

```sh
bun run teams images --db exports/history.sqlite
bun run teams images --db exports/history.sqlite --chat-label 'Project Alpha'
bun run teams images --db exports/history.sqlite --chat '<raw-chat-id>'
bun run teams images --db exports/history.sqlite --refresh-media
```

The default handles every chat in the database, using credentials for its account. No JSON export is needed. Images are saved beside the database in `exports/history.sqlite.media/`; keep these together. Successfully downloaded images survive interruption and are checked before being skipped on rerun. Missing or corrupt files are repaired from the cache or downloaded again. Unsupported references remain placeholders.

To limit downloads to one chat, use either `--chat <raw-id>` or `--chat-label <label>`; combining them fails. Labels use the same saved SQLite lookup as `export`: exact matching after trimming whitespace and ignoring case, without live directory/profile requests or name refresh. Missing, duplicate, or generic fallback labels fail before media requests. If no label was saved or several chats share it, use the raw ID. Image selection and unsupported counts are limited to the selected chat. Logs record the requested selector and resolved raw ID.

### Export a collection offline

Select exactly one of `--chat <raw-id>` or `--chat-label <label>`. Labels match the values saved in SQLite, exactly after trimming surrounding whitespace and ignoring case. Matching stays offline without profile/name refresh. Missing labels fail with database-specific guidance; duplicate matches list saved labels and raw IDs so you can select with `--chat`. Generic fallback labels cannot select a chat. If a chat was collected without a label, use its raw ID.

```sh
bun run teams export --db exports/history.sqlite --chat-label 'Project Alpha' --last 3d
bun run teams export --db exports/history.sqlite --chat '<raw-chat-id>' --out exports/full-history
bun run teams export --db exports/history.sqlite --chat '<raw-chat-id>' \
  --from '2026-09-01T00:00:00+07:00' --to '2026-10-01T00:00:00+07:00' --out exports/september
bun run teams export --db exports/history.sqlite --chat '<raw-chat-id>' --out exports/text-only --no-media
```

No credentials or network are needed. In combined mode (`--out`), without bounds, export uses the full stored coverage span; any uncollected gap causes rejection. Bounds must be paired. The combined destination must be new. `--no-markdown` skips the transcript; `--no-media` uses image placeholders.

For daily folders, use `--last Nd` without `--out` or explicit bounds. The last N local calendar days include today, using the same calendar rules as downloads (including daylight saving changes). The saved database label names `exports/<normalized-chat-label>/<YYYY-MM-DD>/`; missing labels use the existing hashed chat-ID fallback. No directory/profile requests are made.

Export ends at the earlier of invocation time and the latest completed collection endpoint, whichever calendar day that falls on. The command prints that cutoff and reports the skipped uncollected tail; the final archive records the exact bound, even for a partial earlier day. Days after the cutoff are not exported. This uses completed coverage, not the latest message timestamp, and applies equally to weekdays and weekends. Full coverage is required from the requested start through the cutoff: internal gaps or no collected coverage in the requested range fail before writing daily folders. Fully covered empty days produce empty archives.

Reruns replace matching daily archives and regenerate Markdown under the shared archive/media lock. Existing account, chat, start bound, and endpoint are checked before replacement; a newer archive is never shortened. Symlinks and unexpected output types are rejected. `--no-markdown` removes a previous daily transcript after JSON publication. Old unreferenced media files remain, while the manifest describes current references. Each day publishes independently; if a later day fails or the command is cancelled, already published days remain. JSON remains available after a Markdown failure. Daily export loads one day's messages at a time.

Downloaded images are copied into the portable bundle. Pending images remain placeholders. A missing or corrupt image recorded as complete fails export before JSON publication: repair it with `images` or use `--no-media`. Markdown failure retains JSON. Very large exports may need smaller subranges because archive generation loads the selected messages into memory.

## Back up and restore collections

Collection creates automatic backups in `<database>.backups/` by default. Use `--backup-dir backups/teams` to change the destination or `--no-backup` to disable backups for that invocation; these options cannot be combined. Disabling backups preserves checkpoints and existing snapshots.

Backups are attempted between completed intervals after an hour, and on successful completion if changes remain. A long interval delays the backup until it completes. A successful no-op collection also snapshots the existing database. Backups include all chats, coverage, and image metadata; `<database>.media/` is **not** copied into each snapshot. Failed or cancelled collection does not start a final backup.

`images` does not trigger backups. Because files in `<database>.media/` are immutable and content-addressed, back up `<database>.media/` separately (for example, with `rclone copy`, excluding `*.tmp` if `images` is running).

Each immutable snapshot contains `history.sqlite` and `SHA256SUMS`. Backups are not automatically pruned, so remove old snapshots manually when no longer needed. A backup failure warns and increments `backups.failed`; history collection may still exit successfully. Check that summary if you depend on backups.

For an independent uploader such as `rclone copy`, upload exactly the backup root (for example, `exports/history.sqlite.backups/`), excluding sibling staging directories. Remote uploads may be incomplete even when their checksum manifest is present. Coordinate cleanup with your uploader.

Restore by copying or downloading one snapshot into a **new working directory**, then run inside that directory:

```sh
sha256sum -c SHA256SUMS
```

Require the checksum to pass before using the restored database. Pair the restored database with its `<database>.media/` directory (next to the restored database file) and work on the restored copy, not the published snapshot. Credentials are not included. Storage constraints, integrity checks, and publication mechanics are in the [backup reference](11-sqlite-collection.md#automatic-collection-backups).

## Download and retry images

`download` downloads supported images by default. Save text first and download images later with:

```sh
bun run teams download --chat '<raw-chat-id>' --last 7d --out exports/last-week --no-media
bun run teams media --input exports/last-week/chat.json
```

`media` updates the archive in place and regenerates its sibling Markdown, creating it if absent. Use `--no-markdown` to preserve a manually edited transcript. Credentials must match the archive's account; `--credentials` overrides the lookup path. This command does not fetch history again.

Complete cached images are reused without HTTP. The cache defaults to `$XDG_CACHE_HOME/teams-chat-download/media/`, falling back to `~/.cache/teams-chat-download/media/`; empty or relative XDG values are ignored. Exported copies are independent of the cache.

`--refresh-media` checks cached images with Teams again and is supported by `download`, `media`, and `images`. It cannot be combined with download's `--no-media`. A failed refresh preserves previously saved images.

Supported inline images include JPEG, PNG, GIF, and WebP from specific Teams media sources, with a 50 MiB response limit. Other attachments, unsupported regions, signed links, and opaque references may remain placeholders. Unsupported references produce partial media coverage; actual download errors fail the command. A complete history export does not imply complete media coverage.

If image download fails, saved text and completed images remain available. Refresh credentials with `login --wait-for-media` when needed, then retry `media` or `images`. See the [image reference](10-image-export.md) for supported URLs, regional translation, validation, and cache behavior.

## Markdown and offline conversion

Exports render Markdown by default beside `chat.json`. Add `--no-markdown` to skip rendering and save JSON only:

```sh
bun run teams download --chat '<raw-chat-id>' --last 7d
bun run teams download --chat '<raw-chat-id>' --last 7d --out exports/last-week
bun run teams download --chat '<raw-chat-id>' --last 7d --no-markdown
```

Download `--out` selects the **export directory**. JSON is always named `chat.json`, with `chat.md` beside it (unless `--no-markdown` is passed). The second command saves `exports/last-week/chat.json` and `exports/last-week/chat.md`. Successful stdout includes the JSON path as `output` and the Markdown path as `markdown` (omitted with `--no-markdown`).

Convert an existing export later without credentials, browser access, or Teams requests:

```sh
bun run teams convert --input exports/last-week/chat.json
bun run teams convert --input exports/last-week/chat.json --format markdown --out exports/readable-chat.md
```

`convert` defaults to Markdown beside the source JSON. Its stdout reports `input`, `output`, `format`, and `messages`. Snapshots, explicit `--out` exports, and offline conversion refuse existing destinations and publish private output files atomically; default daily exports refresh their existing folder, and the media phase explicitly updates the saved archive and generated sibling Markdown. If Markdown conversion fails after JSON was saved, the command exits unsuccessfully and reports the saved JSON path. Keep that file and retry with `convert --out <new-path>`, or use `media` to download images and regenerate sibling Markdown; history does not need to be downloaded again.

Convert all JSON exports that do not already have a sibling Markdown destination:

```sh
bun run teams convert-all
bun run teams convert-all --dir /path/to/exports
bun run teams convert-all --dir /path/to/exports --recursive
```

`convert-all` defaults to the `exports/` directory under the current working directory. It scans regular `.json` files (case-insensitive) in that directory, legacy direct export-folder `chat.json`, and `chat.json` in standard `<chat>/<date-or-period>/` folders. The standard scan is bounded to those layouts; it does not descend into media or arbitrary nested folders. Add `--recursive` for other layouts or deeper JSON files; symlink entries are ignored. Conversion is sequential and offline, using the same validation, renderer, and atomic writer as `convert`. An existing sibling `.md` destination is skipped without reading its JSON, so rerunning the command converts only missing outputs. Existing Markdown is not refreshed, and the batch command does not accept a shared `--out` path.

Stdout contains `directory`, `format`, `recursive`, `converted`, `skipped`, `failed`, and per-file `files` results with absolute input/output paths, status, and any conversion error. Invalid JSON, unsupported archives, and per-file write failures are reported while remaining files continue; any failed file makes the command exit with code 1. Empty directories succeed with zero counts. Missing or unreadable directories fail explicitly. Completed files and all source JSON are kept if a later file fails or the run is cancelled. Like `convert`, the only supported format is `markdown`.

Conversion accepts complete version 1 exports using the current media paths. A shared reader validates the version, required rendering fields, and date window while retaining unknown fields. Markdown reads as a chronological transcript: one heading per calendar day, then compact speaker turns such as `**Alice · 09:15–09:17**`. Consecutive messages from the same source sender are grouped when the gap from the previous message is at most five minutes, with each message kept as its own paragraphs or rich-text blocks. A sender change, longer pause, new day, or system event starts a new turn. Missing sender identities stay separate; matching display names alone do not establish the same author. Available sender names fall back to the source sender ID or "Unknown sender". Message IDs and technical type labels remain in JSON.

Dates and 24-hour times use the machine's local timezone, labeled once at the top; set `TZ` when converting to use another zone (for example, `TZ=UTC bun run teams convert --input exports/last-week/chat.json --out exports/utc-chat.md`). JSON retains the original timestamps and exact window bounds. Existing exports can be converted again with a new `--out` path to get the transcript layout without fetching history.

Rich HTML supports paragraphs, emphasis, lists, blockquotes, code, and ordinary HTTP(S)/email links. Explicit `Text` messages remain literal text. Unsupported message types retain available content as literal text; missing/non-string content gets an explicit placeholder. Tables, cards, Teams-specific replies, reactions, and other complex structures are not fully reconstructed; JSON retains the source data.

Downloaded images become local Markdown image links; conversion to another directory rebases those links relative to the new Markdown path. Conversion performs no downloads and does not copy image files, so keep the original image directory available. Older exports, `--no-media`, and unsupported images retain **not-downloaded placeholders**. Messages with `amsreferences` but no inline images get a media placeholder without copying media URLs or technical reference details. Executable HTML elements and unsafe link destinations are omitted, and source text is escaped rather than retained as raw HTML. HTML, PDF, and other output formats remain future work.

## Progress and recovery

Commands print results, progress, and request summaries to stdout; warnings and errors go to stderr. Stdout as a whole is not a JSON document. Use `chats --out` or saved archives for JSON data. The exit code indicates command success, with backup warnings reported separately as described above.

| Situation                             | Next step                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| Credentials expired                   | Run `login`, then retry the original command.                                           |
| Missing image credentials             | Run `login --wait-for-media`, then retry `media` or `images`.                         |
| Interrupted collection                | Rerun the collection command with the same database; completed intervals survive.       |
| History download failed          | Retry download; completed database intervals remain saved.               |
| JSON saved but Markdown failed        | Use `convert --out <new-path>`, or `media` to regenerate the sibling transcript.        |
| Output folder already exists          | Choose a new snapshot destination. Only default daily exports refresh existing folders. |
| Collection export has coverage gaps   | Collect the missing period or export a fully covered subrange.                          |
| An updater lock remains after a crash | Confirm no updater is running before inspecting and removing the stale lock directory.  |

Daily refresh and JSON media updates share an adjacent `chat.json.media.lock`; collection and database media updates use `<database>.collection.lock`. Concurrent updaters are refused. JSON and Markdown publication is individually atomic, so a later failure can leave new JSON with an older transcript. Ctrl+C cancels further requests while retaining already published work.

Retry budgets and transport rules are documented in the [architecture reference](07-architecture.md#4-http-policy-with-ky). For contributor checks against live Teams, see [development and verification](development.md#live-smoke-test).

### Collection execution logs

`download`, `collect`, `images`, and `export` automatically write a private, timestamped log per invocation in `<database>.logs/` and print its path. Use `--no-log` to disable file logging. Logs include the requested range, already-collected duration and remaining gap count, fetched pages and checkpoints, profile warnings, backup outcomes, final results, and handled failures or cancellation. Fully covered ranges explicitly report that no history requests are needed. Skipped intervals are summarized rather than listed individually.

Each log starts with the normalized command input, working directory, and resolved options, including defaults and ISO date bounds when available. Input uses parsed flags (including parser defaults), so shell quoting, flag order, launcher details, and ignored arguments after `--` are not preserved. Credential-file arguments are shown as `[REDACTED]`; only explicitly selected operational fields are recorded. The header is saved to the log file only, before database access. With explicit --db it also precedes credential access; default-path selection first needs the credential account ID.

Logs contain operational metadata, including paths and account/chat identifiers, but no message bodies, credentials, or raw HTTP URLs. They are separate from SQLite checkpoints and backup snapshots; coverage in SQLite remains authoritative. Logging failures warn and collection continues. On Unix, files are mode 600 in a mode-700 log directory. Windows privacy depends on filesystem ACLs; the CLI does not validate or configure those ACLs. Database parent directories may be symlink aliases; the log directory itself must not be a symlink. Logs are not automatically pruned; remove old logs when no longer needed. Invalid command options fail before log creation. Hard crashes may leave a log without a final status, and logs are not fsynced per event.

Collection workflow logs identify the command that ran. `images` records verified downloaded-image skips, pending work, refresh mode, per-image outcomes, and the final image summary even on handled download failure. `export` records the requested chat/range and media/Markdown options, coverage verification, copied-image progress, and JSON/Markdown publication. All four database workflow commands support `--no-log`. The export database remains read-only and offline; its diagnostic log is a separate sibling file. Standalone JSON commands (`media`, `convert`) do not write these database workflow logs.

`download` uses the same per-invocation log for collection, images, and export. With a default database, credentials must be loaded before its account-specific log path can be resolved; credential failures at that point have no file log. Explicit `--db` logs start before credential access. Automatic collection backups precede image downloading; repeat a successful collection to include newly downloaded images in a backup.
