import type { Metadata } from "next";
import { Suspense } from "react";
import { ImportView } from "@/components/import/import-view";
import { ImportedFiles } from "@/components/import/imported-files";
import { PageHeader, Skeleton } from "@/components/ui/primitives";
import { getT } from "@/i18n/server";
import { getImportedDocuments } from "@/server/data/documents";
import { requireSession } from "@/server/data/session";
import { getServerEnv } from "@/server/env";

export const metadata: Metadata = { title: "Import" };

async function ImportContent() {
  await requireSession();
  const documents = await getImportedDocuments();
  return (
    <div className="flex flex-col gap-10">
      <ImportView maxMb={getServerEnv().IMPORT_MAX_FILE_MB} />
      <ImportedFiles documents={documents} />
    </div>
  );
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
