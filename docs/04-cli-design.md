# Proposed CLI design

This document translates the research into an implementation proposal. **There is no application code yet.** Examples, module boundaries, defaults, and file layouts are recommendations unless explicitly identified as user requirements or verified protocol facts.

The [HTTP reference](02-http-protocol.md) defines observed request behavior. The [validation plan](05-validation-and-open-questions.md) defines what still needs proof.

## 1. User requirements expressed so far

- Support personal-account Teams Free one-to-one and group chats.
- Let the user discover chat IDs with useful labels and select a chat.
- Primarily export **one specific chat**, rather than making all-account archival the default workflow.
- Support a specific period, such as the last seven days or a historical date window.
- Download included chat images as usable local files.
- Avoid downloading the same images again during overlapping/repeated exports.
- Re-fetching text is acceptable; avoid unnecessary incremental text-sync complexity initially.
- Keep the browser out of ordinary downloading when valid credentials suffice.
- Use browser login/session management when needed, with renewal behavior still to be established.
- Write detailed reference documentation before application implementation.

These requirements do not yet select an output format, executable name, packaging approach, credential backend, or exact flag syntax.

## 2. Direction supported by the evidence

Use a small HTTP-based exporter. Keep interactive login as a distinct concern.

~~~text
CLI input
   |
   +--> Resolve account, chat selection, and fixed date window
   |
   +--> Load/validate appropriate service credentials
   |
   +--> HTTP directory/history requests
   |       |
   |       +--> Preserve fields, enforce dates, deduplicate, sort
   |
   +--> Identify included image references
   |       |
   |       +--> Reuse local media cache or HTTP-download missing images
   |
   +--> Produce export with local media references and completion metadata

Separate login command --> optional browser helper --> credential state
~~~

No AI agent, MCP session, browser-scrolling loop, extension, or userscript is required for the normal export path established by the experiments.

The eventual JavaScript/TypeScript implementation should follow the supplied project instructions: Bun tooling and package management, ES modules, direct imports/exports, and simple scoped code. No package list or framework choice has been approved by these documents.

### Alternatives considered

| Approach | Status and tradeoff for this scope |
| --- | --- |
| Microsoft Graph chat API | Its documented personal-account limitation prevents treating it as the supported direct solution for this account; see the sources document |
| Official account export plus local archive parser | Documented alternative; not exercised. Could suit bulk archive processing, but does not establish the selected-chat CLI workflow by itself |
| Browser extension | Considered, not built or tested. Can integrate a picker/export action with the live browser, but adds extension packaging and a browser dependency to a workload now shown to have an HTTP path |
| Userscript | Considered, not built or tested. Could provide browser-local convenience, but retains a page/script-manager dependency and does not solve the authentication/caching model automatically |
| Playwright MCP or official CLI for every export | Useful for exploration or agent-guided work, but unnecessary for the tested HTTP read path |
| HTTP CLI plus optional browser login helper | Current proposed direction; concentrates custom code on chat selection, bounded reads, output, and media caching |

These comparisons explain the current scope choice. They are not benchmarks or evidence that an extension/userscript cannot work.

## 3. Proposed command surface

Illustrative commands:

~~~text
teams login
teams chats
teams export --chat <chat-id> --last 7d --images
teams export --chat <chat-id> --since <timestamp> --images
teams export --chat <chat-id> --from <timestamp> --to <timestamp> --images
~~~

| Operation | Proposed behavior | Unresolved detail |
| --- | --- | --- |
| `login` | Interactive browser login or session recovery, capture and validate service credentials | Launcher, profile selection, storage, renewal, logout |
| `chats` | Print IDs, labels/fallbacks, and useful chat types | Participant-name lookup, directory pagination, output modes, filtering hidden/meeting chats |
| `export` | Retrieve one selected chat and period; preserve source metadata and cache included images | Output format, defaults, overwrite semantics, flags |

An interactive picker could be a convenience on top of `chats`, not a requirement for noninteractive scripting. Always retain an explicit-ID route so ambiguity between chats with the same title does not select the wrong conversation.

