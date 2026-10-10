import { z } from "zod";
import { D, toPlain, type DecimalValue } from "@/domain/money/decimal";
import { joinUrl, mapWithConcurrency, requestJson } from "@/server/blockchain/http";
import {
  DEFAULT_MARKET_TIMEOUT_MS,
  DERIVED_RATE_DIGITS,
  assertDateRange,
  makeQuote,
  marketErrorFactory,
  normalizePairs,
  parseMarketResponse,
  parsePositiveRate,
  utcDate,
  type CurrencyPair,
  type RateFetchOptions,
  type RateProvider,
  type RateQuote,
} from "../types";

/**
 * Crypto prices via CoinGecko:
 *
 *   GET {base}/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,eur,brl&include_last_updated_at=true
 *     → { bitcoin: { usd: 65000.12, eur: …, last_updated_at: 1712345678 }, … }
 *   GET {base}/api/v3/coins/{id}/market_chart/range?vs_currency=usd&from={unix}&to={unix}
 *     → { prices: [[ms, price], …], market_caps: …, total_volumes: … }
 *
 * The optional demo API key is sent in the `x-cg-demo-api-key` header (never in
 * the URL, never echoed). Historical ranges > 90 days come back as daily points;
 * shorter ranges are hourly and are reduced to the LAST point of each UTC day.
 * The public/demo tier only serves the last 365 days of history.
 * Pairs whose base is fiat and quote is crypto (EUR/BTC) are inverted locally.
 */

export const DEFAULT_COINGECKO_URL = "https://api.coingecko.com";
const SOURCE = "coingecko";

/**
 * Currency code ↔ CoinGecko coin id. `polygon-ecosystem-token` (POL) and
 * `euro-coin` (EURC) are believed correct but were not verifiable offline; an
 * unknown id simply yields no quote.
 */
export const COINGECKO_IDS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  WBTC: "wrapped-bitcoin",
  POL: "polygon-ecosystem-token",
  LINK: "chainlink",
  UNI: "uniswap",
  ARB: "arbitrum",
  OP: "optimism",
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  EURC: "euro-coin",
};

/** vs_currencies used by Monio (CoinGecko supports these among many others). */
export const COINGECKO_VS_CURRENCIES: ReadonlySet<string> = new Set(["usd", "eur", "brl", "gbp", "chf", "btc", "eth"]);

export interface CoinGeckoProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => Date;
}

interface Plan {
  pair: CurrencyPair;
  id: string;
  vs: string;
  invert: boolean;
}

/** How a pair is priced on CoinGecko, or null when it cannot be. */
export function coingeckoPlan(pair: CurrencyPair): Plan | null {
  const baseId = COINGECKO_IDS[pair.base];
  const quoteId = COINGECKO_IDS[pair.quote];
  const quoteVs = pair.quote.toLowerCase();
  const baseVs = pair.base.toLowerCase();
  if (baseId && COINGECKO_VS_CURRENCIES.has(quoteVs)) return { pair, id: baseId, vs: quoteVs, invert: false };
  if (quoteId && COINGECKO_VS_CURRENCIES.has(baseVs)) return { pair, id: quoteId, vs: baseVs, invert: true };
  return null;
}

const SimplePriceSchema = z.record(z.string(), z.record(z.string(), z.unknown()));
const RangeSchema = z.object({ prices: z.array(z.tuple([z.union([z.string(), z.number()]), z.unknown()])) });

function applyDirection(price: DecimalValue | null, invert: boolean): DecimalValue | null {
  if (!price) return null;
  return invert ? new D(1).dividedBy(price).toSignificantDigits(DERIVED_RATE_DIGITS) : price;
}

export class CoinGeckoProvider implements RateProvider {
  readonly id = SOURCE;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly now: () => Date;

  constructor(opts: CoinGeckoProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_COINGECKO_URL;
    this.apiKey = opts.apiKey || undefined;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MARKET_TIMEOUT_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.now = opts.now ?? (() => new Date());
  }

  private async get(path: string, query: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(joinUrl(this.baseUrl, path));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return requestJson(
      url.toString(),
      {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        signal,
        ...(this.apiKey ? { headers: { "x-cg-demo-api-key": this.apiKey } } : {}),
      },
      marketErrorFactory(SOURCE),
    );
  }

  async fetchLatest(pairs: CurrencyPair[], opts: RateFetchOptions = {}): Promise<RateQuote[]> {
    const plans = normalizePairs(pairs, SOURCE)
      .map(coingeckoPlan)
      .filter((p): p is Plan => p !== null);
    if (plans.length === 0) return [];
    const ids = [...new Set(plans.map((p) => p.id))].sort();
    const vs = [...new Set(plans.map((p) => p.vs))].sort();
    const data = parseMarketResponse(
      SimplePriceSchema,
      await this.get(
        "api/v3/simple/price",
        { ids: ids.join(","), vs_currencies: vs.join(","), include_last_updated_at: "true" },
        opts.signal,
      ),
      SOURCE,
    );
    const today = utcDate(this.now());
    const out: RateQuote[] = [];
    for (const plan of plans) {
      const entry = data[plan.id];
      if (!entry) continue;
      const updated = typeof entry.last_updated_at === "string" && /^\d{1,12}$/.test(entry.last_updated_at)
        ? utcDate(new Date(Number(entry.last_updated_at) * 1000))
        : today;
      const rate = applyDirection(parsePositiveRate(entry[plan.vs]), plan.invert);
      const q = makeQuote(plan.pair.base, plan.pair.quote, updated, rate, SOURCE);
      if (q) out.push(q);
    }
    return out;
  }

  async fetchHistorical(pairs: CurrencyPair[], from: string, to: string, opts: RateFetchOptions = {}): Promise<RateQuote[]> {
    assertDateRange(from, to, SOURCE);
    const plans = normalizePairs(pairs, SOURCE)
      .map(coingeckoPlan)
      .filter((p): p is Plan => p !== null);
    const series = [...new Map(plans.map((p) => [`${p.id}|${p.vs}`, { id: p.id, vs: p.vs }])).values()];
    const fromUnix = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const toUnix = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000);

    const closes = new Map<string, Map<string, string>>();
    await mapWithConcurrency(series, this.concurrency, async ({ id, vs }) => {
      const data = parseMarketResponse(
        RangeSchema,
        await this.get(
          `api/v3/coins/${encodeURIComponent(id)}/market_chart/range`,
          { vs_currency: vs, from: String(fromUnix), to: String(toUnix) },
          opts.signal,
        ),
        SOURCE,
      );
      const byDay = new Map<string, { ts: number; price: unknown }>();
      for (const [tsRaw, price] of data.prices) {
        const ts = Number(tsRaw);
        if (!Number.isFinite(ts)) continue;
        const day = utcDate(new Date(ts));
        const prev = byDay.get(day);
        if (!prev || ts >= prev.ts) byDay.set(day, { ts, price });
      }
      const daily = new Map<string, string>();
      for (const [day, { price }] of byDay) {
        const value = parsePositiveRate(price);
        if (value && day >= from && day <= to) daily.set(day, toPlain(value));
      }
      closes.set(`${id}|${vs}`, daily);
    });

    const out: RateQuote[] = [];
    for (const plan of plans) {
      for (const [day, price] of closes.get(`${plan.id}|${plan.vs}`) ?? []) {
        const q = makeQuote(plan.pair.base, plan.pair.quote, day, applyDirection(new D(price), plan.invert), SOURCE);
        if (q) out.push(q);
      }
    }
    return out;
  }
}
