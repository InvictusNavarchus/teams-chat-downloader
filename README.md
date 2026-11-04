# Teams Chat Download

A Bun CLI for exporting chat history from **Microsoft Teams Free with a personal Microsoft account** (`teams.live.com`).

The intended workflow is to select a chat, export a chosen date range, and download its images with a persistent cache so overlapping exports can reuse media.

## Project status

The CLI supports browser login, listing chat IDs, and exporting one chat's message history and supported inline images to JSON with optional Markdown output. It uses strict TypeScript, CAC, Zod, Ky, Playwright for login, and Turndown for HTML-to-Markdown conversion. JSON is the canonical export: source message fields, rich text, and unknown fields remain preserved. Markdown is generated from the saved JSON and can be regenerated offline.

One-to-one labels resolve through participant profiles and a persistent name cache. Images use an account-scoped persistent cache and are copied beside each export for offline use. Unattended credential renewal remains future work. Ordinary listing/export does not launch or connect to a browser.

## Setup

The implementation was tested with Bun **1.3.14**. Install dependencies with the committed lockfile:

```sh
bun install --frozen-lockfile
bun run teams --help
```

Sign in using an installed Chromium, Chrome, or Edge:

```sh
bun run teams login
bun run teams chats
```

`login` opens a visible browser with a dedicated persistent Teams profile. Sign in and complete verification directly in that window. If capture waits for history, open a chat. The command captures the service headers, checks self-profile, directory, and history access over HTTP, saves a private credential file, then closes its browser. Passwords and verification codes are never captured by the CLI.

Run `bun run teams login` again when credentials expire. It reuses the dedicated browser session; Microsoft may still require sign-in or verification. This is an explicit refresh command, not background renewal. The first run uses a separate profile from your everyday browser and Playwright MCP, so those existing sessions are not automatically imported.

The default credential destination is `$XDG_STATE_HOME/teams-chat-download/credentials.json` (fallback `~/.local/state/teams-chat-download/credentials.json`). The browser profile is `browser/` beside that default destination, even with an explicit credential override. Relative/empty XDG state home is ignored. On this Fedora installation the command detects `/usr/bin/chromium-browser`, enables Chromium's sandbox, and selects native Wayland when `WAYLAND_DISPLAY` is set. It installs no browser and changes no global MCP settings.

Optional overrides:

```sh
bun run teams login --browser /path/to/chromium --browser-profile /private/teams-browser --credentials /private/credentials.json --timeout 600
```

The login timeout defaults to 600 seconds. Browser profiles must be private (Unix mode 700) and cannot be used by two browser processes concurrently. Closing the window, timeout, cancellation, capture failure, or failed validation leaves previous credentials intact. See the [login reference](docs/09-browser-login.md) for the exact lifecycle and limits.

Manual file input remains supported using [the credential template](examples/credentials.example.json). `historyAuthentication` is the **complete captured `Authentication` header value**; `directoryToken` is the captured `x-skypetoken` value. For names, `profileAuthorization` is the complete `Authorization` value including `Bearer`, paired with `directoryToken` from the same profile request. Each command only requires its own service credentials. For manually supplied credentials, `accountId` is a local account label. Login derives a stable SHA-256 account label from the verified self-profile MRI; it is not a token.

For uncached images, `mediaCookies` optionally maps each supported media origin to its matching `skypetoken_asm` cookie value. `login` captures available, unexpired cookies from the browser jar after service verification. Existing credential files remain valid. If an export reports missing image credentials, run `bun run teams login --wait-for-media` and open an image-containing chat when prompted; this waits for a supported image request if no cookie is available yet. Cookie capture does not itself verify standalone HTTP image access; that is checked when downloading. Cookies are sent only to their matching media origin.

`chats` and `export` find credentials automatically, in this order:

1. An explicit `--credentials <file>` override, when supplied (no fallback).
2. `$XDG_STATE_HOME/teams-chat-download/credentials.json`, or `~/.local/state/teams-chat-download/credentials.json` when that variable is unset, empty, or relative. Use an absolute `XDG_STATE_HOME` with the setup commands above.
3. The existing `.private/credentials.json` inside this CLI installation, for compatibility with the original setup. This path is independent of your working directory.

Only a missing file permits fallback. Invalid JSON, invalid credential fields, unreadable files, or unsafe permissions stop lookup. An existing project-private credential file therefore needs no migration unless you want to use the per-user location.

