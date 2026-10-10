import { getCurrency, isFiat } from "@/domain/money/currencies";
import { COINGECKO_IDS, CoinGeckoProvider } from "./providers/coingecko";
import { FrankfurterProvider } from "./providers/frankfurter";
import { MockRateProvider } from "./providers/mock";
import {
  assertDateRange,
  assertValidQuote,
  normalizePairs,
  sortQuotes,
  type CurrencyPair,
  type RateFetchOptions,
  type RateProvider,
  type RateQuote,
} from "./types";

/**
 * Market data entry point.
 *
 * mock → MockRateProvider (deterministic; the dev default).
 * live → fiat/fiat pairs via Frankfurter (ECB), every other pair via CoinGecko.
 *
 * Results are validated (rate > 0, ISO date) and sorted by base/quote/date.
 * Pairs a provider cannot price are simply absent from the result. If any
 * routed provider fails, the call rejects with that MarketDataError.
 */

export type MarketProviderMode = "mock" | "live";

export interface MarketDataServiceConfig {
  provider: MarketProviderMode;
  frankfurterUrl?: string;
  coingeckoUrl?: string;
  /** CoinGecko demo API key (sent as the x-cg-demo-api-key header). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

export interface MarketDataService {
  readonly provider: string;
  latest(pairs: CurrencyPair[], opts?: RateFetchOptions): Promise<RateQuote[]>;
  historical(pairs: CurrencyPair[], from: string, to: string, opts?: RateFetchOptions): Promise<RateQuote[]>;
}

/** True for fiat codes routed to the ECB source (catalog fiat, or unknown 3-letter codes that are not crypto). */
export function isFiatCode(code: string): boolean {
  if (isFiat(code)) return true;
  return !getCurrency(code) && !COINGECKO_IDS[code] && /^[A-Z]{3}$/.test(code);
}

const SERVICE = "market";

export function createMarketDataService(config: MarketDataServiceConfig): MarketDataService {
  const shared = {
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
  };

  const route: (pair: CurrencyPair) => RateProvider = (() => {
    if (config.provider === "mock") {
      const mock = new MockRateProvider(config.now ? { now: config.now } : {});
      return () => mock;
    }
    const fiat = new FrankfurterProvider({ ...shared, ...(config.frankfurterUrl ? { baseUrl: config.frankfurterUrl } : {}) });
    const crypto = new CoinGeckoProvider({
      ...shared,
      ...(config.coingeckoUrl ? { baseUrl: config.coingeckoUrl } : {}),
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.now ? { now: config.now } : {}),
    });
    return (pair: CurrencyPair) => (isFiatCode(pair.base) && isFiatCode(pair.quote) ? fiat : crypto);
  })();

  async function dispatch(
    pairs: CurrencyPair[],
    call: (provider: RateProvider, group: CurrencyPair[]) => Promise<RateQuote[]>,
  ): Promise<RateQuote[]> {
    const groups = new Map<RateProvider, CurrencyPair[]>();
    for (const pair of normalizePairs(pairs, SERVICE)) {
      const provider = route(pair);
      groups.set(provider, [...(groups.get(provider) ?? []), pair]);
    }
    const results = await Promise.all([...groups].map(([provider, group]) => call(provider, group)));
    return sortQuotes(results.flat().map((q) => assertValidQuote(q, SERVICE)));
  }

  return {
    provider: config.provider,
    latest: (pairs, opts) => dispatch(pairs, (p, group) => p.fetchLatest(group, opts)),
    historical: async (pairs, from, to, opts) => {
      assertDateRange(from, to, SERVICE);
      return dispatch(pairs, async (p, group) => (p.fetchHistorical ? p.fetchHistorical(group, from, to, opts) : []));
    },
  };
}
