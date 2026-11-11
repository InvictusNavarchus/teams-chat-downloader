# Browser login and explicit credential refresh

Implemented **2026-11-05**. `bun run teams login` acquires credentials through a visible Chromium browser and saves the existing version-1 credential format, including optional service-scoped media cookies when available. Ordinary `chats` and `export` remain HTTP-only operations; they neither import the login module nor connect to Playwright. Credential renewal without the browser, unattended refresh, and logout/revocation remain outside this feature.

## Browser and profile ownership

The runtime dependency is `playwright-core` **^1.64.1**, with its exact resolved version recorded in `bun.lock`; 1.64.1 was the stable registry version checked before the initial installation. This package does not install a browser. The CLI detects installed executables in this order: `chromium-browser`, `chromium`, `google-chrome`, `google-chrome-stable`, `msedge`. `--browser <path>` overrides detection. If nothing is detected, Playwright's own managed Chromium location is attempted; an absent browser produces a safe, actionable error. Compatibility with arbitrary distribution browser versions is not promised.

The browser is always visible, with `chromiumSandbox: true`. Native Wayland is selected by `--ozone-platform=wayland` when `WAYLAND_DISPLAY` is set; the terminal's environment is inherited. Playwright's ordinary automation defaults remain in place. No MCP-specific flag overrides are added, no global MCP config is read or modified, and no browser is installed automatically. The command owns browser cleanup and handles SIGINT/SIGTERM through the CLI abort signal.

Default state root: `$XDG_STATE_HOME/teams-chat-download/`, falling back to `~/.local/state/teams-chat-download/` for unset, empty, or relative XDG state home. Credentials are `credentials.json`; the persistent browser user-data directory is `browser/`. New directories use mode 700 and credential files mode 600. Existing browser-profile directories with group/other permissions are rejected on Unix. Browser state can contain normal Microsoft session credentials and is private data.

This is a tool-specific profile, separate from the existing MCP profile and everyday browser. First use may require another interactive sign-in. Later logins reopen the persistent profile. `--browser-profile <dir>` selects another dedicated profile; never point two live browser processes at the same user-data directory. No existing MCP profile is migrated or shared automatically.

## Command and output contract

```sh
bun run teams login
bun run teams login --wait-for-media
bun run teams login --browser /path/to/chromium --browser-profile /private/teams-browser --credentials /private/credentials.json --timeout 600
```

All paths may be overridden explicitly. The credential destination defaults to the standard state file even if the older project-private fallback exists. Explicit `--credentials` changes the file destination, not the default browser-profile directory. Time budget: 600 seconds by default, configurable from 1 to 3600 seconds. Browser launch has at most 30 seconds; initial navigation at most 60 seconds, within the overall budget. Cancellation closes an opened context to interrupt navigation.

Progress and HTTP validation counters go to stdout alongside the success JSON object with `status: "saved"`, `credentials` destination, and `browserProfile` path. Stdout as a whole is terminal output rather than a JSON document. Warnings and failures go to stderr; the exit code indicates success or failure. No tokens, profile names, password fields, cookies, or raw Playwright error messages are printed. Login derives `accountId` as SHA-256 of the verified self-profile MRI, rather than trusting a user-supplied label for captured credentials. The version-1 file is replaced as one coherent set; old and new service credentials are not merged.

The CLI instructs the user to sign in and complete any verification directly in the browser. It does not fill or inspect password/MFA fields. It navigates only to `https://teams.live.com/v2/` and observes the requests Teams makes normally. If no successful history request occurs, the user can open a chat. The tool does not send messages, alter contacts, or drive a chat picker; normal Teams UI activity can still have normal application side effects such as marking a chat read.

## Capture and validation

Register response observation before navigating. Ignore non-2xx responses and other origins. Retain only:

1. The complete `authentication` value from a successful GET under `https://teams.live.com/api/chatsvc/consumer/v1/`.
2. The complete `authorization` and `x-skypetoken` values **from the same** successful profile request: `GET /api/mt/beta/users/me/`, `POST /api/mt/beta/users/fetchShortProfile`, or `POST /api/mt/beta/users/fetchFederated`.

