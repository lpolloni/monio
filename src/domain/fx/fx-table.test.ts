import { describe, expect, it } from "vitest";
import { FxTable, type RateQuote } from "./fx-table";

const q = (base: string, quote: string, asOf: string, rate: string): RateQuote => ({
  base,
  quote,
  asOf,
  rate,
  source: "test",
});

const table = new FxTable([
  q("EUR", "USD", "2026-01-01", "1.10"),
  q("EUR", "USD", "2026-02-01", "1.20"),
  q("EUR", "BRL", "2026-01-01", "6.00"),
  q("BTC", "USD", "2026-01-01", "90000"),
  q("BTC", "USD", "2026-01-31", "100000"),
]);

describe("FxTable", () => {
  it("returns identity for the same currency", () => {
    expect(table.convert({ amount: "12.5", currency: "EUR" }, "EUR", "2026-01-15")?.amount).toBe("12.5");
  });

  it("uses the most recent rate on or before the date", () => {
    expect(table.resolve("EUR", "USD", "2026-01-31")?.rate.toString()).toBe("1.1");
    expect(table.resolve("EUR", "USD", "2026-02-01")?.rate.toString()).toBe("1.2");
  });

  it("inverts pairs exactly", () => {
    const r = table.convert({ amount: "120", currency: "USD" }, "EUR", "2026-02-10");
    expect(r?.amount).toBe("100");
    expect(r?.path).toEqual(["USD", "EUR"]);
  });

  it("triangulates through a pivot currency", () => {
    // 1 BTC = 100000 USD; 1 EUR = 1.10 USD on 2026-01-31 => 1 BTC = 90909.0909... EUR
    const r = table.convert({ amount: "1", currency: "BTC" }, "EUR", "2026-01-31");
    expect(r?.path).toEqual(["BTC", "USD", "EUR"]);
    expect(Number(r?.amount)).toBeCloseTo(90909.0909, 3);
  });

  it("converts BRL to USD through EUR", () => {
    const r = table.convert({ amount: "600", currency: "BRL" }, "USD", "2026-01-02");
    expect(r?.amount).toBe("110");
    expect(r?.path).toEqual(["BRL", "EUR", "USD"]);
  });

  it("marks old observations as stale and never extrapolates silently", () => {
    expect(table.resolve("EUR", "BRL", "2026-03-01")?.stale).toBe(true);
    expect(table.resolve("EUR", "USD", "2025-12-01")?.stale).toBe(true);
  });

  it("returns null when no path exists", () => {
    expect(table.resolve("GBP", "CHF", "2026-01-01")).toBeNull();
  });

  it("preserves the original amount alongside the conversion", () => {
    const r = table.convert({ amount: "-39.90", currency: "BRL" }, "EUR", "2026-01-05");
    expect(r?.original).toEqual({ amount: "-39.90", currency: "BRL" });
    expect(r?.amount).toBe("-6.65");
  });
});
