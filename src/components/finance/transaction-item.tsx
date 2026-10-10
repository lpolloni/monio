"use client";

import { ArrowLeftRight, Copy, CreditCard } from "lucide-react";
import { useTranslations } from "use-intl";
import { Badge } from "@/components/ui/primitives";
import { cn, prettyDescription } from "@/lib/utils";
import { CategoryIcon } from "./category-icon";
import { Money } from "./money";

export interface TransactionItemData {
  id: string;
  bookedOn: string;
  description: string;
  merchant: string | null;
  amount: string;
  currency: string;
  converted: string | null;
  displayCurrency: string;
  categorySlug: string | null;
  classification: string;
  status: string;
  duplicateOf: string | null;
  accountName: string;
  institutionName: string | null;
}

/** One transaction row: who, what, where — and the amount in its original currency. */
export function TransactionItem({ tx, onSelect, compact = false }: { tx: TransactionItemData; onSelect?: () => void; compact?: boolean }) {
  const t = useTranslations();
  const isTransfer = tx.classification !== "regular";
  const title = tx.merchant ?? prettyDescription(tx.description);
  const categoryLabel = tx.categorySlug
    ? t(`categories.${tx.categorySlug}` as "categories.groceries")
    : t("categories.uncategorized");
  const Wrapper = onSelect ? "button" : "div";
  return (
    <Wrapper
      {...(onSelect ? { type: "button" as const, onClick: onSelect } : {})}
      className={cn(
        "group flex w-full items-center gap-3.5 rounded-2xl px-2 py-2.5 text-left transition-colors",
        onSelect && "hover:bg-surface focus-visible:bg-surface",
      )}
    >
      {isTransfer ? (
        <span className="grid size-10 shrink-0 place-items-center rounded-[0.9rem] bg-surface-2 text-fg-muted" aria-hidden>
          {tx.classification === "card_payment" ? <CreditCard className="size-[18px]" strokeWidth={1.8} /> : <ArrowLeftRight className="size-[18px]" strokeWidth={1.8} />}
        </span>
      ) : (
        <CategoryIcon slug={tx.categorySlug} />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-[14.5px] font-medium text-fg", isTransfer && "text-fg-muted")}>{title}</span>
          {tx.status === "pending" ? <Badge tone="warning">{t("common.pending")}</Badge> : null}
          {tx.duplicateOf ? (
            <Badge tone="warning">
              <Copy className="size-3" />
              {t("activity.duplicate")}
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-fg-subtle">
          {isTransfer
            ? tx.classification === "card_payment"
              ? t("activity.cardPayment")
              : t("activity.transfer")
            : categoryLabel}
          {compact ? null : <> · {tx.institutionName ? `${tx.institutionName} · ` : ""}{tx.accountName}</>}
        </span>
      </span>
      <span className="flex flex-col items-end">
        <Money
          amount={tx.amount}
          currency={tx.currency}
          colored
          signDisplay="exceptZero"
          className={cn("text-[14.5px] font-medium", isTransfer && "!text-fg-muted")}
        />
        {tx.converted ? (
          <Money amount={tx.converted} currency={tx.displayCurrency} className="text-[11.5px] text-fg-subtle" signDisplay="exceptZero" />
        ) : null}
      </span>
    </Wrapper>
  );
}
