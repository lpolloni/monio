import { z } from "zod";
import { deriveWatchTargetAddresses, watchTargetBranches } from "@/domain/crypto/addresses";
import { fromBaseUnits } from "@/domain/money/decimal";
import { joinUrl, mapWithConcurrency, requestJson } from "../http";
import {
  clampMaxTransactions,
  finalizeHoldings,
  isoFromUnixSeconds,
  parseResponse,
  providerErrorFactory,
  sortTransactions,
  zBaseUnits,
  zSmallInt,
} from "../shared";
import {
  BlockchainProviderError,
  DEFAULT_TIMEOUT_MS,
  type ChainProvider,
  type ChainTransaction,
  type HoldingSnapshot,
  type SnapshotOptions,
  type WalletSnapshot,
  type WatchTarget,
} from "../types";

/**
 * Bitcoin via the Esplora REST API (Blockstream Esplora / mempool.space).
 *
 *   GET {base}/address/{address}                    → chain_stats / mempool_stats (sats)
 *   GET {base}/address/{address}/txs                → mempool txs + newest 25 confirmed
 *   GET {base}/address/{address}/txs/chain/{txid}   → next 25 confirmed after {txid}
 *
 * xpub / descriptor targets are scanned with the standard gap limit (20 consecutive
 * unused addresses per branch), bounded by `maxAddressRequests` / `maxHistoryRequests`.
 * Balances include unconfirmed (mempool) movements.
 */

export const DEFAULT_ESPLORA_URL = "https://mempool.space/api";
export const DEFAULT_ESPLORA_TESTNET_URL = "https://mempool.space/testnet4/api";
const PROVIDER = "esplora";
const CONFIRMED_PAGE_SIZE = 25;

export interface EsploraProviderOptions {
  baseUrl?: string;
  testnetBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  gapLimit?: number;
  /** Cap on /address/{addr} lookups during an xpub/descriptor scan (default 200). */
  maxAddressRequests?: number;
  /** Cap on transaction-list requests per snapshot (default 50). */
  maxHistoryRequests?: number;
  concurrency?: number;
  now?: () => Date;
}

const StatsSchema = z.object({
  funded_txo_sum: zBaseUnits,
  spent_txo_sum: zBaseUnits,
  tx_count: zSmallInt,
});
const AddressSchema = z.object({ chain_stats: StatsSchema, mempool_stats: StatsSchema });

export const EsploraTxSchema = z.object({
  txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
  vin: z.array(
    z.object({
      is_coinbase: z.boolean().optional(),
      prevout: z
        .object({ scriptpubkey_address: z.string().optional(), value: zBaseUnits })
        .nullable()
        .optional(),
    }),
  ),
  vout: z.array(z.object({ scriptpubkey_address: z.string().optional(), value: zBaseUnits })),
  fee: zBaseUnits.optional(),
  status: z.object({ confirmed: z.boolean(), block_time: zSmallInt.optional() }),
});
const TxListSchema = z.array(EsploraTxSchema);
export type EsploraTx = z.output<typeof EsploraTxSchema>;

interface AddressStats {
  address: string;
  balance: bigint;
  txCount: number;
  chainTxCount: number;
}

interface Budget {
  addresses: number;
  history: number;
}

