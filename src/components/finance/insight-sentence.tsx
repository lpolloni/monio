"use client";

import { TrendingDown, TrendingUp, Info, CalendarClock, Repeat, Coins } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";
import { formatMoney, formatMonth } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface InsightData {
  id: string;
  kind: string;
  severity: "info" | "positive" | "warning";
  params: Record<string, string | number>;
}

/** Renders a deterministic insight as a translated sentence with formatted values. */
export function useInsightText() {
  const t = useTranslations();
  const locale = useLocale();
  return (insight: InsightData): string => {
    const p = insight.params;
    const cur = String(p.currency ?? "EUR");
    const money = (v: unknown) => formatMoney(String(v ?? "0"), cur, locale);
    const month = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}$/.test(v) ? formatMonth(v, locale, "long") : String(v ?? ""));
    switch (insight.kind) {
      case "category_spend_change":
        return t(p.direction === "up" ? "insights.category_spend_change_up" : "insights.category_spend_change_down", {
          category: t(`categories.${String(p.category)}` as "categories.groceries").toLowerCase(),
          changePct: String(p.changePct),
          month: month(p.month),
          previousMonth: month(p.previousMonth),
          previous: money(p.previous),
          current: money(p.current),
        });
      case "subscription_price_change":
        return t("insights.subscription_price_change", {
          merchant: String(p.merchant),
          previous: money(p.previous),
          current: money(p.current),
          changePct: `${Number(p.changePct) > 0 ? "+" : ""}${p.changePct}`,
        });
      case "upcoming_recurring":
        return t("insights.upcoming_recurring", { count: Number(p.count), days: String(p.days), merchants: String(p.merchants) });
      case "fx_effect":
        return t(p.direction === "up" ? "insights.fx_effect_up" : "insights.fx_effect_down", {
          currency: cur,
          total: money(p.total),
          fxEffect: money(p.fxEffect),
          share: String(p.share),
        });
      case "savings_rate":
        return t("insights.savings_rate", { rate: String(p.rate), month: month(p.month), net: money(p.net) });
      case "negative_cashflow":
        return t("insights.negative_cashflow", { month: month(p.month), net: money(p.net) });
      default:
        return insight.kind;
    }
  };
}

const ICONS = {
  category_spend_change: TrendingUp,
  subscription_price_change: Repeat,
  upcoming_recurring: CalendarClock,
  fx_effect: Coins,
  savings_rate: TrendingUp,
  negative_cashflow: TrendingDown,
} as const;

export function InsightSentence({ insight, className }: { insight: InsightData; className?: string }) {
  const text = useInsightText()(insight);
  const Icon = ICONS[insight.kind as keyof typeof ICONS] ?? Info;
  const tone =
    insight.severity === "positive" ? "text-positive bg-positive-soft" : insight.severity === "warning" ? "text-warning bg-warning-soft" : "text-accent bg-accent-soft";
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl", tone)} aria-hidden>
        <Icon className="size-4" strokeWidth={1.9} />
      </span>
      <p className="text-[14.5px] leading-relaxed text-fg">{text}</p>
    </div>
  );
}