Login always writes its default per-user state file unless `--credentials` overrides it; it does not overwrite the old project-private fallback automatically. A new default file takes precedence over that fallback on subsequent reads. See the [authentication reference](docs/03-authentication-and-browser.md) for historical browser setup and capture sources. Credential files with group/other permissions are rejected on Unix. The `.private/`, `exports/`, and browser-artifact directories are ignored by Git. Keep custom credential files and browser profiles outside version control too.

## Usage

List chat IDs and available group titles as JSON:

```sh
bun run teams chats
```

Save a local reference for copying chat IDs. Run the same command whenever you want to refresh it:

```sh
bun run teams chats --out .private/chats.json
```

The file contains the same JSON array as stdout, including IDs and resolved labels. Every invocation fetches the current directory and reuses the name cache. To refresh names too, add `--refresh-names`. Successful saves atomically replace the previous list; failed retrieval, failed writing, or cancellation leaves the previous file intact. New files use private permissions. The `.private/` example is ignored by Git. This replacement behavior applies to chat lists; history exports still refuse to overwrite existing files.

Named group titles are preserved. Untitled one-to-one chats use the other participant's display name; `title` remains null because it reflects the source title. Unavailable or ambiguous profiles retain an explicit unresolved label. Without `profileAuthorization`, listing still works and warns that names are unresolved. Profile authentication or HTTP failures fail explicitly. If Teams reports a partial directory, the command fails rather than presenting it as a complete listing.

Names and self identity are cached for 24 hours in `$XDG_CACHE_HOME/teams-chat-download/profiles/` (default `~/.cache/teams-chat-download/profiles/`; relative XDG values are ignored). The cache is private, contains no tokens or email fields, and is isolated by account label and credential pair; renewed credentials start a new cache. A warm listing only fetches the directory. Force a profile refresh after a name change with:

```sh
bun run teams chats --refresh-names
```

The [participant profile reference](docs/08-participant-profiles.md) records the observed requests, cache policy, and remaining limits. Name caching is separate from the image cache. Automatic export filenames resolve the selected chat's label through the same directory and name cache. Exports with an explicit `--out` do not request the directory or profiles.

Export a rolling seven-day window, or select an older period directly:

```sh
bun run teams export --chat '<raw-chat-id>' --last 7d
bun run teams export --chat '<raw-chat-id>' --from '2026-08-01T00:00:00Z' --to '2026-08-08T00:00:00Z'
bun run teams export --chat '<raw-chat-id>' --last 7d --out exports/last-week.json
```

Choose exactly one of `--last Nd`, `--since <timestamp>`, or `--from <timestamp> --to <timestamp>`. Full timestamps must include `Z` or an offset and use at most millisecond precision; date-only values are rejected. The start is inclusive and the end exclusive. `--last 7d` means 168 hours ending at one captured invocation time. Filtering and sorting use `originalarrivaltime`.

`--out` is optional. By default, files go into `exports/` under the current working directory. The chat label becomes normalized lowercase kebab-case: accents are removed, other Unicode letters and numbers are retained, separators become hyphens, and labels are capped at 40 characters to keep filenames within filesystem limits. For a label of "Project Alpha":

| Selection | Example filename |
| --- | --- |
| `--last 1d` | `project-alpha--last-1d--to-2026-11-05T10-30-00-000Z.json` |
| `--since '2026-11-01T00:00:00Z'` | `project-alpha--since-2026-11-01T00-00-00-000Z--to-2026-11-05T10-30-00-000Z.json` |
| `--from '2026-11-01T00:00:00Z' --to '2026-11-05T00:00:00Z'` | `project-alpha--from-2026-11-01T00-00-00-000Z--to-2026-11-05T00-00-00-000Z.json` |

Filename timestamps use UTC with milliseconds and filename-safe separators. The `to` timestamp is the exclusive end of the actual export window; including it distinguishes rolling exports run at different times. Successful stdout JSON includes the absolute saved path as `output`. If directory credentials or a matching chat label are unavailable, naming uses a short hash of the chat ID; generic untitled/unresolved labels also include that hash. Directory and profile request failures still fail explicitly. Use `--out <file>` to select any other path and skip label lookup. Existing files are never overwritten, including a repeated export of the same explicit range; choose another `--out` path if needed.

