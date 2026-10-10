import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { D, type DecimalValue } from "@/domain/money/decimal";
import {
  DERIVED_RATE_DIGITS,
  assertDateRange,
  eachDate,
  makeQuote,
  normalizePairs,
  utcDate,
  type CurrencyPair,
  type RateProvider,
  type RateQuote,
} from "../types";

/**
 * Deterministic offline rate provider (source "mock").
 *
 * Each base series is multi-octave "value noise": seeded lattice points
 * (SHA-256 of series/period/index) every 180, 45 and 9 days, joined with a
 * smoothstep curve and weighted 0.55/0.30/0.15. The result is a smooth
 * random-walk-like path that is a pure function of the date (no Math.random,
 * no state) and is GUARANTEED to stay inside the configured [lo, hi] band.
 * All arithmetic is Decimal — no binary floating point.
 *
 * Every pair is priced through USD, so cross rates are mutually consistent
 * (e.g. USD/BRL = EUR/BRL ÷ EUR/USD).
 */

const SOURCE = "mock";
const DAY_MS = 86_400_000;

interface Band {
  lo: string;
  hi: string;
}

export const MOCK_SERIES: Readonly<Record<string, Band>> = {
  "EUR/USD": { lo: "1.08", hi: "1.18" },
  "EUR/BRL": { lo: "5.8", hi: "6.6" },
  "EUR/GBP": { lo: "0.83", hi: "0.88" },
  "EUR/CHF": { lo: "0.92", hi: "0.97" },
  "BTC/USD": { lo: "55000", hi: "115000" },
  "ETH/USD": { lo: "2000", hi: "4800" },
  "POL/USD": { lo: "0.18", hi: "0.75" },
  "LINK/USD": { lo: "9", hi: "28" },
  "UNI/USD": { lo: "4.5", hi: "17" },
  "ARB/USD": { lo: "0.3", hi: "1.6" },
  "OP/USD": { lo: "0.5", hi: "3.2" },
  "WBTC/BTC": { lo: "0.998", hi: "1.002" },
  "USDC/USD": { lo: "0.998", hi: "1.002" },
  "USDT/USD": { lo: "0.998", hi: "1.002" },
  "DAI/USD": { lo: "0.998", hi: "1.002" },
  "EURC/EUR": { lo: "0.998", hi: "1.002" },
};

const OCTAVES: readonly { period: number; weight: DecimalValue }[] = [
  { period: 180, weight: new D("0.55") },
  { period: 45, weight: new D("0.30") },
  { period: 9, weight: new D("0.15") },
];
const TWO_POW_32 = new D(2).pow(32);
const latticeCache = new Map<string, DecimalValue>();

function lattice(series: string, period: number, k: number): DecimalValue {
  const key = `${series}|${period}|${k}`;
  let v = latticeCache.get(key);
  if (!v) {
    const h = sha256(utf8ToBytes(`monio-mock-fx|${key}`));
    const u32 = ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
    v = new D(u32).dividedBy(TWO_POW_32);
    if (latticeCache.size > 50_000) latticeCache.clear();
    latticeCache.set(key, v);
  }
  return v;
}

/** Smooth deterministic noise in [0, 1] for a series on an integer day. */
function noise(series: string, day: number): DecimalValue {
  let total = new D(0);
  for (const { period, weight } of OCTAVES) {
    const k = Math.floor(day / period);
    const f = new D(day - k * period).dividedBy(period);
    const s = f.times(f).times(new D(3).minus(f.times(2))); // smoothstep
    const v0 = lattice(series, period, k);
    const v1 = lattice(series, period, k + 1);
    total = total.plus(weight.times(v0.plus(v1.minus(v0).times(s))));
  }
  return total;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** Value of a base series (e.g. "BTC/USD") on a date, always within its band. */
export function mockSeriesValue(series: string, date: string): DecimalValue {
  const band = MOCK_SERIES[series];
  if (!band) throw new RangeError(`Unknown mock series ${series}`);
  const lo = new D(band.lo);
  return lo.plus(new D(band.hi).minus(lo).times(noise(series, dayNumber(date))));
}

/** USD value of one unit of `code` on `date`, or null for unknown currencies. */
function usdValue(code: string, date: string): DecimalValue | null {
  const s = (series: string) => mockSeriesValue(series, date);
  switch (code) {
    case "USD":
      return new D(1);
    case "EUR":
      return s("EUR/USD");
    case "BRL":
      return s("EUR/USD").dividedBy(s("EUR/BRL"));
    case "GBP":
      return s("EUR/USD").dividedBy(s("EUR/GBP"));
    case "CHF":
      return s("EUR/USD").dividedBy(s("EUR/CHF"));
    case "BTC":
      return s("BTC/USD");
    case "WBTC":
      return s("WBTC/BTC").times(s("BTC/USD"));
    case "EURC":
      return s("EURC/EUR").times(s("EUR/USD"));
    default: {
      const direct = MOCK_SERIES[`${code}/USD`];
      return direct ? s(`${code}/USD`) : null;
    }
  }
}

/** Mock rate for any supported pair on a date (null when a currency is unknown). */
export function mockRate(base: string, quote: string, date: string): DecimalValue | null {
  const b = usdValue(base, date);
  const q = usdValue(quote, date);
  if (!b || !q) return null;
  return b.dividedBy(q).toSignificantDigits(DERIVED_RATE_DIGITS);
}

export interface MockRateProviderOptions {
  now?: () => Date;
}

export class MockRateProvider implements RateProvider {
  readonly id = SOURCE;
  private readonly now: () => Date;

  constructor(opts: MockRateProviderOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  private quotesFor(pairs: CurrencyPair[], dates: string[]): RateQuote[] {
    const out: RateQuote[] = [];
    for (const { base, quote } of normalizePairs(pairs, SOURCE)) {
      for (const date of dates) {
        const q = makeQuote(base, quote, date, mockRate(base, quote, date), SOURCE);
        if (q) out.push(q);
      }
    }
    return out;
  }

  async fetchLatest(pairs: CurrencyPair[]): Promise<RateQuote[]> {
    return this.quotesFor(pairs, [utcDate(this.now())]);
  }

  async fetchHistorical(pairs: CurrencyPair[], from: string, to: string): Promise<RateQuote[]> {
    assertDateRange(from, to, SOURCE);
    return this.quotesFor(pairs, eachDate(from, to));
  }
}
