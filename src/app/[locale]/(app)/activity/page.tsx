import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import { ActivityView } from "@/components/activity/activity-view";
import { RecurringList } from "@/components/activity/recurring-list";
import { PageHeader, Skeleton } from "@/components/ui/primitives";
import { getLocale, getT } from "@/i18n/server";
import { cn } from "@/lib/utils";
import { getActivityData, getRecurringList, type ActivityPeriod } from "@/server/data/activity";

export const metadata: Metadata = { title: "Activity" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FiltersSchema = z.object({
  tab: z.enum(["transactions", "recurring"]).catch("transactions"),
  period: z.enum(["month", "last_month", "3m", "12m", "all"]).catch("3m"),
  account: z.uuid().optional().catch(undefined),
  category: z.union([z.uuid(), z.literal("uncategorized")]).optional().catch(undefined),
  q: z.string().max(60).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(50).catch(1),
});

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

async function ActivityContent({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const f = FiltersSchema.parse({
    tab: first(raw.tab) ?? "transactions",
    period: first(raw.period) ?? "3m",
    account: first(raw.account),
    category: first(raw.category),
    q: first(raw.q),
    page: first(raw.page) ?? 1,
  });
  const [t, locale] = await Promise.all([getT(), getLocale()]);
  const tabs = (
    <nav className="mb-6 flex gap-6 border-b border-border" aria-label={t("activity.title")}>
      {(["transactions", "recurring"] as const).map((tab) => (
        <Link
          key={tab}
          href={`/${locale}/activity${tab === "recurring" ? "?tab=recurring" : ""}`}
          aria-current={f.tab === tab ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 pb-3 text-[14px] font-medium transition-colors",
            f.tab === tab ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg",
          )}
        >
          {tab === "transactions" ? t("activity.tabTransactions") : t("activity.tabRecurring")}
        </Link>
      ))}
    </nav>
  );
  if (f.tab === "recurring") {
    const items = await getRecurringList();
    return (
      <>
        {tabs}
        <RecurringList items={items} />
      </>
    );
  }
  const data = await getActivityData({ period: f.period as ActivityPeriod, accountId: f.account, categoryId: f.category, q: f.q, page: f.page });
  return (
    <>
      {tabs}
      <ActivityView
        {...data}
        filters={{ period: f.period as ActivityPeriod, accountId: f.account, categoryId: f.category, q: f.q, page: f.page }}
      />
    </>
  );
}

export default async function ActivityPage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getT();
  return (
    <>
      <PageHeader title={t("activity.title")} subtitle={t("activity.subtitle")} />
      <Suspense
        fallback={
          <div className="flex flex-col gap-3">
            <Skeleton className="h-11 w-full !rounded-full" />
            <Skeleton className="h-20 w-full max-w-xl !rounded-[1.5rem]" />
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        }
      >
        <ActivityContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}
