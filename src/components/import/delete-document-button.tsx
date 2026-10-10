"use client";

import { LoaderCircle, Trash2, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { deleteDocument } from "@/server/actions/accounts";

/** Trash button for one imported file; asks before deleting it with everything it brought in. */
export function DeleteDocumentButton({ documentId, filename }: { documentId: string; filename: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm() {
    startTransition(async () => {
      const r = await deleteDocument(documentId);
      if (r.ok) {
        toast.success(t("import.fileDeleted", { count: r.removed.transactions }));
        setOpen(false);
      } else toast.error(r.error === "busy" ? t("import.fileBusy") : t("common.somethingWrong"));
    });
  }

  return (
    <>
      <Button type="button" size="icon-sm" variant="ghost" aria-label={`${t("import.deleteFile")}: ${filename}`} onClick={() => setOpen(true)}>
        <Trash2 />
      </Button>
      <Sheet open={open} onOpenChange={setOpen} title={t("import.deleteFile")} description={filename} closeLabel={t("common.close")}>
        <div className="flex flex-col gap-6 px-6 pt-2 pb-6">
          <p className="flex items-start gap-2 text-[13.5px] leading-relaxed text-fg-muted">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            {t("import.deleteFileHint")}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="danger" disabled={pending} onClick={onConfirm}>
              {pending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {t("common.deletePermanently")}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
