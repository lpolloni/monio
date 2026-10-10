import { describe, expect, it } from "vitest";
import {
  detectSecretMaterial,
  detectWatchTarget,
  hasValidEvmChecksum,
  shortenAddress,
  toChecksumAddress,
  type WatchTargetResult,
} from "./addresses";
import { descriptorChecksum, verifyDescriptorChecksum } from "./descriptors";

// All values below are PUBLIC test vectors (BIP-32/44/49/84/173/350/380, EIP-55,
// Bitcoin wiki examples). None of them hold anyone's funds.

/** BIP-84 test vector account 0 (mnemonic "abandon ×11 about"). */
const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
/** Same account key serialized with the plain xpub version (as used in descriptors). */
const BIP84_ACCOUNT_XPUB =
  "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
const BIP49_YPUB =
  "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP";
const BIP44_XPUB =
  "xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj";
const BIP49_UPUB =
  "upub5EFU65HtV5TeiSHmZZm7FUffBGy8UKeqp7vw43jYbvZPpoVsgU93oac7Wk3u6moKegAEWtGNF8DehrnHtv21XXEMYRUocHqguyjknFHYfgY";
const BIP84_VPUB =
  "vpub5Y6cjg78GGuNLsaPhmYsiw4gYX3HoQiRBiSwDaBXKUafCt9bNwWQiitDk5VZ5BVxYnQdwoTyXSs2JHRPAgjAvtbBrf8ZhDYe2jWAqvZVnsc";
const BIP44_TPUB =
  "tpubDC5FSnBiZDMmhiuCmWAYsLwgLYrrT9rAqvTySfuCCrgsWz8wxMXUS9Tb9iVMvcRbvFcAHGkMD5Kx8koh4GquNGNTfohfk7pgjhaPCdXpoba";
/** BIP-32 test vector 1 master keys (seed 000102…0f). */
const BIP32_TV1_XPUB =
  "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8";
const BIP32_TV1_XPRV =
  "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";

function target(result: WatchTargetResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.target;
}
const errorOf = (input: string) => {
  const r = detectWatchTarget(input);
  return r.ok ? "ok" : r.error;
};

