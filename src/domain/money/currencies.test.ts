import { describe, expect, it } from "vitest";
import { getCurrency, isIsoCurrency, isKnownCurrency, isoCurrencyCodes, normalizeCurrencyCode } from "./currencies";

describe("currencies beyond the catalog", () => {
  it("knows every ISO 4217 code, but not the non-national or test codes", () => {
    expect(isIsoCurrency("AED")).toBe(true);
    expect(isIsoCurrency("aed")).toBe(true);
    expect(isIsoCurrency("KES")).toBe(true);
    expect(isIsoCurrency("XAU")).toBe(false);
    expect(isIsoCurrency("XXX")).toBe(false);
    expect(isIsoCurrency("ZZZ")).toBe(false);
    expect(isoCurrencyCodes()).toEqual(expect.arrayContaining(["AED", "PYG", "ARS"]));
  });

  it("describes an unknown ISO currency with its name and the decimals the standard gives it", () => {
    expect(getCurrency("AED")).toEqual({ code: "AED", kind: "fiat", name: "United Arab Emirates Dirham", decimals: 2, displayDecimals: 2 });
    expect(getCurrency("JPY")).toMatchObject({ kind: "fiat", decimals: 0 });
    expect(getCurrency("BHD")).toMatchObject({ decimals: 3 });
    expect(isKnownCurrency("AED")).toBe(true);
    expect(isKnownCurrency("ZZZ")).toBe(false);
  });

  it("normalizes codes and symbols to the ISO code", () => {
    expect(normalizeCurrencyCode("aed")).toBe("AED");
    expect(normalizeCurrencyCode("ZZZ")).toBeUndefined();
    expect(normalizeCurrencyCode("R$")).toBe("BRL");
    expect(normalizeCurrencyCode("Gs.")).toBe("PYG");
  });
});
