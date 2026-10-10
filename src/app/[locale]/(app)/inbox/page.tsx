import type { Metadata } from "next";
import { Suspense } from "react";
import { InboxView } from "@/components/inbox/inbox-view";
import { PageHeader, Skeleton } from "@/components/ui/primitives";
import { getT } from "@/i18n/server";
import { getOpenInbox } from "@/server/data/inbox";
import { getCategories } from "@/server/data/queries";
import { requireSession } from "@/server/data/session";

export const metadata: Metadata = { title: "Inbox" };

async function InboxContent() {
  const { supabase } = await requireSession();
  const [items, categories, { data: institutions }] = await Promise.all([
    getOpenInbox(),
    getCategories(),
    supabase.from("institutions").select("id, name, country").order("name"),
  ]);
  return (
    <InboxView
      items={items.map((i) => ({ id: i.id, kind: i.kind, payload: i.payload }))}
      categories={categories.filter((c) => c.isSystem).map((c) => ({ id: c.id, slug: c.slug, kind: c.kind }))}
      institutions={(institutions ?? []).map((i) => ({ id: i.id, name: i.name, country: i.country }))}
    />
  );
}

export default async function InboxPage() {
  const t = await getT();
  return (
    <>
      <div className="mx-auto max-w-3xl">
        <PageHeader title={t("inbox.title")} subtitle={t("inbox.subtitle")} />
      </div>
      <Suspense
        fallback={
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-32 !rounded-[1.6rem]" />
            ))}
          </div>
        }
      >
        <InboxContent />
      </Suspense>
    </>
  );
}