describe("detectWatchTarget — bitcoin addresses", () => {
  it.each([
    ["1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "p2pkh", "mainnet"],
    ["1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA", "p2pkh", "mainnet"],
    ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "p2sh", "mainnet"],
    ["37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf", "p2sh", "mainnet"],
    ["mkpZhYtJu2r87Js3pDiWJDmPte2NRZ8bJV", "p2pkh", "testnet"],
    ["2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2", "p2sh", "testnet"],
    ["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "p2wpkh", "mainnet"],
    ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "p2wpkh", "mainnet"],
    ["bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3", "p2wsh", "mainnet"],
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "p2tr", "mainnet"],
    ["tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl", "p2wpkh", "testnet"],
    ["tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7", "p2wsh", "testnet"],
  ])("accepts %s as %s on %s", (input, addressType, network) => {
    const t = target(detectWatchTarget(input));
    expect(t).toMatchObject({ family: "bitcoin", kind: "address", addressType, network, identifier: input });
  });

  it("normalizes uppercase bech32 to lowercase", () => {
    const t = target(detectWatchTarget("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4"));
    expect(t.identifier).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  });

  it("strips BIP-21 URIs and surrounding whitespace", () => {
    const t = target(detectWatchTarget("  bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=0.1  "));
    expect(t.identifier).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it.each([
    ["1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", "bad base58 checksum"],
    ["3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz", "bad base58 checksum (p2sh)"],
    ["bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv", "bad bech32 checksum"],
    ["bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "mixed case bech32"],
    // BIP-350: taproot program encoded with bech32 (not bech32m) is invalid.
    ["bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", "v1 with bech32 checksum"],
    // BIP-350: v0 program encoded with bech32m is invalid.
    ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh", "v0 with bech32m checksum"],
    ["bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", "v2 future version (unsupported)"],
    ["ltc1qg82xyhmhx5qkmrmlyd7ezmrsq7ljl0vgunjf8m", "foreign hrp"],
    ["bc1q", "too short"],
    ["hello world", "free text"],
    ["0x123", "short hex"],
  ])("rejects %s (%s)", (input) => {
    expect(["invalid", "unsupported"]).toContain(errorOf(input));
  });

  it("marks future segwit versions and regtest as unsupported rather than invalid", () => {
    expect(errorOf("bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs")).toBe("unsupported");
    expect(errorOf("bcrt1qs758ursh4q9z627kt3pp5yysm78ddny6txaqgw")).toBe("unsupported");
  });

  it("returns empty for blank input", () => {
    expect(errorOf("")).toBe("empty");
    expect(errorOf("   \n ")).toBe("empty");
  });
});

describe("detectWatchTarget — EVM", () => {
  // EIP-55 specification test vectors.
  const EIP55 = [
    "0x52908400098527886E0F7030069857D2E4169EE7",
    "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    "0xde709f2102306220921060314715629080e2fb77",
    "0x27b1fdb04752bbc536007a920d24acb045561c26",
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];

  it.each(EIP55.slice(4))("checksums %s exactly as EIP-55", (addr) => {
    expect(toChecksumAddress(addr.toLowerCase())).toBe(addr);
    expect(toChecksumAddress(addr.toUpperCase().replace("0X", "0x"))).toBe(addr);
    expect(hasValidEvmChecksum(addr)).toBe(true);
  });

  it.each(EIP55)("accepts %s and returns the checksummed identifier", (addr) => {
    const t = target(detectWatchTarget(addr));
    expect(t).toMatchObject({ family: "evm", kind: "address", addressType: "evm", network: "mainnet" });
    expect(t.identifier).toBe(toChecksumAddress(addr));
  });

  it("accepts lowercase input and checksums it", () => {
    const t = target(detectWatchTarget("0xd8da6bf26964af9d7eed9e03e53415d37aa96045"));
    expect(t.identifier).toBe("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });

  it("rejects a mixed-case address with a wrong checksum", () => {
    expect(errorOf("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toBe("invalid");
    expect(hasValidEvmChecksum("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toBe(false);
  });

  it("rejects wrong lengths / non-hex and flags ENS names as unsupported", () => {
    expect(errorOf("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeA")).toBe("invalid");
    expect(errorOf("0xZZAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe("invalid");
    expect(errorOf("vitalik.eth")).toBe("unsupported");
  });

  it("toChecksumAddress throws on malformed input", () => {
    expect(() => toChecksumAddress("0x1234")).toThrow(TypeError);
  });
});

describe("detectWatchTarget — extended public keys", () => {
  it.each([
    [BIP84_ZPUB, "zpub", "p2wpkh", "mainnet"],
    [BIP49_YPUB, "ypub", "p2sh", "mainnet"],
    [BIP44_XPUB, "xpub", "p2pkh", "mainnet"],
    [BIP32_TV1_XPUB, "xpub", "p2pkh", "mainnet"],
    [BIP84_VPUB, "vpub", "p2wpkh", "testnet"],
    [BIP49_UPUB, "upub", "p2sh", "testnet"],
    [BIP44_TPUB, "tpub", "p2pkh", "testnet"],
  ])("accepts %s", (input, xpubType, addressType, network) => {
    const t = target(detectWatchTarget(input));
    expect(t).toMatchObject({ family: "bitcoin", kind: "xpub", xpubType, addressType, network, identifier: input });
  });

  it("rejects an xpub with a corrupted checksum", () => {
    expect(errorOf(`${BIP84_ZPUB.slice(0, -1)}t`)).toBe("invalid");
  });
});

describe("detectWatchTarget — output descriptors", () => {
  const body = `wpkh([73c5da0a/84h/0h/0h]${BIP84_ACCOUNT_XPUB}/<0;1>/*)`;

  it("implements the BIP-380 checksum (spec + Bitcoin Core doc vectors)", () => {
    expect(descriptorChecksum("raw(deadbeef)")).toBe("89f8spxm");
    expect(verifyDescriptorChecksum("raw(deadbeef)", "89f8spxm")).toBe(true);
    expect(verifyDescriptorChecksum("raw(deedbeef)", "89f8spxm")).toBe(false);
    expect(
      descriptorChecksum(
        "wpkh([d34db33f/84h/0h/0h]xpub6DJ2dNUysrn5Vt36jH2KLBT2i1auw1tTSSomg8PhqNiUtx8QX2SvC9nrHu81fT41fvDUnhMjEzQgXnQjKEu3oaqMSzhSrHMxyyoEAmUHQbY/0/*)",
      ),
    ).toBe("cjjspncu");
    expect(descriptorChecksum("raw(Ü)")).toBeNull();
  });

  it("parses a multipath wpkh descriptor and appends the checksum", () => {
    const t = target(detectWatchTarget(body));
    const checksum = descriptorChecksum(body);
    expect(t).toMatchObject({
      family: "bitcoin",
      kind: "descriptor",
      network: "mainnet",
      addressType: "p2wpkh",
      xpubType: "xpub",
      identifier: `${body}#${checksum}`,
    });
    expect(t.descriptor).toEqual({
      script: "wpkh",
      extendedKey: BIP84_ACCOUNT_XPUB,
      origin: "[73c5da0a/84h/0h/0h]",
      branches: [0, 1],
      checksum,
    });
  });

  it("accepts a correct checksum and rejects a wrong one", () => {
    const checksum = descriptorChecksum(body)!;
    expect(errorOf(`${body}#${checksum}`)).toBe("ok");
    expect(errorOf(`${body}#qqqqqqqq`)).toBe("invalid");
  });

  it("parses pkh and sh(wpkh) single-branch descriptors", () => {
    expect(target(detectWatchTarget(`pkh(${BIP44_XPUB}/0/*)`))).toMatchObject({
      addressType: "p2pkh",
      descriptor: { script: "pkh", branches: [0], origin: null },
    });
    expect(target(detectWatchTarget(`sh(wpkh(${BIP44_XPUB}/1/*))`))).toMatchObject({
      addressType: "p2sh",
      descriptor: { script: "sh-wpkh", branches: [1] },
    });
  });

  it("maps addr() to a plain address target", () => {
    expect(target(detectWatchTarget("addr(bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu)")).kind).toBe("address");
  });

  it.each([
    [`tr(${BIP44_XPUB}/0/*)`, "taproot derivation"],
    [`wsh(multi(1,${BIP44_XPUB}/0/*,${BIP49_YPUB}/0/*))`, "multisig"],
    [`wpkh(${BIP44_XPUB}/0h/*)`, "hardened step"],
    [`wpkh(${BIP44_XPUB})`, "non-ranged"],
    ["wpkh(0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c)", "single hex pubkey"],
  ])("returns unsupported for %s (%s)", (input) => {
    expect(errorOf(input)).toBe("unsupported");
  });

  it("rejects a descriptor embedding a corrupted xpub", () => {
    expect(errorOf(`wpkh(${BIP44_XPUB.slice(0, -1)}k/0/*)`)).toBe("invalid");
  });
});

describe("detectWatchTarget — SECURITY: secret material is detected, never accepted", () => {
  it("flags the Bitcoin-wiki example WIF (uncompressed) as private_key_detected", () => {
    expect(errorOf("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ")).toBe("private_key_detected");
  });

  it("flags compressed WIF keys (K/L prefixes) as private_key_detected", () => {
    // BIP-84 test vector m/84'/0'/0'/0/0 private key — public test data.
    expect(errorOf("KyZpNDKnfs94vbrwhJneDi77V6jF64PWPF8x5cdJb8ifgg2DUc9d")).toBe("private_key_detected");
  });

  it("flags an xprv (valid or corrupted) as private_key_detected", () => {
    expect(errorOf(BIP32_TV1_XPRV)).toBe("private_key_detected");
    expect(errorOf(`${BIP32_TV1_XPRV.slice(0, -1)}j`)).toBe("private_key_detected");
    expect(errorOf(`zprv${BIP32_TV1_XPRV.slice(4)}`)).toBe("private_key_detected");
  });

  it("flags an xprv embedded in a descriptor", () => {
    expect(errorOf(`wpkh([73c5da0a/84h/0h/0h]${BIP32_TV1_XPRV}/0/*)`)).toBe("private_key_detected");
  });

  it("flags 64-hex raw private keys with or without 0x", () => {
    const hex = "0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d";
    expect(errorOf(hex)).toBe("private_key_detected");
    expect(errorOf(`0x${hex}`)).toBe("private_key_detected");
    expect(errorOf(hex.toUpperCase())).toBe("private_key_detected");
    expect(errorOf(`my key is 0x${hex} please track it`)).toBe("private_key_detected");
  });

  it("flags BIP-38 encrypted keys and Ethereum keystore JSON", () => {
    expect(errorOf("6PRVWUbkzzsbcVac2qwfssoUJAN1Xhrg6bNk8J7Nzm5H7kxEbn2Nh2ZoGg")).toBe("private_key_detected");
    expect(errorOf('{"version":3,"crypto":{"ciphertext":"abc","cipher":"aes-128-ctr"}}')).toBe(
      "private_key_detected",
    );
  });

  it("flags a 12-word phrase as seed_phrase_detected", () => {
    expect(
      errorOf("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"),
    ).toBe("seed_phrase_detected");
  });

  it("flags 24-word, multi-line, numbered and capitalized phrases", () => {
    const words = Array.from({ length: 23 }, () => "zoo").concat("wrong");
    expect(errorOf(words.join(" "))).toBe("seed_phrase_detected");
    expect(errorOf(words.slice(0, 12).join("\n"))).toBe("seed_phrase_detected");
    expect(errorOf(words.slice(0, 15).map((w, i) => `${i + 1}. ${w}`).join(" "))).toBe("seed_phrase_detected");
    expect(errorOf(words.slice(0, 18).map((w) => w.toUpperCase()).join(" "))).toBe("seed_phrase_detected");
  });

  it("does not flag short word lists as seed phrases", () => {
    expect(errorOf("my bitcoin wallet")).toBe("invalid");
  });

  it("detectSecretMaterial returns null for valid watch targets", () => {
    for (const input of [
      BIP84_ZPUB,
      BIP44_XPUB,
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
      "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
    ]) {
      expect(detectSecretMaterial(input)).toBeNull();
    }
  });
});

describe("shortenAddress", () => {
  it("shortens EVM, bech32, xpub and descriptor identifiers", () => {
    expect(shortenAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe("0xd8dA…6045");
    expect(shortenAddress("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")).toBe("bc1qcr…6fyu");
    expect(shortenAddress(BIP84_ZPUB)).toBe("zpub6r…tZYs");
    expect(shortenAddress(`sh(wpkh([73c5da0a/49h/0h/0h]${BIP44_XPUB}/0/*))#abcdefgh`)).toBe("sh(wpkh(xpub6B…nMdj))");
  });

  it("leaves short strings untouched", () => {
    expect(shortenAddress("abc")).toBe("abc");
  });
});
