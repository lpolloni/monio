import type { WatchTarget } from "@/domain/crypto/addresses";
import type { NetworkId } from "@/domain/crypto/assets";

export type { NetworkId } from "@/domain/crypto/assets";
export type { WatchTarget } from "@/domain/crypto/addresses";

/**
 * Read-only blockchain data contracts. Providers only ever perform GET requests
 * or the JSON-RPC reads eth_getBalance / eth_call (balanceOf, decimals, symbol)
 * / eth_blockNumber. There is no signing, transaction building or broadcasting.
 */

export interface HoldingSnapshot {
  network: NetworkId;
  symbol: string;
  name: string;
  /** EIP-55 checksummed token contract, or null for the native coin. */
  contractAddress: string | null;
  decimals: number;
  /** Decimal string, >= 0, already scaled by `decimals`. Zero balances are omitted from snapshots. */
  quantity: string;
  /** Currency code from currencies.ts when the asset is known (null for unknown tokens and testnet coins). */
  currencyCode: string | null;
  isStablecoin: boolean;
}

export interface ChainTransaction {
  network: NetworkId;
  txHash: string;
  /** Log index of the token transfer; -1 for native-coin movements. */
  logIndex: number;
  /** ISO timestamp of the block (or of the fetch for pending transactions). */
  blockTime: string;
  /**
   * Balance effect for the watched target:
   *  - in:   +quantity
   *  - out:  -quantity - feeQuantity (fee only when paid by the target)
   *  - self: -feeQuantity (quantity is the amount moved between own addresses, informational)
   */
  direction: "in" | "out" | "self";
  symbol: string;
  contractAddress: string | null;
  /** Decimal string, >= 0. */
  quantity: string;
  feeQuantity?: string;
  feeSymbol?: string;
  counterparty: string | null;
  /** True when the transaction is not yet confirmed (mempool / pending). */
  pending?: boolean;
}

export interface WalletSnapshot {
  target: WatchTarget;
  fetchedAt: string;
  holdings: HoldingSnapshot[];
  /** Newest first. */
  transactions: ChainTransaction[];
  networksScanned: NetworkId[];
  /**
   * Machine-readable notes in the form "<network>:<reason>" (e.g. "arbitrum:rate_limited",
   * "bitcoin:scan_truncated", "ethereum:history_unavailable"). Never contains addresses or keys.
   */
  unsupportedReasons: string[];
  provider: string;
}

export interface SnapshotOptions {
  networks?: NetworkId[];
  maxTransactions?: number;
  signal?: AbortSignal;
}

export interface ChainProvider {
  readonly id: string;
  supports(target: WatchTarget): boolean;
  getSnapshot(target: WatchTarget, opts?: SnapshotOptions): Promise<WalletSnapshot>;
}

export type BlockchainErrorCode =
  | "network"
  | "rate_limited"
  | "not_found"
  | "invalid_response"
  | "unsupported"
  | "timeout"
  | "aborted";

/**
 * Error raised by chain providers. The message is built only from the code,
 * provider id, HTTP status and a static detail string: it never contains
 * URLs, addresses, xpubs or API keys, so it is safe to log.
 */
export class BlockchainProviderError extends Error {
  readonly code: BlockchainErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly network?: NetworkId;

  constructor(
    code: BlockchainErrorCode,
    provider: string,
    opts: { status?: number; retryAfterSeconds?: number; detail?: string; network?: NetworkId } = {},
  ) {
    const parts = [`[${provider}${opts.network ? `/${opts.network}` : ""}] ${code}`];
    if (opts.status !== undefined) parts.push(`(HTTP ${opts.status})`);
    if (opts.detail) parts.push(`- ${opts.detail}`);
    super(parts.join(" "));
    this.name = "BlockchainProviderError";
    this.code = code;
    this.provider = provider;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.network !== undefined) this.network = opts.network;
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_TRANSACTIONS = 50;
export const MAX_TRANSACTIONS_LIMIT = 500;
