/**
 * Positioned-table reader for statement PDFs whose columns are named by a
 * header row, in any order: "Descrizione | Data | Importo", "Date | Details |
 * Paid out | Paid in | Balance", "Data | Histórico | Valor | Saldo"...
 *
 * Unlike the line parser it does not need the date at the start of the line:
 * a movement is any line of a table region holding a date cell and a money
 * cell, and each money cell is attributed to the nearest header column. Lines
 * under a movement without money are its wrapped details. Repeated page
 * headers/footers are never details, and never movements.
 *
 * It never guesses: a money line it cannot place becomes a warning, an
 * unsigned amount without a debit/credit column refuses the whole reader, and
 * printed opening/closing or running balances are checked with decimal
 * arithmetic by the caller.
 */
import { inferDateOrder, parseDate, type DateOrder } from "@/domain/import/parse-date";
import type { ParsedAccount, ParsedBalance, ParsedTransaction, ParseWarning } from "@/domain/import/types";
import { dec, toPlain } from "@/domain/money/decimal";
import { findIban } from "../institution-catalog";
import { roleOfHeader } from "../profiles/generic";
import { currencyInText, fullDates, isCardStatementText, isCheckingStatementText, readAmountToken, type AmountReading, type PdfLine } from "./pdf";
import { fold, normalizeDescription } from "./text";
import { pdfHeaderSignature, type PdfTableRecipe } from "./layout-memory";
import type { DocumentParseContext, ParserOutput } from "./types";

export const PDF_TABLE_PROFILE = "pdf-table";
/** Same reader, with the columns of an unrecognized header row taken from the layout memory. */
export const PDF_TABLE_LEARNED_PROFILE = "pdf-table-learned";

type MoneyRole = "amount" | "debit" | "credit" | "balance";
type ColumnRole = MoneyRole | "date" | "valueDate" | "description";

export interface TableColumn {
  role: ColumnRole;
  left: number;
  right: number;
}

