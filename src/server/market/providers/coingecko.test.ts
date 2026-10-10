import { describe, expect, it } from "vitest";
import { dec } from "@/domain/money/decimal";
import { fakeFetch, hangingFetch, jsonResponse } from "@/server/blockchain/testing/fake-fetch";
import { CoinGeckoProvider, coingeckoPlan } from "./coingecko";

const NOW = new Date("2026-10-10T12:00:00Z");
const LAST_UPDATED = Math.floor(Date.parse("2026-10-09T23:59:00Z") / 1000);

describe("CoinGeckoProvider.fetchLatest", () => {
  it("maps /simple/price, inverts fiat→crypto pairs and sends the demo key as a header", async () => {
    const body = `{"bitcoin":{"usd":65000.12,"eur":60000.5,"last_updated_at":${LAST_UPDATED}},"usd-coin":{"usd":0.999812345678901234,"eur":0}}`;
    const f = fakeFetch(() => new Response(body, { status: 200 }));
    const quotes = await new CoinGeckoProvider({ fetchImpl: f, apiKey: "CG-DEMO-KEY", now: () => NOW }).fetchLatest([
      { base: "BTC", quote: "USD" },
      { base: "EUR", quote: "BTC" },
      { base: "USDC", quote: "USD" },
      { base: "USDC", quote: "EUR" }, // price 0 → dropped
      { base: "LINK", quote: "UNI" }, // not priceable → skipped
    ]);
    expect(quotes).toEqual([
      { base: "BTC", quote: "USD", asOf: "2026-10-09", rate: "65000.12", source: "coingecko" },
      { base: "EUR", quote: "BTC", asOf: "2026-10-09", rate: dec("1").dividedBy("60000.5").toSignificantDigits(15).toFixed(), source: "coingecko" },
      // No last_updated_at → today's date; full source precision kept.
      { base: "USDC", quote: "USD", asOf: "2026-10-10", rate: "0.999812345678901234", source: "coingecko" },
    ]);
    const call = f.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe("https://api.coingecko.com/api/v3/simple/price");
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      ids: "bitcoin,usd-coin",
      vs_currencies: "eur,usd",
      include_last_updated_at: "true",
    });
    expect(call.headers["x-cg-demo-api-key"]).toBe("CG-DEMO-KEY");
    expect(call.url.href).not.toContain("CG-DEMO-KEY");
  });

  it("makes no request when nothing is priceable", async () => {
    const f = fakeFetch(() => jsonResponse({}));
    await expect(new CoinGeckoProvider({ fetchImpl: f }).fetchLatest([{ base: "LINK", quote: "UNI" }])).resolves.toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("maps errors without leaking the API key", async () => {
    const run = (f: typeof fetch, timeoutMs = 1000) =>
      new CoinGeckoProvider({ fetchImpl: f, timeoutMs, apiKey: "CG-DEMO-KEY" }).fetchLatest([{ base: "BTC", quote: "USD" }]);
    const rateLimited = await run(fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "60" } }))).catch((e: Error) => e);
    expect(rateLimited).toMatchObject({ code: "rate_limited", retryAfterSeconds: 60 });
    expect((rateLimited as Error).message).not.toContain("CG-DEMO-KEY");
    await expect(run(fakeFetch(() => new Response("{", { status: 200 })))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(fakeFetch(() => jsonResponse(["not", "an", "object"])))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(hangingFetch(), 20)).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("CoinGeckoProvider.fetchHistorical", () => {
  it("queries market_chart/range and keeps the last price of each UTC day", async () => {
    const ms = (iso: string) => Date.parse(iso);
    const f = fakeFetch(() =>
      jsonResponse({
        prices: [
          [ms("2026-01-01T00:00:00Z"), 3000.1],
          [ms("2026-01-01T23:00:00Z"), 3010.25],
          [ms("2026-01-02T05:00:00Z"), 0],
          [ms("2026-01-02T12:00:00Z"), 3100.5],
          [ms("2026-01-03T00:00:00Z"), 3200],
        ],
        market_caps: [],
        total_volumes: [],
      }),
    );
    const quotes = await new CoinGeckoProvider({ fetchImpl: f }).fetchHistorical(
      [
        { base: "ETH", quote: "USD" },
        { base: "USD", quote: "ETH" },
      ],
      "2026-01-01",
      "2026-01-02",
    );
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url.pathname).toBe("/api/v3/coins/ethereum/market_chart/range");
    expect(Object.fromEntries(f.calls[0]!.url.searchParams)).toEqual({
      vs_currency: "usd",
      from: String(Date.parse("2026-01-01T00:00:00Z") / 1000),
      to: String(Date.parse("2026-01-02T23:59:59Z") / 1000),
    });
    expect(quotes.filter((q) => q.base === "ETH").map((q) => [q.asOf, q.rate])).toEqual([
      ["2026-01-01", "3010.25"],
      ["2026-01-02", "3100.5"],
    ]);
    const inverse = quotes.find((q) => q.base === "USD" && q.asOf === "2026-01-01")!;
    expect(dec(inverse.rate).times("3010.25").minus(1).abs().lessThan("1e-14")).toBe(true);
  });
});

describe("coingeckoPlan", () => {
  it("routes crypto/fiat directly and fiat/crypto inverted", () => {
    expect(coingeckoPlan({ base: "POL", quote: "BRL" })).toMatchObject({ id: "polygon-ecosystem-token", vs: "brl", invert: false });
    expect(coingeckoPlan({ base: "EUR", quote: "ETH" })).toMatchObject({ id: "ethereum", vs: "eur", invert: true });
    expect(coingeckoPlan({ base: "ETH", quote: "BTC" })).toMatchObject({ id: "ethereum", vs: "btc", invert: false });
    expect(coingeckoPlan({ base: "EUR", quote: "USD" })).toBeNull();
  });
});
