import { getCurrency } from "@/domain/money/currencies";
import type { ChainFamily } from "./addresses";

/**
 * Supported networks and well-known ERC-20 tokens (mainnets only).
 *
 * Contract addresses are stored EIP-55 checksummed and are verified by
 * `assets.test.ts`. Only addresses known with certainty are listed; tokens
 * deliberately OMITTED because the address could not be confirmed offline:
 * POL and ARB on Ethereum L1, EURC and DAI on Base, WBTC/LINK/UNI on
 * Arbitrum/Optimism/Base and LINK on Polygon. Unknown tokens discovered by an
 * indexer (Blockscout) are still reported, with `currencyCode: null`.
 */

export type NetworkId = "bitcoin" | "ethereum" | "polygon" | "arbitrum" | "optimism" | "base";
export type EvmNetworkId = Exclude<NetworkId, "bitcoin">;

export interface NetworkInfo {
  id: NetworkId;
  family: ChainFamily;
  name: string;
  chainId?: number;
  nativeSymbol: string;
  nativeName: string;
  nativeDecimals: number;
  /** Currency code from currencies.ts for the native asset. */
  nativeCurrencyCode: string;
  explorerUrl: string;
}

export interface TokenInfo {
  network: EvmNetworkId;
  symbol: string;
  name: string;
  /** EIP-55 checksummed. */
  contractAddress: string;
  decimals: number;
  /** Currency code from currencies.ts used for pricing, or null when unknown. */
  currencyCode: string | null;
  isStablecoin: boolean;
}

const NETWORK_LIST: readonly NetworkInfo[] = [
  {
    id: "bitcoin",
    family: "bitcoin",
    name: "Bitcoin",
    nativeSymbol: "BTC",
    nativeName: "Bitcoin",
    nativeDecimals: 8,
    nativeCurrencyCode: "BTC",
    explorerUrl: "https://mempool.space",
  },
  {
    id: "ethereum",
    family: "evm",
    name: "Ethereum",
    chainId: 1,
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeDecimals: 18,
    nativeCurrencyCode: "ETH",
    explorerUrl: "https://etherscan.io",
  },
  {
    id: "polygon",
    family: "evm",
    name: "Polygon PoS",
    chainId: 137,
    nativeSymbol: "POL",
    nativeName: "Polygon Ecosystem Token",
    nativeDecimals: 18,
    nativeCurrencyCode: "POL",
    explorerUrl: "https://polygonscan.com",
  },
  {
    id: "arbitrum",
    family: "evm",
    name: "Arbitrum One",
    chainId: 42161,
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeDecimals: 18,
    nativeCurrencyCode: "ETH",
    explorerUrl: "https://arbiscan.io",
  },
  {
    id: "optimism",
    family: "evm",
    name: "OP Mainnet",
    chainId: 10,
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeDecimals: 18,
    nativeCurrencyCode: "ETH",
    explorerUrl: "https://optimistic.etherscan.io",
  },
  {
    id: "base",
    family: "evm",
    name: "Base",
    chainId: 8453,
    nativeSymbol: "ETH",
    nativeName: "Ether",
    nativeDecimals: 18,
    nativeCurrencyCode: "ETH",
    explorerUrl: "https://basescan.org",
  },
];

export const NETWORKS: readonly NetworkInfo[] = NETWORK_LIST;
export const NETWORK_IDS: readonly NetworkId[] = NETWORK_LIST.map((n) => n.id);
export const EVM_NETWORK_IDS: readonly EvmNetworkId[] = NETWORK_LIST.filter((n) => n.family === "evm").map(
  (n) => n.id as EvmNetworkId,
);

const NETWORK_BY_ID = new Map(NETWORK_LIST.map((n) => [n.id, n]));

export function isNetworkId(value: string): value is NetworkId {
  return NETWORK_BY_ID.has(value as NetworkId);
}

export function isEvmNetworkId(value: string): value is EvmNetworkId {
  return isNetworkId(value) && value !== "bitcoin";
}

export function getNetwork(id: NetworkId): NetworkInfo {
  const n = NETWORK_BY_ID.get(id);
  if (!n) throw new RangeError(`Unknown network: ${id}`);
  return n;
}

export function networksForFamily(family: ChainFamily): NetworkId[] {
  return NETWORK_LIST.filter((n) => n.family === family).map((n) => n.id);
}

