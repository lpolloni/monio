import { countsAsPersonal, type EntityKind } from "../accounts/classification";
import type { FxTable } from "../fx/fx-table";
import { D, dec, toPlain, type DecimalValue } from "../money/decimal";

export interface HistoryAccount {
  accountId: string;
  entityKind: EntityKind;
  includeInNetWorth: boolean;
  isCrypto: boolean;
}

export interface BalancePoint {
  accountId: string;
  asOf: string;
  balance: string;
  currency: string;
}

export interface HoldingPoint {
  accountId: string;
  asOf: string;
  currency: string;
  quantity: string;
}

export interface NetWorthPoint {
  date: string;
  netWorth: string;
  assets: string;
  liabilities: string;
  crypto: string;
  /** Same positions valued at the rates of the last date (isolates FX effects). */
  netWorthAtConstantRates: string;
}

function latestOnOrBefore<T extends { asOf: string }>(sorted: T[], date: string): T | undefined {
  let found: T | undefined;
  for (const p of sorted) {
    if (p.asOf <= date) found = p;
    else break;
  }
  return found;
}

/**
 * Net worth on each requested date from balance snapshots (last known balance on or
 * before the date) and crypto holdings, converted at that date's rates. The
 * constant-rate series values the same positions at the final date's rates, so the
 * gap between the two series is purely the exchange-rate effect.
 */
export function computeNetWorthHistory(
  accounts: HistoryAccount[],
  balances: BalancePoint[],
  holdings: HoldingPoint[],
  fx: FxTable,
  currency: string,
  dates: string[],
  options: { includeBusiness: boolean },
): NetWorthPoint[] {
  const counted = new Map(
    accounts
      .filter((a) => a.includeInNetWorth && countsAsPersonal(a.entityKind, options.includeBusiness))
      .map((a) => [a.accountId, a]),
  );
  const balanceSeries = new Map<string, BalancePoint[]>();
  for (const b of balances) {
    if (!counted.has(b.accountId)) continue;
    const list = balanceSeries.get(b.accountId) ?? [];
    list.push(b);
    balanceSeries.set(b.accountId, list);
  }
  for (const list of balanceSeries.values()) list.sort((a, b) => a.asOf.localeCompare(b.asOf));

  const holdingSeries = new Map<string, HoldingPoint[]>();
  for (const h of holdings) {
    if (!counted.has(h.accountId)) continue;
    const key = `${h.accountId}|${h.currency}`;
    const list = holdingSeries.get(key) ?? [];
    list.push(h);
    holdingSeries.set(key, list);
  }
  for (const list of holdingSeries.values()) list.sort((a, b) => a.asOf.localeCompare(b.asOf));

  const finalDate = dates[dates.length - 1] ?? "";
  const out: NetWorthPoint[] = [];
  for (const date of dates) {
    let assets = new D(0);
    let liabilities = new D(0);
    let crypto = new D(0);
    let constant = new D(0);
    const add = (amount: string, cur: string, isCrypto: boolean) => {
      const now = fx.convert({ amount, currency: cur }, currency, date);
      const fixed = fx.convert({ amount, currency: cur }, currency, finalDate);
      if (!now || !fixed) return;
      const v: DecimalValue = dec(now.amount);
      if (v.isNegative()) liabilities = liabilities.plus(v.abs());
      else assets = assets.plus(v);
      if (isCrypto) crypto = crypto.plus(v);
      constant = constant.plus(dec(fixed.amount));
    };
    for (const [, list] of balanceSeries) {
      const point = latestOnOrBefore(list, date);
      if (point) add(point.balance, point.currency, false);
    }
    for (const [, list] of holdingSeries) {
      const point = latestOnOrBefore(list, date);
      if (point) add(point.quantity, point.currency, true);
    }
    out.push({
      date,
      netWorth: toPlain(assets.minus(liabilities).toDecimalPlaces(8)),
      assets: toPlain(assets.toDecimalPlaces(8)),
      liabilities: toPlain(liabilities.toDecimalPlaces(8)),
      crypto: toPlain(crypto.toDecimalPlaces(8)),
      netWorthAtConstantRates: toPlain(constant.toDecimalPlaces(8)),
    });
  }
  return out;
}
