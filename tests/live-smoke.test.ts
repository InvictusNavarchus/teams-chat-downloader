import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "../src/archive.ts";
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
  accountId: createHash("sha256").update("8:live:self").digest("hex"),
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

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function savedArchive(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "teams-smoke-fixture-test-"));
  directories.push(directory);
  const path = join(directory, "chat.json");
  const archive = {
    version: 1,
    status: "complete",
    accountId: credentials.accountId,
    chatId: "synthetic-chat",
    window: {
      from: options.from,
      toExclusive: options.to,
      timestampField: "originalarrivaltime",
    },
    media: { status: "not-downloaded" },
    messages: [
      {
        id: "self",
        originalarrivaltime: "2026-08-03T00:00:00Z",
        from: "8:live:self",
      },
      {
        id: "other",
        originalarrivaltime: "2026-08-03T00:00:01Z",
        from: "https://teams.live.com/v1/users/ME/contacts/8%3Alive%3Aother",
        messagetype: "RichText/Html",
        content: `<img src="${imageUrl}">`,
      },
    ],
    ...overrides,
  };
  await writeFile(path, JSON.stringify(archive), { mode: 0o600 });
  const resolved = resolveLiveSmokeOptions({
    fixture: path,
    from: options.from,
    to: options.to,
  });
  return { path, archive, options: resolved };
}

