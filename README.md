# Teams Chat Download

Download chat history from **Microsoft Teams Free with a personal Microsoft account** (`teams.live.com`). Keep resumable history in SQLite and produce portable JSON, readable Markdown, and supported inline images. Work or school Teams accounts are outside this tool's scope.

## Quick start

You need [Bun](https://bun.sh/) and an installed Chromium, Chrome, or Edge browser. From the project directory:

```sh
bun install --frozen-lockfile
bun run teams login
bun run teams chats
bun run teams collect --chat-label 'Project Alpha' --last 7d --images
# Export offline when ready:
bun run teams export --chat-label 'Project Alpha' --last 7d
```

Sign in and complete verification in the browser opened by `login`. Later commands use direct HTTP and do not need an open browser. Replace `Project Alpha` with a label from `chats`.

`collect --images` saves missing history in SQLite and downloads pending images beside the database. `export` separately writes `chat.json` and `chat.md` offline; `download` remains a convenience command that runs all three stages. `--last 7d` means seven local calendar days including today. Export writes one folder per day under `exports/<chat-label>/`; rerunning export regenerates matching bundles from saved history.

**Collection resumes automatically.** Completed intervals are skipped, and later edits or deletions in those intervals are not synchronized. Existing saved messages are preserved. There is no history refresh mode or `--resume` flag. Image revalidation remains available through `--refresh-media`.

### Run from any directory

Run `bun link` once from this checkout to expose `teams` on your `PATH`. Bun's global executable directory is shown by `bun pm bin -g` (normally `~/.bun/bin`).

```sh
bun link
teams --help
teams download --chat-label 'Project Alpha' --last 1d
```

The linked command runs current source from this checkout and requires its dependencies and Bun. Explicit relative paths resolve from the invoking working directory. Relink after moving the checkout; `bun unlink` removes the registration.

`teams --help` starts with common catch-up, initial collection, and offline export examples. Use `teams collect --help` or `teams export --help` for grouped options and defaults; advanced options and archive utilities remain listed.

## One collection workflow

| Command | Purpose |
| --- | --- |
| `download` | Collect missing history, download images, and export JSON/Markdown |
| `collect` | Collect missing history, optionally with `--images`, without exporting |
| `images` | Download or repair images referenced by saved history |
| `export` | Create JSON/Markdown from saved history, completely offline |

All four accept `--db <file>`. With neither `--db` nor `TEAMS_DATA_DIR` set, online commands use an account-specific database under `$XDG_STATE_HOME/teams-chat-download/collections/` (default `~/.local/state/teams-chat-download/collections/`). Offline `export` discovers a single default collection without credentials. If several accounts have collections, specify `--db`.

### Use a project’s data directory

Set `TEAMS_DATA_DIR` in this checkout’s Git-ignored `.env.teams` to use a project’s existing database and exports from `bun run teams` here. Use the absolute path to the existing data directory. Set `TZ` if you need a fixed timezone for daily exports.

```dotenv
TEAMS_DATA_DIR=/absolute/path/to/project/.data
TZ=Asia/Jakarta
```

Commands default to `history.sqlite` and `exports/` under that directory. Media, backups, and logs stay beside the database. `--db` and explicit output paths still take precedence for their respective destinations. Without `TEAMS_DATA_DIR`, the export root is `exports/` in the invoking working directory.

### Download a period

```sh
# Today so far, using the default account collection:
teams download --chat-label 'Project Alpha' --last 1d

# A specific period as one combined bundle in a new folder:
teams download --chat-label 'Project Alpha' \
  --from '2026-10-01T00:00:00+07:00' --to '2026-11-01T00:00:00+07:00' \
  --out exports/alpha-october

# Use your existing collection:
teams download --db exports/history.sqlite --chat-label 'Project Alpha' --last 7d
```

Choose one date mode: `--last Nd`, `--since <timestamp>`, paired `--from`/`--to`, or `--all-history`. Timestamps require a timezone, start is included and end excluded, and future ends are refused. Use `--chat '<raw-chat-id>'` when labels are duplicated. Raw-ID downloads skip name lookup and use saved labels or a hashed ID for automatic folders.

Without `--out`, `--last Nd` regenerates one folder per day. Other date modes create a combined timestamped snapshot. Explicit `--out` always requires a new directory. `--no-media` skips images; `--no-markdown` omits Markdown.

### Collect now, export later

```sh
teams collect --chat-label 'Project Alpha' --all-history --images
teams export --chat-label 'Project Alpha' --last 3d
teams export --chat-label 'Project Alpha' --out exports/alpha-history
```

`collect` saves text and image references; add `--images` to also download the files before finishing. Omit it for history only, or use the standalone `images` command later. Omit the selector on `images` to handle all chats. `export` selects one saved label/raw ID, or every saved chat with `--all-chats --last Nd`. It requires no credentials and never contacts Teams. Daily export stops at the verified collection cutoff and reports the skipped uncollected tail; internal coverage gaps fail. Combined export requires `--out` and optionally paired date bounds.

To catch up every chat already saved in the database, without tracking how many days have passed:

```sh
teams collect --all-chats --images
# Export the past five local calendar days, including saved images:
teams export --all-chats --last 5d
```

Reuse `--db <file>` on collection, image, and export commands if you originally chose a custom database. `--all-chats` uses saved chat IDs without directory/profile lookup; it does not discover new chats. With no date flags, `collect` catches up from each chat’s earliest completed interval through now, retrying gaps within that range. Use `--all-history` to also backfill older history. A chat without completed coverage requires `--all-history` or an explicit date range for its initial collection. The old `--all` flag has been replaced by `--all-history` on both `collect` and `download`. Chats run sequentially and stop on failure or cancellation; rerun to resume from saved checkpoints. This selector is available on `collect` and daily `export`; `download` and combined `export --out` still require one chat.

`collect --images` downloads pending images across the selected chats’ saved history, including older pending references. Verified files are skipped. History failure stops before images; image failure or cancellation preserves completed history and image files for retry. Collection never creates JSON or Markdown bundles.

`export --all-chats --last 5d` writes JSON, Markdown, and saved images to each chat’s daily folders. It checks all chats’ coverage and folder-name conflicts before publishing. To download missing images first, use `collect --all-chats --images` or `images`; export itself stays offline.

Collection makes automatic verified database backups in `<database>.backups/`, hourly between completed intervals and on clean completion. Use `--backup-dir` to change the location or `--no-backup` to disable them. Backups snapshot only `history.sqlite` (not `<database>.media/`) and are not automatically pruned. Keep the live database and adjacent `<database>.media/` directory together, and back up `<database>.media/` separately. See [backup and restoration](docs/user-guide.md#back-up-and-restore-collections).

## Use your exported files

```text
exports/alpha-october/
├── chat.json
├── chat.md
└── media/
```

Keep the whole folder together so image links continue to work. JSON preserves original message fields and collection provenance. Markdown is derived and can be regenerated offline:

```sh
teams convert --input exports/alpha-october/chat.json --out exports/alpha-october/readable.md
teams convert-all
```

For an existing standalone JSON archive, `teams media --input <chat.json>` remains available to download images and regenerate its transcript.

## Migration from earlier commands

- Replace online `export ...` commands with `download ...`. `export` now always reads saved SQLite history offline.
- `export-db` remains an alias for `export`; `media-db` remains an alias for `images`.
- `download --last Nd` produces daily folders for every selected day. Use `--out <new-directory>` for one combined bundle.
- Repeated downloads preserve completed history rather than re-fetching it. Existing archives and custom databases are not migrated.

## Recovery and limits

- Expired credentials: run `login` again. For missing image credentials, use `login --wait-for-media` and open a chat containing images.
- Interrupted download: rerun it. Completed database intervals and image files remain saved. A failed history phase leaves previously exported files intact.
- Image failure: saved text and available images are exported when possible, and the command exits unsuccessfully. Retry `download`, or run `images` and then `export`.
- Unsupported attachments remain placeholders. Only supported inline images are downloaded; standard Teams emoji render as text.
- Collection preserves previously observed history; it cannot recover messages Teams never made available. It does not synchronize later edits or deletions.
- Combined exports load their selected range into memory; daily exports load one day at a time.

`download`, `collect`, `images`, and `export` write private per-invocation logs in `<database>.logs/`. The path is printed; `--no-log` disables them. Logs include operational paths and account/chat IDs, but no message bodies or credentials. Logs and backups are retained until manually removed. Logging failures warn without stopping collection. Unix files use private permissions; Windows privacy depends on filesystem ACLs.

Credentials and the dedicated browser profile live under `~/.local/state/teams-chat-download/` by default (`XDG_STATE_HOME` can override this). Keep credentials, collections, and exports out of version control. Private Teams endpoints can change and break the tool.

## More documentation

- [User guide](docs/user-guide.md)
- [Documentation index](docs/README.md)
- [Development and verification](docs/development.md)
- [Contributor instructions](AGENTS.md)

Run `teams <command> --help` for options.
