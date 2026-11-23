import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  isHtmlMessage,
  downloadedMediaSchema,
  type ArchiveImage,
  type DownloadedMedia,
  type Message,
} from "./archive.ts";
import type { Credentials } from "./credentials.ts";
import { AppError } from "./errors.ts";
import { ImageResponseError, type Http } from "./http.ts";
import { teamsEmojiText } from "./teams-emoji.ts";

export const mediaOrigins = [
  "https://experimental-api.asm.skype.com",
  "https://us-api.asm.skype.com",
] as const;
const regionalImageOrigin = "https://id-prod.asyncgw.teams.microsoft.com";

// Keep the source identity separate from the authenticated download destination.
export function imageSourceUrl(source: string): URL | undefined {
  try {
    const url = new URL(source);
    const regional = url.origin === regionalImageOrigin;
    if (
      (!regional && !mediaOrigins.some((origin) => origin === url.origin)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        regional
          ? /^\/v1\/objects\/[\w-]+\/views\/imgo$/
          : /^\/v1\/(?:[\w-]+\/)?objects\/[\w-]+\/views\/imgo$/
      ).test(url.pathname)
    )
      return;
    return url;
  } catch {
    return;
  }
}

// Login capture and HTTP validation accept only actual media-cookie destinations.
export function imageUrl(source: string): URL | undefined {
  const url = imageSourceUrl(source);
  if (url && mediaOrigins.some((origin) => origin === url.origin)) return url;
}

export function mediaDirectory(output: string): string {
  return join(dirname(resolve(output)), "media");
}

export function defaultMediaCache(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const cache = env.XDG_CACHE_HOME;
  return join(
    cache && isAbsolute(cache) ? cache : join(home, ".cache"),
    "teams-chat-download",
    "media",
  );
}

const digest = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const cacheSchema = z.object({
  version: z.literal(1),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  extension: z.enum(["jpg", "png", "gif", "webp"]),
  mediaType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  etag: z
    .string()
    .regex(/^[^\r\n]+$/)
    .optional(),
  lastModified: z
    .string()
    .regex(/^[^\r\n]+$/)
    .optional(),
});
type CacheEntry = z.infer<typeof cacheSchema>;
type Image = { entry: CacheEntry; bytes: Uint8Array };

function identify(
  bytes: Uint8Array,
  contentType: string,
): Pick<CacheEntry, "extension" | "mediaType"> {
  const data = Buffer.from(bytes);
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (
    type === "image/jpeg" &&
    data.length >= 5 &&
    data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) &&
    data.subarray(-2).equals(Buffer.from([255, 217]))
  )
    return { extension: "jpg", mediaType: type };
  if (
    type === "image/png" &&
    data.length >= 24 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.subarray(-12, -4).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68]))
  )
    return { extension: "png", mediaType: type };
  if (
    type === "image/gif" &&
    data.length >= 14 &&
    ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString()) &&
    data.at(-1) === 59
  )
    return { extension: "gif", mediaType: type };
  if (
    type === "image/webp" &&
    data.length >= 20 &&
    data.subarray(0, 4).toString() === "RIFF" &&
    data.subarray(8, 12).toString() === "WEBP" &&
    data.readUInt32LE(4) + 8 === data.length
  )
    return { extension: "webp", mediaType: type };
  throw new ImageResponseError(
    "Media response is not a supported complete JPEG, PNG, GIF, or WebP image.",
  );
}

async function cached(cache: string, key: string): Promise<Image | undefined> {
  try {
    const result = cacheSchema.safeParse(
      JSON.parse(await readFile(join(cache, `${key}.json`), "utf8")),
    );
    if (!result.success || result.data.key !== key) return;
    const entry = result.data;
    const bytes = await readFile(
      join(cache, `${entry.sha256}.${entry.extension}`),
    );
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) return;
    const type = identify(bytes, entry.mediaType);
    if (type.extension !== entry.extension) return;
    return { entry, bytes };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== "ENOENT")
      throw new AppError("Cannot read the media cache.");
    // Missing, incomplete, or corrupt entries are cache misses.
  }
}

async function publishCache(
  path: string,
  data: string | Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: "wx", signal });
    signal?.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

type SavedImageOutcome = "cache" | "revalidated" | "downloaded";

export type MediaItemProgress = {
  current: number;
  total: number;
} & ({ outcome: SavedImageOutcome } | { outcome: "failed"; reason: string });

export type MediaProgress =
  | { phase: "start"; total: number }
  | ({ phase: "progress" } & MediaItemProgress);

export class IncompleteImageDownload extends AppError {
  constructor(
    readonly media: DownloadedMedia,
    readonly failedKeys: ReadonlySet<string>,
    readonly reason: string,
  ) {
    super(`${failedKeys.size} image(s) failed. First failure: ${reason}`);
  }
}

