import "server-only";
import { addDaysIso } from "@/domain/analytics/periods";
import { isFiat } from "@/domain/money/currencies";
import { getMarketService } from "../runtime";
import { createAdminClient } from "../supabase/admin";
import { dbNumeric } from "../supabase/numeric";
import type { MarketDataService } from "./service";

/** How far back rates are fetched for a currency seen for the first time. */
const MAX_BACKFILL_DAYS = 400;
/** A currency with an observation this recent needs nothing. */
const FRESH_DAYS = 4;

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Fetches and stores EUR-based rates for fiat currencies (FxTable derives every
 * cross from them). Rates are global reference data: only currency codes and
 * dates leave this function. Returns the number of observations stored.
 */
export async function storeFiatRates(admin: Admin, market: MarketDataService, codes: string[], from: string, to: string): Promise<number> {
  const pairs = [...new Set(codes.map((c) => c.toUpperCase()))].filter((code) => isFiat(code) && code !== "EUR").map((code) => ({ base: "EUR", quote: code }));
  if (!pairs.length) return 0;
  const [latest, history] = await Promise.all([market.latest(pairs), market.historical(pairs, from, to)]);
  const rows = new Map<string, { base: string; quote: string; as_of: string; rate: number; source: string }>();
  for (const q of [...history, ...latest]) rows.set(`${q.base}|${q.quote}|${q.asOf}|${q.source}`, { base: q.base, quote: q.quote, as_of: q.asOf, rate: dbNumeric(q.rate), source: q.source });
  const list = [...rows.values()];
  for (let i = 0; i < list.length; i += 1000) {
    const { error } = await admin.from("exchange_rates").upsert(list.slice(i, i + 1000), { onConflict: "base,quote,as_of,source" });
    if (error) throw error;
  }
  return list.length;
}

/**
 * Makes sure the given fiat currencies can be converted from `from` until
 * today: a currency with no recent rate, or none as old as `from`, is fetched.
 * Called after an import, so that an account in a currency the user never had
 * shows its value at once instead of waiting for the scheduled refresh. Never
 * throws: a missing rate leaves a value unconverted, it does not fail an import.
 */
export async function ensureFiatRates(currencies: string[], from: string, today: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const start = from < addDaysIso(today, -MAX_BACKFILL_DAYS) ? addDaysIso(today, -MAX_BACKFILL_DAYS) : from > today ? today : from;
    const wanted = [...new Set(currencies.map((c) => c.toUpperCase()))].filter((code) => isFiat(code) && code !== "EUR");
    const missing: string[] = [];
    for (const code of wanted) {
      const [newest, oldest] = await Promise.all([
        admin.from("exchange_rates").select("as_of").eq("base", "EUR").eq("quote", code).order("as_of", { ascending: false }).limit(1).maybeSingle(),
        admin.from("exchange_rates").select("as_of").eq("base", "EUR").eq("quote", code).order("as_of", { ascending: true }).limit(1).maybeSingle(),
      ]);
      if (newest.error) throw newest.error;
      if (oldest.error) throw oldest.error;
      const covered = newest.data && oldest.data && newest.data.as_of >= addDaysIso(today, -FRESH_DAYS) && oldest.data.as_of <= addDaysIso(start, FRESH_DAYS);
      if (!covered) missing.push(code);
    }
    if (!missing.length) return;
    const stored = await storeFiatRates(admin, getMarketService(), missing, start, today);
    console.info(`[rates] ${missing.join(", ")}: ${stored} observations stored after import`);
  } catch (error) {
    console.error(`[rates] could not provision rates after import: ${error instanceof Error ? error.name : "error"}`);
  }
}
