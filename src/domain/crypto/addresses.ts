import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32, bech32m, createBase58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { descriptorChecksum, splitDescriptorChecksum, verifyDescriptorChecksum } from "./descriptors";

/**
 * Watch-only target detection for Monio (pure, no I/O).
 *
 * SECURITY: Monio is a watch-only product. This module never accepts private
 * key material. `detectWatchTarget` actively recognises seed phrases, WIF /
 * BIP-38 / mini private keys, raw 32-byte hex keys, extended private keys
 * (xprv/yprv/zprv/tprv/uprv/vprv and multisig variants) and Ethereum keystore
 * JSON, and returns `private_key_detected` / `seed_phrase_detected` so the UI
 * can warn the user and discard the input. Nothing here logs or stores input.
 */

export type ChainFamily = "bitcoin" | "evm";
export type WatchTargetKind = "address" | "xpub" | "descriptor";
export type ChainNetworkType = "mainnet" | "testnet";
export type AddressType = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | "evm";
export type XpubType = "xpub" | "ypub" | "zpub" | "tpub" | "vpub" | "upub";
/** Script types that can be derived from an extended public key. `p2sh` means P2SH-wrapped P2WPKH. */
export type DerivableAddressType = "p2pkh" | "p2sh" | "p2wpkh";

export interface DescriptorInfo {
  /** Script template: pkh(KEY), wpkh(KEY) or sh(wpkh(KEY)). */
  script: "pkh" | "wpkh" | "sh-wpkh";
  /** Embedded extended public key exactly as written in the descriptor. */
  extendedKey: string;
  /** Key origin including brackets (e.g. "[73c5da0a/84h/0h/0h]") or null. */
  origin: string | null;
  /** Non-hardened child numbers before the final wildcard: [0, 1] for /<0;1>/*, [0] for /0/*. */
  branches: number[];
  /** BIP-380 checksum (verified when supplied, computed otherwise). */
  checksum: string;
}

export interface WatchTarget {
  family: ChainFamily;
  kind: WatchTargetKind;
  network: ChainNetworkType;
  /** Normalized: EVM = EIP-55 checksummed; bech32 lowercase; base58 as-is; descriptors with `#checksum`. */
  identifier: string;
  addressType?: AddressType;
  xpubType?: XpubType;
  descriptor?: DescriptorInfo;
}

export type WatchTargetError = "empty" | "invalid" | "private_key_detected" | "seed_phrase_detected" | "unsupported";

export type WatchTargetResult = { ok: true; target: WatchTarget } | { ok: false; error: WatchTargetError };

