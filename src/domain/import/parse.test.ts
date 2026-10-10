import { describe, expect, it } from "vitest";
import { inferDecimalSeparator, parseAmount } from "./parse-amount";
import { inferDateOrder, parseDate } from "./parse-date";

describe("parseAmount", () => {
  it.each([
    ["1.234,56", "1234.56"],
    ["1,234.56", "1234.56"],
    ["-39,90", "-39.9"],
    ["R$ 1.234,56", "1234.56"],
    ["(123.45)", "-123.45"],
    ["123.45-", "-123.45"],
    ["39,90 D", "-39.9"],
    ["39,90 C", "39.9"],
    ["+ 12.00 EUR", "12"],
    ["−12,00", "-12"],
    ["1.234.567", "1234567"],
    ["0,00", "0"],
    ["1'234.50", "1234.5"],
  ])("parses %s", (raw, expected) => {
    expect(parseAmount(raw)?.amount).toBe(expected);
  });

  it("detects currency symbols", () => {
    expect(parseAmount("R$ 10,00")?.currency).toBe("BRL");
    expect(parseAmount("€ -5,00")?.currency).toBe("EUR");
    expect(parseAmount("12.00 USD")?.currency).toBe("USD");
  });

  it("uses the separator hint for ambiguous values", () => {
    expect(parseAmount("1.234")?.amount).toBe("1234");
    expect(parseAmount("1.234", ".")?.amount).toBe("1.234");
    expect(parseAmount("1,234", ",")?.amount).toBe("1.234");
  });

  it("returns null instead of guessing", () => {
    for (const bad of ["", "abc", "12a", "--", "1,2,3.4.5", null, undefined, Number.NaN]) {
      expect(parseAmount(bad as string)).toBeNull();
    }
  });

  it("accepts spreadsheet numbers", () => {
    expect(parseAmount(-1234.5)?.amount).toBe("-1234.5");
    expect(parseAmount(1e-7)?.amount).toBe("0.0000001");
    expect(parseAmount(1e21)?.amount).toBe("1000000000000000000000");
  });

  it("infers the decimal separator of a column", () => {
    expect(inferDecimalSeparator(["1.234,56", "12,00", "1.000"])).toBe(",");
    expect(inferDecimalSeparator(["1,234.56", "12.00"])).toBe(".");
    expect(inferDecimalSeparator(["1000"])).toBeUndefined();
  });
});

describe("parseDate", () => {
  it.each([
    ["2026-03-05", "2026-03-05"],
    ["2026-03-05T22:15:00Z", "2026-03-05"],
    ["20260305120000[-3:BRT]", "2026-03-05"],
    ["05/03/2026", "2026-03-05"],
    ["05.03.26", "2026-03-05"],
    ["5-3-2026", "2026-03-05"],
    ["05 Mar 2026", "2026-03-05"],
    ["5 de março de 2026", "2026-03-05"],
    ["05-mag-2026", "2026-05-05"],
    ["Mar 5, 2026", "2026-03-05"],
  ])("parses %s", (raw, expected) => {
    expect(parseDate(raw)).toBe(expected);
  });

  it("respects MDY order", () => {
    expect(parseDate("03/05/2026", "MDY")).toBe("2026-03-05");
  });

  it("rejects impossible dates", () => {
    expect(parseDate("31/02/2026")).toBeNull();
    expect(parseDate("13/13/2026")).toBeNull();
    expect(parseDate("hello")).toBeNull();
  });

  it("infers day/month order from a column", () => {
    expect(inferDateOrder(["01/02/2026", "25/02/2026"])).toBe("DMY");
    expect(inferDateOrder(["02/25/2026", "02/01/2026"])).toBe("MDY");
    expect(inferDateOrder(["01/02/2026"], "MDY")).toBe("MDY");
  });
});
