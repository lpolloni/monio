import { describe, expect, it } from "vitest";
import { detectWatchTarget, type WatchTarget } from "@/domain/crypto/addresses";
import { fakeFetch, hangingFetch, jsonResponse, type RecordedCall } from "../testing/fake-fetch";
import { BlockchainProviderError } from "../types";
import { EsploraProvider, EsploraTxSchema, classifyBitcoinTx } from "./esplora";

// Public test-vector addresses (BIP-84 / BIP-173 / Bitcoin wiki). All balances and
// transactions served by the fake fetch below are fictional.
const ME = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"; // m/84'/0'/0'/0/0
const R1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"; // m/84'/0'/0'/0/1
const C0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"; // m/84'/0'/0'/1/0
const OTHER = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const OTHER2 = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function target(input: string): WatchTarget {
  const r = detectWatchTarget(input);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}

const txid = (n: number) => n.toString(16).padStart(64, "0");

function tx(
  id: number,
  vin: [string, number][],
  vout: [string, number][],
  fee: number,
  blockTime?: number,
) {
  return {
    txid: txid(id),
    version: 2,
    locktime: 0,
    vin: vin.map(([a, v]) => ({
      txid: txid(9999),
      vout: 0,
      is_coinbase: false,
      prevout: { scriptpubkey: "00", scriptpubkey_address: a, scriptpubkey_type: "v0_p2wpkh", value: v },
    })),
    vout: vout.map(([a, v]) => ({ scriptpubkey: "00", scriptpubkey_address: a, scriptpubkey_type: "v0_p2wpkh", value: v })),
    size: 222,
    weight: 561,
    fee,
    status: blockTime ? { confirmed: true, block_height: 800_000, block_hash: txid(1), block_time: blockTime } : { confirmed: false },
  };
}

function stats(funded: number, spent: number, txCount: number) {
  return { funded_txo_count: txCount, funded_txo_sum: funded, spent_txo_count: 0, spent_txo_sum: spent, tx_count: txCount };
}
const ZERO = stats(0, 0, 0);

function addressOf(call: RecordedCall): { address: string; rest: string } | null {
  const m = /\/api\/address\/([^/]+)(.*)$/.exec(call.url.pathname);
  return m ? { address: m[1]!, rest: m[2]! } : null;
}

