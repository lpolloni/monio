import type { WalletSnapshot } from "../blockchain/types";
import { dbNumeric } from "../supabase/numeric";
import type { MonioClient } from "../supabase/server";

function assetKey(network: string, contract: string | null): string {
  return `${network}|${contract ? contract.toLowerCase() : "native"}`;
}

/**
 * Ensures every asset seen in a snapshot exists in the global crypto_assets
 * catalog. Requires the service-role client (reference data is not writable by
 * users). Unknown tokens are added without a currency code (they are shown but
 * not valued).
 */
export async function ensureAssets(admin: MonioClient, snapshot: WalletSnapshot): Promise<Map<string, string>> {
  const wanted = new Map<string, { network: string; symbol: string; name: string; contract: string | null; decimals: number; currencyCode: string | null; isStablecoin: boolean }>();
  for (const h of snapshot.holdings) {
    wanted.set(assetKey(h.network, h.contractAddress), {
      network: h.network,
      symbol: h.symbol,
      name: h.name,
      contract: h.contractAddress,
      decimals: h.decimals,
      currencyCode: h.currencyCode,
      isStablecoin: h.isStablecoin,
    });
  }
  for (const t of snapshot.transactions) {
    const key = assetKey(t.network, t.contractAddress);
    if (!wanted.has(key)) {
      wanted.set(key, { network: t.network, symbol: t.symbol, name: t.symbol, contract: t.contractAddress, decimals: 18, currencyCode: null, isStablecoin: false });
    }
  }
  const { data: existing, error } = await admin.from("crypto_assets").select("id, network, contract_address");
  if (error) throw error;
  const ids = new Map((existing ?? []).map((a) => [assetKey(a.network, a.contract_address), a.id]));
  const { data: currencies } = await admin.from("currencies").select("code");
  const known = new Set((currencies ?? []).map((c) => c.code));
  for (const [key, a] of wanted) {
    if (ids.has(key)) continue;
    const { data, error: insertError } = await admin
      .from("crypto_assets")
      .insert({
        network: a.network,
        symbol: a.symbol.slice(0, 16),
        name: a.name.slice(0, 80),
        contract_address: a.contract,
        decimals: a.decimals,
        currency_code: a.currencyCode && known.has(a.currencyCode) ? a.currencyCode : null,
        is_stablecoin: a.isStablecoin,
      })
      .select("id")
      .single();
    if (insertError) throw insertError;
    ids.set(key, data.id);
  }
  return ids;
}

/**
 * Stores a read-only wallet snapshot: today's holdings (zeroing assets that
 * disappeared), on-chain transactions (idempotent), and sync timestamps.
 */
export async function persistWalletSnapshot(
  db: MonioClient,
  assetIds: Map<string, string>,
  args: { userId: string; walletId: string; accountId: string; snapshot: WalletSnapshot; asOf: string; ownIdentifiers?: string[] },
): Promise<{ holdings: number; transactions: number }> {
  const { userId, walletId, accountId, snapshot, asOf } = args;
  const rows = new Map<string, { asset_id: string; quantity: string }>();
  for (const h of snapshot.holdings) {
    const assetId = assetIds.get(assetKey(h.network, h.contractAddress));
    if (!assetId) continue;
    rows.set(assetId, { asset_id: assetId, quantity: h.quantity });
  }
  const { data: previous } = await db.from("wallet_latest_holdings").select("asset_id, quantity:quantity::text").eq("wallet_id", walletId);
  for (const p of previous ?? []) {
    if (p.asset_id && !rows.has(p.asset_id) && p.quantity !== "0") rows.set(p.asset_id, { asset_id: p.asset_id, quantity: "0" });
  }
  if (rows.size > 0) {
    const { error } = await db.from("wallet_holdings").upsert(
      [...rows.values()].map((r) => ({ user_id: userId, wallet_id: walletId, asset_id: r.asset_id, as_of: asOf, quantity: dbNumeric(r.quantity) })),
      { onConflict: "wallet_id,asset_id,as_of" },
    );
    if (error) throw error;
  }

  const own = new Set((args.ownIdentifiers ?? []).map((s) => s.toLowerCase()));
  const txRows = snapshot.transactions
    .filter((t) => !t.pending)
    .map((t) => {
      const assetId = assetIds.get(assetKey(t.network, t.contractAddress));
      if (!assetId) return null;
      const internal = t.direction === "self" || (t.counterparty !== null && own.has(t.counterparty.toLowerCase()));
      return {
        user_id: userId,
        wallet_id: walletId,
        asset_id: assetId,
        network: t.network,
        tx_hash: t.txHash,
        log_index: t.logIndex,
        block_time: t.blockTime,
        direction: t.direction,
        quantity: dbNumeric(t.quantity),
        fee_quantity: dbNumeric(t.feeQuantity ?? null),
        counterparty: t.counterparty,
        classification: internal ? "internal" : t.direction === "in" ? "transfer_in" : t.direction === "out" ? "transfer_out" : "unknown",
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (txRows.length > 0) {
    const { error } = await db
      .from("blockchain_transactions")
      .upsert(txRows, { onConflict: "wallet_id,network,tx_hash,log_index,asset_id", ignoreDuplicates: true });
    if (error) throw error;
  }

  const syncedAt = snapshot.fetchedAt;
  const unsupported = snapshot.unsupportedReasons.length > 0 && snapshot.holdings.length === 0;
  await db
    .from("crypto_wallets")
    .update({
      sync_status: unsupported ? "unsupported" : "ok",
      sync_error: snapshot.unsupportedReasons.join(", ").slice(0, 300) || null,
      last_synced_at: syncedAt,
      networks: snapshot.networksScanned,
    })
    .eq("id", walletId);
  await db.from("accounts").update({ last_synced_at: syncedAt, sync_source: "blockchain" }).eq("id", accountId);
  return { holdings: rows.size, transactions: txRows.length };
}
