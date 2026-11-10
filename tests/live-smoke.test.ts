import { expect, test } from "bun:test";
import { resolveLiveSmokeOptions } from "../src/command-validation.ts";
import type { Credentials } from "../src/credentials.ts";
import type { Fetch } from "../src/http.ts";
import { runLiveSmoke, runLiveSmokeCli } from "../src/live-smoke.ts";

const options = resolveLiveSmokeOptions({
  chat: "synthetic-chat",
  from: "2026-08-01T00:00:00Z",
  to: "2026-08-08T00:00:00Z",
});
const credentials: Credentials = {
  version: 1,
  accountId: "synthetic-account",
  historyAuthentication: "history-secret",
  directoryToken: "directory-secret",
  profileAuthorization: "Bearer profile-secret",
  mediaCookies: { "https://us-api.asm.skype.com": "media-secret" },
};
const imageUrl = "https://us-api.asm.skype.com/v1/objects/first/views/imgo";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);

function fixture(
  settings: {
    continuation?: boolean;
    image?: boolean;
    mediaStatus?: number;
    validators?: boolean;
    refreshStatus?: number;
    profileStatus?: number;
    historyStatus?: number;
    participant?: boolean;
    outOfWindow?: boolean;
    title?: string;
    extraChats?: {
      id: string;
      title?: string;
      isOneOnOne?: boolean;
      members?: { mri: string }[];
    }[];
  } = {},
) {
  const calls: Request[] = [];
  const logs: string[] = [];
  let history = 0;
  let media = 0;
  const fetch: Fetch = async (request) => {
    calls.push(request);
    const url = new URL(request.url);
    if (url.pathname.includes("/messages")) {
      history++;
      expect(request.headers.get("Authentication")).toBe("history-secret");
      expect(request.headers.has("Cookie")).toBe(false);
      expect(request.headers.has("Authorization")).toBe(false);
      expect(url.searchParams.get("startTime")).toBe(
        String(options.window.from),
      );
      expect(url.searchParams.get("endTime")).toBe(
        String(options.window.to - 1),
      );
      if (settings.historyStatus)
        return new Response("secret-body", { status: settings.historyStatus });
      return Response.json({
        messages: [
          {
            id: String(history),
            originalarrivaltime:
              settings.outOfWindow && history === 2
                ? "2026-11-01T00:00:00Z"
                : "2026-08-03T00:00:00Z",
            messagetype: "RichText/Html",
            content:
              settings.image === false
                ? "Text only"
                : `<img src="https://external.invalid/private"><img src="${imageUrl}"><img src="https://us-api.asm.skype.com/v1/objects/second/views/imgo">`,
          },
        ],
        _metadata:
          settings.continuation === false
            ? {}
            : {
                backwardLink: `https://msgapi.teams.live.com/v1/users/ME/conversations/synthetic-chat/messages?syncState=${history}`,
              },
      });
    }
    if (url.pathname.includes("/views/imgo")) {
      media++;
      expect(url.href).toBe(imageUrl);
      expect(request.headers.get("Cookie")).toBe("skypetoken_asm=media-secret");
      for (const header of ["Authentication", "Authorization", "x-skypetoken"])
        expect(request.headers.has(header)).toBe(false);
      if (settings.mediaStatus)
        return new Response("secret-body", { status: settings.mediaStatus });
      if (media === 2) {
        expect(request.headers.get("If-None-Match")).toBe('"fixture"');
        if (settings.refreshStatus !== 200)
          return new Response(null, { status: 304 });
      } else expect(request.headers.has("If-None-Match")).toBe(false);
      return new Response(png, {
        headers: {
          "content-type": "image/png",
          ...(settings.validators === false ? {} : { etag: '"fixture"' }),
        },
      });
    }
    if (url.pathname.includes("/users/me/")) {
      expect(request.headers.get("Authorization")).toBe(
        "Bearer profile-secret",
      );
      expect(request.headers.get("x-skypetoken")).toBe("directory-secret");
      if (settings.profileStatus)
        return new Response("secret-body", { status: settings.profileStatus });
      return Response.json({
        value: { mri: "8:live:self", displayName: "Self" },
      });
    }
    if (url.pathname.endsWith("fetchShortProfile")) {
      expect(await request.json()).toEqual(["8:live:other"]);
      return Response.json({
        value: [{ mri: "8:live:other", displayName: "Other", status: 200 }],
      });
    }
    expect(url.pathname).toBe("/api/csa/api/v3/teams/users/me");
    expect(request.headers.get("x-skypetoken")).toBe("directory-secret");
    expect(request.headers.has("Cookie")).toBe(false);
    return Response.json({
      chats: [
        {
          id: options.chat,
          title: settings.title,
          isOneOnOne: settings.participant !== false,
          members: [{ mri: "8:live:self" }, { mri: "8:live:other" }],
        },
        ...(settings.extraChats ?? []),
      ],
      metadata: { hasMoreChats: false, isPartialData: false },
    });
  };
  return {
    calls,
    logs,
    dependencies: { fetch, log: (message: string) => logs.push(message) },
  };
}

