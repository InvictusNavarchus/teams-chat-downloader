# Authentication, sessions, and the browser

Research date: **2026-11-04**. This document records the working investigation setup and the boundary between browser login and ordinary HTTP export. It does not implement a credential manager or prescribe global settings for other machines.

See the [HTTP reference](02-http-protocol.md#1-endpoint-and-credential-map) for endpoint-specific credential requirements and [validation](05-validation-and-open-questions.md) for renewal checks.

## 1. Current architecture conclusion

**Verified:** ordinary HTTP requests can read the tested history, directory, and image resources using captured credentials. The page does not need to perform those downloads, and the exporter need not click chats or scroll history.

**Proposed architecture:**

~~~text
Interactive user login
        |
        v
Optional Playwright login/session helper
        |
        v
Service-specific credential state
        |
        +--> HTTP directory requests
        +--> HTTP date-bounded history requests
        +--> HTTP media requests and local cache
~~~

The normal exporter should not require a running browser, Playwright MCP connection, Playwright CLI daemon, or AI agent when valid credentials are already available.

The successful experiments were hosted by MCP for convenience. They used server-side global `fetch()` and explicitly supplied the needed credential; this differs from browser-side `page.evaluate(() => fetch(...))` or a Playwright API request context sharing browser cookies.

**Unknown:** the complete cold-start behavior of a future standalone Bun process. The HTTP exchange has been proven, but no packaged application or credential loading path exists yet.

## 2. Three distinct authentication surfaces

| Surface | Captured material that worked | What remains unknown |
| --- | --- | --- |
| History service | Complete `Authentication` request-header value | Lifetime, precise format, independent renewal, value equivalence with other credentials |
| Chat directory | `x-skypetoken` request-header value | Lifetime, refresh, minimal directory query parameters, name-lookup credentials |
| Image service | Matching `skypetoken_asm` cookie | Lifetime, renewal, host/region coverage, alternative authorization mechanisms |

Do not model this as one undifferentiated browser cookie blob. Conversely, do not assume the three values represent unrelated underlying identities: their relationship was not tested.

An HTTP header's value must be preserved as captured. For history, changing the header name to `Authorization` or inserting a guessed `Bearer` prefix would not reproduce the verified request.

The authentication and media cookies are session credentials. They are not the user's password. The user did not provide a password or verification code to the agent, and the investigation did not intentionally store either one.

## 3. How credentials were acquired in the experiments

### 3.1 Manual sign-in

1. Open `https://teams.live.com/` in the configured visible Chromium browser.
2. Teams may redirect to a public landing page at `/gather`.
3. Use its Sign in action, which navigated through `/v2/` to Microsoft's `login.live.com` authentication flow.
4. The user enters credentials and completes verification directly in that browser.
5. Confirm that Teams' Chat interface is available rather than assuming any `teams.live.com` page means authentication succeeded.

No programmatic handling of passwords, verification codes, or MFA was implemented.

### 3.2 History credential capture

The experiments temporarily observed successful GET responses under `/api/chatsvc/consumer/`. Opening the sample group produced a successful read such as `threads/{id}/consumptionhorizons`.

From that read's request headers, the experiment retained only the complete `authentication` value for the minimal history tests. It did not need a fresh history fetch specifically, because this same captured service header successfully authorized the history endpoint.

The diagnostic source request is not a proposed export feature. Do not build read-state management or consumption-horizon mutation into the tool.

### 3.3 Directory credential capture

The browser was observed requesting `/api/csa/api/v3/teams/users/me/updates` after a reload. Its request supplied `x-skypetoken` and other cookie/sync context.

Replaying the initial directory route without the `/updates` suffix worked, first with captured cookie/token-related headers and then with `x-skypetoken` alone. The replay retained the source query values. An empty update response is not evidence of an empty initial directory.

### 3.4 Image credential capture

The browser displayed image resources at the observed ASM host. The image response request headers returned by inspection did not contain the cookie needed for successful standalone fetching.

The experiment queried browser-context cookies for the **exact image URL**, kept the matching cookie in memory, and supplied it in a server-side request. The successful cookie was `skypetoken_asm`.

This is why request-header capture alone is not yet a complete login helper for every operation.

### 3.5 Cleanup and persistence limits

Temporary event listeners and explicit capture-object credential references were removed after each experiment. The originally open chat was restored.

This was not a logout, a credential revocation operation, or a browser-profile deletion. The profile still contains normal session state. The investigation did not claim secure memory erasure.

No reusable capture helper, credential persistence backend, expiry parser, logout command, or refresh operation was implemented.

## 4. What session persistence does and does not mean

A persistent browser profile keeps browser state on disk across launches. It can contain cookies and application storage used by the app's authentication logic. It does not make service credentials permanent.

**Verified:** the current Teams page could reload and restore its chat without an interactive sign-in prompt.

**Not verified:** sign-in survival across a full host/browser restart; maximum idle duration; service-token lifetime; refresh after expiry; simultaneous expiry of chat and media credentials; or recovery after Microsoft explicitly requires authentication again.

Keep these concepts separate:

| Concept | Meaning |
| --- | --- |
| Browser profile | Chromium user data and site state |
| Captured HTTP credential state | The explicit headers/cookies a standalone downloader will need |
| Access credential validity | Whether a particular service accepts a credential at this moment |
| Interactive authentication | A user-facing Microsoft sign-in or verification step |
| Renewal | Obtaining a new usable service credential, potentially without another interactive login |

Expiry does not necessarily mean the user must enter a password again. Teams may be able to renew from browser state. That mechanism has not been characterized, so neither seamless refresh nor mandatory manual login should be promised yet.

## 5. Proposed login-helper responsibilities

This is a future design, not current behavior:

1. Launch or attach to an explicitly selected browser/profile with the known working platform settings.
2. Let the user complete Microsoft's normal login flow if needed.
3. Observe the small set of service requests necessary to obtain directory and history credentials.
4. Obtain the matching media cookie without dumping the entire cookie jar into logs.
5. Validate each credential against an appropriate read operation.
6. Save only the credential state needed by the selected persistence design.
7. Remove listeners and close/detach cleanly without unintentionally deleting session data.

Credential storage location, protection backend, schema, rotation, and logout semantics remain decisions. Do not silently implement a plaintext credential file, system keyring dependency, or global profile migration based on this proposal.

An export should identify which service needs renewed authentication. A valid history token does not establish that image download authentication is also valid.

## 6. Working machine and package snapshot

The following values describe the investigation environment, not supported-platform promises:

| Component | Observed value |
| --- | --- |
| OS/session | Fedora KDE 44, Wayland |
| Shell | Bash |
| User timezone | Asia/Jakarta |
| Browser executable | `/usr/bin/chromium-browser` |
| Chromium version observed during browser audit | `156.0.8078.79`, Fedora build |
| MCP launch command | `bunx` |
| MCP package resolved locally | `@playwright/mcp` `0.0.84` |
| Playwright package resolved locally | `1.65.0-alpha-2026-10-30` |
| Playwright core package resolved locally | `1.65.0-alpha-2026-10-30` |
| Package selector in actual MCP config | `@playwright/mcp@latest` |

The config and installed package manifests were re-read during the documentation pass. The exact Chromium version above comes from the earlier live audit; it was not a new browser-version probe during this documentation task.

`@latest` is not pinned. A version pin was discussed during troubleshooting but was not applied in the inspected configuration. The fact that an MCP release resolves an alpha Playwright dependency should be recorded for reproduction, not quietly described as a fully pinned stable toolchain.

## 7. Current browser configuration

### 7.1 MCP host configuration

The relevant portion of `~/.codex/config.toml` was:

~~~toml
[mcp_servers.playwright]
command = "bunx"
args = [
  "@playwright/mcp@latest",
  "--config",
  "/home/invictus/.codex/playwright-wayland.json",
]
env_vars = ["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]
~~~

This is the actual machine-specific path recorded during the investigation. It is not a portable example with shell expansion. Do not assume `~` or an environment-variable reference inside an arbitrary JSON/TOML string will be expanded by the receiving application.

Only the Playwright-related keys were inspected for documentation. Other MCP entries and unrelated secrets were not copied.

### 7.2 Browser JSON

The referenced `~/.codex/playwright-wayland.json` contained:

~~~json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": {
      "executablePath": "/usr/bin/chromium-browser",
      "headless": false,
      "chromiumSandbox": true,
      "args": ["--ozone-platform=wayland"]
    }
  }
}
~~~

