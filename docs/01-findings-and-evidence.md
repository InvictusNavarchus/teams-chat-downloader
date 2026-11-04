# Findings and evidence

Recorded on **2026-11-04**, in timezone **Asia/Jakarta**. All message time ranges in this document are expressed in **UTC** unless stated otherwise.

This document records what was tested, what was inferred, and what earlier assumptions were corrected. Request details are in the [HTTP reference](02-http-protocol.md). Outstanding work is in [validation and open questions](05-validation-and-open-questions.md).

## 1. Scope and evidence limits

### Account and access

- The account is a personal Microsoft account using Teams Free.
- The browser application was `https://teams.live.com/v2/`.
- The user signed in manually through Microsoft's login page and completed verification directly in the visible browser.
- The investigation covered accessible one-to-one and group chat history. Meeting-chat entries were visible in discovery, but their export behavior was not separately established.
- No messages were deliberately sent, edited, deleted, or reacted to by the investigation. Opening chats and reloading Teams can still trigger the application's normal presence or read-state activity; no claim is made that browser navigation causes zero server-side state changes.

### How the HTTP evidence was obtained

Playwright MCP hosted diagnostic snippets. Those snippets observed successful Teams requests and then executed **server-side global `fetch()`**, outside `page.evaluate()` and outside the page's browser network stack.

The successful history and listing tests explicitly supplied a credential header, without browser cookies. The successful image test explicitly supplied a selected media cookie. No browser cookie jar was implicitly available to server-side `fetch()`.

This proves that the tested HTTP operations do not need browser page execution. A separate Bun executable was not built or run, and the browser was not shut down to perform a cold-start exporter test. Portability to Bun follows from the ordinary HTTP exchange; a standalone implementation remains to be verified.

### Handling of private data

- Credential values and raw private response bodies were not printed into the user-facing investigation results.
- Temporary captures held credentials in the MCP server's memory. Listeners and explicit temporary credential references were removed after the experiments.
- No standalone credential file or image file was intentionally created by these experiments.
- The existing persistent browser profile continues to contain its normal authenticated browser state. Clearing temporary capture objects did not log the browser out or erase that profile.
- There is no claim of secure memory erasure or elimination of all browser/MCP diagnostic artifacts.

### Evidence status

| Label | Meaning |
| --- | --- |
| Verified | Observed in a live test or direct local inspection |
| Documented | Supported by linked primary upstream documentation or source |
| Proposed | A recommendation for the future tool |
| Unknown | Not verified; must not be implemented as an assumed contract |

## 2. Discovery ledger

The identifiers below are local references for these documents, not Microsoft request IDs. Samples are called **G1** for the principal group chat and **D1** for the principal one-to-one chat; their actual identities are intentionally omitted.

### E01 — Login and current profile

**Verified:** Teams loaded its Chat interface after manual login. A page reload restored the open chat without another interactive login.

`chrome://version/` reported the profile directory:

~~~text
~/.cache/ms-playwright-mcp/mcp-chromium-0371635/Default
~~~

A full browser/host shutdown and restart was not used as a persistence acceptance test. The profile is persistent by configuration and location; that is different from proving indefinite session validity.

### E02 — DOM behavior and local caching

**Verified:** history was rendered in a virtualized list. In G1, the initially observed message wrappers increased from 27 to 47 after loading older content. Later backward scrolling kept roughly 170–180 wrappers rendered while their contents changed.

Much of this history came from existing local state before another history request was observed. A collector attached only after login or after scrolling started could miss already-cached message payloads.

**Consequence:** a final DOM snapshot is not a complete archive. Server-side history requests avoid depending on what is currently mounted or already cached in the page.

### E03 — History endpoint and payload

**Verified:** both chat types used:

~~~text
GET https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/{encoded-chat-id}/messages
~~~

Observed query parameters included `view`, `pageSize`, `startTime`, and, on continued history requests, `syncState`.

