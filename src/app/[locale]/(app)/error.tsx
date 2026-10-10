"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";

/** Route-level error state. Never shows technical details or financial data. */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("common");
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-24 text-center" role="alert">
      <h1 className="font-display text-[2.4rem] leading-tight text-fg">{t("somethingWrong")}</h1>
      <p className="text-[15px] text-fg-muted">{t("tryAgainLater")}</p>
      <Button onClick={reset} variant="secondary">
        <RefreshCw />
        {t("retry")}
      </Button>
    </div>
  );
}
