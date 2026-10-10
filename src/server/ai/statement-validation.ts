/**
 * Post-validation of statement row proposals (PDF assist).
 *
 * A model may only *point at* data that is already in the document: every
 * accepted row must reference a requested line, and its date, amount and
 * description must all be literally present in that line's text. Anything
 * else is rejected with a reason — never repaired.
 */
import { parseAmount } from "@/domain/import/parse-amount";
import { parseDate } from "@/domain/import/parse-date";
import { abs, dec, equals } from "@/domain/money/decimal";
import { normalizeCurrencyCode } from "@/domain/money/currencies";
import type { RejectedStatementRow } from "./result";
import { sanitizeUntrustedText } from "./sanitize";
import { StatementRowProposalSchema, type StatementRowProposal } from "./schemas";

/* ------------------------------------------------------------------------- */
/* Dates                                                                     */
/* ------------------------------------------------------------------------- */

interface DateCandidates {
  /** Fully specified dates found in the line (YYYY-MM-DD). */
  full: Set<string>;
  /** Day/month without a year (MM-DD). */
  partial: Set<string>;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function addPartial(set: Set<string>, month: number, day: number): void {
  if (month >= 1 && month <= 12 && day >= 1 && day <= 31) set.add(`${pad2(month)}-${pad2(day)}`);
}

/** Every reading of every date-like token in the line (DMY and MDY, month names in EN/PT/IT). */
export function dateCandidatesInLine(text: string): DateCandidates {
  const full = new Set<string>();
  const partial = new Set<string>();
  const add = (v: string | null) => {
    if (v) full.add(v);
  };

  for (const m of text.matchAll(/(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)/g)) add(parseDate(m[0]));
  for (const m of text.matchAll(/(?<!\d)\d{4}[/.]\d{1,2}[/.]\d{1,2}(?!\d)/g)) add(parseDate(m[0]));
  for (const m of text.matchAll(/(?<![\d.,])\d{1,2}([/.-])\d{1,2}\1(?:\d{4}|\d{2})(?![\d.,]\d|\d)/g)) {
    add(parseDate(m[0], "DMY"));
    add(parseDate(m[0], "MDY"));
  }
  for (const m of text.matchAll(/(?<![\d/.,-])(\d{1,2})[/-](\d{1,2})(?![\d]|[/-]\d)/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    addPartial(partial, b, a); // DMY
    addPartial(partial, a, b); // MDY
  }
  // "05 MAR 2026", "5 de março de 2026", "05-mag-26", "05 MAR"
  for (const m of text.matchAll(
    /(?<!\d)(\d{1,2})(?:\s+de)?[\s/.-]*([A-Za-zÀ-ÿ]{3,9})\.?(?:(?:\s+de)?[\s/.-]*(\d{4}|\d{2})(?!\d))?/gi,
  )) {
    const day = m[1]!;
    const month = m[2]!;
    const probe = parseDate(`${day} ${month} 2024`); // leap year: accepts 29 Feb
    if (!probe) continue;
    addPartial(partial, Number(probe.slice(5, 7)), Number(probe.slice(8, 10)));
    if (m[3]) add(parseDate(`${day} ${month} ${m[3]}`));
  }
  // "Mar 5, 2026"
  for (const m of text.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?!\d)/g)) add(parseDate(m[0]));
  return { full, partial };
}

/**
 * True when `iso` is one reading of a date written in the line. A day/month
 * without a year matches any year, or only yearHint ± 1 when a hint is given.
 */
export function dateAppearsInLine(iso: string, text: string, yearHint?: number): boolean {
  const { full, partial } = dateCandidatesInLine(text);
  if (full.has(iso)) return true;
  if (!partial.has(iso.slice(5))) return false;
  return yearHint === undefined || Math.abs(Number(iso.slice(0, 4)) - yearHint) <= 1;
}

/* ------------------------------------------------------------------------- */
/* Amounts                                                                   */
/* ------------------------------------------------------------------------- */

