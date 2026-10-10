import "server-only";
import { computeCashflow } from "@/domain/analytics/cashflow";
import { addDaysIso, addMonthsToKey, monthEnd, monthKey, monthStart } from "@/domain/analytics/periods";
import { dec, toScale } from "@/domain/money/decimal";
import { accountLabel } from "@/lib/institutions";
import { todayIso } from "./dates";
import { getAccounts, getCategories, getFxTable, getTransactionsInRange } from "./queries";
import { getProfile, requireSession } from "./session";
import { queryActivity, toFlow } from "./transactions";

export type ActivityPeriod = "month" | "last_month" | "3m" | "12m" | "all";

export interface ActivityFilterInput {
  period: ActivityPeriod;
  accountId?: string;
  categoryId?: string;
  q?: string;
  page: number;
}

export interface ActivityRow {
  id: string;
  bookedOn: string;
  description: string;
  merchant: string | null;
  amount: string;
  currency: string;
  converted: string | null;
  displayCurrency: string;
  categorySlug: string | null;
  categoryId: string | null;
  categorySource: string | null;
  categoryConfidence: string | null;
  classification: string;
  status: string;
  duplicateOf: string | null;
  accountId: string;
  accountName: string;
  institutionName: string | null;
  originalAmount: string | null;
  originalCurrency: string | null;
  documentName: string | null;
  sourceRow: number | null;
  extraction: string | null;
  source: string;
  counterpartAccount: string | null;
}

export const PAGE_SIZE = 60;

export function periodRange(period: ActivityPeriod, today: string): { from?: string; to: string } {
  const current = monthKey(today);
  switch (period) {
    case "month":
      return { from: monthStart(current), to: today };
    case "last_month": {
      const prev = addMonthsToKey(current, -1);
      return { from: monthStart(prev), to: monthEnd(prev) };
    }
    case "3m":
      return { from: addDaysIso(today, -90), to: today };
    case "12m":
      return { from: addDaysIso(today, -365), to: today };
    default:
      return { to: today };
  }
}

