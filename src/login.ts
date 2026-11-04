import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BrowserContext, BrowserType, Response } from "playwright-core";
import { z } from "zod";
import {
  defaultCredentialsPath,
  saveCredentials,
  type Credentials,
} from "./credentials.ts";
import { AppError, validationError } from "./errors.ts";
import { createHttp, type Fetch, type RequestStats } from "./http.ts";
import { imageUrl, mediaOrigins } from "./media.ts";
import { listChats, readHistory } from "./teams.ts";

const optionsSchema = z.strictObject({
  credentials: z.string().min(1).optional(),
  browser: z.string().min(1).optional(),
  browserProfile: z.string().min(1).optional(),
  media: z.boolean().default(false),
  timeout: z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(1).max(3600))
    .default(600),
});
export type LoginOptions = {
  credentials: string;
  browser?: string;
  browserProfile: string;
  timeout: number;
  media?: boolean;
};
type LaunchOptions = Parameters<BrowserType["launchPersistentContext"]>[1];
type Launch = (
  profile: string,
  options: LaunchOptions,
) => Promise<BrowserContext>;

export function resolveLoginOptions(input: unknown): LoginOptions {
  const result = optionsSchema.safeParse(input);
  if (!result.success) throw validationError("Login options", result.error);
  const options = result.data;
  return {
    credentials: resolve(options.credentials ?? defaultCredentialsPath()),
    browser:
      options.browser ??
      [
        "chromium-browser",
        "chromium",
        "google-chrome",
        "google-chrome-stable",
        "msedge",
      ]
        .map((name) => Bun.which(name))
        .find((path) => path !== null),
    browserProfile: resolve(
      options.browserProfile ??
        join(dirname(defaultCredentialsPath()), "browser"),
    ),
    timeout: options.timeout,
    media: options.media,
  };
}

export function loginLaunchOptions(
  options: LoginOptions,
  env: NodeJS.ProcessEnv = process.env,
): LaunchOptions {
  return {
    executablePath: options.browser,
    headless: false,
    chromiumSandbox: true,
    args: env.WAYLAND_DISPLAY ? ["--ozone-platform=wayland"] : [],
    handleSIGINT: false,
    handleSIGTERM: false,
    timeout: Math.min(options.timeout * 1000, 30_000),
  };
}

async function launch(
  profile: string,
  options: LaunchOptions,
): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  return chromium.launchPersistentContext(profile, options);
}

