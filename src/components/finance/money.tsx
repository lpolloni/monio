"use client";

import { useLocale } from "use-intl";
import { formatMoney, type MoneyFormatOptions } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Static money text with sign-aware coloring. */
export function Money({
  amount,
  currency,
  className,
  colored = false,
  ...options
}: { amount: string; currency: string; className?: string; colored?: boolean } & MoneyFormatOptions) {
  const locale = useLocale();
  const negative = amount.trim().startsWith("-");
  const zero = /^-?0(\.0*)?$/.test(amount.trim());
  return (
    <span
      className={cn(
        "tabular",
        colored && !zero && (negative ? "text-fg" : "text-positive"),
        className,
      )}
    >
      {formatMoney(amount, currency, locale, options)}
    </span>
  );
}
