# Validation plan and open questions

Research date: **2026-11-04**. This file separates already completed investigation checks from tests that a future implementation still needs.

A Bun CLI, pinned package configuration, and synthetic test suite now implement the first bounded-history slice. Use `bun run typecheck` and `bun run test` for current results. This document also retains checks for later features; inclusion in a table does not mean a media/login feature or its test already exists.

## 1. Completed investigation checks

| Area | Completed evidence | Reference |
| --- | --- | --- |
| Interactive login | User signed in in visible Chromium; Teams Chat loaded | E01 |
| Page-session reuse | Reload restored the open chat without another interactive sign-in | E01 |
| Virtualized history | Mounted messages changed while older history loaded; cached history often needed no fresh request | E02 |
| History schema | Fresh response had 200 messages and expected top-level metadata | E03, E07 |
| Cookie-only negative control | Page-side history read without explicit service authentication returned `401` | E04 |
| Plain HTTP history | Group and one-to-one each returned two 200-record pages with no overlap | E05–E06 |
| HTTP directory | `x-skypetoken` alone returned 15 records; partial/more flags false for this account | E08 |
| Direct-message labels | Eight one-to-one title fields were empty; users array empty | E08 |
| HTTP image | Media cookie authorized a valid 69,257-byte JPEG | E09 |
| Conditional media validation | `If-Modified-Since` returned `304` | E10 |
| Array ordering | Latest history array was not monotonic by arrival time | E11 |
| No-cursor historical seeking | Group August window returned the target period directly | E12 |
| Pagination defect | Unchanged historical backward link jumped to current messages | E13 |
| Pagination correction | Preserving end bound fixed the next page, including through the observed same-origin route | E13 |
| Larger bounded exhaustion | Six pages, 1,021 distinct group messages, no out-of-window arrivals, no final backward link | E14 |
| Query consistency | Narrow 65-message result equaled the same subset of larger-window retrieval | E12, E14 |
| One-to-one historical seeking | October window returned 186 messages directly | E15 |
| Exact timestamp boundaries | Start and end both included the reference message at exact millisecond equality | E16 |
| Short-term first-page repeat | Repeated group first-page query returned the same 200 IDs | E13 |
| First standalone Bun CLI | Listed 15 chats and exported 5 messages from a seven-day window, one request each, no retries | E17 |

See the complete [evidence ledger](01-findings-and-evidence.md) for timestamps, counts, controls, and limitations.

## 2. Scope of confidence

The completed checks support a small HTTP exporter for the authenticated user's accessible history and sampled images. They do not establish:

- Microsoft-supported stability of private endpoints.
- Automatic authentication renewal or an indefinitely valid saved session.
- A cold-start standalone process with the browser fully shut down.
- A complete friendly-name chat picker.
- Every image-reference shape or original-upload fidelity.
- Every historical message, retention state, revision, or deletion.
- A consistent snapshot while the conversation changes.
- Universal pagination behavior for every account, region, chat type, or window.

Further work should be driven by the selected product scope. It is unnecessary to reverse-engineer unrelated Teams write features before a read-only exporter can be implemented.

## 3. Gaps to resolve for the core workflow

### Q01 — Minimal reproducible directory request

**Known:** the complete observed query template is now recorded in the HTTP reference, and replay with `x-skypetoken` alone worked. Required versus optional query keys were not isolated.

**Implemented:** the standalone `chats` command uses this template; E17 returned 15 records with one request. Query minimization remains optional and is not a prerequisite. Partial directory flags are surfaced as a failure until continuation is supported.

**Do not assume:** the `/updates` endpoint can replace the initial listing, or that an empty update means no chats exist.

### Q02 — One-to-one participant labels

**Known:** the inspected one-to-one chats had empty titles, member identity references, and no populated user directory in the response.

**Needed:** identify and verify the profile lookup used for those members, identify the current user's own member, and define a reliable fallback label. Check external and personal identities if they are in the intended scope.

**Do not assume:** the last-message sender is the counterpart, names are unique, every member is visible, or an object ID and an MRI are interchangeable.

### Q03 — Message-to-image URL mapping

**Known:** messages expose media-related fields and browser-observed URLs can be downloaded via HTTP.

**Needed:** document sanitized examples of raw image references and how they produce the exact object namespace/host/view. Test multiple images in one message, repeated references, quoted images, and the simplest relevant HTML forms.