function waitForMedia(
  context: BrowserContext,
  signal: AbortSignal,
): Promise<NonNullable<Credentials["mediaCookies"]>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      context.off("response", onResponse);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const observe = async (response: Response) => {
      if (
        signal.aborted ||
        response.status() !== 200 ||
        response.request().method() !== "GET"
      )
        return;
      const url = imageUrl(response.url());
      if (!url) return;
      const cookies = await context.cookies(url.href);
      const cookie = cookies.find(
        (cookie) =>
          cookie.name === "skypetoken_asm" &&
          (cookie.expires === -1 || cookie.expires > Date.now() / 1000) &&
          ["/", "/v1", "/v1/"].includes(cookie.path),
      );
      if (!cookie || signal.aborted) return;
      cleanup();
      resolve({ [url.origin]: cookie.value });
    };
    const onResponse = (response: Response) => {
      void observe(response).catch(() => {});
    };
    context.on("response", onResponse);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function capture(
  context: BrowserContext,
  signal: AbortSignal,
  progress: (message: string) => void,
): Promise<Credentials> {
  return new Promise((resolve, reject) => {
    let history: string | undefined;
    let pair:
      | { directoryToken: string; profileAuthorization: string }
      | undefined;
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => {
      context.off("response", onResponse);
      signal.removeEventListener("abort", abort);
    };
    const observe = async (response: Response) => {
      if (signal.aborted || response.status() < 200 || response.status() >= 300)
        return;
      const url = new URL(response.url());
      if (url.origin !== "https://teams.live.com") return;
      const request = response.request();
      const isHistory =
        request.method() === "GET" &&
        url.pathname.startsWith("/api/chatsvc/consumer/v1/");
      const isProfile =
        (request.method() === "GET" &&
          url.pathname === "/api/mt/beta/users/me/") ||
        (request.method() === "POST" &&
          [
            "/api/mt/beta/users/fetchShortProfile",
            "/api/mt/beta/users/fetchFederated",
          ].includes(url.pathname));
      if (!isHistory && !isProfile) return;
      const headers = await request.allHeaders();
      if (signal.aborted) return;
      if (isHistory && headers.authentication && !history) {
        history = headers.authentication;
        progress("Captured history authentication.");
      }
      if (
        isProfile &&
        headers.authorization &&
        headers["x-skypetoken"] &&
        !pair
      ) {
        pair = {
          directoryToken: headers["x-skypetoken"],
          profileAuthorization: headers.authorization,
        };
        progress("Captured directory and profile authentication.");
      }
      if (history && pair) {
        cleanup();
        resolve({
          version: 1,
          accountId: "pending-verification",
          historyAuthentication: history,
          ...pair,
        });
      }
    };
    // A response can disappear during navigation/closing; continue observing fresh requests.
    const onResponse = (response: Response) => {
      void observe(response).catch(() => {});
    };
    context.on("response", onResponse);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function login(
  options: LoginOptions,
  dependencies: {
    stats: RequestStats;
    signal?: AbortSignal;
    progress?: (message: string) => void;
    fetch?: Fetch;
    launch?: Launch;
  },
) {
  const stopped = new AbortController();
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, stopped.signal])
    : stopped.signal;
  const timer = setTimeout(
    () =>
      stopped.abort(
        new AppError(
          "Login timed out. Run teams login again; sign in and open a chat to generate service requests.",
        ),
      ),
    options.timeout * 1000,
  );
  const progress = dependencies.progress ?? (() => {});
  let context: BrowserContext | undefined;
  const closeOnAbort = () => {
    void context?.close().catch(() => {});
  };
  const closed = () =>
    stopped.abort(
      new AppError("Login browser closed before credentials were saved."),
    );
  try {
    signal.throwIfAborted();
    await mkdir(options.browserProfile, { recursive: true, mode: 0o700 });
    if (
      process.platform !== "win32" &&
      ((await stat(options.browserProfile)).mode & 0o077) !== 0
    )
      throw new AppError(
        "Browser profile must be private: run chmod 700 on its directory.",
      );
    progress(
      "Opening the Teams login browser. Sign in there; open a chat if capture is waiting for history. Passwords and verification codes stay in the browser.",
    );
    try {
      context = await (dependencies.launch ?? launch)(
        options.browserProfile,
        loginLaunchOptions(options),
      );
    } catch {
      throw new AppError(
        "Could not open the login browser. Check --browser, your display session, and that no other browser is using --browser-profile.",
      );
    }
    signal.throwIfAborted();
    context.on("close", closed);
    signal.addEventListener("abort", closeOnAbort, { once: true });
    const captured = capture(context, signal, progress);
    // Attach a handler before navigation so cancellation cannot become an unhandled rejection.
    void captured.catch(() => {});
    const page = context.pages()[0] ?? (await context.newPage());
    try {
      await page.goto("https://teams.live.com/v2/", {
        waitUntil: "domcontentloaded",
        timeout: Math.min(options.timeout * 1000, 60_000),
      });
    } catch {
      signal.throwIfAborted();
      throw new AppError(
        "Could not open Teams in the login browser. Check connectivity and run teams login again.",
      );
    }
    const credentials = await captured;
    progress(
      "Checking captured credentials with HTTP. Browser traffic is outside these request counters.",
    );
    const http = createHttp({
      stats: dependencies.stats,
      signal,
      fetch: dependencies.fetch,
    });
    const selfUrl = new URL(
      "https://teams.live.com/api/mt/beta/users/me/?skypeTeamsInfo=true&forceRefresh=true&ephemeralMeProfile=false&ggEnabled=true",
    );
    const validateSelf = (url: URL) => {
      if (url.href !== selfUrl.href)
        throw new AppError("Refused an unexpected login profile destination.");
    };
    const self = z
      .looseObject({ value: z.looseObject({ mri: z.string().min(1) }) })
      .safeParse(
        await http.json(
          selfUrl,
          "profiles",
          {
            Authorization: credentials.profileAuthorization!,
            "x-skypetoken": credentials.directoryToken!,
          },
          validateSelf,
        ),
      );
    if (!self.success) throw validationError("Login self profile", self.error);
    credentials.accountId = createHash("sha256")
      .update(self.data.value.mri)
      .digest("hex");
    const chats = await listChats(http, {
      ...credentials,
      profileAuthorization: undefined,
    });
    if (chats.length) {
      const now = Date.now();
      await readHistory(http, credentials, chats[0]!.id, {
        from: now - 1,
        to: now,
      });
    } else {
      const url = new URL(
        "https://teams.live.com/api/chatsvc/consumer/v1/users/ME/properties",
      );
      await http.json(
        url,
        "history",
        { Authentication: credentials.historyAuthentication! },
        (destination) => {
          if (destination.href !== url.href)
            throw new AppError(
              "Refused an unexpected login history destination.",
            );
        },
      );
    }
    const mediaCookies: NonNullable<Credentials["mediaCookies"]> = {};
    for (const origin of mediaOrigins) {
      // Ask the browser jar for this service URL; never copy unrelated cookies.
      const cookies = await context.cookies(`${origin}/v1/`);
      const cookie = cookies.find(
        (cookie) =>
          cookie.name === "skypetoken_asm" &&
          (cookie.expires === -1 || cookie.expires > Date.now() / 1000),
      );
      if (cookie) mediaCookies[origin] = cookie.value;
    }
    if (options.media && !Object.keys(mediaCookies).length) {
      progress(
        "Waiting for image access. Open an image-containing chat in the login browser.",
      );
      Object.assign(mediaCookies, await waitForMedia(context, signal));
    }
    if (Object.keys(mediaCookies).length) {
      credentials.mediaCookies = mediaCookies;
      progress(
        "Captured service-scoped image cookies. Image access is checked when exporting.",
      );
    } else {
      progress(
        "No image cookie available yet. Run teams login --media to wait for image access, or export with --no-media.",
      );
    }
    signal.throwIfAborted();
    await saveCredentials(options.credentials, credentials, signal);
    return {
      credentials: options.credentials,
      browserProfile: options.browserProfile,
      status: "saved" as const,
    };
  } catch (error) {
    if (signal.aborted) {
      if (signal.reason instanceof AppError) throw signal.reason;
      throw new AppError("Login cancelled; previous credentials kept.");
    }
    if (error instanceof AppError) throw error;
    throw new AppError("Login failed; previous credentials kept.");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", closeOnAbort);
    stopped.abort();
    if (context) {
      context.off("close", closed);
      await context.close().catch(() => {});
    }
  }
}