test("live runner uses real clients, caps history at two pages and media at one image, and revalidates a fresh cache", async () => {
  const f = fixture();
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(7);
  expect(report.requests).toEqual({
    total: 7,
    directory: 1,
    profiles: 2,
    history: 2,
    media: 2,
    retries: 0,
  });
  expect(report.checks.at(-1)?.detail).toContain("HTTP 304");
  for (const secret of [
    "history-secret",
    "directory-secret",
    "profile-secret",
    "media-secret",
    "secret-body",
    imageUrl,
    "Other",
  ])
    expect(JSON.stringify(report) + f.logs.join("\n")).not.toContain(secret);
  // A second run must start cold even though the previous run downloaded this image.
  const again = fixture();
  expect(
    (await runLiveSmoke(options, credentials, again.dependencies)).ok,
  ).toBe(true);
}, 10000);

test("a short window does not count as a verified pagination check", async () => {
  const f = fixture({ continuation: false });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.history).toBe(1);
  expect(report.checks.find((c) => c.name === "pagination")?.status).toBe(
    "unverified",
  );
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "pass",
  );
});

test.each([
  { label: "  oThEr  ", title: undefined },
  { label: "  PROJECT ALPHA  ", title: "Project Alpha" },
])(
  "label selection matches exact resolved labels and reuses the directory: $label",
  async ({ label, title }) => {
    const f = fixture({ title });
    const selected = resolveLiveSmokeOptions({
      chatLabel: label,
      from: options.from,
      to: options.to,
    });
    const report = await runLiveSmoke(selected, credentials, f.dependencies);
    expect(report.requests.directory).toBe(1);
    expect(report.requests.history).toBe(2);
    expect(report.checks.find((c) => c.name === "history")?.status).toBe(
      "pass",
    );
    expect(
      f.calls
        .filter((call) => new URL(call.url).pathname.includes("/messages"))
        .every((call) =>
          new URL(call.url).pathname.includes("/synthetic-chat/messages"),
        ),
    ).toBe(true);
    if (!title) expect(report.ok).toBe(true);
  },
);

test("ambiguous labels report raw IDs before any history retrieval", async () => {
  // The group title collides with the freshly resolved one-to-one name.
  const f = fixture({ extraChats: [{ id: "duplicate-chat", title: "Other" }] });
  const selected = resolveLiveSmokeOptions({
    chatLabel: "other",
    from: options.from,
    to: options.to,
  });
  const report = await runLiveSmoke(selected, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.directory).toBe(1);
  expect(report.requests.history).toBe(0);
  expect(report.requests.media).toBe(0);
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("fail");
  expect(report.checks.find((c) => c.name === "history")?.detail).toContain(
    "Multiple chats match --chat-label",
  );
  expect(report.checks.find((c) => c.name === "history")?.detail).toContain(
    "synthetic-chat",
  );
  expect(report.checks.find((c) => c.name === "history")?.detail).toContain(
    "duplicate-chat",
  );
});

test("partial label matches never fetch history", async () => {
  const f = fixture();
  const selected = resolveLiveSmokeOptions({
    chatLabel: "oth",
    from: options.from,
    to: options.to,
  });
  const report = await runLiveSmoke(selected, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.history).toBe(0);
  expect(report.checks.find((c) => c.name === "history")).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("No chat matches --chat-label"),
  });
});

test("failed profile-based label resolution prevents history while retaining the profile status", async () => {
  const f = fixture({ profileStatus: 409 });
  const selected = resolveLiveSmokeOptions({
    chatLabel: "Other",
    from: options.from,
    to: options.to,
  });
  const report = await runLiveSmoke(selected, credentials, f.dependencies);
  expect(report.requests.directory).toBe(1);
  expect(report.requests.history).toBe(0);
  expect(report.checks.find((c) => c.name === "profiles")).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("HTTP 409"),
  });
  expect(report.checks.find((c) => c.name === "history")?.status).toBe(
    "unverified",
  );
});

