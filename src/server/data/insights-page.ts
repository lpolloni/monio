import "server-only";
import { computeCashflow, type Breakdown } from "@/domain/analytics/cashflow";
import { dailyBalances } from "@/domain/analytics/balance-series";
import { computeNetWorthHistory, type BalancePoint } from "@/domain/analytics/net-worth-history";
import { addDaysIso, addMonthsToKey, monthEnd, monthKey, monthStart, monthsBetween } from "@/domain/analytics/periods";
import { computePortfolio } from "@/domain/portfolio/portfolio";
import { todayIso } from "./dates";
import { getInsightsList, type InsightView } from "./insights";
import { getAccounts, getCategories, getFxTable, getTransactionsInRange } from "./queries";
import { getProfile, requireSession } from "./session";
import { toFlow } from "./transactions";

export interface InsightsPageData {
  currency: string;
  today: string;
  currentMonth: string;
  months: string[];
  cashflow: { month: string; income: string; expenses: string; net: string; complete: boolean }[];
  categoriesByMonth: Record<string, Breakdown[]>;
  breakdowns: Record<string, { countries: Breakdown[]; institutions: (Breakdown & { name: string })[]; currencies: Breakdown[]; merchants: Breakdown[] }>;
  netWorth: { date: string; netWorth: string; atConstantRates: string; crypto: string }[];
  groups: Record<string, string>;
  insights: InsightView[];
}

export async function getInsightsPageData(): Promise<InsightsPageData> {
  const [{ supabase, userId }, profile] = await Promise.all([requireSession(), getProfile()]);
  const today = todayIso();
  const currentMonth = monthKey(today);
  const firstMonth = addMonthsToKey(currentMonth, -11);
  const from = monthStart(firstMonth);
  const currency = profile.primaryCurrency;
  const [accounts, categories, fx, transactions, insights] = await Promise.all([
    getAccounts(),
    getCategories(),
    getFxTable(from, today),
    getTransactionsInRange(from, today),
    getInsightsList(20),
  ]);
  const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const flows = transactions.map((t) => toFlow(t, accountMap, categoryMap));
  const months = monthsBetween(firstMonth, currentMonth);

  const total = computeCashflow(flows, fx, currency, { from, to: today, includeBusiness: profile.includeBusiness });
  const categoriesByMonth: InsightsPageData["categoriesByMonth"] = {};
  const breakdowns: InsightsPageData["breakdowns"] = {};
  for (const m of months) {
    const cf = computeCashflow(flows, fx, currency, { from: monthStart(m), to: m === currentMonth ? today : monthEnd(m), includeBusiness: profile.includeBusiness });
    categoriesByMonth[m] = cf.expensesByCategory.slice(0, 14);
    breakdowns[m] = {
      countries: cf.expensesByCountry,
      institutions: cf.expensesByInstitution.map((b) => ({
        ...b,
        name: accounts.find((a) => a.institutionId === b.key)?.institutionName ?? b.key,
      })),
      currencies: cf.expensesByCurrency,
      merchants: cf.expensesByMerchant.slice(0, 8),
    };
  }

  // Net worth on every day of the period.
  const dates: string[] = [];
  for (let day = from; day <= today; day = addDaysIso(day, 1)) dates.push(day);
  const accountIds = accounts.map((a) => a.accountId);
  const { data: balances } = await supabase
    .from("account_balances")
    .select("account_id, as_of, balance:balance::text, currency")
    .eq("user_id", userId)
    .in("account_id", accountIds)
    .lte("as_of", today)
    .order("as_of", { ascending: true })
    .limit(5000);
  const walletToAccount = new Map(accounts.filter((a) => a.wallet).map((a) => [a.wallet!.id, a.accountId]));
  const { data: holdingRows } = walletToAccount.size
    ? await supabase
        .from("wallet_holdings")
        .select("wallet_id, as_of, quantity:quantity::text, asset:crypto_assets(currency_code, symbol)")
        .eq("user_id", userId)
        .order("as_of", { ascending: true })
        .limit(5000)
    : { data: [] };
  const holdings = (holdingRows ?? []).flatMap((h) => {
    const asset = Array.isArray(h.asset) ? h.asset[0] : h.asset;
    const accountId = walletToAccount.get(h.wallet_id);
    const code = asset?.currency_code;
    return accountId && code ? [{ accountId, asOf: h.as_of, currency: code, quantity: h.quantity }] : [];
  });
  // Statement balances only mark the start and end of each statement: walk them
  // through the booked movements to know the balance on the days in between.
  const dailyPoints: BalancePoint[] = [];
  for (const account of accounts) {
    const snapshots = (balances ?? []).filter((b) => b.account_id === account.accountId);
    for (const cur of new Set(snapshots.map((b) => b.currency))) {
      const movements = transactions.filter((t) => t.accountId === account.accountId && t.currency === cur && t.status === "posted" && !t.duplicateOf);
      const series = dailyBalances(snapshots.filter((b) => b.currency === cur).map((b) => ({ asOf: b.as_of, balance: b.balance })), movements, { movementsFrom: from });
      dailyPoints.push(...series.map((p) => ({ accountId: account.accountId, asOf: p.date, balance: p.balance, currency: cur })));
    }
  }
  const history = computeNetWorthHistory(
    accounts.map((a) => ({ accountId: a.accountId, entityKind: a.entityKind, includeInNetWorth: a.includeInNetWorth, isCrypto: a.type === "crypto_wallet" })),
    dailyPoints,
    holdings,
    fx,
    currency,
    dates,
    { includeBusiness: profile.includeBusiness },
  );
  const portfolio = computePortfolio(accounts, fx, currency, today, { includeBusiness: profile.includeBusiness });

  return {
    currency,
    today,
    currentMonth,
    months,
    cashflow: total.byMonth.map((m) => ({ ...m, complete: m.month !== currentMonth })),
    categoriesByMonth,
    breakdowns,
    netWorth: history.map((p) => ({ date: p.date, netWorth: p.netWorth, atConstantRates: p.netWorthAtConstantRates, crypto: p.crypto })),
    groups: portfolio.groups,
    insights,
  };
}
