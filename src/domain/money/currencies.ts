/**
 * Currency catalog. Mirrors the `public.currencies` table seeded by the
 * initial migration; keep both in sync when adding currencies.
 */
export type CurrencyKind = "fiat" | "crypto" | "stablecoin";

export interface CurrencyInfo {
  code: string;
  kind: CurrencyKind;
  name: string;
  /** Precision stored and used for exact arithmetic. */
  decimals: number;
  /** Precision shown by default in the UI. */
  displayDecimals: number;
  peggedTo?: string;
}

const CATALOG: CurrencyInfo[] = [
  { code: "EUR", kind: "fiat", name: "Euro", decimals: 2, displayDecimals: 2 },
  { code: "BRL", kind: "fiat", name: "Brazilian real", decimals: 2, displayDecimals: 2 },
  { code: "USD", kind: "fiat", name: "US dollar", decimals: 2, displayDecimals: 2 },
  { code: "GBP", kind: "fiat", name: "Pound sterling", decimals: 2, displayDecimals: 2 },
  { code: "CHF", kind: "fiat", name: "Swiss franc", decimals: 2, displayDecimals: 2 },
  { code: "BTC", kind: "crypto", name: "Bitcoin", decimals: 8, displayDecimals: 6 },
  { code: "ETH", kind: "crypto", name: "Ether", decimals: 18, displayDecimals: 5 },
  { code: "POL", kind: "crypto", name: "Polygon", decimals: 18, displayDecimals: 4 },
  { code: "WBTC", kind: "crypto", name: "Wrapped Bitcoin", decimals: 8, displayDecimals: 6 },
  { code: "LINK", kind: "crypto", name: "Chainlink", decimals: 18, displayDecimals: 4 },
  { code: "UNI", kind: "crypto", name: "Uniswap", decimals: 18, displayDecimals: 4 },
  { code: "ARB", kind: "crypto", name: "Arbitrum", decimals: 18, displayDecimals: 4 },
  { code: "OP", kind: "crypto", name: "Optimism", decimals: 18, displayDecimals: 4 },
  { code: "USDC", kind: "stablecoin", name: "USD Coin", decimals: 6, displayDecimals: 2, peggedTo: "USD" },
  { code: "USDT", kind: "stablecoin", name: "Tether USD", decimals: 6, displayDecimals: 2, peggedTo: "USD" },
  { code: "DAI", kind: "stablecoin", name: "Dai", decimals: 18, displayDecimals: 2, peggedTo: "USD" },
  { code: "EURC", kind: "stablecoin", name: "Euro Coin", decimals: 6, displayDecimals: 2, peggedTo: "EUR" },
];

const BY_CODE = new Map(CATALOG.map((c) => [c.code, c]));

export const CURRENCIES: readonly CurrencyInfo[] = CATALOG;

/** Currencies a user can choose as primary display currency. */
export const DISPLAY_CURRENCIES = ["EUR", "BRL", "USD", "BTC", "ETH"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export function isDisplayCurrency(code: string): code is DisplayCurrency {
  return (DISPLAY_CURRENCIES as readonly string[]).includes(code);
}

export function getCurrency(code: string): CurrencyInfo | undefined {
  return BY_CODE.get(code.toUpperCase());
}

export function isKnownCurrency(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}

export function currencyDecimals(code: string): number {
  return getCurrency(code)?.decimals ?? 2;
}

export function displayDecimals(code: string): number {
  return getCurrency(code)?.displayDecimals ?? 2;
}

export function isFiat(code: string): boolean {
  return getCurrency(code)?.kind === "fiat";
}

export function isCryptoLike(code: string): boolean {
  const kind = getCurrency(code)?.kind;
  return kind === "crypto" || kind === "stablecoin";
}

/** Normalizes common symbols / aliases found in bank exports to ISO codes. */
export function normalizeCurrencyCode(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toUpperCase();
  const aliases: Record<string, string> = {
    "€": "EUR",
    "R$": "BRL",
    "US$": "USD",
    "$": "USD",
    "£": "GBP",
    "₿": "BTC",
    XBT: "BTC",
    REAL: "BRL",
    REAIS: "BRL",
    EURO: "EUR",
    EUROS: "EUR",
  };
  const code = aliases[value] ?? value;
  return isKnownCurrency(code) ? code : undefined;
}
