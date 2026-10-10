/**
 * BIP-380 output-descriptor checksum (pure).
 *
 * Reference: https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki
 * The checksum is an 8-character BCH code over the descriptor text. Values in
 * the polymod exceed 32 bits, so BigInt is used.
 */

// 95 printable ASCII characters in the order mandated by BIP-380 (3 groups of 32/32/31).
const INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}" +
  "IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~" +
  'ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
const CHECKSUM_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn] as const;

function polymod(symbols: readonly number[]): bigint {
  let chk = 1n;
  for (const value of symbols) {
    const top = chk >> 35n;
    chk = ((chk & 0x7ffffffffn) << 5n) ^ BigInt(value);
    for (let i = 0; i < 5; i++) {
      if ((top >> BigInt(i)) & 1n) chk ^= GENERATOR[i]!;
    }
  }
  return chk;
}

function expand(text: string): number[] | null {
  const symbols: number[] = [];
  const groups: number[] = [];
  for (const ch of text) {
    const v = INPUT_CHARSET.indexOf(ch);
    if (v < 0) return null;
    symbols.push(v & 31);
    groups.push(v >> 5);
    if (groups.length === 3) {
      symbols.push(groups[0]! * 9 + groups[1]! * 3 + groups[2]!);
      groups.length = 0;
    }
  }
  if (groups.length === 1) symbols.push(groups[0]!);
  else if (groups.length === 2) symbols.push(groups[0]! * 3 + groups[1]!);
  return symbols;
}

/** Computes the 8-character BIP-380 checksum, or null when the text has characters outside the charset. */
export function descriptorChecksum(descriptor: string): string | null {
  const symbols = expand(descriptor);
  if (!symbols) return null;
  const c = polymod([...symbols, 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  let out = "";
  for (let i = 0; i < 8; i++) out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - i))) & 31n)];
  return out;
}

/** True when `checksum` is the valid BIP-380 checksum of `descriptor`. */
export function verifyDescriptorChecksum(descriptor: string, checksum: string): boolean {
  if (!/^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/.test(checksum)) return false;
  return descriptorChecksum(descriptor) === checksum;
}

/** Splits `body#checksum`; `checksum` is null when absent. */
export function splitDescriptorChecksum(input: string): { body: string; checksum: string | null } {
  const idx = input.lastIndexOf("#");
  if (idx < 0) return { body: input, checksum: null };
  return { body: input.slice(0, idx), checksum: input.slice(idx + 1) };
}
