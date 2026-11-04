# Teams Chat Download

A Bun CLI for exporting chat history from **Microsoft Teams Free with a personal Microsoft account** (`teams.live.com`).

The intended workflow is to select a chat, export a chosen date range, and download its images with a persistent cache so overlapping exports can reuse media.

## Project status

The first implementation supports listing chat IDs and exporting one chat's message history to JSON using supplied credentials. It uses strict TypeScript, CAC, Zod, and Ky. Source message fields are preserved, including rich text and unknown fields; the CLI does not render them yet.

One-to-one labels resolve through participant profiles and a persistent name cache. Image downloading/caching, a login command, and automatic credential renewal are still to come. Exported JSON explicitly records that media was not downloaded. There is no browser dependency in the implemented export path.

## Setup

The implementation was tested with Bun **1.3.14**. Install dependencies with the committed lockfile:

```sh
bun install --frozen-lockfile
bun run teams --help
```

Create a private per-user state directory and copy the credential template:

```sh
teams_state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/teams-chat-download"
mkdir -p -m 700 "$teams_state_dir"
cp examples/credentials.example.json "$teams_state_dir/credentials.json"
chmod 600 "$teams_state_dir/credentials.json"
```

Replace the placeholders locally with credentials captured from your signed-in Teams session. `historyAuthentication` is the **complete captured `Authentication` header value**; `directoryToken` is the captured `x-skypetoken` value. For participant names, `profileAuthorization` is the complete `Authorization: Bearer …` value from a Teams profile request (store the value including `Bearer`, not the header name). Profile requests need this value together with `directoryToken`; capture the pair from the same profile request. Each command only requires its own service credentials. `accountId` is your stable local account label, not a token or a verified Microsoft identity.

Both commands find credentials automatically, in this order:

1. An explicit `--credentials <file>` override, when supplied (no fallback).
2. `$XDG_STATE_HOME/teams-chat-download/credentials.json`, or `~/.local/state/teams-chat-download/credentials.json` when that variable is unset, empty, or relative. Use an absolute `XDG_STATE_HOME` with the setup commands above.
3. The existing `.private/credentials.json` inside this CLI installation, for compatibility with the original setup. This path is independent of your working directory.

Only a missing file permits fallback. Invalid JSON, invalid credential fields, unreadable files, or unsafe permissions stop lookup. An existing project-private credential file therefore needs no migration unless you want to use the per-user location.

This release does not automate credential capture or renewal. See the [authentication reference](docs/03-authentication-and-browser.md) for the observed browser setup and capture sources. Credential files with group/other permissions are rejected on Unix. The `.private/`, `exports/`, and browser-artifact directories are ignored by Git. Keep custom credential files outside version control too.

## Usage

List chat IDs and available group titles as JSON:

```sh
bun run teams chats
```

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

## Documentation

Start with the [research reference](docs/README.md) for the findings, protocol details, browser setup, proposed CLI design, validation plan, and sources. It distinguishes verified behavior from proposals and unresolved questions and serves as the implementation reference.

The [architecture plan](docs/07-architecture.md) records module responsibilities, implementation defaults, and later milestones.

The findings concern private Teams endpoints observed on one account. They are not a published Microsoft API contract.