describe("EsploraProvider — single address", () => {
  const history = [
    tx(3, [[OTHER, 5_000]], [[ME, 1_000], [OTHER, 3_000]], 1_000), // mempool, incoming
    tx(2, [[ME, 50_000_000]], [[OTHER2, 20_000_000], [ME, 29_985_000]], 15_000, 1_710_000_000), // outgoing w/ change
    tx(1, [[OTHER, 60_000_000]], [[ME, 50_000_000], [OTHER, 59_990_000 - 50_000_000]], 10_000, 1_700_000_000), // incoming
  ];

  const handler = (call: RecordedCall) => {
    const a = addressOf(call);
    if (a?.address === ME && a.rest === "") {
      return jsonResponse({ address: ME, chain_stats: stats(79_985_000, 50_000_000, 2), mempool_stats: stats(1_000, 0, 1) });
    }
    if (a?.address === ME && a.rest === "/txs") return jsonResponse(history);
    return jsonResponse({}, 404);
  };

  it("computes the balance from chain + mempool stats in sats and classifies transactions", async () => {
    const f = fakeFetch(handler);
    const provider = new EsploraProvider({ fetchImpl: f, now: () => NOW });
    const snap = await provider.getSnapshot(target(ME));

    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(f.calls[0]!.url.href).toBe(`https://mempool.space/api/address/${ME}`);
    expect(snap.provider).toBe("esplora");
    expect(snap.networksScanned).toEqual(["bitcoin"]);
    expect(snap.holdings).toEqual([
      {
        network: "bitcoin",
        symbol: "BTC",
        name: "Bitcoin",
        contractAddress: null,
        decimals: 8,
        quantity: "0.29986",
        currencyCode: "BTC",
        isStablecoin: false,
      },
    ]);
    expect(snap.transactions).toEqual([
      {
        network: "bitcoin",
        txHash: txid(3),
        logIndex: -1,
        blockTime: NOW.toISOString(),
        symbol: "BTC",
        contractAddress: null,
        pending: true,
        direction: "in",
        quantity: "0.00001",
        counterparty: OTHER,
      },
      {
        network: "bitcoin",
        txHash: txid(2),
        logIndex: -1,
        blockTime: new Date(1_710_000_000_000).toISOString(),
        symbol: "BTC",
        contractAddress: null,
        direction: "out",
        quantity: "0.2",
        feeQuantity: "0.00015",
        feeSymbol: "BTC",
        counterparty: OTHER2,
      },
      {
        network: "bitcoin",
        txHash: txid(1),
        logIndex: -1,
        blockTime: new Date(1_700_000_000_000).toISOString(),
        symbol: "BTC",
        contractAddress: null,
        direction: "in",
        quantity: "0.5",
        counterparty: OTHER,
      },
    ]);
  });

  it("respects maxTransactions and skips history when 0", async () => {
    const f = fakeFetch(handler);
    const snap = await new EsploraProvider({ fetchImpl: f, now: () => NOW }).getSnapshot(target(ME), { maxTransactions: 0 });
    expect(snap.transactions).toEqual([]);
    expect(f.calls).toHaveLength(1);
  });

  it("returns an empty snapshot when bitcoin is not among the requested networks", async () => {
    const f = fakeFetch(handler);
    const snap = await new EsploraProvider({ fetchImpl: f }).getSnapshot(target(ME), { networks: ["ethereum"] });
    expect(snap.networksScanned).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it("follows /txs/chain/{last_txid} pagination", async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => tx(100 + i, [[OTHER, 2_000]], [[ME, 1_000]], 1_000, 1_700_000_000 - i * 600));
    const page2 = Array.from({ length: 5 }, (_, i) => tx(200 + i, [[OTHER, 2_000]], [[ME, 1_000]], 1_000, 1_600_000_000 - i * 600));
    const f = fakeFetch((call) => {
      const a = addressOf(call);
      if (a?.rest === "") return jsonResponse({ chain_stats: stats(30_000, 0, 30), mempool_stats: ZERO });
      if (a?.rest === "/txs") return jsonResponse(page1);
      if (a?.rest === `/txs/chain/${txid(124)}`) return jsonResponse(page2);
      return jsonResponse({}, 404);
    });
    const snap = await new EsploraProvider({ fetchImpl: f, now: () => NOW }).getSnapshot(target(ME), { maxTransactions: 100 });
    expect(snap.transactions).toHaveLength(30);
    expect(f.calls.map((c) => addressOf(c)?.rest)).toEqual(["", "/txs", `/txs/chain/${txid(124)}`]);
    expect(snap.holdings[0]?.quantity).toBe("0.0003");
  });

  it("uses the testnet base URL, tBTC symbol and no currency code for testnet targets", async () => {
    const tb = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";
    const f = fakeFetch(() => jsonResponse({ chain_stats: stats(12_345, 0, 1), mempool_stats: ZERO }));
    const snap = await new EsploraProvider({ fetchImpl: f, now: () => NOW }).getSnapshot(target(tb), { maxTransactions: 0 });
    expect(f.calls[0]!.url.href).toBe(`https://mempool.space/testnet4/api/address/${tb}`);
    expect(snap.holdings[0]).toMatchObject({ symbol: "tBTC", currencyCode: null, quantity: "0.00012345" });
  });
});

