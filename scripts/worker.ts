/**
 * Monio background worker (DEV tooling).
 *
 *   npm run worker -- jobs      process queued imports (and imports stuck in "processing" > 10 min)
 *   npm run worker -- rates     refresh rates for the currencies in use (EXCHANGE_RATE_PROVIDER = mock | live); fiat and crypto are saved independently
 *   npm run worker -- wallets   sync every watch-only crypto wallet (BLOCKCHAIN_PROVIDER = mock | live)
 *   npm run worker -- all       rates, then wallets, then jobs
 *
 * Uses the service-role client; every user-data query is filtered by user id.
 * Prints counts only — never document content, transactions, balances or addresses.
 * Refuses to run with APP_ENV=production unless WORKER_ALLOW_PRODUCTION=true.
 */
import { purgeOrphanedDocuments } from "@/server/maintenance/purge";
import { addDaysIso } from "@/domain/analytics/periods";
import { detectWatchTarget } from "@/domain/crypto/addresses";
import { describeError, isStaleProcessing, runImportJob } from "@/server/import/pipeline";
import { getAiServiceFor, getBlockchainService, getMarketService } from "@/server/runtime";
import { createAdminClient } from "@/server/supabase/admin";
import { dbNumeric } from "@/server/supabase/numeric";
import { ensureAssets, persistWalletSnapshot } from "@/server/wallets/persist";

const MODES = ["jobs", "rates", "wallets", "purge", "all"] as const;
type Mode = (typeof MODES)[number];

const JOB_BATCH = 100;
const RATE_BACKFILL_DAYS = 7;

type Admin = ReturnType<typeof createAdminClient>;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function processJobs(admin: Admin): Promise<boolean> {
  const { data: candidates, error } = await admin
    .from("import_jobs")
    .select("id, user_id, status, started_at")
    .in("status", ["queued", "processing"])
    .order("created_at", { ascending: true })
    .limit(JOB_BATCH);
  if (error) throw error;
  const nowMs = Date.now();
  const runnable = (candidates ?? []).filter((j) => j.status === "queued" || isStaleProcessing(j.started_at, nowMs));
  const counts = { completed: 0, needs_review: 0, failed: 0, skipped: 0 };
  const consent = new Map<string, boolean>();
  for (const job of runnable) {
    if (!consent.has(job.user_id)) {
      const { data: profile } = await admin.from("profiles").select("ai_cloud_consent").eq("id", job.user_id).maybeSingle();
      consent.set(job.user_id, profile?.ai_cloud_consent === true);
    }
    const ai = getAiServiceFor({ aiCloudConsent: consent.get(job.user_id) === true });
    const outcome = await runImportJob(admin, job.user_id, job.id, { today: today(), ai });
    counts[outcome.status]++;
  }
  console.log(
    `jobs: ${runnable.length} claimable of ${candidates?.length ?? 0} pending · ${counts.completed} completed · ` +
      `${counts.needs_review} needs review · ${counts.failed} failed · ${counts.skipped} skipped`,
  );
  return true;
}

/**
 * Currencies the users actually hold: account and display currencies, plus the
 * currencies of crypto assets with a holding. Only these codes are kept (rates
 * are global reference data; no user, account or amount leaves this function).
 */
async function currenciesInUse(admin: Admin): Promise<{ fiat: Set<string>; crypto: Set<string> }> {
  const [accounts, profiles, holdings] = await Promise.all([
    admin.from("accounts").select("currency"),
    admin.from("profiles").select("primary_currency"),
    admin.from("wallet_holdings").select("asset_id"),
  ]);
  if (accounts.error) throw accounts.error;
  if (profiles.error) throw profiles.error;
  if (holdings.error) throw holdings.error;
  const assetIds = [...new Set((holdings.data ?? []).map((h) => h.asset_id))];
  const assets = assetIds.length
    ? await admin.from("crypto_assets").select("currency_code").in("id", assetIds)
    : { data: [], error: null };
  if (assets.error) throw assets.error;
  const fiat = new Set([...(accounts.data ?? []).map((a) => a.currency), ...(profiles.data ?? []).map((p) => p.primary_currency)]);
  const crypto = new Set((assets.data ?? []).map((a) => a.currency_code).filter((c): c is string => !!c));
  return { fiat, crypto };
}

/**
 * Fetches and stores rates for each provider group on its own: when one
 * provider is unavailable (rate limit, outage) the others are still saved.
 * Returns false when any group failed, so the exit code still reports it.
 */
