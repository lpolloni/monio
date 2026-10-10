import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";
import { deriveWatchTargetAddresses, toChecksumAddress, watchTargetBranches } from "@/domain/crypto/addresses";
import {
  EVM_NETWORK_IDS,
  getNetwork,
  isEvmNetworkId,
  tokensForNetwork,
  type EvmNetworkId,
  type NetworkId,
} from "@/domain/crypto/assets";
import { D, dec, fromBaseUnits, toPlain, type DecimalValue } from "@/domain/money/decimal";
import { clampMaxTransactions, finalizeHoldings, sortTransactions } from "../shared";
import {
  BlockchainProviderError,
  type ChainProvider,
  type ChainTransaction,
  type HoldingSnapshot,
  type SnapshotOptions,
  type WalletSnapshot,
  type WatchTarget,
} from "../types";
import { MOCK_CONTROLLED_EXTENDED_KEYS, MOCK_FIXTURES, type FixtureTransaction } from "./fixtures";

/**
 * Deterministic, offline chain provider for development and tests.
 *
 * - Controlled addresses (fixtures.ts) return fixed, FICTIONAL data.
 * - Any other valid address gets pseudo-random data seeded from SHA-256 of the
 *   address, so the same input always yields the same snapshot (no Math.random).
 * - xpub / descriptor targets derive the first N receive/change addresses and
 *   aggregate them.
 * Holdings are always derived from the generated transactions (in − out − fees).
 */

const PROVIDER = "mock";
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2023, 0, 1);
const END_MS = Date.UTC(2026, 5, 30);

export interface MockChainProviderOptions {
  now?: () => Date;
  /** Receive addresses derived for xpub/descriptor targets (default 5). */
  receiveAddressCount?: number;
  /** Change addresses derived for xpub/descriptor targets (default 2). */
  changeAddressCount?: number;
  /** Artificial latency, useful to exercise loading states in the UI. */
  latencyMs?: number;
}

/** SHA-256 counter-mode deterministic generator. */
class SeededRng {
  private counter = 0;
  constructor(private readonly seed: string) {}

  private block(): Uint8Array {
    return sha256(utf8ToBytes(`${this.seed}|${this.counter++}`));
  }

  u32(): number {
    const b = this.block();
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }

  int(min: number, max: number): number {
    return min + (this.u32() % (max - min + 1));
  }

  chance(percent: number): boolean {
    return this.u32() % 100 < percent;
  }

  big(min: bigint, max: bigint): bigint {
    let v = 0n;
    for (const x of this.block()) v = (v << 8n) | BigInt(x);
    return min + (v % (max - min + 1n));
  }

  hex(bytes: number): string {
    const out: number[] = [];
    while (out.length < bytes) out.push(...this.block());
    return bytesToHex(Uint8Array.from(out.slice(0, bytes)));
  }
}

const units = (amount: string, decimals: number): bigint =>
  BigInt(dec(amount).times(new D(10).pow(decimals)).toFixed(0));

function fakeHash(label: string): string {
  return bytesToHex(sha256(utf8ToBytes(`monio-mock-tx|${label}`)));
}

function nativeSymbol(network: NetworkId, testnet: boolean): string {
  return network === "bitcoin" && testnet ? "tBTC" : getNetwork(network).nativeSymbol;
}

function fixtureToTransactions(identifier: string, txs: readonly FixtureTransaction[]): ChainTransaction[] {
  return txs.map((f, i) => {
    const isNative = f.symbol === getNetwork(f.network).nativeSymbol;
    const token = isNative ? undefined : tokensForNetwork(f.network).find((t) => t.symbol === f.symbol);
    if (!isNative && !token) throw new Error(`Fixture token ${f.symbol} missing from catalog`);
    const hash = fakeHash(`fixture|${identifier}|${i}`);
    return {
      network: f.network,
      txHash: f.network === "bitcoin" ? hash : `0x${hash}`,
      logIndex: f.logIndex ?? -1,
      blockTime: f.time,
      direction: f.direction,
      symbol: f.symbol,
      contractAddress: token?.contractAddress ?? null,
      quantity: f.quantity,
      ...(f.fee ? { feeQuantity: f.fee, feeSymbol: getNetwork(f.network).nativeSymbol } : {}),
      counterparty: f.counterparty,
    };
  });
}

function nextTime(rng: SeededRng, previous: number): number | null {
  const t = previous + rng.int(1, 45) * DAY_MS + rng.int(0, 86_399) * 1000;
  return t > END_MS ? null : t;
}

