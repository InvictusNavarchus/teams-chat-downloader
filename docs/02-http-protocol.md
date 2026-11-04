# HTTP protocol reference

Status: **observed private endpoint behavior**, tested on **2026-11-04** for Teams Free with a personal Microsoft account. This document is not a Microsoft-supported API specification.

Evidence references such as E13 point to [findings and evidence](01-findings-and-evidence.md). All credential and chat identifiers below are placeholders.

## 1. Endpoint and credential map

| Operation | Endpoint or host | Smallest credential set verified |
| --- | --- | --- |
| List chats | `GET https://teams.live.com/api/csa/api/v3/teams/users/me` | `x-skypetoken: <captured value>` |
| Self and participant names | `GET /api/mt/beta/users/me/`, `POST /api/mt/beta/users/fetchShortProfile`, `POST /api/mt/beta/users/fetchFederated` on `teams.live.com` | Captured `Authorization` Bearer header **and** `x-skypetoken`; see [query templates and schemas](08-participant-profiles.md) |
| Read history | `GET https://teams.live.com/api/chatsvc/consumer/v1/users/ME/conversations/{encoded-chat-id}/messages` | `Authentication: <captured complete header value>` |
| Continue history | Server-provided URL, observed at `https://msgapi.teams.live.com/v1/users/ME/conversations/{encoded-chat-id}/messages` | Same captured `Authentication` value in the tests |
| Read a chat image | Observed `https://experimental-api.asm.skype.com/v1/{namespace}/objects/{object-id}/views/imgo` | `Cookie: skypetoken_asm=<captured value>` |
| Authentication probe only | `GET https://teams.live.com/api/chatsvc/consumer/v1/threads/{thread-id}/consumptionhorizons` | Successful captured read was used to obtain the history header |

Header names are case-insensitive, but `Authentication` and `Authorization` are **different names**. The complete history header value was replayed unchanged. Its internal format, prefix requirements, and any equivalence between listing and history token values were not investigated.

Do not send every captured credential to every host. Use credentials for the service from which they were observed. The cookie was selected for the exact media URL from browser-context cookies, not copied indiscriminately from all browser cookies.

## 2. Initial history request

### 2.1 Path and chat IDs

The chat identifier comes from directory results or browser discovery. Treat it as opaque. Observed browser IDs included thread-style values beginning with `19:` and containing suffixes such as `@thread.v2`; this is an observation, not a parser rule or validation schema.

Encode the entire chat ID as **one URL path segment**. Do not encode the entire endpoint and do not double-encode an already encoded identifier. Store raw directory IDs as opaque strings and encode at request construction.

An illustrative HTTP request is:

~~~http
GET /api/chatsvc/consumer/v1/users/ME/conversations/{encoded-chat-id}/messages?view=msnp24Equivalent%7CsupportsMessageProperties%7CsupportsExtendedHistory&pageSize=200&startTime={unix-ms}&endTime={unix-ms} HTTP/1.1
Host: teams.live.com
Authentication: <complete-captured-header-value>
~~~

No request body was used for these reads.

### 2.2 Query parameters

| Parameter | Observed or tested behavior | Limits of knowledge |
| --- | --- | --- |
| `view` | Tests used `msnp24Equivalent\|supportsMessageProperties\|supportsExtendedHistory` as one value | Necessity and effects of individual capabilities not isolated |
| `pageSize` | `200` worked for ordinary and bounded history | Not established as the maximum; smaller sizes and server caps not characterized |
| `startTime` | Lower date bound in Unix milliseconds; `1` used for effectively unbounded test history | Earliest accepted value, zero/negative values, and all filtering semantics not characterized |
| `endTime` | Upper date bound in Unix milliseconds; enabled a no-cursor historical jump | Default behavior without it returned current history; both boundaries tested inclusive for one exact-timestamp sample |
| `syncState` | Opaque server continuation state from response metadata/links | Not needed for initial date seeking; expiry, internal encoding, and durability untested |

Use a URL/query builder so separators in `view` and special characters in IDs are encoded correctly. The observed requests sometimes displayed literal pipe characters, while the replay tests used encoded query values successfully.

### 2.3 Tested timestamp fixtures

