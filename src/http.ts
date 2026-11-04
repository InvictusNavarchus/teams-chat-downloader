import ky, { isHTTPError, isTimeoutError, type ResponsePromise } from "ky";
import { AppError } from "./errors.ts";

export type Purpose = "history" | "directory" | "profiles" | "media";
export type Fetch = (request: Request, init?: RequestInit) => Promise<Response>;
export type RequestStats = {
  total: number;
  history: number;
  directory: number;
  profiles: number;
  media: number;
  retries: number;
};

export function requestStats(): RequestStats {
  return {
    total: 0,
    history: 0,
    directory: 0,
    profiles: 0,
    media: 0,
    retries: 0,
  };
}

export function createHttp(config: {
  stats: RequestStats;
  signal?: AbortSignal;
  fetch?: Fetch;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  retryLimit?: number;
  retryDelay?: (attempt: number) => number;
}) {
  async function request<T>(
    url: URL,
    purpose: Purpose,
    headers: Record<string, string>,
    validate: (url: URL) => void,
    consume: (response: ResponsePromise) => Promise<T>,
    readBody?: string[],
  ): Promise<T> {
    validate(url);
    let attempts = 0;
    try {
      return await consume(
        ky(url, {
          method: readBody === undefined ? "get" : "post",
          ...(readBody === undefined ? {} : { json: readBody }),
          headers,
          redirect: "manual",
          signal: config.signal,
          timeout: config.timeoutMs ?? 15_000,
          totalTimeout: config.totalTimeoutMs ?? 60_000,
          ...(purpose === "media"
            ? {
                maxResponseSize: 50 * 1024 * 1024,
                throwHttpErrors: (status: number) => status !== 304,
              }
            : {}),
          retry: {
            limit: config.retryLimit ?? 2,
            // The only POST callers are the two read-only profile batch routes.
            methods: ["get", "post"],
            statusCodes: [408, 429, 500, 502, 503, 504],
            afterStatusCodes: [429, 503],
            maxRetryAfter: Number.POSITIVE_INFINITY,
            backoffLimit: 3_000,
            delay: config.retryDelay ?? ((attempt) => 300 * 2 ** (attempt - 1)),
          },
          fetch: async (request, init) => {
            request.signal.throwIfAborted();
            config.signal?.throwIfAborted();
            validate(new URL(request.url));
            config.stats.total++;
            config.stats[purpose]++;
            if (attempts++ > 0) config.stats.retries++;
            return (config.fetch ?? fetch)(request, init);
          },
        }),
      );
    } catch (error) {
      if (config.signal?.aborted) throw new AppError("Export cancelled.");
      if (isHTTPError(error)) {
        const status = error.response.status;
        const detail =
          status === 401 || status === 403
            ? " Run teams login to refresh credentials, then retry."
            : status >= 300 && status < 400
              ? " Redirects are refused before forwarding credentials."
              : "";
        throw new AppError(
          `${purpose} request failed (HTTP ${status}).${detail}`,
        );
      }
      if (isTimeoutError(error))
        throw new AppError(`${purpose} request exceeded its time budget.`);
      if (error instanceof AppError) throw error;
      throw new AppError(
        `${purpose} request failed or returned an unreadable ${purpose === "media" ? "image" : "JSON"} body.`,
      );
    }
  }
  return {
    json(
      url: URL,
      purpose: Purpose,
      headers: Record<string, string>,
      validate: (url: URL) => void,
      readBody?: string[],
    ) {
      return request(
        url,
        purpose,
        headers,
        validate,
        (response) => response.json<unknown>(),
        readBody,
      );
    },
    image(
      url: URL,
      headers: Record<string, string>,
      validate: (url: URL) => void,
    ) {
      return request(url, "media", headers, validate, async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        const result = await response;
        return { bytes, status: result.status, headers: result.headers };
      });
    },
  };
}

export type Http = ReturnType<typeof createHttp>;