Do not require a development server or a frontend framework for this workflow.

## 4. Date semantics

### 4.1 Server seeking is available

The first bounded HTTP request can go directly to the target period without fetching the intervening history from now. `--from`/`--to` therefore have an efficient implementation path.

This supersedes the earlier proposal to omit `--to` because all exports would have to walk from the latest message. That premise was disproved by the date-seeking tests.

### 4.2 Recommended internal representation

**Proposed:** resolve every invocation to one immutable window of UTC millisecond instants:

~~~text
fromInclusive
toExclusive
~~~

Retain the original user input, timezone interpretation, and resolved UTC instants in export metadata. This makes the meaning of an export auditable.

The tested API is inclusive on both ends. For a half-open CLI window, request `startTime = fromInclusive` and `endTime = toExclusive - 1 ms`, and locally enforce the half-open predicate. Validate that the range is nonempty and representable at the selected precision.

This is a design recommendation. Half-open CLI semantics and the arrival/composition timestamp choice still need an explicit product decision before finalizing help text.

### 4.3 Relative periods

**Proposed:** `--last 7d` means the previous 168 hours, ending at one captured invocation time. It is not a calendar week unless the product deliberately adopts different semantics.

Capture that end time once. Do not recompute now for each page or after a retry, because doing so changes the window during export.

`--since` can be shorthand for an explicit start and the same fixed invocation end. It remains useful even though direct bounded seeking makes a separate `--to` practical.

### 4.4 Input parsing and timezone choices

The research examples use UTC. The user's desktop timezone is Asia/Jakarta. That does not by itself settle CLI input semantics.

Before implementing date parsing, decide:

- Whether full timestamps must contain an offset or `Z`.
- Whether date-only strings are interpreted in UTC, the system timezone, or a configured timezone.
- Whether date-only `--to` means the beginning of that day or includes the entire day.
- Whether the CLI supports an explicit timezone option.

Document the choice and display resolved boundaries. Avoid silently interpreting a date-only value differently across machines. A calendar-day window and a rolling 24-hour duration are not interchangeable in all timezones.

### 4.5 Timestamp used for filtering

`originalarrivaltime` is the field used successfully in the experiments. Its relationship to `composetime`, edit time, message version, and UI date display has not been fully characterized.

**Proposed:** retain all source timestamps, choose one explicit filtering rule, and include that choice in metadata. Do not reassign old messages to a new export date solely because they were edited unless that is an intentional mode.

## 5. Directory, labels, and selection

Use the successful HTTP directory path rather than scraping the browser rail for routine selection.

The listing model should keep at least the opaque ID, available title, relevant type information, and member references. Preserve source flags needed to explain why a record is unavailable or unusual; do not silently treat a meeting, deleted conversation, self-chat, and ordinary group as equivalent.

Friendly one-to-one labels need further work: titles were empty and the directory `users` array did not supply profiles. A member-profile lookup and self-identification rule are unresolved.

**Proposed fallback:** show an explicit unresolved label plus the chat ID until a trustworthy name is available. Do not use the latest message sender as the sole counterpart identity.

Directory pagination/partial-data handling must be implemented or clearly surfaced. This account returned a complete-looking 15-record response, but that is not a universal completeness guarantee.

## 6. History retrieval

The initial implementation should be small and sequential:

1. Resolve one chat and fixed API bounds.
2. Make the initial no-cursor request.
3. Validate the response and preserve its message fields.
4. Continue using returned state while explicitly retaining both bounds.
5. Deduplicate and record progress.
6. Finish when the service exposes no further backward link.

Do not fetch many pages concurrently: each next cursor depends on the preceding response. No need for a parallel history runtime has been established.

Do not use the first timestamp in an array as a stopping condition. The sampled order was not monotonic. Sort after retrieval, with deterministic tie-breaking chosen and tested by the implementation.