`--chat` accepts the raw ID printed by `chats`. History pages use the tested size of 200 and preserve the original bounds on continuation. Identical duplicates are removed; conflicting records for one ID, invalid payloads, unexpected destinations, non-progress, and out-of-window messages fail explicitly.

Every history export saves one JSON file containing source messages and a versioned manifest with window, completion, pagination, and request counts. Existing files are never overwritten. The JSON file is published only after history retrieval and writing finish; failed history retrieval leaves no new complete-looking export. Retrieval currently holds the chosen window in memory and has no durable resume checkpoint.

### Images

Exports download supported inline chat images by default. An export to `exports/last-week.json` stores images in `exports/last-week.json.media/`. Keep this directory beside the JSON and Markdown when copying an export. The manifest maps source messages to relative image paths, byte lengths, media types, and SHA-256 hashes; source messages remain unchanged. No image directory is created when there are no supported images.

```sh
bun run teams export --chat '<raw-chat-id>' --last 7d --format markdown
bun run teams export --chat '<raw-chat-id>' --last 7d --refresh-media
bun run teams export --chat '<raw-chat-id>' --last 7d --no-media
```

Complete images are reused from `$XDG_CACHE_HOME/teams-chat-download/media/` (default `~/.cache/teams-chat-download/media/`; relative XDG values are ignored). Cache entries are isolated by account and keyed by media origin, object path, and representation. Repeated references download once per export. Default reuse makes **zero media requests**, even without media credentials. `--refresh-media` explicitly revalidates cached images using ETag or Last-Modified when available; a `304` reuses the checked local bytes. Missing or corrupt entries are downloaded unconditionally. `--no-media` skips downloading and preserves the earlier not-downloaded manifest and placeholders; it cannot be combined with `--refresh-media`.

The supported adapter handles absolute HTTPS `imgo` URLs in HTML `<img src>` on `us-api.asm.skype.com` and `experimental-api.asm.skype.com`, with an optional namespace. Responses must be HTTP 200 JPEG, PNG, GIF, or WebP, with matching file signatures and container endings; each response is limited to 50 MiB. Downloads run sequentially. External URLs, signed/query-bearing URLs, other views, and opaque-only `amsreferences` are not resolved. They are counted as unsupported, rendered as placeholders, and mark `media.status` as `partial`; history completion remains separate. Otherwise media is `complete`, including exports with no images.

Authentication, HTTP, invalid-image, and write failures stop the command before JSON publication. Completed cache entries survive for a retry, and this attempt's image directory is removed. Existing output/image directories are never overwritten. Stderr reports reused, downloaded, unfinished, and unsupported counts; media HTTP attempts and retries are included in request accounting. See the [image export reference](docs/10-image-export.md) for storage, refresh, and validation limits.

### Markdown and offline conversion

Add `--format markdown` to save JSON first and then generate Markdown from that file:

```sh
bun run teams export --chat '<raw-chat-id>' --last 7d --format markdown
bun run teams export --chat '<raw-chat-id>' --last 7d --format markdown --out exports/last-week.json
```

The default format is `json`. `--out` always selects the **JSON destination**, including when `--format markdown` is used. Markdown is saved beside it, replacing a final `.json` extension with `.md` (case-insensitive), or appending `.md` when the JSON path has another extension. For example, the second command saves `exports/last-week.json` and `exports/last-week.md`. Successful stdout includes the JSON path as `output` and the Markdown path as `markdown`.

Convert an existing export later without credentials, browser access, or Teams requests:

```sh
bun run teams convert --input exports/last-week.json
bun run teams convert --input exports/last-week.json --format markdown --out exports/readable-chat.md
```

`convert` defaults to Markdown beside the source JSON. Its stdout reports `input`, `output`, `format`, and `messages`. Both commands refuse to overwrite any existing destination and publish private output files atomically. If Markdown conversion fails after JSON was saved, the command exits unsuccessfully and reports the saved JSON path. Keep that file and retry with `convert --out <new-path>`; history does not need to be downloaded again.

Convert all JSON exports that do not already have a sibling Markdown destination:

```sh
bun run teams convert-all
bun run teams convert-all --dir /path/to/exports
bun run teams convert-all --dir /path/to/exports --recursive
```

`convert-all` defaults to the `exports/` directory under the current working directory. It scans regular `.json` files (case-insensitive), visiting subdirectories only with `--recursive`; symlink entries are ignored. Conversion is sequential and offline, using the same validation, renderer, and atomic writer as `convert`. An existing sibling `.md` destination is skipped without reading its JSON, so rerunning the command converts only missing outputs. Existing Markdown is not refreshed, and the batch command does not accept a shared `--out` path.

