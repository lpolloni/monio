import { assetGroupFor, countsAsPersonal, isLiquidType, type AssetGroup, type EntityKind } from "../accounts/classification";
import type { FxTable } from "../fx/fx-table";
import type { AccountType } from "../import/types";
import { D, dec, toPlain, type DecimalValue } from "../money/decimal";

export interface HoldingPosition {
  /** Currency/asset code used for pricing (BTC, ETH, USDC...). */
  currency: string;
  quantity: string;
  symbol: string;
  network?: string;
}

export interface AccountPosition {
  accountId: string;
  name: string;
  type: AccountType;
  currency: string;
  entityId: string;
  entityKind: EntityKind;
  entityName: string;
  institutionId: string | null;
  institutionName: string | null;
  institutionColor: string | null;
  country: string | null;
  includeInNetWorth: boolean;
  /** Signed balance in the account currency (liabilities negative). Null when unknown. */
  balance: string | null;
  balanceAsOf: string | null;
  /** For crypto wallets: holdings valued at market prices instead of `balance`. */
  holdings?: HoldingPosition[];
  lastSyncedAt: string | null;
  creditLimit?: string | null;
}

export interface ValuedAccount extends AccountPosition {
  /** Signed value in the display currency, or null if it could not be converted. */
  value: string | null;
  group: AssetGroup;
  countedInNetWorth: boolean;
  staleRate: boolean;
}

export interface InstitutionSummary {
  key: string;
  institutionId: string | null;
  name: string;
  color: string | null;
  country: string | null;
  value: string;
  assets: string;
  liabilities: string;
  accountIds: string[];
  entityKinds: EntityKind[];
  lastUpdated: string | null;
  groups: AssetGroup[];
}

export interface PortfolioSummary {
  currency: string;
  asOf: string;
  netWorth: string;
  assets: string;
  liabilities: string;
  available: string;
  /** Business net worth, always reported separately. */
  businessNetWorth: string;
  includeBusiness: boolean;
  groups: Record<AssetGroup, string>;
  byCurrency: { currency: string; value: string }[];
  institutions: InstitutionSummary[];
  accounts: ValuedAccount[];
  /** Positions that could not be valued (missing balance or exchange rate). */
  unvalued: { accountId: string; reason: "no_balance" | "no_rate"; currency?: string }[];
}

interface Valuation {
  value: DecimalValue;
  stale: boolean;
  missing: { reason: "no_balance" | "no_rate"; currency?: string } | null;
  nativeByCurrency: Map<string, DecimalValue>;
}

function valuePosition(p: AccountPosition, fx: FxTable, currency: string, asOf: string): Valuation {
  const nativeByCurrency = new Map<string, DecimalValue>();
  if (p.holdings && p.holdings.length > 0) {
    let total = new D(0);
    let stale = false;
    for (const h of p.holdings) {
      const converted = fx.convert({ amount: h.quantity, currency: h.currency }, currency, asOf);
      if (!converted) return { value: total, stale, missing: { reason: "no_rate", currency: h.currency }, nativeByCurrency };
      total = total.plus(dec(converted.amount));
      stale ||= converted.stale;
      nativeByCurrency.set(h.currency, (nativeByCurrency.get(h.currency) ?? new D(0)).plus(dec(converted.amount)));
    }
    return { value: total, stale, missing: null, nativeByCurrency };
  }
  if (p.balance === null) return { value: new D(0), stale: false, missing: { reason: "no_balance" }, nativeByCurrency };
  const converted = fx.convert({ amount: p.balance, currency: p.currency }, currency, asOf);
  if (!converted) {
    return { value: new D(0), stale: false, missing: { reason: "no_rate", currency: p.currency }, nativeByCurrency };
  }
  nativeByCurrency.set(p.currency, dec(converted.amount));
  return { value: dec(converted.amount), stale: converted.stale, missing: null, nativeByCurrency };
}

/**
 * Consolidates account positions into a portfolio in one display currency.
 *
 * Rules:
 *  - Assets = positive values, liabilities = |negative values| (card debt, loans, overdrafts).
 *  - Net worth = assets − liabilities, personal (+ shared) by default; business is reported
 *    separately and only included when `includeBusiness` is set.
 *  - Credit limits are never assets.
 *  - Available balance = positive balances of liquid accounts (checking, savings, cash).
 *  - Conversions use the latest rate on or before `asOf`; originals are untouched.
 */
