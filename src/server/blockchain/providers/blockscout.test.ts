import { describe, expect, it } from "vitest";
import { detectWatchTarget, type WatchTarget } from "@/domain/crypto/addresses";
import { fakeFetch, hangingFetch, jsonResponse, type RecordedCall } from "../testing/fake-fetch";
import { BlockscoutProvider, isSpamLikeToken } from "./blockscout";

// Public address; every balance / transfer below is fictional.
const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const PEER = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const UNKNOWN = "0x1111111111111111111111111111111111111111";
const SPAM = "0x2222222222222222222222222222222222222222";
const NFT = "0x3333333333333333333333333333333333333333";
const NOW = new Date("2026-10-10T12:00:00.000Z");
const BASE = "https://eth.blockscout.example";

function target(input: string): WatchTarget {
  const r = detectWatchTarget(input);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const token = (address: string, symbol: string | null, decimals: string | null, type = "ERC-20", name = symbol) => ({
  address_hash: address,
  symbol,
  name,
  decimals,
  type,
  holders_count: "10",
  exchange_rate: null,
});

const TOKEN_BALANCES = [
  { token: token(USDC, "USDC", "6"), token_id: null, value: "2500000000" },
  { token: { ...token(UNKNOWN, "FOO", "18"), address_hash: undefined, address: UNKNOWN }, token_id: null, value: "1500000000000000000" },
  { token: token(SPAM, null, null), token_id: null, value: "999999" },
  { token: token(SPAM, "Visit claim-usdc.com", "18"), token_id: null, value: "1000" },
  { token: token(NFT, "PUNK", null, "ERC-721"), token_id: "42", value: "1" },
  { token: token("0x4444444444444444444444444444444444444444", "ZERO", "18"), token_id: null, value: "0" },
];

const TXS_PAGE_1 = {
  items: [
    { hash: hash(1), timestamp: "2025-05-01T10:00:00.000000Z", from: { hash: ADDR }, to: { hash: PEER }, value: "250000000000000000", fee: { type: "actual", value: "21000000000000" }, status: "ok", result: "success" },
    { hash: hash(2), timestamp: "2025-04-01T10:00:00.000000Z", from: { hash: PEER }, to: { hash: ADDR }, value: "1000000000000000000", fee: { type: "actual", value: "21000000000000" }, status: "ok", result: "success" },
    // Address-poisoning style zero-value incoming tx: ignored.
    { hash: hash(3), timestamp: "2025-03-01T10:00:00.000000Z", from: { hash: PEER }, to: { hash: ADDR }, value: "0", fee: { type: "actual", value: "1" }, status: "ok", result: "success" },
  ],
  next_page_params: { block_number: 123, index: 4, items_count: 50 },
};
const TXS_PAGE_2 = {
  items: [
    // Failed outgoing call: value not moved, fee still paid.
    { hash: hash(4), timestamp: "2025-02-01T10:00:00.000000Z", from: { hash: ADDR }, to: { hash: USDC }, value: "5", fee: { type: "actual", value: "30000000000000" }, status: "error", result: "Reverted" },
    { hash: hash(5), timestamp: "2025-01-01T10:00:00.000000Z", from: { hash: ADDR }, to: { hash: ADDR }, value: "7", fee: { type: "actual", value: "1000" }, status: "ok", result: "success" },
  ],
  next_page_params: null,
};
const TRANSFERS = {
  items: [
    { transaction_hash: hash(10), log_index: 7, timestamp: "2025-06-01T10:00:00.000000Z", from: { hash: PEER }, to: { hash: ADDR }, token: token(USDC, "USDC", "6"), total: { decimals: "6", value: "2500000000" }, type: "token_transfer" },
    // Old Blockscout field name tx_hash.
    { tx_hash: hash(11), log_index: "3", timestamp: "2025-06-02T10:00:00.000000Z", from: { hash: ADDR }, to: { hash: PEER }, token: token(UNKNOWN, "FOO", "18"), total: { decimals: "18", value: "500000000000000000" }, type: "token_transfer" },
    { transaction_hash: hash(12), log_index: 1, timestamp: "2025-06-03T10:00:00.000000Z", from: { hash: PEER }, to: { hash: ADDR }, token: token(SPAM, "Visit claim-usdc.com", "18"), total: { decimals: "18", value: "1000" }, type: "token_transfer" },
    { transaction_hash: hash(13), log_index: 2, timestamp: "2025-06-04T10:00:00.000000Z", from: { hash: PEER }, to: { hash: ADDR }, token: token(NFT, "PUNK", null, "ERC-721"), total: { token_id: "42" }, type: "token_minting" },
    { transaction_hash: hash(14), log_index: 5, timestamp: "2025-06-05T10:00:00.000000Z", from: { hash: PEER }, to: { hash: ADDR }, token: token(USDC, "USDC", "6"), total: { decimals: "6", value: "0" }, type: "token_transfer" },
  ],
  next_page_params: null,
};

function handler(call: RecordedCall): Response {
  const p = call.url.pathname;
  if (p === `/api/v2/addresses/${ADDR}`) return jsonResponse({ hash: ADDR, coin_balance: "1500000000000000000", is_contract: false });
  if (p === `/api/v2/addresses/${ADDR}/token-balances`) return jsonResponse(TOKEN_BALANCES);
  if (p === `/api/v2/addresses/${ADDR}/transactions`) {
    return jsonResponse(call.url.searchParams.get("block_number") === "123" ? TXS_PAGE_2 : TXS_PAGE_1);
  }
  if (p === `/api/v2/addresses/${ADDR}/token-transfers`) return jsonResponse(TRANSFERS);
  return jsonResponse({ message: "Not found" }, 404);
}

const provider = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof BlockscoutProvider>[0]> = {}) =>
  new BlockscoutProvider({ baseUrls: { ethereum: BASE }, fetchImpl, now: () => NOW, ...extra });