Stdout contains `directory`, `format`, `recursive`, `converted`, `skipped`, `failed`, and per-file `files` results with absolute input/output paths, status, and any conversion error. Invalid JSON, unsupported archives, and per-file write failures are reported while remaining files continue; any failed file makes the command exit with code 1. Empty directories succeed with zero counts. Missing or unreadable directories fail explicitly. Completed files and all source JSON are kept if a later file fails or the run is cancelled. Like `convert`, the only supported format is `markdown`.

Conversion accepts complete version 1 exports, including files from before this feature. A shared reader validates the version, required rendering fields, and date window while retaining unknown fields. Markdown reads as a chronological transcript: one heading per calendar day, then compact speaker turns such as `**Alice · 09:15–09:17**`. Consecutive messages from the same source sender are grouped when the gap from the previous message is at most five minutes, with each message kept as its own paragraphs or rich-text blocks. A sender change, longer pause, new day, or system event starts a new turn. Missing sender identities stay separate; matching display names alone do not establish the same author. Available sender names fall back to the source sender ID or "Unknown sender". Message IDs and technical type labels remain in JSON.

Dates and 24-hour times use the machine's local timezone, labeled once at the top; set `TZ` when converting to use another zone (for example, `TZ=UTC bun run teams convert --input exports/last-week.json --out exports/utc-chat.md`). JSON retains the original timestamps and exact window bounds. Existing exports can be converted again with a new `--out` path to get the transcript layout without fetching history.

Rich HTML supports paragraphs, emphasis, lists, blockquotes, code, and ordinary HTTP(S)/email links. Explicit `Text` messages remain literal text. Unsupported message types retain available content as literal text; missing/non-string content gets an explicit placeholder. Tables, cards, Teams-specific replies, reactions, and other complex structures are not fully reconstructed; JSON retains the source data.

Downloaded images become local Markdown image links; conversion to another directory rebases those links relative to the new Markdown path. Conversion performs no downloads and does not copy image files, so keep the original image directory available. Older exports, `--no-media`, and unsupported images retain **not-downloaded placeholders**. Messages with `amsreferences` but no inline images get a media placeholder without copying media URLs or technical reference details. Executable HTML elements and unsafe link destinations are omitted, and source text is escaped rather than retained as raw HTML. HTML, PDF, and other output formats remain future work.

Successful commands write JSON to stdout. Request summaries, warnings, and errors go to stderr. Summaries count directory, profile, history, and media attempts separately, including retries. Each HTTP operation, including the two read-only profile POST routes, allows two retries for eligible read failures, has a 15-second attempt timeout and a 60-second total deadline, and honors applicable server wait guidance without shortening it. Redirects are refused. These are client settings, not known Teams quotas. SIGINT/SIGTERM cancels further requests.

## Development and verification

```sh
bun run typecheck
bun run test
```

Offline tests use synthetic responses for pagination, validation, retries, cancellation, and output publication. An ordinary live check listed 15 chats with one directory request and exported 5 messages from a seven-day window with one history request, without retries. The browser remained open; a browser-closed check is still outstanding. See [E17](docs/01-findings-and-evidence.md#e17--first-bun-cli-live-check).

The participant-name CLI check resolved all eight one-to-one names in a 15-chat directory. The first run used four requests; the next reused the cache and used one directory request, both without retries. See [E19](docs/01-findings-and-evidence.md#e19--participant-name-cli-and-cache-check).

The login check completed twice using its dedicated persistent browser, three HTTP validation requests per run without retries. After the login browser closed, separate CLI processes listed all 15 chats with eight resolved one-to-one names and exported five messages successfully. The independent research MCP browser remained open. See [E20](docs/01-findings-and-evidence.md#e20--standalone-browser-login-and-saved-credential-reuse).

## Documentation

Start with the [research reference](docs/README.md) for the findings, protocol details, browser setup, proposed CLI design, validation plan, and sources. It distinguishes verified behavior from proposals and unresolved questions and serves as the implementation reference.

The [architecture plan](docs/07-architecture.md) records module responsibilities, implementation defaults, and later milestones.

The findings concern private Teams endpoints observed on one account. They are not a published Microsoft API contract.
