import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  BrowserContext,
  Response as BrowserResponse,
} from "playwright-core";
import {
  defaultCredentialsPath,
  loadCredentials,
  saveCredentials,
} from "../src/credentials.ts";
import { requestStats, type Fetch } from "../src/http.ts";
import {
  login,
  loginLaunchOptions,
  resolveLoginOptions,
  type LoginOptions,
} from "../src/login.ts";

const history = "history-secret";
const skype = "skype-secret";
const authorization = "Bearer profile-secret";
const mri = "8:live:synthetic-self";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

class Browser extends EventEmitter {
  closed = false;
  navigate: () => Promise<void> = async () => {
    this.capture();
  };
  context() {
    return this as unknown as BrowserContext;
  }
  pages() {
    return [{ goto: async () => this.navigate() }];
  }
  async close() {
    this.closed = true;
    this.emit("close");
  }
  response(
    path: string,
    headers: Record<string, string>,
    status = 200,
    method = "GET",
    origin = "https://teams.live.com",
  ) {
    this.emit("response", {
      url: () => origin + path,
      status: () => status,
      request: () => ({
        method: () => method,
        allHeaders: async () => headers,
      }),
    } as unknown as BrowserResponse);
  }
  capture() {
    this.response(
      "/api/chatsvc/consumer/v1/users/ME/streams/notifications/messages",
      { authentication: history },
    );
    this.response(
      "/api/mt/beta/users/fetchShortProfile",
      { authorization, "x-skypetoken": skype },
      200,
      "POST",
    );
  }
}

async function fixture(empty = false) {
  const dir = await mkdtemp(join(tmpdir(), "teams-login-test-"));
  dirs.push(dir);
  const options: LoginOptions = {
    credentials: join(dir, "credentials.json"),
    browserProfile: join(dir, "browser"),
    timeout: 10,
    browser: "/fixture/chromium",
  };
  const browser = new Browser();
  const stats = requestStats();
  const requests: Request[] = [];
  const messages: string[] = [];
  const fetch: Fetch = async (request) => {
    requests.push(request);
    const url = new URL(request.url);
    expect(request.redirect).toBe("manual");
    if (url.pathname.includes("/api/mt/")) {
      expect(request.headers.get("authorization")).toBe(authorization);
      expect(request.headers.get("x-skypetoken")).toBe(skype);
      expect(request.headers.has("authentication")).toBe(false);
      return Response.json({ value: { mri } });
    }
    if (url.pathname.includes("/api/csa/")) {
      expect(request.headers.get("x-skypetoken")).toBe(skype);
      expect(request.headers.has("authorization")).toBe(false);
      return Response.json({
        chats: empty ? [] : [{ id: "synthetic-chat", title: "Group" }],
        metadata: { hasMoreChats: false, isPartialData: false },
      });
    }
    expect(request.headers.get("Authentication")).toBe(history);
    expect(request.headers.has("authorization")).toBe(false);
    return url.pathname.endsWith("/properties")
      ? Response.json({ properties: [] })
      : Response.json({ messages: [], _metadata: {} });
  };
  const dependencies = {
    stats,
    fetch,
    progress: (message: string) => messages.push(message),
    launch: async () => browser.context(),
  };
  return {
    dir,
    options,
    dependencies,
    browser,
    stats,
    requests,
    messages,
    fetch,
  };
}

test("login defaults are per-user, visible and sandboxed, with Wayland selected only when present", () => {
  const options = resolveLoginOptions({});
  expect(options.credentials).toBe(defaultCredentialsPath());
  expect(options.browserProfile).toBe(
    join(dirname(defaultCredentialsPath()), "browser"),
  );
  expect(options.timeout).toBe(600);
  const launched = loginLaunchOptions(options, {
    WAYLAND_DISPLAY: "wayland-1",
  });
  expect(launched?.headless).toBe(false);
  expect(launched?.chromiumSandbox).toBe(true);
  expect(launched?.args).toEqual(["--ozone-platform=wayland"]);
  expect(loginLaunchOptions(options, {})?.args).toEqual([]);
  expect(resolveLoginOptions({ timeout: 42 }).timeout).toBe(42);
  expect(resolveLoginOptions({ timeout: "42" }).timeout).toBe(42);
  for (const timeout of [0, -1, 3601, "invalid", true])
    expect(() => resolveLoginOptions({ timeout })).toThrow("Login options");
});

