import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { AccountDetailView } from "@/components/explore/account-detail-view";
import { Skeleton } from "@/components/ui/primitives";
import { institutionShortLabel } from "@/lib/institutions";
import { getAccountDetail } from "@/server/data/account-detail";

async function AccountContent({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  if (!z.uuid().safeParse(accountId).success) notFound();
  const detail = await getAccountDetail(accountId);
  if (!detail) notFound();
  const short = institutionShortLabel(detail.account.institutionSlug, detail.account.institutionName ?? detail.account.name, detail.account.wallet?.family ?? null);
  return <AccountDetailView detail={detail} short={short} now={new Date().toISOString()} />;
}

export default function AccountPage({ params }: { params: Promise<{ locale: string; accountId: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-6">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-96 max-w-full" />
          <Skeleton className="h-64 w-full !rounded-[1.75rem]" />
        </div>
      }
    >
      <AccountContent params={params} />
    </Suspense>
  );
}