A fresh G1 response contained 200 messages and the top-level keys `messages`, `tenantId`, and `_metadata`. See the field inventory in the [HTTP reference](02-http-protocol.md#3-history-response).

### E04 — Cookie-only history request

**Verified:** a page-side `fetch()` with browser credentials included, but without the application's explicit history authentication header, returned HTTP `401`.

**Interpretation:** cookies alone did not authorize that request. This did not prove that a browser was required for downloading history.

### E05 — Server-side credential replay

**Verified:** a successful read request for chat consumption horizons was observed. A server-side replay using the captured headers returned HTTP `200`. This was an authentication probe, not the history export endpoint.

The useful history credential was then reduced to the captured `authentication` header value alone. Its value was reused as observed; its format was not rewritten or decoded.

### E06 — Plain HTTP history and ordinary pagination

**Verified:** server-side `fetch()` with only `authentication` returned:

| Chat | First page | Next page | Combined unique IDs | Overlap |
| --- | ---: | ---: | ---: | ---: |
| G1 | 200 | 200 | 400 | 0 |
| D1 | 200 | 200 | 400 | 0 |

All four requests returned HTTP `200`. No cookies or browser-specific headers were explicitly supplied.

The G1 next page used the server-provided link at `msgapi.teams.live.com` without changing it. This unbounded test worked. **Do not generalize it to date-bounded requests:** E13 records a counterexample.

### E07 — Sample message diversity

**Verified:** one 200-message G1 batch contained:

| `messagetype` | Count |
| --- | ---: |
| `RichText/Html` | 190 |
| `Text` | 8 |
| `ThreadActivity/AddMember` | 1 |
| `ThreadActivity/DeleteMember` | 1 |

In that same batch:

- All 200 IDs were unique within the batch.
- 29 messages had nonempty `amsreferences`.
- 192 content strings matched a simple HTML-tag check. That check was a structural observation, not a rendering or sanitization test.
- Observed `contenttype` values included `Text`, `text`, and an absent/null result in the summary. Do not assume casing or universal presence.
- Properties included mentions, cards, links, files, quoted-message metadata, pinned state, edit time, and reaction-related fields.

The count of media references is not a count of successfully downloaded attachments. All property value schemas and their interpretation remain incomplete.

### E08 — HTTP chat listing

**Verified:** a browser-observed directory request led to a successful server-side read of:

~~~text
GET https://teams.live.com/api/csa/api/v3/teams/users/me
~~~

The first replay used captured cookie/token-related headers. A second test reduced that to **`x-skypetoken` alone**, without cookies or the observed sync-token header.

The response returned:

- 15 chat records.
- 7 records with nonempty titles.
- 8 one-to-one records.
- An empty `users` array.
- `metadata.hasMoreChats = false`.
- `metadata.isPartialData = false`.

**Limit:** these flags and counts describe this account response. Directory pagination, hidden/deleted-chat policy, membership filtering, and participant-name lookup were not established. The browser rail also contained a self-chat entry; the directory count is not proof that every possible UI entry appears as an ordinary chat record.

### E09 — Image download

**Verified:** an image URL observed while G1 was displayed used `experimental-api.asm.skype.com`, an `/objects/{object-id}/views/imgo` path, and no query parameters in the inspected samples.

Unauthenticated server-side attempts returned `401`. Request-header inspection for those browser image responses did not expose the required cookie, even though they were successful in the browser.

The matching browser-context cookies were then obtained in memory for the exact image URL. The relevant cookie name was **`skypetoken_asm`**. A server-side request with that cookie returned:

| Property | Result |
| --- | --- |
| HTTP status | `200` |
| Content type | `image/jpeg` |
| Downloaded size | 69,257 bytes |
| First 8 bytes, hexadecimal | `ffd8ffe000104a46` |
| `ETag` present | No |
| `Last-Modified` present | Yes |

These bytes support the conclusion that an actual JPEG resource was downloaded, rather than a screenshot, HTML login page, or placeholder. The file was read in memory. Original-upload resolution, exact byte identity with the upload, and other media variants were not verified.

### E10 — Image cache revalidation

**Verified:** requesting the same image with the captured media cookie plus `If-Modified-Since`, using the returned `Last-Modified` value, returned HTTP **`304`**.

**Consequence:** this sample supports conditional cache validation without resending the image body. A persistent cache, manifest, cache lookup, or cached export was not implemented.

### E11 — Latest-history baseline and ordering

Before testing historical date jumps, a no-cursor G1 request used `startTime=1` and `pageSize=200`.

**Verified result:**

- 200 messages; all 200 `originalarrivaltime` values parsed as dates.
- Earliest arrival: `2026-10-28T10:54:53.532Z`.
- Latest arrival: `2026-11-04T07:05:56.754Z`.
- The array was **neither nondecreasing nor nonincreasing** by arrival time. Both non-strict monotonic comparisons failed.

The reason for the order was not investigated. Do not infer that array order is creation order, version order, or a guarantee that the first older timestamp marks the end of a period.

### E12 — Direct date seeking without a cursor

All initial requests below had **no `syncState` parameter**. Date boundaries were supplied as Unix milliseconds.

| Request | Count | Earliest arrival | Latest arrival | Additional finding |
| --- | ---: | --- | --- | --- |
| `startTime=2026-08-01`, no end | 200 | Oct 28, 10:54:53.532Z | Nov 4, 07:05:56.754Z | Same 200 IDs as latest baseline |
| `startTime=2026-08-01`, `endTime=2026-08-08` | 65 | Aug 3, 02:40:22.109Z | Aug 7, 07:51:53.246Z | No backward link; no out-of-window arrivals |
| `startTime=1`, `endTime=2026-08-08` | 200 | Jul 29, 07:43:45.688Z | Aug 7, 07:51:53.246Z | Backward link present |
| Start set one day after test time | 0 | — | — | No backward link |

Date-only values in this table mean `00:00:00.000Z` on that date. The future control used the execution clock plus 86,400,000 milliseconds; it was not a request for a different fixed fixture date.

**Conclusion:** `startTime` is an effective lower bound in the tested requests, but by itself does not position the first page near that lower bound. Supplying `endTime` positions retrieval at the older upper boundary. No cursor from current history is necessary to start there.

The 65-message result had the exact same IDs as the corresponding date subset of the independently fetched end-only page.

### E13 — Date-window pagination trap and fix

The first G1 request for `2026-07-01T00:00:00Z` through `2026-09-01T00:00:00Z` returned 200 messages spanning August 6–26, with a backward link.

**Verified failure:** that link had query keys `startTime`, `syncState`, `pageSize`, and `view`—**no `endTime`**. Following it unchanged returned the current 200-message October/November baseline, with all 200 arrivals outside the requested window.

**Verified fix:** keeping the returned cursor while adding the original `endTime` returned 200 older messages spanning July 29–August 6, with zero overlap with the first page and zero out-of-window arrivals. Replaying the corrected next request through the observed same-origin history endpoint also produced the same range and count.

Repeating the original first-page date request returned the same 200 message IDs in this short test. This is evidence of repeatability against the sampled state, not a guarantee of snapshot isolation or cursor durability across later edits.

### E14 — Date-bounded traversal to exhaustion

With both original date bounds explicitly retained, the July–August G1 window was followed until no backward link remained:

| Page | Count | Earliest arrival | Latest arrival |
| --- | ---: | --- | --- |
| 1 | 200 | `2026-08-06T10:46:03.562Z` | `2026-08-26T08:01:24.570Z` |
| 2 | 200 | `2026-07-29T07:31:24.842Z` | `2026-08-06T10:45:59.851Z` |
| 3 | 200 | `2026-07-16T10:47:55.403Z` | `2026-07-29T07:31:17.331Z` |
| 4 | 200 | `2026-07-07T10:55:19.023Z` | `2026-07-16T10:47:24.424Z` |
| 5 | 200 | `2026-07-01T04:15:45.565Z` | `2026-07-07T10:55:05.483Z` |
| 6 | 21 | `2026-07-01T01:53:51.129Z` | `2026-07-01T04:14:51.997Z` |

**Verified totals:** 1,021 records, 1,021 unique IDs, zero inter-page overlap, zero arrivals outside the requested window, and no final backward link.

Filtering these 1,021 records to the narrower August 1–8 window gave the exact same 65 IDs as the direct narrow request.

**Limit:** this establishes exhaustion of the server-provided window and consistency between the tested queries. There was no independent authoritative archive count against which to prove that the service exposed every message ever sent, including deleted, expired, or inaccessible history.

### E15 — Direct one-to-one date window

A July–August request for D1 returned zero messages. Zero alone did not establish a date-seeking failure or success for a populated period.

A D1 latest baseline returned 200 messages spanning `2026-10-30T03:07:22.979Z` through `2026-11-04T10:28:32.404Z`.

A no-cursor request for `2026-10-22T00:00:00Z` through `2026-10-24T00:00:00Z` then returned:

- HTTP `200`.
- 186 messages.
- Earliest arrival: `2026-10-22T02:57:04.514Z`.
- Latest arrival: `2026-10-23T11:43:23.164Z`.
- No out-of-window arrivals and no backward link.

This demonstrated a populated historical jump in a one-to-one chat as well as in a group chat. Multi-page bounded traversal was completed for G1, not separately for D1.

### E16 — Exact millisecond boundary checks

A known G1 message at timestamp `t` was used for two single-millisecond windows:

| API bounds | Reference message included? | Returned count |
| --- | --- | ---: |
| Start `t`, end `t + 1 ms` | Yes | 1 |
| Start `t - 1 ms`, end `t` | Yes | 1 |

**Conclusion:** both boundaries tested as inclusive for this sample. A CLI using half-open windows must explicitly adapt the request and locally enforce its chosen semantics.

### E17 — First Bun CLI live check

On **2026-11-04**, the implemented CLI ran as separate Bun **1.3.14** processes using Ky **2.2.0** and an explicitly supplied private credential JSON file. Browser request observation supplied credentials; the CLI itself used ordinary HTTP, without Playwright calls or a browser connection.

| Operation | Outcome | CLI HTTP attempts | Retries |
| --- | --- | ---: | ---: |
| `chats` with the recorded directory query | Exit `0`, 15 chat records | 1 directory | 0 |
| `export` for the active selected chat and `--last 7d` | Exit `0`, 5 messages, 1 exhausted history page, JSON written | 1 history, 0 directory | 0 |

The export used a fixed half-open window, source-field-preserving validation, and local credential loading. Private credential state and the resulting message file were kept under ignored `.private/`; no raw identifiers, token values, or message bodies are included here. Temporary browser capture state was removed afterward.

**Limits:** the browser remained open, so this is not a browser-closed acceptance test. The live CLI export needed only one page; bounded multi-page traversal in the implementation is covered by synthetic tests, while E14 remains the earlier separate live protocol experiment. This check did not exercise media, renewal, throttling, or another account. It generated only ordinary listing/export traffic, not rate-limit probes.

### E18 — Participant profile resolution

Follow-up on **2026-11-05**: server-side HTTP resolved all eight untitled one-to-one counterparts (four personal, four organization). Their names all matched text visible in Teams. Self-profile MRI matched a member in every sampled one-to-one chat, leaving exactly one counterpart after exclusion.

The two batch profile routes and self-profile route succeeded with captured Bearer authorization plus Skype token; tested single-credential variants returned 401. The personal route needed the observed query template to return profiles. No cookies or browser-side Fetch were used. The [participant profile reference](08-participant-profiles.md) records exact paths, query templates, response shapes, and routing controls.

Limits: one account; no live self-chat, unavailable/masked-profile, credential renewal, or server batch-limit acceptance. Cached names can become stale. This experiment did not implement automatic token capture.

### E19 — Participant-name CLI and cache check

On **2026-11-05**, two ordinary `bun run teams chats` invocations used the automatically located credential file, now containing the captured profile Authorization/Skype pair. Both exited 0, returned 15 chats, and resolved all eight one-to-one labels.

| Run | Directory attempts | Profile attempts | Total attempts | Retries |
| --- | ---: | ---: | ---: | ---: |
| First run with a new cache | 1 | 3 (self and two batches) | 4 | 0 |
| Immediate repeat | 1 | 0 | 1 | 0 |

Only counts and safe diagnostics were recorded here; credentials and names remain private. The browser stayed open, but the CLI used ordinary HTTP without a Playwright connection. This verifies persistent reuse across CLI processes; TTL expiry, refresh, account isolation, invalid cache data, and failure paths have synthetic coverage rather than live waiting/probing.

### E20 — Standalone browser login and saved-credential reuse

On **2026-11-05**, the new `bun run teams login` ran with Bun 1.3.14, pinned `playwright-core` 1.64.1, and the installed Fedora Chromium. It used a separate private per-user persistent profile, visible sandboxed mode, and the native Wayland argument. The existing MCP profile/configuration was not migrated or changed.

Both the initial invocation and an immediate second invocation captured history Authentication plus the paired profile Authorization/Skype headers, passed self-profile/directory/history HTTP checks, saved the version-1 state file, closed their login browser, and exited 0. Each used three counted validation attempts (one per service purpose), zero retries. Browser/application traffic was outside those counters. The second invocation reused the persisted browser session successfully; this does not establish indefinite session lifetime.

After the login browser closed, separate CLI processes using automatic credential lookup:

| Operation | Outcome | Counted HTTP attempts | Retries |
| --- | --- | ---: | ---: |
| `chats` | 15 chats, all eight one-to-one labels resolved | 4 (directory, self, two name batches) | 0 |
| `export --last 7d` for a supplied chat ID | Complete JSON, five messages, one history page | 1 history | 0 |

The new credential scope made the name cache cold as designed. A separate properties-route probe returned HTTP 200 with a JSON object using the freshly saved history header, supporting the empty-directory verifier's route without establishing actual empty-account behavior. Private credential and export artifacts were excluded from Git. The independent research MCP browser remained open: this proves the login browser can close before CLI reuse, not that every Microsoft/browser process on the machine was shut down. No CLI command attached to MCP or Playwright for these reads. Empty-account fallback, cancellation, unsafe permissions, and failure preservation have synthetic coverage; no live empty account, unattended refresh, MFA recovery, or media-cookie acquisition was tested.

## 3. Corrections that must survive into implementation

| Earlier assumption or suggestion | Current conclusion |
| --- | --- |
| Browser automation might be required throughout export | Plain HTTP history, listing, and sample media reads succeeded with captured credentials |
| A cookie-only `401` means the browser must download history | The missing explicit history header explained that failure |
| All older exports must walk backward from current history | Date-bounded first requests can seek directly into older history |
| `--from` and `--to` would only filter output locally | They can bound server-side history requests efficiently |
| The returned next-page URL can always be followed unchanged | Its omitted `endTime` broke bounded pagination; preserve bounds explicitly |
| Message array order is sufficient for chronological stopping | The sampled latest array was not monotonic by arrival time |
| Every one-to-one chat has a usable title | Eight listed one-to-one chats had empty titles; names need lookup |
| Message credentials alone establish image support | A separate media cookie was needed in the successful image test |
| Every startup warning should be suppressed | Keep intentional automation defaults unless a demonstrated problem justifies changing them; enable the browser security sandbox separately |

## 4. What has not been established

Do not interpret the evidence as a complete Teams implementation. Unknowns include automatic credential renewal; participant lookup beyond E18's sampled identities; directory pagination; cursor lifetime and mutation behavior; deleted/edited-message semantics; all attachment formats; original-resolution selection; throttling; and a browser-closed cold-start exporter.

The [validation document](05-validation-and-open-questions.md) turns these into implementation checks without treating them as blockers to every initial feature.
