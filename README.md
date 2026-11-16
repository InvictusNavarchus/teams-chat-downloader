# Teams Chat Download

Export chat history from **Microsoft Teams Free with a personal Microsoft account** (`teams.live.com`). Save a readable Markdown transcript, original message data as JSON, and supported inline images for offline use.

For a short period, export directly. For long histories, collect into a resumable SQLite database and create portable exports when ready. Work or school Teams accounts are outside this tool's scope.

## Quick start

You need [Bun](https://bun.sh/) and an installed Chromium, Chrome, or Edge browser. The project was tested with Bun **1.3.14**. From the project directory:

```sh
bun install --frozen-lockfile
bun run teams login
```

Sign in and complete verification in the browser window that opens. If prompted, open a chat. The CLI saves credentials and closes its browser; later exports do not need an open browser.

### Run from any directory

After installing dependencies, run `bun link` once from this checkout to expose the `teams` command. Ensure Bun's global executable directory (`bun pm bin -g`, normally `~/.bun/bin`) is on your `PATH`.

```sh
# From this repository:
bun link
# From any working directory:
teams --help
teams chats
```

The command runs this checkout directly: keep it and its dependencies installed, with Bun on `PATH`. Source updates take effect immediately; relink after moving the checkout. Relative paths (including the default `exports/` directory and `--db`) resolve from the directory where you invoke `teams`. Credentials keep their existing user-state location. Run `bun unlink` from this checkout to remove the link.

### Export chats

List your chats, then replace `Project Alpha` below with a label from the list:

```sh
bun run teams chats
bun run teams export --chat-label 'Project Alpha' --last 7d
```

This exports the last seven **local calendar days**, including today so far, with Markdown and supported images. The command prints where it saved the files.

## Choose your workflow

### Export a recent or specific period

```sh
# Today so far:
bun run teams export --chat-label 'Project Alpha' --last 1d

# A specific period, saved in a new folder:
bun run teams export --chat-label 'Project Alpha' \
  --from '2026-10-01T00:00:00+07:00' --to '2026-11-01T00:00:00+07:00' \
  --out exports/alpha-october
```

Explicit timestamps need a timezone (`Z` or an offset). The start is included and the end excluded. Use `--chat '<raw-chat-id>'` instead of `--chat-label` when labels are duplicated or you need a stable selector for scripts.

**Daily exports replace that day's saved export.** Without `--out`, `--last 1d` refreshes one folder per chat and local date, including its generated transcript. Other periods create snapshots, and an explicit `--out` always requires a new folder. A failed history request leaves the previous daily export intact.

See the [user guide](docs/user-guide.md#choose-dates-and-export-history) for date options, timezone overrides, and output rules.

### Collect a long history and resume interruptions

```sh
# Collect all history available from Teams:
bun run teams collect --db exports/history.sqlite --chat-label 'Project Alpha' --all

# Download its supported images:
bun run teams media-db --db exports/history.sqlite --chat-label 'Project Alpha'

# Create a portable export offline using the label saved during collection:
bun run teams export-db --db exports/history.sqlite --chat-label 'Project Alpha' --out exports/alpha-history

# Export the last three local calendar days into separate daily folders:
bun run teams export-db --db exports/history.sqlite --chat-label 'Project Alpha' --last 3d
```

`media-db` accepts either `--chat <raw-id>` or `--chat-label <label>` to limit downloads to one chat; omit both to handle every chat in the database. Combining the selectors fails.

`export-db` accepts exactly one of `--chat <raw-id>` or `--chat-label <label>`. Both database commands match labels saved in SQLite exactly after trimming whitespace and ignoring case; missing, duplicate, or generic fallback labels fail. Label lookup stays offline and does not refresh names.

`export-db --last Nd` writes `exports/<saved-chat-label>/<YYYY-MM-DD>/chat.json` and a sibling Markdown transcript for each collected day in the requested range. Reruns safely refresh matching daily folders. Export stops at the verified collection cutoff (printed by the command), even if it falls on an earlier day. The final day can be partial; later uncollected days are skipped and reported. Coverage gaps before the cutoff still fail, and fully collected empty days are exported. Use `--no-markdown --no-media` for JSON only. Daily mode cannot be combined with `--out` or explicit bounds.

If collection stops, rerun it with the same database: completed intervals are skipped. Each database belongs to one account and can hold multiple chats. Collection preserves saved history but does **not** synchronize later edits or deletions in completed intervals.

Automatic backups go to `exports/history.sqlite.backups/` in this example. Backups are full snapshots and are not automatically pruned. Keep the live database and its adjacent `history.sqlite.media/` directory together. See [collection workflows](docs/user-guide.md#collect-long-histories) and [backup and restoration instructions](docs/user-guide.md#back-up-and-restore-collections).

## Use your exported files

A typical export looks like this:

```text
exports/alpha-october/
├── chat.json    # Original message data and export metadata
├── chat.md      # Readable transcript
└── media/       # Downloaded images, when present
```

Open `chat.md` in a Markdown viewer. Keep the whole folder together when moving or sharing it so image links continue to work. JSON preserves source fields that the transcript may not fully render, such as complex Teams content.

Regenerate a transcript offline, choosing a new destination if one already exists:

```sh
bun run teams convert --input exports/alpha-october/chat.json --out exports/alpha-october/readable.md
```

Use `bun run teams convert-all` to generate missing transcripts under `exports/`. See [offline conversion](docs/user-guide.md#markdown-and-offline-conversion) for custom locations and batch options.

## Common issues and limits

- **Expired credentials:** run `bun run teams login` again, then retry. Renewal is manual.
- **Missing image credentials:** run `bun run teams login --wait-for-media` and open an image-containing chat when prompted.
- **Images failed after text was saved:** retry with `bun run teams media --input <path/to/chat.json>`. For a collection, rerun `media-db`. Completed images are reused.
- **Text only:** add `--no-media` to skip images or `--no-markdown` to save JSON without a transcript.
- **Missing attachments or formatting:** only supported inline images are downloaded. Other attachments and some rich Teams structures remain placeholders or are incompletely rendered; original fields remain in JSON.
- **Long downloads:** direct exports cannot resume unfinished history retrieval. Use `collect` for checkpoints. Very large offline exports may still need smaller date ranges to fit in memory.

The tool uses private Teams endpoints observed on a personal account, so service changes can break it. It can export only history Teams makes available; it cannot recover deleted or inaccessible messages.

Credentials and the dedicated browser profile are saved under `~/.local/state/teams-chat-download/` by default (`XDG_STATE_HOME` can override this). Keep credentials, browser profiles, and private chat exports out of version control. See [credential settings](docs/user-guide.md#sign-in-and-manage-credentials) for custom paths and lookup rules.

## More documentation

- [User guide](docs/user-guide.md): advanced commands, dates, images, backups, and recovery.
- [Documentation index](docs/README.md): technical references and historical research.
- [Development and verification](docs/development.md): offline tests and opt-in live checks.
- [Contributor instructions](AGENTS.md): project conventions and protocol invariants.

Run `bun run teams --help` or `bun run teams <command> --help` for CLI options.

### Collection execution logs

`collect`, `media-db`, and `export-db` automatically save timestamped progress, coverage summaries, backup results, and handled failures in `<database>.logs/` files (private Unix permissions; Windows privacy depends on filesystem ACLs). Each command prints the log path at startup; use `--no-log` to opt out. Logs are retained until manually removed and are separate from database backups. Logging failures warn without stopping collection. See the [logging details](docs/user-guide.md#collection-execution-logs).

This covers history collection, database media downloads, and offline database exports.

Standard Teams emoji render as text (for example, 🎉) and do not count as missing media. Custom emoji and unsupported attachments still report missing media. Existing SQLite counts are repaired automatically on the next writable `collect` or `media-db` open; read-only exports do not migrate databases. Regenerate Markdown to update existing transcripts.
