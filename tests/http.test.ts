import { describe, expect, test } from "bun:test";
import { createHttp, requestStats } from "../src/http.ts";

const url = new URL("https://teams.live.com/fixture");
const allow = () => {};

describe("request policy", () => {
  test("counts failed HTTP attempts and retries once each", async () => {
    const stats = requestStats();
    const http = createHttp({
      stats,
      retryDelay: () => 0,
      fetch: async () =>
        stats.total < 3
          ? new Response("unavailable", { status: 503 })
          : Response.json({ ok: true }),
    });
    expect(await http.json(url, "history", {}, allow)).toEqual({ ok: true });
    expect(stats).toEqual({ total: 3, history: 3, directory: 0, retries: 2 });
  });

  test("counts retryable network errors and stops at the attempt limit", async () => {
    const stats = requestStats();
    const http = createHttp({
      stats,
      retryDelay: () => 0,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(http.json(url, "history", {}, allow)).rejects.toThrow();
    expect(stats.total).toBe(3);
    expect(stats.retries).toBe(2);
  });

  test.each([401, 403, 302, 404])(
    "does not retry HTTP %i or leak bodies",
    async (status) => {
      const stats = requestStats();
      const http = createHttp({
        stats,
        fetch: async () =>
          new Response("private-response-body", {
            status,
            headers: { location: "https://attacker.invalid" },
          }),
      });
      let message = "";
      try {
        await http.json(url, "history", {}, allow);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain(String(status));
      expect(message).not.toContain("private-response-body");
      expect(stats.total).toBe(1);
    },
  );

  test("waits for a numeric Retry-After before retry dispatch", async () => {
    const stats = requestStats();
    const start = performance.now();
    const http = createHttp({
      stats,
      fetch: async () =>
        stats.total === 1
          ? new Response("slow down", {
              status: 429,
              headers: { "retry-after": "1" },
            })
          : Response.json({ ok: true }),
    });
    await http.json(url, "history", {}, allow);
    expect(performance.now() - start).toBeGreaterThanOrEqual(950);
    expect(stats.total).toBe(2);
  });

  test.each(["120", new Date(Date.now() + 120_000).toUTCString()])(
    "does not truncate a server wait to fit the time budget: %s",
    async (retryAfter) => {
      const stats = requestStats();
      const http = createHttp({
        stats,
        totalTimeoutMs: 25,
        fetch: async () =>
          new Response("wait", {
            status: 429,
            headers: { "retry-after": retryAfter },
          }),
      });
      await expect(http.json(url, "history", {}, allow)).rejects.toThrow(
        "time budget",
      );
      expect(stats.total).toBe(1);
      expect(stats.retries).toBe(0);
    },
  );

  test("cancellation during retry delay prevents another request", async () => {
    const controller = new AbortController();
    const stats = requestStats();
    const http = createHttp({
      stats,
      signal: controller.signal,
      fetch: async () => {
        setTimeout(() => controller.abort(), 10);
        return new Response("wait", {
          status: 429,
          headers: { "retry-after": "120" },
        });
      },
    });
    await expect(http.json(url, "history", {}, allow)).rejects.toThrow(
      "cancelled",
    );
    expect(stats.total).toBe(1);
    expect(stats.retries).toBe(0);
  });

  test("pre-cancelled operations make zero requests", async () => {
    const controller = new AbortController();
    controller.abort();
    const stats = requestStats();
    const http = createHttp({
      stats,
      signal: controller.signal,
      fetch: async () => {
        throw new Error("must not dispatch");
      },
    });
    await expect(http.json(url, "history", {}, allow)).rejects.toThrow(
      "cancelled",
    );
    expect(stats.total).toBe(0);
  });

  test("malformed JSON is not retried as a transport failure", async () => {
    const stats = requestStats();
    const http = createHttp({
      stats,
      fetch: async () => new Response("<html>private</html>"),
    });
    await expect(http.json(url, "history", {}, allow)).rejects.toThrow(
      "unreadable JSON",
    );
    expect(stats.total).toBe(1);
  });
});
