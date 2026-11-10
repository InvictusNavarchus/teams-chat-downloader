import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cac } from "cac";
import { isHtmlMessage, type Message } from "./archive.ts";
import { selectChatByLabel } from "./chat-selection.ts";
import {
  type LiveSmokeOptions,
  resolveLiveSmokeOptions,
} from "./command-validation.ts";
import { loadCredentials, type Credentials } from "./credentials.ts";
import { AppError } from "./errors.ts";
import { createHttp, requestStats, type Fetch, type Http } from "./http.ts";
import { downloadImages, imageUrl } from "./media.ts";
import { resolveChatNames } from "./profiles.ts";
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

// Limit the real downloader to one supported reference, even if a message has many.
async function sampleImage(messages: Message[]): Promise<Message | undefined> {
  for (const message of messages) {
    if (!isHtmlMessage(message) || typeof message.content !== "string")
      continue;
    let selected: URL | undefined;
    await new HTMLRewriter()
      .on("img", {
        element(element) {
          selected ??= imageUrl(element.getAttribute("src") ?? "");
        },
      })
      .transform(new Response(message.content))
      .text();
    if (selected)
      return { ...message, content: `<img src="${selected.href}">` };
  }
}

export async function runLiveSmoke(
  options: LiveSmokeOptions,
  credentials: Credentials,
  dependencies: {
    fetch?: Fetch;
    signal?: AbortSignal;
    log?: (message: string) => void;
  } = {},
) {
  const stats = requestStats();
  const checks: Check[] = [];
  const log = dependencies.log ?? console.log;
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
  let participantRequested = false;
  const http: Http = {
    ...base,
    async json(url, purpose, headers, validate, readBody) {
      const response = await base.json(
        url,
        purpose,
        headers,
        validate,
        readBody,
      );
      if (purpose === "profiles" && readBody?.length)
        participantRequested = true;
      return response;
    },
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
  try {
    let chats: Awaited<ReturnType<typeof readChatDirectory>> | undefined;
    await check("directory", async () => {
      chats = await readChatDirectory(http, credentials);
      return `${chats.length} chats; complete directory response.`;
    });
    let resolvedChats: Awaited<ReturnType<typeof resolveChatNames>> | undefined;
    await check("profiles", async () => {
      if (!chats) throw new Unverified("Directory lookup did not succeed.");
      const target = chats.find(
        (chat) => chat.isOneOnOne && !chat.title && chat.members.length >= 2,
      );
      // Label selection needs every resolvable label to detect collisions, even
      // between titled groups and untitled one-to-one chats.
      const profileChats =
        options.chatLabel !== undefined ? chats : target ? [target] : [];
      resolvedChats = await resolveChatNames(http, credentials, profileChats, {
        refresh: true,
        cachePath: join(temporary, "profiles.json"),
        signal: dependencies.signal,
      });
      if (!credentials.profileAuthorization)
        throw new AppError("Profile credentials missing; run teams login.");
      if (!target)
        throw new Unverified(
          "No untitled one-to-one chat available for a participant lookup.",
        );
      if (
        resolvedChats.find((chat) => chat.id === target.id)?.label ===
          "Unresolved one-to-one chat" ||
        !participantRequested
      )
        throw new Unverified(
          "Self profile checked, but no participant name resolved live.",
        );
      return options.chatLabel !== undefined
        ? "Directory labels resolved with a fresh cache; self profile and participant name checked live."
        : "Self profile and one participant name resolved with a fresh cache.";
    });

    const progress = historyProgress();
    const messages: Message[] = [];
    let secondPageAdded = 0;
    const historyRead = await check("history", async () => {
      let chat = options.chat;
      if (options.chatLabel !== undefined) {
        if (!resolvedChats)
          throw new Unverified("Directory label resolution did not succeed.");
        chat = selectChatByLabel(resolvedChats, options.chatLabel).id;
      }
      if (chat === undefined)
        throw new AppError(
          "Choose exactly one of --chat <id> or --chat-label <label>.",
        );
      if (chats && !chats.some((item) => item.id === chat))
        throw new AppError(
          "Selected chat is absent from the current directory.",
        );
      for await (const page of readHistoryPages(
        http,
        credentials,
        chat,
        options.window,
        progress,
        undefined,
        { signal: dependencies.signal },
      )) {
        messages.push(...page);
        if (progress.pages === 2) {
          secondPageAdded = page.length;
          break;
        }
      }
      return `${progress.pages} page(s), ${messages.length} distinct messages; schemas and fixed date bounds validated.`;
    });
    await check("pagination", async () => {
      if (!historyRead)
        throw new Unverified("History sampling did not succeed.");
      if (progress.pages !== 2 || secondPageAdded === 0)
        throw new Unverified(
          "Two validated pages with new records required; choose a busier historical window.",
        );
      return "Followed a real continuation with new records; stopped after page two.";
    });

    let image: Message | undefined;
    const output = join(temporary, "export", "chat.json");
    const cacheRoot = join(temporary, "media-cache");
    const mediaOptions = { cacheRoot, signal: dependencies.signal };
    const downloaded = await check("media cookie", async () => {
      if (!historyRead && messages.length === 0)
        throw new Unverified(
          "No validated history sample available for media checks.",
        );
      image = await sampleImage(messages);
      if (!image)
        throw new Unverified(
          "No supported image in the two-page sample; choose an image-containing historical window.",
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
    await rm(temporary, { recursive: true, force: true });
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
      "Probe saved credentials, two history pages and one image against live Teams",
    )
    .option("--chat <id>", "Raw chat ID with enough history for two pages")
    .option(
      "--chat-label <label>",
      "Exact resolved chat label (choose this or --chat)",
    )
    .option(
      "--from <timestamp>",
      "Inclusive historical start (timestamp with timezone)",
    )
    .option(
      "--to <timestamp>",
      "Exclusive historical end (timestamp with timezone)",
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
