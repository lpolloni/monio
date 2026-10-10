/**
 * PDF statement parser.
 *
 * 1. Text is extracted with unpdf (pdf.js, eval disabled) and rebuilt into lines
 *    by baseline, keeping each fragment's x position.
 * 2. A deterministic line parser reads lines such as
 *       "05/03/2026  PAG*NETFLIX  -39,90"     "05 MAR  UBER *TRIP  23,40"
 *    Years missing from dates are inferred from the statement period stated in
 *    the header; amounts need exactly two decimals; the sign comes from an
 *    explicit marker, from the debit/credit column under which the amount sits,
 *    or from the statement kind (card bills list purchases unsigned).
 * 3. Lines that look transactional but cannot be read deterministically are
 *    reported as warnings and, optionally, sent to an AI assist hook. Every row
 *    proposed by the model is validated against the line text (the amount must
 *    literally appear in it) before being accepted with `extraction: "ai"`.
 *
 * All document text is untrusted data; nothing in it is ever executed or
 * interpreted as instructions.
 */
import { extractTextItems, getDocumentProxy, createIsomorphicCanvasFactory, renderPageAsImage } from "unpdf";
import { z } from "zod";
import { parseAmount } from "@/domain/import/parse-amount";
import { inferDateOrder, parseDate, type DateOrder } from "@/domain/import/parse-date";
import type { AccountType, ParsedAccount, ParsedTransaction, ParseWarning } from "@/domain/import/types";
import { isKnownCurrency, normalizeCurrencyCode } from "@/domain/money/currencies";
import { dec, toPlain } from "@/domain/money/decimal";
import { findIban, findInstitutionByText, getInstitution } from "../institution-catalog";
import { mergeDocumentInterpretation, needsDocumentAi, validateDocumentInterpretation } from "./document-ai";
import { parseSignedLedger } from "./signed-ledger";
import { canLearnPdf, pdfLayoutKey, reusablePdf } from "./pdf-learning";
import { WarningSink } from "./warnings";
import { fold, normalizeDescription, sanitizeCell } from "./text";
import type { AiProposedRow, DocumentParseContext, ParserOutput } from "./types";

export const MAX_PDF_PAGES = 300;
/** Maximum number of ambiguous lines sent to the AI assist hook. */
export const MAX_AI_LINES = 200;
const MAX_AI_LINE_LENGTH = 500;

export class PdfRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfRejectedError";
  }
}

export interface PdfTextItem {
  x: number;
  width: number;
  text: string;
  /** Character range of this item inside the line text. */
  start: number;
  end: number;
}

export interface PdfLine {
  /** 1-based line number across the whole document. */
  line: number;
  page: number;
  text: string;
  items: PdfTextItem[];
}

// ---------------------------------------------------------------------------
// Text extraction

export async function extractPdfLines(bytes: Uint8Array, recoverVisualText = false): Promise<PdfLine[]> {
  const CanvasFactory = recoverVisualText ? await createIsomorphicCanvasFactory(() => import("@napi-rs/canvas")) : undefined;
  const worker = recoverVisualText ? await (await import("./pdf-ocr")).createPdfOcrWorker() : undefined;
  // pdf.js may transfer/detach the buffer it receives: give it a copy.
  // The bundled pdf.js (v5) no longer compiles fonts with eval, so there is no
  // `isEvalSupported` switch to turn off; font faces and system fonts are disabled.
  const pdf = await getDocumentProxy(bytes.slice(), {
    ...(CanvasFactory ? { CanvasFactory } : {}),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    // Errors only: standard-font warnings are irrelevant for text extraction.
    verbosity: 0,
  });
  try {
    if (pdf.numPages > MAX_PDF_PAGES) throw new PdfRejectedError(`PDF has more than ${MAX_PDF_PAGES} pages.`);
    const { items } = await extractTextItems(pdf);
    const lines: PdfLine[] = [];
    for (const [pageIndex, pageItems] of items.entries()) {
      const fragments = pageItems
        .filter((it) => it.str && it.str.trim())
        .map((it) => ({ x: it.x, y: it.y, width: it.width, size: it.fontSize || 10, str: it.str }));
      if (worker) {
        const page = await pdf.getPage(pageIndex + 1);
        const height = page.getViewport({ scale: 1 }).height;
        const image = await renderPageAsImage(pdf, pageIndex + 1, { scale: 2, canvasImport: () => import("@napi-rs/canvas") });
        const { data } = await worker.recognize(Buffer.from(image), {}, { blocks: true });
        for (const block of data.blocks ?? []) for (const paragraph of block.paragraphs) for (const row of paragraph.lines) for (const word of row.words) {
          if (word.confidence < 40 || !word.text.trim()) continue;
          const x = word.bbox.x0 / 2, right = word.bbox.x1 / 2;
          const baseline = height - row.baseline.y0 / 2;
          // Native glyphs remain authoritative. Add only text in previously empty regions.
          if (fragments.some(f => f.x < right && f.x + f.width > x && Math.abs(f.y - baseline) <= Math.max(2, f.size * 0.4))) continue;
          fragments.push({ x, y: baseline, width: right - x, size: (word.bbox.y1 - word.bbox.y0) / 2, str: word.text });
        }
      }
      // Top to bottom, then left to right.
      fragments.sort((a, b) => b.y - a.y || a.x - b.x);
      const groups: (typeof fragments)[] = [];
      for (const f of fragments) {
        const group = groups[groups.length - 1];
        const ref = group?.[0];
        if (group && ref && Math.abs(ref.y - f.y) <= Math.max(2, ref.size * 0.4)) group.push(f);
        else groups.push([f]);
      }
      for (const group of groups) {
        group.sort((a, b) => a.x - b.x);
        let text = "";
        const lineItems: PdfTextItem[] = [];
        let previous: (typeof group)[number] | undefined;
        for (const f of group) {
          const str = sanitizeCell(f.str.normalize("NFC"), 1000).replace(/\s+/g, " ").trim();
          if (!str) continue;
          // Fragments that touch (glyph runs of one word) are joined without a space.
          const touching = previous !== undefined && f.x - (previous.x + previous.width) < f.size * 0.15;
          if (text && !touching) text += " ";
          const start = text.length;
          text += str;
          const previousItem = lineItems.at(-1);
          if (touching && previousItem) {
            previousItem.text += str;
            previousItem.width = f.x + f.width - previousItem.x;
            previousItem.end = text.length;
          } else lineItems.push({ x: f.x, width: f.width, text: str, start, end: text.length });
          previous = f;
          if (text.length > 2000) break;
        }
        if (text) lines.push({ line: lines.length + 1, page: pageIndex + 1, text: text.slice(0, 2000), items: lineItems });
      }
    }
    return lines;
  } finally {
    await worker?.terminate();
    await pdf.loadingTask.destroy();
  }
}

