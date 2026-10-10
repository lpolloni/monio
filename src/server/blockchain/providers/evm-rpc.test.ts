import { describe, expect, it } from "vitest";
import { detectWatchTarget, type WatchTarget } from "@/domain/crypto/addresses";
import { fakeFetch, hangingFetch, jsonResponse, type RecordedCall } from "../testing/fake-fetch";
import { EvmRpcProvider, assertReadOnlyCall, decodeAbiString } from "./evm-rpc";

// Public address; all balances served below are fictional.
const ADDR = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const LINK_ETH = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function target(input: string): WatchTarget {
  const r = detectWatchTarget(input);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

type RpcBody = { id: number; method: string; params: [{ to: string; data: string }, string] | [string, string] };

function rpcHandler(balances: { native: bigint; tokens: Record<string, bigint> }) {
  return (call: RecordedCall) => {
    const body = call.body as RpcBody;
    if (body.method === "eth_getBalance") return jsonResponse({ jsonrpc: "2.0", id: body.id, result: `0x${balances.native.toString(16)}` });
    if (body.method === "eth_call") {
      const { to } = body.params[0] as { to: string; data: string };
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: word(balances.tokens[to.toLowerCase()] ?? 0n) });
    }
    return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
  };
}

describe("EvmRpcProvider", () => {
  it("reads native + catalog token balances with exact base-unit conversion", async () => {
    const f = fakeFetch(
      rpcHandler({
        native: 2_000_000_000_000_000_001n, // 2.000000000000000001 ETH
        tokens: { [USDC_ETH.toLowerCase()]: 1_234_560_000n, [LINK_ETH.toLowerCase()]: 5n * 10n ** 17n },
      }),
    );
    const provider = new EvmRpcProvider({ rpcUrls: { ethereum: "https://rpc.example.test" }, fetchImpl: f, now: () => NOW });
    const snap = await provider.getSnapshot(target(ADDR));

    expect(snap.provider).toBe("evm-rpc");
    expect(snap.networksScanned).toEqual(["ethereum"]);
    expect(snap.holdings).toEqual([
      { network: "ethereum", symbol: "ETH", name: "Ether", contractAddress: null, decimals: 18, quantity: "2.000000000000000001", currencyCode: "ETH", isStablecoin: false },
      { network: "ethereum", symbol: "LINK", name: "ChainLink Token", contractAddress: LINK_ETH, decimals: 18, quantity: "0.5", currencyCode: "LINK", isStablecoin: false },
      { network: "ethereum", symbol: "USDC", name: "USD Coin", contractAddress: USDC_ETH, decimals: 6, quantity: "1234.56", currencyCode: "USDC", isStablecoin: true },
    ]);
    expect(snap.transactions).toEqual([]);
    expect(snap.unsupportedReasons).toEqual(
      expect.arrayContaining(["ethereum:history_unavailable", "polygon:not_configured", "base:not_configured"]),
    );

    // Every request is a read-only POST with an allowed method / selector.
    for (const call of f.calls) {
      const body = call.body as RpcBody;
      expect(call.method).toBe("POST");
      expect(["eth_getBalance", "eth_call"]).toContain(body.method);
      if (body.method === "eth_call") {
        expect((body.params[0] as { data: string }).data).toBe(`0x70a08231${"0".repeat(24)}${ADDR.slice(2).toLowerCase()}`);
      }
    }
  });

  it("keeps working networks when another one is rate limited", async () => {
    const ok = rpcHandler({ native: 10n ** 18n, tokens: {} });
    const f = fakeFetch((call) => (call.url.host === "polygon.rpc.test" ? new Response("", { status: 429 }) : ok(call)));
    const snap = await new EvmRpcProvider({
      rpcUrls: { base: "https://base.rpc.test", polygon: "https://polygon.rpc.test" },
      fetchImpl: f,
    }).getSnapshot(target(ADDR), { networks: ["base", "polygon"] });
    expect(snap.holdings).toEqual([expect.objectContaining({ network: "base", symbol: "ETH", quantity: "1" })]);
    expect(snap.unsupportedReasons).toContain("polygon:rate_limited");
  });

  it("maps JSON-RPC rate-limit errors, HTTP 429, malformed JSON and timeouts", async () => {
    const run = (fetchImpl: typeof fetch, timeoutMs = 1000) =>
      new EvmRpcProvider({ rpcUrls: { ethereum: "https://rpc.example.test" }, fetchImpl, timeoutMs }).getSnapshot(target(ADDR), {
        networks: ["ethereum"],
      });
    await expect(run(fakeFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "limit exceeded" } })))).rejects.toMatchObject({ code: "rate_limited" });
    await expect(run(fakeFetch(() => new Response("", { status: 429 })))).rejects.toMatchObject({ code: "rate_limited" });
    await expect(run(fakeFetch(() => new Response("not json", { status: 200 })))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(fakeFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: "0xZZ" })))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(fakeFetch(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: `0x${"f".repeat(80)}` })))).rejects.toMatchObject({ code: "invalid_response" });
    await expect(run(hangingFetch(), 20)).rejects.toMatchObject({ code: "timeout" });
  });

  it("reads token metadata via decimals() and symbol()", async () => {
    const abiString = (s: string) => {
      const hex = Buffer.from(s, "utf8").toString("hex");
      return `0x${(32n).toString(16).padStart(64, "0")}${BigInt(s.length).toString(16).padStart(64, "0")}${hex.padEnd(64, "0")}`;
    };
    const f = fakeFetch((call) => {
      const body = call.body as RpcBody;
      const data = (body.params[0] as { data: string }).data;
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: data === "0x313ce567" ? word(6n) : abiString("USDC") });
    });
    const provider = new EvmRpcProvider({ rpcUrls: { ethereum: "https://rpc.example.test" }, fetchImpl: f });
    await expect(provider.fetchTokenMetadata("ethereum", USDC_ETH)).resolves.toEqual({ symbol: "USDC", decimals: 6 });
  });
});

describe("read-only guard", () => {
  it("allows only balance/metadata reads", () => {
    expect(() => assertReadOnlyCall("eth_getBalance", [ADDR, "latest"])).not.toThrow();
    expect(() => assertReadOnlyCall("eth_blockNumber", [])).not.toThrow();
    expect(() => assertReadOnlyCall("eth_call", [{ to: USDC_ETH, data: "0x313ce567" }, "latest"])).not.toThrow();
  });

  it.each([
    ["eth_sendRawTransaction", ["0xf86c..."]],
    ["eth_sendTransaction", [{ from: ADDR, to: ADDR, value: "0x1" }]],
    ["eth_sign", [ADDR, "0xdeadbeef"]],
    ["personal_sign", ["0xdeadbeef", ADDR]],
    // ERC-20 transfer(address,uint256) selector 0xa9059cbb must never be sent, even as a call.
    ["eth_call", [{ to: USDC_ETH, data: `0xa9059cbb${"0".repeat(128)}` }, "latest"]],
    ["eth_call", [{ to: USDC_ETH, data: "0x70a08231", from: ADDR }, "latest"]],
    ["eth_call", [{ to: USDC_ETH, data: `0x70a08231${"0".repeat(24)}${ADDR.slice(2)}`, value: "0x1" }, "latest"]],
  ])("rejects %s", (method, params) => {
    expect(() => assertReadOnlyCall(method, params)).toThrow(TypeError);
  });
});

describe("decodeAbiString", () => {
  it("decodes dynamic strings and legacy bytes32 symbols", () => {
    expect(decodeAbiString(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`)).toBe("MKR");
    expect(decodeAbiString("0x1234")).toBeNull();
  });
});
