import { D, dec, toPlain, type DecimalValue } from "../money/decimal";
import type { Money } from "../money/money";

/**
 * A single exchange-rate observation: 1 unit of `base` = `rate` units of `quote`
 * on `asOf` (YYYY-MM-DD). Crypto assets are treated as currencies (BTC -> USD).
 */
export interface RateQuote {
  base: string;
  quote: string;
  asOf: string;
  rate: string;
  source: string;
}

export interface ResolvedRate {
  rate: DecimalValue;
  /** Oldest observation date used along the conversion path. */
  asOf: string;
  path: string[];
  sources: string[];
  /** True when the observation is older than the requested date by more than `staleAfterDays`. */
  stale: boolean;
}

export interface ConvertedMoney extends Money {
  original: Money;
  rate: string;
  rateAsOf: string;
  path: string[];
  stale: boolean;
}

const PIVOTS = ["USD", "EUR"];
export const CONVERSION_SCALE = 12;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * In-memory exchange-rate table supporting historical lookups.
 *
 * Lookup rules (deterministic):
 * 1. Use the most recent observation on or before the requested date.
 * 2. Try the direct pair, then the inverse, then triangulate through USD and EUR.
 * 3. Never extrapolate into the future: if only later observations exist, the
 *    earliest one is used and marked stale.
 */
export class FxTable {
  private readonly series = new Map<string, RateQuote[]>();

  constructor(
    quotes: Iterable<RateQuote>,
    private readonly staleAfterDays = 4,
  ) {
    for (const q of quotes) {
      const key = `${q.base}/${q.quote}`;
      const list = this.series.get(key) ?? [];
      list.push(q);
      this.series.set(key, list);
    }
    for (const list of this.series.values()) list.sort((a, b) => a.asOf.localeCompare(b.asOf));
  }

  get size(): number {
    let n = 0;
    for (const list of this.series.values()) n += list.length;
    return n;
  }

  /** Latest observation date available for a pair (direct or inverse). */
  latestDate(): string | undefined {
    let latest: string | undefined;
    for (const list of this.series.values()) {
      const last = list[list.length - 1];
      if (last && (!latest || last.asOf > latest)) latest = last.asOf;
    }
    return latest;
  }

  private findObservation(base: string, quote: string, date: string): RateQuote | undefined {
    const list = this.series.get(`${base}/${quote}`);
    if (!list || list.length === 0) return undefined;
    // binary search: last index with asOf <= date
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.asOf <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? list[found] : list[0];
  }

  private directOrInverse(from: string, to: string, date: string): ResolvedRate | null {
    const direct = this.findObservation(from, to, date);
    const inverse = this.findObservation(to, from, date);
    // Prefer whichever observation is closest to (and not after) the date.
    const pick = (() => {
      if (direct && inverse) {
        const dScore = direct.asOf <= date ? direct.asOf : "";
        const iScore = inverse.asOf <= date ? inverse.asOf : "";
        return dScore >= iScore ? "direct" : "inverse";
      }
      return direct ? "direct" : inverse ? "inverse" : null;
    })();
    if (!pick) return null;
    const obs = (pick === "direct" ? direct : inverse)!;
    const rate = pick === "direct" ? dec(obs.rate) : new D(1).dividedBy(dec(obs.rate));
    const lag = daysBetween(obs.asOf, date);
    return {
      rate,
      asOf: obs.asOf,
      path: [from, to],
      sources: [obs.source],
      stale: lag > this.staleAfterDays || lag < 0,
    };
  }

  resolve(from: string, to: string, date: string): ResolvedRate | null {
    const f = from.toUpperCase();
    const t = to.toUpperCase();
    if (f === t) return { rate: new D(1), asOf: date, path: [f], sources: [], stale: false };

    const simple = this.directOrInverse(f, t, date);
    if (simple) return simple;

    for (const pivot of PIVOTS) {
      if (pivot === f || pivot === t) continue;
      const a = this.directOrInverse(f, pivot, date);
      const b = a ? this.directOrInverse(pivot, t, date) : null;
      if (a && b) {
        return {
          rate: a.rate.times(b.rate),
          asOf: a.asOf < b.asOf ? a.asOf : b.asOf,
          path: [f, pivot, t],
          sources: [...a.sources, ...b.sources],
          stale: a.stale || b.stale,
        };
      }
    }
    // Two pivots (e.g. BRL -> USD -> EUR -> X) for completeness.
    const viaUsd = this.directOrInverse(f, "USD", date);
    const usdEur = this.directOrInverse("USD", "EUR", date);
    const eurTo = this.directOrInverse("EUR", t, date);
    if (viaUsd && usdEur && eurTo) {
      return {
        rate: viaUsd.rate.times(usdEur.rate).times(eurTo.rate),
        asOf: [viaUsd.asOf, usdEur.asOf, eurTo.asOf].sort()[0]!,
        path: [f, "USD", "EUR", t],
        sources: [...viaUsd.sources, ...usdEur.sources, ...eurTo.sources],
        stale: viaUsd.stale || usdEur.stale || eurTo.stale,
      };
    }
    return null;
  }

  /** Converts without mutating or replacing the original amount. */
  convert(value: Money, to: string, date: string): ConvertedMoney | null {
    const resolved = this.resolve(value.currency, to, date);
    if (!resolved) return null;
    return {
      // Converted values are display/aggregation values; 12 places exceeds every
      // supported currency's precision while removing repeating-decimal noise.
      amount: toPlain(dec(value.amount).times(resolved.rate).toDecimalPlaces(CONVERSION_SCALE)),
      currency: to.toUpperCase(),
      original: value,
      rate: toPlain(resolved.rate.toSignificantDigits(20)),
      rateAsOf: resolved.asOf,
      path: resolved.path,
      stale: resolved.stale,
    };
  }
}