function generateBitcoin(address: string, testnet: boolean): ChainTransaction[] {
  const rng = new SeededRng(`monio-mock|bitcoin|${address}`);
  if (!rng.chance(75)) return [];
  const symbol = testnet ? "tBTC" : "BTC";
  const hrp = testnet ? "tb" : "bc";
  const peer = () => bech32.encode(hrp, [0, ...bech32.toWords(hexToBytes(rng.hex(20)))]);
  const txs: ChainTransaction[] = [];
  let t: number | null = EPOCH_MS + rng.int(0, 700) * DAY_MS;
  let balance = 0n;
  const n = rng.int(1, 6);
  for (let i = 0; i < n; i++) {
    t = nextTime(rng, t);
    if (t === null) break;
    const base = { network: "bitcoin" as const, txHash: rng.hex(32), logIndex: -1, blockTime: new Date(t).toISOString(), symbol, contractAddress: null };
    if (i === 0 || balance < 100_000n || rng.chance(55)) {
      const amount = rng.big(50_000n, 25_000_000n);
      balance += amount;
      txs.push({ ...base, direction: "in", quantity: fromBaseUnits(amount, 8), counterparty: peer() });
    } else {
      const fee = rng.big(300n, 6_000n);
      const amount = ((balance - fee) * BigInt(rng.int(10, 70))) / 100n;
      balance -= amount + fee;
      txs.push({
        ...base,
        direction: "out",
        quantity: fromBaseUnits(amount, 8),
        feeQuantity: fromBaseUnits(fee, 8),
        feeSymbol: symbol,
        counterparty: peer(),
      });
    }
  }
  return txs;
}

interface AssetSpec {
  symbol: string;
  contractAddress: string | null;
  decimals: number;
  chance: number;
  min: string;
  max: string;
}

function evmAssets(network: EvmNetworkId): AssetSpec[] {
  const info = getNetwork(network);
  const native: AssetSpec =
    network === "polygon"
      ? { symbol: "POL", contractAddress: null, decimals: 18, chance: 40, min: "1", max: "2500" }
      : { symbol: info.nativeSymbol, contractAddress: null, decimals: 18, chance: network === "ethereum" ? 70 : 35, min: "0.005", max: "3" };
  const tokens = tokensForNetwork(network).map<AssetSpec>((t) => {
    const [min, max] = t.isStablecoin
      ? ["5", "5000"]
      : t.symbol === "WBTC"
        ? ["0.0005", "0.15"]
        : t.symbol === "WETH"
          ? ["0.01", "2"]
          : ["1", "400"];
    return { symbol: t.symbol, contractAddress: t.contractAddress, decimals: t.decimals, chance: 30, min, max };
  });
  return [native, ...tokens];
}

function feeRange(network: EvmNetworkId): [string, string] {
  if (network === "ethereum") return ["0.0001", "0.004"];
  if (network === "polygon") return ["0.002", "0.08"];
  return ["0.000005", "0.0002"];
}

function generateEvm(address: string, network: EvmNetworkId): ChainTransaction[] {
  const rng = new SeededRng(`monio-mock|${network}|${address.toLowerCase()}`);
  const native = getNetwork(network).nativeSymbol;
  const [feeMin, feeMax] = feeRange(network);
  const peer = () => toChecksumAddress(`0x${rng.hex(20)}`);
  const txs: ChainTransaction[] = [];
  let nativeBalance = 0n;

  for (const asset of evmAssets(network)) {
    if (!rng.chance(asset.chance)) continue;
    const isNative = asset.contractAddress === null;
    let balance = 0n;
    let t: number | null = EPOCH_MS + rng.int(0, 900) * DAY_MS;
    const n = rng.int(1, 4);
    for (let i = 0; i < n; i++) {
      t = nextTime(rng, t);
      if (t === null) break;
      const base = {
        network,
        txHash: `0x${rng.hex(32)}`,
        logIndex: isNative ? -1 : rng.int(0, 250),
        blockTime: new Date(t).toISOString(),
        symbol: asset.symbol,
        contractAddress: asset.contractAddress,
      };
      const fee = rng.big(units(feeMin, 18), units(feeMax, 18));
      if (i === 0 || balance === 0n || rng.chance(60)) {
        const amount = rng.big(units(asset.min, asset.decimals), units(asset.max, asset.decimals));
        balance += amount;
        if (isNative) nativeBalance += amount;
        txs.push({ ...base, direction: "in", quantity: fromBaseUnits(amount, asset.decimals), counterparty: peer() });
      } else {
        const spendable = isNative ? balance - fee : balance;
        if (spendable <= 0n) continue;
        const amount = (spendable * BigInt(rng.int(10, 80))) / 100n;
        const payFee = isNative || nativeBalance >= fee;
        balance -= amount + (isNative ? fee : 0n);
        if (isNative) nativeBalance -= amount + fee;
        else if (payFee) nativeBalance -= fee;
        txs.push({
          ...base,
          direction: "out",
          quantity: fromBaseUnits(amount, asset.decimals),
          ...(payFee ? { feeQuantity: fromBaseUnits(fee, 18), feeSymbol: native } : {}),
          counterparty: peer(),
        });
      }
    }
  }
  return txs;
}