const MAX_DETAIL_LINES = 6;
const OPENING_LABEL = /^(saldo (anterior|inicial|iniziale|precedente|di apertura|de abertura)|opening balance|previous balance|balance brought forward|anfangssaldo|alter kontostand|solde (initial|precedent))\b/;
const CLOSING_LABEL = /^((il tuo )?nuovo saldo|novo saldo|saldo (final|finale|di chiusura|atual)|closing balance|(your )?new balance|balance carried forward|endsaldo|neuer kontostand|solde final|nouveau solde)\b/;
const SUMMARY_LABEL = /^(saldo|balance|solde|kontostand|total|totale|totais|subtotal|summe|somme|operazioni in (uscita|entrata)|total de (entradas|saidas)|money (in|out)|paid (in|out))\b/;
const VALUE_DATE_DETAIL = /^(?:data )?(?:valuta|value date|data valor|wertstellung|date de valeur)\s*:?\s*(\S+)$/;
/** Named sub-accounts printed above their own table ("Spazio: Savings", "Pocket: Travel"). */
const SECTION_LABEL = /^(?:spazio|space|pocket|vault|cofrinho|caixinha|sottoconto|sub-?account|unterkonto)\s*:\s*(.{1,60})$/i;
const DATE_CELL = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-](?:\d{4}|\d{2}))(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?(?:\s+(.*))?$/;
const SHORT_DATE_CELL = /^(\d{1,2})\/(\d{1,2})(?:\s+(.*))?$/;
const CURRENCY_SUFFIX = /\s*(?:EUR|BRL|USD|GBP|CHF)$/;

/** Columns named by a header line: a date column and a movement column are required. */
export function tableHeaderColumns(line: PdfLine): TableColumn[] | undefined {
  if (line.items.length < 2 || line.items.length > 12) return undefined;
  const columns: TableColumn[] = [];
  for (const item of line.items) {
    if (readAmountToken(item.text.replace(/\s+/g, "")) || DATE_CELL.test(item.text)) return undefined;
    const named = roleOfHeader(item.text);
    const role: ColumnRole | undefined =
      named === "counterparty" ? "description" : named === "valuta" ? "valueDate"
      : named === "date" || named === "valueDate" || named === "description" || named === "amount" || named === "debit" || named === "credit" || named === "balance" ? named
      : undefined;
    if (role && !columns.some((c) => c.role === role)) columns.push({ role, left: item.x, right: item.x + item.width });
  }
  const has = (role: ColumnRole) => columns.some((c) => c.role === role);
  return has("date") && (has("amount") || (has("debit") && has("credit"))) ? columns : undefined;
}

interface Cells {
  dates: { raw: string; left: number; right: number }[];
  money: { reading: AmountReading; text: string; left: number; right: number }[];
  text: string[];
}

function readMoney(text: string): AmountReading | undefined {
  const compact = text.replace(/\s+/g, "");
  return readAmountToken(compact) ?? readAmountToken(compact.replace(CURRENCY_SUFFIX, ""));
}

/** Splits a line into date, money and text cells (a cell may start with its date or end with its amount). */
function readCells(line: PdfLine): Cells {
  const cells: Cells = { dates: [], money: [], text: [] };
  for (const item of line.items) {
    const left = item.x, right = item.x + item.width;
    const reading = readMoney(item.text);
    if (reading) { cells.money.push({ reading, text: item.text, left, right }); continue; }
    const date = DATE_CELL.exec(item.text) ?? SHORT_DATE_CELL.exec(item.text);
    let rest = item.text;
    if (date) {
      rest = date.at(-1) ?? "";
      cells.dates.push({ raw: item.text.slice(0, item.text.length - rest.length).trim(), left, right });
    }
    const cut = rest.lastIndexOf(" ");
    const tail = cut > 0 ? readMoney(rest.slice(cut + 1)) : undefined;
    if (tail && /\p{L}/u.test(rest.slice(0, cut))) {
      cells.money.push({ reading: tail, text: rest.slice(cut + 1), left, right });
      rest = rest.slice(0, cut);
    }
    if (rest.trim()) cells.text.push(rest.trim());
  }
  return cells;
}

const compact = (text: string) => fold(text).replace(/[^a-z0-9]/g, "");
const isRow = (cells: Cells) => cells.dates.length > 0 && cells.money.length > 0;

function nearest<T extends TableColumn>(columns: T[], left: number, right: number): T | undefined {
  const distance = (c: TableColumn) => Math.min(Math.abs(c.left - left), Math.abs(c.right - right), Math.abs((c.left + c.right) / 2 - (left + right) / 2));
  return columns.reduce<T | undefined>((best, c) => (!best || distance(c) < distance(best) ? c : best), undefined);
}

function signed(reading: AmountReading): string {
  return reading.sign === "minus" || reading.sign === "debit" ? toPlain(dec(reading.magnitude).negated()) : reading.magnitude;
}

/** The statement period: a line that is essentially two full dates ("01.09.2026 fino al 30.09.2026"). */
function statedPeriod(lines: PdfLine[], order: DateOrder): { start: string; end: string } | undefined {
  for (const line of lines) {
    const dates = fullDates(line.text, order);
    if (dates.length !== 2 || dates[0]!.date > dates[1]!.date) continue;
    const between = fold(line.text).slice(dates[0]!.end, dates[1]!.index).trim();
    if (between.length <= 10 && !/\d/.test(between) && !readCells(line).money.length) return { start: dates[0]!.date, end: dates[1]!.date };
  }
  return undefined;
}

interface Section {
  key: string;
  name?: string;
  transactions: ParsedTransaction[];
  /** Printed running balances, in document order. */
  running: { amount: string; balance: string }[];
  opening?: string;
  closing?: string;
}

/**
 * Reads every header-named table of the document. Returns undefined when the
 * document has no such table, is a card bill (different sign conventions), or
 * prints unsigned amounts whose direction cannot be known.
 */
export function parsePdfTable(lines: PdfLine[], ctx: DocumentParseContext = {}, learned: ReadonlyMap<string, PdfTableRecipe> = ctx.learnedPdfTables ?? new Map()): ParserOutput | undefined {
  const headers = new Map<number, TableColumn[]>();
  let remembered: PdfTableRecipe | undefined;
  for (const line of lines) {
    let columns = tableHeaderColumns(line);
    if (!columns && learned.size && line.items.length >= 2) {
      const recipe = learned.get(pdfHeaderSignature(line.items.map((i) => i.text)));
      columns = recipe?.columns;
      remembered ??= recipe;
    }
    if (columns) headers.set(line.line, columns);
  }
  if (!headers.size) return undefined;

  const cellsOf = new Map(lines.map((l) => [l.line, readCells(l)]));
  const pages = [...new Set(lines.map((l) => l.page))];
  const byPage = new Map(pages.map((p) => [p, lines.filter((l) => l.page === p)]));

  // Page furniture: the same line (digits aside) on every page, never followed
  // (footer) or never preceded (header) by a movement on its page.
  const furniture = new Set<number>();
  if (pages.length > 1) {
    const occurrences = new Map<string, PdfLine[]>();
    for (const l of lines) {
      if (headers.has(l.line) || isRow(cellsOf.get(l.line)!)) continue;
      const key = l.text.replace(/\d+/g, "#");
      occurrences.set(key, [...(occurrences.get(key) ?? []), l]);
    }
    for (const group of occurrences.values()) {
      if (new Set(group.map((l) => l.page)).size !== pages.length) continue;
      const rowsOn = (l: PdfLine, after: boolean) => byPage.get(l.page)!.some((o) => (after ? o.line > l.line : o.line < l.line) && isRow(cellsOf.get(o.line)!));
      if (group.every((l) => !rowsOn(l, true)) || group.every((l) => !rowsOn(l, false))) for (const l of group) furniture.add(l.line);
    }
  }

  const dateTokens = lines.flatMap((l) => l.text.match(/(?<![\d/.\-])\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}(?![\d/.\-])/g) ?? []);
  const order = inferDateOrder(dateTokens, "DMY");
  const period = statedPeriod(lines, order);
  const currency = currencyInText(lines) ?? ctx.fallbackCurrency;
  if (!currency) return undefined;

  const warnings: ParseWarning[] = [];
  const sections = new Map<string, Section>();
  const sectionFor = (page: number, inherited?: Section): Section => {
    const label = byPage.get(page)!.map((l) => SECTION_LABEL.exec(l.text)?.[1]?.trim()).find(Boolean);
    if (!label && inherited) return inherited;
    const key = label ? `section:${fold(label)}` : "default";
    let section = sections.get(key);
    if (!section) sections.set(key, (section = { key, ...(label ? { name: label } : {}), transactions: [], running: [] }));
    return section;
  };
  const completeDate = (raw: string): string | null => {
    const short = SHORT_DATE_CELL.exec(raw);
    if (!short || DATE_CELL.test(raw)) return parseDate(raw, order);
    if (!period) return null;
    const [a, b] = [short[1]!.padStart(2, "0"), short[2]!.padStart(2, "0")];
    const [day, month] = order === "MDY" ? [b, a] : [a, b];
    const years = [...new Set([period.start.slice(0, 4), period.end.slice(0, 4)])];
    const found = years.map((y) => parseDate(`${y}-${month}-${day}`)).filter((d): d is string => !!d && d >= period.start && d <= period.end);
    return found.length === 1 ? found[0]! : null;
  };

  const tableLines = new Set<number>();
  const moneyEdges: number[] = [];
  let columns: TableColumn[] | undefined;
  let section: Section | undefined;
  let usesMinus = false;
  const rows: { line: PdfLine; cells: Cells; columns: TableColumn[]; section: Section; details: PdfLine[] }[] = [];

  for (const page of pages) {
    const pageLines = byPage.get(page)!;
    const header = pageLines.find((l) => headers.has(l.line));
    let active = false;
    if (header) {
      columns = headers.get(header.line)!;
      section = sectionFor(page);
    } else if (columns) {
      // A table may continue on a page that does not repeat its header.
      active = pageLines.some((l) => isRow(cellsOf.get(l.line)!) && cellsOf.get(l.line)!.money.some((m) => moneyEdges.some((e) => Math.abs(e - m.right) <= 2)));
      if (active) section = sectionFor(page, section);
    }
    let current: (typeof rows)[number] | undefined;
    for (const line of pageLines) {
      if (header && line.line === header.line) { active = true; current = undefined; continue; }
      if (!active || !columns || !section) continue;
      if (furniture.has(line.line)) { current = undefined; continue; }
      tableLines.add(line.line);
      const cells = cellsOf.get(line.line)!;
      if (isRow(cells)) {
        current = { line, cells, columns, section, details: [] };
        rows.push(current);
        for (const m of cells.money) {
          moneyEdges.push(m.right);
          if (nearest(columns.filter((c) => c.role !== "date" && c.role !== "valueDate" && c.role !== "description"), m.left, m.right)?.role !== "balance" && (m.reading.sign === "minus" || m.reading.sign === "debit")) usesMinus = true;
        }
      } else if (cells.money.length) {
        const label = fold(line.text);
        if (!OPENING_LABEL.test(label) && !CLOSING_LABEL.test(label) && !SUMMARY_LABEL.test(label)) {
          warnings.push({ code: "row_unreadable", row: line.line, message: "Table line has an amount but no date; it was not imported." });
        }
        current = undefined;
      } else if (current && current.details.length < MAX_DETAIL_LINES) current.details.push(line);
    }
  }
  if (!rows.length) return undefined;

  const admin = lines.filter((l) => !tableLines.has(l.line) && !headers.has(l.line));
  const adminText = admin.map((l) => l.text).join("\n");
  if (isCardStatementText(adminText)) return undefined;

  for (const row of rows) {
    const { line, cells } = row;
    const unreadable = (message: string) => warnings.push({ code: "row_unreadable", row: line.line, message });
    const moneyColumns = row.columns.filter((c) => c.role === "amount" || c.role === "debit" || c.role === "credit" || c.role === "balance");
    const placed = cells.money.map((m) => ({ ...m, role: nearest(moneyColumns, m.left, m.right)!.role as MoneyRole }));
    const balances = placed.filter((m) => m.role === "balance");
    const moving = placed.filter((m) => m.role !== "balance" && !dec(m.reading.magnitude).isZero());
    if (moving.length !== 1 || balances.length > 1) { unreadable("Table row does not hold exactly one movement amount."); continue; }
    const movement = moving[0]!;
    let amount: string;
    if (movement.role === "debit") amount = toPlain(dec(movement.reading.magnitude).negated());
    else if (movement.role === "credit") amount = movement.reading.magnitude;
    else if (movement.reading.sign !== "none" || usesMinus) amount = signed(movement.reading);
    else return undefined; // Unsigned single column: the direction is not stated anywhere.

    const dateColumns = row.columns.filter((c) => c.role === "date" || c.role === "valueDate");
    const dated = cells.dates.map((d, i) => ({ ...d, role: dateColumns.length > 1 ? nearest(dateColumns, d.left, d.right)!.role : i === 0 ? "date" : "valueDate" }));
    const bookedRaw = (dated.find((d) => d.role === "date") ?? dated[0]!).raw;
    const bookedOn = completeDate(bookedRaw);
    if (!bookedOn) { unreadable("Table row has an unreadable date."); continue; }

    let valueOn = completeDate(dated.find((d) => d.raw !== bookedRaw && d.role === "valueDate")?.raw ?? "");
    const details: string[] = [];
    for (const detail of row.details) {
      const value = VALUE_DATE_DETAIL.exec(fold(detail.text));
      const date = value ? parseDate(value[1]!, order) : null;
      if (date) valueOn ??= date;
      else details.push(detail.text);
    }
    const title = cells.text.join(" ");
    if (!/\p{L}/u.test(title)) { unreadable("Table row has no description."); continue; }

    const tx: ParsedTransaction = {
      bookedOn,
      description: normalizeDescription([title, ...details].join(" ")).slice(0, 1000),
      amount,
      currency: movement.reading.currency ?? currency,
      sourceRow: line.line,
      raw: { line: [line.text, ...row.details.map((d) => d.text)].join("\n").slice(0, 2000), page: String(line.page), date: bookedRaw, amount: movement.text },
      extraction: "heuristic",
    };
    if (valueOn) tx.valueOn = valueOn;
    row.section.transactions.push(tx);
    if (balances.length) row.section.running.push({ amount, balance: signed(balances[0]!.reading) });
  }

  // Printed opening/closing balances, attributed to the sub-account named on their page.
  for (const line of lines) {
    const cells = cellsOf.get(line.line)!;
    if (isRow(cells) || cells.money.length !== 1) continue;
    const label = fold(line.text);
    const kind = OPENING_LABEL.test(label) ? "opening" : CLOSING_LABEL.test(label) ? "closing" : undefined;
    if (!kind) continue;
    const target = sectionFor(line.page, sections.size === 1 ? [...sections.values()][0] : undefined);
    target[kind] ??= signed(cells.money[0]!.reading);
  }

  const iban = findIban(adminText);
  const type = isCheckingStatementText(adminText) ? "checking" as const : undefined;
  const accounts: ParsedAccount[] = [];
  for (const s of sections.values()) {
    if (!s.transactions.length && s.opening === undefined && s.closing === undefined) continue;
    const dates = s.transactions.map((t) => t.bookedOn).sort();
    const account: ParsedAccount = { key: s.key, currency: s.transactions[0]?.currency ?? currency, transactions: s.transactions };
    if (s.name) { account.name = s.name; account.type = "savings"; }
    else if (type) account.type = type;
    if (iban) {
      account.country = iban.slice(0, 2);
      account.identifier = s.name ? `${iban}:${fold(s.name)}` : iban;
      if (!s.name) account.identifierMask = iban.slice(-4);
    }
    const derived = runningBalances(s, warnings);
    const opening = s.opening ?? derived?.opening, closing = s.closing ?? derived?.closing;
    const openingOn = period?.start ?? dates[0], closingOn = period?.end ?? dates.at(-1);
    if (opening !== undefined && openingOn) account.openingBalance = { amount: opening, asOf: openingOn } satisfies ParsedBalance;
    if (closing !== undefined && closingOn) account.closingBalance = { amount: closing, asOf: closingOn } satisfies ParsedBalance;
    accounts.push(account);
  }
  if (accounts.length === 1) accounts[0]!.key = "default";

  return {
    statement: { format: "pdf", profile: remembered ? PDF_TABLE_LEARNED_PROFILE : PDF_TABLE_PROFILE, accounts, warnings },
    institutionText: adminText,
    // The remembered issuer counts only while this statement still names it outside its movements.
    ...(remembered?.issuer && compact(adminText).includes(compact(remembered.issuer)) ? { documentInstitution: remembered.issuer } : {}),
    ...(period ? { statedPeriod: period } : {}),
  };
}