describe("EsploraProvider — errors", () => {
  const run = async (fetchImpl: typeof fetch, timeoutMs = 1000) => {
    try {
      await new EsploraProvider({ fetchImpl, timeoutMs }).getSnapshot(target(ME));
    } catch (e) {
      expect(e).toBeInstanceOf(BlockchainProviderError);
      expect((e as Error).message).not.toContain(ME);
      return (e as BlockchainProviderError).code;
    }
    throw new Error("expected failure");
  };

  it("maps HTTP 429 to rate_limited", async () => {
    expect(await run(fakeFetch(() => new Response("Too Many Requests", { status: 429 })))).toBe("rate_limited");
  });

  it("maps malformed JSON and unexpected shapes to invalid_response", async () => {
    expect(await run(fakeFetch(() => new Response("{not json", { status: 200 })))).toBe("invalid_response");
    expect(await run(fakeFetch(() => jsonResponse({ chain_stats: { funded_txo_sum: "abc" } })))).toBe("invalid_response");
    // Negative balance is an inconsistent upstream answer.
    expect(await run(fakeFetch(() => jsonResponse({ chain_stats: stats(1, 5, 1), mempool_stats: ZERO })))).toBe(
      "invalid_response",
    );
  });

  it("times out", async () => {
    expect(await run(hangingFetch(), 20)).toBe("timeout");
  });

  it("refuses non-bitcoin targets", async () => {
    await expect(
      new EsploraProvider({ fetchImpl: fakeFetch(() => jsonResponse({})) }).getSnapshot(
        target("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"),
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("EsploraProvider — xpub gap-limit scan", () => {
  const txA = tx(1, [[OTHER, 2_000_000]], [[ME, 1_000_000], [OTHER, 990_000]], 10_000, 1_700_000_000);
  const txB = tx(2, [[ME, 1_000_000]], [[OTHER2, 400_000], [C0, 590_000]], 10_000, 1_700_100_000);
  const txC = tx(3, [[C0, 590_000]], [[R1, 585_000]], 5_000, 1_700_200_000);
  const used: Record<string, { stats: ReturnType<typeof stats>; txs: unknown[] }> = {
    [ME]: { stats: stats(1_000_000, 1_000_000, 2), txs: [txB, txA] },
    [R1]: { stats: stats(585_000, 0, 1), txs: [txC] },
    [C0]: { stats: stats(590_000, 590_000, 2), txs: [txC, txB] },
  };
  const handler = (call: RecordedCall) => {
    const a = addressOf(call);
    if (!a) return jsonResponse({}, 404);
    const u = used[a.address];
    if (a.rest === "") return jsonResponse({ chain_stats: u?.stats ?? ZERO, mempool_stats: ZERO });
    if (a.rest === "/txs") return jsonResponse(u?.txs ?? []);
    return jsonResponse({}, 404);
  };

  it("derives receive/change addresses until the gap limit and aggregates", async () => {
    const f = fakeFetch(handler);
    const snap = await new EsploraProvider({ fetchImpl: f, gapLimit: 3, now: () => NOW }).getSnapshot(target(ZPUB));
    const lookups = f.calls.filter((c) => addressOf(c)?.rest === "");
    // receive: [0,1,2] then [3,4]; change: [0,1,2] then [3] → 9 lookups.
    expect(lookups).toHaveLength(9);
    expect(lookups.slice(0, 2).map((c) => addressOf(c)?.address)).toEqual([ME, R1]);
    expect(snap.holdings[0]?.quantity).toBe("0.00585");
    expect(snap.unsupportedReasons).toEqual([]);
    // txB appears in two address histories but is reported once; change to C0 is recognised as ours.
    expect(snap.transactions.map((t) => [t.txHash, t.direction, t.quantity, t.feeQuantity])).toEqual([
      [txid(3), "self", "0.00585", "0.00005"],
      [txid(2), "out", "0.004", "0.0001"],
      [txid(1), "in", "0.01", undefined],
    ]);
  });

  it("caps the number of address requests and reports scan_truncated", async () => {
    const f = fakeFetch((call) => {
      const a = addressOf(call);
      if (a?.rest === "") return jsonResponse({ chain_stats: stats(1_000, 0, 1), mempool_stats: ZERO });
      return jsonResponse([]);
    });
    const snap = await new EsploraProvider({ fetchImpl: f, gapLimit: 5, maxAddressRequests: 10 }).getSnapshot(
      target(ZPUB),
      { maxTransactions: 0 },
    );
    expect(f.calls.filter((c) => addressOf(c)?.rest === "")).toHaveLength(10);
    expect(snap.unsupportedReasons).toContain("bitcoin:scan_truncated");
    expect(snap.holdings[0]?.quantity).toBe("0.0001");
  });

  it("scans only the branches of a single-branch descriptor", async () => {
    const xpub =
      "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
    const f = fakeFetch(handler);
    await new EsploraProvider({ fetchImpl: f, gapLimit: 3 }).getSnapshot(target(`wpkh(${xpub}/1/*)`), { maxTransactions: 0 });
    const scanned = f.calls.map((c) => addressOf(c)?.address);
    expect(scanned[0]).toBe(C0);
    expect(scanned).not.toContain(ME);
  });
});

describe("classifyBitcoinTx", () => {
  const ctx = { symbol: "BTC", fetchedAt: NOW.toISOString() };
  const own = new Set([ME, C0]);

  it("does not attribute the fee when only some inputs are ours (CoinJoin-like)", () => {
    const t = classifyBitcoinTx(
      EsploraTxSchema.parse(tx(9, [[ME, 100_000], [OTHER, 100_000]], [[OTHER2, 99_000], [OTHER, 99_000]], 2_000, 1_700_000_000)),
      own,
      ctx,
    );
    expect(t).toMatchObject({ direction: "out", quantity: "0.001" });
    expect(t?.feeQuantity).toBeUndefined();
  });

  it("ignores transactions that do not touch owned addresses", () => {
    expect(classifyBitcoinTx(EsploraTxSchema.parse(tx(10, [[OTHER, 5_000]], [[OTHER2, 4_000]], 1_000, 1)), own, ctx)).toBeNull();
  });
});
