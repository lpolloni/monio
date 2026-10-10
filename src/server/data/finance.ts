import "server-only";
import type { EntityKind } from "@/domain/accounts/classification";
import type { RateQuote } from "@/domain/fx/fx-table";
import type { AccountType } from "@/domain/import/types";
import type { AccountPosition, HoldingPosition } from "@/domain/portfolio/portfolio";
import type { MonioClient } from "../supabase/server";

export interface AccountRecord extends AccountPosition {
  institutionSlug: string | null;
  institutionCountry: string | null;
  accountMask: string | null;
  isArchived: boolean;
  syncSource: string | null;
  wallet: WalletRecord | null;
}

export interface WalletRecord {
  id: string;
  family: "bitcoin" | "evm";
  watchKind: "address" | "xpub" | "descriptor";
  publicIdentifier: string;
  networks: string[];
  syncStatus: string;
  syncError: string | null;
  lastSyncedAt: string | null;
  holdings: (HoldingPosition & { assetId: string; name: string; isStablecoin: boolean; asOf: string })[];
}

type Db = MonioClient;

const PAGE = 1000;

/** Fetches every row of a query by paging through PostgREST's max-rows limit. */
async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, maxRows = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error instanceof Error ? error : new Error(JSON.stringify(error));
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

export async function loadRates(db: Db, from: string, to: string): Promise<RateQuote[]> {
  const rows = await fetchAll((a, b) =>
    db
      .from("exchange_rates")
      .select("base, quote, as_of, rate:rate::text, source")
      .gte("as_of", from)
      .lte("as_of", to)
      .order("as_of", { ascending: true })
      .order("base", { ascending: true })
      .order("quote", { ascending: true })
      .range(a, b),
  );
  // Also include the latest observation before the window so early dates resolve.
  const { data: before } = await db
    .from("exchange_rates")
    .select("base, quote, as_of, rate:rate::text, source")
    .lt("as_of", from)
    .order("as_of", { ascending: false })
    .limit(60);
  return [...(before ?? []), ...rows].map((r) => ({
    base: r.base,
    quote: r.quote,
    asOf: r.as_of,
    rate: r.rate,
    source: r.source,
  }));
}


export async function loadAccounts(db: Db, userId: string): Promise<AccountRecord[]> {
  const { data: accounts, error } = await db
    .from("accounts")
    .select(
      "id, name, type, currency, country, account_mask, credit_limit:credit_limit::text, include_in_net_worth, is_archived, last_synced_at, sync_source, entity_id, institution:institutions(id, name, slug, brand_color, country)",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const ids = (accounts ?? []).map((a) => a.id);
  if (ids.length === 0) return [];

  const [{ data: entities }, { data: balances }, { data: wallets }] = await Promise.all([
    db.from("financial_entities").select("id, name, kind").eq("user_id", userId),
    db.from("account_latest_balances").select("account_id, as_of, balance:balance::text, currency").in("account_id", ids),
    db
      .from("crypto_wallets")
      .select("id, account_id, family, watch_kind, public_identifier, networks, sync_status, sync_error, last_synced_at")
      .eq("user_id", userId),
  ]);
  const walletIds = (wallets ?? []).map((w) => w.id);
  const { data: holdings } = walletIds.length
    ? await db
        .from("wallet_latest_holdings")
        .select("wallet_id, asset_id, as_of, quantity:quantity::text")
        .in("wallet_id", walletIds)
    : { data: [] as { wallet_id: string | null; asset_id: string | null; as_of: string | null; quantity: string }[] };
  const assetIds = [...new Set((holdings ?? []).map((h) => h.asset_id).filter((x): x is string => !!x))];
  const { data: assets } = assetIds.length
    ? await db.from("crypto_assets").select("id, network, symbol, name, currency_code, is_stablecoin").in("id", assetIds)
    : { data: [] as { id: string; network: string; symbol: string; name: string; currency_code: string | null; is_stablecoin: boolean }[] };

  const entityById = new Map((entities ?? []).map((e) => [e.id, e]));
  const balanceByAccount = new Map((balances ?? []).map((b) => [b.account_id, b]));
  const assetById = new Map((assets ?? []).map((a) => [a.id, a]));
  const holdingsByWallet = new Map<string, WalletRecord["holdings"]>();
  for (const h of holdings ?? []) {
    if (!h.wallet_id || !h.asset_id) continue;
    const asset = assetById.get(h.asset_id);
    if (!asset) continue;
    const list = holdingsByWallet.get(h.wallet_id) ?? [];
    if (h.quantity !== "0") {
      list.push({
        assetId: asset.id,
        currency: asset.currency_code ?? asset.symbol,
        symbol: asset.symbol,
        network: asset.network,
        name: asset.name,
        isStablecoin: asset.is_stablecoin,
        quantity: h.quantity,
        asOf: h.as_of ?? "",
      });
    }
    holdingsByWallet.set(h.wallet_id, list);
  }
  const walletByAccount = new Map(
    (wallets ?? []).map((w) => [
      w.account_id,
      {
        id: w.id,
        family: w.family as WalletRecord["family"],
        watchKind: w.watch_kind as WalletRecord["watchKind"],
        publicIdentifier: w.public_identifier,
        networks: w.networks,
        syncStatus: w.sync_status,
        syncError: w.sync_error,
        lastSyncedAt: w.last_synced_at,
        holdings: holdingsByWallet.get(w.id) ?? [],
      } satisfies WalletRecord,
    ]),
  );

  return (accounts ?? []).map((a) => {
    const entity = entityById.get(a.entity_id);
    const balance = balanceByAccount.get(a.id);
    const wallet = walletByAccount.get(a.id) ?? null;
    const institution = Array.isArray(a.institution) ? a.institution[0] : a.institution;
    return {
      accountId: a.id,
      name: a.name,
      type: a.type as AccountType,
      currency: a.currency,
      entityId: a.entity_id,
      entityKind: (entity?.kind ?? "personal") as EntityKind,
      entityName: entity?.name ?? "",
      institutionId: institution?.id ?? null,
      institutionName: institution?.name ?? (wallet ? walletInstitutionName(wallet) : null),
      institutionColor: institution?.brand_color ?? (wallet ? (wallet.family === "bitcoin" ? "#F7931A" : "#7B8CDE") : null),
      institutionSlug: institution?.slug ?? null,
      institutionCountry: institution?.country ?? null,
      country: a.country ?? institution?.country ?? null,
      includeInNetWorth: a.include_in_net_worth,
      balance: wallet ? null : (balance?.balance ?? null),
      balanceAsOf: balance?.as_of ?? null,
      holdings: wallet ? wallet.holdings : undefined,
      lastSyncedAt: a.last_synced_at,
      creditLimit: a.credit_limit,
      accountMask: a.account_mask,
      isArchived: a.is_archived,
      syncSource: a.sync_source,
      wallet,
    } satisfies AccountRecord;
  });
}

function walletInstitutionName(wallet: WalletRecord): string {
  return wallet.family === "bitcoin" ? "Bitcoin" : "Ethereum";
}