Incomplete profile pairs are never combined across requests. Reading request headers can fail during navigation/closing; ignore that observation and continue waiting. Listeners are removed after capture or on abort. No raw network log, trace, screenshot, or browser storage-state export is written.

After both services have supplied candidates, use ordinary HTTP with redirect refusal and the existing timeout/retry/accounting policy to check:

1. Self-profile using `skypeTeamsInfo=true&forceRefresh=false&ephemeralMeProfile=false&ggEnabled=true` and the captured Authorization/Skype pair. Require a nonempty MRI and derive the stable local account label from it. This verification reads the profile without forcing another refresh while the browser may already be refreshing it. Overlapping forced refreshes reproduced HTTP 409; see the [controlled comparison](05-validation-and-open-questions.md#13-login-profile-refresh-contention). Ordinary profile lookups retain their existing refresh behavior.
2. The chat directory with Skype token only, including directory completeness validation. Name enrichment is disabled during this check.
3. History using its separate Authentication value: for the first listed chat, request a one-millisecond window ending at the validation time. Discard any returned records. For an empty directory, use the observed read-only `GET /api/chatsvc/consumer/v1/users/ME/properties` route to avoid inventing a chat ID. This route returned HTTP 200 with a JSON object using the newly captured history header on the populated account. The empty-account branch has synthetic coverage; live acceptance with an actually empty account remains outstanding.

The nonempty-account normal path therefore uses three counted validation requests. Browser sign-in/application traffic is outside these counters. These checks establish currently accepted service credentials, not token lifetime, future renewal, or message completeness. A partial directory currently fails login verification because directory continuation is not implemented. Do not switch accounts midway through a login attempt; use another completed invocation/profile when changing accounts.

After these checks, the CLI reads cookies applicable to `/v1/` on each supported media origin from its browser jar. Only matching unexpired/session `skypetoken_asm` values are saved in optional `mediaCookies`; unrelated cookies are excluded. Missing media cookies do not fail ordinary login. `login --wait-for-media` waits when none are available: open an image-containing chat when prompted. A successful GET response for a supported image triggers another cookie lookup for that exact URL; only a cookie scoped to `/`, `/v1`, or `/v1/` can be reused across objects. The same login timeout, cancellation, and previous-file preservation apply while waiting. Standalone HTTP media access is checked during export, without an extra login probe. See the [image reference](10-image-export.md).

Only after all checks succeed does the writer validate the credential schema, create a private temporary file alongside the destination, and atomically rename it into place. Failure, timeout, cancellation, or closing the browser before publication leaves existing credentials intact. In all cases the command removes temporary capture listeners and closes its context; persistent profile data remains for reuse. A refresh changes the profile-cache credential scope, so the next name lookup may be cold.

## Verification and remaining limits

Synthetic tests cover valid capture, capture filtering, pair integrity, service validation failure, forced-refresh contention, empty-account fallback, timeout, manual close, cancellation, safe errors, private permissions, atomic replacement, launch options, CLI help, and invalid options. See [E20](01-findings-and-evidence.md#e20--standalone-browser-login-and-saved-credential-reuse) for the initial live login checks and [E21](01-findings-and-evidence.md#e21--concurrent-forced-self-profile-refreshes-can-return-http-409) for the HTTP 409 investigation and verified non-forced login check.

Known limits: one active login per profile; manual sign-in/MFA when Microsoft requires it; no browser-profile import; no logout command; `--wait-for-media` may require manually opening an image-containing chat; no silent renewal; no endpoint-stability promise. Media cookie capture has synthetic coverage but has not yet been live-validated. Session expiry, revoked credentials, and other account/region behavior remain service-specific. On authentication failure, rerun `teams login` and then retry the original command.

Primary library references: [persistent contexts and launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [context response events](https://playwright.dev/docs/api/class-browsercontext#browser-context-event-response), and [request headers](https://playwright.dev/docs/api/class-request#request-all-headers). These support library mechanics, not the private Teams authentication contract.