| UTC instant | Unix milliseconds |
| --- | ---: |
| `2026-07-01T00:00:00.000Z` | `1782864000000` |
| `2026-08-01T00:00:00.000Z` | `1785542400000` |
| `2026-08-08T00:00:00.000Z` | `1786147200000` |
| `2026-09-01T00:00:00.000Z` | `1788220800000` |
| `2026-10-22T00:00:00.000Z` | `1792627200000` |
| `2026-10-24T00:00:00.000Z` | `1792800000000` |

These numbers were independently recalculated during the documentation pass. They are safe fixture values; no authentication information is encoded in them.

### 2.4 Direct date seeking

**Verified:** an initial request containing start/end timestamps but no `syncState` returned the requested old period directly. The client did not have to obtain a cursor by traversing the more recent period first.

`startTime` alone did not select a first page near the start: an August lower bound returned the same latest 200 IDs as the unbounded baseline. Adding an August upper bound moved the result into August. A future start returned an empty result.

This supports `--from` and `--to` as efficient server-side request bounds, not merely output filters. It does not establish an arbitrary direct page number, a durable snapshot, or access to history the account cannot otherwise read.

## 3. History response

### 3.1 Top-level structure

Observed top-level keys:

~~~text
messages
tenantId
_metadata
~~~

`messages` was an array. A successful bounded window could contain fewer than 200 records or zero records. Zero is not itself an error when HTTP and response shape are valid.

An illustrative shape, with all values replaced, is:

~~~json
{
  "messages": [],
  "tenantId": "<opaque-tenant-value>",
  "_metadata": {
    "lastCompleteSegmentStartTime": "<service-value>",
    "lastCompleteSegmentEndTime": "<service-value>",
    "backwardLink": "<optional-server-pagination-url>",
    "syncState": "<opaque-server-state>"
  }
}
~~~

This is a field illustration, not a valid nonempty response fixture or a complete type definition. The segment fields and sync-state value types and meanings were not fully validated. In exhausted/empty responses, `backwardLink` was absent.

### 3.2 Observed message fields

The following field inventory came from a fresh group-history response. Optionality and all types are not established; do not turn this inventory into a rigid schema that discards unknown fields.

| Field | What can currently be said |
| --- | --- |
| `id` | Used successfully for per-chat message identity and overlap/deduplication checks; retain as an opaque value |
| `clientmessageid` | Separate client-side identifier; do not assume it is interchangeable with `id` |
| `conversationid` | Conversation reference; exact casing is significant to the JSON field |
| `conversationLink` | Conversation link; avoid persisting credentials if any future link contains them |
| `sequenceId` | Present; ordering and numeric representation not characterized |
| `version` | Present; revision comparison and history semantics not characterized |
| `messagetype` | Distinguishes text, HTML, and observed thread activity events |
| `contenttype` | Observed casing/presence varied; not a reliable sole HTML detector |
| `type` | Present; complete meaning and values uncharacterized |
| `content` | Observed message content strings, often HTML; preserve source and separately render/normalize |
| `from` | Sender reference; not a promise of a friendly display name |
| `fromTenantId` | Sender tenant context; not a participant-name lookup |
| `imdisplayname` | Observed sender-name-related field; completeness and precedence uncharacterized |
| `fromDisplayNameInToken` | Sender-name-related field; may be historical or absent |
| `fromGivenNameInToken` | Sender-name-related field |
| `fromFamilyNameInToken` | Sender-name-related field |
| `composetime` | Timestamp field; exact semantic differences from arrival and edit timestamps remain open |
| `originalarrivaltime` | Successfully parsed for date-window checks and result summaries |
| `properties` | Object with additional metadata; detailed value schemas not characterized |
| `amsreferences` | Observed as an array in some messages and absent in others; exact item structure not yet documented |

The source may expose new or additional fields. Preserve the original non-credential message fields in the raw export layer rather than limiting output to a minimal text model.

### 3.3 Observed message types and properties

The sample contained `RichText/Html`, `Text`, `ThreadActivity/AddMember`, and `ThreadActivity/DeleteMember`. Other types are not ruled out.

Observed `properties` keys:

~~~text
mentions
cards
links
files
qtdMsgs
formatVariant
hasValidMsgReferences
languageStamp
blurHash
edittime
composetime
skipfanouttobots
pinned
emotions
deltaEmotions
~~~

These are presence observations only. In particular:

- A field name does not establish whether its value is a JSON object, serialized JSON string, array, scalar, or nullable value.
- `edittime` does not prove access to previous message revisions.
- `emotions` and `deltaEmotions` do not yet establish a correct reaction aggregation algorithm.
- `qtdMsgs` does not establish a complete threaded-reply or quote-rendering model.
- A media reference does not establish that the linked file is still downloadable.

### 3.4 Ordering and identity

The latest 200-message G1 array was neither monotonic ascending nor monotonic descending by `originalarrivaltime` (E11).

**Proposed implementation rules:**

- Sort the finished export explicitly using the chosen timestamp, with a documented tie-breaker.
- Deduplicate by account/chat/message identity, not content text or timestamp.
- Preserve `version` until duplicate-version behavior has been characterized. Do not invent numeric ordering for opaque values or silently retain an older revision.
- Do not stop traversal because the first array record is older than the desired cutoff.

## 4. Pagination

### 4.1 Observed continuation data

`_metadata` included `backwardLink` and `syncState`. Tested backward links targeted:

~~~text
https://msgapi.teams.live.com/v1/users/ME/conversations/{encoded-chat-id}/messages
~~~

Their query keys included:

~~~text
startTime
syncState
pageSize
view
~~~

Treat the state as opaque. Do not synthesize it by decoding timestamps, modifying bytes, or guessing a page index. No such manipulation was necessary for date seeking.

### 4.2 Critical rule: retain the original date bounds

**Observed defect/behavior:** the backward link did not carry `endTime`.

- With an unbounded initial history read, following the link unchanged worked.
- With a historical bounded initial read, following it unchanged returned current messages outside the requested period.
- Restoring the original `endTime` fixed the next page.
- Retaining both original bounds throughout the larger traversal reached the end of the window with 1,021 distinct IDs and no out-of-window arrivals.

The client must keep the resolved original date window as part of its own request state. The returned URL is not the complete source of truth for the requested export scope.

### 4.3 Proposed traversal procedure

This is an implementation procedure derived from the experiments, not existing application code:

1. Resolve the chat ID and both UTC millisecond boundaries once.
2. Make the first request with the tested `view`, `pageSize=200`, and the original start/end values; omit `syncState`.
3. Require a successful HTTP response and validate the basic JSON shape before treating it as data.
4. Preserve message fields, record IDs, and enforce the CLI's local date predicate.
5. If no backward link is present, record server-reported exhaustion of this window.
6. Otherwise, validate the link's scheme, host, path, and chat identity before sending any credential.
7. Keep the returned continuation state, but explicitly set the original `startTime` and `endTime` on the next URL.
8. Continue, checking for repeated continuation URLs/states, non-progress, and unexpected out-of-window records.
9. Treat HTTP/parse failures as failures or resumable interruptions, not as end of history.

The experiments used manual redirect handling for replay requests. Credential forwarding to arbitrary redirect targets was not needed. A production HTTP layer should preserve that restriction rather than following unknown cross-origin redirects with authentication attached.

### 4.4 Completion and repeatability

**Verified:** the G1 bounded traversal ended with a 21-record page and no backward link. A future-start request returned zero records and no backward link.

**Unknown:** whether every short page is terminal, whether an empty page can still have a continuation, and whether temporary service states can change pagination while data is being edited.

Therefore, page count alone is not an established completion contract. Do not stop solely because a page has fewer than 200 records.

The initial larger-window request was repeated and returned the same ID set in the short observation interval. There was no test of long-term cursor persistence, expiry, account changes, edits between pages, or deletions between pages. Do not claim snapshot isolation or permanent deterministic cursors.

## 5. Time-window semantics

### 5.1 API boundaries

Both API bounds tested as inclusive for a known single message at exact millisecond `t`:

- `[t, t + 1]` returned it.
- `[t - 1, t]` returned it.

Date checks in larger experiments used parsed `originalarrivaltime`. No message landed exactly on the outer midnight boundaries in those samples; the exact-millisecond test is the evidence for inclusivity.