/** Checks a printed running-balance column (either order) and derives the opening/closing balances from it. */
function runningBalances(section: Section, warnings: ParseWarning[]): { opening: string; closing: string } | undefined {
  const points = section.running;
  if (!points.length || points.length !== section.transactions.length) return undefined;
  const ascending = points.every((p, i) => i === 0 || dec(points[i - 1]!.balance).plus(p.amount).equals(p.balance));
  const descending = points.every((p, i) => i === 0 || dec(p.balance).plus(points[i - 1]!.amount).equals(points[i - 1]!.balance));
  if (!ascending && !descending) {
    warnings.push({ code: "balance_mismatch", message: `Account "${section.key}": movements do not follow the printed running balance. Some transactions may be missing.` });
    return undefined;
  }
  const first = ascending ? points[0]! : points.at(-1)!;
  const last = ascending ? points.at(-1)! : points[0]!;
  return { opening: toPlain(dec(first.balance).minus(first.amount)), closing: last.balance };
}

/**
 * Learns the table of a layout no reader recognized from a source-verified
 * model interpretation: the line above the first movement becomes the header,
 * and the positions of the date and amount cells become its columns. The
 * recipe is kept only if replaying it on the same document reads every
 * verified movement again — and anything it reads beyond them reconciles with
 * the printed balances.
 */
