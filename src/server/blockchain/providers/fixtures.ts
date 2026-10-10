import type { NetworkId } from "@/domain/crypto/assets";

/**
 * Deterministic fixtures for the mock chain provider.
 *
 * The ADDRESSES / KEYS are well-known PUBLIC values (BIP-84 test-vector keys
 * derived from the "abandon ×11 about" test mnemonic, the EIP-55 example
 * address, and a widely published Ethereum address). Every BALANCE,
 * TRANSACTION and COUNTERPARTY below is FICTIONAL and does not reflect
 * on-chain reality. Holdings are derived from these transactions
 * (in − out − fees), so a fixture is always internally consistent.
 */

export interface FixtureTransaction {
  network: NetworkId;
  /** Fixed ISO timestamp. */
  time: string;
  direction: "in" | "out" | "self";
  symbol: string;
  quantity: string;
  /** Fee in the network's native coin, when paid by the watched target. */
  fee?: string;
  counterparty: string | null;
  /** Token transfers get a log index; native movements use -1. */
  logIndex?: number;
}

export interface MockFixture {
  label: string;
  transactions: FixtureTransaction[];
}

/** BIP-84 test vector account 0 (public test data). */
export const MOCK_BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
/** The same account key serialized as a plain xpub (for descriptors). */
export const MOCK_BIP84_ACCOUNT_XPUB =
  "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
/** m/84'/0'/0'/0/0, 0/1 and 1/0 of the BIP-84 test vector. */
export const MOCK_BTC_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
export const MOCK_BTC_RECEIVE_1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
export const MOCK_BTC_CHANGE_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
/** Publicly known Ethereum address; fixture data is fictional. */
export const MOCK_EVM_RICH = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
/** EIP-55 example address, used as the "empty wallet" fixture. */
export const MOCK_EVM_EMPTY = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/**
 * Extended keys whose derived addresses WITHOUT a fixture are reported empty
 * (instead of seeded-random), so their aggregate snapshot is fully predictable.
 */
export const MOCK_CONTROLLED_EXTENDED_KEYS: ReadonlySet<string> = new Set([MOCK_BIP84_ZPUB, MOCK_BIP84_ACCOUNT_XPUB]);

// Fictional counterparties: public spec example addresses (BIP-173, Bitcoin wiki, EIP-55).
const BTC_PEER_A = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const BTC_PEER_B = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const EVM_PEER_A = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const EVM_PEER_B = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
const EVM_PEER_C = "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb";

export const MOCK_FIXTURES: Readonly<Record<string, MockFixture>> = {
  [MOCK_BTC_RECEIVE_0]: {
    label: "BIP-84 receive #0",
    // Balance: 0.05 + 0.0125 − 0.02 − 0.0000141 = 0.0424859 BTC
    transactions: [
      { network: "bitcoin", time: "2025-01-15T10:20:00.000Z", direction: "in", symbol: "BTC", quantity: "0.05", counterparty: BTC_PEER_A },
      { network: "bitcoin", time: "2025-03-02T08:00:00.000Z", direction: "in", symbol: "BTC", quantity: "0.0125", counterparty: BTC_PEER_B },
      {
        network: "bitcoin",
        time: "2025-06-20T18:45:00.000Z",
        direction: "out",
        symbol: "BTC",
        quantity: "0.02",
        fee: "0.0000141",
        counterparty: BTC_PEER_B,
      },
    ],
  },
  [MOCK_BTC_RECEIVE_1]: {
    label: "BIP-84 receive #1",
    transactions: [
      { network: "bitcoin", time: "2025-08-11T12:00:00.000Z", direction: "in", symbol: "BTC", quantity: "0.003", counterparty: BTC_PEER_A },
    ],
  },
  [MOCK_BTC_CHANGE_0]: {
    label: "BIP-84 change #0",
    transactions: [
      { network: "bitcoin", time: "2025-09-01T09:30:00.000Z", direction: "in", symbol: "BTC", quantity: "0.0075", counterparty: BTC_PEER_A },
    ],
  },
  [MOCK_EVM_RICH]: {
    label: "Multi-network EVM wallet",
    // ethereum ETH: 2.5 − 0.4 − 0.00042 − 0.0003 − 0.00025 = 2.09903; USDC 1250; LINK 42.5; DAI 0 (filtered)
    // base: ETH 0.15, USDC 320.75 — arbitrum: ARB 180
    transactions: [
      { network: "ethereum", time: "2024-11-05T14:00:00.000Z", direction: "in", symbol: "ETH", quantity: "2.5", counterparty: EVM_PEER_A },
      {
        network: "ethereum",
        time: "2025-01-20T09:15:00.000Z",
        direction: "out",
        symbol: "ETH",
        quantity: "0.4",
        fee: "0.00042",
        counterparty: EVM_PEER_B,
      },
      { network: "ethereum", time: "2025-02-10T16:30:00.000Z", direction: "in", symbol: "USDC", quantity: "1500", counterparty: EVM_PEER_C, logIndex: 12 },
      {
        network: "ethereum",
        time: "2025-04-01T11:05:00.000Z",
        direction: "out",
        symbol: "USDC",
        quantity: "250",
        fee: "0.0003",
        counterparty: EVM_PEER_A,
        logIndex: 7,
      },
      { network: "ethereum", time: "2025-05-12T07:45:00.000Z", direction: "in", symbol: "LINK", quantity: "42.5", counterparty: EVM_PEER_B, logIndex: 33 },
      { network: "ethereum", time: "2025-07-01T13:00:00.000Z", direction: "in", symbol: "DAI", quantity: "100", counterparty: EVM_PEER_C, logIndex: 4 },
      {
        network: "ethereum",
        time: "2025-07-15T19:20:00.000Z",
        direction: "out",
        symbol: "DAI",
        quantity: "100",
        fee: "0.00025",
        counterparty: EVM_PEER_C,
        logIndex: 9,
      },
      { network: "base", time: "2025-03-03T10:00:00.000Z", direction: "in", symbol: "ETH", quantity: "0.15", counterparty: EVM_PEER_A },
      { network: "base", time: "2025-03-04T10:00:00.000Z", direction: "in", symbol: "USDC", quantity: "320.75", counterparty: EVM_PEER_B, logIndex: 2 },
      { network: "arbitrum", time: "2025-02-20T21:10:00.000Z", direction: "in", symbol: "ARB", quantity: "180", counterparty: EVM_PEER_C, logIndex: 15 },
    ],
  },
  [MOCK_EVM_EMPTY]: { label: "Empty wallet", transactions: [] },
};
