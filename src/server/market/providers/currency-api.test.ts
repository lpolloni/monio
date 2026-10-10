import { describe, expect, it } from "vitest";
import { fakeFetch, jsonResponse } from "@/server/blockchain/testing/fake-fetch";
import { createMarketDataService } from "../service";
import { CurrencyApiProvider, sampleDates } from "./currency-api";

describe("CurrencyApiProvider", () => {
  it("reads the latest day of a base currency", async () => {
    const f = fakeFetch(() => jsonResponse({ date: "2026-10-10", eur: { pyg: 8621.4, usd: 1.12, brl: 5.6 } }));
    const quotes = await new CurrencyApiProvider({ fetchImpl: f }).fetchLatest([{ base: "EUR", quote: "PYG" }]);
    expect(quotes).toEqual([{ base: "EUR", quote: "PYG", asOf: "2026-10-10", rate: "8621.4", source: "currency-api" }]);
    expect(f.calls[0]!.url.href).toBe("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.min.json");
  });

  it("samples history at the start, each month end and the end of the range, skipping days the dataset lacks", async () => {
    expect(sampleDates("2026-08-03", "2026-10-10")).toEqual(["2026-08-03", "2026-08-31", "2026-09-30", "2026-10-10"]);
    const f = fakeFetch((call) => {
      const date = /@(\d{4}-\d{2}-\d{2})\//.exec(call.url.href)![1]!;
      return date === "2026-08-31" ? new Response("not found", { status: 404 }) : jsonResponse({ date, eur: { pyg: 8600 } });
    });
    const quotes = await new CurrencyApiProvider({ fetchImpl: f }).fetchHistorical([{ base: "EUR", quote: "PYG" }], "2026-08-03", "2026-10-10");
    expect(quotes.map((q) => q.asOf)).toEqual(["2026-08-03", "2026-09-30", "2026-10-10"]);
  });

  it("is used only for fiat currencies the ECB does not publish", async () => {
    const f = fakeFetch((call) =>
      call.url.hostname === "api.frankfurter.dev"
        ? jsonResponse({ amount: 1, base: "EUR", date: "2026-10-09", rates: { USD: 1.12 } })
        : jsonResponse({ date: "2026-10-10", eur: { pyg: 8621.4 } }),
    );
    const quotes = await createMarketDataService({ provider: "live", fetchImpl: f }).latest([{ base: "EUR", quote: "USD" }, { base: "EUR", quote: "PYG" }]);
    expect(quotes.map((q) => [q.quote, q.source])).toEqual([["PYG", "currency-api"], ["USD", "frankfurter"]]);
    expect(f.calls.map((c) => c.url.hostname).sort()).toEqual(["api.frankfurter.dev", "cdn.jsdelivr.net"]);
  });
});
