import { D, toPlain } from "../money/decimal";
import { normalizeCurrencyCode } from "../money/currencies";

export type DecimalSeparator = "." | ",";

export interface ParsedAmount {
  /** Signed canonical decimal string ("-1234.56"). */
  amount: string;
  /** Currency detected from a symbol or code inside the raw value, if any. */
  currency?: string;
}

const CURRENCY_TOKEN = /(R\$|US\$|€|£|\$|₿|\b[A-Z]{3,4}\b)/g;

/**
 * Parses amounts as found in bank exports, in any common locale:
 *   "1.234,56"  "1,234.56"  "-39,90"  "R$ 1.234,56"  "(123.45)"  "123.45-"
 *   "39,90 D"   "39,90 C"   "+ 12.00 EUR"  "−12,00" (unicode minus)
 *
 * When the decimal separator is ambiguous ("1.234" / "1,234"), `hint` decides;
 * without a hint a single separator followed by exactly 3 digits is treated as a
 * thousands separator. Returns null for anything that is not an amount — it
 * never guesses digits.
 */
export function parseAmount(raw: string | number | null | undefined, hint?: DecimalSeparator): ParsedAmount | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    // Spreadsheet cells: shortest round-trip representation, expanded from exponent
    // notation (1e-7, 1e21) without passing through further float arithmetic.
    return { amount: toPlain(new D(raw)) };
  }
  let s = raw.trim();
  if (!s) return null;

  let currency: string | undefined;
  for (const match of s.matchAll(CURRENCY_TOKEN)) {
    const code = normalizeCurrencyCode(match[0]);
    if (code) currency = code;
  }
  s = s.replace(CURRENCY_TOKEN, " ");

  let negative = false;
  // Debit / credit suffix markers used by some Brazilian and Italian exports.
  const dc = s.match(/\s([DC])\s*$/i);
  if (dc) {
    negative = dc[1]!.toUpperCase() === "D";
    s = s.slice(0, dc.index);
  }
  s = s.replace(/[−‒–—]/g, "-").replace(/\s+/g, "");
  if (/^\(.*\)$/.test(s)) {
    negative = !negative;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  s = s.replace(/['’_]/g, ""); // Swiss/Italian thousands apostrophes
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSep: DecimalSeparator | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep: DecimalSeparator = lastDot >= 0 ? "." : ",";
    const occurrences = s.split(sep).length - 1;
    const digitsAfter = s.length - s.lastIndexOf(sep) - 1;
    if (occurrences > 1) {
      decimalSep = null; // "1.234.567" -> thousands separators only
    } else if (hint) {
      decimalSep = hint === sep ? sep : null;
    } else {
      decimalSep = digitsAfter === 3 ? null : sep;
    }
  }

  let normalized: string;
  if (decimalSep) {
    const thousands = decimalSep === "." ? "," : ".";
    const parts = s.split(thousands).join("");
    const pieces = parts.split(decimalSep);
    if (pieces.length !== 2) return null;
    normalized = `${pieces[0] || "0"}.${pieces[1]}`;
  } else {
    normalized = s.replace(/[.,]/g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = toPlain(normalized);
  return { amount: negative && value !== "0" ? `-${value}` : value, currency };
}

/**
 * Infers the decimal separator used across a column of values, so that
 * "1.234" can be disambiguated using the rest of the file.
 */
export function inferDecimalSeparator(samples: Iterable<string>): DecimalSeparator | undefined {
  let dot = 0;
  let comma = 0;
  for (const raw of samples) {
    const s = raw.replace(/[^\d.,]/g, "");
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastDot > lastComma) dot++;
      else comma++;
      continue;
    }
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (!sep) continue;
    const digitsAfter = s.length - s.lastIndexOf(sep) - 1;
    if (digitsAfter === 1 || digitsAfter === 2 || digitsAfter > 3) {
      if (sep === ".") dot++;
      else comma++;
    }
  }
  if (dot === 0 && comma === 0) return undefined;
  return dot >= comma ? "." : ",";
}
