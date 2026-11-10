# AGENTS.md — Contributor & AI Agent Guide

## 1. Project Overview & Philosophy

`teams-chat-download` is a Bun-powered command-line interface (CLI) for exporting chat history and inline media from **Microsoft Teams Free with personal Microsoft accounts** (`teams.live.com`).

### Core Design Principles

1. **Direct HTTP Over Browser Automation**: Browser automation (via `playwright-core`) is strictly isolated to the interactive `login` command for credential capture. Listing chats, fetching history, and downloading media run entirely through direct HTTP calls using `ky`.
2. **JSON as the Canonical Archive**: The primary export output is a Version 1 JSON archive (`history.json`). It retains rich text, original arrival timestamps, message edit states, and unknown Teams API properties without loss.
3. **Sibling Markdown Representation**: A readable Markdown transcript (`history.md`) is rendered alongside the JSON archive by default. Markdown is derived from the JSON and can be regenerated completely offline.
4. **Two-Tier Persistent Caching**:
   - **Profiles Cache**: `$XDG_CACHE_HOME/teams-chat-download/profiles/` caches participant display names for 24 hours to resolve one-to-one chat labels.
   - **Media Cache**: `$XDG_CACHE_HOME/teams-chat-download/media/` deduplicates images by account and media object key, supporting conditional HTTP 304 revalidation and offline local reuse.
5. **Defensive Non-Destructive Operations**: Exports will never overwrite existing export folders. File writes are atomic (written to temp files then renamed). Private file permissions (`0600`/`0700`) are strictly enforced for credentials and profiles.

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
│   └── 10-image-export.md           # Media extraction, caching, and revalidation
├── exports/              # Default export output directory (git-ignored)
├── src/                  # Application source code
│   ├── archive.ts        # Version 1 JSON archive schema, serialization, and validation
│   ├── archive-media.ts  # Media download coordination for archives (inline and post-export)
│   ├── cli.ts            # CAC argument parsing, command dispatch, terminal progress, and exit handling
│   ├── command-validation.ts # Command schemas, inferred types, defaults application, and resolution
│   ├── config.ts         # Shared application defaults and command limits
│   ├── convert.ts        # Offline single-archive JSON-to-Markdown conversion
│   ├── convert-all.ts    # Batch offline JSON-to-Markdown conversion
│   ├── credentials.ts    # XDG state loading, credential validation, and file permission checks
│   ├── date-window.ts    # Shared history date-window contract and validation
│   ├── errors.ts         # Domain error classes, validation errors, and sanitized formatters
│   ├── export.ts         # Label selection and chat export orchestration (history + text + media)
│   ├── export-path.ts    # Destination folder formatting and kebab-case label sanitization
│   ├── http.ts           # Ky HTTP client wrapper, retry policy, backoff, and request accounting
│   ├── login.ts          # Playwright helper for interactive browser sign-in and token capture
│   ├── markdown.ts       # Turndown-based HTML-to-Markdown conversion and transcript rendering
│   ├── media.ts          # Media URI parsing, AMS/Skype ASM cookie handling, and cache lookup
│   ├── output.ts         # Atomic filesystem writes and directory permission enforcement
│   ├── profiles.ts       # Participant name resolution and 24-hour disk caching
│   └── teams.ts          # Teams API client (directory listing, bounded history, pacing delay)
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
│   ├── markdown.test.ts
│   ├── media.test.ts
│   ├── command-validation.test.ts
│   ├── profiles.test.ts
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
   - _Never merge these into a generic global credential bundle._
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

---

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

# Type checking (strict TypeScript, noEmit)
bun run typecheck

# Code formatting (Biome)
bun run format
```