/** Classifies an Esplora transaction relative to a set of owned addresses (exported for tests). */
export function classifyBitcoinTx(
  tx: EsploraTx,
  own: ReadonlySet<string>,
  ctx: { symbol: string; fetchedAt: string },
): ChainTransaction | null {
  let sent = 0n;
  let received = 0n;
  let allInputsOurs = tx.vin.length > 0;
  let foreignInput: string | null = null;
  for (const vin of tx.vin) {
    const addr = vin.prevout?.scriptpubkey_address;
    if (addr && own.has(addr) && vin.prevout) sent += vin.prevout.value;
    else {
      allInputsOurs = false;
      foreignInput ??= addr ?? null;
    }
  }
  let allOutputsOurs = true;
  let foreignOutput: string | null = null;
  for (const vout of tx.vout) {
    const addr = vout.scriptpubkey_address;
    if (addr && own.has(addr)) received += vout.value;
    else if (vout.value > 0n) {
      allOutputsOurs = false;
      foreignOutput ??= addr ?? null;
    }
  }
  const fee = tx.fee ?? 0n;
  const confirmed = tx.status.confirmed && tx.status.block_time !== undefined;
  const base = {
    network: "bitcoin" as const,
    txHash: tx.txid.toLowerCase(),
    logIndex: -1,
    blockTime: confirmed ? isoFromUnixSeconds(tx.status.block_time!) : ctx.fetchedAt,
    symbol: ctx.symbol,
    contractAddress: null,
    ...(confirmed ? {} : { pending: true }),
  };
  const btc = (v: bigint) => fromBaseUnits(v, 8);

  if (sent === 0n) {
    if (received === 0n) return null;
    return { ...base, direction: "in", quantity: btc(received), counterparty: foreignInput };
  }
  if (allInputsOurs && allOutputsOurs) {
    return {
      ...base,
      direction: "self",
      quantity: btc(received),
      feeQuantity: btc(fee),
      feeSymbol: ctx.symbol,
      counterparty: null,
    };
  }
  const net = received - sent;
  if (net < 0n) {
    // The fee is only attributable when every input is ours (otherwise e.g. a CoinJoin).
    const feePaid = allInputsOurs ? fee : 0n;
    const amount = -net - feePaid;
    return {
      ...base,
      direction: "out",
      quantity: btc(amount > 0n ? amount : 0n),
      ...(feePaid > 0n ? { feeQuantity: btc(feePaid), feeSymbol: ctx.symbol } : {}),
      counterparty: foreignOutput,
    };
  }
  if (net > 0n) return { ...base, direction: "in", quantity: btc(net), counterparty: foreignInput };
  return { ...base, direction: "self", quantity: "0", counterparty: null };
}

export class EsploraProvider implements ChainProvider {
  readonly id = PROVIDER;
  private readonly baseUrl: string;
  private readonly testnetBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly gapLimit: number;
  private readonly maxAddressRequests: number;
  private readonly maxHistoryRequests: number;
  private readonly concurrency: number;
  private readonly now: () => Date;

  constructor(opts: EsploraProviderOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_ESPLORA_URL;
    this.testnetBaseUrl = opts.testnetBaseUrl ?? DEFAULT_ESPLORA_TESTNET_URL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.gapLimit = Math.max(1, opts.gapLimit ?? 20);
    this.maxAddressRequests = Math.max(1, opts.maxAddressRequests ?? 200);
    this.maxHistoryRequests = Math.max(0, opts.maxHistoryRequests ?? 50);
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.now = opts.now ?? (() => new Date());
  }

  supports(target: WatchTarget): boolean {
    return target.family === "bitcoin";
  }

  private async get(url: string, signal?: AbortSignal): Promise<unknown> {
    return requestJson(url, { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, signal }, providerErrorFactory(PROVIDER, "bitcoin"));
  }

  private async fetchStats(base: string, address: string, signal?: AbortSignal): Promise<AddressStats> {
    const data = parseResponse(
      AddressSchema,
      await this.get(joinUrl(base, `address/${encodeURIComponent(address)}`), signal),
      PROVIDER,
      "bitcoin",
    );
    const c = data.chain_stats;
    const m = data.mempool_stats;
    const balance = c.funded_txo_sum - c.spent_txo_sum + m.funded_txo_sum - m.spent_txo_sum;
    if (balance < 0n) {
      throw new BlockchainProviderError("invalid_response", PROVIDER, { detail: "negative balance", network: "bitcoin" });
    }
    return { address, balance, txCount: c.tx_count + m.tx_count, chainTxCount: c.tx_count };
  }

