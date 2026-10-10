"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { detectWatchTarget, type WatchTargetError } from "@/domain/crypto/addresses";
import { getSession } from "../data/session";
import { getBlockchainService } from "../runtime";
import { createAdminClient } from "../supabase/admin";
import { ensureAssets, persistWalletSnapshot } from "../wallets/persist";

export type ConnectWalletResult =
  | { ok: true; accountId: string; holdings: number; provider: string }
  | { ok: false; error: WatchTargetError | "unauthorized" | "already_connected" | "sync_failed" | "failed" };

/**
 * Starts watching a public address / extended public key. The input is
 * re-validated on the server: private keys and recovery phrases are rejected and
 * never stored or logged. Only read-only provider calls are made.
 */
export async function connectWallet(input: string, label: string): Promise<ConnectWalletResult> {
  const parsedLabel = z.string().trim().max(80).safeParse(label);
  const detected = detectWatchTarget(typeof input === "string" ? input.slice(0, 600) : "");
  if (!detected.ok) return { ok: false, error: detected.error };
  const session = await getSession();
  if (!session) return { ok: false, error: "unauthorized" };
  const { supabase, userId } = session;
  const target = detected.target;

  const { data: existing } = await supabase
    .from("crypto_wallets")
    .select("id, account_id")
    .eq("family", target.family)
    .eq("public_identifier", target.identifier)
    .maybeSingle();
  if (existing) return { ok: false, error: "already_connected" };

  const { data: entity } = await supabase.from("financial_entities").select("id").eq("kind", "personal").single();
  if (!entity) return { ok: false, error: "failed" };
  const name = (parsedLabel.success && parsedLabel.data) || (target.family === "bitcoin" ? "Bitcoin wallet" : "Ethereum wallet");
  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .insert({ user_id: userId, entity_id: entity.id, name, type: "crypto_wallet", currency: target.family === "bitcoin" ? "BTC" : "ETH", sync_source: "blockchain" })
    .select("id")
    .single();
  if (accountError || !account) return { ok: false, error: "failed" };
  const { data: wallet, error: walletError } = await supabase
    .from("crypto_wallets")
    .insert({ user_id: userId, account_id: account.id, family: target.family, watch_kind: target.kind, public_identifier: target.identifier, label: name })
    .select("id")
    .single();
  if (walletError || !wallet) {
    await supabase.from("accounts").delete().eq("id", account.id);
    return { ok: false, error: "failed" };
  }
  await supabase.rpc("log_user_action", { p_action: "wallet.connected", p_target_table: "crypto_wallets", p_target_id: wallet.id, p_details: { family: target.family, kind: target.kind } });

  const synced = await syncWalletInternal(userId, wallet.id, account.id, target);
  refresh();
  if (!synced.ok) return { ok: false, error: "sync_failed" };
  return { ok: true, accountId: account.id, holdings: synced.holdings, provider: synced.provider };
}

async function syncWalletInternal(userId: string, walletId: string, accountId: string, target: Parameters<ReturnType<typeof getBlockchainService>["snapshot"]>[0]) {
  const session = await getSession();
  if (!session) return { ok: false as const };
  const chain = getBlockchainService();
  try {
    const snapshot = await chain.snapshot(target);
    // Asset catalog is global reference data: written with the service role.
    const assetIds = await ensureAssets(createAdminClient(), snapshot);
    const { data: own } = await session.supabase.from("crypto_wallets").select("public_identifier");
    const result = await persistWalletSnapshot(session.supabase, assetIds, {
      userId,
      walletId,
      accountId,
      snapshot,
      asOf: snapshot.fetchedAt.slice(0, 10),
      ownIdentifiers: (own ?? []).map((w) => w.public_identifier),
    });
    return { ok: true as const, holdings: result.holdings, provider: chain.provider };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "failed";
    await session.supabase.from("crypto_wallets").update({ sync_status: "error", sync_error: code.slice(0, 300) }).eq("id", walletId);
    return { ok: false as const };
  }
}

export async function syncWallet(walletId: string): Promise<{ ok: boolean }> {
  if (!z.uuid().safeParse(walletId).success) return { ok: false };
  const session = await getSession();
  if (!session) return { ok: false };
  const { data: wallet } = await session.supabase.from("crypto_wallets").select("id, account_id, public_identifier").eq("id", walletId).single();
  if (!wallet) return { ok: false };
  const detected = detectWatchTarget(wallet.public_identifier);
  if (!detected.ok) return { ok: false };
  const result = await syncWalletInternal(session.userId, wallet.id, wallet.account_id, detected.target);
  refresh();
  return { ok: result.ok };
}