// ---------------------------------------------------------------------------
// Dates

const MONTHS: Record<string, number> = {};
const monthNames: [number, string[]][] = [
  [1, ["jan", "janeiro", "january", "gen", "gennaio", "ene", "enero", "januar", "janv", "janvier"]],
  [2, ["feb", "fev", "fevereiro", "february", "febbraio", "febrero", "februar", "fevr", "fevrier"]],
  [3, ["mar", "marco", "march", "marzo", "marz", "maerz", "mars"]],
  [4, ["apr", "abr", "abril", "april", "aprile", "avr", "avril"]],
  [5, ["may", "mai", "maio", "mag", "maggio", "mayo"]],
  [6, ["jun", "junho", "june", "giu", "giugno", "junio", "juni", "juin"]],
  [7, ["jul", "julho", "july", "lug", "luglio", "julio", "juli", "juil", "juillet"]],
  [8, ["aug", "ago", "agosto", "august", "aout"]],
  [9, ["sep", "sept", "set", "setembro", "september", "settembre", "septiembre", "septembre"]],
  [10, ["oct", "out", "outubro", "october", "ott", "ottobre", "octubre", "okt", "oktober", "octobre"]],
  [11, ["nov", "novembro", "november", "novembre", "noviembre"]],
  [12, ["dec", "dez", "dezembro", "december", "dic", "dicembre", "diciembre", "dezember", "decembre"]],
];
for (const [month, names] of monthNames) for (const name of names) MONTHS[name] = month;

function iso(y: number, m: number, d: number): string | null {
  return parseDate(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

interface PartialDate {
  day: number;
  month: number;
  year?: number;
  /** Length of the matched prefix in the line text. */
  length: number;
  numeric: boolean;
  raw: string;
}

const NUM_DATE_PREFIX = /^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{4}|\d{2}))?(?=\s|$)/;
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?=\s|$)/;
const NAME_DATE_PREFIX = /^(\d{1,2})(?:\s+de)?[\s\-/.]?([a-z]{3,9})\.?(?:(?:\s+de)?[\s\-/.](\d{4}))?(?=\s|$)/;

/** Reads a date at the start of `text` (which must already be NFC); year may be missing. */
function datePrefix(text: string, order: DateOrder): PartialDate | undefined {
  let m = ISO_DATE_PREFIX.exec(text);
  if (m) {
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), length: m[0].length, numeric: true, raw: m[0] };
  }
  m = NUM_DATE_PREFIX.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [day, month] = order === "MDY" ? [b, a] : [a, b];
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const y = m[3] ? Number(m[3]) : undefined;
    const year = y === undefined ? undefined : y < 100 ? 2000 + y : y;
    return { day, month, year, length: m[0].length, numeric: true, raw: m[0] };
  }
  m = NAME_DATE_PREFIX.exec(fold(text.slice(0, 40)));
  if (m) {
    const month = MONTHS[m[2]!];
    const day = Number(m[1]);
    if (!month || day < 1 || day > 31) return undefined;
    return { day, month, year: m[3] ? Number(m[3]) : undefined, length: m[0].length, numeric: false, raw: text.slice(0, m[0].length) };
  }
  return undefined;
}

const FULL_DATE_PATTERNS = [
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
  /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/g,
  /\b(\d{1,2})(?:\s+de)?[\s\-/.]([a-z]{3,9})\.?(?:\s+de)?[\s\-/.](\d{4})\b/g,
];

/** Full dates (with year) found anywhere in a line, in order of appearance. */
function fullDates(text: string, order: DateOrder): { index: number; end: number; date: string }[] {
  const folded = fold(text.slice(0, 2000));
  const found: { index: number; end: number; date: string }[] = [];
  FULL_DATE_PATTERNS.forEach((pattern, kind) => {
    for (const m of folded.matchAll(pattern)) {
      let date: string | null = null;
      if (kind === 0) date = iso(Number(m[1]), Number(m[2]), Number(m[3]));
      else if (kind === 1) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        date = order === "MDY" ? iso(Number(m[3]), a, b) : iso(Number(m[3]), b, a);
      } else {
        const month = MONTHS[m[2]!];
        if (month) date = iso(Number(m[3]), month, Number(m[1]));
      }
      if (date) found.push({ index: m.index, end: m.index + m[0].length, date });
    }
  });
  return found.sort((a, b) => a.index - b.index);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Completes a date without year using the statement period (or a reference date). */
