"use client";

import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useLocale, useTranslations } from "use-intl";
import { AreaTrend } from "@/components/charts/area-trend";
import { categoryHue, CategoryIcon } from "@/components/finance/category-icon";
import { InsightSentence } from "@/components/finance/insight-sentence";
import { SectionHeader } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/segmented";
import { formatDate, formatMoney, formatMonth } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InsightsPageData } from "@/server/data/insights-page";

const GROUP_COLORS: Record<string, string> = {
  cash: "var(--group-cash)",
  investments: "var(--group-investments)",
  crypto: "var(--group-crypto)",
  other: "var(--group-other)",
};

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-[1.75rem] bg-bg-elevated/75 p-5 hairline sm:p-6", className)}>{children}</div>;
}

function LegendItem({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-fg-muted">
      <span className={cn("h-0.5 w-4 rounded-full", dashed && "border-t-2 border-dashed bg-transparent")} style={dashed ? { borderColor: color } : { background: color }} />
      {label}
    </span>
  );
}

export function InsightsView({ data }: { data: InsightsPageData }) {
  const t = useTranslations();
  const locale = useLocale();
  const completeMonths = data.months.filter((m) => m !== data.currentMonth);
  const [month, setMonth] = useState(completeMonths[completeMonths.length - 1] ?? data.currentMonth);
  const cur = data.currency;
  const money = (v: string) => formatMoney(v, cur, locale);

  const nwData = data.netWorth.map((p) => ({
    date: p.date,
    value: Number(p.netWorth), // drawing only
    label: money(p.netWorth),
    secondary: Number(p.atConstantRates),
    secondaryLabel: money(p.atConstantRates),
  }));
  const cryptoData = data.netWorth.map((p) => ({ date: p.date, value: Number(p.crypto), label: money(p.crypto) }));
  const cashflowData = data.cashflow.map((c) => ({ ...c, incomeN: Number(c.income), expensesN: Number(c.expenses) }));
  const categories = data.categoriesByMonth[month] ?? [];
  const catTotal = categories.reduce((s, c) => s + Number(c.amount), 0) || 1;
  const breakdown = data.breakdowns[month];
  const groups = (["cash", "investments", "crypto", "other"] as const)
    .map((g) => ({ key: g, value: Number(data.groups[g] ?? "0"), amount: data.groups[g] ?? "0" }))
    .filter((g) => g.value > 0);
  const groupTotal = groups.reduce((s, g) => s + g.value, 0) || 1;
  const monthOptions = data.months.slice(-6).map((m) => ({ value: m, label: formatMonth(m, locale, "short") }));

  return (
    <div className="flex flex-col gap-10">
      {/* Observations */}
      <section>
        <SectionHeader title={t("insights.observations")} />
        {data.insights.length === 0 ? (
          <p className="text-[14px] text-fg-muted">{t("insights.noInsights")}</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {data.insights.map((insight) => (
              <ObservationCard key={insight.id} insight={insight} />
            ))}
          </div>
        )}
      </section>

      {/* Net worth evolution */}
      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="font-display text-[1.7rem] leading-none text-fg">{t("insights.netWorthEvolution")}</h2>
            <div className="flex flex-wrap gap-4">
              <LegendItem color="var(--accent)" label={t("home.netWorth")} />
              <LegendItem color="var(--fg-subtle)" label={t("insights.atConstantRates")} dashed />
            </div>
          </div>
          <AreaTrend data={nwData} currency={cur} primaryName={t("home.netWorth")} secondaryName={t("insights.atConstantRates")} height={280} />
          <p className="mt-3 text-[12.5px] text-fg-subtle">{t("insights.fxEffectLegend")}</p>
        </Card>
        <Card>
          <h2 className="mb-4 font-display text-[1.7rem] leading-none text-fg">{t("insights.portfolio")}</h2>
          <div className="flex items-center gap-6">
            <div className="relative size-40 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={groups} dataKey="value" nameKey="key" innerRadius="68%" outerRadius="100%" paddingAngle={2} stroke="var(--bg-elevated)" strokeWidth={2} cornerRadius={4} animationDuration={900}>
                    {groups.map((g) => (
                      <Cell key={g.key} fill={GROUP_COLORS[g.key]} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      const p = payload?.[0]?.payload as (typeof groups)[number] | undefined;
                      if (!active || !p) return null;
                      return (
                        <div className="rounded-xl bg-bg-elevated px-3 py-2 text-[12px] shadow-float hairline">
                          {t(`groups.${p.key}`)}: <span className="font-medium tabular">{money(p.amount)}</span>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="flex min-w-0 flex-1 flex-col gap-2.5">
              {groups.map((g) => (
                <li key={g.key} className="flex items-center gap-2 text-[13px]">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: GROUP_COLORS[g.key] }} />
                  <span className="min-w-0 flex-1 truncate text-fg-muted">{t(`groups.${g.key}`)}</span>
                  <span className="text-fg-subtle tabular">{Math.round((g.value / groupTotal) * 100)}%</span>
                  <span className="w-24 text-right font-medium text-fg tabular">{formatMoney(g.amount, cur, locale, { compact: true })}</span>
                </li>
              ))}
              <li className="flex items-center gap-2 border-t border-border pt-2 text-[13px]">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: "var(--group-liabilities)" }} />
                <span className="flex-1 text-fg-muted">{t("groups.liabilities")}</span>
                <span className="w-24 text-right font-medium text-negative tabular">−{formatMoney(data.groups.liabilities ?? "0", cur, locale, { compact: true })}</span>
              </li>
            </ul>
          </div>
        </Card>
      </section>

      {/* Cash flow */}
      <Card>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-[1.7rem] leading-none text-fg">{t("insights.cashflow")}</h2>
          <div className="flex flex-wrap gap-4">
            <LegendItem color="var(--positive)" label={t("home.income")} />
            <LegendItem color="var(--negative)" label={t("home.expenses")} />
            <span className="text-[12.5px] text-fg-subtle">◌ {t("insights.incompleteMonth")}</span>
          </div>
        </div>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cashflowData} barGap={2} barCategoryGap="28%" margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fill: "var(--fg-subtle)", fontSize: 11 }} tickFormatter={(m: string) => formatMonth(m, locale, "short")} />
              <YAxis width={64} tickLine={false} axisLine={false} tick={{ fill: "var(--fg-subtle)", fontSize: 11 }} tickFormatter={(v: number) => formatMoney(String(v), cur, locale, { compact: true })} />
              <Tooltip
                cursor={{ fill: "var(--surface-2)", opacity: 0.5 }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (typeof cashflowData)[number] | undefined;
                  if (!active || !p) return null;
                  return (
                    <div className="rounded-2xl bg-bg-elevated px-3.5 py-2.5 text-[12.5px] shadow-float hairline">
                      <p className="text-fg-subtle first-letter:uppercase">
                        {formatMonth(p.month, locale, "long")}
                        {p.complete ? "" : ` · ${t("insights.incompleteMonth")}`}
                      </p>
                      <p className="text-fg tabular">
                        {t("home.income")}: {money(p.income)}
                      </p>
                      <p className="text-fg tabular">
                        {t("home.expenses")}: {money(p.expenses)}
                      </p>
                      <p className="font-medium text-fg tabular">
                        {t("home.netCashFlow")}: {money(p.net)}
                      </p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="incomeN" radius={[4, 4, 0, 0]} animationDuration={800}>
                {cashflowData.map((d) => (
                  <Cell key={d.month} fill="var(--positive)" fillOpacity={d.complete ? 0.9 : 0.35} />
                ))}
              </Bar>
              <Bar dataKey="expensesN" radius={[4, 4, 0, 0]} animationDuration={800}>
                {cashflowData.map((d) => (
                  <Cell key={d.month} fill="var(--negative)" fillOpacity={d.complete ? 0.9 : 0.35} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* Spending breakdowns */}
      <section className="grid grid-cols-1 gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-[1.7rem] leading-none text-fg">{t("insights.spendingByCategory")}</h2>
            <div className="-mx-1 overflow-x-auto px-1 scrollbar-none">
              <Segmented size="sm" label={t("common.period")} value={month} onChange={setMonth} options={monthOptions} />
            </div>
          </div>
          {categories.length === 0 ? (
            <p className="text-fg-muted">{t("insights.noData")}</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {categories.map((c, i) => {
                const share = Number(c.amount) / catTotal;
                const hue = categoryHue(c.key);
                return (
                  <li key={c.key} className="grid grid-cols-[2.25rem_minmax(0,8rem)_1fr_auto] items-center gap-3 sm:grid-cols-[2.25rem_10rem_1fr_6.5rem]">
                    <CategoryIcon slug={c.key === "uncategorized" ? null : c.key} size="sm" />
                    <span className="truncate text-[13.5px] text-fg">{t(`categories.${c.key}` as "categories.groceries")}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-surface-2">
                      <motion.span
                        key={`${month}-${c.key}`}
                        className="block h-full rounded-full"
                        style={{ background: `oklch(0.66 0.13 ${hue})` }}
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.max(share * 100, 1.5)}%` }}
                        transition={{ duration: 0.7, delay: i * 0.03, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </span>
                    <span className="text-right text-[13.5px] font-medium text-fg tabular">{money(c.amount)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <div className="flex flex-col gap-6">
          {breakdown ? (
            <>
              <BreakdownCard title={t("insights.spendingByCountry")} items={breakdown.countries.map((b) => ({ key: b.key, label: b.key === "unknown" ? t("common.unknown") : b.key, amount: b.amount }))} currency={cur} />
              <BreakdownCard title={t("insights.spendingByInstitution")} items={breakdown.institutions.map((b) => ({ key: b.key, label: b.key === "unknown" ? t("common.unknown") : b.name, amount: b.amount }))} currency={cur} />
              <BreakdownCard title={t("insights.spendingByCurrency")} items={breakdown.currencies.map((b) => ({ key: b.key, label: b.key, amount: b.amount }))} currency={cur} />
            </>
          ) : null}
        </div>
      </section>

      {/* Crypto */}
      {data.netWorth.some((p) => Number(p.crypto) > 0) ? (
        <Card>
          <h2 className="mb-4 font-display text-[1.7rem] leading-none text-fg">{t("insights.cryptoEvolution")}</h2>
          <AreaTrend data={cryptoData} currency={cur} color="var(--group-crypto)" height={220} />
          <p className="mt-3 text-[12.5px] text-fg-subtle">{t("explore.costBasisUnknown")}</p>
        </Card>
      ) : null}
      <p className="text-[12px] text-fg-subtle">{formatDate(data.today, locale, "long")}</p>
    </div>
  );
}

function BreakdownCard({ title, items, currency }: { title: string; items: { key: string; label: string; amount: string }[]; currency: string }) {
  const locale = useLocale();
  const max = Math.max(...items.map((i) => Number(i.amount)), 1);
  return (
    <Card>
      <h3 className="mb-3 text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle">{title}</h3>
      <ul className="flex flex-col gap-2">
        {items.slice(0, 6).map((i) => (
          <li key={i.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3 text-[13px]">
            <span className="truncate text-fg">{i.label}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${(Number(i.amount) / max) * 100}%` }} />
            </span>
            <span className="text-right font-medium text-fg tabular">{formatMoney(i.amount, currency, locale, { compact: true })}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ObservationCard({ insight }: { insight: InsightsPageData["insights"][number] }) {
  const t = useTranslations("insights");
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[1.5rem] bg-bg-elevated/80 p-5 hairline">
      <InsightSentence insight={insight} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-3 ml-11 inline-flex items-center gap-1 text-[12.5px] text-fg-subtle transition hover:text-fg"
      >
        {t("evidence")}
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.pre
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-2 ml-11 overflow-x-auto rounded-xl bg-surface p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-muted"
          >
            {JSON.stringify(insight.evidence, null, 2)}
          </motion.pre>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
