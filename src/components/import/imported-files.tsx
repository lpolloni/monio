"use client";

import { FileText } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";
import { SectionHeader } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format";
import type { ImportedDocument } from "@/server/data/documents";
import { DeleteDocumentButton } from "./delete-document-button";

/** Every file imported so far, each removable with what it brought in. */
export function ImportedFiles({ documents }: { documents: ImportedDocument[] }) {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <section>
      <SectionHeader title={t("import.importedFiles")} />
      {documents.length === 0 ? (
        <p className="text-[14px] text-fg-muted">{t("explore.noDocuments")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 hairline">
              <FileText className="size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-fg">{d.filename}</span>
                <span className="block truncate text-[11.5px] text-fg-subtle">
                  <span className="uppercase">{d.format}</span> · {formatDate(d.createdAt.slice(0, 10), locale, "medium")} · {t("import.fileTransactions", { count: d.transactionCount })}
                  {d.periodStart && d.periodEnd ? ` · ${formatDate(d.periodStart, locale, "short")} – ${formatDate(d.periodEnd, locale, "short")}` : ""}
                </span>
              </span>
              <DeleteDocumentButton documentId={d.id} filename={d.filename} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