export interface DerivedAddress {
  address: string;
  /** BIP-32 child number of the branch (0 = receive, 1 = change for xpubs). */
  change: number;
  index: number;
  addressType: DerivableAddressType;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const base58check = createBase58check(sha256);
const B58 = "1-9A-HJ-NP-Za-km-z";
const MAX_INPUT_LENGTH = 1024;
const MAX_DERIVATION_COUNT = 10_000;
const HARDENED = 0x80000000;

export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

const fail = (error: WatchTargetError): WatchTargetResult => ({ ok: false, error });
const ok = (target: WatchTarget): WatchTargetResult => ({ ok: true, target });

// ---------------------------------------------------------------------------
// Extended keys (SLIP-132 version bytes)
// ---------------------------------------------------------------------------

interface ExtendedKeyInfo {
  xpubType: XpubType;
  network: ChainNetworkType;
  addressType: DerivableAddressType;
  privateVersion: number;
}

const PUBLIC_VERSIONS = new Map<number, ExtendedKeyInfo>([
  [0x0488b21e, { xpubType: "xpub", network: "mainnet", addressType: "p2pkh", privateVersion: 0x0488ade4 }],
  [0x049d7cb2, { xpubType: "ypub", network: "mainnet", addressType: "p2sh", privateVersion: 0x049d7878 }],
  [0x04b24746, { xpubType: "zpub", network: "mainnet", addressType: "p2wpkh", privateVersion: 0x04b2430c }],
  [0x043587cf, { xpubType: "tpub", network: "testnet", addressType: "p2pkh", privateVersion: 0x04358394 }],
  [0x044a5262, { xpubType: "upub", network: "testnet", addressType: "p2sh", privateVersion: 0x044a4e28 }],
  [0x045f1cf6, { xpubType: "vpub", network: "testnet", addressType: "p2wpkh", privateVersion: 0x045f18bc }],
]);
/** Ypub / Zpub / Upub / Vpub (multisig) — recognised but not supported. */
const MULTISIG_PUBLIC_VERSIONS = new Set([0x0295b43f, 0x02aa7ed3, 0x024289ef, 0x02575483]);
/** xprv yprv zprv tprv uprv vprv Yprv Zprv Uprv Vprv. */
const PRIVATE_VERSIONS = new Set([
  0x0488ade4, 0x049d7878, 0x04b2430c, 0x04358394, 0x044a4e28, 0x045f18bc, 0x0295b005, 0x02aa7a99, 0x024285b5,
  0x02575048,
]);

type ExtendedKeyDecode =
  | { kind: "public"; version: number; info: ExtendedKeyInfo }
  | { kind: "private" }
  | { kind: "unsupported" }
  | { kind: "invalid" };

function decodeExtendedKey(value: string): ExtendedKeyDecode {
  let raw: Uint8Array;
  try {
    raw = base58check.decode(value);
  } catch {
    return { kind: "invalid" };
  }
  if (raw.length !== 78) return { kind: "invalid" };
  const version = readUint32BE(raw, 0);
  // Byte 45 is 0x00 for serialized private keys, whatever the version says.
  if (PRIVATE_VERSIONS.has(version) || raw[45] === 0x00) return { kind: "private" };
  if (MULTISIG_PUBLIC_VERSIONS.has(version)) return { kind: "unsupported" };
  const info = PUBLIC_VERSIONS.get(version);
  if (!info) return { kind: "invalid" };
  if (raw[45] !== 0x02 && raw[45] !== 0x03) return { kind: "invalid" };
  try {
    // Validates that the public key is a point on secp256k1.
    HDKey.fromExtendedKey(value, { public: version, private: info.privateVersion });
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "public", version, info };
}

// ---------------------------------------------------------------------------
// Secret material detection
// ---------------------------------------------------------------------------

const EXTENDED_PRIVATE_RE = new RegExp(`^[xyztuvYZUV]prv[${B58}]{100,}$`);
// WIF: uncompressed mainnet "5" / testnet "9" (51 chars); compressed mainnet "K"/"L" / testnet "c" (52 chars).
const WIF_RE = new RegExp(`^(?:[59][${B58}]{50}|[KLc][${B58}]{51})$`);
const BIP38_RE = new RegExp(`^6P[${B58}]{56}$`);
const MINI_KEY_RE = new RegExp(`^S(?:[${B58}]{21}|[${B58}]{29})$`);
const RAW_HEX_KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;
// Delimiters found in descriptors, URIs and free text. Address charsets never contain these.
const TOKEN_SPLIT_RE = /[\s()[\]{}<>,;:'"=?&|*#/\\]+/;

function isPrivateKeyToken(token: string): boolean {
  if (token.length < 22) return false;
  if (EXTENDED_PRIVATE_RE.test(token)) return true;
  if (WIF_RE.test(token)) return true;
  if (BIP38_RE.test(token)) return true;
  if (MINI_KEY_RE.test(token) && sha256(utf8ToBytes(`${token}?`))[0] === 0) return true;
  if (token.length >= 100 && token.length <= 120 && decodeExtendedKey(token).kind === "private") return true;
  return false;
}

/**
 * Heuristic seed-phrase detector: 12–25 whitespace-separated purely alphabetic
 * words (case-insensitive, any script), optionally numbered ("1. abandon").
 * This is a superset of the BIP-39 lengths (12/15/18/21/24) that also covers
 * Electrum (13 with passphrase word) and 25-word phrases. No wordlist needed:
 * a valid watch target never contains spaces, so false positives only change
 * the error code of an already-invalid input.
 */
function looksLikeSeedPhrase(text: string): boolean {
  const words = text
    .split(/[\s,;]+/u)
    .filter((t) => t.length > 0 && !/^\d{1,2}[.):-]?$/.test(t))
    .map((t) => t.replace(/^\d{1,2}[.):-]/, ""));
  if (words.length < 12 || words.length > 25) return false;
  return words.every((w) => /^\p{L}{1,12}$/u.test(w));
}

