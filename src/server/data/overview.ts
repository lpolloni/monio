import "server-only";
import { computeCashflow } from "@/domain/analytics/cashflow";
import { addDaysIso, monthKey, monthStart } from "@/domain/analytics/periods";
import { sum, toPlain } from "@/domain/money/decimal";
import { computePortfolio, type PortfolioSummary } from "@/domain/portfolio/portfolio";
import { todayIso } from "./dates";
import type { AccountRecord } from "./finance";
import { getAccounts, getCategories, getFxTable, getTransactionsInRange } from "./queries";
import { getInboxPreview, type InboxItemView } from "./inbox";
import { getInsightsList, type InsightView } from "./insights";
import { getProfile, requireSession } from "./session";
import { toFlow, type TransactionRow } from "./transactions";

export interface RecentTransaction extends TransactionRow {
  accountName: string;
  institutionName: string | null;
  institutionColor: string | null;
  categorySlug: string | null;
  categoryHue: number | null;
  categoryIcon: string | null;
  converted: string | null;
}

export interface HomeOverview {
  today: string;
  currency: string;
  displayName: string | null;
  portfolio: PortfolioSummary;
  month: { from: string; to: string; income: string; expenses: string; net: string; count: number };
  recent: RecentTransaction[];
  attention: InboxItemView[];
  attentionCount: number;
  insights: InsightView[];
  businessEntities: { name: string; value: string }[];
  hasData: boolean;
  accounts: AccountRecord[];
}

export async function getHomeOverview(): Promise<HomeOverview> {
  const [{ supabase }, profile] = await Promise.all([requireSession(), getProfile()]);
  const today = todayIso();
  const currency = profile.primaryCurrency;
  const from = monthStart(monthKey(today));
  const fx = await getFxTable(addDaysIso(from, -45), today);
  const [accounts, categories, monthTx, inbox, insights] = await Promise.all([
    getAccounts(),
    getCategories(),
    getTransactionsInRange(addDaysIso(from, -30), today),
    getInboxPreview(3),
    getInsightsList(3),
  ]);

  const portfolio = computePortfolio(accounts, fx, currency, today, { includeBusiness: profile.includeBusiness });
  const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const flow = computeCashflow(
    monthTx.map((t) => toFlow(t, accountMap, categoryMap)),
    fx,
    currency,
    { from, to: today, includeBusiness: profile.includeBusiness },
  );

  const recent = monthTx.slice(0, 7).map((t): RecentTransaction => {
    const account = accountMap.get(t.accountId);
    const category = t.categoryId ? categoryMap.get(t.categoryId) : undefined;
    return {
      ...t,
      accountName: account?.name ?? "",
      institutionName: account?.institutionName ?? null,
      institutionColor: account?.institutionColor ?? null,
      categorySlug: category?.slug ?? null,
      categoryHue: category?.hue ?? null,
      categoryIcon: category?.icon ?? null,
      converted: t.currency === currency ? null : (fx.convert({ amount: t.amount, currency: t.currency }, currency, t.bookedOn)?.amount ?? null),
    };
  });

  const businessByEntity = new Map<string, { name: string; value: string }>();
  for (const a of portfolio.accounts) {
    if (a.entityKind !== "business" || a.value === null || !a.includeInNetWorth) continue;
    const prev = businessByEntity.get(a.entityId);
    businessByEntity.set(a.entityId, { name: a.entityName, value: toPlain(sum([prev?.value ?? "0", a.value])) });
  }

  void supabase;
  return {
    today,
    currency,
    displayName: profile.displayName,
    portfolio,
    month: { from, to: today, income: flow.income, expenses: flow.expenses, net: flow.net, count: flow.transactionCount },
    recent,
    attention: inbox.items,
    attentionCount: inbox.total,
    insights,
    businessEntities: [...businessByEntity.values()],
    hasData: accounts.length > 0,
    accounts,
  };
}