test("login captures a matching profile pair, verifies all services and atomically saves private credentials", async () => {
  const f = await fixture();
  const result = await login(f.options, f.dependencies);
  expect(result.status).toBe("saved");
  const saved = await loadCredentials(f.options.credentials);
  expect(saved).toEqual({
    version: 1,
    accountId: createHash("sha256").update(mri).digest("hex"),
    historyAuthentication: history,
    directoryToken: skype,
    profileAuthorization: authorization,
  });
  expect(f.stats).toEqual({
    total: 3,
    history: 1,
    directory: 1,
    profiles: 1,
    retries: 0,
  });
  expect(f.browser.closed).toBe(true);
  expect(f.browser.listenerCount("response")).toBe(0);
  expect(f.browser.listenerCount("close")).toBe(0);
  for (const secret of [history, skype, authorization, mri])
    expect(f.messages.join(" ")).not.toContain(secret);
  expect((await readdir(f.dir)).sort()).toEqual([
    "browser",
    "credentials.json",
  ]);
  if (process.platform !== "win32") {
    expect((await stat(f.options.credentials)).mode & 0o777).toBe(0o600);
    expect((await stat(f.options.browserProfile)).mode & 0o777).toBe(0o700);
  }
});

test("capture ignores failed responses, other origins, wrong methods and incomplete profile pairs", async () => {
  const f = await fixture();
  f.browser.navigate = async () => {
    for (const status of [302, 401, 403]) {
      f.browser.response(
        "/api/chatsvc/consumer/v1/users/ME/properties",
        { authentication: "bad" },
        status,
      );
      f.browser.response(
        "/api/mt/beta/users/me/",
        { authorization: "bad", "x-skypetoken": "bad" },
        status,
      );
    }
    f.browser.response(
      "/api/chatsvc/consumer/v1/users/ME/properties",
      { authentication: "bad" },
      200,
      "GET",
      "https://attacker.invalid",
    );
    f.browser.response("/api/mt/beta/users/fetchShortProfile", {
      authorization: "bad",
      "x-skypetoken": "bad",
    });
    f.browser.response("/api/mt/beta/users/me/", { authorization: "bad" });
    f.browser.response("/api/mt/beta/users/me/", { "x-skypetoken": "bad" });
    f.browser.capture();
  };
  await login(f.options, f.dependencies);
  expect((await loadCredentials(f.options.credentials)).directoryToken).toBe(
    skype,
  );
});

test("an empty directory uses a properties read without inventing a conversation", async () => {
  const f = await fixture(true);
  await login(f.options, f.dependencies);
  expect(new URL(f.requests[2]!.url).pathname).toBe(
    "/api/chatsvc/consumer/v1/users/ME/properties",
  );
});

test.each(["profiles", "directory", "history"])(
  "failed %s verification leaves previous credentials intact",
  async (purpose) => {
    const f = await fixture();
    await writeFile(f.options.credentials, "old-file-bytes", { mode: 0o600 });
    const fetch: Fetch = (request) => {
      const path = new URL(request.url).pathname;
      const fail =
        purpose === "profiles"
          ? path.includes("/api/mt/")
          : purpose === "directory"
            ? path.includes("/api/csa/")
            : path.includes("/api/chatsvc/");
      return fail
        ? Promise.resolve(new Response("secret failure body", { status: 401 }))
        : f.fetch(request);
    };
    await expect(
      login(f.options, { ...f.dependencies, fetch }),
    ).rejects.toThrow(`${purpose} request failed (HTTP 401)`);
    expect(await readFile(f.options.credentials, "utf8")).toBe(
      "old-file-bytes",
    );
    expect(f.browser.closed).toBe(true);
  },
);

