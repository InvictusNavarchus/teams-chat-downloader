# Sources and provenance

Research date: **2026-11-04**.

## 1. What the sources can establish

The private Teams endpoint findings come from the live experiments recorded in [findings and evidence](01-findings-and-evidence.md). Public Playwright documentation does not document or guarantee those Teams endpoint contracts.

The links below support account-type constraints, available official alternatives, browser/tool behavior, and standard HTTP semantics. They should not be cited as proof that a particular private Teams request accepts a parameter; use the live evidence for that.

Some upstream links track a moving branch. The local package/version snapshot and dated evidence therefore matter. Chromium links below use the inspected browser version where practical.

## 2. Account type and official alternatives

### S01 — Microsoft Graph chat messages

[Microsoft Graph: List messages in a chat](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0)

The permission table lists personal Microsoft account delegation as unsupported for this operation. This is why the normal Graph chat-message API was not assumed to solve this personal-account task. It does not mean every Microsoft Graph endpoint is unsupported for personal accounts.

The browser did make unrelated Graph requests during investigation, including a storage-quota read. Their presence does not establish personal-account support for the Graph chat-history operation.

### S02 — Official Teams personal data export

[Microsoft Support: Export or delete your data in Microsoft Teams for personal use](https://support.microsoft.com/en-au/teams/personal/files-search/export-or-delete-your-data-in-microsoft-teams-personal)

[Teams data export page](https://teams.live.com/dataexport)

The support article describes the official export route and a downloaded TAR archive containing message/file data, with `messages.json` after extraction. This was discussed as an alternative, but no archive was requested, downloaded, parsed, or compared during this investigation.

An archive parser could still be an alternative product direction if official bulk export fits a later need. The current direction serves selected-chat, selected-period HTTP exports; no claim is made that the official archive was unsuitable in every respect or that private APIs are the only available route.

## 3. Playwright network and authentication behavior

### S03 — Network inspection

[Playwright: Network](https://playwright.dev/docs/network)

Documents request/response monitoring, response waiting, routing, and WebSocket observation. It supports using Playwright to investigate transport; it does not make cached messages appear in a newly attached response listener.

### S04 — Service workers

[Playwright: Service Workers](https://playwright.dev/docs/service-workers)

Explains context-level observation of service-worker requests and the distinction between page- and worker-owned requests. A Teams service worker and dedicated workers were observed, but no complete internal transport/caching model was derived. Blocking service workers was not needed for the successful HTTP strategy and was not applied as a blanket fix.

### S05 — HTTP request contexts

[Playwright: APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext)

Documents that the browser-associated request context shares its cookie jar with the browser. This does not imply automatic replay of authorization headers produced by application JavaScript. The decisive minimal-credential tests used server-side global Fetch rather than relying on cookie sharing.

### S06 — Saved browser authentication

[Playwright: Authentication](https://playwright.dev/docs/auth)

Describes reuse of authenticated browser state and its sensitivity. Browser state reuse is distinct from implementing a service-specific credential store or renewal mechanism for a standalone downloader.

### S07 — Persistent profiles and sandbox setting

[Playwright: BrowserType](https://playwright.dev/docs/api/class-browsertype)

[Chromium sandbox launch option](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox)

Relevant to persistent-context ownership, launch options, and the Chromium sandbox default. The working local config explicitly enables `chromiumSandbox`; runtime confirmation came from `chrome://sandbox/`, not merely from the option being present in JSON.

## 4. Playwright MCP and official CLI

### S08 — MCP configuration and profiles

[Playwright MCP repository](https://github.com/microsoft/playwright-mcp)

[MCP configuration file section](https://github.com/microsoft/playwright-mcp#configuration-file)

[MCP user profile section](https://github.com/microsoft/playwright-mcp#user-profile)

Documents the MCP browser configuration and profile behavior. The exact profile path used in the investigation was obtained from the running browser, because generic documentation paths did not exactly match that runtime location.

### S09 — MCP Chromium configuration source

[Playwright MCP configuration source](https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/tools/mcp/config.ts)

The inspected source adds the AutomationControlled Blink argument when another disable-Blink-features argument is not already present. Local installed code was also inspected during troubleshooting. The current decision is to retain the intentional default because no Teams-specific reason for overriding it was demonstrated.

### S10 — Official CLI configuration and sessions

[Playwright CLI: Configuration](https://playwright.dev/agent-cli/configuration)

[Playwright CLI: Sessions and dashboard](https://playwright.dev/agent-cli/sessions)

The CLI documents in-memory default state, explicit persistent/custom-profile modes, and named sessions. These capabilities were considered, not installed or validated against the existing MCP session.

### S11 — Official CLI attach and network commands

[Playwright CLI: Attach and detach](https://playwright.dev/agent-cli/commands/attach)

[Playwright CLI: Network and mocking](https://playwright.dev/agent-cli/commands/network-routing)

[Playwright CLI: Command reference](https://playwright.dev/agent-cli/capabilities)

Documents attach mechanisms, network inspection/body saving, and custom code execution. The existence of attach commands is not evidence that the current MCP browser exposes an appropriate endpoint automatically.

## 5. Chromium display modes and warning behavior

### S12 — Modern headless mode

[Chrome: Headless mode](https://developer.chrome.com/docs/automation-and-testing/headless)

[Playwright: Chromium headless shell](https://playwright.dev/docs/browsers#chromium-headless-shell)

Support the distinction between browser rendering and showing a visible desktop window. No browser-mode performance benchmark was performed for this exporter workload.

### S13 — Native Wayland/Ozone

[Chromium Ozone overview, inspected source revision](https://chromium.googlesource.com/chromium/src/+/6c4a1e7b654e39b5dfa9fe1bee5e616a04776144/docs/ozone_overview.md)

Relevant to selecting the native Wayland platform. The working Fedora configuration and desktop variables were independently observed locally. No claim of guaranteed resource savings follows from using this display backend.

### S14 — Startup bad-flag warning source

[Chromium 156.0.8078.79: bad_flags_prompt.cc](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.79/chrome/browser/ui/startup/bad_flags_prompt.cc)

Explains the general warning for Blink-feature switches and the first-matching-warning behavior that made successive banners appear during troubleshooting. The banner alone was not treated as proof of a Teams failure.

### S15 — Automation indicator implementation

[Chromium 156.0.8078.79: navigator.cc](https://raw.githubusercontent.com/chromium/chromium/156.0.8078.79/third_party/blink/renderer/core/frame/navigator.cc)

Relates AutomationControlled state to the `navigator.webdriver` result while allowing other automation overrides. This is why the docs say the flag affects the indicator rather than promising that it always forces a particular value or defeats automation detection.

## 6. HTTP cache and retry semantics

### S16 — HTTP conditional requests

[RFC 9110: If-Modified-Since](https://httpwg.org/specs/rfc9110.html#field.if-modified-since)

[RFC 9110: 304 Not Modified](https://httpwg.org/specs/rfc9110.html#status.304)

These define the standard conditional-request behavior. The separate live evidence is that the tested ASM image actually returned `Last-Modified` and honored the condition with `304`. ETag-based revalidation remains an untested extension for this service sample.

### S17 — HTTP rate-limit responses

[RFC 6585: 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)

Defines `429` and permits `Retry-After` to indicate how long to wait. It does not specify Teams' quotas, how Teams counts requests, or whether a particular private endpoint always returns this status when throttled. No live throttling test was performed.

### S18 — Retry-After syntax and meaning

[RFC 9110: Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)

Defines a delay expressed as seconds or an HTTP date. This supports the future client's response handling; it is not evidence that the investigated Teams endpoints emit this header. Retry limits and concurrency settings remain client implementation decisions.

## 7. Provenance of local configuration and measurements

The following came from local/runtime inspection rather than public API documentation:

- The configured MCP command, argument array, forwarded environment-variable names, and referenced JSON launch options.
- Installed package versions from the resolved package manifests.
- The browser's runtime executable, version, launch arguments, profile path, and sandbox report.
- Successful Teams sign-in and page reload.
- Private endpoint paths and query/header names.
- Response key inventories, counts, date ranges, and equality/overlap checks.
- The JPEG byte count/signature and cache-validation status.

The original browser launch combined Fedora wrapper arguments, Playwright defaults, MCP additions, and explicit user settings. A generic source file cannot, by itself, establish the complete effective command line on another machine.

## 8. Reference-update policy

For future changes, record new evidence before changing a verified statement. Keep current implementation decisions distinguishable from historical observations. If an upstream source moves or a private endpoint changes, retain the dated observation and document the replacement behavior rather than rewriting the old result as though it never occurred.

No source link is permission to copy live credentials, private messages, or raw browser logs into this documentation set.

## 9. Application stack

These references support library behavior used in the architecture plan. They do not by themselves add live Teams evidence; the actual CLI compatibility check is recorded separately as E17.

### S19 — Bun TypeScript and testing

[Bun: TypeScript](https://bun.sh/docs/typescript)

[Bun: Test runner](https://bun.sh/docs/test)

Documents direct TypeScript execution, development types, separate type checking, and the built-in test runner. Select tooling supported by the runtime version chosen for the CLI rather than assuming every feature of current online documentation exists locally.

### S20 — CAC commands and asynchronous dispatch

[CAC README](https://github.com/cacjs/cac/blob/main/README.md)

Documents command/flag parsing and explicitly awaited asynchronous action dispatch. The documented parsed options allow `any` values; TypeScript implementation of the parser does not itself produce a validated application options type.

### S21 — Zod parsing, inference, and object behavior

[Zod: Basic usage](https://zod.dev/basics)

[Zod: Object schemas](https://zod.dev/api?id=objects)

Documents runtime parsing, `z.infer`, default removal of unrecognized object keys, and `z.looseObject()` for preserving additional keys. Preserve source fields deliberately at each relevant nested boundary.

### S22 — Ky request policy and validation

[Ky v2.2.0 README](https://github.com/sindresorhus/ky/blob/v2.2.0/readme.md)

[Ky v2.2.0 release](https://github.com/sindresorhus/ky/releases/tag/v2.2.0)

[Ky v2.2.0 implementation](https://github.com/sindresorhus/ky/blob/v2.2.0/source/core/Ky.ts)

The reviewed release documents Bun support, configurable retries/timeouts, custom Fetch instrumentation, Standard Schema response validation, and HTTP error handling. Its `beforeRequest` hook runs once before retry handling, and `maxRetryAfter` can clamp a server-indicated delay. These details motivate explicit request accounting and retry policy. The implementation uses the Ky ^2.2.0 range with an exact resolution in `bun.lock`; E17 records its first ordinary Bun/Teams compatibility check.
