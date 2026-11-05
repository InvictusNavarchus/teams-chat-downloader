# Image export and cache

Implemented **2026-11-05**, with synthetic HTTP and filesystem coverage. The historical [media experiment](02-http-protocol.md#7-images-and-other-media) established a separate media cookie and one JPEG response; it did not establish universal media discovery. Inspection of saved source exports also found inline `https://us-api.asm.skype.com/v1/objects/{id}/views/imgo` URLs alongside opaque `amsreferences` strings. No new live authenticated image export or login-cookie capture has been performed for this implementation.

## Export contract

`export` downloads supported images by default, after collecting the selected window's history. `--no-media` retains the previous text-only behavior. `--refresh-media` explicitly bypasses default cache reuse and cannot be combined with `--no-media`. Only HTML messages are parsed for `<img src>`; literal Text messages stay literal. Parsing uses [Bun HTMLRewriter](https://bun.sh/docs/runtime/html-rewriter), including entity decoding and quoted/unquoted attributes.

Supported URLs use HTTPS on exactly `us-api.asm.skype.com` or `experimental-api.asm.skype.com`, with `/v1/[namespace/]objects/{object}/views/imgo`. Namespace and object segments use letters, numbers, underscores, or hyphens. URLs containing user information, query strings, fragments, other hosts, or other views are unsupported. Opaque references are never converted into guessed URLs. References without inline images count as unsupported; HTML images with unsupported destinations count individually. When inline images exist, opaque reference arrays are retained without separately interpreting their entries.

JSON remains version 1, preserves source messages, and adds a media manifest:

- `status`: `complete` when all discovered references are supported, or `partial` when unsupported references exist. This is separate from completed history retrieval. `--no-media` uses `not-downloaded`.
- `cacheHits`, `downloaded`: distinct supported image keys reused or fetched, including explicit refresh results.
- `unsupported`: unresolved reference count.
- `images`: message ID, logical key, relative local path, byte length, SHA-256 digest, and media type. Repeated appearances of one image in a message share one mapping.

Each export uses a dedicated directory containing `chat.json`, optional `chat.md`, and `media/<key>.<extension>`. Export `--out <directory>` chooses this folder; the default folder name combines the chat label and period under `exports/`. Private directories and files use modes 700/600 when created. No image directory is created for an empty supported set. Existing export directories are refused before retrieval. After history retrieval, the command exclusively creates its directory so concurrent exports cannot share a destination. Images are available before JSON publication. Any media or JSON-publication failure removes this attempt's whole export directory and keeps completed cached images. A crash may leave an incomplete export directory; choose a new output path or inspect it before removing it manually. No durable history checkpoint or automatic orphan cleanup is implemented.

Unsupported media does not fail history export: it is explicitly partial in the media manifest, counted on stderr, and uses rendering placeholders. Actual download/authentication/write failures fail the command. Markdown failure after JSON publication keeps the JSON and its images for offline conversion.

## Credentials and HTTP

The optional version-1 credential field `mediaCookies` maps each allowed origin to the cookie **value**, without the `skypetoken_asm=` prefix. `login` asks its own browser jar for cookies applicable to each origin's `/v1/` URL after normal profile/directory/history verification; only unexpired or session `skypetoken_asm` cookies are retained. No unrelated cookies are persisted. An ordinary login without media cookies still succeeds with a diagnostic. `login --wait-for-media` waits when none are available, asking the user to open an image-containing chat. A successful supported image GET triggers a cookie lookup for that exact URL; reusable cookies must be scoped to `/`, `/v1`, or `/v1/`. The login timeout and cancellation still apply. An uncached image without its origin's cookie fails with instructions to run `login --wait-for-media` or use `--no-media`.

Cookie presence is not an image-access verification. Export supplies only `Cookie: skypetoken_asm=<value>` to the matching origin and exact validated image URL. History/profile/directory credentials are never sent to media hosts. Media cookies are never sent to Teams history routes. Redirects are refused, including same-origin redirects. Credentials, source URLs, and response bodies are excluded from new media metadata and diagnostics; canonical source messages remain unchanged and may themselves contain source URLs.

Media uses the shared Ky retry policy, cancellation, timeouts, and attempt counters. `media` is a separate request-purpose counter. Downloads are sequential and buffer at most one response at a time, capped at 50 MiB after decompression. HTTP 200 is required for a fetched image. JPEG/PNG/GIF/WebP content types must match basic signatures and container endings/lengths. This is not a full image decode or a guarantee against every malformed container. SVG, HTML login responses, empty bodies, partial-content responses, and obvious truncation are rejected.

## Cache and refresh

The default root is `$XDG_CACHE_HOME/teams-chat-download/media`, falling back to `~/.cache/teams-chat-download/media` for unset, empty, or relative XDG values. A SHA-256 digest of the stable account label selects an account directory. A logical key hashes the complete allowed origin and path, including namespace, object ID, and `imgo` representation. Query-bearing URLs are unsupported rather than stripping unknown version or authentication parameters. Different hosts remain separate keys.

Each key has an independent versioned JSON metadata file; bodies are named by content digest and extension. Metadata includes key, type, size, digest, and optional ETag/Last-Modified. Writes use private temporary files and atomic rename, publishing the complete body before metadata. Independent entries avoid a shared index and its lost-update race. Concurrent readers see complete old or new entries; concurrent refreshes use the last published entry. Superseded bodies are retained; cache eviction is not implemented.

A hit requires valid metadata, a present body, matching byte length and digest, and matching type/signature checks. Complete hits perform no HTTP request, including no HEAD, and require no current media cookie. Missing/corrupt entries miss the cache. Other filesystem errors fail explicitly. Repeated logical keys download once per invocation. Local copies keep export contents independent of later cache changes or deletion.

Explicit refresh sends `If-None-Match` when an ETag exists, otherwise `If-Modified-Since` when Last-Modified exists. Without a validator, refresh is unconditional. A `304` reuses the already loaded, verified body; deleting the cache body while the request is in flight cannot remove those bytes. A `304` without a valid cached body fails. Missing/corrupt bodies start with an unconditional request. A `200` replaces the mapping only after validation and complete cache publication; a failed refresh keeps the old entry usable. Default reuse prioritizes avoiding repeat requests and can retain stale remote images until explicit refresh.

## Offline rendering and limits

The archive reader validates version-1 manifests and image fields. Image paths must be `media/<hash>.<extension>`; absolute and parent-traversal paths are rejected. Markdown matches local images by source message identity and normalized source-URL digest, so hidden or removed HTML nodes cannot shift later image mappings. Alternative Markdown destinations rebase links to the original image directory without network requests or file copying.

Supported formats and paths do not imply original-upload fidelity, all-image discovery, video/file support, stickers/cards/replies coverage, signed-URL handling, deleted-image recovery, cookie renewal, or support for every region. Cold live download, live login-cookie capture, and behavior on other accounts remain to be checked through ordinary authorized usage.
