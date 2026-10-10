import { z } from "zod";
import { requestJson } from "@/server/blockchain/http";
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
 * Daily rates for the fiat currencies the ECB does not publish (PYG, ARS, CLP,
 * COP, UYU, PEN...), from the open currency-api dataset served by jsDelivr:
 *
 *   GET {base}@{latest|YYYY-MM-DD}/v1/currencies/eur.min.json
 *     → { date: "2026-08-31", eur: { pyg: 8621.4, usd: 1.12, … } }
 *
 * One file per base currency and day. History is therefore sampled — the first
 * day of the range, each month end inside it and its last day — which is enough
 * for FxTable to convert a past movement at a rate of its own month.
 */

export const DEFAULT_CURRENCY_API_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api";
const SOURCE = "currency-api";
const ISO_4217 = /^[A-Z]{3}$/;
const MAX_SAMPLES = 16;

export interface CurrencyApiProviderOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DaySchema = z.object({ date: z.string().refine(isIsoDate) }).catchall(z.unknown());

function groupByBase(pairs: CurrencyPair[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const { base, quote } of pairs) {
    if (!ISO_4217.test(base) || !ISO_4217.test(quote)) throw new MarketDataError("unsupported", SOURCE, { detail: "only ISO-4217 fiat codes are supported" });
    groups.set(base, [...(groups.get(base) ?? []), quote]);
  }
  return groups;
}

/** The first day, every month end and the last day of a range. */
export function sampleDates(from: string, to: string): string[] {
  const out = new Set([from]);
  const cursor = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < 240; i++) {
    const end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1 + i, 0)).toISOString().slice(0, 10);
    if (end >= to) break;
    if (end > from) out.add(end);
  }
  out.add(to);
  return [...out].sort().slice(-MAX_SAMPLES);
}

export class CurrencyApiProvider implements RateProvider {
  readonly id = SOURCE;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: CurrencyApiProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CURRENCY_API_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MARKET_TIMEOUT_MS;
  }

  private async day(version: string, base: string, quotes: string[], signal?: AbortSignal): Promise<RateQuote[]> {
    const url = `${this.baseUrl}@${version}/v1/currencies/${base.toLowerCase()}.min.json`;
    const data = parseMarketResponse(DaySchema, await requestJson(url, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, signal }, marketErrorFactory(SOURCE)), SOURCE);
    const rates = z.record(z.string(), z.unknown()).safeParse(data[base.toLowerCase()]);
    if (!rates.success) throw new MarketDataError("invalid_response", SOURCE, { detail: "base mismatch" });
    return quotes.flatMap((quote) => {
      const q = makeQuote(base, quote, data.date, parsePositiveRate(rates.data[quote.toLowerCase()]), SOURCE);
      return q ? [q] : [];
    });
  }

  async fetchLatest(pairs: CurrencyPair[], opts: RateFetchOptions = {}): Promise<RateQuote[]> {
    const out: RateQuote[] = [];
    for (const [base, quotes] of groupByBase(normalizePairs(pairs, SOURCE))) out.push(...(await this.day("latest", base, quotes, opts.signal)));
    return out;
  }

  async fetchHistorical(pairs: CurrencyPair[], from: string, to: string, opts: RateFetchOptions = {}): Promise<RateQuote[]> {
    assertDateRange(from, to, SOURCE);
    const out: RateQuote[] = [];
    for (const [base, quotes] of groupByBase(normalizePairs(pairs, SOURCE))) {
      for (const date of sampleDates(from, to)) {
        try {
          out.push(...(await this.day(date, base, quotes, opts.signal)).filter((q) => q.asOf >= from && q.asOf <= to));
        } catch (error) {
          // A day the dataset does not hold (too old, not published yet) is simply absent.
          if (!(error instanceof MarketDataError) || error.code !== "not_found") throw error;
        }
      }
    }
    return out;
  }
}
