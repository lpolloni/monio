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
  { code: "PYG", kind: "fiat", name: "Paraguayan guarani", decimals: 0, displayDecimals: 0 },
  { code: "ARS", kind: "fiat", name: "Argentine peso", decimals: 2, displayDecimals: 2 },
  { code: "CLP", kind: "fiat", name: "Chilean peso", decimals: 0, displayDecimals: 0 },
  { code: "COP", kind: "fiat", name: "Colombian peso", decimals: 2, displayDecimals: 2 },
  { code: "MXN", kind: "fiat", name: "Mexican peso", decimals: 2, displayDecimals: 2 },
  { code: "UYU", kind: "fiat", name: "Uruguayan peso", decimals: 2, displayDecimals: 2 },
  { code: "PEN", kind: "fiat", name: "Peruvian sol", decimals: 2, displayDecimals: 2 },
  { code: "CAD", kind: "fiat", name: "Canadian dollar", decimals: 2, displayDecimals: 2 },
  { code: "AUD", kind: "fiat", name: "Australian dollar", decimals: 2, displayDecimals: 2 },
  { code: "JPY", kind: "fiat", name: "Japanese yen", decimals: 0, displayDecimals: 0 },
  { code: "CNY", kind: "fiat", name: "Chinese yuan", decimals: 2, displayDecimals: 2 },
  { code: "INR", kind: "fiat", name: "Indian rupee", decimals: 2, displayDecimals: 2 },
  { code: "SEK", kind: "fiat", name: "Swedish krona", decimals: 2, displayDecimals: 2 },
  { code: "NOK", kind: "fiat", name: "Norwegian krone", decimals: 2, displayDecimals: 2 },
  { code: "DKK", kind: "fiat", name: "Danish krone", decimals: 2, displayDecimals: 2 },
  { code: "PLN", kind: "fiat", name: "Polish zloty", decimals: 2, displayDecimals: 2 },
  { code: "CZK", kind: "fiat", name: "Czech koruna", decimals: 2, displayDecimals: 2 },
  { code: "HUF", kind: "fiat", name: "Hungarian forint", decimals: 2, displayDecimals: 2 },
  { code: "TRY", kind: "fiat", name: "Turkish lira", decimals: 2, displayDecimals: 2 },
  { code: "ZAR", kind: "fiat", name: "South African rand", decimals: 2, displayDecimals: 2 },
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

/**
 * ISO 4217 codes known to the runtime. Any currency a statement names is one of
 * these: it is shown, converted and stored like the catalog ones. Codes starting
 * with X are not national currencies (metals, XXX/XTS test codes) and are left out.
 */
const ISO_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("currency").filter((c) => /^[A-Z]{3}$/.test(c) && !c.startsWith("X")));
const derived = new Map<string, CurrencyInfo>();

/** True for a currency in the catalog or any ISO 4217 currency. */
export function isIsoCurrency(code: string): boolean {
  return ISO_CODES.has(code.toUpperCase());
}

/** Every ISO currency code, in order. */
export function isoCurrencyCodes(): string[] {
  return [...ISO_CODES];
}

/** True for a currency this catalog describes itself (its rows are seeded). */
export function isCatalogCurrency(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}

/**
 * Describes an ISO currency outside the catalog: a fiat currency, its name and
 * its number of decimals as the ISO standard defines them. Derived once per code.
 */
function describeIso(code: string): CurrencyInfo | undefined {
  if (!isIsoCurrency(code)) return undefined;
  const cached = derived.get(code);
  if (cached) return cached;
  const decimals = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  const name = new Intl.DisplayNames(["en"], { type: "currency" }).of(code) ?? code;
  const info: CurrencyInfo = { code, kind: "fiat", name, decimals, displayDecimals: decimals };
  derived.set(code, info);
  return info;
}

/** Currencies a user can choose as primary display currency. */
export const DISPLAY_CURRENCIES = ["EUR", "BRL", "USD", "BTC", "ETH"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

export function isDisplayCurrency(code: string): code is DisplayCurrency {
  return (DISPLAY_CURRENCIES as readonly string[]).includes(code);
}

export function getCurrency(code: string): CurrencyInfo | undefined {
  const upper = code.toUpperCase();
  return BY_CODE.get(upper) ?? describeIso(upper);
}

export function isKnownCurrency(code: string): boolean {
  return getCurrency(code) !== undefined;
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
    "₲": "PYG",
    GS: "PYG",
    "GS.": "PYG",
    "¥": "JPY",
    "U$S": "USD",
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