function fixture(
  settings: {
    continuation?: boolean;
    image?: boolean;
    mediaStatus?: number;
    validators?: boolean;
    refreshStatus?: number;
    profileStatus?: number;
    participantStatus?: number;
    directoryStatus?: number;
    directoryId?: string;
    historyStatus?: number;
    secondHistoryStatus?: number;
    emptyHistory?: boolean;
    participant?: boolean;
    outOfWindow?: boolean;
    title?: string;
    members?: { mri: string }[];
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
      const status =
        history === 2
          ? (settings.secondHistoryStatus ?? settings.historyStatus)
          : settings.historyStatus;
      if (status) return new Response("secret-body", { status });
      return Response.json({
        messages: settings.emptyHistory
          ? []
          : [
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
      expect(request.headers.get("Authorization")).toBe(
        "Bearer profile-secret",
      );
      expect(request.headers.get("x-skypetoken")).toBe("directory-secret");
      expect(request.headers.has("Cookie")).toBe(false);
      expect(request.headers.has("Authentication")).toBe(false);
      if (settings.participantStatus)
        return new Response("secret-body", {
          status: settings.participantStatus,
        });
      return Response.json({
        value: [{ mri: "8:live:other", displayName: "Other", status: 200 }],
      });
    }
    expect(url.pathname).toBe("/api/csa/api/v3/teams/users/me");
    expect(request.headers.get("x-skypetoken")).toBe("directory-secret");
    expect(request.headers.has("Cookie")).toBe(false);
    if (settings.directoryStatus)
      return new Response("secret-body", { status: settings.directoryStatus });
    return Response.json({
      chats: [
        {
          id: settings.directoryId ?? options.chat,
          title: settings.title,
          isOneOnOne: settings.participant !== false,
          members: settings.members ?? [
            { mri: "8:live:self" },
            { mri: "8:live:other" },
          ],
        },
        ...(settings.extraChats ?? []),
      ],
      metadata: { hasMoreChats: false, isPartialData: false },
    });
  };
  return {
    calls,
    logs,
    dependencies: {
      fetch,
      log: (message: string) => logs.push(message),
      exportsRoot: join(
        tmpdir(),
        `teams-smoke-no-exports-${crypto.randomUUID()}`,
      ),
    },
  };
}

test("live runner uses real clients, caps history at two pages and media at one image, and revalidates a fresh cache", async () => {
  const f = fixture();
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(8);
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

test("fixture targets keep profiles and media live when directory and history both fail", async () => {
  const saved = await savedArchive();
  const before = await readFile(saved.path, "utf8");
  const f = fixture({ directoryStatus: 401, historyStatus: 403 });
  const report = await runLiveSmoke(saved.options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests).toEqual({
    total: 6,
    directory: 1,
    profiles: 2,
    history: 1,
    media: 2,
    retries: 0,
  });
  expect(report.checks.map(({ name, status }) => [name, status])).toEqual([
    ["directory", "fail"],
    ["self profile", "pass"],
    ["participant profiles", "pass"],
    ["history", "fail"],
    ["pagination", "unverified"],
    ["media cookie", "pass"],
    ["media cache", "pass"],
    ["media revalidation", "pass"],
  ]);
  expect(await readFile(saved.path, "utf8")).toBe(before);
  for (const secret of [
    "history-secret",
    "directory-secret",
    "profile-secret",
    "media-secret",
    "secret-body",
    imageUrl,
    "8:live:other",
  ])
    expect(JSON.stringify(report) + f.logs.join("\n")).not.toContain(secret);
});

test("automatic targets keep all service probes independent without a selector", async () => {
  const saved = await savedArchive();
  const f = fixture({
    directoryStatus: 401,
    profileStatus: 409,
    historyStatus: 401,
  });
  const auto = resolveLiveSmokeOptions({ from: options.from, to: options.to });
  const report = await runLiveSmoke(auto, credentials, {
    ...f.dependencies,
    exportsRoot: dirname(saved.path),
  });
  expect(report.requests).toEqual({
    total: 6,
    directory: 1,
    profiles: 2,
    history: 1,
    media: 2,
    retries: 0,
  });
  expect(
    report.checks.find((c) => c.name === "participant profiles")?.status,
  ).toBe("pass");
  expect(report.checks.find((c) => c.name === "history")?.detail).toContain(
    "HTTP 401",
  );
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "pass",
  );
  expect(
    f.logs.some(
      (line) => line.includes("auto-selected") && line.includes(saved.path),
    ),
  ).toBe(true);
});

test("automatic fixture data enriches explicit label probes without guessing a failed label mapping", async () => {
  const saved = await savedArchive();
  const f = fixture({ directoryStatus: 401, profileStatus: 409 });
  const selected = resolveLiveSmokeOptions({
    chatLabel: "Other",
    from: options.from,
    to: options.to,
  });
  const report = await runLiveSmoke(selected, credentials, {
    ...f.dependencies,
    exportsRoot: dirname(saved.path),
  });
  expect(report.requests.history).toBe(0);
  expect(report.requests.profiles).toBe(2);
  expect(report.requests.media).toBe(2);
  expect(report.checks.find((c) => c.name === "history")?.status).toBe(
    "unverified",
  );
  expect(
    report.checks.find((c) => c.name === "participant profiles")?.status,
  ).toBe("pass");
});

test("an explicit raw ID retains its meaning when the discovered fixture belongs to another chat", async () => {
  const saved = await savedArchive({ chatId: "different-fixture-chat" });
  const f = fixture({ continuation: false });
  const report = await runLiveSmoke(options, credentials, {
    ...f.dependencies,
    exportsRoot: dirname(saved.path),
  });
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
  const calls = f.calls.filter((call) =>
    new URL(call.url).pathname.endsWith("/messages"),
  );
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toContain("/synthetic-chat/messages");
});

test("an explicit fixture overrides automatic candidates", async () => {
  const selected = await savedArchive();
  const ignored = await savedArchive({ chatId: "ignored-automatic-candidate" });
  const f = fixture({ continuation: false });
  const report = await runLiveSmoke(selected.options, credentials, {
    ...f.dependencies,
    exportsRoot: dirname(ignored.path),
  });
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
  expect(
    f.logs.some(
      (line) => line.includes("explicit") && line.includes(selected.path),
    ),
  ).toBe(true);
  expect(f.logs.some((line) => line.includes(ignored.path))).toBe(false);
});

test("automatic mode falls back to an available directory chat when no saved archive exists", async () => {
  const f = fixture({ continuation: false });
  const auto = resolveLiveSmokeOptions({ from: options.from, to: options.to });
  const report = await runLiveSmoke(auto, credentials, f.dependencies);
  expect(report.requests.history).toBe(1);
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
  expect(
    f.logs.some((line) => line.includes("no usable same-account archive")),
  ).toBe(true);
});

test("fixture participant lookup does not depend on a successful self-profile request", async () => {
  const saved = await savedArchive();
  const f = fixture({
    directoryStatus: 401,
    profileStatus: 409,
    continuation: false,
  });
  const report = await runLiveSmoke(saved.options, credentials, f.dependencies);
  expect(report.requests.profiles).toBe(2);
  expect(
    report.checks.find((c) => c.name === "self profile")?.detail,
  ).toContain("HTTP 409");
  expect(
    report.checks.find((c) => c.name === "participant profiles")?.status,
  ).toBe("pass");
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "pass",
  );
});

test("fixture mode reports each independent service's failure instead of skipping requests", async () => {
  const saved = await savedArchive();
  const f = fixture({
    directoryStatus: 401,
    profileStatus: 409,
    participantStatus: 403,
    historyStatus: 401,
    mediaStatus: 403,
  });
  const report = await runLiveSmoke(saved.options, credentials, f.dependencies);
  expect(report.requests).toEqual({
    total: 5,
    directory: 1,
    profiles: 2,
    history: 1,
    media: 1,
    retries: 0,
  });
  for (const [name, status] of [
    ["directory", 401],
    ["self profile", 409],
    ["participant profiles", 403],
    ["history", 401],
    ["media cookie", 403],
  ] as const) {
    const check = report.checks.find((item) => item.name === name);
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain(`HTTP ${status}`);
  }
  expect(
    report.checks.filter((c) => c.status === "unverified").map((c) => c.name),
  ).toEqual(["pagination", "media cache", "media revalidation"]);
});

test("a raw-ID history probe and self-profile probe continue after directory failure without a fixture", async () => {
  const f = fixture({ directoryStatus: 401, continuation: false });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.requests.history).toBe(1);
  expect(report.requests.profiles).toBe(1);
  expect(report.checks.find((c) => c.name === "self profile")?.status).toBe(
    "pass",
  );
  expect(
    report.checks.find((c) => c.name === "participant profiles")?.status,
  ).toBe("unverified");
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
});

test("a successful directory cannot veto a supplied raw history target", async () => {
  const f = fixture({
    directoryId: "different-listed-chat",
    continuation: false,
  });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.checks.find((c) => c.name === "directory")?.status).toBe(
    "pass",
  );
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
  expect(report.requests.history).toBe(1);
});

