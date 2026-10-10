/**
 * Structure-inferring reader for statement PDFs no other reader recognizes.
 *
 * It assumes nothing about the bank or the layout. It looks for what every
 * statement has — dated movements with one amount each — in whatever shape
 * they are printed: one row per movement, a card of several lines per
 * movement, cards side by side, a day number under a month heading; one signed
 * amount column, separate debit/credit columns in any order, a direction word
 * next to the amount, with or without a running balance.
 *
 * What each amount column means is not guessed from its position: every
 * possible assignment is tried and checked against the arithmetic the document
 * prints about itself — the running balance, opening + movements = closing,
 * the totals of money in and out. Header names are only a tie-break. A reading
 * that the document proves is `verified`; one that merely contradicts nothing
 * is returned only when signs and columns are stated outright; anything else is
 * refused (undefined), never guessed.
 */
import { inferDateOrder, parseDate, type DateOrder } from "@/domain/import/parse-date";
import type { ParsedAccount, ParsedTransaction, ParseWarning } from "@/domain/import/types";
import { D, dec, toPlain, type DecimalValue } from "@/domain/money/decimal";
import { findIban, findInstitutionByText, findIssuerName } from "../institution-catalog";
import { roleOfHeader } from "../profiles/generic";
import { currencyInText, fullDates, isCardStatementText, isCheckingStatementText, readAmountToken, type AmountReading, type PdfLine } from "./pdf";
import { fold, normalizeDescription } from "./text";
import type { DocumentParseContext, ParserOutput } from "./types";

export const PDF_INFERRED_PROFILE = "pdf-inferred";

