import { z } from "zod";
import { D, dec, toPlain } from "@/domain/money/decimal";
import type { NetworkId } from "@/domain/crypto/assets";
import type { UpstreamFailure } from "./http";
import {
  BlockchainProviderError,
  DEFAULT_MAX_TRANSACTIONS,
  MAX_TRANSACTIONS_LIMIT,
  type ChainTransaction,
  type HoldingSnapshot,
  type WalletSnapshot,
  type WatchTarget,
} from "./types";

// ---------------------------------------------------------------------------
// zod helpers. Upstream JSON numbers arrive as exact source-text strings (see http.ts),
// but plain numbers are accepted too so the schemas work with any JSON parser.
// ---------------------------------------------------------------------------

/** Non-negative integer in base units (sats, wei) → bigint. Never goes through a float. */
export const zBaseUnits = z.union([
  z.string().regex(/^\d+$/).transform((v) => BigInt(v)),
  z
    .number()
    .refine((n) => Number.isSafeInteger(n) && n >= 0)
    .transform((n) => BigInt(n)),
]);

/** 0x-prefixed hex quantity (JSON-RPC) → bigint. "0x" alone is treated as zero. */
export const zHexQuantity = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/)
  .transform((v) => (v === "0x" ? 0n : BigInt(v)));

/** Small non-negative integer (counts, timestamps, log indexes) → number. */
export const zSmallInt = z.union([
  z
    .string()
    .regex(/^\d{1,15}$/)
    .transform((v) => Number(v)),
  z.number().refine((n) => Number.isSafeInteger(n) && n >= 0),
]);

const DECIMAL_OR_EXP = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** ISO-8601 timestamp that Date can parse. */
export const zTimestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)));

/** 0x-prefixed 32-byte transaction hash. */
export const zTxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** Decimal number (plain or exponent notation) → canonical plain decimal string. */
export const zDecimalString = z.union([
  z
    .string()
    .regex(DECIMAL_OR_EXP)
    .transform((v) => toPlain(new D(v))),
  z
    .number()
    .refine((n) => Number.isFinite(n))
    .transform((n) => toPlain(new D(String(n)))),
]);

export function providerErrorFactory(provider: string, network?: NetworkId) {
  return (f: UpstreamFailure) =>
    new BlockchainProviderError(f.code, provider, {
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(f.retryAfterSeconds !== undefined ? { retryAfterSeconds: f.retryAfterSeconds } : {}),
      ...(f.detail ? { detail: f.detail } : {}),
      ...(network ? { network } : {}),
    });
}

/** Validates `data` with `schema`; throws invalid_response with a static message (no payload echo). */
export function parseResponse<T extends z.ZodType>(
  schema: T,
  data: unknown,
  provider: string,
  network?: NetworkId,
): z.output<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new BlockchainProviderError("invalid_response", provider, {
      detail: "unexpected response shape",
      ...(network ? { network } : {}),
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

export function clampMaxTransactions(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_TRANSACTIONS;
  return Math.max(0, Math.min(MAX_TRANSACTIONS_LIMIT, Math.floor(value)));
}

/** Newest first; deterministic tie-breaks. */
export function sortTransactions(txs: ChainTransaction[]): ChainTransaction[] {
  return [...txs].sort((a, b) => {
    if (a.blockTime !== b.blockTime) return a.blockTime < b.blockTime ? 1 : -1;
    if (a.network !== b.network) return a.network < b.network ? -1 : 1;
    if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
}

export function isPositive(quantity: string): boolean {
  return dec(quantity).greaterThan(0);
}

/** Native first, then tokens by network and symbol. Drops zero balances. */
export function finalizeHoldings(holdings: HoldingSnapshot[]): HoldingSnapshot[] {
  return holdings
    .filter((h) => isPositive(h.quantity))
    .sort((a, b) => {
      if (a.network !== b.network) return a.network < b.network ? -1 : 1;
      if ((a.contractAddress === null) !== (b.contractAddress === null)) return a.contractAddress === null ? -1 : 1;
      return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    });
}

export function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function reasonFor(network: NetworkId, error: unknown): string {
  const code = error instanceof BlockchainProviderError ? error.code : "network";
  return `${network}:${code}`;
}

/** Merges per-network partial snapshots of the same target. */
export function mergeSnapshots(
  target: WatchTarget,
  parts: WalletSnapshot[],
  provider: string,
  fetchedAt: string,
  maxTransactions: number,
  extraReasons: string[] = [],
): WalletSnapshot {
  const networks = new Set<NetworkId>();
  const reasons: string[] = [];
  for (const p of parts) {
    p.networksScanned.forEach((n) => networks.add(n));
    reasons.push(...p.unsupportedReasons);
  }
  reasons.push(...extraReasons);
  return {
    target,
    fetchedAt,
    holdings: finalizeHoldings(parts.flatMap((p) => p.holdings)),
    transactions: sortTransactions(parts.flatMap((p) => p.transactions)).slice(0, maxTransactions),
    networksScanned: [...networks],
    unsupportedReasons: [...new Set(reasons)],
    provider,
  };
}

/**
 * Runs `fn` for every network; networks that fail are reported in
 * `unsupportedReasons`. When every network fails the first error is rethrown.
 */
export async function settlePerNetwork<N extends NetworkId>(
  networks: readonly N[],
  fn: (network: N) => Promise<WalletSnapshot>,
): Promise<{ parts: WalletSnapshot[]; reasons: string[] }> {
  const settled = await Promise.allSettled(networks.map((n) => fn(n)));
  const parts: WalletSnapshot[] = [];
  const reasons: string[] = [];
  let firstError: unknown;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") parts.push(s.value);
    else {
      firstError ??= s.reason;
      reasons.push(reasonFor(networks[i]!, s.reason));
    }
  });
  if (parts.length === 0 && firstError !== undefined) throw firstError;
  return { parts, reasons };
}
