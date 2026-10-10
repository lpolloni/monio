import { countsAsPersonal, type EntityKind } from "../accounts/classification";
import type { CategoryKind } from "../categories/catalog";
import type { FxTable } from "../fx/fx-table";
import { D, dec, toPlain, type DecimalValue } from "../money/decimal";
import { monthKey, monthsBetween } from "./periods";

export interface FlowTransaction {
  id: string;
  bookedOn: string;
  amount: string;
  currency: string;
  classification: string;
  categorySlug: string | null;
  categoryKind: CategoryKind | null;
  accountId: string;
  entityKind: EntityKind;
  country: string | null;
  institutionId: string | null;
  status: string;
  duplicateOf: string | null;
  merchant?: string | null;
}

export interface Breakdown {
  key: string;
  amount: string;
  count: number;
}

export interface MonthFlow {
  month: string;
  income: string;
  expenses: string;
  net: string;
}

export interface CashflowSummary {
  currency: string;
  from: string;
  to: string;
  income: string;
  expenses: string;
  net: string;
  transactionCount: number;
  excludedTransfers: number;
  unconverted: number;
  expensesByCategory: Breakdown[];
  incomeByCategory: Breakdown[];
  expensesByCountry: Breakdown[];
  expensesByInstitution: Breakdown[];
  expensesByCurrency: Breakdown[];
  expensesByMerchant: Breakdown[];
  byMonth: MonthFlow[];
}

/** Whether a transaction is real income/expense (not a move between own accounts). */
export function isCountedFlow(tx: FlowTransaction, includeBusiness: boolean): boolean {
  return (
    tx.classification === "regular" &&
    tx.categoryKind !== "transfer" &&
    !tx.duplicateOf &&
    tx.status === "posted" &&
    countsAsPersonal(tx.entityKind, includeBusiness)
  );
}

function bump(map: Map<string, { amount: DecimalValue; count: number }>, key: string, amount: DecimalValue) {
  const cur = map.get(key) ?? { amount: new D(0), count: 0 };
  cur.amount = cur.amount.plus(amount);
  cur.count += 1;
  map.set(key, cur);
}

function toBreakdown(map: Map<string, { amount: DecimalValue; count: number }>): Breakdown[] {
  return [...map.entries()]
    .map(([key, v]) => ({ key, amount: toPlain(v.amount), count: v.count }))
    .filter((b) => !dec(b.amount).isZero())
    .sort((a, b) => dec(b.amount).comparedTo(dec(a.amount)));
}

/**
 * Income and expenses for a period in one display currency, each transaction
 * converted at the rate of its own booking date.
 *
 * - Internal transfers, card bill payments, investment moves and FX exchanges are
 *   excluded (card purchases are already counted on the card account).
 * - Refunds (positive amounts in an expense category or tagged "refunds") reduce
 *   expenses instead of inflating income.
 * - Exchange-rate appreciation is never income: only booked transactions count.
 */
export function computeCashflow(
  transactions: FlowTransaction[],
  fx: FxTable,
  currency: string,
  options: { from: string; to: string; includeBusiness: boolean },
): CashflowSummary {
  let income = new D(0);
  let expenses = new D(0);
  let count = 0;
  let excluded = 0;
  let unconverted = 0;
  const expCat = new Map<string, { amount: DecimalValue; count: number }>();
  const incCat = new Map<string, { amount: DecimalValue; count: number }>();
  const expCountry = new Map<string, { amount: DecimalValue; count: number }>();
  const expInst = new Map<string, { amount: DecimalValue; count: number }>();
  const expCur = new Map<string, { amount: DecimalValue; count: number }>();
  const expMerchant = new Map<string, { amount: DecimalValue; count: number }>();
  const months = new Map<string, { income: DecimalValue; expenses: DecimalValue }>();
  for (const m of monthsBetween(monthKey(options.from), monthKey(options.to))) {
    months.set(m, { income: new D(0), expenses: new D(0) });
  }

  for (const tx of transactions) {
    if (tx.bookedOn < options.from || tx.bookedOn > options.to) continue;
    if (!isCountedFlow(tx, options.includeBusiness)) {
      if (tx.classification !== "regular" || tx.categoryKind === "transfer") excluded++;
      continue;
    }
    const converted = fx.convert({ amount: tx.amount, currency: tx.currency }, currency, tx.bookedOn);
    if (!converted) {
      unconverted++;
      continue;
    }
    count++;
    const value = dec(converted.amount);
    const month = months.get(monthKey(tx.bookedOn));
    const isRefund = value.isPositive() && (tx.categorySlug === "refunds" || tx.categoryKind === "expense");
    if (value.isNegative() || isRefund) {
      // Outflow, or refund offsetting an expense category.
      const expense = value.negated();
      expenses = expenses.plus(expense);
      if (month) month.expenses = month.expenses.plus(expense);
      const cat = tx.categorySlug && tx.categorySlug !== "refunds" ? tx.categorySlug : isRefund ? "refunds" : "uncategorized";
      bump(expCat, cat, expense);
      bump(expCountry, tx.country ?? "unknown", expense);
      bump(expInst, tx.institutionId ?? "unknown", expense);
      bump(expCur, tx.currency, expense);
      if (tx.merchant) bump(expMerchant, tx.merchant, expense);
    } else {
      income = income.plus(value);
      if (month) month.income = month.income.plus(value);
      bump(incCat, tx.categorySlug ?? "uncategorized", value);
    }
  }

  return {
    currency,
    from: options.from,
    to: options.to,
    income: toPlain(income),
    expenses: toPlain(expenses),
    net: toPlain(income.minus(expenses)),
    transactionCount: count,
    excludedTransfers: excluded,
    unconverted,
    expensesByCategory: toBreakdown(expCat),
    incomeByCategory: toBreakdown(incCat),
    expensesByCountry: toBreakdown(expCountry),
    expensesByInstitution: toBreakdown(expInst),
    expensesByCurrency: toBreakdown(expCur),
    expensesByMerchant: toBreakdown(expMerchant).slice(0, 20),
    byMonth: [...months.entries()].map(([month, v]) => ({
      month,
      income: toPlain(v.income),
      expenses: toPlain(v.expenses),
      net: toPlain(v.income.minus(v.expenses)),
    })),
  };
}
