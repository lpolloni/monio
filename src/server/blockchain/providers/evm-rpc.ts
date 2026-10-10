import { z } from "zod";
import { isEvmAddressFormat, toChecksumAddress } from "@/domain/crypto/addresses";
import {
  EVM_NETWORK_IDS,
  getNetwork,
  isEvmNetworkId,
  tokensForNetwork,
  type EvmNetworkId,
  type TokenInfo,
} from "@/domain/crypto/assets";
import { fromBaseUnits } from "@/domain/money/decimal";
import { mapWithConcurrency, requestJson } from "../http";
import {
  clampMaxTransactions,
  finalizeHoldings,
  mergeSnapshots,
  parseResponse,
  providerErrorFactory,
  settlePerNetwork,
  zHexQuantity,
} from "../shared";
import {
  BlockchainProviderError,
  DEFAULT_TIMEOUT_MS,
  type ChainProvider,
  type HoldingSnapshot,
  type SnapshotOptions,
  type WalletSnapshot,
  type WatchTarget,
} from "../types";

/**
 * EVM balances via plain JSON-RPC (POST {rpcUrl}).
 *
 * Read-only by construction: the only methods that can be sent are
 * eth_getBalance, eth_blockNumber and eth_call with the ERC-20 view selectors
 * balanceOf(address) 0x70a08231, decimals() 0x313ce567 and symbol() 0x95d89b41.
 * Anything else throws before a request is made.
 *
 * Limitation: JSON-RPC has no address index, so this provider returns BALANCES
 * ONLY (native coin + the curated token catalog in assets.ts) and reports
 * "<network>:history_unavailable". Use Blockscout for token discovery/history.
 */

const PROVIDER = "evm-rpc";

/** Public endpoints used when no URL is configured. Override in production (rate limits apply). */
export const DEFAULT_EVM_RPC_URLS: Readonly<Record<EvmNetworkId, string>> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  polygon: "https://polygon-rpc.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  optimism: "https://mainnet.optimism.io",
  base: "https://mainnet.base.org",
};

export const ERC20_SELECTORS = {
  balanceOf: "0x70a08231",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
} as const;

type ReadOnlyMethod = "eth_getBalance" | "eth_call" | "eth_blockNumber";

export interface EvmRpcProviderOptions {
  rpcUrls?: Partial<Record<EvmNetworkId, string>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  now?: () => Date;
}

const RpcResponseSchema = z.union([
  z.object({ result: z.string() }),
  z.object({ error: z.object({ code: z.union([z.string(), z.number()]).optional(), message: z.string().optional() }) }),
]);

const ADDRESS_WORD = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");

/** Throws unless the call is one of the whitelisted read-only operations. */
export function assertReadOnlyCall(method: string, params: readonly unknown[]): void {
  if (method === "eth_blockNumber") {
    if (params.length !== 0) throw new TypeError("eth_blockNumber takes no params");
    return;
  }
  if (method === "eth_getBalance") {
    if (params.length !== 2 || typeof params[0] !== "string" || !isEvmAddressFormat(params[0])) {
      throw new TypeError("eth_getBalance expects [address, block]");
    }
    return;
  }
  if (method === "eth_call") {
    const call = params[0] as { to?: unknown; data?: unknown } | undefined;
    if (!call || typeof call.to !== "string" || !isEvmAddressFormat(call.to) || typeof call.data !== "string") {
      throw new TypeError("eth_call expects [{to, data}, block]");
    }
    const data = call.data.toLowerCase();
    const ok =
      data === ERC20_SELECTORS.decimals ||
      data === ERC20_SELECTORS.symbol ||
      (data.startsWith(ERC20_SELECTORS.balanceOf) && /^0x70a08231[0]{24}[0-9a-f]{40}$/.test(data));
    if (!ok) throw new TypeError("eth_call data is not an allowed read-only ERC-20 view");
    if (Object.keys(call).some((k) => k !== "to" && k !== "data")) throw new TypeError("eth_call allows only to/data");
    return;
  }
  throw new TypeError("JSON-RPC method not allowed");
}

/** Decodes an ABI-encoded `string` return value, or a right-padded bytes32 (legacy tokens). */
export function decodeAbiString(hex: string): string | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length === 0 || body.length % 64 !== 0) return null;
  const bytesFromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
  if (body.length === 64) {
    const raw = bytesFromHex(body);
    const end = raw.indexOf(0);
    return new TextDecoder("utf-8", { fatal: false }).decode(end >= 0 ? raw.slice(0, end) : raw) || null;
  }
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
  if (!Number.isSafeInteger(offset) || offset * 2 + 64 > body.length) return null;
  const length = Number(BigInt(`0x${body.slice(offset * 2, offset * 2 + 64)}`));
  const start = offset * 2 + 64;
  if (!Number.isSafeInteger(length) || start + length * 2 > body.length) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytesFromHex(body.slice(start, start + length * 2)));
}

export class EvmRpcProvider implements ChainProvider {
  readonly id = PROVIDER;
  private readonly rpcUrls: Partial<Record<EvmNetworkId, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly now: () => Date;
  private nextId = 1;

  constructor(opts: EvmRpcProviderOptions = {}) {
    this.rpcUrls = opts.rpcUrls ?? DEFAULT_EVM_RPC_URLS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.now = opts.now ?? (() => new Date());
  }

  supports(target: WatchTarget): boolean {
    return target.family === "evm" && target.kind === "address";
  }

  configuredNetworks(): EvmNetworkId[] {
    return EVM_NETWORK_IDS.filter((n) => !!this.rpcUrls[n]);
  }