**Do not assume:** every `amsreferences` entry is a downloadable inline image, every HTML image is an account-owned upload, or one view name covers original-resolution requirements.

### Q04 — Credential acquisition and persistence

**Known:** manual login plus temporary observation yielded working header/cookie material. The CLI now validates and loads an explicit private credential JSON file; automatic acquisition and renewal are not implemented.

**Needed:** choose the login helper interface and profile ownership, capture the required credential set reproducibly, and investigate renewal. File input is the first revisable persistence choice; any later backend must preserve service separation and avoid exposing secrets.

**Do not assume:** extracting browser cookies alone captures the history token, or that copying a browser state file automatically makes application-generated headers available to an HTTP client.

### Q05 — Standalone execution

**Known:** ordinary server-side Fetch requests worked in the MCP process without browser-side execution. E17 additionally verified the actual Bun CLI's saved-file loading, directory read, and bounded single-page history export.

**Needed:** repeat with the browser/MCP closed, verify a live bounded history read with continuation in the CLI, and later verify cached/uncached media reads. The browser remained open during E17.

**Do not assume:** the earlier research snippets establish every CLI behavior, or that the single-page check proves browser-closed operation or live multi-page traversal.

### Q06 — Product semantics

The first slice uses explicit-offset timestamps, half-open windows, arrival-time filtering, one JSON document, and no overwrite. These are revisable implementation defaults, not additional planning gates. Image defaults and partial-media behavior remain later decisions. See the actual usage in the project README.

