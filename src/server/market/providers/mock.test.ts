import { describe, expect, it } from "vitest";
import { D, dec, isDecimalString } from "@/domain/money/decimal";
import { addDays, eachDate } from "../types";
import { MOCK_SERIES, MockRateProvider, mockRate, mockSeriesValue } from "./mock";

const provider = new MockRateProvider({ now: () => new Date("2026-10-10T08:00:00Z") });
const SAMPLE_DATES = eachDate("2015-01-01", "2027-12-31").filter((_, i) => i % 9 === 0);

describe("MockRateProvider", () => {
  it("is deterministic for a given date (no Math.random)", async () => {
    const pairs = [
      { base: "BTC", quote: "EUR" },
      { base: "EUR", quote: "BRL" },
    ];
    const a = await provider.fetchHistorical(pairs, "2025-01-01", "2025-01-31");
    const b = await new MockRateProvider().fetchHistorical(pairs, "2025-01-01", "2025-01-31");
    expect(b).toEqual(a);
    expect(a).toHaveLength(62);
    expect(a.every((q) => q.source === "mock" && isDecimalString(q.rate) && dec(q.rate).greaterThan(0))).toBe(true);
  });

  it("uses the injected clock for latest quotes and skips unknown currencies", async () => {
    const quotes = await provider.fetchLatest([
      { base: "eth", quote: "usd" },
      { base: "XYZ", quote: "USD" },
      { base: "USD", quote: "USD" },
    ]);
    expect(quotes).toEqual([{ base: "ETH", quote: "USD", asOf: "2026-10-10", rate: mockRate("ETH", "USD", "2026-10-10")!.toFixed(), source: "mock" }]);
  });

  it.each(Object.entries(MOCK_SERIES))("keeps %s inside its plausible band on every date", (series, band) => {
    for (const date of SAMPLE_DATES) {
      const v = mockSeriesValue(series, date);
      expect(v.greaterThanOrEqualTo(band.lo), `${series} ${date}`).toBe(true);
      expect(v.lessThanOrEqualTo(band.hi), `${series} ${date}`).toBe(true);
    }
  });

  it("produces realistic levels for the headline pairs", () => {
    for (const date of SAMPLE_DATES) {
      const eurUsd = mockRate("EUR", "USD", date)!;
      const eurBrl = mockRate("EUR", "BRL", date)!;
      const usdBrl = mockRate("USD", "BRL", date)!;
      expect(eurUsd.greaterThanOrEqualTo("1.08") && eurUsd.lessThanOrEqualTo("1.18")).toBe(true);
      expect(eurBrl.greaterThanOrEqualTo("5.8") && eurBrl.lessThanOrEqualTo("6.6")).toBe(true);
      // USD/BRL is derived consistently from the EUR legs.
      expect(usdBrl.minus(eurBrl.dividedBy(eurUsd)).abs().lessThan("1e-12")).toBe(true);
      const btc = mockRate("BTC", "USD", date)!;
      expect(btc.greaterThanOrEqualTo(55_000) && btc.lessThanOrEqualTo(115_000)).toBe(true);
      const eth = mockRate("ETH", "USD", date)!;
      expect(eth.greaterThanOrEqualTo(2_000) && eth.lessThanOrEqualTo(4_800)).toBe(true);
      for (const stable of ["USDC", "USDT", "DAI"]) {
        expect(mockRate(stable, "USD", date)!.minus(1).abs().lessThanOrEqualTo("0.002")).toBe(true);
      }
      expect(mockRate("EURC", "EUR", date)!.minus(1).abs().lessThanOrEqualTo("0.002")).toBe(true);
      expect(mockRate("WBTC", "BTC", date)!.minus(1).abs().lessThanOrEqualTo("0.002")).toBe(true);
    }
  });

  it("is consistent across inverse and cross pairs", () => {
    const date = "2026-03-15";
    const btcEur = mockRate("BTC", "EUR", date)!;
    const eurBtc = mockRate("EUR", "BTC", date)!;
    expect(btcEur.times(eurBtc).minus(1).abs().lessThan("1e-12")).toBe(true);
    const viaUsd = mockRate("BTC", "USD", date)!.dividedBy(mockRate("EUR", "USD", date)!);
    expect(btcEur.minus(viaUsd).abs().dividedBy(btcEur).lessThan("1e-12")).toBe(true);
  });

  it("moves smoothly from day to day", () => {
    for (const series of ["BTC/USD", "EUR/USD", "ETH/USD"]) {
      const band = MOCK_SERIES[series]!;
      const width = new D(band.hi).minus(band.lo);
      let prev = mockSeriesValue(series, "2024-01-01");
      for (let d = "2024-01-02"; d <= "2025-12-31"; d = addDays(d, 1)) {
        const v = mockSeriesValue(series, d);
        expect(v.minus(prev).abs().dividedBy(width).lessThan("0.06")).toBe(true);
        prev = v;
      }
    }
  });

  it("rejects invalid ranges and codes", async () => {
    await expect(provider.fetchHistorical([{ base: "BTC", quote: "USD" }], "2025-02-01", "2025-01-01")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.fetchHistorical([{ base: "BTC", quote: "USD" }], "2025-02-30", "2025-03-01")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.fetchLatest([{ base: "B TC", quote: "USD" }])).rejects.toMatchObject({ code: "invalid_request" });
  });
});
