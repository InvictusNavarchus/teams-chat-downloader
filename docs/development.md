> Current command interface: `download` collects missing intervals, downloads images, and exports through SQLite; `collect` saves history and optionally downloads images with `--images`, without exporting; `export` is offline; `images` downloads saved references. `export-db`/`media-db` are aliases. Repeated collection preserves saved history and does not synchronize edits or deletions. Default databases are account-scoped under user state; offline default discovery requires exactly one database. See the [user guide](user-guide.md#default-collections-and-command-migration).

# Development and verification

[Documentation index](README.md) · [Project overview](../README.md)

Use Bun for package management and scripts. Install the committed dependency resolution with `bun install --frozen-lockfile`. Dependency ranges live in `package.json`; exact resolved versions live in `bun.lock`. Read [AGENTS.md](../AGENTS.md) before contributing.

## Offline checks

Shared command defaults and limits live in `src/config.ts`; CLI help and runtime fallbacks use those same values. `src/cli.ts` parses arguments with CAC and dispatches commands. `src/command-validation.ts` validates the resulting objects with Zod, applies defaults, and resolves command options, including export date windows and login paths. The shared date-window contract lives in `src/date-window.ts`. Environment-dependent credential and media paths are resolved by their existing helpers when invoked.

```sh
bun run typecheck
bun run test
```

Offline tests use synthetic responses for pagination, validation, retries, cancellation, and output publication. They do not require saved credentials. Live checks are separate and explicitly opt-in.

`src/cli-help.ts` formats registered CAC commands/options into common workflows and grouped references. `tests/cli-help.test.ts` checks every command and alias without credentials or HTTP, verifies that help creates no application files, and checks the 88-column layout. Review `bun run teams --help` and `bun run teams collect --help` when changing user-facing commands; keep parser defaults independent of help formatting.

## Live smoke test

Run an explicit, bounded check against live Teams using saved credentials:

```sh
# Automatically find a same-account archive under exports/:
bun run test:live
# Override automatic fixture discovery, including for a custom export location:
bun run test:live --fixture exports/example/chat.json
# Or select a specific live history target:
bun run test:live --chat '<raw-chat-id>'
bun run test:live --chat-label 'Project Alpha'
# Override the default window to probe a busier historical period:
bun run test:live --chat-label 'Project Alpha' --from '2026-08-01T00:00:00Z' --to '2026-08-08T00:00:00Z'
```

With no selector, the runner automatically looks for complete same-account version 1 archives under `exports/` in the current working directory. It checks regular root `.json` files, legacy direct export-folder `chat.json`, and standard `<chat>/<date-or-period>/chat.json` bundles. It ignores symlinks, media directories, and deeper descendants. It prefers archives with a known non-self sender and a supported inline image; among equally useful candidates, newer file modification times win, then path order breaks ties. Invalid/unreadable candidates are skipped with a count; other accounts are ignored. The selected local path is printed. Discovery reads files only and makes no network requests.

An automatically selected archive supplies the raw chat ID and known participant/image targets. If no usable archive is available, the runner uses live directory members and its first listed chat where possible; unavailable inputs remain `UNVERIFIED`. No archive or fixture argument is required. Supply at most one of `--fixture <chat.json>`, `--chat <raw-id>`, or `--chat-label <label>` to override the default. An explicit fixture bypasses discovery, must be a complete version 1 archive with `accountId` matching the credentials, and fails before HTTP if invalid or mismatched. The archive is read only; no archived response counts as a live service check.

`--chat` overrides the history target without requiring directory lookup to succeed. `--chat-label` retains the same exact, case-insensitive label match as `export`, after trimming whitespace, including resolved participant names. Generic fallback labels cannot select chats; missing or duplicate matches prevent history retrieval, and duplicate errors list matching labels and raw IDs. Explicit label selection still requires a successful directory response and any needed profile names; archive filenames are never guessed into label mappings. In either case, automatic archive discovery can supply participant/image targets independently, even from another chat in the same account. The directory is fetched only once. For independent history checks during directory failures, use the default no-selector invocation, `--fixture`, or a raw `--chat` ID.

With no date arguments, the window defaults to the last two local calendar days including today, matching `download --last 2d`: yesterday at local midnight through one captured invocation time. This also applies in fixture mode; the fixture's archived window does not replace the requested live window. Set `TZ` to override the machine's timezone. Supply both `--from` and `--to` to override this window; a single bound is rejected. Explicit timestamps require a timezone; the start is inclusive and the end exclusive, and the end cannot be in the future. The resolved window is printed before requests begin.

Each service probe runs when its own inputs are available, even if another service fails:

| Check                | Required input or result                                                            |
| -------------------- | ----------------------------------------------------------------------------------- |
| Directory            | Directory credentials                                                               |
| Self profile         | Profile credentials, regardless of directory result                                 |
| Participant profiles | Known non-self sender from the fixture, or live directory members                   |
| History              | Automatic/explicit fixture ID, raw ID, resolved label, or first live directory chat |
| Pagination           | Successful first history page with a continuation                                   |
| Media cookie         | Supported image reference from the fixture, or sampled live history                 |
| Media cache          | Valid bytes from this run's cold image download                                     |
| Media revalidation   | Cold image bytes and an ETag or Last-Modified validator                             |

The runner never widens the window automatically. No continuation, missing targets, or missing validators leave the affected checks `UNVERIFIED`. A failed second history page fails pagination while the first page remains verified. Without a discovered or explicit fixture, participant/image discovery can still depend on the directory or history. `--credentials <file>` overrides the usual saved-credential lookup. `--help` describes the arguments. This runner is separate from `bun test` and never opens a browser or refreshes credentials automatically.

Profile probes use direct HTTP requests with no name-cache reuse. Fixture/raw-ID mode queries one known participant; label mode resolves all needed one-to-one names so duplicate labels are detected. History reads at most two pages at the existing page size of 200 and shares the exporter's URL, date-bound, duplicate, progress, payload, and pacing checks. Media uses at most one supported image reference, preferring the fixture's reference even if live history fails or is empty. A fresh temporary image cache forces a real HTTP 200 request to verify that image's origin-specific cookie. The runner then checks local reuse with zero requests and sends a conditional refresh if the image supplies ETag or Last-Modified. HTTP 304 verifies cached-byte reuse; HTTP 200 verifies the refresh fallback and explicitly leaves the 304 branch unverified.

Each of the eight checks prints `PASS`, `FAIL`, or `UNVERIFIED`, followed by HTTP attempt counts including retries. `FAIL` means an attempted operation failed; `UNVERIFIED` means a required input/result was unavailable or the run was cancelled. Exit code 0 requires all checks to pass; any failure, unverified coverage, or invalid invocation exits with code 1. A typical successful fixture/raw-ID run uses seven HTTP attempts without retries: one directory, two profiles, two history, and two media. Label selection may require additional profile batches to detect all matching labels. It prints neither credentials nor message bodies or source URLs. Temporary cache/image files are removed on normal completion, handled failure, and cancellation; fixtures, saved credentials, exports, and normal caches are untouched. Abrupt termination such as SIGKILL can leave the private temporary directory behind.

This is a sample-based HTTP smoke test, covering the selected history route, one participant profile family, and one image origin. It does not prove history exhaustion, every media origin, browser-login capture/renewal, or archive/Markdown publication. Those remain covered separately by offline tests and ordinary usage. See the [architecture reference](07-architecture.md#bounded-live-smoke-test) and [current live verification result](05-validation-and-open-questions.md#12-automated-live-smoke-test).

Historical login, export, and participant-name results are recorded in [findings and evidence](01-findings-and-evidence.md).