// Shared by archive downloads and SQLite indexing; never persist a translated
// destination in place of the source identity used by Markdown and cache keys.
export function messageImageReferences(message: Message): {
  images: { key: string; sourceUrl: string }[];
  unsupported: number;
} {
  const images = new Map<string, string>();
  let inline = 0;
  let unsupported = 0;
  if (isHtmlMessage(message) && typeof message.content === "string") {
    new HTMLRewriter()
      .on("img", {
        element(element) {
          if (teamsEmojiText(element) !== undefined) return;
          inline++;
          const source = imageSourceUrl(element.getAttribute("src") ?? "");
          if (source) images.set(digest(source.href), source.href);
          else unsupported++;
        },
      })
      .transform(message.content);
  }
  if (inline === 0 && Array.isArray(message.amsreferences))
    unsupported += message.amsreferences.length;
  return {
    images: [...images].map(([key, sourceUrl]) => ({ key, sourceUrl })),
    unsupported,
  };
}

// Collection bytes are durable independently of the disposable shared cache.
// Validate both metadata and disk contents before skipping a download or export.
export async function readStoredImage(
  directory: string,
  image: ArchiveImage,
  allowLegacyPath = false,
): Promise<Uint8Array | undefined> {
  const parsed = downloadedMediaSchema.safeParse({
    status: "complete",
    cacheHits: 0,
    downloaded: 0,
    unsupported: 0,
    images: [image],
  });
  if (!parsed.success) throw new AppError("Stored image metadata is invalid.");
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new AppError(
        "Saved image directory must be a directory without symlinks.",
      );
    const file = join(directory, basename(image.path));
    const info = await lstat(file);
    if (!info.isFile())
      throw new AppError(
        "Saved image must be a regular file without symlinks.",
      );
    if (info.size !== image.bytes || info.size > 50 * 1024 * 1024) return;
    const bytes = await readFile(file);
    if (digest(bytes) !== image.sha256) return;
    let type;
    try {
      type = identify(bytes, image.mediaType);
    } catch {
      return;
    }
    if (
      image.path !== `media/${image.sha256}.${type.extension}` &&
      !(
        allowLegacyPath && image.path === `media/${image.key}.${type.extension}`
      )
    )
      return;
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof AppError) throw error;
    throw new AppError("Could not read saved image bytes.");
  }
}

