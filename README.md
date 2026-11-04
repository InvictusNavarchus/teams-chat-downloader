# Teams Chat Download

A Bun CLI for exporting chat history from **Microsoft Teams Free with a personal Microsoft account** (`teams.live.com`).

The intended workflow is to select a chat, export a chosen date range, and download its images with a persistent cache so overlapping exports can reuse media.

## Project status

The CLI supports browser login, listing chat IDs, and exporting one chat's message history to JSON. It uses strict TypeScript, CAC, Zod, Ky, and Playwright for login. Source message fields are preserved, including rich text and unknown fields; the CLI does not render them yet.

One-to-one labels resolve through participant profiles and a persistent name cache. Image downloading/caching and unattended credential renewal are still to come. Exported JSON explicitly records that media was not downloaded. Ordinary listing/export does not launch or connect to a browser.

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

The [participant profile reference](docs/08-participant-profiles.md) records the observed requests, cache policy, and remaining limits. Name caching is separate from the future image cache. Exports by chat ID do not request profiles.

Export a rolling seven-day window, or select an older period directly:

```sh
bun run teams export --chat '<raw-chat-id>' --last 7d --out exports/last-week.json
bun run teams export --chat '<raw-chat-id>' --from '2026-08-01T00:00:00Z' --to '2026-08-08T00:00:00Z' --out exports/august.json
```

Choose exactly one of `--last Nd`, `--since <timestamp>`, or `--from <timestamp> --to <timestamp>`. Full timestamps must include `Z` or an offset and use at most millisecond precision; date-only values are rejected. The start is inclusive and the end exclusive. `--last 7d` means 168 hours ending at one captured invocation time. Filtering and sorting use `originalarrivaltime`.

`--chat` accepts the raw ID printed by `chats`. An export with an explicit ID makes no directory request. History pages use the tested size of 200 and preserve the original bounds on continuation. Identical duplicates are removed; conflicting records for one ID, invalid payloads, unexpected destinations, non-progress, and out-of-window messages fail explicitly.

The output is one JSON file containing source messages and a versioned manifest with window, completion, pagination, and request counts. Existing files are never overwritten. The file is published only after retrieval and writing finish; a failed run leaves no new complete-looking export. Retrieval currently holds the chosen window in memory and has no durable resume checkpoint.

Successful commands write JSON to stdout. Request summaries, warnings, and errors go to stderr. Summaries count directory, profile, and history attempts separately, including retries. Each HTTP operation, including the two read-only profile POST routes, allows two retries for eligible read failures, has a 15-second attempt timeout and a 60-second total deadline, and honors applicable server wait guidance without shortening it. Redirects are refused. These are client settings, not known Teams quotas. SIGINT/SIGTERM cancels further requests.

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