See [proposed CLI design](04-cli-design.md#12-decisions-still-to-make-before-final-cli-behavior).

## 4. Authentication and session questions

| Question | Current state | Useful next check |
| --- | --- | --- |
| How long is the history header accepted? | Unknown | Observe actual expiry or a documented expiry field without exposing the token |
| How long is directory authentication accepted? | Unknown | Test independently of history and distinguish service failure |
| How long is the media cookie accepted? | Unknown | Retest after expiry/renewal without assuming synchronized lifetimes |
| Does Teams renew from an existing profile without prompting? | Unknown | Reopen the selected profile after relevant expiry and observe normal app renewal |
| Can renewal be done through HTTP alone? | Unknown | Inspect the actual renewal flow before choosing a dependency |
| Does the profile survive a full restart usefully? | Persistent path observed; full acceptance test not done | Close/restart and verify service credentials, not just a page title |
| Does closing the browser invalidate an already captured access credential? | Not directly tested | Standalone cold-start check |
| What should logout revoke/remove? | Not designed | Define local credential deletion versus browser-profile deletion versus remote revocation |
| Can official CLI attach to this MCP session? | Not tested | Only investigate if choosing that login interface; not needed for HTTP export |

Do not make the user wait for every service's natural expiry before implementing a basic explicit-login workflow. Handle an authentication failure honestly and add renewal once its behavior is understood.

## 5. Directory coverage questions

- What continuation or additional request is required when `hasMoreChats` or `isPartialData` is true?
- Are hidden chats, meeting chats, self-chat/notes, SMS/live-chat entries, migrated conversations, or deleted records part of the intended listing?
- How should blocked, disabled, membership-restricted, or external chats appear?
- Can a chat title change between listing and export, and should the export record both selection label and current label?
- What request resolves member display names, and how should lookup failures affect selection?

The 15-record test had no partial-data flags, so it did not exercise these cases. Do not silently claim all-account enumeration until the relevant continuation is understood.

## 6. History and pagination questions

### 6.1 State and mutation

- How long is `syncState` usable?
- Does it remain valid across process restarts, credential renewal, or changes to query bounds?
- What happens when messages are created, edited, or deleted between pages?
- Can a page repeat a message ID with a different version?
- Does a cursor describe a stable snapshot, a mutable feed, or some service-specific segment state?

The short-term repeat check is not an answer to these lifecycle questions. Do not decode or forge opaque state to avoid testing normal behavior.

### 6.2 Ordering and timestamps

- Why was the response array not monotonic by arrival time?
- Are there messages whose compose time and original arrival time fall on different sides of the user's desired boundary?
- Does the service always filter by the same timestamp for system events, edits, and migrated messages?
- How are malformed, absent, or higher-precision timestamps represented?

Retain source timestamps and use local filtering as a correctness guard. Do not claim that array position or a single segment field is a complete ordering specification.

### 6.3 Window and pagination coverage

- Multi-page bounded traversal has been completed for one group; repeat it for a sufficiently busy one-to-one chat when practical.
- Smaller page sizes, server maximum page size, very large ranges, and a range with exactly 200 records were not characterized.
- An empty page with a nonempty next link was not observed; traversal logic should handle or report non-progress deliberately.
- Identical adjacent windows should not duplicate boundary messages under the chosen CLI semantics.
- Completion flags are not an independent archive oracle for messages that the service has already deleted, expired, or made inaccessible.

## 7. Message semantics questions

| Feature | What was observed | What remains to validate |
| --- | --- | --- |
| Plain text | `Text` messages | Escaping, whitespace, empty content |
| Rich text | `RichText/Html` and actual HTML | Safe rendering, links, code blocks, tables, nested formatting |
| Edits | Version/edit-related fields | Latest revision rules, historical revision availability |
| Deletions | Not characterized | Tombstones, removed content, repeat-export policy |
| Reactions | `emotions` and `deltaEmotions` keys | Value schemas and aggregation semantics |
| Mentions | `mentions` key | Identity mapping and display text preservation |
| Quotes/replies | `qtdMsgs` and related content possibilities | Parent references, unavailable quoted messages, image references inside quotes |
| Membership events | AddMember and DeleteMember message types | A complete type model and readable rendering |
| Cards and files | Keys observed | Payload structure and export policy |
| Pinned content | Metadata/links observed | Whether additional reads are needed or in scope |

Do not flatten everything into text and later assume lost metadata can be reconstructed. Preserve raw useful fields while the supported renderer handles a deliberately small set of semantics.

## 8. Media and cache questions

- Are media object IDs immutable and stable enough for a permanent cache key?
- What version information, if any, distinguishes replacement content under the same object/view?
- Which views are thumbnails versus full/original representations?
- How are PNGs, GIFs, animated content, stickers, video messages, audio, and ordinary files represented?
- Are other ASM regions/hosts needed for this account or other supported accounts?
- What happens when media is deleted or access is lost after text export?
- Which media responses supply Last-Modified or ETag validators, and which honor conditional reads?
- How should interrupted downloads, missing cache files, concurrent exports, and cache eviction be handled?
- What output layout keeps an export portable without another network request?

The tested image is sufficient evidence to start a focused inline-image implementation, not a universal attachment downloader.

## 9. Regression checks for future implementation

These are behavior checks for the implementation. The existing synthetic suite covers the initial HTTP/history slice; media, rendering, and durable persistence checks remain future work. Use synthetic/sanitized data where live access is unnecessary.

### 9.1 Request construction and dates

| Check | Failure it should catch |
| --- | --- |
| Historical first request has both resolved bounds and no cursor | Accidentally requiring a latest-history traversal |
| Continuation link lacks `endTime`, but actual next request retains original bounds | The observed jump-back-to-current-history regression |
| Original end time does not change on retry or later pages | Moving export scope |
| IDs with reserved path characters are encoded exactly once | Incorrect path or different chat selection |
| Exact start/end timestamps obey chosen CLI semantics | Inclusive/exclusive off-by-one errors |
| Two adjacent half-open windows assign a boundary message once | Duplicate boundary output |
| A page is deliberately out of order | Incorrect early stopping or output ordering |
| A future/empty valid window is a successful empty result | Treating no messages as a transport error |
| A `401`, HTML error page, or malformed JSON is not an empty result | Silent incomplete export |

### 9.2 Pagination and persistence

| Check | Failure it should catch |
| --- | --- |
| Several pages, including a short final page, combine correctly | Truncated exports |
| A short page with a continuation is handled deliberately | Assuming count is the terminal condition |
| A repeated cursor or non-progress response is detected | Infinite loops |
| A repeated ID is handled with a defined version policy | Duplicate or stale output |
| Wrong-host/chat continuation is rejected before credentials are sent | Unintended credential forwarding or mixed conversation output |
| A failed later page retains a truthful interrupted status | Reporting partial data as complete |
| A checkpoint cannot advance past unsaved page content | Message loss after a crash |

### 9.3 Media cache

| Check | Failure it should catch |
| --- | --- |
| Repeat/overlapping export reuses a complete image without fetching it | Re-downloading every image |
| Same object with different view/version does not alias incorrectly | Thumbnail/full-image or stale-content confusion |
| Missing or partial cached body is not a hit | Broken image output |
| Interrupted download never becomes complete | Poisoned cache |
| `304` reuses valid local bytes | Unnecessary body transfer |
| `304` without a local body triggers correct recovery | False cache success |
| `200` refresh validates before replacing cached bytes | Replacing a valid image with an error body |
| Media authentication failure is distinct from history failure | Misleading login status |
| Export references resolve with network disabled | An archive that depends on expiring remote links |

### 9.4 Labels and rendering

- Empty one-to-one titles have truthful fallbacks.
- Duplicate chat titles do not change identity-based selection.
- The current user's last message does not become the counterpart's label.
- Raw message HTML is preserved separately from safe readable rendering, if HTML output is implemented.
- Credentials, raw cookies, authenticated URLs, and private cursors do not appear in public-facing logs or export manifests.

These checks should verify behavior and observed failure modes, not merely duplicate the implementation's internal steps.

### 9.5 Request efficiency, accounting, and throttling

These checks implement the user-approved requirements in [CLI design sections 6.1–6.3](04-cli-design.md#61-agreed-request-saving-behavior). Use synthetic/sanitized responses and a controlled clock where necessary. Do not generate live traffic to find Teams' rate limits or automation thresholds.

| Check | Failure it should catch |
| --- | --- |
| A supplied chat ID reaches history without an incidental directory lookup | Spending a directory request merely to resolve an already supplied ID |
| The first request seeks the chosen window and uses the tested page size of 200 | Fetching intervening history or unnecessarily shrinking pages |
| Continuation requests are sequential and retain fixed bounds | Parallel cursor misuse or scope changes during retrieval |
| A repeated/overlapping export re-fetches requested text but makes zero requests for complete cached images | Confusing image caching with message-range caching or silently revalidating every image |
| Repeated references to one uncached logical media key cause one download | Duplicate media requests within one export |
| Concurrent image downloads never exceed the chosen small bound | Unbounded media request bursts |
| Explicit refresh counts a conditional media request even when it returns `304` | Reporting a body-free response as zero API calls |
| Counters include failed attempts and retries once, with retry count identified as a subset | Under-counting failures or double-counting retries in the total |
| Cache hits count distinct reused media keys and issue no HTTP request | Inflated cache-hit counts or hidden validation requests |
| Interrupted exports report partial counts and truthful completion status | Losing useful diagnostics or reporting incomplete work as success |
| A synthetic `429` with delay-seconds or HTTP-date `Retry-After` delays the next attempt accordingly | Ignoring server retry guidance or parsing only one valid header form |
| Missing retry guidance uses bounded backoff and a finite attempt limit; cancellation prevents further attempts | Retry storms, endless waits, or ignored cancellation |
| An unchanged authentication rejection or interaction requirement does not trigger repeated transient retries | Repeated requests that cannot recover without new credentials or user action |
| Request summaries exclude secrets and distinguish HTTP-client counts from browser login traffic | Credential exposure or a misleading claim to count all account traffic |

No specific retry count, concurrency value, or requests-per-second threshold has been verified for Teams. Choose explicit client limits during implementation and test that they are enforced; do not describe those settings as a known safe service quota.

## 10. Suggested implementation sequence

1. Use the implemented defaults in the [architecture plan](07-architecture.md); revisit input/output choices when a concrete requirement warrants it rather than treating them as planning gates.
2. Resolve minimal directory request details, participant labels, and basic raw-message image-reference mapping.
3. Implement and validate an HTTP-only bounded text export with explicit supplied credential state, request counters, and bounded retry handling.
4. Add the persistent image cache and a small tested set of image representations, checking that cache hits make no network requests and media concurrency stays bounded.
5. Add the optional interactive login helper and demonstrate a cold-start export without a running browser.
6. Expand rendering, media coverage, renewal, or checkpointing only as the selected scope requires.

An ID-based first milestone can precede complete friendly-name resolution if the user accepts that scope. Likewise, explicit re-login can precede automatic renewal. Do not present either compromise as already approved.

## 11. Documentation and fixture maintenance

For each new live discovery:

1. Record the date, account type, operation, input shape, status, and sanitized outcome.
2. State the negative control or comparison when one was used.
3. Add a stable evidence reference and update the relevant protocol/design section.
4. Preserve uncertainty rather than extrapolating from one example to all accounts.
5. Sanitize identifiers, message bodies, credential values, authenticated URLs, and cursors before creating fixtures.

Existing `.playwright-mcp/` snapshots/logs are not safe fixture material by default. Do not commit or publish them just to preserve research evidence. Their existence was left unchanged by this documentation task.