export function learnPdfTable(lines: PdfLine[], interpreted: ParserOutput, ctx: DocumentParseContext = {}): { signature: string; recipe: PdfTableRecipe; output: ParserOutput } | undefined {
  const verified = interpreted.statement.accounts.flatMap((a) => a.transactions).filter((t) => t.raw.evidence_lines);
  if (verified.length < 2) return undefined;
  const byLine = new Map(lines.map((l) => [l.line, l]));
  const movements: { left: number; right: number; reading: AmountReading; amount: string }[] = [];
  const others: { left: number; right: number }[] = [];
  const dates: { left: number; right: number }[] = [];
  const rowLines = new Set<number>();
  for (const tx of verified) {
    const [, amountLine, dateLine] = tx.raw.evidence_lines!.split(",").map(Number);
    const line = amountLine === dateLine ? byLine.get(amountLine!) : undefined;
    const cells = line && readCells(line);
    const movement = cells?.money.filter((m) => dec(m.reading.magnitude).equals(dec(tx.amount).abs()));
    // Only a "date and amount on one line" layout is a table this reader can replay.
    if (!line || !cells?.dates.length || movement?.length !== 1 || rowLines.has(line.line)) return undefined;
    rowLines.add(line.line);
    dates.push(cells.dates[0]!);
    movements.push({ ...movement[0]!, amount: tx.amount });
    others.push(...cells.money.filter((m) => m !== movement[0]));
  }
  const span = (cells: { left: number; right: number }[]) => ({ left: Math.min(...cells.map((c) => c.left)), right: Math.max(...cells.map((c) => c.right)) });
  const aligned = (cells: { left: number; right: number }[]) => !cells.length || Math.max(...cells.map((c) => c.right)) - Math.min(...cells.map((c) => c.right)) <= 3 || Math.max(...cells.map((c) => c.left)) - Math.min(...cells.map((c) => c.left)) <= 3;
  const columns: PdfTableRecipe["columns"] = [{ role: "date", ...span(dates) }];
  const out = movements.filter((m) => dec(m.amount).isNegative()), into = movements.filter((m) => !dec(m.amount).isNegative());
  if (movements.every((m) => (m.reading.sign === "minus" || m.reading.sign === "debit") === dec(m.amount).isNegative()) && out.length && aligned(movements)) {
    columns.push({ role: "amount", ...span(movements) });
  } else if (out.length && into.length && aligned(out) && aligned(into) && Math.abs(span(out).right - span(into).right) > 6) {
    columns.push({ role: "debit", ...span(out) }, { role: "credit", ...span(into) });
  } else return undefined;
  if (others.length) {
    if (!aligned(others)) return undefined;
    columns.push({ role: "balance", ...span(others) });
  }

  const first = Math.min(...rowLines);
  const page = byLine.get(first)!.page;
  const header = lines.filter((l) => l.page === page && l.line < first && l.items.length >= 2 && !rowLines.has(l.line) && !isRow(readCells(l))).at(-1);
  if (!header || tableHeaderColumns(header)) return undefined;
  const signature = pdfHeaderSignature(header.items.map((i) => i.text));
  const recipe: PdfTableRecipe = { kind: "pdf-table", columns, ...(interpreted.documentInstitution ? { issuer: interpreted.documentInstitution.slice(0, 120) } : {}) };
  const output = parsePdfTable(lines, ctx, new Map([[signature, recipe]]));
  if (!output || output.statement.warnings.length) return undefined;
  const replayed = output.statement.accounts.flatMap((a) => a.transactions);
  const reads = (tx: ParsedTransaction) => replayed.some((r) => String(r.sourceRow) === tx.raw.evidence_lines!.split(",")[1] && r.bookedOn === tx.bookedOn && dec(r.amount).equals(tx.amount));
  if (!verified.every(reads)) return undefined;
  const reconciled = output.statement.accounts.every((a) => !a.transactions.length || (a.openingBalance && a.closingBalance &&
    a.transactions.reduce((total, t) => total.plus(t.amount), dec(a.openingBalance.amount)).equals(a.closingBalance.amount)));
  if (replayed.length !== verified.length && !reconciled) return undefined;
  return { signature, recipe, output };
}