export async function downloadImages(
  messages: Message[],
  output: string,
  credentials: Credentials,
  http: Http,
  options: {
    refresh?: boolean;
    cacheRoot?: string;
    signal?: AbortSignal;
    onProgress?: (progress: MediaProgress) => void;
    onSummary?: (message: string) => void;
    // Database callers save bytes beside SQLite; descriptors retain portable paths.
    directory?: string;
    onImage?: (image: ArchiveImage) => void;
    onImageFailure?: (key: string, reason: string) => void;
    unavailableOrigins?: Map<string, ImageResponseError>;
    // References already classified by the SQLite index, outside this work list.
    unsupported?: number;
  } = {},
): Promise<DownloadedMedia> {
  const media: DownloadedMedia = {
    status: "complete",
    images: [],
    cacheHits: 0,
    downloaded: 0,
    unsupported: options.unsupported ?? 0,
  };
  const resources = new Map<string, { url: URL; messages: Set<string> }>();
  for (const message of messages) {
    const references = messageImageReferences(message);
    media.unsupported += references.unsupported;
    for (const { key, sourceUrl } of references.images) {
      const source = new URL(sourceUrl);
      let resource = resources.get(key);
      if (!resource) {
        const url =
          source.origin === regionalImageOrigin
            ? new URL(source.pathname, mediaOrigins[0])
            : source;
        resource = { url, messages: new Set() };
        resources.set(key, resource);
      }
      resource.messages.add(message.id);
    }
    options.signal?.throwIfAborted();
  }
  if (media.unsupported) media.status = "partial";
  const cache = join(
    options.cacheRoot ?? defaultMediaCache(),
    digest(credentials.accountId),
  );
  let completed = 0;
  let revalidated = 0;
  const failed = new Set<string>();
  let firstFailure: string | undefined;
  const unavailableOrigins = options.unavailableOrigins ?? new Map();
  if (resources.size > 0) {
    options.onProgress?.({ phase: "start", total: resources.size });
  }
  try {
    // Storage, checkpoint, and cancellation errors still stop the queue.
    for (const [key, resource] of resources) {
      options.signal?.throwIfAborted();
      let image = await cached(cache, key);
      let outcome: SavedImageOutcome;
      if (image && !options.refresh) {
        outcome = "cache";
      } else {
        try {
          ({ image, outcome } = await fetchImage(key, resource.url, image));
        } catch (error) {
          options.signal?.throwIfAborted();
          if (!(error instanceof ImageResponseError)) throw error;
          if (error.status === 401 || error.status === 429)
            unavailableOrigins.set(resource.url.origin, error);
          failed.add(key);
          firstFailure ??= error.message;
          options.onImageFailure?.(key, error.message);
          options.onProgress?.({
            phase: "progress",
            current: completed + failed.size,
            total: resources.size,
            outcome: "failed",
            reason: error.message,
          });
          continue;
        }
      }
      const directory = options.directory ?? mediaDirectory(output);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory())
        throw new AppError(
          "Export media path must be a directory; symbolic links are refused.",
        );
      // Content-based paths keep an earlier manifest valid if a refresh fails later.
      const name = `${image.entry.sha256}.${image.entry.extension}`;
      await publishCache(join(directory, name), image.bytes, options.signal);
      for (const messageId of resource.messages) {
        media.images.push({
          messageId,
          key,
          path: `media/${name}`,
          bytes: image.entry.bytes,
          sha256: image.entry.sha256,
          mediaType: image.entry.mediaType,
        });
      }
      options.onImage?.(media.images.at(-1)!);
      if (outcome === "downloaded") media.downloaded++;
      else media.cacheHits++;
      if (outcome === "revalidated") revalidated++;
      completed++;
      options.onProgress?.({
        phase: "progress",
        current: completed + failed.size,
        total: resources.size,
        outcome,
      });
    }
    options.signal?.throwIfAborted();
    if (firstFailure !== undefined) {
      media.status = "partial";
      throw new IncompleteImageDownload(media, failed, firstFailure);
    }
    return media;
  } catch (error) {
    if (options.signal?.aborted)
      throw new AppError("Export cancelled; completed images and cache kept.");
    if (error instanceof AppError) throw error;
    throw new AppError(
      "Could not save export images; completed images and cache kept.",
    );
  } finally {
    (options.onSummary ?? console.log)(
      `Images: ${completed} saved, ${failed.size} failed, ${resources.size - completed - failed.size} unfinished; ${media.cacheHits - revalidated} reused from local cache, ${revalidated} revalidated with Teams (HTTP 304), ${media.downloaded} downloaded (HTTP 200); unsupported media references: ${media.unsupported}.`,
    );
  }

  async function fetchImage(
    key: string,
    url: URL,
    previous?: Image,
  ): Promise<{ image: Image; outcome: "downloaded" | "revalidated" }> {
    const unavailable = unavailableOrigins.get(url.origin);
    if (unavailable)
      throw new ImageResponseError(
        `Skipped request to ${url.hostname}. ${unavailable.message}`,
      );
    const cookie =
      credentials.mediaCookies?.[url.origin as (typeof mediaOrigins)[number]];
    if (!cookie) {
      const error = new ImageResponseError(
        "Image credentials are missing. Run teams login --wait-for-media and open an image-containing chat, or use --no-media.",
      );
      unavailableOrigins.set(url.origin, error);
      throw error;
    }
    const headers: Record<string, string> = {
      Cookie: `skypetoken_asm=${cookie}`,
    };
    if (previous?.entry.etag) headers["If-None-Match"] = previous.entry.etag;
    else if (previous?.entry.lastModified)
      headers["If-Modified-Since"] = previous.entry.lastModified;
    const response = await http.image(url, headers, (destination) => {
      if (!imageUrl(destination.href) || destination.href !== url.href)
        throw new AppError("Refused an unexpected media destination.");
    });
    if (response.status === 304) {
      if (!previous)
        throw new ImageResponseError(
          "Media returned 304 without a complete cached image.",
        );
      return { image: previous, outcome: "revalidated" };
    }
    if (response.status !== 200)
      throw new ImageResponseError(
        "Media did not return a complete image (HTTP 200 required).",
      );
    const type = identify(
      response.bytes,
      response.headers.get("content-type") ?? "",
    );
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    const entry: CacheEntry = {
      version: 1,
      key,
      ...type,
      sha256: digest(response.bytes),
      bytes: response.bytes.length,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
    if (!cacheSchema.safeParse(entry).success)
      throw new ImageResponseError("Media returned invalid cache validators.");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    await publishCache(
      join(cache, `${entry.sha256}.${entry.extension}`),
      response.bytes,
      options.signal,
    );
    await publishCache(
      join(cache, `${key}.json`),
      JSON.stringify(entry),
      options.signal,
    );
    return { image: { entry, bytes: response.bytes }, outcome: "downloaded" };
  }
}
