# Teams personal chat export: research reference

[Project overview](../README.md)

Research date: **2026-11-04**. Target: **Microsoft Teams Free with a personal Microsoft account**, using `teams.live.com`.

This workspace contains the research and proposed design for a chat export tool. **No exporter, login helper, credential store, or CLI has been implemented.** Command examples describe a possible future interface.

## Main conclusion

A normal export can use ordinary HTTP requests to list accessible chats, request a specific historical date window, paginate within that window, and download chat images. Browser automation is not required to execute those requests while the appropriate credentials remain valid.

Playwright remains a practical helper for interactive login and credential acquisition. Credential lifetime, renewal, and a standalone login command have not been implemented or fully investigated.

The evidence is from live, read-only HTTP experiments against one signed-in personal account. These private Teams endpoints are observed behavior, not a published Microsoft API contract.

## Read these documents

| Document | Purpose |
| --- | --- |
| [Findings and evidence](01-findings-and-evidence.md) | Scope, evidence vocabulary, exact test results, and corrections to earlier assumptions |
| [HTTP protocol reference](02-http-protocol.md) | Endpoints, authentication headers, response fields, date parameters, pagination, listing, and images |
| [Authentication and browser setup](03-authentication-and-browser.md) | Credential acquisition, browser/session roles, the working Fedora Wayland configuration, and startup troubleshooting |
| [Proposed CLI design](04-cli-design.md) | User workflow, implementation boundaries, date semantics, media caching, outputs, and failure handling |
| [Validation and open questions](05-validation-and-open-questions.md) | Untested behavior, implementation acceptance checks, and a practical order for resolving gaps |
| [Sources](06-sources.md) | Primary documentation and upstream source references; distinction between public documentation and private endpoint observations |

## Evidence rules

Each document distinguishes:

- **Verified:** directly observed in a live experiment or in the local configuration.
- **Documented:** supported by an identified upstream document or source file.
- **Proposed:** an implementation recommendation, not existing behavior or a final product decision.
- **Unknown:** not established by the investigation.

If a conclusion conflicts with an earlier conversational suggestion, the measured result and the correction recorded here take precedence. When future behavior changes, update the evidence and the relevant protocol section together. Do not quietly turn a proposal into a verified fact.

## Facts an implementation must preserve

1. History uses an `Authentication` header; do not silently replace it with `Authorization: Bearer ...`.
2. Chat listing was separately verified with `x-skypetoken` alone.
3. Image downloading was separately verified with the media cookie `skypetoken_asm`.
4. History date boundaries are Unix timestamps in **milliseconds**, and both boundaries tested as inclusive.
5. A bounded first request needs **no** pagination cursor and can jump directly to an older period.
6. The returned `backwardLink` omits `endTime`. Preserve the requested date bounds explicitly on every subsequent page. An unchanged link returned current messages in the date-window test.
7. A message array was not strictly chronological by arrival time. Do not infer completion from the first old message or from array position.
8. Distinguish an exhausted history window from authentication, HTTP, or parsing failures.
9. Media cache identity must include the media object and representation, rather than a temporary URL or chat title.
10. Full message semantics, participant-name lookup, automatic renewal, and universal media support are still incomplete.

## Intended workflow

The user primarily wants to select one chat and export a period such as the last seven days, including locally available images without downloading the same images on each export.

A proposed interface is:

~~~text
teams login
teams chats
teams export --chat <chat-id> --last 7d --images
teams export --chat <chat-id> --from <timestamp> --to <timestamp> --images
~~~

The command name, exact flags, output formats, credential persistence backend, and date-only input rules are not final. See the design document before implementing them.

## What is deliberately absent

- No live credentials, cookies, bearer values, raw cursors, real chat IDs, participant names, message bodies, or downloaded private images are included in these documents.
- HTTP examples use placeholders. Field inventories and measured counts are evidence, not complete schemas.
- Existing `.playwright-mcp/` files are investigation artifacts, not sanitized fixtures or the authoritative reference. They may contain private browsing information; they were not copied into these documents.
- There is no `package.json` or application test suite. The Git repository was initialized after the documentation pass to version these research references; existing `.playwright-mcp/` artifacts remain untracked.

## Working constraints

Implementation requires a separate explicit instruction from the user. For future JavaScript/TypeScript work, the supplied project instructions require Bun, ES modules, scoped changes, and appropriate verification. Do not install packages, start a development server, alter the global MCP setup, or create application code merely because a design example appears here.
