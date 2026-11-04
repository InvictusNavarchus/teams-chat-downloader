import ky, { isHTTPError, isTimeoutError } from "ky";
import { AppError } from "./errors.ts";

export type Purpose = "history" | "directory";
export type Fetch = (request: Request, init?: RequestInit) => Promise<Response>;
export type RequestStats = {
  total: number;
  history: number;
  directory: number;
  retries: number;
};

export function requestStats(): RequestStats {
  return { total: 0, history: 0, directory: 0, retries: 0 };
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
  return {
    async json(
      url: URL,
      purpose: Purpose,
      headers: Record<string, string>,
      validate: (url: URL) => void,
    ): Promise<unknown> {
      validate(url);
      let attempts = 0;
      try {
        return await ky
          .get(url, {
            headers,
            redirect: "manual",
            signal: config.signal,
            timeout: config.timeoutMs ?? 15_000,
            totalTimeout: config.totalTimeoutMs ?? 60_000,
            retry: {
              limit: config.retryLimit ?? 2,
              methods: ["get"],
              statusCodes: [408, 429, 500, 502, 503, 504],
              afterStatusCodes: [429, 503],
              maxRetryAfter: Number.POSITIVE_INFINITY,
              backoffLimit: 3_000,
              delay:
                config.retryDelay ?? ((attempt) => 300 * 2 ** (attempt - 1)),
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
          })
          .json<unknown>();
      } catch (error) {
        if (config.signal?.aborted) throw new AppError("Export cancelled.");
        if (isHTTPError(error)) {
          const status = error.response.status;
          const detail =
            status === 401 || status === 403
              ? " Refresh the credentials for this service."
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
          `${purpose} request failed or returned an unreadable JSON body.`,
        );
      }
    },
  };
}

export type Http = ReturnType<typeof createHttp>;