There was no explicit `userDataDir`, `isolated`, `channel`, or `ignoreDefaultArgs` entry in the inspected JSON.

Using a separate JSON file made nested launch options, boolean settings, and browser argument arrays explicit. It avoided passing several layers of shell/MCP/browser quoting through command-line options. A JSON file is not the only theoretically possible configuration mechanism, nor does its use imply that the tool requires a nested `--args` command.

### 7.3 Profile location and scope

`chrome://version/` reported:

~~~text
Profile path:
~/.cache/ms-playwright-mcp/mcp-chromium-0371635/Default

Corresponding user data directory:
~/.cache/ms-playwright-mcp/mcp-chromium-0371635
~~~

`Default` is the browser profile subdirectory, not the whole Chromium user data directory. Do not pass the `Default` path as `userDataDir` without understanding that distinction.

The default MCP profile location is workspace-derived. The exact cache path reported at runtime differed from a generalized README path; use the runtime observation for this session and do not hard-code this hash as a universal default.

An earlier suggestion used a Teams-specific fixed profile path in a global MCP configuration. The user correctly rejected that scope coupling. The current config keeps global browser/platform settings and leaves the profile selection at the MCP default. A future dedicated Teams login profile can be chosen explicitly by the project/tool without turning the global MCP browser into a Teams-only setup.

