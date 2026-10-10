import type { Metadata } from "next";
import { Suspense } from "react";
import { InsightsView } from "@/components/insights/insights-view";
import { PageHeader, Skeleton } from "@/components/ui/primitives";
import { getT } from "@/i18n/server";
import { getInsightsPageData } from "@/server/data/insights-page";

export const metadata: Metadata = { title: "Insights" };

async function InsightsContent() {
  const data = await getInsightsPageData();
  return <InsightsView data={data} />;
}

export default async function InsightsPage() {
  const t = await getT();
  return (
    <>
      <PageHeader title={t("insights.title")} subtitle={t("insights.subtitle")} />
      <Suspense
        fallback={
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <Skeleton className="h-28 !rounded-[1.5rem]" />
              <Skeleton className="h-28 !rounded-[1.5rem]" />
            </div>
            <Skeleton className="h-80 !rounded-[1.75rem]" />
            <Skeleton className="h-72 !rounded-[1.75rem]" />
          </div>
        }
      >
        <InsightsContent />
      </Suspense>
    </>
  );
}
