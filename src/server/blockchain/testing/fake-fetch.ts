/**
 * Test doubles for `fetch` (no real network access). Used by provider tests
 * in src/server/blockchain and src/server/market.
 */

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect?: RequestRedirect;
}

export type FakeHandler = (call: RecordedCall) => Response | Promise<Response>;

export type FakeFetch = typeof fetch & { calls: RecordedCall[] };

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that dispatches every request to `handler` and records it. Honours abort signals. */
export function fakeFetch(handler: FakeHandler): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: RecordedCall = { url, method: init?.method ?? "GET", headers, body, ...(init?.redirect ? { redirect: init.redirect } : {}) };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return handler(call);
  };
  return Object.assign(impl as typeof fetch, { calls });
}

/** A fetch that never answers until its signal aborts (simulates a hung upstream). */
export function hangingFetch(): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: new URL(String(input)), method: init?.method ?? "GET", headers: {}, body: undefined });
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  return Object.assign(impl as typeof fetch, { calls });
}