export function computePortfolio(
  positions: AccountPosition[],
  fx: FxTable,
  currency: string,
  asOf: string,
  options: { includeBusiness: boolean },
): PortfolioSummary {
  let assets = new D(0);
  let liabilities = new D(0);
  let available = new D(0);
  let business = new D(0);
  const groups: Record<AssetGroup, DecimalValue> = {
    cash: new D(0),
    investments: new D(0),
    crypto: new D(0),
    liabilities: new D(0),
    other: new D(0),
  };
  const byCurrency = new Map<string, DecimalValue>();
  const institutions = new Map<string, InstitutionSummary & { _v: DecimalValue; _a: DecimalValue; _l: DecimalValue }>();
  const accounts: ValuedAccount[] = [];
  const unvalued: PortfolioSummary["unvalued"] = [];

  for (const p of positions) {
    const valuation = valuePosition(p, fx, currency, asOf);
    if (valuation.missing) unvalued.push({ accountId: p.accountId, ...valuation.missing });
    const value = valuation.value;
    const negative = value.isNegative() && !value.isZero();
    const group = assetGroupFor(p.type, negative);
    const counted = p.includeInNetWorth && countsAsPersonal(p.entityKind, options.includeBusiness) && !valuation.missing;

    if (p.entityKind === "business" && p.includeInNetWorth && !valuation.missing) business = business.plus(value);

    if (counted) {
      if (negative) liabilities = liabilities.plus(value.abs());
      else assets = assets.plus(value);
      groups[group] = groups[group].plus(negative ? value.abs() : value);
      if (!negative && isLiquidType(p.type)) available = available.plus(value);
      for (const [code, v] of valuation.nativeByCurrency) {
        byCurrency.set(code, (byCurrency.get(code) ?? new D(0)).plus(v));
      }
    }

    accounts.push({
      ...p,
      value: valuation.missing ? null : toPlain(value),
      group,
      countedInNetWorth: counted,
      staleRate: valuation.stale,
    });

    const key = p.institutionId ?? `unknown:${p.institutionName ?? p.name}`;
    const inst =
      institutions.get(key) ??
      {
        key,
        institutionId: p.institutionId,
        name: p.institutionName ?? p.name,
        color: p.institutionColor,
        country: p.country,
        value: "0",
        assets: "0",
        liabilities: "0",
        accountIds: [],
        entityKinds: [],
        lastUpdated: null,
        groups: [],
        _v: new D(0),
        _a: new D(0),
        _l: new D(0),
      };
    inst.accountIds.push(p.accountId);
    if (!inst.entityKinds.includes(p.entityKind)) inst.entityKinds.push(p.entityKind);
    if (!inst.groups.includes(group)) inst.groups.push(group);
    if (!valuation.missing) {
      inst._v = inst._v.plus(value);
      if (negative) inst._l = inst._l.plus(value.abs());
      else inst._a = inst._a.plus(value);
    }
    const updated = p.lastSyncedAt ?? p.balanceAsOf;
    if (updated && (!inst.lastUpdated || updated > inst.lastUpdated)) inst.lastUpdated = updated;
    institutions.set(key, inst);
  }

  const institutionList = [...institutions.values()]
    .map(({ _v, _a, _l, ...rest }) => ({ ...rest, value: toPlain(_v), assets: toPlain(_a), liabilities: toPlain(_l) }))
    .sort((a, b) => dec(b.assets).comparedTo(dec(a.assets)));

  return {
    currency,
    asOf,
    netWorth: toPlain(assets.minus(liabilities)),
    assets: toPlain(assets),
    liabilities: toPlain(liabilities),
    available: toPlain(available),
    businessNetWorth: toPlain(business),
    includeBusiness: options.includeBusiness,
    groups: {
      cash: toPlain(groups.cash),
      investments: toPlain(groups.investments),
      crypto: toPlain(groups.crypto),
      liabilities: toPlain(groups.liabilities),
      other: toPlain(groups.other),
    },
    byCurrency: [...byCurrency.entries()]
      .map(([code, v]) => ({ currency: code, value: toPlain(v) }))
      .sort((a, b) => dec(b.value).comparedTo(dec(a.value))),
    institutions: institutionList,
    accounts,
    unvalued,
  };
}