test("missing images leave media checks unverified rather than passing", async () => {
  const f = fixture({ continuation: false, image: false });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.media).toBe(0);
  expect(report.checks.slice(-3).map((c) => c.status)).toEqual([
    "unverified",
    "unverified",
    "unverified",
  ]);
});

test("expired media cookies fail a cold request without leaking the response body", async () => {
  const f = fixture({ continuation: false, mediaStatus: 401 });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.media).toBe(1);
  expect(report.checks.find((c) => c.name === "media cookie")).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("HTTP 401"),
  });
  expect(f.logs.join("\n")).not.toContain("secret-body");
});

test.each([403, 409])(
  "profile HTTP %i does not prevent checking independent history and media credentials",
  async (profileStatus) => {
    const f = fixture({ continuation: false, profileStatus });
    const report = await runLiveSmoke(options, credentials, f.dependencies);
    expect(report.ok).toBe(false);
    expect(report.requests.profiles).toBe(1);
    expect(report.checks.find((c) => c.name === "profiles")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining(`HTTP ${profileStatus}`),
    });
    expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
      "pass",
    );
  },
);

test("history authentication failures cannot pass pagination or media checks", async () => {
  const f = fixture({ historyStatus: 401 });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.history).toBe(1);
  expect(report.requests.media).toBe(0);
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("fail");
  expect(report.checks.find((c) => c.name === "pagination")?.status).toBe(
    "unverified",
  );
});

test("an out-of-window second page cannot pass pagination, while valid first-page media remains checkable", async () => {
  const f = fixture({ outOfWindow: true });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.history).toBe(2);
  expect(report.checks.find((c) => c.name === "history")).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("outside the fixed date window"),
  });
  expect(report.checks.find((c) => c.name === "pagination")?.status).toBe(
    "unverified",
  );
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "pass",
  );
});

test("no eligible participant is reported unverified without making profile requests", async () => {
  const f = fixture({ continuation: false, participant: false });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.profiles).toBe(0);
  expect(report.checks.find((c) => c.name === "profiles")?.status).toBe(
    "unverified",
  );
});

test("missing media credentials fail rather than reusing an existing normal cache", async () => {
  const f = fixture({ continuation: false });
  const report = await runLiveSmoke(
    options,
    { ...credentials, mediaCookies: undefined },
    f.dependencies,
  );
  expect(report.ok).toBe(false);
  expect(report.requests.media).toBe(0);
  expect(report.checks.find((c) => c.name === "media cookie")).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("Image credentials are missing"),
  });
});

test("missing validators leave conditional revalidation unverified without another download", async () => {
  const f = fixture({ continuation: false, validators: false });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.media).toBe(1);
  expect(report.checks.at(-1)?.status).toBe("unverified");
});

test("a conditional HTTP 200 is accepted as a validated refresh and described accurately", async () => {
  const f = fixture({ continuation: false, refreshStatus: 200 });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.checks.at(-1)).toMatchObject({
    status: "pass",
    detail: expect.stringContaining("304 branch unverified"),
  });
});

test("cancellation prevents further requests and leaves checks unverified", async () => {
  const f = fixture();
  const report = await runLiveSmoke(options, credentials, {
    ...f.dependencies,
    signal: AbortSignal.abort(),
  });
  expect(report.ok).toBe(false);
  expect(report.requests.total).toBe(0);
  expect(report.checks.every((c) => c.status === "unverified")).toBe(true);
});

test("live CLI requires explicit targets and timezone-qualified historical bounds", async () => {
  for (const input of [
    {},
    { from: options.from, to: options.to },
    {
      chat: options.chat,
      chatLabel: "Other",
      from: options.from,
      to: options.to,
    },
    { chatLabel: "   ", from: options.from, to: options.to },
    { chatLabel: "  Untitled Chat ", from: options.from, to: options.to },
    {
      chatLabel: "Unresolved one-to-one chat",
      from: options.from,
      to: options.to,
    },
    { chat: options.chat, from: "2026-08-01", to: options.to },
    { chat: options.chat, from: options.to, to: options.from },
    { chat: options.chat, from: options.from, to: "9999-01-01T00:00:00Z" },
    { chat: options.chat, from: options.from, to: options.to, out: "exports" },
  ])
    expect(() => resolveLiveSmokeOptions(input)).toThrow();
  expect(await runLiveSmokeCli(["bun", "live-smoke.ts", "--help"])).toBe(0);
  expect(await runLiveSmokeCli(["bun", "live-smoke.ts"])).toBe(1);
});