export async function getActivityData(filters: ActivityFilterInput) {
  const [{ supabase }, profile] = await Promise.all([requireSession(), getProfile()]);
  const today = todayIso();
  const range = periodRange(filters.period, today);
  const currency = profile.primaryCurrency;
  const [accounts, categories, fx] = await Promise.all([getAccounts(), getCategories(), getFxTable(range.from ? addDaysIso(range.from, -7) : addDaysIso(today, -800), today)]);
  const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  const { rows, total } = await queryActivity(supabase, {
    from: range.from,
    to: range.to,
    accountIds: filters.accountId ? [filters.accountId] : undefined,
    categoryId: filters.categoryId,
    search: filters.q,
    limit: PAGE_SIZE * filters.page,
    offset: 0,
  });

  const docIds = [...new Set(rows.map((r) => r.documentId).filter((d): d is string => !!d))];
  const { data: docs } = docIds.length
    ? await supabase.from("documents").select("id, original_filename").in("id", docIds)
    : { data: [] as { id: string; original_filename: string }[] };
  const docName = new Map((docs ?? []).map((d) => [d.id, d.original_filename]));
  const counterpartIds = rows.map((r) => r.counterpartId).filter((x): x is string => !!x);
  const { data: counterparts } = counterpartIds.length
    ? await supabase.from("transactions").select("id, account_id").in("id", counterpartIds)
    : { data: [] as { id: string; account_id: string }[] };
  const counterpartAccount = new Map((counterparts ?? []).map((c) => [c.id, c.account_id]));

  const mapped: ActivityRow[] = rows.map((r) => {
    const account = accountMap.get(r.accountId);
    const category = r.categoryId ? categoryMap.get(r.categoryId) : undefined;
    const cpAccount = r.counterpartId ? accountMap.get(counterpartAccount.get(r.counterpartId) ?? "") : undefined;
    return {
      id: r.id,
      bookedOn: r.bookedOn,
      description: r.description,
      merchant: r.merchant,
      amount: r.amount,
      currency: r.currency,
      converted: r.currency === currency ? null : (fx.convert({ amount: r.amount, currency: r.currency }, currency, r.bookedOn)?.amount ?? null),
      displayCurrency: currency,
      categorySlug: category?.slug ?? null,
      categoryId: r.categoryId,
      categorySource: r.categorySource,
      categoryConfidence: r.categoryConfidence,
      classification: r.classification,
      status: r.status,
      duplicateOf: r.duplicateOf,
      accountId: r.accountId,
      accountName: account?.name ?? "",
      institutionName: account?.institutionName ?? null,
      originalAmount: r.originalAmount,
      originalCurrency: r.originalCurrency,
      documentName: r.documentId ? (docName.get(r.documentId) ?? null) : null,
      sourceRow: r.sourceRow,
      extraction: r.extraction,
      source: r.source,
      counterpartAccount: cpAccount ? accountLabel(cpAccount.institutionName, cpAccount.name) : null,
    };
  });

  // Period summary over ALL matching rows (not only the loaded page).
  const all = await getTransactionsInRange(range.from ?? addDaysIso(today, -800), range.to);
  const q = filters.q?.toLowerCase().trim();
  const summaryRows = all.filter(
    (t) =>
      (!filters.accountId || t.accountId === filters.accountId) &&
      (!filters.categoryId || (filters.categoryId === "uncategorized" ? !t.categoryId : t.categoryId === filters.categoryId)) &&
      (!q || t.description.toLowerCase().includes(q) || (t.merchant ?? "").toLowerCase().includes(q)),
  );
  const flow = computeCashflow(summaryRows.map((t) => toFlow(t, accountMap, categoryMap)), fx, currency, {
    from: range.from ?? "0000-01-01",
    to: range.to,
    includeBusiness: profile.includeBusiness || accountMap.get(filters.accountId ?? "")?.entityKind === "business",
  });

  return {
    rows: mapped,
    total,
    hasMore: total > mapped.length,
    currency,
    today,
    summary: { income: flow.income, expenses: flow.expenses, net: flow.net },
    accounts: accounts.map((a) => ({ id: a.accountId, name: a.name, institutionName: a.institutionName })),
    categories: categories.filter((c) => c.isSystem).map((c) => ({ id: c.id, slug: c.slug, kind: c.kind })),
  };
}

export async function getRecurringList() {
  const [{ supabase }, profile] = await Promise.all([requireSession(), getProfile()]);
  const today = todayIso();
  const [accounts, categories, fx] = await Promise.all([getAccounts(), getCategories(), getFxTable(addDaysIso(today, -10), today)]);
  const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
  const categoryMap = new Map(categories.map((c) => [c.id, c.slug]));
  const { data, error } = await supabase
    .from("recurring_series")
    .select("id, account_id, merchant, category_id, cadence, average_amount:average_amount::text, last_amount:last_amount::text, currency, last_seen_on, next_expected_on, occurrences, is_subscription, status")
    .neq("status", "dismissed")
    .order("next_expected_on", { ascending: true });
  if (error) throw error;
  const monthlyFactor: Record<string, string> = { weekly: "4.345", monthly: "1", quarterly: "0.3333333333", yearly: "0.0833333333" };
  return (data ?? []).map((s) => {
    const converted = fx.convert({ amount: s.last_amount, currency: s.currency }, profile.primaryCurrency, today);
    const account = s.account_id ? accountMap.get(s.account_id) : undefined;
    return {
      id: s.id,
      merchant: s.merchant,
      categorySlug: s.category_id ? (categoryMap.get(s.category_id) ?? null) : null,
      cadence: s.cadence,
      lastAmount: s.last_amount,
      averageAmount: s.average_amount,
      currency: s.currency,
      lastSeenOn: s.last_seen_on,
      nextExpectedOn: s.next_expected_on,
      occurrences: s.occurrences,
      isSubscription: s.is_subscription,
      status: s.status,
      accountName: account ? accountLabel(account.institutionName, account.name) : null,
      monthlyEquivalent: converted ? toScale(dec(converted.amount).times(dec(monthlyFactor[s.cadence] ?? "1")), 2) : null,
      displayCurrency: profile.primaryCurrency,
    };
  });
}
