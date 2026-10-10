/**
 * Text helpers shared by every statement parser.
 *
 * Everything read from a document is untrusted data: it is decoded, stripped of
 * control/bidi characters and length-capped before any pattern matching, so a
 * hostile file can neither smuggle invisible characters into descriptions nor
 * make a regular expression run for long on a giant line.
 */

/** Hard cap applied to every line/cell before pattern matching. */
export const MAX_LINE_LENGTH = 2_000;
/** Descriptions longer than this are truncated (statements never need more). */
export const MAX_DESCRIPTION_LENGTH = 500;

export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

/** Windows-1252 characters for bytes 0x80..0x9F (undefined positions stay C1 controls). */
const CP1252_HIGH =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";

/**
 * Decodes Windows-1252. Implemented explicitly because Node's TextDecoder treats
 * the "windows-1252" label as ISO-8859-1 and leaves 0x80..0x9F (€, “ ”, – ...) as
 * control characters.
 */
export function decodeWindows1252(bytes: Uint8Array): string {
  const latin1 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return latin1.replace(/[\u0080-\u009f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);
}

/**
 * Decodes bytes as UTF-8 (strict) and falls back to Windows-1252 (a superset of
 * Latin-1 used by most Brazilian/Italian bank exports) when the bytes are not
 * valid UTF-8. UTF-16 is honoured only when announced by a BOM. The BOM is
 * always removed.
 */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }
  const body = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(body), encoding: "utf-8" };
  } catch {
    return { text: decodeWindows1252(body), encoding: "windows-1252" };
  }
}

// C0/C1 controls (except tab/newline, handled separately), bidi overrides/isolates,
// zero-width characters and BOMs. These have no business in a bank statement and
// can be used to visually disguise text.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

/** Removes invisible/control characters and caps the length of a single cell or line. */
export function sanitizeCell(value: string, maxLength = MAX_LINE_LENGTH): string {
  const capped = value.length > maxLength * 2 ? value.slice(0, maxLength * 2) : value;
  const cleaned = capped.replace(INVISIBLE, "");
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/**
 * Normalizes a description for storage: strips control characters, turns any
 * whitespace run (incl. tabs/newlines/NBSP) into a single space, trims, keeps the
 * original case and caps the length. The text is data — never interpreted.
 */
export function normalizeDescription(value: string): string {
  const cleaned = sanitizeCell(value.replace(/[\t\r\n   ]/g, " "), MAX_DESCRIPTION_LENGTH * 2);
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_DESCRIPTION_LENGTH ? collapsed.slice(0, MAX_DESCRIPTION_LENGTH).trimEnd() : collapsed;
}

/**
 * Lowercases and strips diacritics character by character, so the folded string
 * has exactly the same length as the (NFC) input and indices map 1:1.
 */
export function fold(value: string): string {
  let out = "";
  for (const ch of value.normalize("NFC")) {
    const base = ch.normalize("NFD")[0] ?? ch;
    // Keep UTF-16 length identical: astral characters are replaced by two spaces.
    out += ch.length === base.length ? base.toLowerCase().slice(0, ch.length).padEnd(ch.length, " ") : " ".repeat(ch.length);
  }
  return out;
}

/**
 * Folded, punctuation-free form used to compare header names across languages:
 * "Crédito (R$)" -> "credito r", "Amount (EUR)" -> "amount eur".
 */
export function normalizeHeader(value: string): string {
  return fold(sanitizeCell(value, 200))
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Like normalizeHeader but without parenthesized qualifiers: "Crédito (R$)" -> "credito". */
export function headerCore(value: string): string {
  return normalizeHeader(sanitizeCell(value, 200).replace(/\([^)]*\)/g, " "));
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Splits text into lines, capping each one. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).map((line) => sanitizeCell(line));
}

export type Delimiter = "," | ";" | "\t" | "|";
const DELIMITERS: Delimiter[] = [";", "\t", ",", "|"];

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === delimiter && !quoted) count++;
  }
  return count;
}

export interface DelimiterGuess {
  delimiter: Delimiter;
  /** Number of delimiters on the most common line shape. */
  fields: number;
  /** Share of sampled lines that have that shape (0..1). */
  consistency: number;
}

/**
 * Infers the delimiter of a CSV-like text from its first non-empty lines: the
 * delimiter whose per-line count is the most consistent (ignoring preamble lines
 * without any delimiter) wins. Returns undefined when no delimiter repeats.
 */
export function detectDelimiter(text: string, maxLines = 60): DelimiterGuess | undefined {
  const lines: string[] = [];
  for (const line of text.slice(0, 256 * 1024).split(/\r\n|\r|\n/)) {
    if (line.trim()) lines.push(line.slice(0, MAX_LINE_LENGTH));
    if (lines.length >= maxLines) break;
  }
  if (lines.length < 2) return undefined;
  let best: DelimiterGuess | undefined;
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    let mode = 0;
    let modeCount = 0;
    for (const [c, n] of freq) {
      if (n > modeCount || (n === modeCount && c > mode)) {
        mode = c;
        modeCount = n;
      }
    }
    if (mode === 0 || modeCount < 2) continue;
    const consistency = modeCount / lines.length;
    // Prefer consistent shapes; among equals, prefer more fields.
    const score = consistency + Math.min(mode, 20) / 1000;
    if (consistency >= 0.5 && score > bestScore) {
      bestScore = score;
      best = { delimiter, fields: mode + 1, consistency };
    }
  }
  return best;
}
