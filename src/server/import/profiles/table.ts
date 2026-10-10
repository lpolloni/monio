/**
 * Shared engine that turns a table (CSV rows / spreadsheet rows) plus a column
 * mapping into accounts and transactions. Profiles describe *where* things are;
 * this module does the reading, sign handling, balance extraction and warnings,
 * so every profile behaves the same way on bad rows: they become warnings,
 * never guesses.
 */
import { parseAmount, type DecimalSeparator, type ParsedAmount } from "@/domain/import/parse-amount";
import { parseDate, type DateOrder } from "@/domain/import/parse-date";
import type { AccountType, ParsedAccount, ParsedBalance, ParsedTransaction } from "@/domain/import/types";
import { dec, sum, toPlain } from "@/domain/money/decimal";
import { resolveCurrency, WarningSink } from "../parsers/warnings";
import { normalizeDescription, normalizeHeader } from "../parsers/text";
import type { ProfileContext, ProfileResult } from "./types";

export function cellAt(row: readonly string[] | undefined, col: number | undefined): string {
  if (!row || col === undefined || col < 0) return "";
  return (row[col] ?? "").trim();
}

/** Index of the first header whose normalized form equals one of `names` (normalized), or -1. */
export function headerIndex(headers: readonly string[], ...names: string[]): number {
  const wanted = new Set(names.map(normalizeHeader));
  return headers.findIndex((h) => wanted.has(normalizeHeader(h)));
}

/**
 * Scores a header row against a known signature: 1 when it is exactly the
 * expected set, a bit less when extra columns exist, 0 when any required column
 * is missing.
 */
export function signatureScore(
  headers: readonly string[],
  required: string[],
  optional: string[] = [],
  { strict = false }: { strict?: boolean } = {},
): number {
  const present = headers.map(normalizeHeader).filter(Boolean);
  const set = new Set(present);
  const req = required.map(normalizeHeader);
  if (!req.every((r) => set.has(r))) return 0;
  const known = new Set([...req, ...optional.map(normalizeHeader)]);
  const extras = present.filter((h) => !known.has(h)).length;
  if (extras && strict) return 0;
  return extras === 0 ? 1 : Math.max(0.7, 0.95 - extras * 0.05);
}

/** Share (0..1) of non-empty values in `col` accepted by `test`; 0 when the column is empty. */
export function columnRate(rows: readonly string[][], col: number, test: (value: string) => boolean): number {
  let total = 0;
  let ok = 0;
  for (const row of rows) {
    const value = cellAt(row, col);
    if (!value) continue;
    total++;
    if (test(value)) ok++;
  }
  return total === 0 ? 0 : ok / total;
}

