import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Credentials } from "./credentials.ts";
import { AppError, validationError } from "./errors.ts";
import type { Http } from "./http.ts";

const nameSchema = z.strictObject({
  mri: z.string().min(1),
  displayName: z.string().trim().min(1),
});
const selfSchema = z.looseObject({ value: nameSchema.loose() });
const batchSchema = z.looseObject({
  value: z.array(
    z.looseObject({
      mri: z.string().min(1),
      status: z.number().int(),
      displayName: z.string().optional(),
    }),
  ),
});
const cacheSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string(),
  fetchedAt: z.number().int().nonnegative(),
  self: nameSchema,
  names: z.array(nameSchema),
});
type Cache = z.infer<typeof cacheSchema>;
type Chat = {
  id: string;
  title: string | null;
  label: string;
  isOneOnOne: boolean | null;
  members: (string | undefined)[];
};
export type ProfileOptions = {
  cachePath?: string;
  now?: number;
  refresh?: boolean;
  warn?: (message: string) => void;
  signal?: AbortSignal;
};
const ttl = 24 * 60 * 60 * 1000;
const base = "https://teams.live.com/api/mt/beta/users/";
const queries = {
  "me/":
    "skypeTeamsInfo=true&forceRefresh=true&ephemeralMeProfile=false&ggEnabled=true",
  fetchShortProfile:
    "isMailAddress=false&enableGuest=true&skypeTeamsInfo=true&canBeSmtpAddress=false&includeIBBarredUsers=false&includeDisabledAccounts=false&ggEnabled=true",
  fetchFederated: "edEnabled=false&includeDisabledAccounts=false",
};

function scopeFor(credentials: Credentials): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        credentials.accountId,
        credentials.directoryToken,
        credentials.profileAuthorization,
      ]),
    )
    .digest("hex");
}

export function defaultProfileCachePath(credentials: Credentials): string {
  const root = process.env.XDG_CACHE_HOME;
  return join(
    root && isAbsolute(root) ? root : join(homedir(), ".cache"),
    "teams-chat-download",
    "profiles",
    `${scopeFor(credentials)}.json`,
  );
}

async function readCache(
  path: string,
  scope: string,
  now: number,
  warn?: ProfileOptions["warn"],
): Promise<Cache | undefined> {
  let raw: string;
  try {
    const info = await stat(path);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      throw new AppError("Profile cache must be private: run chmod 600 on it.");
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof AppError) throw error;
    throw new AppError("Cannot read profile cache.");
  }
  let cache: Cache;
  try {
    cache = cacheSchema.parse(JSON.parse(raw));
  } catch {
    warn?.("Invalid profile cache discarded; fetching names again.");
    return;
  }
  if (
    cache.scope !== scope ||
    now < cache.fetchedAt ||
    now - cache.fetchedAt >= ttl
  )
    return;
  return cache;
}

async function writeCache(
  path: string,
  cache: Cache,
  signal?: AbortSignal,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    signal?.throwIfAborted();
    await rename(temporary, path);
  } catch {
    throw new AppError(
      signal?.aborted
        ? "Profile lookup cancelled."
        : "Cannot write profile cache.",
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function resolveChatNames(
  http: Http,
  credentials: Credentials,
  chats: Chat[],
  options: ProfileOptions = {},
) {
  const output = chats.map(({ members: _members, ...chat }) => chat);
  const targets = chats.filter((chat) => chat.isOneOnOne && !chat.title);
  if (!targets.length) return output;
  if (!credentials.profileAuthorization || !credentials.directoryToken) {
    options.warn?.(
      "Participant names unresolved. Run teams login to capture profileAuthorization and directoryToken.",
    );
    return output;
  }
  const headers = {
    Authorization: credentials.profileAuthorization,
    "x-skypetoken": credentials.directoryToken,
  };
  async function request(path: keyof typeof queries, members?: string[]) {
    const url = new URL(base + path);
    url.search = queries[path];
    const validate = (destination: URL) => {
      if (
        destination.origin !== url.origin ||
        destination.pathname !== url.pathname ||
        destination.search !== url.search ||
        destination.username ||
        destination.password ||
        destination.hash
      )
        throw new AppError("Refused an unexpected profile destination.");
    };
    return http.json(url, "profiles", headers, validate, members);
  }
  const now = options.now ?? Date.now();
  const scope = scopeFor(credentials);
  const cachePath = options.cachePath ?? defaultProfileCachePath(credentials);
  let cache = options.refresh
    ? undefined
    : await readCache(cachePath, scope, now, options.warn);
  let changed = false;
  if (!cache) {
    const self = selfSchema.safeParse(await request("me/"));
    if (!self.success) throw validationError("Self profile", self.error);
    cache = {
      version: 1,
      scope,
      fetchedAt: now,
      self: {
        mri: self.data.value.mri,
        displayName: self.data.value.displayName,
      },
      names: [],
    };
    changed = true;
  }
  const self = cache.self;
  const names = new Map(
    cache.names.map((profile) => [profile.mri, profile.displayName]),
  );
  function counterpart(chat: Chat): string | undefined {
    // Missing or ambiguous member identity must never become a guessed label.
    if (!chat.members.length || chat.members.some((member) => !member)) return;
    const others = [
      ...new Set(chat.members.filter((member) => member !== self.mri)),
    ];
    return others.length === 0
      ? self.mri
      : others.length === 1
        ? others[0]
        : undefined;
  }
  const missing = [
    ...new Set(
      targets
        .map(counterpart)
        .filter(
          (mri): mri is string => !!mri && mri !== self.mri && !names.has(mri),
        ),
    ),
  ];
  for (const [prefix, path] of [
    ["8:live:", "fetchShortProfile"],
    ["8:orgid:", "fetchFederated"],
  ] as const) {
    const ids = missing.filter((mri) => mri.startsWith(prefix));
    for (let start = 0; start < ids.length; start += 50) {
      const batch = ids.slice(start, start + 50);
      const result = batchSchema.safeParse(await request(path, batch));
      if (!result.success)
        throw validationError("Participant profiles", result.error);
      for (const profile of result.data.value) {
        if (!batch.includes(profile.mri))
          throw new AppError(
            "Profile response contained an unrequested identity.",
          );
        if (profile.status !== 200 || !profile.displayName?.trim()) continue;
        const name = profile.displayName.trim();
        if (names.has(profile.mri) && names.get(profile.mri) !== name)
          throw new AppError(
            "Profile response contained conflicting names for one identity.",
          );
        names.set(profile.mri, name);
        changed = true;
      }
    }
  }
  for (const chat of targets) {
    const mri = counterpart(chat);
    const name =
      mri === self.mri
        ? `${self.displayName} (You)`
        : mri
          ? names.get(mri)
          : undefined;
    const row = output.find((row) => row.id === chat.id);
    if (row && name) row.label = name;
  }
  if (
    targets.some(
      (chat) =>
        output.find((row) => row.id === chat.id)?.label ===
        "Unresolved one-to-one chat",
    )
  )
    options.warn?.(
      "Some participant names could not be resolved; unresolved labels retained.",
    );
  options.signal?.throwIfAborted();
  if (changed)
    await writeCache(
      cachePath,
      {
        ...cache,
        names: [...names].map(([mri, displayName]) => ({ mri, displayName })),
      },
      options.signal,
    );
  return output;
}