test("a quiet live window does not prevent media verification using the archive reference", async () => {
  const saved = await savedArchive();
  const f = fixture({ emptyHistory: true, continuation: false });
  const report = await runLiveSmoke(saved.options, credentials, f.dependencies);
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
  expect(report.checks.find((c) => c.name === "pagination")?.status).toBe(
    "unverified",
  );
  expect(report.requests.media).toBe(2);
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "pass",
  );
});

test("missing fixture sender leaves only participant coverage unverified when other inputs are known", async () => {
  const messages: Message[] = [
    {
      id: "image",
      originalarrivaltime: "2026-08-03T00:00:00Z",
      messagetype: "RichText/Html",
      content: `<img src="${imageUrl}">`,
    },
  ];
  const saved = await savedArchive({ messages });
  const f = fixture({ directoryStatus: 401, historyStatus: 401 });
  const report = await runLiveSmoke(saved.options, credentials, f.dependencies);
  expect(report.requests.profiles).toBe(1);
  expect(
    report.checks.find((c) => c.name === "participant profiles")?.status,
  ).toBe("unverified");
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "pass",
  );
});

test("untrusted fixture image URLs are never requested and do not leak into diagnostics", async () => {
  const saved = await savedArchive({
    messages: [
      {
        id: "external",
        originalarrivaltime: "2026-08-03T00:00:00Z",
        messagetype: "RichText/Html",
        content:
          '<img src="https://external.invalid/image?token=fixture-secret">',
      },
    ],
  });
  const f = fixture({ directoryStatus: 401, historyStatus: 401 });
  const report = await runLiveSmoke(saved.options, credentials, f.dependencies);
  expect(report.requests.media).toBe(0);
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "unverified",
  );
  expect(
    f.calls.every((call) => new URL(call.url).hostname !== "external.invalid"),
  ).toBe(true);
  expect(f.logs.join("\n")).not.toContain("fixture-secret");
});

test.each(["another-account", undefined])(
  "fixtures with wrong or missing account IDs fail before HTTP: %s",
  async (accountId) => {
    const saved = await savedArchive({ accountId });
    const f = fixture();
    await expect(
      runLiveSmoke(saved.options, credentials, f.dependencies),
    ).rejects.toThrow("Fixture account does not match");
    expect(f.calls).toHaveLength(0);
  },
);

test("malformed fixtures fail before HTTP without echoing their private content", async () => {
  const saved = await savedArchive();
  await writeFile(saved.path, "invalid-json-with-fixture-secret");
  const f = fixture();
  await expect(
    runLiveSmoke(saved.options, credentials, f.dependencies),
  ).rejects.toThrow("Input export is not valid JSON");
  expect(f.calls).toHaveLength(0);
  expect(f.logs.join("\n")).not.toContain("fixture-secret");
});