const DATE_LIKE_SPANS = [
  /(?<!\d)\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)/g,
  /(?<![\d.,])\d{1,2}([/.-])\d{1,2}\1(?:\d{4}|\d{2})(?![\d.,]\d|\d)/g,
  /(?<![\d.,-])\d{1,2}[/-]\d{1,2}(?![\d]|[/-]\d)/g,
  /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?!\d)/g,
];

const CUR = String.raw`(?:R\$|US\$|€|£|\$|EUR|BRL|USD|GBP|CHF)`;
/** "-39,90", "- 39,90", "R$ -39,90", "-R$ 39,90", "EUR -39,90" (minus not glued to a word). */
const LEADING_MINUS = new RegExp(String.raw`(?:^|[\s(:;])[-−–]\s?(?:${CUR}\s?)?$|${CUR}\s?[-−–]\s?$`);
/** "39,90-" (glued), "39,90 D", "39,90 EUR D". */
const TRAILING_DEBIT = new RegExp(String.raw`^(?:[-−](?!\d)|\s*(?:${CUR}\s*)?D(?![A-Za-z]))`);
const OPEN_PAREN = new RegExp(String.raw`\(\s?(?:${CUR}\s?)?$`);
const CLOSE_PAREN = new RegExp(String.raw`^\s?(?:${CUR}\s?)?\)`);

interface AmountToken {
  values: string[];
  negative: boolean;
}

