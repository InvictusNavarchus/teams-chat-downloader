# Documentation

[Project overview and quick start](../README.md)

## Using the CLI

These guides describe implemented behavior:

| Guide                                          | What you will find                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [User guide](user-guide.md)                    | Sign-in, chat selection, date ranges, collection, backups, images, offline conversion, and recovery |
| [Development and verification](development.md) | Contributor setup, offline checks, and the opt-in live smoke test                                   |

For a first export, start with the [quick start](../README.md#quick-start). For exact command options, run `bun run teams <command> --help`.

## Technical references

These documents explain implementation contracts and the evidence behind them. Dated experiments establish behavior for the sampled account, not a published Microsoft API guarantee.

| Reference                                                            | Scope                                                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [HTTP protocol](02-http-protocol.md)                                 | Endpoints, service-specific authentication, pagination, date bounds, and observed quirks                                    |
| [Authentication and browser setup](03-authentication-and-browser.md) | Credential capture sources, browser/session roles, and historical environment troubleshooting                               |
| [Architecture](07-architecture.md)                                   | Stack, module responsibilities, validation, HTTP policy, and storage boundaries; later milestones remain labeled separately |
| [Participant profiles](08-participant-profiles.md)                   | Name resolution, profile authentication, and cache behavior                                                                 |
| [Browser login](09-browser-login.md)                                 | Dedicated browser profile, capture, verification, persistence, and renewal limits                                           |
| [Image export](10-image-export.md)                                   | Supported sources, service cookies, cache and refresh, output publication, and offline links                                |
| [SQLite collection](11-sqlite-collection.md)                         | Schema, checkpoints, migration, image storage, verified backups, and offline exports                                        |

[AGENTS.md](../AGENTS.md) records contributor rules and the invariants changes must preserve. Consult the [user guide](user-guide.md) for current command examples rather than copying commands from historical proposals.

## Research, proposals, and evidence

The initial investigation targeted Microsoft Teams Free at `teams.live.com` on **2026-11-04**. These documents retain the reasoning, measured results, and unresolved questions. Proposed interfaces are not necessarily implemented.

| Document                                                             | Purpose                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [Findings and evidence](01-findings-and-evidence.md)                 | Live experiments, corrections, and the limits of each observation                                      |
| [Proposed CLI design](04-cli-design.md)                              | Original requirements and design proposals, including superseded or unimplemented options              |
| [Validation and open questions](05-validation-and-open-questions.md) | Verification results, acceptance checks, and remaining gaps                                            |
| [Sources](06-sources.md)                                             | Upstream references and the distinction between public documentation and private endpoint observations |

Evidence is classified as **verified** (observed), **documented** (supported by an identified source), **proposed** (a recommendation), or **unknown** (not established). Preserve these distinctions when updating references; an implementation or synthetic test does not establish new live Teams behavior.

Research examples use placeholders. Do not add credentials, raw cursors, real chat IDs, private messages, or downloaded images to documentation. Local browser investigation artifacts are not sanitized fixtures or authoritative references.