test("legacy account labels need a successful self profile to distinguish the participant", async () => {
  const saved = await savedArchive({ accountId: "legacy" });
  const f = fixture({
    directoryStatus: 401,
    profileStatus: 409,
    historyStatus: 401,
  });
  const report = await runLiveSmoke(
    saved.options,
    { ...credentials, accountId: "legacy" },
    f.dependencies,
  );
  expect(report.requests.profiles).toBe(1);
  expect(
    report.checks.find((c) => c.name === "participant profiles")?.status,
  ).toBe("unverified");
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "pass",
  );
});

test("a failed second page is reported as a pagination failure while the first page remains verified", async () => {
  const f = fixture({ secondHistoryStatus: 403 });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.requests.history).toBe(2);
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
  expect(report.checks.find((c) => c.name === "pagination")?.status).toBe(
    "fail",
  );
  expect(report.checks.find((c) => c.name === "pagination")?.detail).toContain(
    "HTTP 403",
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
  expect(report.checks.find((c) => c.name === "self profile")).toMatchObject({
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
    expect(report.requests.profiles).toBe(2);
    expect(report.checks.find((c) => c.name === "self profile")).toMatchObject({
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
  expect(report.checks.find((c) => c.name === "pagination")).toMatchObject({
    status: "fail",
    detail: expect.stringContaining("outside the fixed date window"),
  });
  expect(report.checks.find((c) => c.name === "history")?.status).toBe("pass");
  expect(report.checks.find((c) => c.name === "media cookie")?.status).toBe(
    "pass",
  );
});

test("no known participant leaves only that probe unverified, while self profile still runs", async () => {
  const f = fixture({ continuation: false, members: [] });
  const report = await runLiveSmoke(options, credentials, f.dependencies);
  expect(report.ok).toBe(false);
  expect(report.requests.profiles).toBe(1);
  expect(report.checks.find((c) => c.name === "self profile")?.status).toBe(
    "pass",
  );
  expect(
    report.checks.find((c) => c.name === "participant profiles")?.status,
  ).toBe("unverified");
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

test.each([
  ["Asia/Jakarta", "2026-11-05T15:00:00+07:00", "2026-11-04T00:00:00+07:00"],
  ["UTC", "2026-01-01T12:00:00Z", "2025-12-31T00:00:00Z"],
  [
    "America/New_York",
    "2026-03-09T12:00:00-04:00",
    "2026-03-08T00:00:00-05:00",
  ],
  [
    "America/New_York",
    "2026-11-02T12:00:00-05:00",
    "2026-11-01T00:00:00-04:00",
  ],
])(
  "default smoke window matches export --last 2d in %s at %s",
  async (zone, invocation, start) => {
    const modulePath = fileURLToPath(
      new URL("../src/command-validation.ts", import.meta.url),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { resolveLiveSmokeOptions, resolveExportOptions } from ${JSON.stringify(modulePath)};
    const now = ${Date.parse(invocation)};
    console.log(JSON.stringify({
      automatic: resolveLiveSmokeOptions({}, now).window,
      raw: resolveLiveSmokeOptions({ chat: "fixture" }, now).window,
      label: resolveLiveSmokeOptions({ chatLabel: "Project Alpha" }, now).window,
      fixture: resolveLiveSmokeOptions({ fixture: "chat.json" }, now).window,
      exported: resolveExportOptions({ chat: "fixture", last: "2d" }, now).window,
    }));`,
      ],
      { env: { ...process.env, TZ: zone }, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const window = { from: Date.parse(start), to: Date.parse(invocation) };
    expect(JSON.parse(stdout)).toEqual({
      automatic: window,
      raw: window,
      label: window,
      fixture: window,
      exported: window,
    });
  },
);

test.each([{ from: "2026-08-01T00:00:00Z" }, { to: "2026-08-08T00:00:00Z" }])(
  "smoke window overrides require both bounds: %j",
  (bounds) => {
    expect(() =>
      resolveLiveSmokeOptions({ chat: "fixture", ...bounds }),
    ).toThrow("Supply both --from and --to");
  },
);

test("live CLI accepts automatic mode and validates explicit overrides and bounds", async () => {
  expect(resolveLiveSmokeOptions({}).chat).toBeUndefined();
  expect(
    resolveLiveSmokeOptions({ from: options.from, to: options.to }).window,
  ).toEqual(options.window);
  for (const input of [
    { fixture: "" },
    { fixture: "chat.json", chat: "fixture" },
    { fixture: "chat.json", chatLabel: "Other" },
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
  expect(
    await runLiveSmokeCli([
      "bun",
      "live-smoke.ts",
      "--credentials",
      join(tmpdir(), `teams-smoke-missing-${crypto.randomUUID()}.json`),
    ]),
  ).toBe(1);
});
