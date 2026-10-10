import { describe, expect, it } from "vitest";
import { fakeFetch, hangingFetch, jsonResponse } from "@/server/blockchain/testing/fake-fetch";
import { MarketDataError } from "../types";
import { FrankfurterProvider } from "./frankfurter";

const latestBody = (base: string, rates: string) => `{"amount":1.0,"base":"${base}","date":"2026-10-09","rates":${rates}}`;

describe("FrankfurterProvider", () => {
  it("maps /v1/latest to quotes with exact decimal rates (one request per base)", async () => {
    const f = fakeFetch((call) => {
      const base = call.url.searchParams.get("base")!;
      return base === "EUR"
        ? new Response(latestBody("EUR", '{"USD":1.1234,"BRL":6.12345678901234567}'), { status: 200 })
        : new Response(latestBody("USD", '{"BRL":5.4321}'), { status: 200 });
    });
    const quotes = await new FrankfurterProvider({ fetchImpl: f }).fetchLatest([
      { base: "EUR", quote: "USD" },
      { base: "EUR", quote: "BRL" },
      { base: "usd", quote: "brl" },
    ]);
    expect(quotes).toEqual([
      { base: "EUR", quote: "USD", asOf: "2026-10-09", rate: "1.1234", source: "frankfurter" },
      { base: "EUR", quote: "BRL", asOf: "2026-10-09", rate: "6.12345678901234567", source: "frankfurter" },
      { base: "USD", quote: "BRL", asOf: "2026-10-09", rate: "5.4321", source: "frankfurter" },
    ]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url.origin + f.calls[0]!.url.pathname).toBe("https://api.frankfurter.dev/v1/latest");
    expect(Object.fromEntries(f.calls[0]!.url.searchParams)).toEqual({ base: "EUR", symbols: "USD,BRL" });
  });

  it("maps the time-series endpoint", async () => {
    const f = fakeFetch(() =>
      jsonResponse({
        amount: 1,
        base: "EUR",
        start_date: "2026-01-02",
        end_date: "2026-01-05",
        rates: { "2026-01-02": { USD: 1.03, BRL: 6.3 }, "2026-01-05": { USD: 1.04, BRL: 6.31 } },
      }),
    );
    const quotes = await new FrankfurterProvider({ fetchImpl: f, baseUrl: "https://fx.example.test/" }).fetchHistorical(
      [
        { base: "EUR", quote: "USD" },
        { base: "EUR", quote: "BRL" },
      ],
      "2026-01-01",
      "2026-01-05",
    );
    expect(f.calls[0]!.url.pathname).toBe("/v1/2026-01-01..2026-01-05");
    expect(quotes.map((q) => `${q.asOf} ${q.base}/${q.quote} ${q.rate}`)).toEqual([
      "2026-01-02 EUR/USD 1.03",
      "2026-01-02 EUR/BRL 6.3",
      "2026-01-05 EUR/USD 1.04",
      "2026-01-05 EUR/BRL 6.31",
    ]);
  });

  it("drops non-positive and non-numeric rates", async () => {
    const f = fakeFetch(() => new Response(latestBody("EUR", '{"USD":0,"BRL":-6.1,"GBP":"NaN","CHF":0.94}'), { status: 200 }));
    const quotes = await new FrankfurterProvider({ fetchImpl: f }).fetchLatest(
      ["USD", "BRL", "GBP", "CHF"].map((quote) => ({ base: "EUR", quote })),
    );
    expect(quotes.map((q) => q.quote)).toEqual(["CHF"]);
  });

  it("maps errors: 429, malformed JSON, wrong shape, base mismatch, timeout, crypto codes", async () => {
    const run = (f: typeof fetch, timeoutMs = 1000) =>
      new FrankfurterProvider({ fetchImpl: f, timeoutMs }).fetchLatest([{ base: "EUR", quote: "USD" }]);
    await expect(run(fakeFetch(() => new Response("", { status: 429 })))).rejects.toMatchObject({ code: "rate_limited" });
    await expect(run(fakeFetch(() => new Response("<html>", { status: 200 })))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(fakeFetch(() => jsonResponse({ rates: [] })))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(fakeFetch(() => new Response(latestBody("USD", "{}"), { status: 200 })))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(hangingFetch(), 20)).rejects.toMatchObject({ code: "timeout" });
    await expect(
      new FrankfurterProvider({ fetchImpl: fakeFetch(() => jsonResponse({})) }).fetchLatest([{ base: "BTC", quote: "EUR" }]),
    ).rejects.toBeInstanceOf(MarketDataError);
  });
});
