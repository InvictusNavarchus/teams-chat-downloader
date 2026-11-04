import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials } from "../src/credentials.ts";
import { exportChat } from "../src/export.ts";
import { createHttp, requestStats } from "../src/http.ts";
import { resolveExportOptions } from "../src/options.ts";
import { writeExport } from "../src/output.ts";
import { historyProgress } from "../src/teams.ts";

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "teams-cli-test-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("exports preserved messages and truthful manifest without credentials or cursors", async () => {
  const dir = await temporary();
  const out = join(dir, "export.json");
  const options = resolveExportOptions({
    chat: "fixture",
    credentials: "unused.json",
    out,
    from: "2026-08-01T00:00:00Z",
    to: "2026-08-08T00:00:00Z",
  });
  const stats = requestStats();
  const http = createHttp({
    stats,
    fetch: async () =>
      Response.json({
        messages: [
          {
            id: "1",
            originalarrivaltime: "2026-08-01T00:00:00Z",
            newProperty: { retained: true },
          },
        ],
        _metadata: { syncState: "private-cursor" },
      }),
  });
  await exportChat(
    options,
    {
      version: 1,
      accountId: "fixture",
      historyAuthentication: "private-header",
    },
    http,
    stats,
    historyProgress(),
  );
  const raw = await readFile(out, "utf8");
  const document = JSON.parse(raw);
  expect(document.status).toBe("complete");
  expect(document.messages[0].newProperty).toEqual({ retained: true });
  expect(document.history.serviceReportedExhaustion).toBe(true);
  expect(document.requests.total).toBe(1);
  expect(document.media.status).toBe("not-downloaded");
  expect(raw).not.toContain("private-header");
  expect(raw).not.toContain("private-cursor");
  expect(await readdir(dir)).toEqual(["export.json"]);
  await expect(
    exportChat(
      options,
      {
        version: 1,
        accountId: "fixture",
        historyAuthentication: "private-header",
      },
      http,
      stats,
      historyProgress(),
    ),
  ).rejects.toThrow("already exists");
  expect(stats.total).toBe(1);
});

test("a later page failure creates no complete-looking export", async () => {
  const dir = await temporary();
  const out = join(dir, "export.json");
  const options = resolveExportOptions({
    chat: "fixture",
    credentials: "unused.json",
    out,
    last: "7d",
  });
  const stats = requestStats();
  const http = createHttp({
    stats,
    retryLimit: 0,
    fetch: async () =>
      stats.total === 1
        ? Response.json({
            messages: [
              {
                id: "1",
                originalarrivaltime: new Date(
                  options.window.from,
                ).toISOString(),
              },
            ],
            _metadata: {
              backwardLink:
                "https://msgapi.teams.live.com/v1/users/ME/conversations/fixture/messages?syncState=next",
            },
          })
        : new Response("unavailable", { status: 503 }),
  });
  const progress = historyProgress();
  await expect(
    exportChat(
      options,
      {
        version: 1,
        accountId: "fixture",
        historyAuthentication: "private-header",
      },
      http,
      stats,
      progress,
    ),
  ).rejects.toThrow("503");
  expect(await readdir(dir)).toEqual([]);
  expect(progress.pages).toBe(1);
  expect(stats.total).toBe(2);
});

test("atomic publication never overwrites an existing destination", async () => {
  const dir = await temporary();
  const out = join(dir, "export.json");
  await writeFile(out, "keep me");
  await expect(writeExport(out, { status: "complete" })).rejects.toThrow(
    "already exists",
  );
  expect(await readFile(out, "utf8")).toBe("keep me");
  expect(await readdir(dir)).toEqual(["export.json"]);
});

test("credential file rejects broad permissions and malformed shapes without values in errors", async () => {
  const dir = await temporary();
  const path = join(dir, "credentials.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      accountId: "fixture",
      historyAuthentication: "header",
    }),
    { mode: 0o644 },
  );
  await expect(loadCredentials(path)).rejects.toThrow("chmod 600");
  await chmod(path, 0o600);
  expect((await loadCredentials(path)).historyAuthentication).toBe("header");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      accountId: "fixture",
      historyAuthentication: "secret\r\ninjected",
    }),
  );
  try {
    await loadCredentials(path);
    throw new Error("Expected failure");
  } catch (error) {
    expect(String(error)).toContain("historyAuthentication");
    expect(String(error)).not.toContain("secret");
  }
});

test("CLI rejects invalid input before network or output", async () => {
  const result = Bun.spawn(
    [
      process.execPath,
      "src/cli.ts",
      "export",
      "--chat",
      "fixture",
      "--last",
      "0d",
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(result.stderr).text();
  expect(await result.exited).toBe(1);
  expect(stderr).toContain("Export options");
  expect(stderr).not.toContain("HTTP attempts");
});
