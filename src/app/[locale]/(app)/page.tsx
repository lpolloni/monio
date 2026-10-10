import { Suspense } from "react";
import { HomeEmpty, HomeView, type AccountLite, type HomeViewModel } from "@/components/home/home-view";
import { Skeleton } from "@/components/ui/primitives";
import { institutionShortLabel } from "@/lib/institutions";
import { getHomeOverview } from "@/server/data/overview";

async function HomeContent() {
  const o = await getHomeOverview();
  if (!o.hasData) return <HomeEmpty />;

  const institutionAccounts: Record<string, AccountLite[]> = {};
  const institutionMeta: HomeViewModel["institutionMeta"] = {};
  for (const inst of o.portfolio.institutions) {
    institutionMeta[inst.key] = { country: inst.country, entityKinds: inst.entityKinds };
    institutionAccounts[inst.key] = inst.accountIds
      .map((id) => o.portfolio.accounts.find((a) => a.accountId === id))
      .filter((a): a is NonNullable<typeof a> => !!a)
      .map((a) => ({
        id: a.accountId,
        name: a.name,
        type: a.type,
        currency: a.currency,
        nativeBalance: a.balance,
        value: a.value,
        mask: o.accounts.find((r) => r.accountId === a.accountId)?.accountMask ?? null,
        lastUpdated: a.lastSyncedAt ?? a.balanceAsOf,
        entityKind: a.entityKind,
        creditLimit: a.creditLimit ?? null,
        holdings: (a.holdings ?? []).map((h) => ({ symbol: h.symbol, quantity: h.quantity, currency: h.currency })),
      }));
  }

  const model: HomeViewModel = {
    now: new Date().toISOString(),
    today: o.today,
    currency: o.currency,
    displayName: o.displayName,
    netWorth: o.portfolio.netWorth,
    assets: o.portfolio.assets,
    liabilities: o.portfolio.liabilities,
    available: o.portfolio.available,
    businessNetWorth: o.portfolio.businessNetWorth,
    includeBusiness: o.portfolio.includeBusiness,
    groups: o.portfolio.groups,
    nodes: o.portfolio.institutions.map((i) => {
      const first = o.accounts.find((a) => a.accountId === i.accountIds[0]);
      return {
      key: i.key,
      name: i.name,
      short: institutionShortLabel(first?.institutionSlug, i.name, first?.wallet?.family ?? null),
      color: i.color,
      value: i.value,
      assets: i.assets,
      liabilities: i.liabilities,
      lastUpdated: i.lastUpdated,
      groups: i.groups,
      isBusiness: i.entityKinds.length === 1 && i.entityKinds[0] === "business",
      };
    }),
    institutionAccounts,
    institutionMeta,
    month: o.month,
    recent: o.recent.map((t) => ({
      id: t.id,
      bookedOn: t.bookedOn,
      description: t.description,
      merchant: t.merchant,
      amount: t.amount,
      currency: t.currency,
      converted: t.converted,
      displayCurrency: o.currency,
      categorySlug: t.categorySlug,
      classification: t.classification,
      status: t.status,
      duplicateOf: t.duplicateOf,
      accountName: t.accountName,
      institutionName: t.institutionName,
    })),
    attention: o.attention.map((a) => ({ id: a.id, kind: a.kind, payload: a.payload })),
    attentionCount: o.attentionCount,
    insights: o.insights.map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, params: i.params })),
    businessEntities: o.businessEntities,
    unvaluedCount: o.portfolio.unvalued.length,
  };
  return <HomeView model={model} />;
}

function HomeSkeleton() {
  return (
    <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1.15fr_0.85fr]">
      <Skeleton className="mx-auto aspect-square w-full max-w-[560px] !rounded-full opacity-60" />
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-16 w-80" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="mt-6 h-2 w-full" />
        <Skeleton className="mt-6 h-32 w-full !rounded-[1.6rem]" />
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <HomeContent />
    </Suspense>
  );
}