/** Numeric tokens of a line (dates/times masked out) with every plausible reading and sign. */
export function amountTokensInLine(text: string): AmountToken[] {
  let masked = text;
  for (const re of DATE_LIKE_SPANS) masked = masked.replace(re, (s) => " ".repeat(s.length));

  const tokens: AmountToken[] = [];
  for (const m of masked.matchAll(/(?<![\dA-Za-z])\d(?:[\d.,'’]*\d)?(?!\d)/g)) {
    const raw = m[0];
    const start = m.index;
    const end = start + raw.length;
    const values = new Set<string>();
    const plain = parseAmount(raw);
    if (plain) values.add(plain.amount);
    // "1.234" / "1,234" may also be a 3-decimal value.
    const lastSep = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
    if (lastSep >= 0 && raw.length - lastSep - 1 === 3) {
      const alt = parseAmount(raw, raw[lastSep] as "." | ",");
      if (alt) values.add(alt.amount);
    }
    if (!values.size) continue;

    const before = masked.slice(0, start);
    const after = masked.slice(end);
    const parenthesized = OPEN_PAREN.test(before) && CLOSE_PAREN.test(after);
    const negative = LEADING_MINUS.test(before) || TRAILING_DEBIT.test(after) || /^\s*\(-\)/.test(after) || parenthesized;
    tokens.push({ values: [...values], negative });
  }
  return tokens;
}

export type AmountCheck = "match" | "sign_mismatch" | "absent";

/**
 * Checks that `amount` (canonical decimal string) is written in the line in
 * some formatting ("1234.56", "1.234,56", "1,234.56", "1234,56"...), with a
 * matching sign: negative needs a leading "-", trailing "-"/"D" or
 * parentheses; positive needs none of them.
 */
export function amountAppearsInLine(amount: string, text: string): AmountCheck {
  const value = dec(amount);
  const negative = value.isNegative() && !value.isZero();
  const magnitude = abs(value);
  let sawValue = false;
  for (const token of amountTokensInLine(text)) {
    if (!token.values.some((v) => equals(v, magnitude))) continue;
    if (token.negative === negative) return "match";
    sawValue = true;
  }
  return sawValue ? "sign_mismatch" : "absent";
}

/* ------------------------------------------------------------------------- */
/* Description & currency                                                    */
/* ------------------------------------------------------------------------- */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds `description` in the line (case-insensitive, whitespace-normalized)
 * and returns the line's own text for it, or null when it is not there.
 */
export function findDescriptionInLine(description: string, text: string): string | null {
  const words = description.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const re = new RegExp(words.map(escapeRegExp).join("\\s+"), "iu");
  const m = text.normalize("NFC").match(re);
  return m ? m[0].replace(/\s+/g, " ") : null;
}

const FIAT_TOKENS = /R\$|US\$|€|£|\b(?:EUR|BRL|USD|GBP|CHF)\b/g;

/** Fiat currencies written in the text as symbol or ISO code. */
export function fiatCurrenciesInText(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.toUpperCase().matchAll(FIAT_TOKENS)) {
    const code = normalizeCurrencyCode(m[0]);
    if (code) found.add(code);
  }
  return found;
}

function currencyInLine(currency: string, text: string): boolean {
  if (fiatCurrenciesInText(text).has(currency)) return true;
  return new RegExp(`(?<![A-Za-z])${escapeRegExp(currency)}(?![A-Za-z])`).test(text);
}

/* ------------------------------------------------------------------------- */
/* Proposal validation                                                       */
/* ------------------------------------------------------------------------- */

export interface StatementValidationContext {
  /** Requested line number → the exact text that was sent to the model. */
  lines: ReadonlyMap<number, string>;
  currencyHint?: string;
  yearHint?: number;
}

export interface StatementValidation {
  accepted: StatementRowProposal[];
  rejected: RejectedStatementRow[];
}

function reject(reason: RejectedStatementRow["reason"], message: string, line?: number): RejectedStatementRow {
  return line === undefined ? { reason, message } : { line, reason, message };
}

/** Validates every proposed row; accepted rows are sorted by line. */
export function validateStatementRows(rawRows: readonly unknown[], ctx: StatementValidationContext): StatementValidation {
  const rejected: RejectedStatementRow[] = [];
  const parsed: StatementRowProposal[] = [];
  // Every answer that names a line counts, valid or not: two answers for one line are a conflict.
  const perLine = new Map<number, number>();

  for (const raw of rawRows) {
    const rawLine = raw && typeof raw === "object" && "line" in raw ? (raw as { line: unknown }).line : undefined;
    const line = typeof rawLine === "number" && Number.isInteger(rawLine) && rawLine > 0 ? rawLine : undefined;
    if (line !== undefined) perLine.set(line, (perLine.get(line) ?? 0) + 1);
    const result = StatementRowProposalSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".") || "row"}: ${i.message}`).join("; ");
      rejected.push(reject("schema_invalid", sanitizeUntrustedText(issues, 200), line));
      continue;
    }
    parsed.push(result.data);
  }

  const accepted: StatementRowProposal[] = [];
  for (const p of parsed) {
    const text = ctx.lines.get(p.line);
    if (text === undefined) {
      rejected.push(reject("line_not_requested", "The proposal references a line that was not sent.", p.line));
      continue;
    }
    if ((perLine.get(p.line) ?? 0) > 1) {
      rejected.push(reject("ambiguous_line", "More than one row was proposed for this line.", p.line));
      continue;
    }
    if (parseDate(p.date) !== p.date) {
      rejected.push(reject("invalid_date", "The date is not a valid calendar date.", p.line));
      continue;
    }
    if (!dateAppearsInLine(p.date, text, ctx.yearHint)) {
      rejected.push(reject("date_not_in_line", "The date is not written in the line.", p.line));
      continue;
    }
    const amount = parseAmount(p.amount, ".");
    if (!amount) {
      rejected.push(reject("invalid_amount", "The amount is not a decimal number.", p.line));
      continue;
    }
    const amountCheck = amountAppearsInLine(amount.amount, text);
    if (amountCheck === "absent") {
      rejected.push(reject("amount_not_in_line", "The amount is not written in the line.", p.line));
      continue;
    }
    if (amountCheck === "sign_mismatch") {
      rejected.push(reject("sign_mismatch", "The amount's sign does not match the line.", p.line));
      continue;
    }
    const description = findDescriptionInLine(p.description, text);
    if (!description) {
      rejected.push(reject("description_not_in_line", "The description is not text from the line.", p.line));
      continue;
    }
    if (p.currency && p.currency !== ctx.currencyHint && !currencyInLine(p.currency, text)) {
      rejected.push(reject("currency_not_in_line", "The currency is neither written in the line nor the hint.", p.line));
      continue;
    }
    accepted.push({
      line: p.line,
      date: p.date,
      description,
      amount: amount.amount,
      ...(p.currency && { currency: p.currency }),
    });
  }
  accepted.sort((a, b) => a.line - b.line);
  return { accepted, rejected };
}
