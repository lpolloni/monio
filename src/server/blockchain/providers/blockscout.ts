import { z } from "zod";
import { isEvmAddressFormat, toChecksumAddress } from "@/domain/crypto/addresses";
import {
  EVM_NETWORK_IDS,
  findKnownToken,
  getNetwork,
  isEvmNetworkId,
  type EvmNetworkId,
} from "@/domain/crypto/assets";
import { fromBaseUnits } from "@/domain/money/decimal";
import { joinUrl, requestJson } from "../http";
import {
  clampMaxTransactions,
  finalizeHoldings,
  mergeSnapshots,
  parseResponse,
  providerErrorFactory,
  settlePerNetwork,
  sortTransactions,
  zBaseUnits,
  zSmallInt,
  zTimestamp,
  zTxHash,
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
 * EVM balances, ERC-20 discovery and history via the Blockscout v2 REST API:
 *
 *   GET {base}/api/v2/addresses/{addr}                              → coin_balance (wei)
 *   GET {base}/api/v2/addresses/{addr}/token-balances               → ERC-20/721/1155 balances
 *   GET {base}/api/v2/addresses/{addr}/transactions                 → native txs (paged)
 *   GET {base}/api/v2/addresses/{addr}/token-transfers?type=ERC-20  → token transfers (paged)
 *
 * Only ERC-20 tokens are reported (NFTs are ignored). Tokens without a symbol or
 * decimals, or whose metadata looks like a phishing lure, are treated as spam and
 * excluded; tokens not in the curated catalog get `currencyCode: null`.
 * The optional API key is sent as the `apikey` query parameter and never echoed.
 * Field names differ between Blockscout releases (address vs address_hash,
 * tx_hash vs transaction_hash); both are accepted.
 */

const PROVIDER = "blockscout";
const MAX_TOKEN_DECIMALS = 36;
/** uint256 balances with more digits than this are absurd (and exceed exact Decimal precision). */
const MAX_BALANCE_DIGITS = 45;

export const DEFAULT_BLOCKSCOUT_URLS: Readonly<Record<EvmNetworkId, string>> = {
  ethereum: "https://eth.blockscout.com",
  polygon: "https://polygon.blockscout.com",
  arbitrum: "https://arbitrum.blockscout.com",
  optimism: "https://optimism.blockscout.com",
  base: "https://base.blockscout.com",
};

export interface BlockscoutProviderOptions {
  baseUrls: Partial<Record<EvmNetworkId, string>>;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Max pages fetched per list endpoint (Blockscout pages hold 50 items). Default 3. */
  maxPages?: number;
  now?: () => Date;
}

const AddressRef = z.object({ hash: z.string() });

const TokenSchema = z
  .object({
    address_hash: z.string().optional(),
    address: z.string().optional(),
    symbol: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    decimals: z.union([z.string(), z.number()]).nullable().optional(),
    type: z.string().nullable().optional(),
  })
  ;
type BlockscoutToken = z.output<typeof TokenSchema>;

const AddressInfoSchema = z.object({ coin_balance: zBaseUnits.nullable().optional() });

const TokenBalancesSchema = z.array(
  z.object({ token: TokenSchema, value: z.union([z.string(), z.number()]).nullable().optional() }),
);

const PageParams = z.record(z.string(), z.unknown()).nullable().optional();

const TransactionsPageSchema = z.object({
  items: z.array(
    z
      .object({
        hash: zTxHash,
        timestamp: zTimestamp.nullable().optional(),
        from: AddressRef.nullable(),
        to: AddressRef.nullable().optional(),
        value: zBaseUnits,
        fee: z.object({ value: zBaseUnits.nullable().optional() }).nullable().optional(),
        status: z.string().nullable().optional(),
        result: z.string().nullable().optional(),
      })
      ,
  ),
  next_page_params: PageParams,
});

const TransfersPageSchema = z.object({
  items: z.array(
    z
      .object({
        transaction_hash: zTxHash.optional(),
        tx_hash: zTxHash.optional(),
        log_index: zSmallInt,
        timestamp: zTimestamp.nullable().optional(),
        from: AddressRef.nullable(),
        to: AddressRef.nullable(),
        token: TokenSchema,
        total: z
          .object({ value: z.union([z.string(), z.number()]).nullable().optional() })
          
          .nullable()
          .optional(),
      })
      ,
  ),
  next_page_params: PageParams,
});

/**
 * Spam / phishing heuristic for indexer-discovered tokens. Catalog tokens are never spam.
 * Exported for tests and reuse.
 */
export function isSpamLikeToken(token: {
  symbol?: string | null;
  name?: string | null;
  decimals?: string | number | null;
}): boolean {
  const symbol = token.symbol?.trim();
  if (!symbol) return true;
  if (token.decimals === null || token.decimals === undefined) return true;
  const decimals = String(token.decimals);
  if (!/^\d{1,3}$/.test(decimals) || Number(decimals) > MAX_TOKEN_DECIMALS) return true;
  if (symbol.length > 20) return true;
  const text = `${symbol} ${token.name ?? ""}`.toLowerCase();
  if (/(https?:\/\/|www\.|t\.me\/|\.(com|io|org|net|xyz|app|finance|site|top|vip)\b)/.test(text)) return true;
  if (/\b(claim|airdrop|reward|rewards|visit|bonus|voucher|giveaway)\b/.test(text)) return true;
  return false;
}

function tokenAddress(token: BlockscoutToken): string | null {
  const raw = token.address_hash ?? token.address;
  return raw && isEvmAddressFormat(raw) ? toChecksumAddress(raw) : null;
}

function digitsOnly(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return null;
}

/** Resolves an ERC-20 token into display metadata, or null when it must be ignored (NFT / spam / malformed). */
function resolveToken(
  network: EvmNetworkId,
  token: BlockscoutToken,
): { contractAddress: string; symbol: string; name: string; decimals: number; currencyCode: string | null; isStablecoin: boolean } | null {
  if (token.type !== "ERC-20") return null;
  const contractAddress = tokenAddress(token);
  if (!contractAddress) return null;
  const known = findKnownToken(network, contractAddress);
  if (known) {
    return {
      contractAddress,
      symbol: known.symbol,
      name: known.name,
      decimals: known.decimals,
      currencyCode: known.currencyCode,
      isStablecoin: known.isStablecoin,
    };
  }
  if (isSpamLikeToken(token)) return null;
  return {
    contractAddress,
    symbol: token.symbol!.trim(),
    name: token.name?.trim() || token.symbol!.trim(),
    decimals: Number(token.decimals),
    currencyCode: null,
    isStablecoin: false,
  };
}

export class BlockscoutProvider implements ChainProvider {
  readonly id = PROVIDER;
  private readonly baseUrls: Partial<Record<EvmNetworkId, string>>;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly now: () => Date;

  constructor(opts: BlockscoutProviderOptions) {
    this.baseUrls = opts.baseUrls;
    this.apiKey = opts.apiKey || undefined;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPages = Math.max(1, opts.maxPages ?? 3);
    this.now = opts.now ?? (() => new Date());
  }

  supports(target: WatchTarget): boolean {
    return target.family === "evm" && target.kind === "address";
  }

  configuredNetworks(): EvmNetworkId[] {
    return EVM_NETWORK_IDS.filter((n) => !!this.baseUrls[n]);
  }

  private async get(
    network: EvmNetworkId,
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const base = this.baseUrls[network];
    if (!base) throw new BlockchainProviderError("unsupported", PROVIDER, { network, detail: "no base URL configured" });
    const url = new URL(joinUrl(base, path));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    if (this.apiKey) url.searchParams.set("apikey", this.apiKey);
    return requestJson(
      url.toString(),
      { fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, signal },
      providerErrorFactory(PROVIDER, network),
    );
  }

  private async getPaged<T extends { items: unknown[]; next_page_params?: Record<string, unknown> | null }>(
    network: EvmNetworkId,
    path: string,
    baseQuery: Record<string, string>,
    schema: z.ZodType<T>,
    wanted: number,
    signal?: AbortSignal,
  ): Promise<T["items"]> {
    const items: T["items"] = [];
    let query = baseQuery;
    for (let page = 0; page < this.maxPages && items.length < wanted; page++) {
      const data = parseResponse(schema, await this.get(network, path, query, signal), PROVIDER, network);
      items.push(...data.items);
      const next = data.next_page_params;
      if (!next) break;
      query = { ...baseQuery };
      for (const [k, v] of Object.entries(next)) {
        if (v !== null && v !== undefined && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
          query[k] = String(v);
        }
      }
    }
    return items;
  }

  private async networkSnapshot(
    target: WatchTarget,
    network: EvmNetworkId,
    fetchedAt: string,
    maxTransactions: number,
    signal?: AbortSignal,
  ): Promise<WalletSnapshot> {
    const me = target.identifier.toLowerCase();
    const addrPath = `api/v2/addresses/${target.identifier}`;
    const info = getNetwork(network);
    const empty: WalletSnapshot = {
      target,
      fetchedAt,
      holdings: [],
      transactions: [],
      networksScanned: [network],
      unsupportedReasons: [],
      provider: PROVIDER,
    };

    let coinBalance = 0n;
    try {
      const data = parseResponse(AddressInfoSchema, await this.get(network, addrPath, {}, signal), PROVIDER, network);
      coinBalance = data.coin_balance ?? 0n;
    } catch (e) {
      // Blockscout answers 404 for addresses it has never seen: an empty wallet, not an error.
      if (e instanceof BlockchainProviderError && e.code === "not_found") return empty;
      throw e;
    }

    const holdings: HoldingSnapshot[] = [
      {
        network,
        symbol: info.nativeSymbol,
        name: info.nativeName,
        contractAddress: null,
        decimals: info.nativeDecimals,
        quantity: fromBaseUnits(coinBalance, info.nativeDecimals),
        currencyCode: info.nativeCurrencyCode,
        isStablecoin: false,
      },
    ];

    const balances = parseResponse(
      TokenBalancesSchema,
      await this.get(network, `${addrPath}/token-balances`, {}, signal),
      PROVIDER,
      network,
    );
    for (const item of balances) {
      const token = resolveToken(network, item.token);
      const value = digitsOnly(item.value);
      if (!token || value === null || value.length > MAX_BALANCE_DIGITS) continue;
      holdings.push({
        network,
        symbol: token.symbol,
        name: token.name,
        contractAddress: token.contractAddress,
        decimals: token.decimals,
        quantity: fromBaseUnits(BigInt(value), token.decimals),
        currencyCode: token.currencyCode,
        isStablecoin: token.isStablecoin,
      });
    }

    const transactions: ChainTransaction[] = [];
    if (maxTransactions > 0) {
      const [txItems, transferItems] = await Promise.all([
        this.getPaged(network, `${addrPath}/transactions`, {}, TransactionsPageSchema, maxTransactions, signal),
        this.getPaged(
          network,
          `${addrPath}/token-transfers`,
          { type: "ERC-20" },
          TransfersPageSchema,
          maxTransactions,
          signal,
        ),
      ]);

      for (const tx of txItems) {
        const from = tx.from?.hash.toLowerCase() ?? null;
        const to = tx.to?.hash.toLowerCase() ?? null;
        const failed = tx.status === "error";
        const pending = !tx.timestamp || tx.result === "pending";
        const common = {
          network,
          txHash: tx.hash.toLowerCase(),
          logIndex: -1,
          blockTime: tx.timestamp ? new Date(tx.timestamp).toISOString() : fetchedAt,
          symbol: info.nativeSymbol,
          contractAddress: null,
          ...(pending ? { pending: true } : {}),
        };
        if (from === me) {
          const fee = tx.fee?.value ?? 0n;
          transactions.push({
            ...common,
            direction: to === me ? "self" : "out",
            quantity: failed ? "0" : fromBaseUnits(tx.value, info.nativeDecimals),
            ...(fee > 0n ? { feeQuantity: fromBaseUnits(fee, info.nativeDecimals), feeSymbol: info.nativeSymbol } : {}),
            counterparty: to && to !== me && isEvmAddressFormat(to) ? toChecksumAddress(to) : null,
          });
        } else if (to === me && !failed && tx.value > 0n) {
          transactions.push({
            ...common,
            direction: "in",
            quantity: fromBaseUnits(tx.value, info.nativeDecimals),
            counterparty: from && isEvmAddressFormat(from) ? toChecksumAddress(from) : null,
          });
        }
      }

      for (const tr of transferItems) {
        const token = resolveToken(network, tr.token);
        const value = digitsOnly(tr.total?.value);
        const hash = tr.transaction_hash ?? tr.tx_hash;
        if (!token || value === null || value === "0" || value.length > MAX_BALANCE_DIGITS || !hash) continue;
        const from = tr.from?.hash.toLowerCase() ?? null;
        const to = tr.to?.hash.toLowerCase() ?? null;
        const direction = from === me && to === me ? "self" : from === me ? "out" : to === me ? "in" : null;
        if (!direction) continue;
        const other = direction === "in" ? from : direction === "out" ? to : null;
        transactions.push({
          network,
          txHash: hash.toLowerCase(),
          logIndex: tr.log_index,
          blockTime: tr.timestamp ? new Date(tr.timestamp).toISOString() : fetchedAt,
          direction,
          symbol: token.symbol,
          contractAddress: token.contractAddress,
          quantity: fromBaseUnits(BigInt(value), token.decimals),
          counterparty: other && isEvmAddressFormat(other) ? toChecksumAddress(other) : null,
          ...(tr.timestamp ? {} : { pending: true }),
        });
      }
    }

    return {
      ...empty,
      holdings: finalizeHoldings(holdings),
      transactions: sortTransactions(transactions).slice(0, maxTransactions),
    };
  }

  async getSnapshot(target: WatchTarget, opts: SnapshotOptions = {}): Promise<WalletSnapshot> {
    if (!this.supports(target)) throw new BlockchainProviderError("unsupported", PROVIDER, { detail: "not an EVM address" });
    const fetchedAt = this.now().toISOString();
    const maxTransactions = clampMaxTransactions(opts.maxTransactions);
    const requested = (opts.networks ?? EVM_NETWORK_IDS).filter(isEvmNetworkId);
    const networks = requested.filter((n) => !!this.baseUrls[n]);
    const missing = requested.filter((n) => !this.baseUrls[n]).map((n) => `${n}:not_configured`);
    const { parts, reasons } = await settlePerNetwork(networks, (n) =>
      this.networkSnapshot(target, n, fetchedAt, maxTransactions, opts.signal),
    );
    return mergeSnapshots(target, parts, PROVIDER, fetchedAt, maxTransactions, [...reasons, ...missing]);
  }
}
