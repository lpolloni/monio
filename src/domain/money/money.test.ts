import { describe, expect, it } from "vitest";
import { dec, fromBaseUnits, percentChange, sum, toPlain, toScale } from "./decimal";
import { addMoney, CurrencyMismatchError, money, roundToCurrency, sumMoney } from "./money";
import { normalizeCurrencyCode } from "./currencies";

describe("decimal arithmetic", () => {
  it("avoids binary floating point errors", () => {
    expect(toPlain(dec("0.1").plus(dec("0.2")))).toBe("0.3");
    expect(toPlain(sum(["19.99", "0.01", "-20"]))).toBe("0");
  });

  it("keeps 18-decimal crypto precision", () => {
    expect(toPlain(sum(["0.000000000000000001", "1.999999999999999999"]))).toBe("2");
    expect(fromBaseUnits(123456789012345678901n, 18)).toBe("123.456789012345678901");
    expect(fromBaseUnits(150_000_000n, 8)).toBe("1.5");
  });

  it("uses banker's rounding when scaling", () => {
    expect(toScale("1.005", 2)).toBe("1.00");
    expect(toScale("1.015", 2)).toBe("1.02");
    expect(toScale("-2.345", 2)).toBe("-2.34");
  });

  it("rejects non-decimal input instead of guessing", () => {
    expect(() => dec("12,50")).toThrow(TypeError);
    expect(() => dec("1e5x")).toThrow(TypeError);
  });

  it("computes percent change and refuses division by zero", () => {
    expect(percentChange("200", "250")?.toFixed(2)).toBe("25.00");
    expect(percentChange("-100", "-50")?.toFixed(0)).toBe("50");
    expect(percentChange("0", "10")).toBeNull();
  });
});

describe("money", () => {
  it("adds amounts of the same currency", () => {
    expect(addMoney(money("10.10", "EUR"), money("-0.10", "EUR"))).toEqual({ amount: "10", currency: "EUR" });
  });

  it("refuses to mix currencies implicitly", () => {
    expect(() => addMoney(money("1", "EUR"), money("1", "BRL"))).toThrow(CurrencyMismatchError);
    expect(() => sumMoney([money("1", "USD")], "EUR")).toThrow(CurrencyMismatchError);
  });

  it("rounds to the currency's native precision", () => {
    expect(roundToCurrency(money("12.3456", "EUR")).amount).toBe("12.35");
    expect(roundToCurrency(money("0.123456789", "BTC")).amount).toBe("0.12345679");
  });

  it("normalizes currency symbols", () => {
    expect(normalizeCurrencyCode("R$")).toBe("BRL");
    expect(normalizeCurrencyCode("€")).toBe("EUR");
    expect(normalizeCurrencyCode("xbt")).toBe("BTC");
    expect(normalizeCurrencyCode("ZZZ")).toBeUndefined();
  });
});
