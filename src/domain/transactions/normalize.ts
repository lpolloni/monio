import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { toPlain } from "../money/decimal";

/**
 * Matching key for a bank description: uppercase, accents removed, card/reference
 * numbers and dates stripped, whitespace collapsed. The original description is
 * always stored untouched; this key is only used for comparisons.
 */
export function normalizeDescription(description: string): string {
  return description
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b\d{2}[/.-]\d{2}([/.-]\d{2,4})?\b/g, " ") // dates
    .replace(/\b[X*]{2,}\d{2,4}\b/g, " ") // masked card numbers
    .replace(/\b\d{5,}\b/g, " ") // long references
    .replace(/[^\p{L}\p{N}*.&/+\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Human-friendly cleanup used when no merchant could be identified. */
export function cleanDescription(description: string): string {
  const base = description
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base.length > 120 ? `${base.slice(0, 117)}…` : base;
}

export interface FingerprintInput {
  bookedOn: string;
  amount: string;
  currency: string;
  description: string;
  externalId?: string | null;
}

function keyOf(tx: FingerprintInput): string {
  return `${tx.bookedOn}|${toPlain(tx.amount)}|${tx.currency.toUpperCase()}|${normalizeDescription(tx.description)}`;
}

/**
 * Deterministic fingerprints for idempotent imports. Identical rows within one
 * account and day (two coffees at the same price) are disambiguated by their
 * occurrence index, so re-importing the same or an overlapping statement maps
 * each row to the same fingerprint. Source-provided ids (OFX FITID) win.
 */
export function computeFingerprints<T extends FingerprintInput>(rows: T[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((tx) => {
    if (tx.externalId) {
      return bytesToHex(sha256(utf8ToBytes(`v1|ext|${tx.externalId.trim()}`)));
    }
    const key = keyOf(tx);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return bytesToHex(sha256(utf8ToBytes(`v1|${key}|${occurrence}`)));
  });
}

/** SHA-256 hex of an account identifier (IBAN, card number) so the raw value is never stored. */
export function hashIdentifier(identifier: string): string {
  return bytesToHex(sha256(utf8ToBytes(`acct|${identifier.replace(/\s+/g, "").toUpperCase()}`)));
}

export function maskIdentifier(identifier: string): string {
  const compact = identifier.replace(/\s+/g, "");
  return compact.slice(-4);
}

/** Token-set Jaccard similarity of two normalized descriptions (0..1). */
export function descriptionSimilarity(a: string, b: string): number {
  const tokens = (s: string) => normalizeDescription(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
