import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Archive,
  isHtmlMessage,
  type Message,
  readArchive,
} from "./archive.ts";
import { imageSourceUrl } from "./media.ts";

function participantMri(source: unknown): string | undefined {
  if (typeof source !== "string") return;
  const supported = /^8:(?:live|orgid):[^\s/?#]+$/;
  if (supported.test(source)) return source;
  try {
    // Source sender links are identifiers here, never request destinations.
    const url = new URL(source);
    const segment = /^\/v1\/users\/ME\/contacts\/([^/]+)$/.exec(
      url.pathname,
    )?.[1];
    if (
      url.protocol !== "https:" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !segment
    )
      return;
    const mri = decodeURIComponent(segment);
    if (supported.test(mri)) return mri;
  } catch {
    // Unknown sender shapes are not guessed into profile identities.
  }
}

export function knownSmokeParticipant(
  sources: unknown[],
  selfMri: string | undefined,
  accountId: string,
): string | undefined {
  // Login account IDs are SHA-256(self MRI). Legacy custom account labels need
  // a successful self read to distinguish the account from other participants.
  if (!selfMri && !/^[a-f0-9]{64}$/.test(accountId)) return;
  for (const source of sources) {
    const mri = participantMri(source);
    if (
      mri &&
      mri !== selfMri &&
      createHash("sha256").update(mri).digest("hex") !== accountId
    )
      return mri;
  }
}

// Limit the real downloader to one supported reference, even if a message has many.
export async function sampleSmokeImage(
  messages: Message[],
): Promise<Message | undefined> {
  for (const message of messages) {
    if (!isHtmlMessage(message) || typeof message.content !== "string")
      continue;
    let selected: URL | undefined;
    await new HTMLRewriter()
      .on("img", {
        element(element) {
          selected ??= imageSourceUrl(element.getAttribute("src") ?? "");
        },
      })
      .transform(new Response(message.content))
      .text();
    if (selected)
      return { ...message, content: `<img src="${selected.href}">` };
  }
}

export async function discoverSmokeFixture(
  root: string,
  accountId: string,
  options: { signal?: AbortSignal; log?: (message: string) => void } = {},
): Promise<{ path: string; archive: Archive } | undefined> {
  if (options.signal?.aborted) return;
  const directory = resolve(root);
  const candidates: { path: string; modified: number }[] = [];
  let skipped = 0;
  try {
    if (!(await lstat(directory)).isDirectory()) {
      options.log?.(
        "Fixture discovery: exports path is not a regular directory; using live discovery.",
      );
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (options.signal?.aborted) return;
      const path = entry.isDirectory()
        ? join(directory, entry.name, "chat.json")
        : entry.isFile() && entry.name.toLowerCase().endsWith(".json")
          ? join(directory, entry.name)
          : undefined;
      if (!path) continue;
      try {
        const info = await lstat(path);
        if (info.isFile()) candidates.push({ path, modified: info.mtimeMs });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") skipped++;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      options.log?.(
        "Fixture discovery: cannot read exports directory; using live discovery.",
      );
    return;
  }
  candidates.sort(
    (a, b) =>
      b.modified - a.modified ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  let selected: { path: string; archive: Archive } | undefined;
  let bestScore = -1;
  for (const candidate of candidates) {
    if (options.signal?.aborted) return;
    try {
      const archive = await readArchive(candidate.path, options.signal);
      if (archive.accountId !== accountId) continue;
      const score =
        Number(
          !!knownSmokeParticipant(
            archive.messages.map((message) => message.from),
            undefined,
            accountId,
          ),
        ) + Number(!!(await sampleSmokeImage(archive.messages)));
      if (score > bestScore) {
        selected = { path: candidate.path, archive };
        bestScore = score;
      }
      if (score === 2) break;
    } catch {
      if (options.signal?.aborted) return;
      skipped++;
    }
  }
  if (skipped)
    options.log?.(
      `Fixture discovery: skipped ${skipped} unreadable or invalid archive(s).`,
    );
  return selected;
}