const FULL_DATE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2}))$/;
const PARTIAL_DATE = /^(\d{1,2})[/.\-](\d{1,2})$/;
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2})|\d{1,2}[/.\-]\d{1,2})\s+(\S.*)$/;
/** "05 Mar", "5 de março de 2026", "05-mag-26": a date whose month is written out. */
const NAMED_DATE = /^(\d{1,2})(?:\s+de)?[\s\-/.]+([a-zç]{3,9})\.?(?:(?:\s+de)?[\s\-/.]+(\d{4}|\d{2}))?$/;
const DAY = /^\d{1,2}$/;
const PLACEHOLDER = /^[—–\-_.·•*=]+$/;
const CURRENCY_TAIL = /\s*\(?(?:EUR|BRL|USD|GBP|CHF|R\$|€|£|\$)\)?$/;
/** "2026-07", "07/2026", "luglio 2026": a heading that dates the day numbers under it. */
const YEAR_MONTH = /^(?:(\d{4})[-/.](\d{1,2})|(\d{1,2})[-/.](\d{4})|([a-zç]{3,10})\.?(?:\s+de)?[\s/\-.]+(\d{4}))$/;
/** A line that only carries a reference code: "ID 220915", "Rif: 377519", "Protocolo 760397". */
const REFERENCE = /^(?:id|ref|rif|riferimento|referencia|reference|protocolo|protocollo|nsu|doc|documento|aut|autenticacao|codice|codigo|code|cro|trn|n|no|nr|num|numero)\s*[.:#º°]*\s*[a-z0-9][a-z0-9\-/.]*\d[a-z0-9\-/.]*$/;

const DEBIT_WORDS = new Set(["debito", "debitos", "debit", "debits", "dare", "addebito", "addebiti", "uscita", "uscite", "saida", "saidas", "withdrawal", "withdrawals", "soll", "dr", "db", "d"]);
const CREDIT_WORDS = new Set(["credito", "creditos", "credit", "credits", "avere", "accredito", "accrediti", "entrata", "entrate", "entrada", "entradas", "deposit", "deposits", "haben", "cr", "c"]);
/** A labelled account number: "Conta 12345-6", "Conto n. 000123456", "Account number: 12-345-678". */
const ACCOUNT_NUMBER = /(?<![a-z])(?:conta(?: corrente)?|conto(?: corrente)?|account(?: number| no)?|konto(?:nummer)?|c\/c)\s*(?:n[.ºo°]*\s*)?[:#]?\s*(\d[\d.\-/]{2,24}\d)(?![\d.,]\d)/;
/** Stand-in x for amounts split out of a fragment that holds a whole row. */
const VIRTUAL_COLUMN = 1_000_000;
const LOOKS_AMOUNT = /\d[.,]\d{2}(?!\d)/;
const LOOKS_DATE = /\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{2}-\d{2}/;

type FactKind = "opening" | "closing" | "in" | "out";
const FACT_LABELS: [FactKind, RegExp][] = [
  ["opening", /^(saldo (anterior|inicial|iniziale|inizio|precedente|di apertura|de abertura)|iniziale|inicial|opening balance|previous balance|balance brought forward|anfangssaldo|alter kontostand|solde (initial|precedent))\b/],
  ["closing", /^(saldo (final|finale|fine|di chiusura|atual|attuale|contabile finale)|finale?|closing balance|new balance|ending balance|balance carried forward|endsaldo|neuer kontostand|solde final|nouveau solde|(il tuo )?nuovo saldo|novo saldo)\b/],
  ["in", /^(entradas|entrate|creditos|accrediti|total (de |das? )?(entradas|creditos)|totale (delle )?(entrate|accrediti|avere)|money in|paid in|total credits|total deposits|deposits|einzahlungen)\b/],
  ["out", /^(saidas|uscite|debitos|addebiti|total (de |das? )?(saidas|debitos)|totale (delle )?(uscite|addebiti|dare)|money out|paid out|total debits|total withdrawals|withdrawals|auszahlungen)\b/],
];

const MONTH_NAMES: Record<string, number> = {
  jan: 1, gen: 1, ene: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, mag: 5, jun: 6, giu: 6, jul: 7, lug: 7,
  aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, ott: 10, okt: 10, nov: 11, dec: 12, dez: 12, dic: 12,
};

interface Box {
  left: number;
  right: number;
}
type Atom = Box & { raw: string } & (
  | { kind: "money"; reading: AmountReading }
  | { kind: "date"; partial: boolean; named?: boolean }
  | { kind: "direction"; sign: 1 | -1 }
  | { kind: "text" }
);

interface Row {
  line: PdfLine;
  atoms: Atom[];
  band: number;
  /** x of the band's left edge, so that columns compare across side-by-side cards. */
  origin: number;
}

function readMoney(text: string): AmountReading | undefined {
  const compact = text.replace(/\s+/g, "");
  return readAmountToken(compact) ?? readAmountToken(compact.replace(CURRENCY_TAIL, ""));
}

function labelKind(text: string): FactKind | undefined {
  const label = fold(text).replace(/[:.\s]+$/, "");
  return FACT_LABELS.find(([, pattern]) => pattern.test(label))?.[0];
}

/** Splits one positioned fragment into what it holds: a date, an amount, a direction word, text. */
function atomsOf(item: PdfLine["items"][number]): Atom[] {
  const box = { left: item.x, right: item.x + item.width };
  let text = item.text.trim();
  if (!text || PLACEHOLDER.test(text)) return [];
  const out: Atom[] = [];
  const whole = readMoney(text);
  if (whole) return [{ ...box, kind: "money", reading: whole, raw: text }];
  const named = NAMED_DATE.exec(fold(text));
  if (named && MONTH_NAMES[named[2]!.slice(0, 3)]) return [{ ...box, kind: "date", partial: !named[3], named: true, raw: text }];
  const leading = FULL_DATE.test(text) || PARTIAL_DATE.test(text) ? [text, text, ""] : LEADING_DATE.exec(text);
  if (leading) {
    out.push({ ...box, kind: "date", partial: PARTIAL_DATE.test(leading[1]!), raw: leading[1]! });
    text = leading[2]!;
    if (!text) return out;
  }
  const word = fold(text);
  if (DEBIT_WORDS.has(word) || CREDIT_WORDS.has(word)) return [...out, { ...box, kind: "direction", sign: DEBIT_WORDS.has(word) ? -1 : 1, raw: text }];
  // Amounts glued to the end of their text: "Saldo finale: 2.001,72 (EUR)", or a
  // whole table row drawn as one fragment ("Coffee shop 4,50 D 995,50"). They
  // have no position of their own: the nth from the end stands for a column.
  let body = text.replace(CURRENCY_TAIL, "");
  const tails: Atom[] = [];
  while (tails.length < 3) {
    const words = body.split(" ");
    const take = words.length > 2 && /^(?:D|C|DR|CR|DB|[-+])$/.test(words.at(-1)!) ? 2 : 1;
    const reading = words.length > take ? readMoney(words.slice(-take).join("")) : undefined;
    if (!reading) break;
    const column = VIRTUAL_COLUMN - tails.length * 1000;
    tails.unshift({ left: column, right: column, kind: "money", reading, raw: words.slice(-take).join(" ") });
    body = words.slice(0, -take).join(" ").replace(CURRENCY_TAIL, "");
  }
  if (tails.length && /\p{L}/u.test(body)) return [...out, { ...box, kind: "text", raw: body.trim() }, ...tails];
  return [...out, { ...box, kind: "text", raw: text }];
}

const signedValue = (reading: AmountReading): DecimalValue => (reading.sign === "minus" || reading.sign === "debit" ? dec(reading.magnitude).negated() : dec(reading.magnitude));

/** Groups values lying within `gap` of their neighbour; returns the group index of each value. */
function cluster(values: number[], gap: number): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  let group = -1;
  let previous = -Infinity;
  for (const { value, index } of order) {
    if (value - previous > gap) group++;
    out[index] = group;
    previous = value;
  }
  return out;
}

function statedPeriod(lines: PdfLine[], order: DateOrder): { start: string; end: string } | undefined {
  for (const line of lines) {
    const dates = fullDates(line.text, order);
    if (dates.length !== 2 || dates[0]!.date > dates[1]!.date) continue;
    const between = line.text.slice(dates[0]!.end, dates[1]!.index).trim();
    if (between.length <= 10 && !/\d/.test(between)) return { start: dates[0]!.date, end: dates[1]!.date };
  }
  return undefined;
}

interface Movement {
  rows: Row[];
  anchor: Atom & { kind: "date" | "text" };
  /** Year and month from the heading above, when the anchor is a day number. */
  month?: { year: number; month: number };
  valueDate?: Atom;
  money: (Atom & { kind: "money"; column: number })[];
  direction?: 1 | -1;
  /** Everything but the anchor, in reading order; amounts that turn out to be no column stay in the text. */
  parts: Atom[];
  /** The words alone. */
  text: string;
  reference?: string;
}

type Role = "amount" | "debit" | "credit" | "balance" | "ignore";
const ROLES: Role[] = ["amount", "debit", "credit", "balance", "ignore"];

interface Reading {
  roles: Role[];
  amounts: DecimalValue[];
  balances: (DecimalValue | undefined)[];
  passes: number;
  hints: number;
}

export interface InferredStatement {
  output: ParserOutput;
  /** The document's own balances or totals prove the reading. */
  verified: boolean;
}

export function parsePdfStructure(lines: PdfLine[], ctx: DocumentParseContext = {}): InferredStatement | undefined {
  if (!lines.length) return undefined;
  const fullTokens = lines.flatMap((l) => l.text.match(/(?<![\d/.\-])\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}(?![\d/.\-])/g) ?? []);
  const order = inferDateOrder(fullTokens, "DMY");
  const period = statedPeriod(lines, order);
  const currency = currencyInText(lines) ?? ctx.fallbackCurrency;
  if (!currency) return undefined;

  // Page furniture: the same line at the same height on every page.
  const pages = new Set(lines.map((l) => l.page)).size;
  const furniture = new Set<number>();
  if (pages > 1) {
    const seen = new Map<string, PdfLine[]>();
    for (const l of lines) {
      const key = `${Math.round(l.y ?? -1)}|${l.text.replace(/\d+/g, "#")}`;
      seen.set(key, [...(seen.get(key) ?? []), l]);
    }
    for (const group of seen.values()) if (new Set(group.map((l) => l.page)).size === pages) for (const l of group) furniture.add(l.line);
  }
  let rows: Row[] = lines.filter((l) => !furniture.has(l.line)).map((line) => ({ line, atoms: line.items.flatMap(atomsOf), band: 0, origin: 0 }));

  // Balances and totals the document states about itself.
  const facts = new Map<FactKind, DecimalValue | null>();
  const boundaries = new Set<number>();
  const state = (kind: FactKind, value: DecimalValue) => {
    const amount = kind === "in" || kind === "out" ? value.abs() : value;
    const known = facts.get(kind);
    facts.set(kind, known === undefined || (known && known.equals(amount)) ? amount : null);
  };
  const isMoney = (a: Atom): a is Atom & { kind: "money" } => a.kind === "money";
  for (const [i, row] of rows.entries()) {
    const next = rows[i + 1];
    const texts = row.atoms.filter((a) => a.kind === "text");
    const money = row.atoms.filter(isMoney);
    const dated = row.atoms.some((a) => a.kind === "date");
    // A row of labels above a row of their values.
    if (!dated && !money.length && texts.length >= 2 && texts.filter((a) => labelKind(a.raw)).length >= 2 && next && next.line.page === row.line.page && next.atoms.length === texts.length && next.atoms.every(isMoney)) {
      for (const label of texts) {
        const kind = labelKind(label.raw);
        const value = next.atoms.filter(isMoney).reduce((best, a) => (Math.abs(a.left - label.left) < Math.abs(best.left - label.left) ? a : best));
        if (kind) state(kind, signedValue(value.reading));
      }
      boundaries.add(row.line.line).add(next.line.line);
      row.atoms = [];
      next.atoms = [];
      continue;
    }
    // A label and its value on one line.
    const kind = !dated && money.length === 1 && texts.length ? labelKind(texts.map((a) => a.raw).join(" ")) : undefined;
    if (kind) {
      state(kind, signedValue(money[0]!.reading));
      boundaries.add(row.line.line);
      row.atoms = [];
      continue;
    }
    // A label with its value right under it.
    for (const label of texts) {
      const stacked = labelKind(label.raw);
      const under = stacked && next && next.line.page === row.line.page ? next.atoms.filter(isMoney).find((a) => Math.abs(a.left - label.left) <= 4 || Math.abs(a.right - label.right) <= 4) : undefined;
      if (!stacked || !under || money.length) continue;
      state(stacked, signedValue(under.reading));
      boundaries.add(row.line.line).add(next!.line.line);
      row.atoms = row.atoms.filter((a) => a !== label);
      next!.atoms = next!.atoms.filter((a) => a !== under);
    }
  }
  const fact = (kind: FactKind) => facts.get(kind) ?? undefined;

  // Column headers: names for the columns, and never part of a movement.
  const headerColumns: (Box & { role: Role | "date" | "valueDate" })[] = [];
  for (const row of rows) {
    if (row.atoms.length < 2 || row.atoms.some((a) => a.kind === "money" || a.kind === "date")) continue;
    const named = row.line.items.map((item) => ({ item, role: roleOfHeader(item.text) })).filter((n) => n.role);
    if (new Set(named.map((n) => n.role)).size < 2 || !named.some((n) => n.role === "date" || n.role === "description")) continue;
    for (const { item, role } of named) {
      const box = { left: item.x, right: item.x + item.width };
      if (role === "amount" || role === "debit" || role === "credit" || role === "balance" || role === "date" || role === "valueDate") headerColumns.push({ ...box, role });
      else if (role === "valuta") headerColumns.push({ ...box, role: "valueDate" });
    }
    boundaries.add(row.line.line);
    row.atoms = [];
  }
  rows = rows.filter((r) => r.atoms.length || boundaries.has(r.line.line));

  // Cards printed side by side: rows holding nothing but several dates give the bands.
  const dateRows = rows.filter((r) => r.atoms.length >= 2 && r.atoms.every((a) => a.kind === "date"));
  const bandCount = Math.max(0, ...dateRows.map((r) => r.atoms.length));
  const bandRows = dateRows.filter((r) => r.atoms.length === bandCount);
  if (bandCount >= 2 && bandRows.every((r) => r.atoms.every((a, i) => Math.abs(a.left - bandRows[0]!.atoms[i]!.left) <= 4))) {
    const edges = bandRows[0]!.atoms.map((a) => a.left - 8);
    const bandOf = (a: Atom) => Math.max(0, edges.findLastIndex((edge) => a.left >= edge));
    const split: (Row & { block: number })[] = [];
    let block = 0;
    for (const row of rows) {
      if (dateRows.includes(row)) block++;
      if (!row.atoms.length) { split.push({ ...row, block }); continue; }
      for (let band = 0; band < bandCount; band++) {
        const atoms = row.atoms.filter((a) => bandOf(a) === band);
        if (atoms.length) split.push({ line: row.line, atoms, band, origin: edges[band]!, block });
      }
    }
    // Card by card: left to right, then down.
    rows = split.map((row, index) => ({ row, index })).sort((a, b) => a.row.block - b.row.block || a.row.band - b.row.band || a.index - b.index).map(({ row }) => row);
  }

  // What starts a movement: a full date, a day-month, or a day number under a month heading.
  const first = (row: Row) => row.atoms[0];
  const isDate = (a: Atom): a is Atom & { kind: "date" } => a.kind === "date";
  const monthOf = (row: Row): { year: number; month: number } | undefined => {
    if (row.atoms.length !== 1 || row.atoms[0]!.kind !== "text") return undefined;
    const m = YEAR_MONTH.exec(fold(row.atoms[0]!.raw));
    if (!m) return undefined;
    const year = Number(m[1] ?? m[4] ?? m[6]);
    const month = m[5] ? MONTH_NAMES[m[5].slice(0, 3)] : Number(m[2] ?? m[3]);
    return month && month >= 1 && month <= 12 && year >= 1970 && year <= 2100 ? { year, month } : undefined;
  };
  // The date column is where most rows have their (first) date, wherever it sits in the row.
  const leads = (partial: boolean) => {
    const dates = rows.flatMap((r) => { const a = r.atoms.find(isDate); return a && a.partial === partial ? [{ row: r, left: a.left - r.origin }] : []; });
    const groups = cluster(dates.map((d) => d.left), 4);
    const size = (group: number) => groups.filter((g) => g === group).length;
    const main = groups.reduce((best, g) => (size(g) > size(best) ? g : best), groups[0] ?? 0);
    return dates.filter((_, i) => groups[i] === main).map((d) => d.row);
  };
  const dayRows = rows.some(monthOf) ? rows.filter((r) => { const a = first(r); return a?.kind === "text" && DAY.test(a.raw) && Number(a.raw) >= 1 && Number(a.raw) <= 31; }) : [];
  const dayLeft = dayRows.length ? [...dayRows].sort((a, b) => dayRows.filter((r) => Math.abs(first(r)!.left - first(b)!.left) <= 2).length - dayRows.filter((r) => Math.abs(first(r)!.left - first(a)!.left) <= 2).length)[0]!.atoms[0]!.left : 0;
  const days = dayRows.filter((r) => Math.abs(first(r)!.left - dayLeft) <= 2);
  const mode = [{ kind: "full" as const, anchors: leads(false) }, { kind: "partial" as const, anchors: leads(true) }, { kind: "day" as const, anchors: days }].sort((a, b) => b.anchors.length - a.anchors.length)[0]!;
  if (!mode.anchors.length) return undefined;
  const anchors = new Set(mode.anchors);

  const movement = (own: Row[], anchor: Movement["anchor"], month: Movement["month"]): Movement => {
    const atoms = own.flatMap((row) => row.atoms.filter((a) => a !== anchor).map((atom) => ({ atom, row })));
    const referenceRow = own.find((row) => row.atoms.length === 1 && row.atoms[0]!.kind === "text" && REFERENCE.test(fold(row.atoms[0]!.raw)));
    const valueDate = own[0]!.atoms.find((a) => a !== anchor && a.kind === "date");
    const parts = atoms.filter(({ atom, row }) => row !== referenceRow && atom !== valueDate && atom.kind !== "direction").map(({ atom }) => atom);
    return {
      rows: own,
      anchor,
      month,
      valueDate,
      money: atoms.filter(({ atom }) => atom.kind === "money").map(({ atom, row }) => ({ ...(atom as Atom & { kind: "money" }), left: atom.left - row.origin, right: atom.right - row.origin, column: -1 })),
      direction: atoms.map(({ atom }) => atom).find((a): a is Atom & { kind: "direction" } => a.kind === "direction")?.sign,
      parts,
      text: parts.filter((a) => a.kind !== "money").map((a) => a.raw).join(" "),
      reference: referenceRow?.atoms[0]!.raw,
    };
  };
  /**
   * Several movements under one date: when more than one line of a movement
   * carries an amount, and each of those lines says what it is, every such line
   * is a movement of that day (with the amount-less lines under it).
   */
  const perAmountLine = (m: Movement): Movement[] => {
    const paying = m.rows.filter((row) => row.atoms.some((a) => a.kind === "money"));
    if (paying.length < 2 || !paying.every((row) => row.atoms.some((a) => a !== m.anchor && a.kind === "text"))) return [m];
    return paying.map((row, i) => movement(m.rows.slice(m.rows.indexOf(row), i + 1 < paying.length ? m.rows.indexOf(paying[i + 1]!) : undefined), m.anchor, m.month));
  };

  // Movements: from one anchor to the next (or to a heading, a balance line, the end of the page).
  const movements: Movement[] = [];
  // Text that sits before the first movement of a page exactly where descriptions
  // do means part of a description is printed above its dated line: which movement
  // each line belongs to cannot be told from the order of the lines alone.
  const above: Row[] = [];
  let loose: Row[] = [];
  const pending: Row[][] = [];
  let open: Row[] | undefined;
  let month: { year: number; month: number } | undefined;
  const months = new Map<Row[], { year: number; month: number } | undefined>();
  const interior = new Set<Row[]>();
  let previous: Row | undefined;
  for (const row of rows) {
    const heading = mode.kind === "day" ? monthOf(row) : undefined;
    const breaks = !row.atoms.length || heading !== undefined || (previous !== undefined && (previous.line.page !== row.line.page || previous.band !== row.band));
    if (breaks) loose = [];
    if (anchors.has(row)) {
      above.push(...loose);
      loose = [];
      open = [row];
      pending.push(open);
      months.set(open, month);
    } else if (breaks) open = undefined;
    else if (open) open.push(row);
    else if (row.atoms.every((a) => a.kind === "text")) loose.push(row);
    if (heading) month = heading;
    previous = row;
  }
  // The last movement of a page (or of a column of cards) has no next anchor to
  // close it: it only keeps the lines that sit where the lines of other movements do.
  const lastOf = new Map<string, Row[]>();
  for (const group of pending) lastOf.set(`${group[0]!.line.page}|${group[0]!.band}`, group);
  for (const group of pending) if (lastOf.get(`${group[0]!.line.page}|${group[0]!.band}`) !== group) interior.add(group);
  const textLefts: number[] = [];
  const moneyEdges: number[] = [];
  for (const group of pending) {
    if (!interior.has(group)) continue;
    for (const row of group.slice(1)) for (const a of row.atoms) {
      if (a.kind === "money") moneyEdges.push(a.left - row.origin, a.right - row.origin);
      else textLefts.push(a.left - row.origin);
    }
  }
  const near = (edges: number[], x: number) => edges.some((edge) => Math.abs(edge - x) <= 4);
  if (above.some((row) => near(textLefts, row.atoms[0]!.left - row.origin))) return undefined;
  // Amounts line up on either edge; text starts where other text does.
  const fits = (row: Row) => row.atoms.every((a) => (a.kind === "money" ? near(moneyEdges, a.left - row.origin) || near(moneyEdges, a.right - row.origin) : near(textLefts, a.left - row.origin)));
  for (const group of pending) {
    let kept = group;
    if (!interior.has(group) && interior.size) {
      const stop = group.findIndex((row, i) => i > 0 && !fits(row));
      if (stop > 0) kept = group.slice(0, stop);
    }
    const head = kept[0]!;
    const anchor = (mode.kind === "day" ? head.atoms[0] : head.atoms.find(isDate)) as Movement["anchor"];
    movements.push(movement(kept, anchor, months.get(group)));
  }

  const solved = solve(movements) ?? undefined;
  const split = solved?.verified || !movements.some((m) => perAmountLine(m).length > 1) ? undefined : solve(movements.flatMap(perAmountLine));
  const chosen = split && (split.verified || !solved) ? split : solved;
  if (!chosen) return undefined;
  const { dated, reading, verified } = chosen;

  function solve(candidates: Movement[]): { dated: Movement[]; reading: Reading; verified: boolean } | undefined {
  // A dated line without any amount is not a movement.
  const dated = candidates.filter((m) => m.money.length);
  if (!dated.length) return undefined;

  // Amount columns, by where the amounts end (they are usually right-aligned) or start.
  const cells = dated.flatMap((m) => m.money);
  const byRight = cluster(cells.map((c) => c.right), 4);
  const byLeft = cluster(cells.map((c) => c.left), 4);
  const columnOf = Math.max(...byLeft) < Math.max(...byRight) ? byLeft : byRight;
  cells.forEach((cell, i) => (cell.column = columnOf[i]!));
  const columns = Math.max(...columnOf) + 1;
  if (columns > 4) return undefined;
  const columnBox = (column: number): Box => {
    const own = cells.filter((c) => c.column === column);
    return { left: Math.min(...own.map((c) => c.left)), right: Math.max(...own.map((c) => c.right)) };
  };
  const hinted: (Role | undefined)[] = Array.from({ length: columns }, (_, column) => {
    const box = columnBox(column);
    const distance = (h: Box) => Math.min(Math.abs(h.right - box.right), Math.abs(h.left - box.left), Math.abs((h.left + h.right) / 2 - (box.left + box.right) / 2));
    const named = headerColumns.filter((h) => h.role !== "date" && h.role !== "valueDate").sort((a, b) => distance(a) - distance(b))[0];
    return named && distance(named) <= 45 ? (named.role as Role) : undefined;
  });
  const explicit = Array.from({ length: columns }, (_, column) => cells.some((c) => c.column === column && c.reading.sign !== "none"));

  const read = (roles: Role[], newestFirst: boolean): Reading | undefined => {
    const count = (role: Role) => roles.filter((r) => r === role).length;
    if (count("balance") > 1 || count("amount") > 1 || count("debit") > 1 || count("credit") > 1) return undefined;
    if (count("amount") ? count("debit") + count("credit") > 0 : count("debit") + count("credit") === 0) return undefined;
    const amounts: DecimalValue[] = [];
    const balances: (DecimalValue | undefined)[] = [];
    let running = fact("opening");
    for (const m of newestFirst ? [...dated].reverse() : dated) {
      const moving = m.money.filter((c) => roles[c.column] !== "balance" && roles[c.column] !== "ignore" && !dec(c.reading.magnitude).isZero());
      const printed = m.money.filter((c) => roles[c.column] === "balance");
      if (moving.length !== 1 || printed.length > 1) return undefined;
      const cell = moving[0]!;
      const role = roles[cell.column]!;
      const magnitude = dec(cell.reading.magnitude);
      const balance = printed[0] ? signedValue(printed[0].reading) : undefined;
      let amount: DecimalValue | undefined;
      if (role === "debit") amount = magnitude.negated();
      else if (role === "credit") amount = magnitude;
      else if (cell.reading.sign !== "none") amount = signedValue(cell.reading).isNegative() ? magnitude.negated() : magnitude;
      else if (m.direction) amount = m.direction < 0 ? magnitude.negated() : magnitude;
      else if (explicit[cell.column]) amount = magnitude;
      // Unsigned amounts: the running balance says which way the money went.
      else if (balance && running) amount = balance.minus(running).isNegative() ? magnitude.negated() : magnitude;
      if (!amount) return undefined;
      amounts.push(amount);
      balances.push(balance);
      running = balance ?? running?.plus(amount);
    }

    let passes = 0;
    const check = (holds: boolean | undefined) => {
      if (holds === undefined) return true;
      if (holds) passes++;
      return holds;
    };
    const total = amounts.reduce((sum, a) => sum.plus(a), new D(0));
    const opening = fact("opening"), closing = fact("closing");
    const inflow = amounts.filter((a) => a.isPositive()).reduce((sum, a) => sum.plus(a), new D(0));
    const outflow = amounts.filter((a) => a.isNegative()).reduce((sum, a) => sum.minus(a), new D(0));
    let ok = check(opening && closing ? opening.plus(total).equals(closing) : undefined);
    ok &&= check(fact("in") ? inflow.equals(fact("in")!) : undefined);
    ok &&= check(fact("out") ? outflow.equals(fact("out")!) : undefined);
    if (count("balance")) {
      if (balances.some((b) => !b)) return undefined;
      const chain = balances as DecimalValue[];
      const ascending = chain.every((b, i) => i === 0 || chain[i - 1]!.plus(amounts[i]!).equals(b));
      const descending = chain.every((b, i) => i === 0 || b.plus(amounts[i - 1]!).equals(chain[i - 1]!));
      ok &&= check(chain.length > 1 ? ascending || descending : undefined);
      if (ascending && chain.length) {
        ok &&= check(closing ? chain.at(-1)!.equals(closing) : undefined);
        ok &&= check(opening ? chain[0]!.minus(amounts[0]!).equals(opening) : undefined);
      }
    }
    if (!ok) return undefined;
    if (newestFirst) { amounts.reverse(); balances.reverse(); }
    return { roles, amounts, balances, passes, hints: roles.filter((r, i) => hinted[i] === r).length - roles.filter((r) => r === "ignore").length };
  };

  let best: Reading | undefined;
  const assign = (roles: Role[]) => {
    if (roles.length < columns) return ROLES.forEach((role) => assign([...roles, role]));
    // A statement may list its newest movement first: only a running balance tells.
    for (const newestFirst of roles.includes("balance") ? [false, true] : [false]) {
      const reading = read(roles, newestFirst);
      if (reading && (!best || reading.passes > best.passes || (reading.passes === best.passes && reading.hints > best.hints))) best = reading;
    }
  };
  assign([]);
  const reading = best as Reading | undefined;
  if (!reading) return undefined;
  const verified = reading.passes > 0;
  // Unproven, a reading stands only when the document names every column or signs
  // every amount, and no movement holds a second amount or date that it would hide.
  if (!verified) {
    const stated = reading.roles.every((role, i) => hinted[i] === role || (role === "amount" && (explicit[i] || dated.every((m) => m.direction))));
    const plain = dated.every((m) => !LOOKS_AMOUNT.test(m.text) && !LOOKS_DATE.test(m.text) && (m.money.length === 1 || hinted.every(Boolean)));
    if (!stated || !plain) return undefined;
  }
  return { dated, reading, verified };
  }

  // Dates.
  const complete = (candidates: (string | null)[]) => (candidates.every((d): d is string => !!d && (!period || (d >= shift(period.start, -31) && d <= shift(period.end, 31)))) ? candidates : undefined);
  let booked: string[] | undefined;
  let ambiguous = false;
  if (mode.kind === "full") booked = complete(dated.map((m) => parseDate(m.anchor.raw, order)));
  else if (mode.kind === "day") booked = complete(dated.map((m) => (m.month ? parseDate(`${m.month.year}-${String(m.month.month).padStart(2, "0")}-${m.anchor.raw.padStart(2, "0")}`) : null)));
  else if (period) {
    const years = [...new Set([period.start.slice(0, 4), period.end.slice(0, 4)])];
    const inOrder = (monthFirst: boolean) => complete(dated.map((m) => {
      const named = NAMED_DATE.exec(fold(m.anchor.raw));
      const numeric = PARTIAL_DATE.exec(m.anchor.raw);
      if (!named && !numeric) return null;
      const [day, mon] = named ? [named[1]!, String(MONTH_NAMES[named[2]!.slice(0, 3)])] : monthFirst ? [numeric![2]!, numeric![1]!] : [numeric![1]!, numeric![2]!];
      const found = years.map((y) => parseDate(`${y}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}`)).filter((d): d is string => !!d && d >= period.start && d <= period.end);
      return found.length === 1 ? found[0]! : null;
    }));
    const dayFirst = inOrder(false), monthFirst = inOrder(true);
    const sorted = (list: string[]) => list.every((d, i) => i === 0 || d >= list[i - 1]!) || list.every((d, i) => i === 0 || d <= list[i - 1]!);
    if (dayFirst && monthFirst) {
      const [a, b] = [sorted(dayFirst as string[]), sorted(monthFirst as string[])];
      booked = (b && !a ? monthFirst : dayFirst) as string[];
      ambiguous = a === b && dayFirst.some((d, i) => d !== monthFirst[i]);
    } else booked = (dayFirst ?? monthFirst) as string[] | undefined;
  }
  if (!booked) return undefined;

  const valueOn = (m: Movement, bookedOn: string, monthFirst: boolean): string | null => {
    if (!m.valueDate) return null;
    const partial = PARTIAL_DATE.exec(m.valueDate.raw);
    if (!partial) return parseDate(m.valueDate.raw, order);
    const [day, mon] = monthFirst ? [partial[2]!, partial[1]!] : [partial[1]!, partial[2]!];
    const year = Number(bookedOn.slice(0, 4));
    const near = [year - 1, year, year + 1].map((y) => parseDate(`${y}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}`)).filter((d): d is string => !!d && Math.abs(Date.parse(d) - Date.parse(bookedOn)) <= 45 * 86_400_000);
    return near.length === 1 ? near[0]! : null;
  };
  // Value dates are kept only when one day/month order reads every one of them.
  const valueOrder = [false, true].find((monthFirst) => dated.every((m, i) => !m.valueDate || valueOn(m, booked![i]!, monthFirst)));

  const warnings: ParseWarning[] = [];
  if (ambiguous) warnings.push({ code: "ambiguous_date_order", message: "Dates could be day/month or month/day; read as day/month." });
  const transactions: ParsedTransaction[] = [];
  for (const [i, m] of dated.entries()) {
    const words = m.parts.filter((a) => a.kind !== "money" || reading.roles[m.money.find((c) => c.raw === a.raw)?.column ?? -1] === "ignore");
    const description = normalizeDescription(words.map((a) => a.raw).join(" ")).slice(0, 1000);
    const head = m.rows[0]!.line;
    if (!/\p{L}/u.test(description)) {
      warnings.push({ code: "row_unreadable", row: head.line, message: "Movement has a date and an amount but no description; it was not imported." });
      continue;
    }
    const cell = m.money.find((c) => reading.roles[c.column] !== "balance" && reading.roles[c.column] !== "ignore" && !dec(c.reading.magnitude).isZero())!;
    const tx: ParsedTransaction = {
      bookedOn: booked[i]!,
      description,
      amount: toPlain(reading.amounts[i]!),
      currency: cell.reading.currency ?? currency,
      sourceRow: head.line,
      raw: { line: [...new Set(m.rows.map((r) => r.line))].map((l) => l.text).join("\n").slice(0, 2000), page: String(head.page), date: m.anchor.raw, amount: cell.raw },
      extraction: "heuristic",
    };
    if (m.reference) tx.raw.reference = m.reference.slice(0, 200);
    const value = valueOrder === undefined ? null : valueOn(m, booked[i]!, valueOrder);
    if (value && value !== tx.bookedOn) tx.valueOn = value;
    transactions.push(tx);
  }
  if (!transactions.length) return undefined;

  const used = new Set(dated.flatMap((m) => m.rows.map((r) => r.line.line)));
  const adminText = lines.filter((l) => !used.has(l.line)).map((l) => l.text).join("\n");
  if (isCardStatementText(adminText)) return undefined;

  const chain = reading.balances.every((b) => b) && reading.balances.length ? (reading.balances as DecimalValue[]) : undefined;
  const ascending = chain?.every((b, i) => i === 0 || chain[i - 1]!.plus(reading.amounts[i]!).equals(b));
  const opening = fact("opening") ?? (chain && ascending ? chain[0]!.minus(reading.amounts[0]!) : chain?.at(-1)!.minus(reading.amounts.at(-1)!));
  const closing = fact("closing") ?? (chain && ascending ? chain.at(-1) : chain?.[0]);
  const sortedDates = [...booked].sort();
  const account: ParsedAccount = { key: "default", currency, transactions };
  if (isCheckingStatementText(adminText)) account.type = "checking";
  const iban = findIban(adminText);
  const number = ACCOUNT_NUMBER.exec(fold(adminText))?.[1]?.replace(/\D/g, "");
  const issuer = findInstitutionByText(adminText)?.slug ?? findIssuerName(adminText);
  if (iban) {
    account.identifier = iban;
    account.identifierMask = iban.slice(-4);
    account.country = iban.slice(0, 2);
  } else if (number && issuer) {
    // Namespaced by the issuer, so the same number at two banks never collides.
    account.identifier = `bank:${fold(issuer).replace(/[^a-z0-9]/g, "")}:${number}`;
    account.identifierMask = number.slice(-4);
  }
  if (opening) account.openingBalance = { amount: toPlain(opening), asOf: period?.start ?? sortedDates[0]! };
  if (closing) account.closingBalance = { amount: toPlain(closing), asOf: period?.end ?? sortedDates.at(-1)! };

  return {
    verified,
    output: {
      statement: { format: "pdf", profile: PDF_INFERRED_PROFILE, accounts: [account], warnings },
      institutionText: adminText,
      ...(period ? { statedPeriod: period } : {}),
    },
  };
}

function shift(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