function token(
  network: EvmNetworkId,
  symbol: string,
  name: string,
  contractAddress: string,
  decimals: number,
  currencyCode: string | null,
): TokenInfo {
  const currency = currencyCode ? getCurrency(currencyCode) : undefined;
  return {
    network,
    symbol,
    name,
    contractAddress,
    decimals,
    currencyCode: currency ? currency.code : null,
    isStablecoin: currency?.kind === "stablecoin",
  };
}

const TOKEN_LIST: readonly TokenInfo[] = [
  // Ethereum mainnet
  token("ethereum", "USDC", "USD Coin", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "USDC"),
  token("ethereum", "USDT", "Tether USD", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6, "USDT"),
  token("ethereum", "DAI", "Dai Stablecoin", "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18, "DAI"),
  token("ethereum", "EURC", "Euro Coin", "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", 6, "EURC"),
  token("ethereum", "WBTC", "Wrapped BTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8, "WBTC"),
  token("ethereum", "LINK", "ChainLink Token", "0x514910771AF9Ca656af840dff83E8264EcF986CA", 18, "LINK"),
  token("ethereum", "UNI", "Uniswap", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", 18, "UNI"),
  token("ethereum", "WETH", "Wrapped Ether", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18, null),
  // Arbitrum One
  token("arbitrum", "USDC", "USD Coin", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6, "USDC"),
  token("arbitrum", "USDC.e", "Bridged USDC", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", 6, "USDC"),
  token("arbitrum", "USDT", "Tether USD", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6, "USDT"),
  token("arbitrum", "DAI", "Dai Stablecoin", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18, "DAI"),
  token("arbitrum", "ARB", "Arbitrum", "0x912CE59144191C1204E64559FE8253a0e49E6548", 18, "ARB"),
  // OP Mainnet
  token("optimism", "USDC", "USD Coin", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6, "USDC"),
  token("optimism", "USDC.e", "Bridged USDC", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", 6, "USDC"),
  token("optimism", "USDT", "Tether USD", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", 6, "USDT"),
  token("optimism", "DAI", "Dai Stablecoin", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18, "DAI"),
  token("optimism", "OP", "Optimism", "0x4200000000000000000000000000000000000042", 18, "OP"),
  token("optimism", "WETH", "Wrapped Ether", "0x4200000000000000000000000000000000000006", 18, null),
  // Base
  token("base", "USDC", "USD Coin", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, "USDC"),
  token("base", "WETH", "Wrapped Ether", "0x4200000000000000000000000000000000000006", 18, null),
  // Polygon PoS
  token("polygon", "USDC", "USD Coin", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6, "USDC"),
  token("polygon", "USDC.e", "Bridged USDC", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 6, "USDC"),
  token("polygon", "USDT", "Tether USD", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", 6, "USDT"),
  token("polygon", "DAI", "Dai Stablecoin", "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", 18, "DAI"),
  token("polygon", "WBTC", "Wrapped BTC", "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", 8, "WBTC"),
  token("polygon", "WETH", "Wrapped Ether", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", 18, null),
];

export const KNOWN_TOKENS: readonly TokenInfo[] = TOKEN_LIST;

const TOKEN_BY_KEY = new Map(TOKEN_LIST.map((t) => [`${t.network}:${t.contractAddress.toLowerCase()}`, t]));

export function tokensForNetwork(network: NetworkId): TokenInfo[] {
  return TOKEN_LIST.filter((t) => t.network === network);
}

/** Case-insensitive lookup of a known token by contract address. */
export function findKnownToken(network: NetworkId, contractAddress: string): TokenInfo | undefined {
  return TOKEN_BY_KEY.get(`${network}:${contractAddress.toLowerCase()}`);
}

const BITCOIN_TESTNET_EXPLORER = "https://mempool.space/testnet4";

export function explorerAddressUrl(network: NetworkId, address: string, opts: { testnet?: boolean } = {}): string {
  const base = network === "bitcoin" && opts.testnet ? BITCOIN_TESTNET_EXPLORER : getNetwork(network).explorerUrl;
  return `${base}/address/${encodeURIComponent(address)}`;
}

export function explorerTxUrl(network: NetworkId, txHash: string, opts: { testnet?: boolean } = {}): string {
  const base = network === "bitcoin" && opts.testnet ? BITCOIN_TESTNET_EXPLORER : getNetwork(network).explorerUrl;
  return `${base}/tx/${encodeURIComponent(txHash)}`;
}