/**
 * Returns which kind of secret material `input` appears to contain, or null.
 * Exported so other inputs (notes, imports) can reuse the same guard.
 */
export function detectSecretMaterial(input: string): "private_key_detected" | "seed_phrase_detected" | null {
  const text = input.trim();
  if (text.length === 0) return null;
  if (looksLikeSeedPhrase(text)) return "seed_phrase_detected";
  if (RAW_HEX_KEY_RE.test(text)) return "private_key_detected";
  // Ethereum V3 keystore JSON (encrypted private key).
  if (text.startsWith("{") && /"ciphertext"\s*:/.test(text)) return "private_key_detected";
  for (const token of text.split(TOKEN_SPLIT_RE)) {
    // 64-hex tokens anywhere (e.g. "my key is 0x…") are treated as raw private keys. This also
    // catches x-only keys in tr() descriptors, which are unsupported anyway (indistinguishable).
    if (RAW_HEX_KEY_RE.test(token) || isPrivateKeyToken(token)) return "private_key_detected";
  }
  return null;
}

// ---------------------------------------------------------------------------
// EVM (EIP-55)
// ---------------------------------------------------------------------------

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddressFormat(value: string): boolean {
  return EVM_ADDRESS_RE.test(value);
}

/** EIP-55 mixed-case checksum encoding. Throws TypeError for anything that is not 0x + 40 hex. */
export function toChecksumAddress(address: string): string {
  const normalized = /^0X/.test(address) ? `0x${address.slice(2)}` : address;
  if (!EVM_ADDRESS_RE.test(normalized)) throw new TypeError("Not a 20-byte hex address");
  const lower = normalized.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    const ch = lower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/** True when the address has a valid EIP-55 checksum, or is single-case (no checksum to verify). */
export function hasValidEvmChecksum(address: string): boolean {
  if (!EVM_ADDRESS_RE.test(address)) return false;
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

function detectEvm(value: string): WatchTargetResult {
  const candidate = /^0X/.test(value) ? `0x${value.slice(2)}` : value;
  if (!EVM_ADDRESS_RE.test(candidate)) return fail("invalid");
  if (!hasValidEvmChecksum(candidate)) return fail("invalid");
  return ok({
    family: "evm",
    kind: "address",
    network: "mainnet",
    identifier: toChecksumAddress(candidate),
    addressType: "evm",
  });
}

// ---------------------------------------------------------------------------
// Bitcoin addresses
// ---------------------------------------------------------------------------

function detectSegwit(value: string): WatchTargetResult {
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) return fail("invalid");
  const s = value.toLowerCase();
  if (s.length > 90) return fail("invalid");
  const sep = s.lastIndexOf("1");
  const hrp = s.slice(0, sep);
  if (hrp === "bcrt") return fail("unsupported");
  if (hrp !== "bc" && hrp !== "tb") return fail("invalid");
  const network: ChainNetworkType = hrp === "bc" ? "mainnet" : "testnet";

  const v0 = bech32.decodeUnsafe(s);
  const v1 = v0 ? undefined : bech32m.decodeUnsafe(s);
  const decoded = v0 ?? v1;
  if (!decoded || decoded.words.length < 1) return fail("invalid");
  const version = decoded.words[0]!;
  if (version > 16) return fail("invalid");
  // BIP-350: v0 must use bech32, v1+ must use bech32m.
  if ((version === 0 && !v0) || (version > 0 && !v1)) return fail("invalid");
  const program = bech32.fromWordsUnsafe(decoded.words.slice(1));
  if (!program || program.length < 2 || program.length > 40) return fail("invalid");

  let addressType: AddressType;
  if (version === 0) {
    if (program.length === 20) addressType = "p2wpkh";
    else if (program.length === 32) addressType = "p2wsh";
    else return fail("invalid");
  } else if (version === 1 && program.length === 32) {
    addressType = "p2tr";
  } else {
    return fail("unsupported"); // future segwit versions / non-taproot v1 programs
  }
  return ok({ family: "bitcoin", kind: "address", network, identifier: s, addressType });
}

function detectBase58Address(value: string): WatchTargetResult {
  let raw: Uint8Array;
  try {
    raw = base58check.decode(value);
  } catch {
    return fail("invalid");
  }
  if (raw.length !== 21) return fail("invalid");
  const map: Record<number, [ChainNetworkType, AddressType]> = {
    0x00: ["mainnet", "p2pkh"],
    0x05: ["mainnet", "p2sh"],
    0x6f: ["testnet", "p2pkh"],
    0xc4: ["testnet", "p2sh"],
  };
  const entry = map[raw[0]!];
  if (!entry) return fail("invalid");
  return ok({ family: "bitcoin", kind: "address", network: entry[0], identifier: value, addressType: entry[1] });
}

function detectExtendedPublicKey(value: string): WatchTargetResult {
  const decoded = decodeExtendedKey(value);
  if (decoded.kind === "private") return fail("private_key_detected");
  if (decoded.kind === "unsupported") return fail("unsupported");
  if (decoded.kind === "invalid") return fail("invalid");
  return ok({
    family: "bitcoin",
    kind: "xpub",
    network: decoded.info.network,
    identifier: value,
    addressType: decoded.info.addressType,
    xpubType: decoded.info.xpubType,
  });
}

// ---------------------------------------------------------------------------
// Output descriptors (BIP-380/381/382/389 subset)
// ---------------------------------------------------------------------------

const UNSUPPORTED_DESCRIPTOR_FUNCS = new Set([
  "tr",
  "rawtr",
  "wsh",
  "sh",
  "multi",
  "sortedmulti",
  "multi_a",
  "sortedmulti_a",
  "combo",
  "raw",
  "pk",
  "musig",
]);

function detectDescriptor(value: string): WatchTargetResult {
  const { body, checksum } = splitDescriptorChecksum(value);
  if (checksum !== null && !verifyDescriptorChecksum(body, checksum)) return fail("invalid");
  const computed = descriptorChecksum(body);
  if (!computed) return fail("invalid");

  let script: DescriptorInfo["script"];
  let keyExpr: string;
  let m: RegExpExecArray | null;
  if ((m = /^addr\(([^()]+)\)$/.exec(body))) {
    // addr(ADDRESS) is just an address.
    return detectPlain(m[1]!);
  } else if ((m = /^sh\(wpkh\(([^()]+)\)\)$/.exec(body))) {
    script = "sh-wpkh";
    keyExpr = m[1]!;
  } else if ((m = /^(wpkh|pkh)\(([^()]+)\)$/.exec(body))) {
    script = m[1] === "wpkh" ? "wpkh" : "pkh";
    keyExpr = m[2]!;
  } else {
    const func = /^([a-z_]+)\(/.exec(body)?.[1];
    return fail(func && UNSUPPORTED_DESCRIPTOR_FUNCS.has(func) ? "unsupported" : "invalid");
  }

  const km = new RegExp(`^(\\[[0-9a-fA-F]{8}(?:/\\d+['hH]?)*\\])?([${B58}]+|[0-9a-fA-F]+)((?:/[^/]+)*)$`).exec(keyExpr);
  if (!km) return fail("invalid");
  const origin = km[1] ?? null;
  const key = km[2]!;
  const steps = (km[3] ?? "").split("/").filter((s) => s.length > 0);

  if (/^[0-9a-fA-F]+$/.test(key) && !/^[xyztuvYZUV]pub/.test(key)) {
    // A 32-byte hex key in a pkh/wpkh slot is a private key; hex public keys are single-key descriptors.
    if (key.length === 64) return fail("private_key_detected");
    return fail("unsupported");
  }
  const ext = decodeExtendedKey(key);
  if (ext.kind === "private") return fail("private_key_detected");
  if (ext.kind === "unsupported") return fail("unsupported");
  if (ext.kind === "invalid") return fail(WIF_RE.test(key) ? "private_key_detected" : "invalid");

  // Supported shape: KEY/<branch>/* or KEY/<a;b>/* — all non-hardened (watch-only cannot derive hardened children).
  // Anything else (non-ranged, hardened wildcard, extra steps) cannot be scanned watch-only.
  if (steps.length !== 2 || steps[1] !== "*") return fail("unsupported");
  const branchStep = steps[0]!;
  let branches: number[];
  const multi = /^<(\d+);(\d+)>$/.exec(branchStep);
  if (multi) branches = [Number(multi[1]), Number(multi[2])];
  else if (/^\d+$/.test(branchStep)) branches = [Number(branchStep)];
  else return fail(/['hH]$/.test(branchStep) ? "unsupported" : "invalid");
  if (branches.some((b) => !Number.isSafeInteger(b) || b >= HARDENED)) return fail("invalid");
  if (branches.length === 2 && branches[0] === branches[1]) return fail("invalid");

  const addressType: AddressType = script === "wpkh" ? "p2wpkh" : script === "pkh" ? "p2pkh" : "p2sh";
  return ok({
    family: "bitcoin",
    kind: "descriptor",
    network: ext.info.network,
    identifier: `${body}#${computed}`,
    addressType,
    xpubType: ext.info.xpubType,
    descriptor: { script, extendedKey: key, origin, branches, checksum: computed },
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function stripUriScheme(value: string): string {
  const btc = /^bitcoin:([^?]+)(?:\?.*)?$/i.exec(value);
  if (btc) return btc[1]!;
  const eth = /^ethereum:(?:pay-)?([^@/?]+)/i.exec(value);
  if (eth) return eth[1]!;
  return value;
}

function detectPlain(value: string): WatchTargetResult {
  if (/^0x/i.test(value)) return detectEvm(value);
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth$/i.test(value)) return fail("unsupported"); // ENS needs resolution
  if (/^ln(?:bc|tb|bcrt)/i.test(value)) return fail("unsupported"); // Lightning invoices
  if (/^(?:bc|tb|bcrt)1/i.test(value)) return detectSegwit(value);
  if (/^[xyztuvYZUV]pub/.test(value)) return detectExtendedPublicKey(value);
  if (new RegExp(`^[123mn][${B58}]{24,34}$`).test(value)) return detectBase58Address(value);
  return fail("invalid");
}

/**
 * Classifies user input as a watch-only target. Never throws.
 * Secret material is detected BEFORE any parsing so the caller can warn and discard it.
 */
export function detectWatchTarget(input: string): WatchTargetResult {
  if (typeof input !== "string") return fail("invalid");
  const text = input.trim();
  if (text.length === 0) return fail("empty");
  const secret = detectSecretMaterial(text);
  if (secret) return fail(secret);
  if (text.length > MAX_INPUT_LENGTH || /\s/.test(text)) return fail("invalid");

  const value = stripUriScheme(text);
  if (/^[a-z_]+\(/.test(value)) return detectDescriptor(value);
  return detectPlain(value);
}

/** Shortens an identifier for display: `0x1234…abcd`, `bc1qcr…6fyu`, `wpkh(xpub6D…HQbY)`. */
export function shortenAddress(identifier: string, head = 6, tail = 4): string {
  const descriptor = /^((?:[a-z_]+\()+)(?:\[[^\]]*\])?([^/()]+)/.exec(identifier);
  if (descriptor) {
    const wrappers = descriptor[1]!;
    const closing = ")".repeat((wrappers.match(/\(/g) ?? []).length);
    return `${wrappers}${shortenAddress(descriptor[2]!, head, tail)}${closing}`;
  }
  if (identifier.length <= head + tail + 1) return identifier;
  return `${identifier.slice(0, head)}…${identifier.slice(-tail)}`;
}

function encodeAddress(pubkey: Uint8Array, type: DerivableAddressType, network: ChainNetworkType): string {
  const h = hash160(pubkey);
  if (type === "p2wpkh") {
    return bech32.encode(network === "mainnet" ? "bc" : "tb", [0, ...bech32.toWords(h)]);
  }
  if (type === "p2sh") {
    const redeemScript = concatBytes(Uint8Array.of(0x00, 0x14), h); // OP_0 <20-byte keyhash>
    return base58check.encode(concatBytes(Uint8Array.of(network === "mainnet" ? 0x05 : 0xc4), hash160(redeemScript)));
  }
  return base58check.encode(concatBytes(Uint8Array.of(network === "mainnet" ? 0x00 : 0x6f), h));
}

function deriveFromExtendedKey(
  key: string,
  branch: number,
  start: number,
  count: number,
  addressTypeOverride?: DerivableAddressType,
): DerivedAddress[] {
  if (!Number.isSafeInteger(branch) || branch < 0 || branch >= HARDENED) throw new RangeError("Invalid branch");
  if (!Number.isSafeInteger(start) || start < 0) throw new RangeError("Invalid start index");
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_DERIVATION_COUNT) throw new RangeError("Invalid count");
  if (start + count > HARDENED) throw new RangeError("Index out of non-hardened range");
  const decoded = decodeExtendedKey(key);
  if (decoded.kind === "private") throw new TypeError("Private extended keys are not accepted");
  if (decoded.kind !== "public") throw new TypeError("Invalid extended public key");
  const addressType = addressTypeOverride ?? decoded.info.addressType;
  const node = HDKey.fromExtendedKey(key, { public: decoded.version, private: decoded.info.privateVersion }).deriveChild(
    branch,
  );
  const out: DerivedAddress[] = [];
  for (let i = start; i < start + count; i++) {
    const pub = node.deriveChild(i).publicKey;
    if (!pub) throw new Error("Derivation produced no public key");
    out.push({ address: encodeAddress(pub, addressType, decoded.info.network), change: branch, index: i, addressType });
  }
  return out;
}

/**
 * Derives addresses `m/.../change/i` for i in [start, start+count) from an extended PUBLIC key.
 * Script type follows SLIP-132: zpub/vpub → P2WPKH (bech32), ypub/upub → P2SH-P2WPKH, xpub/tpub → P2PKH,
 * unless `addressType` overrides it (descriptors use plain xpub with an explicit script).
 */
export function deriveAddressesFromXpub(
  xpub: string,
  opts: { change: 0 | 1; start?: number; count: number; addressType?: DerivableAddressType },
): DerivedAddress[] {
  return deriveFromExtendedKey(xpub.trim(), opts.change, opts.start ?? 0, opts.count, opts.addressType);
}

/** BIP-32 branch numbers to scan for an xpub/descriptor target ([] for plain addresses). */
export function watchTargetBranches(target: WatchTarget): number[] {
  if (target.kind === "xpub") return [0, 1];
  if (target.kind === "descriptor" && target.descriptor) return [...target.descriptor.branches];
  return [];
}

/** Derives addresses for an xpub or descriptor target on the given branch. */
export function deriveWatchTargetAddresses(
  target: WatchTarget,
  opts: { branch: number; start?: number; count: number },
): DerivedAddress[] {
  if (target.family !== "bitcoin") throw new TypeError("Derivation is only available for Bitcoin targets");
  if (target.kind === "xpub") {
    if (opts.branch !== 0 && opts.branch !== 1) throw new RangeError("xpub branches are 0 (receive) and 1 (change)");
    return deriveFromExtendedKey(target.identifier, opts.branch, opts.start ?? 0, opts.count);
  }
  if (target.kind === "descriptor" && target.descriptor) {
    const d = target.descriptor;
    if (!d.branches.includes(opts.branch)) throw new RangeError("Branch not part of the descriptor");
    const override: DerivableAddressType = d.script === "wpkh" ? "p2wpkh" : d.script === "pkh" ? "p2pkh" : "p2sh";
    return deriveFromExtendedKey(d.extendedKey, opts.branch, opts.start ?? 0, opts.count, override);
  }
  throw new TypeError("Target is a single address");
}