async function refreshRates(admin: Admin): Promise<boolean> {
  const market = getMarketService();
  const { data: currencies, error } = await admin.from("currencies").select("code, kind");
  if (error) throw error;
  const kinds = new Map((currencies ?? []).map((c) => [c.code, c.kind]));
  const inUse = await currenciesInUse(admin);
  // Fiat against EUR; crypto and stablecoins against USD (FxTable derives crosses).
  const fiatPairs = [...inUse.fiat].filter((code) => kinds.get(code) === "fiat" && code !== "EUR").map((code) => ({ base: "EUR", quote: code }));
  const cryptoPairs = [...inUse.crypto]
    .filter((code) => kinds.get(code) !== "fiat" && code !== "USD")
    .map((code) => ({ base: code, quote: "USD" }));
  const groups = [
    { name: "fiat", pairs: fiatPairs },
    { name: "crypto", pairs: cryptoPairs },
  ].filter((g) => g.pairs.length > 0);
  if (groups.length === 0) {
    console.log("rates: no foreign currencies in use; nothing to fetch");
    return true;
  }
  const to = today();
  let ok = true;
  for (const { name, pairs } of groups) {
    try {
      const [latest, history] = await Promise.all([market.latest(pairs), market.historical(pairs, addDaysIso(to, -RATE_BACKFILL_DAYS), to)]);
      const rows = new Map<string, { base: string; quote: string; as_of: string; rate: number; source: string }>();
      for (const q of [...history, ...latest]) {
        rows.set(`${q.base}|${q.quote}|${q.asOf}|${q.source}`, { base: q.base, quote: q.quote, as_of: q.asOf, rate: dbNumeric(q.rate), source: q.source });
      }
      const list = [...rows.values()];
      for (let i = 0; i < list.length; i += 1000) {
        const { error: upsertError } = await admin.from("exchange_rates").upsert(list.slice(i, i + 1000), { onConflict: "base,quote,as_of,source" });
        if (upsertError) throw upsertError;
      }
      const priced = new Set(list.map((r) => `${r.base}/${r.quote}`)).size;
      console.log(`rates: ${name} via ${market.provider} · ${priced}/${pairs.length} pairs priced · ${list.length} observations upserted`);
    } catch (error) {
      ok = false;
      console.error(`rates: ${name} failed (${describeError(error)}); other groups were still saved`);
    }
  }
  return ok;
}

async function syncWallets(admin: Admin): Promise<boolean> {
  const chain = getBlockchainService();
  const { data: wallets, error } = await admin
    .from("crypto_wallets")
    .select("id, user_id, account_id, family, watch_kind, public_identifier")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const ownByUser = new Map<string, string[]>();
  for (const w of wallets ?? []) ownByUser.set(w.user_id, [...(ownByUser.get(w.user_id) ?? []), w.public_identifier]);
  const counts = { synced: 0, failed: 0, invalid: 0 };
  const asOf = today();
  for (const wallet of wallets ?? []) {
    const detected = detectWatchTarget(wallet.public_identifier);
    if (!detected.ok || detected.target.family !== wallet.family) {
      counts.invalid++;
      await admin
        .from("crypto_wallets")
        .update({ sync_status: "unsupported", sync_error: "invalid_watch_target" })
        .eq("id", wallet.id)
        .eq("user_id", wallet.user_id);
      continue;
    }
    try {
      const snapshot = await chain.snapshot(detected.target);
      const assetIds = await ensureAssets(admin, snapshot);
      await persistWalletSnapshot(admin, assetIds, {
        userId: wallet.user_id,
        walletId: wallet.id,
        accountId: wallet.account_id,
        snapshot,
        asOf,
        ownIdentifiers: ownByUser.get(wallet.user_id) ?? [],
      });
      counts.synced++;
    } catch (syncError) {
      counts.failed++;
      const code = syncError && typeof syncError === "object" && "code" in syncError ? String((syncError as { code: unknown }).code) : "failed";
      await admin
        .from("crypto_wallets")
        .update({ sync_status: "error", sync_error: code.slice(0, 300) })
        .eq("id", wallet.id)
        .eq("user_id", wallet.user_id);
    }
  }
  console.log(`wallets: provider ${chain.provider} · ${wallets?.length ?? 0} wallets · ${counts.synced} synced · ${counts.failed} failed · ${counts.invalid} invalid`);
  return counts.failed === 0;
}

async function runMode(name: Exclude<Mode, "all">, admin: Admin): Promise<boolean> {
  try {
    if (name === "jobs") return await processJobs(admin);
    if (name === "rates") return await refreshRates(admin);
    if (name === "purge") {
      const r = await purgeOrphanedDocuments(admin);
      console.log(`purge: ${r.folders} orphaned folders · ${r.objects} objects removed`);
      return true;
    }
    return await syncWallets(admin);
  } catch (error) {
    console.error(`${name}: failed (${describeError(error)})`);
    return false;
  }
}

async function main(): Promise<number> {
  const mode = process.argv[2] as Mode | undefined;
  if (!mode || !MODES.includes(mode)) {
    console.error(`Usage: npm run worker -- <${MODES.join("|")}>`);
    return 2;
  }
  if (process.env.APP_ENV === "production" && process.env.WORKER_ALLOW_PRODUCTION !== "true") {
    console.error("Refusing to run: APP_ENV is production (set WORKER_ALLOW_PRODUCTION=true to override).");
    return 1;
  }
  const admin = createAdminClient();
  const steps: Exclude<Mode, "all">[] = mode === "all" ? ["rates", "wallets", "jobs", "purge"] : [mode];
  let ok = true;
  for (const step of steps) ok = (await runMode(step, admin)) && ok;
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    // Configuration errors name variables, never their values.
    console.error(`worker: failed (${error instanceof Error ? error.message : describeError(error)})`);
    process.exit(1);
  },
);
