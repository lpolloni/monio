import { detectWatchTarget } from "@/domain/crypto/addresses";
import { EVM_NETWORK_IDS, NETWORK_IDS, isEvmNetworkId, isNetworkId, type EvmNetworkId } from "@/domain/crypto/assets";
import { BlockscoutProvider } from "./providers/blockscout";
import { EsploraProvider, type EsploraProviderOptions } from "./providers/esplora";
import { DEFAULT_EVM_RPC_URLS, EvmRpcProvider } from "./providers/evm-rpc";
import { MockChainProvider, type MockChainProviderOptions } from "./providers/mock";
import { clampMaxTransactions, mergeSnapshots, reasonFor } from "./shared";
import {
  BlockchainProviderError,
  type NetworkId,
  type SnapshotOptions,
  type WalletSnapshot,
  type WatchTarget,
} from "./types";

/**
 * Entry point for read-only wallet snapshots.
 *
 * mock → MockChainProvider (deterministic, offline; the dev default).
 * live → bitcoin: Esplora; EVM: Blockscout for networks that have a Blockscout URL configured,
 *        JSON-RPC (balances only) for the rest, using public RPC defaults when none is configured.
 *
 * Every snapshot re-validates the target from its identifier (defence in depth: a
 * target loaded from storage can never smuggle secret material or a forged descriptor).
 */

export type BlockchainProviderMode = "mock" | "live";

export interface BlockchainServiceConfig {
  provider: BlockchainProviderMode;
  /** Esplora base URL for mainnet (default https://mempool.space/api). */
  bitcoinApiUrl?: string;
  /** Esplora base URL for testnet targets (default https://mempool.space/testnet4/api). */
  bitcoinTestnetApiUrl?: string;
  evmRpcUrls?: Partial<Record<NetworkId, string>>;
  blockscoutUrls?: Partial<Record<NetworkId, string>>;
  /** Blockscout API key (sent as the `apikey` query parameter; never returned). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  mock?: MockChainProviderOptions;
  esplora?: Pick<EsploraProviderOptions, "gapLimit" | "maxAddressRequests" | "maxHistoryRequests" | "concurrency">;
}

export interface BlockchainService {
  readonly provider: string;
  snapshot(target: WatchTarget, opts?: SnapshotOptions): Promise<WalletSnapshot>;
  supportedNetworks(): NetworkId[];
}

function evmOnly(urls: Partial<Record<NetworkId, string>> | undefined): Partial<Record<EvmNetworkId, string>> {
  const out: Partial<Record<EvmNetworkId, string>> = {};
  for (const [k, v] of Object.entries(urls ?? {})) if (isEvmNetworkId(k) && v) out[k] = v;
  return out;
}

function revalidate(target: WatchTarget): WatchTarget {
  const checked = detectWatchTarget(target?.identifier ?? "");
  if (!checked.ok || checked.target.family !== target.family || checked.target.kind !== target.kind) {
    throw new BlockchainProviderError("unsupported", "service", { detail: "invalid watch target" });
  }
  return checked.target;
}

function sanitizeOptions(opts: SnapshotOptions): SnapshotOptions {
  return {
    ...opts,
    ...(opts.networks ? { networks: opts.networks.filter((n) => isNetworkId(n)) } : {}),
    maxTransactions: clampMaxTransactions(opts.maxTransactions),
  };
}

export function createBlockchainService(config: BlockchainServiceConfig): BlockchainService {
  if (config.provider === "mock") {
    const mock = new MockChainProvider({ ...config.mock, ...(config.now ? { now: config.now } : {}) });
    return {
      provider: "mock",
      supportedNetworks: () => [...NETWORK_IDS],
      snapshot: async (target, opts = {}) => mock.getSnapshot(revalidate(target), sanitizeOptions(opts)),
    };
  }

  const shared = {
    ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.now ? { now: config.now } : {}),
  };
  const esplora = new EsploraProvider({
    ...shared,
    ...config.esplora,
    ...(config.bitcoinApiUrl ? { baseUrl: config.bitcoinApiUrl } : {}),
    ...(config.bitcoinTestnetApiUrl ? { testnetBaseUrl: config.bitcoinTestnetApiUrl } : {}),
  });
  const blockscoutUrls = evmOnly(config.blockscoutUrls);
  const blockscout =
    Object.keys(blockscoutUrls).length > 0
      ? new BlockscoutProvider({ ...shared, baseUrls: blockscoutUrls, ...(config.apiKey ? { apiKey: config.apiKey } : {}) })
      : null;
  const rpc = new EvmRpcProvider({ ...shared, rpcUrls: { ...DEFAULT_EVM_RPC_URLS, ...evmOnly(config.evmRpcUrls) } });

  async function evmSnapshot(target: WatchTarget, opts: SnapshotOptions): Promise<WalletSnapshot> {
    const fetchedAt = (config.now ?? (() => new Date()))().toISOString();
    const requested = (opts.networks ?? EVM_NETWORK_IDS).filter(isEvmNetworkId);
    const viaBlockscout = blockscout ? requested.filter((n) => blockscout.configuredNetworks().includes(n)) : [];
    const viaRpc = requested.filter((n) => !viaBlockscout.includes(n));
    const jobs: { provider: string; networks: EvmNetworkId[]; run: Promise<WalletSnapshot> }[] = [];
    if (blockscout && viaBlockscout.length > 0) {
      jobs.push({ provider: blockscout.id, networks: viaBlockscout, run: blockscout.getSnapshot(target, { ...opts, networks: viaBlockscout }) });
    }
    if (viaRpc.length > 0) {
      jobs.push({ provider: rpc.id, networks: viaRpc, run: rpc.getSnapshot(target, { ...opts, networks: viaRpc }) });
    }
    const settled = await Promise.allSettled(jobs.map((j) => j.run));
    const parts: WalletSnapshot[] = [];
    const reasons: string[] = [];
    let firstError: unknown;
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") parts.push(s.value);
      else {
        firstError ??= s.reason;
        for (const n of jobs[i]!.networks) reasons.push(reasonFor(n, s.reason));
      }
    });
    if (parts.length === 0 && firstError !== undefined) throw firstError;
    const label = parts.map((p) => p.provider).join("+") || "live";
    return mergeSnapshots(target, parts, label, fetchedAt, clampMaxTransactions(opts.maxTransactions), reasons);
  }

  return {
    provider: "live",
    supportedNetworks: () => [...NETWORK_IDS],
    snapshot: async (target, opts = {}) => {
      const safe = revalidate(target);
      const options = sanitizeOptions(opts);
      if (safe.family === "bitcoin") return esplora.getSnapshot(safe, options);
      return evmSnapshot(safe, options);
    },
  };
}