/** Header names made unique and non-empty, used as keys of `raw`. */
export function rawKeys(headers: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h, i) => {
    const base = h.trim() || `col${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

export function buildRaw(keys: readonly string[], cells: readonly string[]): Record<string, string> {
  const raw: Record<string, string> = {};
  const width = Math.max(keys.length, cells.length);
  for (let i = 0; i < width; i++) {
    const value = cells[i] ?? "";
    if (value === "" && i >= keys.length) continue;
    raw[keys[i] ?? `col${i + 1}`] = value;
  }
  return raw;
}

export function negateAmount(amount: string): string {
  return toPlain(dec(amount).negated());
}

export function absAmount(amount: string): string {
  return toPlain(dec(amount).abs());
}

export function isZeroAmount(amount: string): boolean {
  return dec(amount).isZero();
}

export interface RowView {
  cells: string[];
  /** 0-based index in the table. */
  index: number;
  /** 1-based source row. */
  rowNumber: number;
  raw: Record<string, string>;
}

export type AmountSpec =
  | { kind: "signed"; col: number }
  /** Separate columns; values are read as magnitudes (debit = money out). */
  | { kind: "split"; debitCol?: number; creditCol?: number };

export interface TableSpec {
  date: number;
  /** Column used when `date` is empty (e.g. Revolut pending rows have no completion date). */
  dateFallback?: number;
  valueDate?: number;
  dateOrder: DateOrder;
  decimal?: DecimalSeparator;
  amount: AmountSpec;
  /** Credit-card exports where positive = purchase: flip every sign. */
  invertSign?: boolean;
  description: (row: RowView) => string;
  counterparty?: (row: RowView) => string | undefined;
  externalId?: number;
  balance?: number;
  currencyCol?: number;
  /** Fixed currency of the export (e.g. "Amount (EUR)"). */
  currency?: string;
  originalAmountCol?: number;
  originalCurrencyCol?: number;
  account?: (row: RowView, currency: string) => { key: string; name?: string; type?: AccountType };
  /** Rows to ignore (e.g. declined card authorizations); `warn` adds a warning. */
  skip?: (row: RowView) => { reason: string; warn: boolean } | undefined;
  pending?: (row: RowView) => boolean;
  /** Additional transactions derived from the same row (e.g. a fee). */
  extra?: (row: RowView, base: ParsedTransaction) => ParsedTransaction[];
  extraction: "exact" | "heuristic";
  accountType?: AccountType;
  country?: string;
  /** Rows with only description text are appended to the previous transaction. */
  continuationRows?: boolean;
}

const OPENING_ROW =
  /^(saldo\s+(anterior|inicial|iniziale|precedente|de abertura|di apertura|apertura)|opening balance|previous balance|balance brought forward|brought forward|anfangssaldo|alter kontostand|solde (initial|precedent|anterieur))\b/;
const CLOSING_ROW =
  /^(saldo\s+(final|finale|di chiusura|atual|contabile finale)|closing balance|balance carried forward|carried forward|endsaldo|neuer kontostand|solde final)\b/;
const OTHER_BALANCE_ROW = /^(saldo( do dia| del giorno| disponivel| disponibile| bloqueado| contabile)?|balance|daily balance|kontostand|solde)$/;
const SUMMARY_ROW = /^(total|totale|totais|totals|subtotal|summe|somme|totale movimenti|total geral)\b/;

export function balanceRowKind(description: string): "opening" | "closing" | "other" | undefined {
  const d = normalizeHeader(description);
  if (!d) return undefined;
  if (OPENING_ROW.test(d)) return "opening";
  if (CLOSING_ROW.test(d)) return "closing";
  if (OTHER_BALANCE_ROW.test(d)) return "other";
  return undefined;
}

interface BalancePoint {
  index: number;
  date: string;
  balance: string;
  effect: string;
}

interface AccountBuilder {
  account: ParsedAccount;
  points: BalancePoint[];
  txIndexes: { index: number; date: string }[];
  opening?: ParsedBalance;
  closing?: ParsedBalance;
}

export function readTable(rows: string[][], ctx: ProfileContext, spec: TableSpec): ProfileResult {
  const warnings = new WarningSink();
  const keys = rawKeys(rows[ctx.headerRowIndex] ?? []);
  const builders = new Map<string, AccountBuilder>();
  let previous: ParsedTransaction | undefined;

  const amountAt = (index: number, col: number | undefined): { state: "empty" } | { state: "invalid"; value: string } | { state: "ok"; parsed: ParsedAmount } => {
    const value = cellAt(rows[index], col);
    if (!value || value === "-") return { state: "empty" };
    const numeric = col !== undefined && ctx.numericCell?.(index, col);
    const parsed = parseAmount(value, numeric ? "." : spec.decimal);
    return parsed ? { state: "ok", parsed } : { state: "invalid", value };
  };

  const builderFor = (acct: { key: string; name?: string; type?: AccountType }, currency: string): AccountBuilder => {
    let builder = builders.get(acct.key);
    if (!builder) {
      builder = {
        account: {
          key: acct.key,
          name: acct.name,
          type: acct.type ?? spec.accountType,
          currency,
          country: spec.country,
          transactions: [],
        },
        points: [],
        txIndexes: [],
      };
      builders.set(acct.key, builder);
    }
    return builder;
  };

  for (let i = ctx.headerRowIndex + 1; i < rows.length; i++) {
    const cells = rows[i] ?? [];
    if (cells.every((c) => !c.trim())) {
      previous = undefined;
      continue;
    }
    const rowNumber = i + 1;
    const view: RowView = { cells, index: i, rowNumber, raw: buildRaw(keys, cells) };

    const skip = spec.skip?.(view);
    if (skip) {
      if (skip.warn) warnings.add({ code: "row_unreadable", message: skip.reason, row: rowNumber });
      previous = undefined;
      continue;
    }

    const description = spec.description(view);
    const dateRaw = cellAt(cells, spec.date) || cellAt(cells, spec.dateFallback);
    const balanceCell = amountAt(i, spec.balance);
    let amountState: ReturnType<typeof amountAt>;
    if (spec.amount.kind === "signed") {
      amountState = amountAt(i, spec.amount.col);
    } else {
      const debit = amountAt(i, spec.amount.debitCol);
      const credit = amountAt(i, spec.amount.creditCol);
      const debitValue = debit.state === "ok" && !isZeroAmount(debit.parsed.amount) ? debit.parsed : undefined;
      const creditValue = credit.state === "ok" && !isZeroAmount(credit.parsed.amount) ? credit.parsed : undefined;
      if (debit.state === "invalid" || credit.state === "invalid") {
        amountState = { state: "invalid", value: debit.state === "invalid" ? debit.value : (credit as { value: string }).value };
      } else if (debitValue && creditValue) {
        amountState = { state: "invalid", value: "both debit and credit are filled" };
      } else if (debitValue) {
        amountState = { state: "ok", parsed: { ...debitValue, amount: negateAmount(absAmount(debitValue.amount)) } };
      } else if (creditValue) {
        amountState = { state: "ok", parsed: { ...creditValue, amount: absAmount(creditValue.amount) } };
      } else if (debit.state === "ok" || credit.state === "ok") {
        amountState = { state: "ok", parsed: { amount: "0" } };
      } else {
        amountState = { state: "empty" };
      }
    }

    // Opening/closing balance rows ("SALDO ANTERIOR") are not transactions.
    const balanceKind = balanceRowKind(description);
    if (balanceKind) {
      const value = balanceCell.state === "ok" ? balanceCell.parsed.amount : amountState.state === "ok" ? amountState.parsed.amount : undefined;
      if (value !== undefined && balanceKind !== "other") {
        const currency = resolveCurrency(cellAt(cells, spec.currencyCol), [spec.currency, ctx.fallbackCurrency], warnings, rowNumber);
        const builder = builderFor(spec.account?.(view, currency) ?? { key: "default" }, currency);
        const asOf = parseDate(dateRaw, spec.dateOrder) ?? "";
        if (balanceKind === "opening") builder.opening = { amount: value, asOf };
        else builder.closing = { amount: value, asOf };
      }
      previous = undefined;
      continue;
    }
    if (SUMMARY_ROW.test(normalizeHeader(description)) && !dateRaw) {
      previous = undefined;
      continue;
    }

    if (!dateRaw && amountState.state === "empty" && balanceCell.state === "empty") {
      // Description wrapped onto the next row (common in Italian/Brazilian exports).
      if (spec.continuationRows !== false && previous && description.trim()) {
        previous.description = normalizeDescription(`${previous.description} ${description}`);
      }
      continue;
    }

    const bookedOn = parseDate(dateRaw, spec.dateOrder);
    if (!bookedOn) {
      warnings.add(
        dateRaw
          ? { code: "row_unreadable", message: `Unreadable date "${dateRaw.slice(0, 40)}"; row skipped.`, row: rowNumber }
          : { code: "missing_date", message: "Row has no date; skipped.", row: rowNumber },
      );
      previous = undefined;
      continue;
    }
    if (amountState.state === "empty") {
      warnings.add({ code: "missing_amount", message: "Row has no amount; skipped.", row: rowNumber });
      previous = undefined;
      continue;
    }
    if (amountState.state === "invalid") {
      warnings.add({
        code: "row_unreadable",
        message: `Unreadable amount "${amountState.value.slice(0, 40)}"; row skipped.`,
        row: rowNumber,
      });
      previous = undefined;
      continue;
    }

    const currency = resolveCurrency(
      cellAt(cells, spec.currencyCol),
      [spec.currency, amountState.parsed.currency, ctx.fallbackCurrency],
      warnings,
      rowNumber,
    );
    let amount = amountState.parsed.amount;
    if (spec.invertSign) amount = negateAmount(amount);

    const tx: ParsedTransaction = {
      bookedOn,
      description: normalizeDescription(description),
      amount,
      currency,
      sourceRow: rowNumber,
      raw: view.raw,
      extraction: spec.extraction,
    };
    const valueOn = spec.valueDate !== undefined ? parseDate(cellAt(cells, spec.valueDate), spec.dateOrder) : null;
    if (valueOn) tx.valueOn = valueOn;
    const externalId = cellAt(cells, spec.externalId);
    if (externalId) tx.externalId = externalId.slice(0, 200);
    const counterparty = spec.counterparty?.(view);
    if (counterparty) tx.counterparty = normalizeDescription(counterparty);
    if (spec.pending?.(view)) tx.pending = true;

    const original = amountAt(i, spec.originalAmountCol);
    const originalCurrencyRaw = cellAt(cells, spec.originalCurrencyCol);
    if (original.state === "ok" && originalCurrencyRaw) {
      const originalCurrency = resolveCurrency(originalCurrencyRaw, [], warnings, rowNumber);
      if (originalCurrency !== currency && originalCurrency !== "XXX") {
        const magnitude = absAmount(original.parsed.amount);
        tx.originalAmount = dec(amount).isNegative() ? negateAmount(magnitude) : magnitude;
        tx.originalCurrency = originalCurrency;
      }
    }

    const builder = builderFor(spec.account?.(view, currency) ?? { key: "default" }, currency);
    const produced = [tx, ...(spec.extra?.(view, tx) ?? [])];
    builder.account.transactions.push(...produced);
    // Pending rows do not move the booked balance: keep them out of balance derivation.
    if (!tx.pending) builder.txIndexes.push({ index: i, date: bookedOn });
    if (balanceCell.state === "ok" && !tx.pending) {
      builder.points.push({
        index: i,
        date: bookedOn,
        balance: balanceCell.parsed.amount,
        effect: toPlain(sum(produced.map((t) => t.amount))),
      });
    }
    previous = tx;
  }

  const accounts: ParsedAccount[] = [];
  for (const builder of builders.values()) {
    const { account } = builder;
    const derived = deriveBalances(builder);
    const opening = builder.opening ?? derived.opening;
    const closing = builder.closing ?? derived.closing;
    const first = builder.txIndexes.length ? minDate(builder.txIndexes) : undefined;
    const last = builder.txIndexes.length ? maxDate(builder.txIndexes) : undefined;
    if (opening) account.openingBalance = { amount: opening.amount, asOf: opening.asOf || first || "" };
    if (closing) account.closingBalance = { amount: closing.amount, asOf: closing.asOf || last || "" };
    if (account.openingBalance && !account.openingBalance.asOf) delete account.openingBalance;
    if (account.closingBalance && !account.closingBalance.asOf) delete account.closingBalance;
    accounts.push(account);
  }
  if (accounts.length === 1) accounts[0]!.key = "default";
  return { accounts, warnings: warnings.list };
}

function minDate(items: { date: string }[]): string {
  return items.reduce((min, item) => (item.date < min ? item.date : min), items[0]!.date);
}

function maxDate(items: { date: string }[]): string {
  return items.reduce((max, item) => (item.date > max ? item.date : max), items[0]!.date);
}

/**
 * Derives opening/closing balances from a running-balance column. Only done when
 * the chronologically first/last transaction rows themselves carry a balance, so
 * exports that print the balance once per day do not produce wrong values.
 */
function deriveBalances(builder: AccountBuilder): { opening?: ParsedBalance; closing?: ParsedBalance } {
  const { points, txIndexes } = builder;
  if (!points.length || !txIndexes.length) return {};
  const firstRow = txIndexes[0]!;
  const lastRow = txIndexes[txIndexes.length - 1]!;
  const descending = firstRow.date > lastRow.date;
  const chronoFirst = descending ? lastRow : firstRow;
  const chronoLast = descending ? firstRow : lastRow;
  const result: { opening?: ParsedBalance; closing?: ParsedBalance } = {};
  const firstPoint = points.find((p) => p.index === chronoFirst.index);
  if (firstPoint) {
    result.opening = { amount: toPlain(dec(firstPoint.balance).minus(dec(firstPoint.effect))), asOf: firstPoint.date };
  }
  const lastPoint = points.find((p) => p.index === chronoLast.index);
  if (lastPoint) result.closing = { amount: lastPoint.balance, asOf: lastPoint.date };
  return result;
}
