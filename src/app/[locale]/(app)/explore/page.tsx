import type { Metadata } from "next";
import { Suspense } from "react";
import { ExploreView, type ExploreInstitution } from "@/components/explore/explore-view";
import { PageHeader, Skeleton } from "@/components/ui/primitives";
import { computePortfolio } from "@/domain/portfolio/portfolio";
import { addDaysIso } from "@/domain/analytics/periods";
import { getT } from "@/i18n/server";
import { institutionShortLabel } from "@/lib/institutions";
import { todayIso } from "@/server/data/dates";
import { getAccounts, getFxTable } from "@/server/data/queries";
import { getProfile } from "@/server/data/session";

export const metadata: Metadata = { title: "Explore" };

async function ExploreContent() {
  const profile = await getProfile();
  const today = todayIso();
  const [accounts, fx] = await Promise.all([getAccounts(), getFxTable(addDaysIso(today, -10), today)]);
  const portfolio = computePortfolio(accounts, fx, profile.primaryCurrency, today, { includeBusiness: profile.includeBusiness });
  const valued = new Map(portfolio.accounts.map((a) => [a.accountId, a]));
  const institutions: ExploreInstitution[] = portfolio.institutions.map((inst) => {
    const records = inst.accountIds.map((id) => accounts.find((a) => a.accountId === id)!).filter(Boolean);
    const first = records[0];
    return {
      key: inst.key,
      name: inst.name,
      short: institutionShortLabel(first?.institutionSlug, inst.name, first?.wallet?.family ?? null),
      color: inst.color,
      country: first?.wallet ? "chain" : (inst.country ?? first?.country ?? "none"),
      value: inst.value,
      accounts: records.map((a) => {
        const v = valued.get(a.accountId);
        return {
          id: a.accountId,
          name: a.name,
          type: a.type,
          group: v?.group ?? "other",
          currency: a.currency,
          balance: a.balance,
          value: v?.value ?? null,
          mask: a.accountMask,
          creditLimit: a.creditLimit ?? null,
          entityKind: a.entityKind,
          entityName: a.entityName,
          lastUpdated: a.lastSyncedAt ?? a.balanceAsOf,
          holdings: (a.holdings ?? []).map((h) => ({ symbol: h.symbol, quantity: h.quantity })),
          isWallet: !!a.wallet,
          countedInNetWorth: v?.countedInNetWorth ?? false,
        };
      }),
    };
  });
  return <ExploreView institutions={institutions} currency={profile.primaryCurrency} now={new Date().toISOString()} />;
}

export default async function ExplorePage() {
  const t = await getT();
  return (
    <>
      <PageHeader title={t("explore.title")} subtitle={t("explore.subtitle")} />
      <Suspense
        fallback={
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-56 !rounded-[1.75rem]" />
            ))}
          </div>
        }
      >
        <ExploreContent />
      </Suspense>
    </>
  );
}