Avoid a text-sync database initially. The user is comfortable re-fetching text for the requested period. Correct pagination, preserving fields, and not repeating image downloads matter more than optimizing a small text payload prematurely.

## 7. Image discovery and downloads

### 7.1 Discovery still needs a complete adapter

The HTTP image download is proven. A complete mapping from every raw message representation to its downloadable images is **not** proven.

Investigate `amsreferences`, relevant HTML image/object attributes, quoted content, cards, and message properties using sanitized examples before claiming every embedded image is covered. Different representation paths may refer to the same object or to different variants.

### 7.2 Scope images to included messages

Download only images referenced by messages included by the chosen export predicate. Do not download every image from an account or from adjacent pages just because it was encountered while reading history.

External web images, preview thumbnails, inline chat uploads, stickers, GIFs, and ordinary file attachments may require different treatment. Their coverage should be explicit. The initial successful JPEG is not evidence that every one of these is handled.

### 7.3 Fidelity

The tested `imgo` view returned a valid JPEG. It was not compared with an original upload, and no image dimensions or alternate views were measured.

Do not call an image original/full-resolution merely because a view name appears suggestive. Select and record the requested representation after validation.

## 8. Persistent media cache

The cache exists to avoid repeated network transfers during overlapping exports. It should be independent of an individual export directory, so a new export can reuse a prior download.

### 8.1 Identity

**Proposed logical key:** account scope + media service/namespace + media object ID + representation/view + version when available.

Reasons for this key:

- A chat title is not unique and can change.
- A message may refer to several images.
- Different views can represent different bytes or resolutions of one object.
- Temporary or signed URL values may change without changing the object.
- Account scoping avoids assuming that an ID or authorization context is globally interchangeable.

The complete stability/version semantics of media IDs remain untested. Preserve available metadata and support revalidation rather than asserting all objects are immutable.

### 8.2 Cache entry contents

A simple file-plus-manifest approach is sufficient as an initial proposal. No database has been shown necessary.

An entry can track:

- Logical identity and selected representation.
- Complete local file path and byte length.
- Detected media type and optional integrity hash.
- Available `Last-Modified`, `ETag`, or source version metadata.
- Completion status and any last validation time.

Exclude authentication headers, media-cookie values, and credential-bearing URL query parameters from ordinary manifests and exported metadata.

An integrity hash can verify or deduplicate bytes after download. **A content hash alone cannot prevent the first repeated network request** unless the object-to-file mapping is also retained.

### 8.3 Default lookup flow

1. Resolve a message reference to its logical media key.
2. If a complete matching local file exists, reuse it without a network request.
3. Otherwise, download with the appropriate media credential into a temporary file.
4. Validate the response and completed body.
5. Promote the complete file to the cache, then mark the entry successful.
6. Materialize the image into the selected export layout without another media download.

Never mark a partial file as a successful cache hit. A manifest entry pointing to a missing file is a cache miss, not a reason to emit a broken image reference.

Skipping revalidation on a default cache hit prioritizes the user's no-repeat-download workflow. A refresh mode can validate mutable resources explicitly.

### 8.4 Optional refresh/revalidation

The sample supports `Last-Modified` plus `If-Modified-Since`; its conditional response was `304`.

**Proposed behavior:**

- On `304`, reuse an existing complete local file.
- On `200`, validate the new body and replace the cache entry only after success.
- If there is no complete local file, do an unconditional read rather than treating `304` as success.
- Use ETag-based validation if supplied by another resource, but test it; this investigation did not receive an ETag for the sample.