### 5.2 Proposed CLI boundaries

A practical proposal is to define internal CLI windows as **`[from, to)`**: include the start and exclude the end. This makes adjacent export windows compose without boundary overlap.

For millisecond-precision bounds, one possible request mapping is:

~~~text
API startTime = CLI from
API endTime   = CLI to - 1 millisecond
Local filter  = arrival >= from AND arrival < to
~~~

This mapping is a proposal, not a tested CLI implementation. Validate it with fixtures and reject empty/reversed windows. Preserve the resolved original API bounds on every continued request.

Date-only inputs, timezone defaults, `--to` day inclusion, and whether user-facing filtering should use arrival or composition time remain product decisions. Do not silently promise that message arrival time and the human-visible creation date are always identical.

`--last 7d` was proposed to mean a rolling 168-hour window ending at a single captured invocation time. Calendar-week semantics were not requested or established.

## 6. Chat directory

### 6.1 Request

~~~http
GET /api/csa/api/v3/teams/users/me?isPrefetch=false&enableMembershipSummary=true&supportsAdditionalSystemGeneratedFolders=true&enableEngageCommunities=false HTTP/1.1
Host: teams.live.com
x-skypetoken: <captured-token-value>
~~~

These exact query values were recovered from the existing numbered browser request log during documentation. Both the initial directory route and the observed `/updates` reads used them and returned `200`:

| Query key | Observed value |
| --- | --- |
| `isPrefetch` | `false` |
| `enableMembershipSummary` | `true` |
| `supportsAdditionalSystemGeneratedFolders` | `true` |
| `enableEngageCommunities` | `false` |

This is a reproducible observed request shape, not proof that every flag is required. **The minimal required query set has not been isolated.** No new authenticated directory replay was performed just to recover these values.

A successful browser request at the same path with `/updates` appended supplied usable credentials. Removing `/updates` and retaining the observed query values produced the initial listing response. A subsequent replay with only `x-skypetoken`, without `cookie` or `x-ms-synctoken`, also succeeded.

The initial full directory read, the updates endpoint, and their sync tokens have distinct purposes. Do not treat an empty incremental `chats` array as an empty account.

### 6.2 Response keys

The successful initial listing response had:

~~~text
conversationFolders
teams
chats
users
privateFeeds
metadata
~~~

An observed updates response additionally included `channels`. Do not require identical key sets from both routes.

Observed initial `metadata` keys:

~~~text
syncToken
forwardSyncToken
isPartialData
hasMoreChats
coldBootTime
~~~

For this account, `hasMoreChats` and `isPartialData` were both false. Handling a true value, directory continuation, and token persistence are unresolved.

### 6.3 Chat record inventory

Observed keys on a representative chat record:

~~~text
id
consumptionHorizon
userConsumptionHorizon
productContext
lastL2MessageIdNFS
retentionHorizon
retentionHorizonV2
members
title
version
threadVersion
threadType
isEmptyConversation
isRead
isHighImportance
isOneOnOne
lastMessage
isLastMessageFromMe
chatSubType
lastJoinAt
createdAt
creator
tenantId
hidden
isGapDetectionEnabled
interopType
isConversationDeleted
isExternal
addedBy
addedByTenantId
isMessagingDisabled
isDisabled
importState
chatType
interopConversationStatus
conversationBlockedAt
hasTranscript
isMigrated
isSticky
isSmsThread
relationshipState
meetingPolicy
rosterVersion
identityMaskEnabled
isLiveChatEnabled
fileReferences
hasImpersonation
~~~

These fields are an inventory, not permission to infer all member visibility or membership semantics. `isOneOnOne`, type fields, and flags should inform display and eligibility only after their behavior is checked.

Observed nested member keys included `isMuted`, `mri`, `objectId`, `role`, and `isIdentityMasked`. Nested consumption-horizon keys included `originalArrivalTime`, `timeStamp`, and `clientMessageId`.

The nested `lastMessage` used different capitalization from history records, including `messageType`, `composeTime`, `originalArrivalTime`, and `imDisplayName`. Do not reuse a history field adapter blindly for directory previews.

### 6.4 Labels and selection

