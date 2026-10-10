import { describe, expect, it } from "vitest";
import {
  deriveAddressesFromXpub,
  deriveWatchTargetAddresses,
  detectWatchTarget,
  watchTargetBranches,
  type WatchTarget,
} from "./addresses";

// PUBLIC test vectors derived from the BIP-39 test mnemonic "abandon ×11 about".
// Expected addresses are the values published in BIP-84 / BIP-49 / BIP-44 test
// vectors; they hold no one's funds.
const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
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

function t(input: string): WatchTarget {
  const r = detectWatchTarget(input);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}

describe("deriveAddressesFromXpub", () => {
  it("matches the BIP-84 test vector (zpub → P2WPKH)", () => {
    const receive = deriveAddressesFromXpub(BIP84_ZPUB, { change: 0, start: 0, count: 2 });
    expect(receive.map((a) => a.address)).toEqual([
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", // m/84'/0'/0'/0/0
      "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g", // m/84'/0'/0'/0/1
    ]);
    expect(receive[0]).toMatchObject({ change: 0, index: 0, addressType: "p2wpkh" });
    const change = deriveAddressesFromXpub(BIP84_ZPUB, { change: 1, start: 0, count: 1 });
    expect(change[0]?.address).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"); // m/84'/0'/0'/1/0
  });

  it("supports a start offset", () => {
    const [second] = deriveAddressesFromXpub(BIP84_ZPUB, { change: 0, start: 1, count: 1 });
    expect(second).toEqual({
      address: "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g",
      change: 0,
      index: 1,
      addressType: "p2wpkh",
    });
  });

  it("matches the BIP-49 test vector (ypub → P2SH-P2WPKH)", () => {
    expect(deriveAddressesFromXpub(BIP49_YPUB, { change: 0, start: 0, count: 1 })[0]?.address).toBe(
      "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf",
    );
  });

  it("matches the BIP-44 test vector (xpub → P2PKH)", () => {
    expect(deriveAddressesFromXpub(BIP44_XPUB, { change: 0, start: 0, count: 1 })[0]?.address).toBe(
      "1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA",
    );
  });

  it("derives testnet addresses from upub / vpub / tpub", () => {
    expect(deriveAddressesFromXpub(BIP49_UPUB, { change: 0, count: 1 })[0]?.address).toBe(
      "2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2",
    );
    expect(deriveAddressesFromXpub(BIP84_VPUB, { change: 0, count: 1 })[0]?.address).toBe(
      "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl",
    );
    expect(deriveAddressesFromXpub(BIP44_TPUB, { change: 0, count: 1 })[0]?.address).toBe(
      "mkpZhYtJu2r87Js3pDiWJDmPte2NRZ8bJV",
    );
  });

  it("allows overriding the script type (plain xpub used for a segwit account)", () => {
    expect(
      deriveAddressesFromXpub(BIP84_ACCOUNT_XPUB, { change: 0, count: 1, addressType: "p2wpkh" })[0]?.address,
    ).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  it("every derived address is itself a valid watch target", () => {
    for (const a of deriveAddressesFromXpub(BIP84_ZPUB, { change: 0, count: 5 })) {
      expect(t(a.address)).toMatchObject({ kind: "address", addressType: "p2wpkh" });
    }
  });

  it("refuses private keys and bad ranges", () => {
    const xprv =
      "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
    expect(() => deriveAddressesFromXpub(xprv, { change: 0, count: 1 })).toThrow(/Private/);
    expect(() => deriveAddressesFromXpub(BIP84_ZPUB, { change: 0, count: 100_000 })).toThrow(RangeError);
    expect(() => deriveAddressesFromXpub(BIP84_ZPUB, { change: 0, start: -1, count: 1 })).toThrow(RangeError);
    expect(() => deriveAddressesFromXpub("zpubnotakey", { change: 0, count: 1 })).toThrow(TypeError);
  });
});

describe("deriveWatchTargetAddresses", () => {
  it("derives receive and change chains from a multipath descriptor", () => {
    const target = t(`wpkh([73c5da0a/84h/0h/0h]${BIP84_ACCOUNT_XPUB}/<0;1>/*)`);
    expect(watchTargetBranches(target)).toEqual([0, 1]);
    expect(deriveWatchTargetAddresses(target, { branch: 0, count: 1 })[0]?.address).toBe(
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
    );
    expect(deriveWatchTargetAddresses(target, { branch: 1, count: 1 })[0]?.address).toBe(
      "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el",
    );
  });

  it("uses the descriptor script, not the key version", () => {
    const target = t(`pkh(${BIP84_ACCOUNT_XPUB}/0/*)`);
    expect(watchTargetBranches(target)).toEqual([0]);
    const [first] = deriveWatchTargetAddresses(target, { branch: 0, count: 1 });
    expect(first?.addressType).toBe("p2pkh");
    expect(first?.address.startsWith("1")).toBe(true);
    expect(() => deriveWatchTargetAddresses(target, { branch: 1, count: 1 })).toThrow(RangeError);
  });

  it("derives both chains for xpub targets and refuses plain addresses", () => {
    const xpubTarget = t(BIP84_ZPUB);
    expect(watchTargetBranches(xpubTarget)).toEqual([0, 1]);
    expect(deriveWatchTargetAddresses(xpubTarget, { branch: 1, count: 1 })[0]?.address).toBe(
      "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el",
    );
    const addressTarget = t("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(watchTargetBranches(addressTarget)).toEqual([]);
    expect(() => deriveWatchTargetAddresses(addressTarget, { branch: 0, count: 1 })).toThrow(TypeError);
  });
});
