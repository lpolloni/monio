import type { Metadata } from "next";
import { Suspense } from "react";
import { ImportView } from "@/components/import/import-view";
import { PageHeader, Skeleton } from "@/components/ui/primitives";
import { getT } from "@/i18n/server";
import { requireSession } from "@/server/data/session";
import { getServerEnv } from "@/server/env";

export const metadata: Metadata = { title: "Import" };

async function ImportContent() {
  await requireSession();
  return <ImportView maxMb={getServerEnv().IMPORT_MAX_FILE_MB} />;
}

export default async function ImportPage() {
  const t = await getT();
  return (
    <>
      <PageHeader title={t("import.title")} subtitle={t("import.subtitle")} />
      <Suspense fallback={<Skeleton className="h-72 !rounded-[2rem]" />}>
        <ImportContent />
      </Suspense>
    </>
  );
}
