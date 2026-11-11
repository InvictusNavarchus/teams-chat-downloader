import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { readArchive, type Message } from "./archive.ts";
import { selectChatByLabel } from "./chat-selection.ts";
import {
  type LiveSmokeOptions,
  resolveLiveSmokeOptions,
} from "./command-validation.ts";
import { defaultExportRoot, defaultLiveSmokeDays } from "./config.ts";
import { loadCredentials, type Credentials } from "./credentials.ts";
import { AppError } from "./errors.ts";
import { createHttp, requestStats, type Fetch, type Http } from "./http.ts";
import { downloadImages } from "./media.ts";
import {
  chatCounterpart,
  labelChats,
  readParticipantProfiles,
  readSelfProfile,
} from "./profiles.ts";
import {
  discoverSmokeFixture,
  knownSmokeParticipant,
  sampleSmokeImage,
} from "./smoke-targets.ts";
import {
  historyProgress,
  readChatDirectory,
  readHistoryPages,
} from "./teams.ts";

type Check = {
  name: string;
  status: "pass" | "fail" | "unverified";
  detail: string;
};

class Unverified extends AppError {}

export async function runLiveSmoke(
  options: LiveSmokeOptions,
  credentials: Credentials,
  dependencies: {
    fetch?: Fetch;
    signal?: AbortSignal;
    log?: (message: string) => void;
    exportsRoot?: string;
  } = {},
) {
  const log = dependencies.log ?? console.log;
  const discovered =
    options.fixture === undefined && !dependencies.signal?.aborted
      ? await discoverSmokeFixture(
          dependencies.exportsRoot ?? defaultExportRoot,
          credentials.accountId,
          { signal: dependencies.signal, log },
        )
      : undefined;
  const fixture =
    options.fixture === undefined
      ? discovered?.archive
      : await readArchive(options.fixture, dependencies.signal);
  if (fixture && fixture.accountId !== credentials.accountId)
    throw new AppError(
      "Fixture account does not match the credentials; choose an archive from the same account.",
    );
  const stats = requestStats();
  const checks: Check[] = [];
  const temporary = await mkdtemp(join(tmpdir(), "teams-live-smoke-"));
  const base = createHttp({
    stats,
    fetch: dependencies.fetch,
    signal: dependencies.signal,
  });
  let hasValidators = false;
  let conditionalSent = false;
  let mediaStatus = 0;
  let mediaHost = "";
  const http: Http = {
    ...base,
    async image(url, headers, validate) {
      mediaHost = url.hostname;
      conditionalSent = !!(
        headers["If-None-Match"] || headers["If-Modified-Since"]
      );
      const response = await base.image(url, headers, validate);
      hasValidators = !!(
        response.headers.get("etag") || response.headers.get("last-modified")
      );
      mediaStatus = response.status;
      return response;
    },
  };
  async function check(name: string, action: () => Promise<string>) {
    let result: Check;
    try {
      if (dependencies.signal?.aborted) throw new Unverified("Cancelled.");
      result = { name, status: "pass", detail: await action() };
    } catch (error) {
      result = {
        name,
        status: error instanceof Unverified ? "unverified" : "fail",
        detail:
          error instanceof AppError ? error.message : "Unexpected failure.",
      };
    }
    checks.push(result);
    log(`[${result.status.toUpperCase()}] ${name}: ${result.detail}`);
    return result.status === "pass";
  }
  let pages: ReturnType<typeof readHistoryPages> | undefined;
  try {
    log(
      fixture
        ? `Fixture: ${options.fixture === undefined ? "auto-selected" : "explicit"} ${options.fixture ?? discovered!.path}.`
        : "Fixture: no usable same-account archive found in exports/; using available live targets.",
    );
    log(
      `History window: ${new Date(options.window.from).toISOString()} (inclusive) to ${new Date(options.window.to).toISOString()} (exclusive).`,
    );
    let chats: Awaited<ReturnType<typeof readChatDirectory>> | undefined;
    await check("directory", async () => {
      chats = await readChatDirectory(http, credentials);
      return `${chats.length} chats; complete directory response.`;
    });
    let self: Awaited<ReturnType<typeof readSelfProfile>> | undefined;
    await check("self profile", async () => {
      self = await readSelfProfile(http, credentials);
      return "Direct self-profile request and payload validated; no directory or cache dependency.";
    });
    let names: Map<string, string> | undefined;
    await check("participant profiles", async () => {
      let ids: string[];
      if (options.chatLabel !== undefined && chats && self) {
        const selfMri = self.mri;
        // Resolve every untitled one-to-one label to detect all collisions.
        ids = [
          ...new Set(
            chats
              .filter((chat) => chat.isOneOnOne && !chat.title)
              .map((chat) => chatCounterpart(chat, selfMri))
              .filter((mri): mri is string => !!mri && mri !== selfMri),
          ),
        ];
      } else {
        const mri = knownSmokeParticipant(
          [
            ...(fixture?.messages.map((message) => message.from) ?? []),
            ...(chats?.flatMap((chat) => chat.members) ?? []),
          ],
          self?.mri,
          credentials.accountId,
        );
        ids = mri ? [mri] : [];
      }
      if (!ids.length) {
        names = new Map();
        throw new Unverified(
          "No known participant identity available; supply a fixture containing a supported sender.",
        );
      }
      names = new Map(
        (await readParticipantProfiles(http, credentials, ids)).map(
          (profile) => [profile.mri, profile.displayName],
        ),
      );
      if (!names.size)
        throw new Unverified("No requested participant name resolved live.");
      return `${names.size} participant name(s) resolved directly without cached names.`;
    });

    const progress = historyProgress();
    const messages: Message[] = [];
    const historyRead = await check("history", async () => {
      let chat = options.chat ?? fixture?.chatId;
      if (options.chatLabel !== undefined) {
        if (!chats)
          throw new Unverified(
            "Label selection needs the directory; use --fixture or --chat for an independent history probe.",
          );
        const needsNames = chats.some((chat) => chat.isOneOnOne && !chat.title);
        if (needsNames && (!self || names === undefined))
          throw new Unverified(
            "Directory label resolution did not succeed; use --fixture or --chat for an independent history probe.",
          );
        chat = selectChatByLabel(
          needsNames ? labelChats(chats, self!, names!) : chats,
          options.chatLabel,
        ).id;
      }
      if (chat === undefined && options.chatLabel === undefined)
        chat = chats?.[0]?.id;
      if (chat === undefined)
        throw new Unverified(
          "No known history target available; create an export or supply --chat or --fixture.",
        );
      pages = readHistoryPages(
        http,
        credentials,
        chat,
        options.window,
        progress,
        undefined,
        { signal: dependencies.signal },
      );
      const page = await pages.next();
      if (!page.done) messages.push(...page.value);
      return `${messages.length} distinct messages on the first page; schema and fixed date bounds validated.`;
    });
    await check("pagination", async () => {
      if (!historyRead || !pages)
        throw new Unverified("First history page did not succeed.");
      const page = await pages.next();
      if (page.done)
        throw new Unverified(
          "First page has no continuation; choose a busier historical window.",
        );
      messages.push(...page.value);
      if (!page.value.length)
        throw new Unverified("Continuation returned no new records.");
      return "Followed a real continuation with new records; stopped after page two.";
    });

    let image: Message | undefined;
    const output = join(temporary, "export", "chat.json");
    const cacheRoot = join(temporary, "media-cache");
    const mediaOptions = { cacheRoot, signal: dependencies.signal };
    const downloaded = await check("media cookie", async () => {
      image =
        (fixture && (await sampleSmokeImage(fixture.messages))) ||
        (await sampleSmokeImage(messages));
      if (!image)
        throw new Unverified(
          "No known supported image reference; supply an image-containing fixture or history window.",
        );
      const media = await downloadImages(
        [image],
        output,
        credentials,
        http,
        mediaOptions,
      );
      if (media.downloaded !== 1 || media.images.length !== 1)
        throw new AppError("Expected exactly one cold image download.");
      return `One live HTTP 200 image from ${mediaHost}; image bytes validated.`;
    });
    await check("media cache", async () => {
      if (!downloaded || !image)
        throw new Unverified("Cold image download did not succeed.");
      const before = stats.total;
      const media = await downloadImages(
        [image],
        output,
        credentials,
        http,
        mediaOptions,
      );
      if (
        media.cacheHits !== 1 ||
        media.downloaded !== 0 ||
        stats.total !== before
      )
        throw new AppError(
          "Expected one verified cache hit with zero requests.",
        );
      return "Validated local reuse with zero HTTP requests.";
    });
    await check("media revalidation", async () => {
      if (!downloaded || !image)
        throw new Unverified("Cold image download did not succeed.");
      if (!hasValidators)
        throw new Unverified(
          "Image supplied no ETag or Last-Modified validator.",
        );
      await downloadImages([image], output, credentials, http, {
        ...mediaOptions,
        refresh: true,
      });
      if (!conditionalSent)
        throw new AppError("Refresh sent no conditional header.");
      return mediaStatus === 304
        ? "Conditional GET returned HTTP 304; validated cached bytes reused."
        : "Conditional GET returned HTTP 200; refreshed image validated (304 branch unverified).";
    });
  } finally {
    try {
      await pages?.return(undefined);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  log(
    `HTTP attempts: ${stats.total} total; directory ${stats.directory}, profiles ${stats.profiles}, history ${stats.history}, media ${stats.media}; retries ${stats.retries}.`,
  );
  return {
    ok: checks.every((item) => item.status === "pass"),
    checks,
    requests: stats,
  };
}

export async function runLiveSmokeCli(argv = process.argv): Promise<number> {
  const cli = cac("test:live");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  let exitCode = 1;
  cli
    .command(
      "",
      `Probe live Teams using automatic archive discovery (default: last ${defaultLiveSmokeDays} local calendar days, including today)`,
    )
    .option("--chat <id>", "Raw chat ID with enough history for two pages")
    .option(
      "--chat-label <label>",
      "Exact resolved chat label (requires live directory/name discovery)",
    )
    .option(
      "--fixture <archive>",
      "Override automatic discovery with a same-account chat.json (choose at most one selector)",
    )
    .option(
      "--from <timestamp>",
      "Inclusive start timestamp with timezone (supply with --to to override default window)",
    )
    .option(
      "--to <timestamp>",
      "Exclusive end timestamp with timezone (supply with --from; default window ends now)",
    )
    .option("--credentials <file>", "Override saved credential lookup")
    .action(async (raw: Record<string, unknown>) => {
      const { "--": _trailing, ...input } = raw;
      const options = resolveLiveSmokeOptions(input);
      const credentials = await loadCredentials(options.credentials);
      const report = await runLiveSmoke(options, credentials, {
        signal: controller.signal,
      });
      exitCode = report.ok ? 0 : 1;
    });
  cli.help();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    cli.parse(argv, { run: false });
    if (cli.options.help) return 0;
    await cli.runMatchedCommand();
    return exitCode;
  } catch (error) {
    // CAC errors may echo user input; only domain errors are safe to print.
    console.error(
      error instanceof AppError
        ? error.message
        : "Live smoke test failed; check arguments and local file access.",
    );
    return 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (import.meta.main) process.exitCode = await runLiveSmokeCli();
