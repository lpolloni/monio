import { z } from "zod";
import { D, toPlain, type DecimalValue } from "@/domain/money/decimal";
import type { RateQuote } from "@/domain/fx/fx-table";
import type { UpstreamErrorCode, UpstreamFailure } from "@/server/blockchain/http";

export type { RateQuote } from "@/domain/fx/fx-table";

/**
 * Market-data contracts. A RateQuote means: 1 `base` = `rate` `quote` on `asOf`
 * (YYYY-MM-DD). Rates are decimal strings and always > 0; providers drop any
 * non-positive / non-numeric upstream value instead of emitting it.
 */

export interface CurrencyPair {
  base: string;
  quote: string;
}

export interface RateFetchOptions {
  signal?: AbortSignal;
}

export interface RateProvider {
  readonly id: string;
  fetchLatest(pairs: CurrencyPair[], opts?: RateFetchOptions): Promise<RateQuote[]>;
  fetchHistorical?(pairs: CurrencyPair[], from: string, to: string, opts?: RateFetchOptions): Promise<RateQuote[]>;
}

export type MarketDataErrorCode = UpstreamErrorCode | "unsupported" | "invalid_request";

/** Safe-to-log error: never contains URLs, API keys or raw payloads. */
export class MarketDataError extends Error {
  readonly code: MarketDataErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    code: MarketDataErrorCode,
    provider: string,
    opts: { status?: number; retryAfterSeconds?: number; detail?: string } = {},
  ) {
    const parts = [`[${provider}] ${code}`];
    if (opts.status !== undefined) parts.push(`(HTTP ${opts.status})`);
    if (opts.detail) parts.push(`- ${opts.detail}`);
    super(parts.join(" "));
    this.name = "MarketDataError";
    this.code = code;
    this.provider = provider;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export const DEFAULT_MARKET_TIMEOUT_MS = 15_000;
/** Longest historical range accepted in one call (~10 years). */
export const MAX_HISTORY_DAYS = 3660;
/** Significant digits kept for derived (inverted / cross) rates. */
export const DERIVED_RATE_DIGITS = 15;

export function marketErrorFactory(provider: string) {
  return (f: UpstreamFailure) =>
    new MarketDataError(f.code, provider, {
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(f.retryAfterSeconds !== undefined ? { retryAfterSeconds: f.retryAfterSeconds } : {}),
      ...(f.detail ? { detail: f.detail } : {}),
    });
}

export function parseMarketResponse<T extends z.ZodType>(schema: T, data: unknown, provider: string): z.output<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new MarketDataError("invalid_response", provider, { detail: "unexpected response shape" });
  return parsed.data;
}

const NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Parses an upstream rate (exact source text or number) into a positive Decimal, or null if invalid. */
export function parsePositiveRate(raw: unknown): DecimalValue | null {
  let text: string;
  if (typeof raw === "string") text = raw.trim();
  else if (typeof raw === "number" && Number.isFinite(raw)) text = String(raw);
  else return null;
  if (!NUMERIC.test(text)) return null;
  const value = new D(text);
  return value.isFinite() && value.greaterThan(0) ? value : null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return utcDate(new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Inclusive list of YYYY-MM-DD dates. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function assertDateRange(from: string, to: string, provider: string): void {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new MarketDataError("invalid_request", provider, { detail: "dates must be YYYY-MM-DD" });
  if (from > to) throw new MarketDataError("invalid_request", provider, { detail: "from is after to" });
  if (daysBetween(from, to) > MAX_HISTORY_DAYS) throw new MarketDataError("invalid_request", provider, { detail: "range too long" });
}

const CODE = /^[A-Z][A-Z0-9]{1,9}$/;

/** Uppercases, validates, de-duplicates and drops identity pairs. */
export function normalizePairs(pairs: readonly CurrencyPair[], provider: string): CurrencyPair[] {
  const seen = new Set<string>();
  const out: CurrencyPair[] = [];
  for (const p of pairs) {
    const base = String(p?.base ?? "").trim().toUpperCase();
    const quote = String(p?.quote ?? "").trim().toUpperCase();
    if (!CODE.test(base) || !CODE.test(quote)) {
      throw new MarketDataError("invalid_request", provider, { detail: "invalid currency code" });
    }
    if (base === quote) continue;
    const key = `${base}/${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ base, quote });
  }
  return out;
}

/** Builds a validated quote; returns null for non-positive / invalid rates. */
export function makeQuote(
  base: string,
  quote: string,
  asOf: string,
  rate: DecimalValue | null,
  source: string,
): RateQuote | null {
  if (!rate || !rate.isFinite() || !rate.greaterThan(0) || !isIsoDate(asOf)) return null;
  return { base, quote, asOf, rate: toPlain(rate), source };
}

/** Final guard applied by the service to every quote it returns. */
export function assertValidQuote(q: RateQuote, provider: string): RateQuote {
  const rate = parsePositiveRate(q.rate);
  if (!rate || !isIsoDate(q.asOf) || !CODE.test(q.base) || !CODE.test(q.quote) || !q.source) {
    throw new MarketDataError("invalid_response", provider, { detail: "invalid quote" });
  }
  return { ...q, rate: toPlain(rate) };
}

export function sortQuotes(quotes: RateQuote[]): RateQuote[] {
  return [...quotes].sort((a, b) =>
    a.base !== b.base ? (a.base < b.base ? -1 : 1) : a.quote !== b.quote ? (a.quote < b.quote ? -1 : 1) : a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0,
  );
}
