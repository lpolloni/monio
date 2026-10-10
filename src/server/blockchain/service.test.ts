import { describe, expect, it } from "vitest";
import { detectWatchTarget, type WatchTarget } from "@/domain/crypto/addresses";
import { MOCK_BTC_RECEIVE_0, MOCK_EVM_RICH } from "./providers/fixtures";
import { createBlockchainService } from "./service";
import { fakeFetch, jsonResponse, type RecordedCall } from "./testing/fake-fetch";

const NOW = new Date("2026-10-10T12:00:00.000Z");

function target(input: string): WatchTarget {
  const r = detectWatchTarget(input);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}

describe("createBlockchainService — mock", () => {
  const service = createBlockchainService({ provider: "mock", now: () => NOW });

  it("serves deterministic snapshots for every network", async () => {
    expect(service.provider).toBe("mock");
    expect(service.supportedNetworks()).toEqual(["bitcoin", "ethereum", "polygon", "arbitrum", "optimism", "base"]);
    const snap = await service.snapshot(target(MOCK_BTC_RECEIVE_0));
    expect(snap.holdings[0]?.quantity).toBe("0.0424859");
  });

  it("re-validates targets and refuses forged ones (e.g. secret material in the identifier)", async () => {
    const forged: WatchTarget = {
      family: "bitcoin",
      kind: "address",
      network: "mainnet",
      identifier: "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ",
    };
    await expect(service.snapshot(forged)).rejects.toMatchObject({ code: "unsupported" });
    const mismatched: WatchTarget = { ...target(MOCK_EVM_RICH), family: "bitcoin" };
    await expect(service.snapshot(mismatched)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("normalizes the identifier from the stored target", async () => {
    const lower: WatchTarget = { ...target(MOCK_EVM_RICH), identifier: MOCK_EVM_RICH.toLowerCase() };
    const snap = await service.snapshot(lower, { networks: ["base"] });
    expect(snap.target.identifier).toBe(MOCK_EVM_RICH);
  });
});

describe("createBlockchainService — live routing", () => {
  const ADDR = MOCK_EVM_RICH;

  function liveFetch() {
    return fakeFetch((call: RecordedCall) => {
      const host = call.url.host;
      if (host === "esplora.test") {
        return jsonResponse({
          chain_stats: { funded_txo_count: 1, funded_txo_sum: 1000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
          mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
        });
      }
      if (host === "eth.blockscout.test") {
        if (call.url.pathname.endsWith("/token-balances")) return jsonResponse([]);
        if (call.url.pathname === `/api/v2/addresses/${ADDR}`) return jsonResponse({ coin_balance: "3000000000000000000" });
        return jsonResponse({ items: [], next_page_params: null });
      }
      if (host === "base.rpc.test") {
        const body = call.body as { id: number; method: string };
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x" });
      }
      if (host === "polygon.rpc.test") return new Response("", { status: 429 });
      return new Response("unexpected host", { status: 500 });
    });
  }

  it("routes bitcoin to Esplora", async () => {
    const f = liveFetch();
    const service = createBlockchainService({ provider: "live", bitcoinApiUrl: "https://esplora.test/api", fetchImpl: f, now: () => NOW });
    const snap = await service.snapshot(target(MOCK_BTC_RECEIVE_0), { maxTransactions: 0 });
    expect(service.provider).toBe("live");
    expect(snap.provider).toBe("esplora");
    expect(snap.holdings[0]?.quantity).toBe("0.00001");
    expect(f.calls.every((c) => c.url.host === "esplora.test")).toBe(true);
  });

  it("routes EVM networks to Blockscout when configured and JSON-RPC otherwise, tolerating partial failures", async () => {
    const f = liveFetch();
    const service = createBlockchainService({
      provider: "live",
      blockscoutUrls: { ethereum: "https://eth.blockscout.test" },
      evmRpcUrls: { base: "https://base.rpc.test", polygon: "https://polygon.rpc.test" },
      apiKey: "SECRET-KEY",
      fetchImpl: f,
      now: () => NOW,
    });
    const snap = await service.snapshot(target(ADDR), { networks: ["ethereum", "base", "polygon"] });
    expect(snap.provider).toBe("blockscout+evm-rpc");
    expect(snap.holdings.map((h) => [h.network, h.symbol, h.quantity])).toEqual([
      ["base", "ETH", "1"],
      ["ethereum", "ETH", "3"],
    ]);
    expect(snap.networksScanned.sort()).toEqual(["base", "ethereum"]);
    expect(snap.unsupportedReasons).toEqual(expect.arrayContaining(["polygon:rate_limited", "base:history_unavailable"]));
    expect(new Set(f.calls.map((c) => c.url.host))).toEqual(new Set(["eth.blockscout.test", "base.rpc.test", "polygon.rpc.test"]));
    expect(JSON.stringify(snap)).not.toContain("SECRET-KEY");
  });

  it("throws when every routed network fails", async () => {
    const service = createBlockchainService({
      provider: "live",
      evmRpcUrls: { polygon: "https://polygon.rpc.test" },
      fetchImpl: liveFetch(),
    });
    await expect(service.snapshot(target(ADDR), { networks: ["polygon"] })).rejects.toMatchObject({ code: "rate_limited" });
  });
});
