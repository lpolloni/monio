import { describe, expect, it } from "vitest";
import { getCurrency } from "@/domain/money/currencies";
import { toChecksumAddress } from "./addresses";
import {
  EVM_NETWORK_IDS,
  KNOWN_TOKENS,
  NETWORKS,
  explorerAddressUrl,
  explorerTxUrl,
  findKnownToken,
  getNetwork,
  isEvmNetworkId,
  networksForFamily,
  tokensForNetwork,
} from "./assets";

describe("network catalog", () => {
  it("lists bitcoin plus five EVM mainnets with unique chain ids", () => {
    expect(NETWORKS.map((n) => n.id)).toEqual(["bitcoin", "ethereum", "polygon", "arbitrum", "optimism", "base"]);
    expect(EVM_NETWORK_IDS).toEqual(["ethereum", "polygon", "arbitrum", "optimism", "base"]);
    const chainIds = NETWORKS.filter((n) => n.family === "evm").map((n) => n.chainId);
    expect(new Set(chainIds).size).toBe(5);
    expect(getNetwork("polygon")).toMatchObject({ chainId: 137, nativeSymbol: "POL" });
    expect(networksForFamily("bitcoin")).toEqual(["bitcoin"]);
    expect(isEvmNetworkId("bitcoin")).toBe(false);
    expect(isEvmNetworkId("base")).toBe(true);
  });

  it("native assets map to catalog currencies", () => {
    for (const n of NETWORKS) expect(getCurrency(n.nativeCurrencyCode)?.decimals).toBe(n.nativeDecimals);
  });

  it("builds explorer links", () => {
    expect(explorerAddressUrl("ethereum", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(
      "https://etherscan.io/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    );
    expect(explorerTxUrl("bitcoin", "ab", { testnet: true })).toBe("https://mempool.space/testnet4/tx/ab");
  });
});

describe("token catalog", () => {
  it("stores every contract address EIP-55 checksummed (guards against typos)", () => {
    for (const t of KNOWN_TOKENS) expect(toChecksumAddress(t.contractAddress)).toBe(t.contractAddress);
  });

  it("has no duplicate (network, contract) or (network, symbol) entries", () => {
    const byContract = new Set(KNOWN_TOKENS.map((t) => `${t.network}:${t.contractAddress.toLowerCase()}`));
    const bySymbol = new Set(KNOWN_TOKENS.map((t) => `${t.network}:${t.symbol}`));
    expect(byContract.size).toBe(KNOWN_TOKENS.length);
    expect(bySymbol.size).toBe(KNOWN_TOKENS.length);
  });

  it("uses currency codes and decimals consistent with currencies.ts", () => {
    for (const t of KNOWN_TOKENS) {
      if (!t.currencyCode) continue;
      const c = getCurrency(t.currencyCode);
      expect(c, t.symbol).toBeDefined();
      expect(t.decimals).toBe(c!.decimals);
      expect(t.isStablecoin).toBe(c!.kind === "stablecoin");
    }
  });

  it("includes the canonical Ethereum mainnet contracts", () => {
    const eth = Object.fromEntries(tokensForNetwork("ethereum").map((t) => [t.symbol, t.contractAddress]));
    expect(eth).toMatchObject({
      USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
      UNI: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      EURC: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c",
    });
  });

  it("finds tokens case-insensitively", () => {
    expect(findKnownToken("base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")?.symbol).toBe("USDC");
    expect(findKnownToken("ethereum", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toBeUndefined();
  });
});
