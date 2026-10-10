/**
 * Minimal JSON-over-HTTP helper shared by the blockchain and market providers.
 *
 * - Every request has a timeout (AbortController) and honours a caller signal.
 * - HTTP 429 → rate_limited (with Retry-After), 404 → not_found, other non-2xx → network.
 * - JSON numbers are parsed from their SOURCE TEXT (ES2023 JSON.parse source access, Node ≥ 21),
 *   so balances and prices never round-trip through binary floating point. Every number in the
 *   returned value is a string.
 * - Failures carry no URL (URLs contain addresses and sometimes API keys).
 * - Redirects are refused (surface as `network`).
 */

export type UpstreamErrorCode = "network" | "rate_limited" | "not_found" | "invalid_response" | "timeout" | "aborted";

export interface UpstreamFailure {
  code: UpstreamErrorCode;
  status?: number;
  retryAfterSeconds?: number;
  detail?: string;
}

export interface JsonRequest {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** JSON-serializable body (POST only). */
  body?: unknown;
}

/** JSON.parse that keeps every number as its exact decimal source text. */
export function parseJsonPreservingNumbers(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" ? (context?.source ?? String(value)) : value,
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export async function requestJson<E extends Error>(
  url: string,
  req: JsonRequest,
  toError: (failure: UpstreamFailure) => E,
): Promise<unknown> {
  if (req.signal?.aborted) throw toError({ code: "aborted" });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);
  const onAbort = () => controller.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });

  const abortedFailure = (): UpstreamFailure | null =>
    timedOut ? { code: "timeout" } : req.signal?.aborted ? { code: "aborted" } : null;

  try {
    let res: Response;
    try {
      res = await req.fetchImpl(url, {
        method: req.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
          ...req.headers,
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
        // Read-only JSON APIs never need redirects; refusing them prevents header-borne API keys
        // from being forwarded to another origin.
        redirect: "error",
      });
    } catch {
      throw toError(abortedFailure() ?? { code: "network", detail: "request failed" });
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 429) {
        const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
        throw toError({ code: "rate_limited", status: 429, ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) });
      }
      if (res.status === 404) throw toError({ code: "not_found", status: 404 });
      throw toError({ code: "network", status: res.status, detail: "upstream error status" });
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      throw toError(abortedFailure() ?? { code: "network", detail: "failed reading body" });
    }
    try {
      return parseJsonPreservingNumbers(text);
    } catch {
      throw toError({ code: "invalid_response", detail: "malformed JSON" });
    }
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

/** Runs `fn` over `items` with at most `limit` concurrent calls, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Joins a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
