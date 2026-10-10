import { describe, expect, it } from "vitest";
import { deriveAddressesFromXpub, detectWatchTarget, isEvmAddressFormat, toChecksumAddress, type WatchTarget } from "@/domain/crypto/addresses";
import { dec, isDecimalString } from "@/domain/money/decimal";
import {
  MOCK_BIP84_ACCOUNT_XPUB,
  MOCK_BIP84_ZPUB,
  MOCK_BTC_RECEIVE_0,
  MOCK_EVM_EMPTY,
  MOCK_EVM_RICH,
} from "./fixtures";
import { MockChainProvider, holdingsFromTransactions } from "./mock";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const provider = new MockChainProvider({ now: () => NOW });

function target(input: string): WatchTarget {
  const r = detectWatchTarget(input);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}

const quantities = (snap: { holdings: { network: string; symbol: string; quantity: string }[] }) =>
  Object.fromEntries(snap.holdings.map((h) => [`${h.network}:${h.symbol}`, h.quantity]));

describe("MockChainProvider — fixtures", () => {
  it("returns the fixed BTC fixture for the BIP-84 receive address", async () => {
    const snap = await provider.getSnapshot(target(MOCK_BTC_RECEIVE_0));
    expect(snap).toMatchObject({ provider: "mock", fetchedAt: NOW.toISOString(), networksScanned: ["bitcoin"], unsupportedReasons: [] });
    expect(quantities(snap)).toEqual({ "bitcoin:BTC": "0.0424859" });
    expect(snap.holdings[0]).toMatchObject({ currencyCode: "BTC", decimals: 8, contractAddress: null });
    expect(snap.transactions.map((t) => [t.direction, t.quantity, t.feeQuantity ?? null])).toEqual([
      ["out", "0.02", "0.0000141"],
      ["in", "0.0125", null],
      ["in", "0.05", null],
    ]);
  });

  it("aggregates derived addresses for the controlled zpub and the equivalent descriptor", async () => {
    const zpub = await provider.getSnapshot(target(MOCK_BIP84_ZPUB));
    expect(quantities(zpub)).toEqual({ "bitcoin:BTC": "0.0529859" });
    expect(zpub.transactions).toHaveLength(5);
    const desc = await provider.getSnapshot(target(`wpkh([73c5da0a/84h/0h/0h]${MOCK_BIP84_ACCOUNT_XPUB}/<0;1>/*)`));
    expect(quantities(desc)).toEqual(quantities(zpub));
  });

  it("returns multi-network EVM fixture balances and filters zero-balance tokens", async () => {
    const snap = await provider.getSnapshot(target(MOCK_EVM_RICH));
    expect(snap.networksScanned).toEqual(["ethereum", "polygon", "arbitrum", "optimism", "base"]);
    expect(quantities(snap)).toEqual({
      "arbitrum:ARB": "180",
      "base:ETH": "0.15",
      "base:USDC": "320.75",
      "ethereum:ETH": "2.09903",
      "ethereum:LINK": "42.5",
      "ethereum:USDC": "1250",
    });
    const usdc = snap.holdings.find((h) => h.network === "ethereum" && h.symbol === "USDC");
    expect(usdc).toMatchObject({ contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", isStablecoin: true, currencyCode: "USDC" });
  });

  it("returns an empty snapshot for the empty fixture", async () => {
    const snap = await provider.getSnapshot(target(MOCK_EVM_EMPTY));
    expect(snap.holdings).toEqual([]);
    expect(snap.transactions).toEqual([]);
  });

  it("honours networks and maxTransactions", async () => {
    const snap = await provider.getSnapshot(target(MOCK_EVM_RICH), { networks: ["base"], maxTransactions: 1 });
    expect(snap.networksScanned).toEqual(["base"]);
    expect(quantities(snap)).toEqual({ "base:ETH": "0.15", "base:USDC": "320.75" });
    expect(snap.transactions).toHaveLength(1);
    expect(snap.transactions[0]?.symbol).toBe("USDC");
  });
});

describe("MockChainProvider — seeded generation", () => {
  const btcAddresses = deriveAddressesFromXpub(MOCK_BIP84_ZPUB, { change: 0, start: 100, count: 15 }).map((a) => a.address);
  const evmAddresses = Array.from({ length: 10 }, (_, i) => toChecksumAddress(`0x${(i + 1).toString(16).padStart(40, "7")}`));

  it("is deterministic for the same input", async () => {
    for (const addr of [btcAddresses[0]!, evmAddresses[0]!]) {
      const a = await provider.getSnapshot(target(addr));
      const b = await new MockChainProvider({ now: () => NOW }).getSnapshot(target(addr));
      expect(b).toEqual(a);
    }
  });

  it("produces different data for different addresses", async () => {
    const snaps = await Promise.all(evmAddresses.map((a) => provider.getSnapshot(target(a))));
    expect(new Set(snaps.map((s) => JSON.stringify(s.holdings))).size).toBeGreaterThan(5);
  });

  it("keeps holdings consistent with transactions, non-negative and in decimal strings", async () => {
    let withHoldings = 0;
    for (const addr of [...btcAddresses, ...evmAddresses]) {
      const snap = await provider.getSnapshot(target(addr), { maxTransactions: 500 });
      expect(snap.holdings).toEqual(holdingsFromTransactions(snap.transactions));
      if (snap.holdings.length > 0) withHoldings++;
      for (const h of snap.holdings) {
        expect(isDecimalString(h.quantity)).toBe(true);
        expect(dec(h.quantity).greaterThan(0)).toBe(true);
        expect(dec(h.quantity).decimalPlaces()).toBeLessThanOrEqual(h.decimals);
      }
      for (const t of snap.transactions) {
        expect(isDecimalString(t.quantity)).toBe(true);
        expect(Date.parse(t.blockTime)).toBeLessThan(NOW.getTime());
        if (t.network !== "bitcoin") {
          expect(t.txHash).toMatch(/^0x[0-9a-f]{64}$/);
          expect(t.counterparty && isEvmAddressFormat(t.counterparty)).toBe(true);
        } else {
          expect(t.txHash).toMatch(/^[0-9a-f]{64}$/);
          expect(detectWatchTarget(t.counterparty ?? "").ok).toBe(true);
        }
      }
    }
    expect(withHoldings).toBeGreaterThan(10);
  });

  it("uses tBTC without a currency code for testnet targets", async () => {
    const snaps = await Promise.all(
      deriveAddressesFromXpub(
        "vpub5Y6cjg78GGuNLsaPhmYsiw4gYX3HoQiRBiSwDaBXKUafCt9bNwWQiitDk5VZ5BVxYnQdwoTyXSs2JHRPAgjAvtbBrf8ZhDYe2jWAqvZVnsc",
        { change: 0, count: 6 },
      ).map((a) => provider.getSnapshot(target(a.address))),
    );
    const holding = snaps.flatMap((s) => s.holdings)[0];
    expect(holding).toMatchObject({ symbol: "tBTC", currencyCode: null });
  });

  it("supports an uncontrolled xpub by aggregating seeded derived addresses", async () => {
    const xpub =
      "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";
    const a = await provider.getSnapshot(target(xpub), { maxTransactions: 500 });
    expect(a).toEqual(await provider.getSnapshot(target(xpub), { maxTransactions: 500 }));
    expect(a.holdings).toEqual(holdingsFromTransactions(a.transactions));
    expect(a.transactions.every((t) => t.network === "bitcoin")).toBe(true);
  });

  it("rejects aborted requests", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider.getSnapshot(target(MOCK_EVM_RICH), { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  });
});