/** Derives holdings from transactions: Σin − Σout − Σfees per (network, symbol). Exported for tests. */
export function holdingsFromTransactions(txs: readonly ChainTransaction[], testnet = false): HoldingSnapshot[] {
  const balances = new Map<string, { network: NetworkId; symbol: string; contractAddress: string | null; total: DecimalValue }>();
  const bump = (network: NetworkId, symbol: string, contractAddress: string | null, delta: DecimalValue) => {
    const key = `${network}|${symbol}`;
    const entry = balances.get(key) ?? { network, symbol, contractAddress, total: new D(0) };
    entry.total = entry.total.plus(delta);
    balances.set(key, entry);
  };
  for (const tx of txs) {
    const q = dec(tx.quantity);
    if (tx.direction === "in") bump(tx.network, tx.symbol, tx.contractAddress, q);
    else if (tx.direction === "out") bump(tx.network, tx.symbol, tx.contractAddress, q.negated());
    else bump(tx.network, tx.symbol, tx.contractAddress, new D(0));
    if (tx.feeQuantity && tx.feeSymbol) bump(tx.network, tx.feeSymbol, null, dec(tx.feeQuantity).negated());
  }
  const holdings: HoldingSnapshot[] = [];
  for (const { network, symbol, contractAddress, total } of balances.values()) {
    if (total.isNegative()) throw new Error("Mock data produced a negative balance");
    const info = getNetwork(network);
    if (symbol === nativeSymbol(network, testnet)) {
      holdings.push({
        network,
        symbol,
        name: network === "bitcoin" && testnet ? "Bitcoin Testnet" : info.nativeName,
        contractAddress: null,
        decimals: info.nativeDecimals,
        quantity: toPlain(total),
        currencyCode: network === "bitcoin" && testnet ? null : info.nativeCurrencyCode,
        isStablecoin: false,
      });
    } else {
      const token = tokensForNetwork(network).find(
        (t) => t.symbol === symbol && (contractAddress === null || t.contractAddress === contractAddress),
      );
      if (!token) throw new Error(`Unknown mock token ${symbol}`);
      holdings.push({
        network,
        symbol,
        name: token.name,
        contractAddress: token.contractAddress,
        decimals: token.decimals,
        quantity: toPlain(total),
        currencyCode: token.currencyCode,
        isStablecoin: token.isStablecoin,
      });
    }
  }
  return finalizeHoldings(holdings);
}

export class MockChainProvider implements ChainProvider {
  readonly id = PROVIDER;
  private readonly now: () => Date;
  private readonly receiveCount: number;
  private readonly changeCount: number;
  private readonly latencyMs: number;

  constructor(opts: MockChainProviderOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.receiveCount = Math.max(1, opts.receiveAddressCount ?? 5);
    this.changeCount = Math.max(0, opts.changeAddressCount ?? 2);
    this.latencyMs = Math.max(0, opts.latencyMs ?? 0);
  }

  supports(target: WatchTarget): boolean {
    return target.family === "bitcoin" || (target.family === "evm" && target.kind === "address");
  }

  private bitcoinAddressTxs(address: string, testnet: boolean, controlled: boolean): ChainTransaction[] {
    const fixture = MOCK_FIXTURES[address];
    if (fixture) return fixtureToTransactions(address, fixture.transactions);
    return controlled ? [] : generateBitcoin(address, testnet);
  }

  async getSnapshot(target: WatchTarget, opts: SnapshotOptions = {}): Promise<WalletSnapshot> {
    if (!this.supports(target)) throw new BlockchainProviderError("unsupported", PROVIDER, { detail: "unsupported target" });
    if (opts.signal?.aborted) throw new BlockchainProviderError("aborted", PROVIDER);
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const fetchedAt = this.now().toISOString();
    const maxTransactions = clampMaxTransactions(opts.maxTransactions);
    const testnet = target.network === "testnet";
    let networks: NetworkId[];
    let txs: ChainTransaction[] = [];

    if (target.family === "bitcoin") {
      networks = !opts.networks || opts.networks.includes("bitcoin") ? ["bitcoin"] : [];
      if (networks.length > 0) {
        if (target.kind === "address") {
          txs = this.bitcoinAddressTxs(target.identifier, testnet, false);
        } else {
          const key = target.kind === "xpub" ? target.identifier : (target.descriptor?.extendedKey ?? "");
          const controlled = MOCK_CONTROLLED_EXTENDED_KEYS.has(key);
          watchTargetBranches(target).forEach((branch, pos) => {
            const count = pos === 0 ? this.receiveCount : this.changeCount;
            for (const d of deriveWatchTargetAddresses(target, { branch, start: 0, count })) {
              txs.push(...this.bitcoinAddressTxs(d.address, testnet, controlled));
            }
          });
        }
      }
    } else {
      const evmNetworks = (opts.networks ?? EVM_NETWORK_IDS).filter(isEvmNetworkId);
      networks = evmNetworks;
      const fixture = MOCK_FIXTURES[target.identifier];
      for (const network of evmNetworks) {
        txs.push(
          ...(fixture
            ? fixtureToTransactions(target.identifier, fixture.transactions).filter((t) => t.network === network)
            : generateEvm(target.identifier, network)),
        );
      }
    }

    return {
      target,
      fetchedAt,
      holdings: holdingsFromTransactions(txs, testnet),
      transactions: sortTransactions(txs).slice(0, maxTransactions),
      networksScanned: networks,
      unsupportedReasons: [],
      provider: PROVIDER,
    };
  }
}