  private async call(
    network: EvmNetworkId,
    method: ReadOnlyMethod,
    params: unknown[],
    signal?: AbortSignal,
  ): Promise<string> {
    assertReadOnlyCall(method, params);
    const url = this.rpcUrls[network];
    if (!url) throw new BlockchainProviderError("unsupported", PROVIDER, { network, detail: "no RPC URL configured" });
    const raw = await requestJson(
      url,
      {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        signal,
        method: "POST",
        body: { jsonrpc: "2.0", id: this.nextId++, method, params },
      },
      providerErrorFactory(PROVIDER, network),
    );
    const res = parseResponse(RpcResponseSchema, raw, PROVIDER, network);
    if ("error" in res) {
      const code = String(res.error.code ?? "");
      const limited = code === "-32005" || code === "429" || /rate|limit|too many/i.test(res.error.message ?? "");
      throw new BlockchainProviderError(limited ? "rate_limited" : "network", PROVIDER, {
        network,
        detail: limited ? "rpc rate limit" : "rpc error",
      });
    }
    if (!/^0x[0-9a-fA-F]*$/.test(res.result)) {
      throw new BlockchainProviderError("invalid_response", PROVIDER, { network, detail: "non-hex result" });
    }
    return res.result;
  }

  private quantity(result: string, network: EvmNetworkId): bigint {
    const parsed = zHexQuantity.safeParse(result);
    // A balance is a uint256: at most 64 hex digits.
    if (!parsed.success || result.length > 66) {
      throw new BlockchainProviderError("invalid_response", PROVIDER, { network, detail: "bad quantity" });
    }
    return parsed.data;
  }

  async blockNumber(network: EvmNetworkId, signal?: AbortSignal): Promise<bigint> {
    return this.quantity(await this.call(network, "eth_blockNumber", [], signal), network);
  }

  /** Reads decimals() and symbol() of an arbitrary ERC-20 (for user-added tokens). */
  async fetchTokenMetadata(
    network: EvmNetworkId,
    contractAddress: string,
    signal?: AbortSignal,
  ): Promise<{ symbol: string | null; decimals: number | null }> {
    const to = toChecksumAddress(contractAddress);
    const [d, s] = await Promise.all([
      this.call(network, "eth_call", [{ to, data: ERC20_SELECTORS.decimals }, "latest"], signal),
      this.call(network, "eth_call", [{ to, data: ERC20_SELECTORS.symbol }, "latest"], signal),
    ]);
    const decimals = d === "0x" ? null : this.quantity(d, network);
    return {
      decimals: decimals !== null && decimals <= 77n ? Number(decimals) : null,
      symbol: s === "0x" ? null : decodeAbiString(s),
    };
  }

  private async networkSnapshot(
    target: WatchTarget,
    network: EvmNetworkId,
    fetchedAt: string,
    signal?: AbortSignal,
  ): Promise<WalletSnapshot> {
    const address = target.identifier;
    const info = getNetwork(network);
    const native = this.quantity(await this.call(network, "eth_getBalance", [address, "latest"], signal), network);
    const tokens = tokensForNetwork(network);
    const tokenBalances = await mapWithConcurrency(tokens, this.concurrency, async (t: TokenInfo) => {
      const result = await this.call(
        network,
        "eth_call",
        [{ to: t.contractAddress, data: `${ERC20_SELECTORS.balanceOf}${ADDRESS_WORD(address)}` }, "latest"],
        signal,
      );
      // "0x" means no contract code at that address on this chain: treat as zero.
      return { token: t, units: result === "0x" ? 0n : this.quantity(result, network) };
    });
    const holdings: HoldingSnapshot[] = [
      {
        network,
        symbol: info.nativeSymbol,
        name: info.nativeName,
        contractAddress: null,
        decimals: info.nativeDecimals,
        quantity: fromBaseUnits(native, info.nativeDecimals),
        currencyCode: info.nativeCurrencyCode,
        isStablecoin: false,
      },
      ...tokenBalances.map(({ token, units }) => ({
        network,
        symbol: token.symbol,
        name: token.name,
        contractAddress: token.contractAddress,
        decimals: token.decimals,
        quantity: fromBaseUnits(units, token.decimals),
        currencyCode: token.currencyCode,
        isStablecoin: token.isStablecoin,
      })),
    ];
    return {
      target,
      fetchedAt,
      holdings: finalizeHoldings(holdings),
      transactions: [],
      networksScanned: [network],
      unsupportedReasons: [`${network}:history_unavailable`],
      provider: PROVIDER,
    };
  }

  async getSnapshot(target: WatchTarget, opts: SnapshotOptions = {}): Promise<WalletSnapshot> {
    if (!this.supports(target)) throw new BlockchainProviderError("unsupported", PROVIDER, { detail: "not an EVM address" });
    const fetchedAt = this.now().toISOString();
    const requested = (opts.networks ?? EVM_NETWORK_IDS).filter(isEvmNetworkId);
    const networks = requested.filter((n) => !!this.rpcUrls[n]);
    const missing = requested.filter((n) => !this.rpcUrls[n]).map((n) => `${n}:not_configured`);
    const { parts, reasons } = await settlePerNetwork(networks, (n) =>
      this.networkSnapshot(target, n, fetchedAt, opts.signal),
    );
    return mergeSnapshots(target, parts, PROVIDER, fetchedAt, clampMaxTransactions(opts.maxTransactions), [
      ...reasons,
      ...missing,
    ]);
  }
}
