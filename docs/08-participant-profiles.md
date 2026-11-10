# Participant names: verified protocol and implementation

Follow-up investigation: **2026-11-05**, one Teams Free personal account. This extends E08 and is recorded as E18 in the evidence ledger. These are private endpoints, not a public Microsoft contract. No private identities or credentials belong in this document.

## Verified reads

The directory returned 15 chats, eight of them one-to-one with two members each and empty titles. Its `users` array remained empty. Member `mri` values are the join keys; do not substitute `objectId`, email, or a last-message sender.

All profile paths below are relative to `https://teams.live.com/api/mt/beta/users/`:

| Operation                 | Method and path          | Observed query                                                                                                                                            |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current user              | `GET me/`                | `skypeTeamsInfo=true&forceRefresh=true&ephemeralMeProfile=false&ggEnabled=true`                                                                           |
| Personal-account profiles | `POST fetchShortProfile` | `isMailAddress=false&enableGuest=true&skypeTeamsInfo=true&canBeSmtpAddress=false&includeIBBarredUsers=false&includeDisabledAccounts=false&ggEnabled=true` |
| Work/school profiles      | `POST fetchFederated`    | `edEnabled=false&includeDisabledAccounts=false`                                                                                                           |

Both POST bodies are JSON arrays of opaque MRI strings, for example `["8:live:example", "8:live:another"]` or `["8:orgid:example"]`. Separate requests by identity family. These POSTs read profiles; they do not modify contacts or messages. Batch size limits were not established. The client uses sequential batches of at most 50 as a conservative implementation default.

The successful minimal replay sent **both** `Authorization: <complete captured Bearer header>` and `x-skypetoken: <captured value>`, plus JSON content type for POSTs. Server-side Fetch supplied no cookies and used no browser request context. Using the Skype token alone failed with 401 for personal profiles and self-profile. Using Bearer authorization alone failed with 401 for both batch routes and self-profile. The successful pair is the required implementation input; do not confuse this `Authorization` header with the history service's `Authentication` header.

Response envelopes have `type` and `value`. Observed `type` strings:

- Self: `Microsoft.Teams.MiddleTier.Tfl.People.Contracts.Models.ConsumerMeProfile`; `value` is an object with `mri` and `displayName`.
- Personal: `Microsoft.SkypeSpaces.MiddleTier.Models.IUserIdentity`; `value` is an array with `mri`, `displayName`, and `status`, plus other fields.
- Federated: `Microsoft.Teams.MiddleTier.People.Contracts.Models.FederatedUser`; `value` is an array. Successful rows include `status: 200`, `mri`, and `displayName`; unsuccessful rows can contain only `status` and `mri`.

Do not treat HTTP 200 as proof that every requested member resolved. Sending all 74 directory members to the federated route returned 67 successful organization profiles and seven personal-identity rows with status 400. This was a routing check, not a recommended listing workflow. The personal route with the observed query resolved all seven personal identities. Omitting its query returned an empty array; necessity of individual flags was not isolated.

The self MRI appeared in all eight one-to-one chats. Excluding it left exactly one counterpart in each: four personal and four organization identities. All eight counterpart names resolved, and all eight matched text visible in the Teams UI. Self-chat labeling, masked/deleted users, unknown identity families, other accounts, and profile expiry/renewal were not verified live.

## Client behavior

Keep `title` as the source title (null when absent). Derive `label` from the counterpart's profile only for untitled one-to-one chats. Named groups retain their titles. An all-self member set uses the self display name with `(You)`; ambiguous membership and unavailable profiles retain explicit unresolved labels. Do not guess from message senders.

`profileAuthorization` is an optional version-1 credential field containing the complete captured Authorization value. The [login command](09-browser-login.md) now captures it and the matching Skype token automatically. Without it, listing still works with directory credentials and emits a warning if names need resolution. Profile HTTP/authentication failures fail the command explicitly, rather than hiding expired credentials behind a successful unresolved list. Missing individual profiles retain fallbacks.

The name cache is separate from the future media cache. Store only self MRI/name, resolved MRI/name pairs, a schema version, credential-scope digest, and fetch time. Never persist bearer tokens, emails, or whole profile payloads in it. The cache lives under `$XDG_CACHE_HOME/teams-chat-download/profiles/` or `~/.cache/teams-chat-download/profiles/`; relative/empty XDG cache home is ignored. Files are private and atomically replaced.

The scope digest includes the local account label and both profile credentials, preventing reuse across different credential sets. Credential renewal therefore starts a new cache even for the same account. Cached snapshots expire after 24 hours; this is a revisable freshness policy, not a server TTL. `chats --refresh-names` bypasses the cache. Invalid cache contents are discarded with a warning; permission and filesystem failures surface explicitly. Concurrent writers can lose cache entries but must never publish partial JSON. No negative profile cache is maintained.

For this account, a cold listing needs four requests: directory, self, personal batch, federated batch. A warm listing needs only the directory request. Only untitled one-to-one counterparts are fetched; do not resolve every group member. Raw-ID exports with an explicit `--out` require no profile reads. Automatic naming for raw-ID exports reads the directory and resolves only the selected chat's label, reusing the same cache; unrelated chat participants are not fetched. Exports using `--chat-label` resolve the directory's labels to find a unique exact match after trimming surrounding whitespace and ignoring case, including when `--out` is supplied. They reuse that matched label for naming without another directory/profile lookup. Selection never reads a saved `chats.json` snapshot, and the profile-cache freshness policy remains unchanged.