Profile migration and sharing with another launcher have not been tested. Do not launch two independent browser processes against the same profile directory concurrently. Attaching to an existing browser and reopening its profile in another process are different operations.

## 8. Troubleshooting history and lessons

### 8.1 Browser executable selection

The initial MCP browser launch expected Chrome at `/opt/google/chrome/chrome`, which was absent. The machine had Fedora Chromium at `/usr/bin/chromium-browser`, a wrapper for the distro browser installation.

Explicit `executablePath` selected the installed browser. Installing another browser was not required to solve this particular problem.

Using a distribution browser is a compatibility tradeoff; it is not evidence that every Fedora Chromium update will match every Playwright package. Browser/package versions should be recorded when diagnosing future regressions.

### 8.2 Config reload versus stale process

Editing MCP configuration did not necessarily change an already-running server process. Host restarts were needed during troubleshooting so that the MCP server relaunched with the new configuration.

A browser tab list can lazily launch the browser. Conversely, a blank Chromium window can be a successful headed launch before navigation; it does not by itself establish login or Teams readiness.

### 8.3 Headless and visible modes

An early launch was headless despite an expectation of a visible window. The Linux process environment and launch defaults mattered; `headless: false` made the intended mode explicit.

Modern headless Chromium still renders pages. The difference is not that HTML/CSS/layout cease to exist. For this single interactive-login workload, a visible browser provides direct feedback and verification handling, with no measured performance reason to prefer headless.

Once downloads use plain HTTP, their browser-rendering mode is irrelevant: the browser need not be running for those requests. Headless login/renewal remains a separate optional workflow, not a requirement for a faster exporter.

### 8.4 X11/XWayland failure and native Wayland

An attempted visible X11 launch encountered authorization/display problems. The desktop had Wayland session variables, a `wayland-1` display, and a session-specific X authority file.

The successful native Wayland configuration forwarded `WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR` from the host environment and supplied `--ozone-platform=wayland`.

Do not copy a transient X authority filename into a permanent configuration. Native Wayland avoided that X11 authorization path in this environment.

Native Wayland may improve desktop integration and scaling behavior, but no export-speed, memory, CPU, battery, or login-stability improvement was measured. It was selected because it worked with the actual desktop session, not because Wayland is a prerequisite for HTTP extraction.

### 8.5 Security sandbox warning

The browser initially launched with `--no-sandbox`, producing a warning. Playwright's Chromium sandbox option defaults to false at the library level; MCP's effective choice also depends on platform/channel configuration.

Setting `chromiumSandbox: true` removed the no-sandbox launch condition in this environment. `chrome://sandbox/` reported adequate sandboxing with namespace and seccomp mechanisms active. Yama-related rows displayed No, but the page still reported adequate sandboxing; no unrelated Yama change was proposed.

This was a meaningful change to the browser's security posture, not just cosmetic suppression of an infobar.

### 8.6 AutomationControlled warning

After the sandbox issue was resolved, Chromium exposed a warning for:

~~~text
--disable-blink-features=AutomationControlled
~~~

Inspection of MCP source showed that it adds this Chromium argument when no existing `--disable-blink-features` argument is present. The feature affects the browser automation indicator used by `navigator.webdriver`; the exact effective value can also depend on other automation overrides.

