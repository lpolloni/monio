"use client";

import { CalendarClock } from "lucide-react";
import { motion } from "motion/react";
import { useLocale, useTranslations } from "use-intl";
import { CategoryIcon } from "@/components/finance/category-icon";
import { Badge } from "@/components/ui/primitives";
import { formatDate, formatMoney } from "@/lib/format";

export interface RecurringItem {
  id: string;
  merchant: string;
  categorySlug: string | null;
  cadence: string;
  lastAmount: string;
  currency: string;
  nextExpectedOn: string | null;
  occurrences: number;
  isSubscription: boolean;
  status: string;
  accountName: string | null;
  monthlyEquivalent: string | null;
  displayCurrency: string;
}

export function RecurringList({ items }: { items: RecurringItem[] }) {
  const t = useTranslations("activity");
  const locale = useLocale();
  if (items.length === 0) return <p className="py-16 text-center text-fg-muted">{t("recurringEmpty")}</p>;
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {items.map((s, i) => (
        <motion.li
          key={s.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.025 }}
          className="flex items-center gap-4 rounded-[1.4rem] bg-bg-elevated/80 p-4 hairline"
        >
          <CategoryIcon slug={s.categorySlug} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[15px] font-medium text-fg">{s.merchant}</span>
              {s.isSubscription ? <Badge tone="accent">{t("subscription")}</Badge> : null}
              {s.status === "confirmed" ? <Badge tone="positive">{t("confirmed")}</Badge> : null}
            </div>
            <p className="mt-0.5 truncate text-[12.5px] text-fg-subtle">
              {t(`cadence_${s.cadence}` as "cadence_monthly")} · {s.accountName}
            </p>
            {s.nextExpectedOn ? (
              <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-fg-muted">
                <CalendarClock className="size-3.5" />
                {t("nextExpected", { date: formatDate(s.nextExpectedOn, locale, "dayMonth") })}
              </p>
            ) : null}
          </div>
          <div className="text-right">
            <p className="text-[15px] font-semibold text-fg tabular">{formatMoney(s.lastAmount, s.currency, locale)}</p>
            {s.monthlyEquivalent && s.cadence !== "monthly" ? (
              <p className="text-[11.5px] text-fg-subtle">{t("monthlyEquivalent", { value: formatMoney(s.monthlyEquivalent, s.displayCurrency, locale) })}</p>
            ) : s.currency !== s.displayCurrency && s.monthlyEquivalent ? (
              <p className="text-[11.5px] text-fg-subtle">{formatMoney(s.monthlyEquivalent, s.displayCurrency, locale)}</p>
            ) : null}
          </div>
        </motion.li>
      ))}
    </ul>
  );
}