function completeYear(
  p: PartialDate,
  period: { start: string; end: string } | undefined,
  reference: string | undefined,
): string | null {
  if (p.year !== undefined) return iso(p.year, p.month, p.day);
  if (period) {
    const from = addDays(period.start, -45);
    const to = addDays(period.end, 45);
    const years = new Set([Number(period.start.slice(0, 4)), Number(period.end.slice(0, 4))]);
    const candidates = [...years].map((y) => iso(y, p.month, p.day)).filter((d): d is string => !!d && d >= from && d <= to);
    return candidates.length === 1 ? candidates[0]! : null;
  }
  if (reference) {
    const y = Number(reference.slice(0, 4));
    const sameYear = iso(y, p.month, p.day);
    if (sameYear && sameYear <= addDays(reference, 31)) return sameYear;
    return iso(y - 1, p.month, p.day);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Amounts

const AMOUNT_TOKEN = /^\(?[-−+]?(?:R\$|US\$|€|£|\$)?[-−+]?(\d{1,3}(?:[.,'’  ]\d{3})+|\d+)([.,])(\d{2})\)?(-|D|C|DR|CR|DB)?$/;
const CURRENCY_TOKEN = /^(R\$|US\$|€|£|\$|EUR|BRL|USD|GBP|CHF)$/;
const MARKER_TOKEN = /^(?:-|\+|−|D|C|DR|CR|DB|\([+-]\))$/;

export interface AmountReading {
  /** Unsigned canonical magnitude ("1234.56"). */
  magnitude: string;
  /** "minus" = written negative ("-", "( )", trailing "-"); debit/credit = D/C markers. */
  sign: "minus" | "plus" | "debit" | "credit" | "none";
  currency?: string;
}

/** Reads one amount token (optionally with attached sign/currency/marker); requires two decimals. */
export function readAmountToken(token: string): AmountReading | undefined {
  if (token.length > 40) return undefined;
  token = token.replace(/^([\d.,]+)\s*\(([+-])\)$/, "$2$1");
  const m = AMOUNT_TOKEN.exec(token);
  if (!m) return undefined;
  const integer = m[1]!;
  const decimalSep = m[2]!;
  // Thousands separators must differ from the decimal separator.
  if (/[.,]/.test(integer) && integer.includes(decimalSep)) return undefined;
  const magnitude = toPlain(`${integer.replace(/\D/g, "")}.${m[3]}`);
  let sign: AmountReading["sign"] = "none";
  const marker = m[4];
  if (marker === "D" || marker === "DR" || marker === "DB") sign = "debit";
  else if (marker === "C" || marker === "CR") sign = "credit";
  else if (marker === "-" || /^\(.*\)/.test(token) || /^\(?[-−]|^\(?(?:R\$|US\$|€|£|\$)[-−]/.test(token)) sign = "minus";
  else if (/^\(?\+|^\(?(?:R\$|US\$|€|£|\$)\+/.test(token)) sign = "plus";
  const symbol = /R\$|US\$|€|£|\$/.exec(token)?.[0];
  return { magnitude, sign, currency: symbol ? normalizeCurrencyCode(symbol) : undefined };
}

interface TrailingAmount extends AmountReading {
  /** Number of tokens consumed from the end. */
  consumed: number;
  token: string;
}

/** Reads the amount at the end of a token list ("R$", "-", "39,90", "D", "EUR" forms). */
function trailingAmount(tokens: string[]): TrailingAmount | undefined {
  let i = tokens.length - 1;
  let currency: string | undefined;
  let marker: string | undefined;
  if (i >= 0 && CURRENCY_TOKEN.test(tokens[i]!)) currency = normalizeCurrencyCode(tokens[i--]!);
  if (i >= 0 && MARKER_TOKEN.test(tokens[i]!) && i > 0 && AMOUNT_TOKEN.test(tokens[i - 1]!)) marker = tokens[i--]!.replace(/[()]/g, "");
  const token = tokens[i];
  if (token === undefined) return undefined;
  const reading = readAmountToken(token);
  if (!reading) return undefined;
  i--;
  if (marker === "D" || marker === "DR" || marker === "DB") reading.sign = "debit";
  else if (marker === "C" || marker === "CR") reading.sign = "credit";
  else if (marker === "-" || marker === "−") reading.sign = "minus";
  else if (marker === "+") reading.sign = "plus";
  if (i >= 0 && reading.sign === "none" && /^[-−+]$/.test(tokens[i]!)) {
    reading.sign = tokens[i] === "+" ? "plus" : "minus";
    i--;
  }
  if (i >= 0 && CURRENCY_TOKEN.test(tokens[i]!)) currency ??= normalizeCurrencyCode(tokens[i--]!);
  return { ...reading, currency: reading.currency ?? currency, consumed: tokens.length - 1 - i, token };
}

// ---------------------------------------------------------------------------
// Line classification

const CARD_MARKERS =
  /\b(fatura|cartao de credito|credit card|carta di credito|estratto conto carta|tarjeta de credito|kreditkarte|carte de credit|card statement|limite disponivel|pagamento minimo)\b/;
const CHECKING_MARKERS = /\b(conta corrente|conta digital|conto corrente|current account|checking account|girokonto|compte courant|cuenta corriente|extrato de conta)\b/;
const PERIOD_MARKERS = /\b(periodo|period|statement period|dal|from|von|zeitraum|referente|competencia|movimentacao|movimenti)\b/;
/** Words joining the two dates of a period: "01/03/2026 a 31/03/2026", "1 Mar 2026 - 31 Mar 2026". */
const PERIOD_CONNECTOR = /^\s*(a|al|ate|to|au|bis|hasta|until|till|-|–|—)\s*:?\s*$/;
/** Header/summary wording: such lines are never sent to the AI as transactions. */
const SUMMARY_WORDS = /\b(saldo|balance|total|totale|totais|vencimento|due date|scadenza|limite|minimo|minimum|emissao|emissione|issued)\b/;
const OPENING_LINE = /^(saldo (anterior|inicial|iniziale|precedente|di apertura|de abertura)|opening balance|previous balance|balance brought forward|anfangssaldo|solde (initial|precedent))\b/;
const CLOSING_LINE = /^(saldo (disponivel no final do periodo(?: filtrado)?|final|finale|di chiusura|atual)|closing balance|new balance|balance carried forward|endsaldo|solde final)\b/;
const OTHER_BALANCE_LINE =
  /^(saldo|balance|total|totale|totais|subtotal|summe|limite|vencimento|due date|scadenza|pagamento minimo|minimum payment)\b/;
const MONTH_ALTERNATION = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
const LOOKS_DATED = new RegExp(
  `(^|\\s)(\\d{1,2}[/.\\-]\\d{1,2}([/.\\-]\\d{2,4})?|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s?(${MONTH_ALTERNATION})\\.?)(?=\\s|$)`,
);
const LOOKS_AMOUNT = /\d[.,]\d{2}(?!\d)/;

const COLUMN_KEYWORDS: Record<"debit" | "credit" | "amount" | "balance", string[]> = {
  debit: ["dare", "uscite", "debito", "debitos", "debit", "debits", "saidas", "saida", "addebiti", "withdrawals", "money out", "paid out", "cargo", "soll"],
  credit: ["avere", "entrate", "credito", "creditos", "credit", "credits", "entradas", "entrada", "accrediti", "deposits", "money in", "paid in", "abono", "haben"],
  amount: ["importo", "valor", "amount", "betrag", "montant", "importe", "valor r$", "importo eur", "movimento", "movimentacao", "movimento r$"],
  balance: ["saldo", "balance", "solde", "kontostand"],
};

type ColumnRole = keyof typeof COLUMN_KEYWORDS;
interface Column {
  role: ColumnRole;
  center: number;
}

function columnRole(text: string): ColumnRole | undefined {
  const t = fold(text).replace(/\([^)]*\)/g, "").trim();
  for (const role of Object.keys(COLUMN_KEYWORDS) as ColumnRole[]) {
    if (COLUMN_KEYWORDS[role].includes(t)) return role;
  }
  return undefined;
}

function detectColumns(line: PdfLine): Column[] | undefined {
  const columns: Column[] = [];
  for (const item of line.items) {
    const role = columnRole(item.text);
    if (role) columns.push({ role, center: item.x + item.width / 2 });
  }
  const roles = new Set(columns.map((c) => c.role));
  if ((roles.has("debit") && roles.has("credit")) || (roles.has("amount") && roles.has("balance"))) return columns;
  return undefined;
}

// ---------------------------------------------------------------------------
// Main parser

interface Candidate {
  line: PdfLine;
  date: PartialDate;
  valueDate?: PartialDate;
  rest: string;
}

interface Ambiguous {
  line: PdfLine;
  reason: string;
}

const AiRowSchema = z.object({
  line: z.number().int().positive(),
  date: z.string().min(1).max(40),
  description: z.string().max(1000),
  amount: z.string().min(1).max(40),
  currency: z.string().max(10).optional(),
});

/** All the ways a magnitude may be printed in a statement (with two decimals). */
export function amountForms(magnitude: string): string[] {
  const [intPart = "0", fracPart = ""] = magnitude.replace(/^-/, "").split(".");
  if (fracPart.length > 2) return [];
  const frac = fracPart.padEnd(2, "0");
  const group = (sep: string) => intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const forms = new Set<string>([`${intPart}.${frac}`, `${intPart},${frac}`]);
  if (intPart.length > 3) {
    for (const [thousands, decimal] of [[".", ","], [",", "."], ["'", "."], ["’", "."], [" ", ","], [" ", ","], [" ", ","], [" ", "."]] as const) {
      forms.add(`${group(thousands)}${decimal}${frac}`);
    }
  }
  return [...forms];
}

/** True when one of the printed forms of `magnitude` appears in `text` as a whole number. */
export function amountAppearsIn(magnitude: string, text: string): boolean {
  for (const form of amountForms(magnitude)) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(form, from);
      if (at < 0) break;
      const before = text.slice(Math.max(0, at - 2), at);
      const after = text.slice(at + form.length, at + form.length + 2);
      const glued = /\d$|\d[.,]$/.test(before) || /^\d|^[.,]\d/.test(after);
      if (!glued) return true;
      from = at + 1;
    }
  }
  return false;
}

export async function parsePdf(bytes: Uint8Array, ctx: DocumentParseContext = {}, deps: { extractLines?: typeof extractPdfLines } = {}): Promise<ParserOutput> {
  const extractLines = deps.extractLines ?? extractPdfLines;
  let lines = await extractLines(bytes);
  // A full-document fallback supersedes the old isolated-line assist.
  const original = await parsePdfLines(lines, ctx.documentAssist ? { ...ctx, aiAssist: undefined } : ctx);
  if (!ctx.documentAssist || !lines.length) return original;
  const layout = ctx.pdfLearning ? pdfLayoutKey(original, lines.flatMap(l => { const c = detectColumns(l); return c ? [c] : []; })) : undefined;
  // A learned reader is a fast path, not permission to skip current-file validation.
  if (ctx.pdfLearning && layout) {
    try {
      const confirmations = await ctx.pdfLearning.confirmations(layout);
      if (confirmations >= 2 && reusablePdf(original, lines)) return original;
      if (confirmations && !reusablePdf(original, lines)) await ctx.pdfLearning.invalidate(layout);
    } catch { console.warn("[import] PDF learning unavailable; using document AI"); }
  }
  if (!ctx.pdfLearning && !needsDocumentAi(original)) return original;
  let recoveredOriginal = original;
  try {
    // Unknown layouts may mix native text and outlined/image-only headers.
    // Bound visual recovery to small statements; oversized documents retain native extraction.
    if (needsDocumentAi(original) && lines.at(-1)!.page <= 20) {
      console.info("[import] Local PDF visual text recovery started");
      try {
        lines = await extractLines(bytes, true);
        console.info("[import] Local PDF visual text recovery completed");
      }
      catch { original.statement.warnings.push({ code: "row_unreadable", message: "Visual PDF text recovery failed; only native text was available." }); }
    }
    recoveredOriginal = await parsePdfLines(lines, { ...ctx, aiAssist: undefined });
    const result = await ctx.documentAssist(lines);
    const interpreted = validateDocumentInterpretation(result);
    if (!interpreted.statement.accounts.some(a => a.transactions.length || a.openingBalance || a.closingBalance)) {
      recoveredOriginal.statement.warnings.push(...interpreted.statement.warnings, { code: "ai_rejected_row", message: "AI could not produce a source-verified document interpretation." });
      return recoveredOriginal;
    }
    if (ctx.pdfLearning && layout) {
      try {
        if (canLearnPdf(recoveredOriginal, interpreted, result, lines)) await ctx.pdfLearning.confirm(layout);
        else await ctx.pdfLearning.invalidate(layout);
      } catch { console.warn("[import] PDF learning could not be updated"); }
    }
    return mergeDocumentInterpretation(recoveredOriginal, interpreted);
  } catch {
    recoveredOriginal.statement.warnings.push({ code: "ai_rejected_row", message: "Document AI interpretation failed; visually recovered deterministic extraction was retained." });
    return recoveredOriginal;
  }
}

/** Nubank account PDFs group undated, wrapped movements under dated daily totals. */
function parseNubankAccountLines(lines: PdfLine[]): ParserOutput | undefined {
  const firstPeriod = lines.findIndex((line) => fullDates(line.text, "DMY").length === 2 && /valores em r\$/i.test(line.text));
  if (firstPeriod < 0) return undefined;
  // Match the issuer's administrative footer, never bank names in counterparties.
  const issuer = lines.some((line) => /^(?:nu financeira s\.a\.|nu pagamentos s\.a\.)/i.test(line.text) || /nubank\.com\.br\/contatos/.test(line.text));
  const holder = lines.slice(0, firstPeriod).map((line) => line.text).join(" ");
  const identity = /ag[eê]ncia\s*:?[ ]*(\d+)\s+conta\s*:?[ ]*(\d[\d .]*-\d+)\b/i.exec(holder);
  if (!issuer || !identity || !/\b(?:CPF|CNPJ)\b/.test(holder)) return undefined;
  const dates = fullDates(lines[firstPeriod]!.text, "DMY");
  const period = { start: dates[0]!.date, end: dates[1]!.date };
  if (period.start > period.end) return undefined;
  const business = /\bCNPJ\b/.test(holder) && !/\bCPF\b/.test(holder);
  const warnings = new WarningSink();
  const transactions: ParsedTransaction[] = [];
  const account: ParsedAccount = {
    key: "default", type: "checking", currency: "BRL", country: "BR",
    identifier: `nubank:${identity[1]}:${identity[2]!.replace(/\D/g, "")}`,
    identifierMask: identity[2]!.replace(/\D/g, "").slice(-4),
    transactions,
  };
  let date: string | null = null;
  let dateRow: number | undefined;
  let group: { amount: string; total: ReturnType<typeof dec>; line: number } | undefined;
  let pending: ParsedTransaction | undefined;
  let pageHeader = true;
  let footer = false;
  let page = 0;
  const finishGroup = () => {
    if (group && !group.total.equals(group.amount)) warnings.add({
      code: "balance_mismatch", row: group.line,
      message: "Extracted movements do not match the printed daily total. Some transactions may be missing.",
    });
  };
  for (const line of lines) {
    if (line.page !== page) { page = line.page; pageHeader = true; footer = false; }
    const text = fold(line.text);
    if (pageHeader) {
      if (/valores em r\$/.test(text) && fullDates(line.text, "DMY").length === 2) pageHeader = false;
      continue;
    }
    if (/^(tem alguma duvida|caso a solucao|o saldo liquido|nao nos responsabilizamos|asseguramos a autenticidade|nu financeira|nu pagamentos|extrato gerado)/.test(text)) footer = true;
    if (footer) continue;
    const prefix = datePrefix(line.text, "DMY");
    const body = prefix ? fold(line.text.slice(prefix.length).trim()) : text;
    if (/^total de (entradas|saidas)\b/.test(body)) {
      if (!prefix && !date) continue; // Monthly summary, before any dated movements.
      finishGroup(); pending = undefined;
      if (prefix) {
        date = completeYear(prefix, period, undefined);
        dateRow = line.line;
        if (date && (date < period.start || date > period.end)) date = null;
      }
      const value = trailingAmount(line.text.split(" "));
      if (!date || !value) {
        group = undefined;
        warnings.add({ code: "row_unreadable", row: line.line, message: "Daily total has no readable date or amount." });
        continue;
      }
      group = { amount: body.startsWith("total de saidas") ? toPlain(dec(value.magnitude).negated()) : value.magnitude, total: dec("0"), line: line.line };
      continue;
    }
    if (/^(saldo inicial|saldo final do periodo)\b/.test(text)) {
      const value = trailingAmount(line.text.split(" "));
      if (value) {
        const amount = value.sign === "minus" ? toPlain(dec(value.magnitude).negated()) : value.magnitude;
        if (text.startsWith("saldo inicial")) account.openingBalance = { amount, asOf: period.start };
        else account.closingBalance = { amount, asOf: period.end };
      }
      continue;
    }
    if (/^(saldo|total|rendimento liquido|movimentacoes|r\$)\b/.test(text)) continue;
    const tokens = line.text.split(" ").filter(Boolean);
    const value = trailingAmount(tokens);
    if (date && group && value) {
      const description = normalizeDescription(tokens.slice(0, tokens.length - value.consumed).join(" "));
      if (!/\p{L}/u.test(description)) {
        warnings.add({ code: "row_unreadable", row: line.line, message: "Movement has no readable description." });
        pending = undefined; continue;
      }
      const amount = dec(group.amount).isNegative() ? toPlain(dec(value.magnitude).negated()) : value.magnitude;
      pending = {
        bookedOn: date, description, amount, currency: "BRL", sourceRow: line.line, extraction: "heuristic",
        raw: { line: line.text, page: String(line.page), date, amount: tokens.slice(tokens.length - value.consumed).join(" "), date_source_row: String(dateRow) },
      };
      transactions.push(pending);
      group.total = group.total.plus(amount);
    } else if (pending && !value) {
      // Preserve wrapped beneficiary details, including a continuation on the next page.
      pending.description = normalizeDescription(`${pending.description} ${line.text}`).slice(0, 1000);
      pending.raw.line = `${pending.raw.line}\n${line.text}`.slice(0, 2000);
    } else if (date && value && !group) {
      warnings.add({ code: "row_unreadable", row: line.line, message: "Movement has no preceding daily date and direction." });
    }
  }
  finishGroup();
  return {
    statement: { format: "pdf", profile: business ? "nubank-pj-pdf" : "nubank-account-pdf", accounts: [account], warnings: warnings.list },
    profileInstitution: { slug: business ? "nubank-pj" : "nubank", weak: false, evidence: "Nubank issuer footer and account-holder header" },
    statedPeriod: period,
  };
}

/** Generic positioned statement table; accepted only with complete source reconciliation. */
function parseReconciledTable(lines: PdfLine[]): ParserOutput | undefined {
  const headers = lines.filter(l => detectColumns(l)?.some(c => c.role === "amount") && detectColumns(l)?.some(c => c.role === "balance"));
  if (headers.length !== 1) return undefined;
  const header = headers[0]!;
  const columns = detectColumns(header)!;
  const preamble = lines.filter(l => l.line < header.line);
  const institutionText = preamble.map(l => l.text).join("\n");
  const issuer = findInstitutionByText(institutionText);
  const currency = currencyInText([header]);
  if (!issuer || !currency) return undefined;
  const periods = preamble.flatMap(l => {
    const match = /\b([a-zÀ-ÿ]+)\/(\d{4})\b/i.exec(l.text);
    const month = match && MONTHS[fold(match[1]!)];
    const start = month && iso(Number(match![2]), month, 1);
    return start ? [{ start, end: new Date(Date.UTC(Number(match![2]), month!, 0)).toISOString().slice(0, 10) }] : [];
  });
  const unique = [...new Map(periods.map(p => [p.start, p])).values()];
  if (unique.length !== 1) return undefined;
  const period = unique[0]!;
  let identifier: string | undefined;
  for (const label of preamble) {
    if (!/ag[eê]ncia/i.test(label.text)) continue;
    const accountColumn = label.items.find(i => /^conta(?: corrente)?$/i.test(i.text));
    const values = lines.find(l => l.line === label.line + 1);
    if (!accountColumn || !values) continue;
    const cell = values.items.filter(i => i.x >= accountColumn.x - 3).map(i => i.text).join("");
    if (/^\d[\d.-]*$/.test(cell)) identifier = `bank:${issuer.slug}:${cell.replace(/\D/g, "")}`;
  }
  if (!identifier) return undefined;
  const table = lines.filter(l => l.line > header.line && l.page === header.page);
  const balance = (line: PdfLine) => {
    const match = /^(?:saldo|balance) (?:em|on) (.+)$/i.exec(line.text);
    if (!match) return undefined;
    const date = datePrefix(match[1]!, "DMY");
    const asOf = date && completeYear(date, period, undefined);
    const tokens = columnAmounts(line, 0, columns)?.filter(a => a.role === "balance");
    if (!asOf || tokens?.length !== 1) return undefined;
    const t = tokens[0]!.reading;
    return { asOf, amount: t.sign === "minus" || t.sign === "debit" ? toPlain(dec(t.magnitude).negated()) : t.magnitude };
  };
  const start = table.findIndex(l => balance(l)?.asOf === addDays(period.start, -1) || balance(l)?.asOf === period.start);
  if (start < 0) return undefined;
  const opening = balance(table[start]!)!;
  let running = dec(opening.amount);
  let date: PartialDate | undefined;
  let dateRow: number | undefined;
  const transactions: ParsedTransaction[] = [];
  const usesMinus = table.some(l => columnAmounts(l, 0, columns)?.some(a => a.role === "amount" && ["minus", "debit"].includes(a.reading.sign)));
  for (const line of table.slice(start + 1)) {
    const closing = balance(line);
    if (closing) {
      if (closing.asOf !== period.end || !transactions.length || !running.equals(closing.amount)) return undefined;
      return { statement: { format: "pdf", profile: "pdf-column-statement", warnings: [], accounts: [{ key: "default", type: "checking", currency, identifier, identifierMask: identifier.replace(/\D/g, "").slice(-4), openingBalance: opening, closingBalance: closing, transactions }] }, institutionText, statedPeriod: period };
    }
    const prefix = datePrefix(line.text, "DMY");
    if (prefix) { date = prefix; dateRow = line.line; }
    const amounts = columnAmounts(line, prefix?.length ?? 0, columns);
    const moving = amounts?.filter(a => a.role === "amount") ?? [];
    if (!moving.length) {
      if (LOOKS_AMOUNT.test(line.text)) return undefined;
      continue; // Wrapped descriptions/date-time continuations are never movements.
    }
    if (!date || moving.length !== 1) return undefined;
    const parsed = readCandidate({ line, date: prefix ?? { ...date, length: 0 }, rest: line.text.slice(prefix?.length ?? 0) }, { columns, isCard: false, usesMinus, period, currency });
    if ("reason" in parsed || parsed.tx.bookedOn < period.start || parsed.tx.bookedOn > period.end) return undefined;
    running = running.plus(parsed.tx.amount);
    const printed = amounts?.filter(a => a.role === "balance") ?? [];
    if (printed.length > 1 || (printed.length === 1 && !running.equals(printed[0]!.reading.sign === "minus" ? toPlain(dec(printed[0]!.reading.magnitude).negated()) : printed[0]!.reading.magnitude))) return undefined;
    parsed.tx.raw.date_source_row = String(dateRow);
    transactions.push(parsed.tx);
  }
  return undefined;
}

/** Deterministic parsing of already-extracted lines (+ optional AI assist for ambiguous ones). */
export async function parsePdfLines(lines: PdfLine[], ctx: DocumentParseContext = {}): Promise<ParserOutput> {
  const nubank = parseNubankAccountLines(lines);
  if (nubank) return nubank;
  const ledger = parseSignedLedger(lines, ctx);
  if (ledger) return ledger;
  const reconciled = parseReconciledTable(lines);
  if (reconciled) return reconciled;
  const warnings = new WarningSink();

  // Pass 1: numeric date order across the whole document (header dates such as
  // "31/03/2026" in the period line prove day/month order too).
  const dateTokens = lines.flatMap((l) => l.text.match(/(?<![\d/.\-])\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}(?![\d/.\-])/g) ?? []);
  const order = inferDateOrder(dateTokens, "DMY");
  const orderProven = inferDateOrder(dateTokens, "YMD") !== "YMD";
  const documentCurrency = currencyInText(lines);

  // Pass 2: split candidate transaction lines from header/footer lines.
  const candidates: Candidate[] = [];
  const headerLines: PdfLine[] = [];
  for (const line of lines) {
    const date = datePrefix(line.text, order);
    if (date && LOOKS_AMOUNT.test(line.text)) {
      let rest = line.text.slice(date.length).trim();
      const valueDate = datePrefix(rest, order);
      if (valueDate && valueDate.numeric === date.numeric) rest = rest.slice(valueDate.length).trim();
      candidates.push({ line, date, valueDate: valueDate && valueDate.numeric === date.numeric ? valueDate : undefined, rest });
    } else {
      headerLines.push(line);
    }
  }
  const headerText = headerLines.map((l) => l.text).join("\n");
  const foldedHeader = fold(headerText);
  const isCard = CARD_MARKERS.test(foldedHeader) && !CHECKING_MARKERS.test(foldedHeader);

  // Statement period and reference date (for dates printed without a year).
  let period: { start: string; end: string } | undefined;
  let reference: string | undefined;
  for (const line of headerLines) {
    const monthHeader = /^([a-zÀ-ÿ]+)\/(\d{4})$/i.exec(line.text.trim());
    if (!period && monthHeader) {
      const month = MONTHS[fold(monthHeader[1]!)];
      const start = month ? iso(Number(monthHeader[2]), month, 1) : null;
      if (start) period = { start, end: new Date(Date.UTC(Number(monthHeader[2]), month, 0)).toISOString().slice(0, 10) };
    }
    const dates = fullDates(line.text, order);
    for (const d of dates) if (!reference || d.date > reference) reference = d.date;
    if (!period && dates.length >= 2) {
      const [first, second] = [dates[0]!, dates[1]!];
      const between = fold(line.text).slice(first.end, second.index);
      if (PERIOD_MARKERS.test(fold(line.text)) || PERIOD_CONNECTOR.test(between)) {
        const [a, b] = [first.date, second.date];
        period = a <= b ? { start: a, end: b } : { start: b, end: a };
      }
    }
  }

  // Currency: explicit symbols/codes in the document, else institution/user default.
  const institutionMatch = findInstitutionByText(headerText);
  const currency = resolvePdfCurrency(documentCurrency, institutionMatch?.slug, ctx.fallbackCurrency, warnings);

  // In an amount/balance table, a negative running balance says nothing
  // about the sign convention of unsigned movements.
  const amountColumns = lines.map(detectColumns).find(value => value !== undefined);
  const usesMinus = candidates.some(c => {
    if (amountColumns) return (columnAmounts(c.line, c.date.length, amountColumns) ?? []).some(a =>
      a.role !== "balance" && (a.reading.sign === "minus" || a.reading.sign === "debit"));
    const t = trailingAmount(c.rest.split(" "));
    return t?.sign === "minus" || t?.sign === "debit";
  });

  const transactions: ParsedTransaction[] = [];
  const ambiguous: Ambiguous[] = [];
  let opening: { amount: string; asOf: string } | undefined;
  let closing: { amount: string; asOf: string } | undefined;
  let columns: Column[] | undefined;
  const candidateByLine = new Map(candidates.map((c) => [c.line.line, c]));

  for (const line of lines) {
    const detected = detectColumns(line);
    if (detected) {
      columns = detected;
      continue;
    }
    const candidate = candidateByLine.get(line.line);
    const foldedText = fold(line.text);

    // Balance lines (with or without a leading date) are not transactions.
    const body = candidate ? fold(candidate.rest) : foldedText;
    const isOpening = OPENING_LINE.test(body);
    const isClosing = CLOSING_LINE.test(body);
    if (isOpening || isClosing || OTHER_BALANCE_LINE.test(body)) {
      if ((isOpening || isClosing) && !isCard) {
        const t = trailingAmount(line.text.split(" "));
        if (t) {
          const amount = t.sign === "minus" || t.sign === "debit" ? toPlain(dec(t.magnitude).negated()) : t.magnitude;
          const asOf = candidate ? completeYear(candidate.date, period, reference) : null;
          if (isOpening) opening = { amount, asOf: asOf ?? period?.start ?? "" };
          else closing = { amount, asOf: asOf ?? period?.end ?? "" };
        }
      }
      continue;
    }

    if (!candidate) {
      // Lines with a date and an amount somewhere (not at the start) are still suspicious.
      if (
        LOOKS_DATED.test(foldedText) &&
        LOOKS_AMOUNT.test(line.text) &&
        !PERIOD_MARKERS.test(foldedText) &&
        !SUMMARY_WORDS.test(foldedText) &&
        line.text.length <= 300
      ) {
        ambiguous.push({ line, reason: "date is not at the start of the line" });
      }
      continue;
    }

    const result = readCandidate(candidate, { columns, isCard, usesMinus, period, reference, currency });
    if ("reason" in result) {
      ambiguous.push({ line, reason: result.reason });
      continue;
    }
    transactions.push(result.tx);
  }

  // Statements in BRL/EUR/GBP/CHF come from day/month locales; others get a warning.
  const dmyLocale = documentCurrency !== undefined && DMY_CURRENCIES.has(documentCurrency);
  if (!orderProven && !dmyLocale && dateTokens.some((t) => {
    const m = /^(\d{1,2})[/.\-](\d{1,2})/.exec(t);
    return m && Number(m[1]) <= 12 && Number(m[2]) <= 12 && m[1] !== m[2];
  })) {
    warnings.add({ code: "ambiguous_date_order", message: "Dates could be day/month or month/day; read as day/month." });
  }

  // Ambiguous lines: warnings, optionally resolved by the AI assist hook.
  const ambiguousWarnings = new Map<number, ParseWarning>();
  for (const a of ambiguous) {
    ambiguousWarnings.set(a.line.line, {
      code: "row_unreadable",
      message: `Line looks like a transaction but could not be read deterministically (${a.reason}).`,
      row: a.line.line,
    });
  }
  if (ctx.aiAssist && ambiguous.length) {
    const sent = ambiguous.slice(0, MAX_AI_LINES).map((a) => ({ line: a.line.line, text: a.line.text.slice(0, MAX_AI_LINE_LENGTH) }));
    const accepted = await runAiAssist(ctx.aiAssist, sent, { period, currency, warnings });
    for (const tx of accepted) {
      ambiguousWarnings.delete(tx.sourceRow);
      transactions.push(tx);
    }
  }
  for (const w of ambiguousWarnings.values()) warnings.add(w);

  const account: ParsedAccount = { key: "default", currency, transactions };
  const type: AccountType | undefined = isCard ? "credit_card" : CHECKING_MARKERS.test(foldedHeader) ? "checking" : undefined;
  if (type) account.type = type;
  const firstMovement = Math.min(...candidates.map(c => c.line.line));
  const holderHeader = lines.filter(l => l.line < firstMovement).map(l => l.text).join(" ");
  const identity = /\bconta\s*:\s*(\d[\d.-]*)/i.exec(holderHeader);
  if (identity && institutionMatch && /\bag[eê]ncia\s*:/i.test(holderHeader)) {
    account.identifier = `bank:${institutionMatch.slug}:${identity[1]!.replace(/\D/g, "")}`;
    account.identifierMask = identity[1]!.replace(/\D/g, "").slice(-4);
  }
  const iban = findIban(headerText);
  if (iban) {
    account.identifier = iban;
    account.identifierMask = iban.slice(-4);
    account.country = iban.slice(0, 2);
  } else {
    const cardEnding = /(?:final|ending(?: in)?|terminante (?:in|con)|termina(?:da)? em|\*{4}|•{4}|x{4})\s*(\d{4})\b/i.exec(headerText);
    if (cardEnding) account.identifierMask = cardEnding[1];
  }
  if (opening?.asOf) account.openingBalance = opening;
  if (closing?.asOf) account.closingBalance = closing;

  return {
    statement: { format: "pdf", accounts: [account], warnings: warnings.list,
      profile: !isCard && columns?.some(c => c.role === "amount") && columns.some(c => c.role === "balance") &&
        account.identifier && account.closingBalance && period && transactions.length === candidates.length && !warnings.list.length
        ? "pdf-column-statement" : isCard ? "pdf-card-lines" : "pdf-lines" },
    institutionText: headerText,
    statedPeriod: period,
  };
}

interface ReadOptions {
  columns?: Column[];
  isCard: boolean;
  usesMinus: boolean;
  period?: { start: string; end: string };
  reference?: string;
  currency: string;
}

function readCandidate(c: Candidate, o: ReadOptions): { tx: ParsedTransaction } | { reason: string } {
  const bookedOn = completeYear(c.date, o.period, o.reference);
  if (!bookedOn) return { reason: c.date.year === undefined ? "cannot infer the year of the date" : "invalid date" };
  const valueOn = c.valueDate ? completeYear(c.valueDate, o.period, o.reference) : null;

  let amount: string;
  let description: string;
  let rawAmount: string;
  const amountItems = o.columns ? columnAmounts(c.line, c.date.length, o.columns) : undefined;
  if (amountItems && amountItems.length) {
    const moving = amountItems.filter((a) => a.role !== "balance");
    if (moving.length !== 1) return { reason: moving.length ? "several amounts in one line" : "no amount column" };
    const a = moving[0]!;
    if (a.role === "debit") amount = toPlain(dec(a.reading.magnitude).negated());
    else if (a.role === "credit") amount = a.reading.magnitude;
    else {
      const signed = signFor(a.reading, o);
      if (signed === undefined) return { reason: "amount direction is not stated" };
      amount = signed;
    }
    rawAmount = a.text;
    const firstAmountStart = Math.min(...amountItems.map((x) => x.start));
    description = c.line.text.slice(0, firstAmountStart).slice(c.date.length).trim();
    if (c.valueDate) description = description.replace(c.valueDate.raw, "").trim();
  } else {
    const tokens = c.rest.split(" ").filter(Boolean);
    const t = trailingAmount(tokens);
    if (!t) return { reason: "no amount at the end of the line" };
    const descTokens = tokens.slice(0, tokens.length - t.consumed);
    if (descTokens.length && trailingAmount(descTokens)) return { reason: "several amounts in one line" };
    const signed = signFor(t, o);
    if (signed === undefined) return { reason: "amount direction is not stated" };
    amount = signed;
    rawAmount = tokens.slice(tokens.length - t.consumed).join(" ");
    description = descTokens.join(" ");
  }
  description = normalizeDescription(description.replace(/^(?:as\s+)?\d{1,2}:\d{2}(?::\d{2})?\s+/i, "").replace(/^(?:às\s+)?\d{1,2}:\d{2}(?::\d{2})?\s+/i, ""));
  if (!/\p{L}/u.test(description)) return { reason: "no description" };

  const tx: ParsedTransaction = {
    bookedOn,
    description,
    amount,
    currency: o.currency,
    sourceRow: c.line.line,
    raw: { line: c.line.text, page: String(c.line.page), date: c.date.raw, amount: rawAmount },
    extraction: "heuristic",
  };
  if (valueOn) tx.valueOn = valueOn;
  return { tx };
}

/** Signed amount from an explicit marker or the statement's conventions; undefined when unknowable. */
function signFor(reading: AmountReading, o: ReadOptions): string | undefined {
  const negative = toPlain(dec(reading.magnitude).negated());
  switch (reading.sign) {
    case "debit":
      return negative;
    case "credit":
    case "plus":
      return reading.magnitude;
    case "minus":
      // On a card bill a minus marks a payment/credit to the card account.
      return o.isCard ? reading.magnitude : negative;
    case "none":
      if (o.isCard) return negative; // card bills list purchases unsigned
      return o.usesMinus ? reading.magnitude : undefined;
  }
}

function columnAmounts(line: PdfLine, dateLength: number, columns: Column[]) {
  const out: { role: ColumnRole; reading: AmountReading; text: string; start: number }[] = [];
  for (const item of line.items) {
    if (item.end <= dateLength) continue;
    const reading = readAmountToken(item.text.replace(/\s+/g, ""));
    if (!reading) continue;
    const center = item.x + item.width / 2;
    let best: Column | undefined;
    for (const col of columns) if (!best || Math.abs(col.center - center) < Math.abs(best.center - center)) best = col;
    if (!best || Math.abs(best.center - center) > 150) return undefined;
    out.push({ role: best.role, reading, text: item.text, start: item.start });
  }
  return out;
}

const DMY_CURRENCIES = new Set(["BRL", "EUR", "GBP", "CHF"]);

/** Most frequent currency symbol/code written in the document, if any. */
function currencyInText(lines: PdfLine[]): string | undefined {
  const counts = new Map<string, number>();
  const pattern = /R\$|US\$|€|£|\b(?:EUR|BRL|USD|GBP|CHF)\b/g;
  for (const line of lines.slice(0, 2000)) {
    for (const m of line.text.matchAll(pattern)) {
      const code = normalizeCurrencyCode(m[0]);
      if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function resolvePdfCurrency(
  documentCurrency: string | undefined,
  institutionSlug: string | undefined,
  fallback: string | undefined,
  warnings: WarningSink,
): string {
  if (documentCurrency) return documentCurrency;
  const institutionCurrency = institutionSlug ? getInstitution(institutionSlug)?.defaultCurrency : undefined;
  if (institutionCurrency) return institutionCurrency;
  const fb = fallback ? normalizeCurrencyCode(fallback) : undefined;
  if (fb) return fb;
  warnings.add({
    code: "unknown_currency",
    message: "The document does not state its currency; transactions are marked XXX until confirmed.",
  });
  return "XXX";
}

async function runAiAssist(
  assist: NonNullable<DocumentParseContext["aiAssist"]>,
  sent: { line: number; text: string }[],
  o: { period?: { start: string; end: string }; currency: string; warnings: WarningSink },
): Promise<ParsedTransaction[]> {
  let proposed: unknown;
  try {
    proposed = await assist(sent);
  } catch (error) {
    o.warnings.add({
      code: "ai_rejected_row",
      message: `AI assist failed (${error instanceof Error ? error.name : "error"}); ambiguous lines were left unread.`,
    });
    return [];
  }
  if (!Array.isArray(proposed)) {
    o.warnings.add({ code: "ai_rejected_row", message: "AI assist returned an invalid response; ignored." });
    return [];
  }
  const sentByLine = new Map(sent.map((s) => [s.line, s.text]));
  const used = new Set<number>();
  const accepted: ParsedTransaction[] = [];
  for (const candidate of proposed.slice(0, sent.length * 2)) {
    const reject = (reason: string, row?: number) =>
      o.warnings.add({ code: "ai_rejected_row", message: `AI-proposed row rejected: ${reason}.`, row });
    const parsed = AiRowSchema.safeParse(candidate);
    if (!parsed.success) {
      reject("malformed row");
      continue;
    }
    const row: AiProposedRow = parsed.data;
    const text = sentByLine.get(row.line);
    if (text === undefined) {
      reject(`line ${row.line} was not sent for review`, row.line);
      continue;
    }
    if (used.has(row.line)) {
      reject("more than one transaction proposed for the same line", row.line);
      continue;
    }
    const date = parseDate(row.date.trim(), "DMY");
    if (!date) {
      reject("invalid date", row.line);
      continue;
    }
    if (o.period && (date < addDays(o.period.start, -31) || date > addDays(o.period.end, 31))) {
      reject("date outside the statement period", row.line);
      continue;
    }
    const amount = parseAmount(row.amount.trim());
    if (!amount || dec(amount.amount).isZero()) {
      reject("invalid amount", row.line);
      continue;
    }
    if (!amountAppearsIn(toPlain(dec(amount.amount).abs()), text)) {
      reject("amount does not appear in the line", row.line);
      continue;
    }
    const description = normalizeDescription(row.description);
    if (!description) {
      reject("empty description", row.line);
      continue;
    }
    let currency = o.currency;
    if (row.currency) {
      const code = normalizeCurrencyCode(row.currency) ?? row.currency.trim().toUpperCase();
      if (!isKnownCurrency(code)) {
        reject("unknown currency", row.line);
        continue;
      }
      currency = code;
    }
    used.add(row.line);
    accepted.push({
      bookedOn: date,
      description,
      amount: amount.amount,
      currency,
      sourceRow: row.line,
      raw: { line: text },
      extraction: "ai",
    });
  }
  return accepted;
}