See the [HTTP conditional-request specification](https://httpwg.org/specs/rfc9110.html#field.if-modified-since).

### 8.5 Portable exports

If the chosen output is intended to work offline or be copied elsewhere, image references must resolve to files included with that export. Do not leave local HTML/Markdown dependent on expiring Teams URLs or an unrelated absolute cache path.

Copying or otherwise materializing cached bytes into an export is a local operation and does not imply a new network download. The exact layout, copying/linking policy, and cache eviction rules remain decisions.

### 8.6 Missing media

A failed or unavailable image should be represented explicitly. A cache entry, placeholder, or manifest can explain the failure without pretending the archive is complete.

Whether an image failure should fail the whole command by default or allow an explicitly partial export needs a product decision. In either case, do not silently report complete success while images are missing.

## 9. Export data and rendering

The raw message layer should preserve useful source fields and distinguish them from derived display values. A readable output can then be regenerated without reinterpreting an already-flattened text-only file.

Potential outputs discussed include JSON, Markdown, HTML, and local searchable records. None is implemented or selected as the final default. A minimal first milestone could be JSON with media files plus a manifest; a readable renderer can follow if required.

For a browser-readable output, treat message HTML as untrusted input: preserve raw source separately and render through a deliberate sanitization policy. This is an implementation requirement of rendering remote HTML, not evidence of a malicious message in the sample.

Recommended export metadata includes:

- Selected account scope and chat ID, with a display label when resolved.
- Resolved UTC boundaries, timezone/input interpretation, and filtering timestamp field.
- Invocation time and completion/interruption status.
- Page count, record count, unique-message count, and deduplication policy.
- Counts of media references, cache hits, downloads, and failures.
- A clear distinction between service-reported exhaustion and independent proof of historical completeness.

Do not include credentials or raw authenticated pagination URLs in a shareable export manifest.

## 10. Failures, progress, and resuming

### 10.1 Proposed behavior

- Distinguish authentication problems in directory, history, and media operations.
- Return meaningful nonzero failure status when the operation cannot fulfill its contract.
- Do not convert failed HTTP reads, JSON parse errors, or expired credentials into empty results.
- Use bounded retries for eligible transient read failures, with cancellation and useful progress.
- Honor applicable server retry guidance if throttling occurs; no retry thresholds were derived from the experiments.
- Keep successful cached images when a later export step fails.

### 10.2 Checkpoints

Checkpointing was discussed but not implemented. A checkpoint would need the chat/account scope, fixed bounds, current continuation, and already-persisted progress. A raw cursor can reveal private state and should not be part of a public/shareable manifest.

Cursor lifetime is unknown. The design must not promise that a saved cursor remains valid indefinitely. If resuming state fails, a bounded re-fetch of text with deduplication and image-cache reuse is a simpler recovery path than inventing a cursor.

Durable text checkpoints are useful only if the associated messages have also been safely persisted. Advancing a cursor before saving its page could skip messages after a crash.

## 11. Simple module boundaries, when implementation is authorized

Keep responsibilities explicit without prebuilding a plugin framework:

| Responsibility | Boundary |
| --- | --- |
| CLI | Parse input, select command, report results/status |
| Login helper | Optional browser interaction and credential acquisition |
| Credential access | Service-specific load/validation; no browser launch as an import side effect |
| HTTP directory/history | Request construction, response validation, bounded pagination |
| Message adaptation | Preserve raw fields, apply date policy, deduplicate, sort |
| Media adapter/cache | Resolve references, reuse/download/validate files |
| Output | Write selected format and completion metadata |

These are conceptual boundaries, not a requirement for one file or class per row. Avoid new abstraction layers until actual call sites require them. Use direct imports rather than barrel exports, as required by the user's project instructions.

## 12. Decisions still to make before final CLI behavior

1. Executable name, installation method, runtime version, and dependency versions.
2. Output format(s), directory layout, overwrite behavior, and what complete means when media fails.
3. Date-only and timezone semantics; arrival versus composition-time filtering.
4. Whether images are opt-in or the default, and which image representations are covered initially.
5. Credential persistence and renewal behavior; browser profile selection for the login helper.
6. Participant-name lookup and handling of hidden, meeting, external, or deleted directory records.
7. Whether the first release needs durable checkpoints, or can restart bounded text retrieval while reusing cached media.

These choices should be settled as part of the implementation discussion. They do not require more unrelated Teams reverse engineering before a focused first milestone can be built.