describe("BlockscoutProvider", () => {
  it("reports native + ERC-20 holdings, excluding NFTs, spam and zero balances", async () => {
    const snap = await provider(fakeFetch(handler)).getSnapshot(target(ADDR), { networks: ["ethereum"] });
    expect(snap.provider).toBe("blockscout");
    expect(snap.holdings).toEqual([
      { network: "ethereum", symbol: "ETH", name: "Ether", contractAddress: null, decimals: 18, quantity: "1.5", currencyCode: "ETH", isStablecoin: false },
      { network: "ethereum", symbol: "FOO", name: "FOO", contractAddress: "0x1111111111111111111111111111111111111111", decimals: 18, quantity: "1.5", currencyCode: null, isStablecoin: false },
      { network: "ethereum", symbol: "USDC", name: "USD Coin", contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, quantity: "2500", currencyCode: "USDC", isStablecoin: true },
    ]);
  });

  it("maps native transactions and ERC-20 transfers (paged) with directions and fees", async () => {
    const f = fakeFetch(handler);
    const snap = await provider(f).getSnapshot(target(ADDR), { networks: ["ethereum"] });
    const rows = snap.transactions.map((t) => [t.txHash, t.logIndex, t.direction, t.symbol, t.quantity, t.feeQuantity ?? null, t.counterparty]);
    expect(rows).toEqual([
      [hash(11), 3, "out", "FOO", "0.5", null, "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"],
      [hash(10), 7, "in", "USDC", "2500", null, "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"],
      [hash(1), -1, "out", "ETH", "0.25", "0.000021", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"],
      [hash(2), -1, "in", "ETH", "1", null, "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"],
      [hash(4), -1, "out", "ETH", "0", "0.00003", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
      [hash(5), -1, "self", "ETH", "0.000000000000000007", "0.000000000000001", null],
    ]);
    // Second page requested with next_page_params; token transfers filtered server-side to ERC-20.
    const txCalls = f.calls.filter((c) => c.url.pathname.endsWith("/transactions"));
    expect(txCalls).toHaveLength(2);
    expect(Object.fromEntries(txCalls[1]!.url.searchParams)).toEqual({ block_number: "123", index: "4", items_count: "50" });
    expect(f.calls.find((c) => c.url.pathname.endsWith("/token-transfers"))!.url.searchParams.get("type")).toBe("ERC-20");
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("sends the API key as a query parameter but never exposes it", async () => {
    const f = fakeFetch((call) => (call.url.pathname.endsWith("/token-balances") ? new Response("", { status: 500 }) : handler(call)));
    const err = await provider(f, { apiKey: "SECRET-KEY" })
      .getSnapshot(target(ADDR), { networks: ["ethereum"] })
      .catch((e: Error) => e);
    expect(f.calls[0]!.url.searchParams.get("apikey")).toBe("SECRET-KEY");
    expect((err as Error).message).not.toContain("SECRET-KEY");
    expect((err as Error).message).not.toContain(ADDR);

    const snap = await provider(fakeFetch(handler), { apiKey: "SECRET-KEY" }).getSnapshot(target(ADDR), { networks: ["ethereum"] });
    expect(JSON.stringify(snap)).not.toContain("SECRET-KEY");
  });

  it("treats a 404 for the address as an empty wallet", async () => {
    const snap = await provider(fakeFetch(() => jsonResponse({ message: "Not found" }, 404))).getSnapshot(target(ADDR), {
      networks: ["ethereum"],
    });
    expect(snap).toMatchObject({ holdings: [], transactions: [], networksScanned: ["ethereum"] });
  });

  it("maps 429, malformed JSON, bad shapes and timeouts", async () => {
    const run = (f: typeof fetch, timeoutMs = 1000) =>
      provider(f, { timeoutMs }).getSnapshot(target(ADDR), { networks: ["ethereum"] });
    await expect(run(fakeFetch(() => new Response("", { status: 429, headers: { "retry-after": "5" } })))).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterSeconds: 5,
    });
    await expect(run(fakeFetch(() => new Response("<html>", { status: 200 })))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(fakeFetch(() => jsonResponse({ coin_balance: "-5" })))).rejects.toMatchObject({ code: "invalid_response" });
    const badTimestamp = fakeFetch((call) =>
      call.url.pathname.endsWith("/transactions")
        ? jsonResponse({ items: [{ ...TXS_PAGE_2.items[1], timestamp: "not-a-date" }], next_page_params: null })
        : handler(call),
    );
    await expect(run(badTimestamp)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(hangingFetch(), 20)).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports unconfigured networks instead of calling them", async () => {
    const f = fakeFetch(handler);
    const snap = await provider(f).getSnapshot(target(ADDR), { networks: ["ethereum", "base"], maxTransactions: 0 });
    expect(snap.unsupportedReasons).toEqual(["base:not_configured"]);
    expect(f.calls.every((c) => c.url.origin === BASE)).toBe(true);
    expect(snap.transactions).toEqual([]);
  });
});

describe("isSpamLikeToken", () => {
  it.each([
    [{ symbol: null, decimals: "18" }, true],
    [{ symbol: "", decimals: "18" }, true],
    [{ symbol: "FOO", decimals: null }, true],
    [{ symbol: "FOO", decimals: "99" }, true],
    [{ symbol: "$ Visit uni-claim.xyz", decimals: "18" }, true],
    [{ symbol: "AIRDROP", name: "Claim your reward at t.me/x", decimals: "0" }, true],
    [{ symbol: "FOO", name: "Foo Token", decimals: "18" }, false],
    [{ symbol: "GUSD", name: "Gemini dollar", decimals: "2" }, false],
  ])("%j → %s", (token, expected) => {
    expect(isSpamLikeToken(token)).toBe(expected);
  });
});