Chromium's warning implementation flags the general `--disable-blink-features` switch and returns after displaying the first matching bad-flag warning. This explained why warnings appeared sequentially as earlier ones were removed.

Removing the argument with `ignoreDefaultArgs` was successfully tested in a separate temporary browser, but no Teams compatibility benefit was established. The recommendation to suppress it was withdrawn. **The current decision is to keep the intentional MCP default and not add an override just to hide the warning.**

No evidence established that this argument is necessary for Teams, that it reliably prevents automation detection, or that the warning blocks sign-in. Manual Teams sign-in later succeeded with the working setup.

### 8.7 Argument sources

The full browser launch combined Fedora wrapper defaults, Playwright launch defaults, MCP-added options, and the explicit Wayland argument. Do not attribute every runtime flag to the user's JSON or remove whole default-argument sets as a blanket fix.

A custom temporary browser launch, navigation, click, and screenshot worked during the flag audit. That limited test did not establish that removing all automation defaults would be safe for Teams.

### 8.8 TOML formatting trap

A multiline inline-table suggestion was incompatible with the parser used during troubleshooting. The configuration was corrected. The working example above uses a regular argument array and a simple `env_vars` list.

If additional environment overrides are needed later, use syntax accepted by the host's actual TOML parser; do not rely on assumptions about newer TOML variants. No additional environment overrides are currently required by the verified native Wayland setup.

## 9. Diagnostic methods and their limits

| Method | Useful result or limitation |
| --- | --- |
| Temporary `chrome://version/` tab | Exposed actual command line, version, and profile path; diagnostic tab was then closed |
| Temporary `chrome://sandbox/` tab | Confirmed effective security sandbox status |
| CDP `Browser.getBrowserCommandLine` | Failed when `--enable-automation` was absent; not the preferred probe here |
| CDP `Browser.getVersion` | Returned browser/version details during inspection |
| CDP browser-window query | Failed without a target; not evidence that the visible browser failed |
| Page `performance` entries | Partial view of relevant traffic; did not establish complete history transport |
| Page/context response listeners | Captured fresh service responses; cached data may have loaded before attachment |
| MCP numbered request log | Revealed earlier history requests and query patterns |
| MCP response-body retrieval for older recorded requests | Returned empty text in attempted reads; did not prove the server's response body was empty |
| Browser worker/service-worker inspection | Confirmed their presence, but no complete transport model was derived from it |
| Server-side global `fetch()` | Available in the MCP snippet environment and successfully replayed ordinary HTTP operations |
| Direct server-side copying of HTTP/2 request headers | Initially failed because names such as `:authority` are not valid Fetch header names; pseudoheaders must not be copied |
| Browser-side `fetch` response handling | Uses the numeric `response.status` property; Playwright response objects instead have a `status()` method |
| A unique-looking role locator | Later matched two Chat buttons; scope locators or inspect cardinality rather than assuming uniqueness forever |

A diagnostic attempt to insert content into a Chromium internal page hit TrustedHTML restrictions. A temporary data-URL page was used instead. This did not establish a Teams problem or justify weakening browser security settings.

The shell environment could not inspect the desktop session as though it were the MCP browser process; process/socket restrictions limited some local probes. The runtime browser pages were the more reliable evidence for the effective launch.

## 10. MCP, official CLI, and library choices

| Component | What it provides | Role in this project |
| --- | --- | --- |
| Playwright library | Browser control and network inspection APIs; also a separate HTTP request API | Possible implementation dependency for the optional login helper |
| Playwright MCP | Structured tool interface for an agent to control/inspect a browser | Used for investigation; not required for normal exports |
| Official `playwright-cli` | Shell commands, daemon sessions, snapshots, network inspection, and custom Playwright snippets | Possible alternative interactive login/investigation interface; not required for normal exports |
| Future `teams` CLI | Product-specific listing, selection, period export, caching, and failure reporting | Not implemented; command name is illustrative |

The official CLI's lower agent-context overhead does not establish faster HTTP downloads or solve Teams authentication/pagination automatically.

Current CLI documentation describes in-memory default profiles and explicit `--persistent`/`--profile` modes. It supports attaching by a bound name, Playwright endpoint, CDP, or extension. An existing MCP browser is **not automatically proven attachable** just because those features exist.

The official CLI was not installed, attached, or used to migrate the live session during this investigation. Do not introduce that migration as a prerequisite for implementing the downloader.

See [sources](06-sources.md) for the relevant official Playwright, Chromium, and MCP references.
