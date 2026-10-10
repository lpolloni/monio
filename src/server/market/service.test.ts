import { describe, expect, it } from "vitest";
import { FxTable } from "@/domain/fx/fx-table";
import { fakeFetch, jsonResponse } from "@/server/blockchain/testing/fake-fetch";
import { createMarketDataService, isFiatCode } from "./service";

const NOW = new Date("2026-10-10T12:00:00Z");

describe("createMarketDataService — mock", () => {
  const service = createMarketDataService({ provider: "mock", now: () => NOW });

  it("returns sorted, validated quotes usable by FxTable", async () => {
    const quotes = await service.latest([
      { base: "EUR", quote: "USD" },
      { base: "BTC", quote: "USD" },
      { base: "USD", quote: "BRL" },
    ]);
    expect(service.provider).toBe("mock");
    expect(quotes.map((q) => `${q.base}/${q.quote}`)).toEqual(["BTC/USD", "EUR/USD", "USD/BRL"]);
    const table = new FxTable(quotes);
    const converted = table.convert({ amount: "0.5", currency: "BTC" }, "BRL", "2026-10-10");
    expect(converted?.path).toEqual(["BTC", "USD", "BRL"]);
    expect(Number(converted?.amount)).toBeGreaterThan(0);
  });

  it("serves daily history and validates ranges", async () => {
    const quotes = await service.historical([{ base: "ETH", quote: "EUR" }], "2026-01-01", "2026-01-10");
    expect(quotes.map((q) => q.asOf)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ]);
    await expect(service.historical([{ base: "ETH", quote: "EUR" }], "2000-01-01", "2026-01-01")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.latest([{ base: "", quote: "EUR" }])).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("createMarketDataService — live", () => {
  function liveFetch() {
    return fakeFetch((call) => {
      if (call.url.host === "fx.test") {
        return new Response('{"amount":1.0,"base":"EUR","date":"2026-10-09","rates":{"USD":1.1,"BRL":6.2}}', { status: 200 });
      }
      if (call.url.host === "cg.test") {
        return new Response('{"bitcoin":{"eur":61000.5,"last_updated_at":1760054400},"ethereum":{"eur":2900}}', { status: 200 });
      }
      return new Response("", { status: 500 });
    });
  }

  it("routes fiat pairs to Frankfurter and crypto pairs to CoinGecko", async () => {
    const f = liveFetch();
    const service = createMarketDataService({
      provider: "live",
      frankfurterUrl: "https://fx.test",
      coingeckoUrl: "https://cg.test",
      fetchImpl: f,
      now: () => NOW,
    });
    const quotes = await service.latest([
      { base: "EUR", quote: "USD" },
      { base: "EUR", quote: "BRL" },
      { base: "BTC", quote: "EUR" },
      { base: "ETH", quote: "EUR" },
    ]);
    expect(service.provider).toBe("live");
    expect(quotes.map((q) => [`${q.base}/${q.quote}`, q.rate, q.source])).toEqual([
      ["BTC/EUR", "61000.5", "coingecko"],
      ["ETH/EUR", "2900", "coingecko"],
      ["EUR/BRL", "6.2", "frankfurter"],
      ["EUR/USD", "1.1", "frankfurter"],
    ]);
    expect(new Set(f.calls.map((c) => c.url.host))).toEqual(new Set(["fx.test", "cg.test"]));
  });

  it("rejects when a routed provider fails", async () => {
    const service = createMarketDataService({
      provider: "live",
      frankfurterUrl: "https://fx.test",
      coingeckoUrl: "https://cg.test",
      fetchImpl: fakeFetch((call) => (call.url.host === "cg.test" ? new Response("", { status: 429 }) : jsonResponse({}))),
    });
    await expect(service.latest([{ base: "BTC", quote: "USD" }])).rejects.toMatchObject({ code: "rate_limited", provider: "coingecko" });
  });

  it("classifies fiat codes", () => {
    expect(isFiatCode("EUR")).toBe(true);
    expect(isFiatCode("JPY")).toBe(true);
    expect(isFiatCode("BTC")).toBe(false);
    expect(isFiatCode("USDC")).toBe(false);
    expect(isFiatCode("POL")).toBe(false);
  });
});