- Use raw `id` as the selection identity.
- Group/meeting titles were available on some records.
- The eight one-to-one records had empty titles in the inspected response.
- `members` supplied identity references, but `users` was empty in the directory response.
- Follow-up E18 verified self MRI exclusion and both profile routes for all eight counterparts; see the [participant profile reference](08-participant-profiles.md). The empty directory titles remain unchanged.

Do not derive a one-to-one label solely from the most recent message's sender name: that sender can be the current user, and the field can be absent or stale. Retain an explicit unresolved fallback whenever profile lookup cannot establish the counterpart's name.

## 7. Images and other media

### 7.1 Discovery and tested path

Messages exposed `amsreferences` and HTML content, while the browser requested media resources at:

~~~text
https://experimental-api.asm.skype.com/v1/{namespace}/objects/{object-id}/views/imgo
~~~

The corresponding browser-to-HTTP reference mapping has not been fully documented. In particular, the tested sample URL was captured from browser network activity; a complete routine that extracts every downloadable image URL from raw messages has not been validated. The subsequent [image export implementation](10-image-export.md) handles a limited inline `<img src>` adapter, including `us-api.asm.skype.com` URLs found in saved source exports; universal discovery remains unresolved.

Keep the observed namespace, object ID, and representation. Do not build a downloader that substitutes a guessed host, object namespace, or view.

Other media-related hosts observed during initialization included `us-api.asm.skype.com` and token-auth paths. Their behavior, necessity, and relationship to the tested image host remain incomplete.

### 7.2 Authentication

The successful sample request supplied:

~~~http
Cookie: skypetoken_asm=<captured-media-cookie-value>
~~~

The cookie was obtained for the exact resource URL from the browser context. Replay with no credentials returned `401`. The captured image request headers alone did not expose this cookie in the inspection output; use this as a known diagnostic limitation, not evidence that the resource is public.

Sending the history header as an alternative media credential was not established. Image and message credentials may expire separately; renewal behavior is unknown.

### 7.3 Download validation

The sample response was a 69,257-byte `image/jpeg` with JPEG signature `ffd8ffe000104a46`. This proves a usable media response for that sample.

**Proposed validation before cache success:**

- Require an appropriate successful response.
- Check the content type and basic file signature where practical.
- Treat an HTML/login/error body as a failure, even if its status is unexpectedly successful.
- Finish writing a temporary file before promoting it to a cache entry.
- Associate the actual resource representation and available version information with the cached bytes.

Do not infer original resolution, all-image coverage, GIF animation preservation, video support, file-attachment support, or availability of deleted media from the JPEG test.

### 7.4 Conditional requests

The sample returned `Last-Modified`, no `ETag`, and accepted:

~~~http
If-Modified-Since: <previous-Last-Modified-value>
Cookie: skypetoken_asm=<captured-media-cookie-value>
~~~

The response was `304 Not Modified`. Use the cached body only if a complete local body actually exists. A `304` is not a replacement for missing bytes.

Using `ETag`/`If-None-Match` would be standard HTTP behavior if a different resource supplies an entity tag, but that path was **not tested** here. See [HTTP semantics](https://httpwg.org/specs/rfc9110.html#field.if-modified-since).

## 8. Error and completeness boundaries

| Condition | Established behavior or proposed handling |
| --- | --- |
| History without explicit authentication | Observed `401` |
| Media without its credential | Observed `401` |
| Valid empty date window | Observed `200`, empty messages, and no backward link in the future-start control |
| Missing/expired credential during traversal | Expiry not tested; do not report an empty or complete export |
| Malformed/non-JSON response | Not tested; fail with useful context rather than treating it as no data |
| HTTP `429` or transient server failure | Not triggered live; the CLI now implements bounded Ky retries, deadlines, and accounting, checked with synthetic failures |
| Repeated cursor or wrong chat/host | Not triggered by valid corrected traversal; detect explicitly before claiming progress |
| Deleted, expired, inaccessible, or retention-limited history | Coverage not established; an exhausted API response is not proof of recovery of unavailable data |

There is no tested support for writes. This tool's intended protocol surface is reading directory/history/media and acquiring credentials through normal user login.