test("timeout cleans up listeners and browser without writing credentials", async () => {
  const f = await fixture();
  f.browser.navigate = async () => {};
  await expect(
    login({ ...f.options, timeout: 1 }, f.dependencies),
  ).rejects.toThrow("Login timed out");
  expect(await Bun.file(f.options.credentials).exists()).toBe(false);
  expect(f.browser.closed).toBe(true);
  expect(f.browser.listenerCount("response")).toBe(0);
});

test("closing the browser while waiting is a failure", async () => {
  const f = await fixture();
  f.browser.navigate = async () => {
    await f.browser.close();
  };
  await expect(login(f.options, f.dependencies)).rejects.toThrow(
    "Login browser closed",
  );
  expect(await Bun.file(f.options.credentials).exists()).toBe(false);
});

test("cancellation interrupts navigation by closing the owned browser", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.browser.navigate = () =>
    new Promise((_resolve, reject) => {
      f.browser.once("close", () =>
        reject(new Error("closed during navigation")),
      );
      setTimeout(() => controller.abort(), 5);
    });
  await expect(
    login(f.options, { ...f.dependencies, signal: controller.signal }),
  ).rejects.toThrow("Login cancelled");
  expect(f.browser.closed).toBe(true);
  expect(f.browser.listenerCount("response")).toBe(0);
  expect(await Bun.file(f.options.credentials).exists()).toBe(false);
});

test("cancellation during verification never replaces an existing credential file", async () => {
  const f = await fixture();
  const controller = new AbortController();
  await writeFile(f.options.credentials, "keep", { mode: 0o600 });
  await expect(
    login(f.options, {
      ...f.dependencies,
      signal: controller.signal,
      fetch: async (request) => {
        controller.abort();
        return f.fetch(request);
      },
    }),
  ).rejects.toThrow("Login cancelled");
  expect(await readFile(f.options.credentials, "utf8")).toBe("keep");
  expect(f.browser.closed).toBe(true);
});

test("browser launch and navigation errors do not reveal raw error text", async () => {
  const f = await fixture();
  await expect(
    login(f.options, {
      ...f.dependencies,
      launch: async () => {
        throw new Error("secret-launch-data");
      },
    }),
  ).rejects.toThrow("Could not open the login browser");
  f.browser.navigate = async () => {
    throw new Error("secret-navigation-data");
  };
  await expect(login(f.options, f.dependencies)).rejects.toThrow(
    "Could not open Teams",
  );
  expect(f.browser.closed).toBe(true);
});

test("credential publication is private even when replacing a broad-permission file, and abort preserves it", async () => {
  const f = await fixture();
  const saved = {
    version: 1 as const,
    accountId: "fixture",
    historyAuthentication: history,
  };
  await writeFile(f.options.credentials, "old", { mode: 0o644 });
  await saveCredentials(f.options.credentials, saved);
  if (process.platform !== "win32")
    expect((await stat(f.options.credentials)).mode & 0o777).toBe(0o600);
  const before = await readFile(f.options.credentials, "utf8");
  const controller = new AbortController();
  controller.abort();
  await expect(
    saveCredentials(
      f.options.credentials,
      { ...saved, accountId: "new" },
      controller.signal,
    ),
  ).rejects.toThrow("Login cancelled");
  expect(await readFile(f.options.credentials, "utf8")).toBe(before);
});

test("unsafe browser profile permissions are rejected before launch", async () => {
  if (process.platform === "win32") return;
  const f = await fixture();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(f.options.browserProfile);
  await chmod(f.options.browserProfile, 0o755);
  let launched = false;
  await expect(
    login(f.options, {
      ...f.dependencies,
      launch: async () => {
        launched = true;
        return f.browser.context();
      },
    }),
  ).rejects.toThrow("chmod 700");
  expect(launched).toBe(false);
});

test("login help and invalid timeouts exit before starting a browser", async () => {
  for (const args of [["--help"], ["--timeout", "0"]]) {
    const child = Bun.spawn(
      [process.execPath, "src/cli.ts", "login", ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(args[0] === "--help" ? 0 : 1);
    expect(stdout + stderr).not.toContain("Opening the Teams login browser");
    expect(stdout + stderr).toContain(
      args[0] === "--help" ? "--browser-profile" : "Login options",
    );
  }
});