  private async fetchHistory(
    base: string,
    stats: AddressStats,
    wanted: number,
    budget: Budget,
    signal?: AbortSignal,
  ): Promise<{ txs: EsploraTx[]; truncated: boolean }> {
    const txs: EsploraTx[] = [];
    let path = `address/${encodeURIComponent(stats.address)}/txs`;
    let confirmedSeen = 0;
    for (;;) {
      if (budget.history <= 0) return { txs, truncated: true };
      budget.history--;
      const page = parseResponse(TxListSchema, await this.get(joinUrl(base, path), signal), PROVIDER, "bitcoin");
      txs.push(...page);
      const confirmed = page.filter((t) => t.status.confirmed);
      confirmedSeen += confirmed.length;
      const last = confirmed[confirmed.length - 1];
      const more = confirmed.length >= CONFIRMED_PAGE_SIZE && confirmedSeen < stats.chainTxCount;
      if (!more || !last || txs.length >= wanted) return { txs, truncated: false };
      path = `address/${encodeURIComponent(stats.address)}/txs/chain/${last.txid}`;
    }
  }

  async getSnapshot(target: WatchTarget, opts: SnapshotOptions = {}): Promise<WalletSnapshot> {
    if (!this.supports(target)) throw new BlockchainProviderError("unsupported", PROVIDER, { detail: "not a bitcoin target" });
    const fetchedAt = this.now().toISOString();
    const maxTransactions = clampMaxTransactions(opts.maxTransactions);
    if (opts.networks && !opts.networks.includes("bitcoin")) {
      return { target, fetchedAt, holdings: [], transactions: [], networksScanned: [], unsupportedReasons: [], provider: PROVIDER };
    }
    const base = target.network === "mainnet" ? this.baseUrl : this.testnetBaseUrl;
    const signal = opts.signal;
    const budget: Budget = { addresses: this.maxAddressRequests, history: this.maxHistoryRequests };
    const reasons: string[] = [];
    const own = new Set<string>();
    const used: AddressStats[] = [];

    if (target.kind === "address") {
      own.add(target.identifier);
      const stats = await this.fetchStats(base, target.identifier, signal);
      if (stats.txCount > 0) used.push(stats);
    } else {
      let truncated = false;
      for (const branch of watchTargetBranches(target)) {
        let index = 0;
        let gap = 0;
        while (gap < this.gapLimit) {
          if (budget.addresses <= 0) {
            truncated = true;
            break;
          }
          const size = Math.min(this.gapLimit - gap, budget.addresses);
          budget.addresses -= size;
          const derived = deriveWatchTargetAddresses(target, { branch, start: index, count: size });
          const results = await mapWithConcurrency(derived, this.concurrency, (d) =>
            this.fetchStats(base, d.address, signal),
          );
          for (const r of results) {
            own.add(r.address);
            if (r.txCount > 0) {
              used.push(r);
              gap = 0;
            } else gap++;
          }
          index += size;
        }
      }
      if (truncated) reasons.push("bitcoin:scan_truncated");
    }

    const testnet = target.network === "testnet";
    const symbol = testnet ? "tBTC" : "BTC";
    const total = used.reduce((acc, s) => acc + s.balance, 0n);
    const holdings: HoldingSnapshot[] = [
      {
        network: "bitcoin",
        symbol,
        name: testnet ? "Bitcoin Testnet" : "Bitcoin",
        contractAddress: null,
        decimals: 8,
        quantity: fromBaseUnits(total, 8),
        currencyCode: testnet ? null : "BTC",
        isStablecoin: false,
      },
    ];

    const byTxid = new Map<string, EsploraTx>();
    let historyTruncated = false;
    if (maxTransactions > 0) {
      for (const stats of used) {
        const { txs, truncated } = await this.fetchHistory(base, stats, maxTransactions, budget, signal);
        historyTruncated ||= truncated;
        for (const tx of txs) byTxid.set(tx.txid.toLowerCase(), tx);
      }
    }
    if (historyTruncated) reasons.push("bitcoin:history_truncated");

    const transactions = sortTransactions(
      [...byTxid.values()]
        .map((tx) => classifyBitcoinTx(tx, own, { symbol, fetchedAt }))
        .filter((t): t is ChainTransaction => t !== null),
    ).slice(0, maxTransactions);

    return {
      target,
      fetchedAt,
      holdings: finalizeHoldings(holdings),
      transactions,
      networksScanned: ["bitcoin"],
      unsupportedReasons: reasons,
      provider: PROVIDER,
    };
  }
}
