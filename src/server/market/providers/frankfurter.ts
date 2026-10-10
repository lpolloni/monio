import { z } from "zod";
import { joinUrl, requestJson } from "@/server/blockchain/http";
import {
  DEFAULT_MARKET_TIMEOUT_MS,
  MarketDataError,
  assertDateRange,
  isIsoDate,
  makeQuote,
  marketErrorFactory,
  normalizePairs,
  parseMarketResponse,
  parsePositiveRate,
  type CurrencyPair,
  type RateFetchOptions,
  type RateProvider,
  type RateQuote,
} from "../types";

/**
 * ECB reference rates via Frankfurter (https://frankfurter.dev):
 *
 *   GET {base}/v1/latest?base=EUR&symbols=USD,BRL
 *     → { amount, base, date, rates: { USD: 1.0823, BRL: 6.1234 } }
 *   GET {base}/v1/{from}..{to}?base=EUR&symbols=USD,BRL
 *     → { amount, base, start_date, end_date, rates: { "2026-01-02": { USD: …, BRL: … }, … } }
 *
 * One request per distinct base currency; Frankfurter computes cross rates itself.
 * `asOf` is the ECB publication date (business days only; weekends/holidays are
 * absent and FxTable falls back to the previous observation).
 */

export const DEFAULT_FRANKFURTER_URL = "https://api.frankfurter.dev";
const SOURCE = "frankfurter";
const ISO_4217 = /^[A-Z]{3}$/;

export interface FrankfurterProviderOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const IsoDate = z.string().refine(isIsoDate);
const LatestSchema = z.object({ base: z.string(), date: IsoDate, rates: z.record(z.string(), z.unknown()) });
const SeriesSchema = z.object({ base: z.string(), rates: z.record(IsoDate, z.record(z.string(), z.unknown())) });

function groupByBase(pairs: CurrencyPair[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const { base, quote } of pairs) {
    if (!ISO_4217.test(base) || !ISO_4217.test(quote)) {
      throw new MarketDataError("unsupported", SOURCE, { detail: "only ISO-4217 fiat codes are supported" });
    }
    groups.set(base, [...(groups.get(base) ?? []), quote]);
  }
  return groups;
}

export class FrankfurterProvider implements RateProvider {
  readonly id = SOURCE;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FrankfurterProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_FRANKFURTER_URL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MARKET_TIMEOUT_MS;
  }

  private async get(path: string, base: string, symbols: string[], signal?: AbortSignal): Promise<unknown> {
    const url = new URL(joinUrl(this.baseUrl, path));
    url.searchParams.set("base", base);
    url.searchParams.set("symbols", symbols.join(","));
    return requestJson(url.toString(), { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, signal }, marketErrorFactory(SOURCE));
  }

  async fetchLatest(pairs: CurrencyPair[], opts: RateFetchOptions = {}): Promise<RateQuote[]> {
    const out: RateQuote[] = [];
    for (const [base, quotes] of groupByBase(normalizePairs(pairs, SOURCE))) {
      const data = parseMarketResponse(LatestSchema, await this.get("v1/latest", base, quotes, opts.signal), SOURCE);
      if (data.base.toUpperCase() !== base) throw new MarketDataError("invalid_response", SOURCE, { detail: "base mismatch" });
      for (const quote of quotes) {
        const q = makeQuote(base, quote, data.date, parsePositiveRate(data.rates[quote]), SOURCE);
        if (q) out.push(q);
      }
    }
    return out;
  }

  async fetchHistorical(pairs: CurrencyPair[], from: string, to: string, opts: RateFetchOptions = {}): Promise<RateQuote[]> {
    assertDateRange(from, to, SOURCE);
    const out: RateQuote[] = [];
    for (const [base, quotes] of groupByBase(normalizePairs(pairs, SOURCE))) {
      const data = parseMarketResponse(SeriesSchema, await this.get(`v1/${from}..${to}`, base, quotes, opts.signal), SOURCE);
      if (data.base.toUpperCase() !== base) throw new MarketDataError("invalid_response", SOURCE, { detail: "base mismatch" });
      for (const [date, rates] of Object.entries(data.rates)) {
        if (date < from || date > to) continue;
        for (const quote of quotes) {
          const q = makeQuote(base, quote, date, parsePositiveRate(rates[quote]), SOURCE);
          if (q) out.push(q);
        }
      }
    }
    return out;
  }
}
