import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const cache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn(), add: vi.fn() };
  const caches = { open: vi.fn().mockResolvedValue(cache), match: vi.fn().mockResolvedValue(new Response("offline")), keys: vi.fn().mockResolvedValue(["other-app", "monio-static-v1", "monio-static-v2"]), delete: vi.fn() };
  const fetch = vi.fn().mockResolvedValue(new Response("online"));
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self: { location: { origin: "https://monio.test" }, addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler; }, skipWaiting: vi.fn(), clients: { claim: vi.fn() } },
    caches, fetch, URL, Response,
  });
  return { handlers, caches, cache, fetch };
}

describe("PWA privacy and offline behavior", () => {
  it("leaves API, RSC, POST and external requests outside the cache", () => {
    const { handlers, caches } = worker();
    for (const [url, method, mode] of [["/api/accounts", "GET", "navigate"], ["/pt?_rsc=x", "GET", "cors"], ["/pt", "POST", "navigate"], ["https://other.test/icons/x.png", "GET", "cors"]] as const) {
      const respondWith = vi.fn();
      handlers.fetch!({ request: { url: new URL(url, "https://monio.test").href, method, mode }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
    expect(caches.open).not.toHaveBeenCalled();
  });

  it("returns a generic fallback on failed navigation without caching the page", async () => {
    const { handlers, fetch, cache } = worker();
    fetch.mockRejectedValue(new TypeError("offline"));
    let response: Promise<Response> | undefined;
    handlers.fetch!({ request: { url: "https://monio.test/pt/activity", method: "GET", mode: "navigate" }, respondWith: (value: Promise<Response>) => { response = value; } });
    expect(await (await response)!.text()).toBe("offline");
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("only deletes obsolete Monio caches", async () => {
    const { handlers, caches } = worker();
    let completion: Promise<unknown> | undefined;
    handlers.activate!({ waitUntil: (value: Promise<unknown>) => { completion = value; } });
    await completion;
    expect(caches.delete.mock.calls).toEqual([["monio-static-v1"]]);
  });
});
