"use client";

import { ArrowRight, ArrowUpRight, Building, ChevronDown, ChevronRight, Network, Rows3, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { useLocale, useTranslations } from "use-intl";
import type { AssetGroup, EntityKind } from "@/domain/accounts/classification";
import { DISPLAY_CURRENCIES } from "@/domain/money/currencies";
import { AnimatedMoney } from "@/components/ui/animated-money";
import { OptionMenu } from "@/components/ui/option-menu";
import { Segmented } from "@/components/ui/segmented";
import { Badge, SectionHeader } from "@/components/ui/primitives";
import { InsightSentence, type InsightData } from "@/components/finance/insight-sentence";
import { Money } from "@/components/finance/money";
import { TransactionItem, type TransactionItemData } from "@/components/finance/transaction-item";
import { useInboxText, type InboxItemData } from "@/components/inbox/inbox-text";
import { useAddSheet } from "@/components/shell/add-sheet";
import { formatDate, formatMoney, formatRelative, freshnessOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { setDisplayCurrency, setIncludeBusiness } from "@/server/actions/preferences";
import { useMediaQuery } from "@/lib/use-media-query";
import { Sheet } from "@/components/ui/sheet";
import { WealthConstellation, type ConstellationNode } from "./wealth-constellation";

export interface AccountLite {
  id: string;
  name: string;
  type: string;
  currency: string;
  nativeBalance: string | null;
  value: string | null;
  mask: string | null;
  lastUpdated: string | null;
  entityKind: EntityKind;
  creditLimit: string | null;
  holdings: { symbol: string; quantity: string; currency: string }[];
}

export interface HomeViewModel {
  now: string;
  today: string;
  currency: string;
  displayName: string | null;
  netWorth: string;
  assets: string;
  liabilities: string;
  available: string;
  businessNetWorth: string;
  includeBusiness: boolean;
  groups: Record<AssetGroup, string>;
  nodes: ConstellationNode[];
  institutionAccounts: Record<string, AccountLite[]>;
  institutionMeta: Record<string, { country: string | null; entityKinds: EntityKind[] }>;
  month: { income: string; expenses: string; net: string };
  recent: TransactionItemData[];
  attention: InboxItemData[];
  attentionCount: number;
  insights: InsightData[];
  businessEntities: { name: string; value: string }[];
  unvaluedCount: number;
}

const GROUP_STYLE: Record<AssetGroup, string> = {
  cash: "var(--group-cash)",
  investments: "var(--group-investments)",
  crypto: "var(--group-crypto)",
  liabilities: "var(--group-liabilities)",
  other: "var(--group-other)",
};

function greetingKey(now: string): "greetingMorning" | "greetingAfternoon" | "greetingEvening" {
  const h = new Date(now).getHours();
  return h < 12 ? "greetingMorning" : h < 18 ? "greetingAfternoon" : "greetingEvening";
}

export function HomeView({ model }: { model: HomeViewModel }) {
  const t = useTranslations();
  const locale = useLocale();
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"map" | "list">("map");
  const [pending, startTransition] = useTransition();
  const [currency, setOptimisticCurrency] = useOptimistic(model.currency);

  const changeCurrency = (next: string) => {
    startTransition(async () => {
      setOptimisticCurrency(next);
      await setDisplayCurrency(next);
    });
  };

  const selectedNode = model.nodes.find((n) => n.key === selected) ?? null;
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  // Desktop: the panel replaces the summary next to the constellation. Smaller screens: bottom sheet.
  const inlineNode = isDesktop ? selectedNode : null;
  const firstName = model.displayName?.split(" ")[0];

  const monthBlock = (
    <>
      <MonthFlow month={model.month} currency={model.currency} />
      {model.businessEntities.length > 0 ? (
        <BusinessNote entities={model.businessEntities} currency={model.currency} include={model.includeBusiness} />
      ) : null}
      {model.unvaluedCount > 0 ? <p className="text-xs text-fg-subtle">{t("home.unvalued", { count: model.unvaluedCount })}</p> : null}
    </>
  );

  return (
    <div className="flex flex-col gap-12 lg:gap-16">
      {/* Hero */}
      <section className="grid grid-cols-1 items-center gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-12">
        <div className="order-2 lg:order-1">
          <div className="mb-2 flex items-center justify-between gap-3">
            <Segmented
              size="sm"
              label={t("common.mapView")}
              value={view}
              onChange={setView}
              options={[
                { value: "map", label: <Network className="size-3.5" />, ariaLabel: t("common.mapView") },
                { value: "list", label: <Rows3 className="size-3.5" />, ariaLabel: t("common.listView") },
              ]}
            />
            <p className="hidden text-xs text-fg-subtle sm:block">{t("home.selectInstitution")}</p>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            {view === "map" ? (
              <motion.div key="map" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                <WealthConstellation
                  nodes={model.nodes}
                  netWorth={model.netWorth}
                  currency={model.currency}
                  groups={model.groups}
                  selected={selected}
                  onSelect={setSelected}
                  now={model.now}
                />
              </motion.div>
            ) : (
              <motion.div key="list" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                <InstitutionList model={model} selected={selected} onSelect={setSelected} />
              </motion.div>
            )}
          </AnimatePresence>
          {/* Phones and tablets: this month comes after the constellation, not before it. */}
          <div className="mt-8 flex flex-col gap-7 lg:hidden">{monthBlock}</div>
        </div>

        <div className="order-1 lg:order-2 lg:min-h-[22rem]">
          <AnimatePresence mode="wait" initial={false}>
            {inlineNode ? (
              <InstitutionPanel
                key={inlineNode.key}
                node={inlineNode}
                accounts={model.institutionAccounts[inlineNode.key] ?? []}
                meta={model.institutionMeta[inlineNode.key]}
                currency={model.currency}
                now={model.now}
                onClose={() => setSelected(null)}
              />
            ) : (
              <motion.div
                key="summary"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="flex flex-col gap-7"
              >
                <div>
                  <p className="text-[15px] text-fg-muted">
                    {t(`home.${greetingKey(model.now)}`)}
                    {firstName ? `, ${firstName}` : ""} · {formatDate(model.today, locale, "weekday")}
                  </p>
                  <div className="mt-5 flex items-center justify-between gap-3">
                    <span className="text-[13px] font-medium uppercase tracking-[0.16em] text-fg-subtle">{t("home.netWorth")}</span>
                    <OptionMenu className="h-8" align="end" label={t("common.currency")} value={currency} onChange={changeCurrency} options={DISPLAY_CURRENCIES.map((c) => ({ value: c, label: c }))} />
                  </div>
                  <h1 className={cn("mt-2 font-display text-[3.1rem] leading-[1] tracking-[-0.02em] text-fg transition-opacity sm:text-[4.2rem]", pending && "opacity-60")}>
                    <AnimatedMoney amount={model.netWorth} currency={model.currency} locale={locale} />
                  </h1>
                  <div className="mt-4 flex justify-between gap-3 text-[13px] sm:flex-wrap sm:justify-start sm:gap-x-6 sm:gap-y-2 sm:text-[14px]">
                    <Stat label={t("home.available")} amount={model.available} currency={model.currency} />
                    <Stat label={t("home.assets")} amount={model.assets} currency={model.currency} />
                    <Stat label={t("home.liabilities")} amount={model.liabilities} currency={model.currency} negative />
                  </div>
                </div>

                <DistributionBar groups={model.groups} />

                <div className="hidden flex-col gap-7 lg:flex">{monthBlock}</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      {!isDesktop ? (
        <Sheet
          open={!!selectedNode}
          onOpenChange={(open) => !open && setSelected(null)}
          title={selectedNode?.name ?? ""}
          closeLabel={t("common.close")}
          hideTitle
        >
          {selectedNode ? (
            <InstitutionPanel
              node={selectedNode}
              accounts={model.institutionAccounts[selectedNode.key] ?? []}
              meta={model.institutionMeta[selectedNode.key]}
              currency={model.currency}
              now={model.now}
              onClose={() => setSelected(null)}
              embedded
            />
          ) : null}
        </Sheet>
      ) : null}

      {/* Below the fold */}
      <section className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-12">
        <HomeSection title={t("home.recentActivity")} href={`/${locale}/activity`} linkLabel={t("common.seeAll")}>
          <div className="-mx-2 flex flex-col">
            {model.recent.map((tx, i) => (
              <motion.div key={tx.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.04 * i }}>
                <TransactionItem tx={tx} showDate />
              </motion.div>
            ))}
          </div>
        </HomeSection>
        <div className="flex flex-col gap-10">
          {model.insights.length > 0 ? (
            <HomeSection title={t("home.insightsTitle")} href={`/${locale}/insights`} linkLabel={t("common.seeAll")}>
              <div className="flex flex-col gap-4">
                {model.insights.map((insight) => (
                  <InsightSentence key={insight.id} insight={insight} />
                ))}
              </div>
            </HomeSection>
          ) : null}
          <AttentionList items={model.attention} count={model.attentionCount} />
        </div>
      </section>
    </div>
  );
}

/**
 * Home section that is a closed disclosure on phones and a plain titled section from `md` up.
 * Visibility is CSS-driven so the server and client render the same markup.
 */
function HomeSection({ title, href, linkLabel, children }: { title: string; href: string; linkLabel: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const link = (
    <Link href={href} className="flex items-center gap-1 text-[13px] text-fg-muted transition hover:text-fg">
      {linkLabel}
      <ChevronRight className="size-4" />
    </Link>
  );
  return (
    <div>
      <SectionHeader title={title} action={link} className="hidden md:flex" />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 rounded-[1.5rem] bg-bg-elevated/75 px-5 py-4 text-left hairline md:hidden"
      >
        <span className="text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle">{title}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />
      </button>
      <div className={cn("md:block", open ? "pt-3 md:pt-0" : "hidden")}>
        {children}
        <div className="mt-3 flex justify-end md:hidden">{link}</div>
      </div>
    </div>
  );
}

function Stat({ label, amount, currency, negative }: { label: string; amount: string; currency: string; negative?: boolean }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 whitespace-nowrap sm:flex-row sm:items-baseline sm:gap-2">
      <span className="text-[12px] text-fg-subtle sm:text-[14px]">{label}</span>
      <Money amount={negative && amount !== "0" ? `-${amount}` : amount} currency={currency} className={cn("font-medium", negative ? "text-negative" : "text-fg")} />
    </span>
  );
}

function DistributionBar({ groups }: { groups: Record<AssetGroup, string> }) {
  const t = useTranslations("groups");
  const entries = (["cash", "investments", "crypto", "other"] as const)
    .map((g) => ({ g, v: Math.max(0, Number(groups[g])) })) // proportions for layout only
    .filter((e) => e.v > 0);
  const total = entries.reduce((a, b) => a + b.v, 0) || 1;
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-2">
        {entries.map((e, i) => (
          <motion.span
            key={e.g}
            className="h-full"
            style={{ background: GROUP_STYLE[e.g] }}
            initial={{ width: 0 }}
            animate={{ width: `${(e.v / total) * 100}%` }}
            transition={{ duration: 0.9, delay: 0.1 * i, ease: [0.16, 1, 0.3, 1] }}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-fg-muted">
        {entries.map((e) => (
          <li key={e.g} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: GROUP_STYLE[e.g] }} />
            {t(e.g)} <span className="text-fg-subtle tabular">{Math.round((e.v / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MonthFlow({ month, currency }: { month: HomeViewModel["month"]; currency: string }) {
  const t = useTranslations("home");
  const income = Math.max(0, Number(month.income));
  const expenses = Math.max(0, Number(month.expenses));
  const max = Math.max(income, expenses, 1);
  return (
    <div className="rounded-[1.6rem] bg-bg-elevated/70 p-5 hairline">
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle">{t("thisMonth")}</span>
        <span className="text-[13px] text-fg-muted">
          {t("netCashFlow")}{" "}
          <Money amount={month.net} currency={currency} signDisplay="exceptZero" className={cn("font-semibold", month.net.startsWith("-") ? "text-negative" : "text-positive")} />
        </span>
      </div>
      <div className="mt-4 grid gap-3">
        {[
          { label: t("income"), value: income, amount: month.income, color: "var(--positive)" },
          { label: t("expenses"), value: expenses, amount: month.expenses, color: "var(--negative)" },
        ].map((row) => (
          <div key={row.label} className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3 text-[13.5px]">
            <span className="text-fg-muted">{row.label}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <motion.span
                className="block h-full rounded-full"
                style={{ background: row.color }}
                initial={{ width: 0 }}
                animate={{ width: `${(row.value / max) * 100}%` }}
                transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
              />
            </span>
            <Money amount={row.amount} currency={currency} className="font-medium text-fg" />
          </div>
        ))}
      </div>
    </div>
  );
}

function BusinessNote({ entities, currency, include }: { entities: { name: string; value: string }[]; currency: string; include: boolean }) {
  const t = useTranslations("home");
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-[13px] hairline">
      <Building className="size-4 text-business" />
      <span className="sensitive text-fg-muted">
        {entities.map((e) => `${e.name} · ${formatMoney(e.value, currency, locale)}`).join("  ·  ")}
      </span>
      <span className="text-fg-subtle">{include ? null : `— ${t("businessExcluded", { name: entities[0]?.name ?? "" })}`}</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(async () => void (await setIncludeBusiness(!include)))}
        className="ml-auto rounded-full bg-surface-2 px-3 py-1 text-[12px] font-medium text-fg transition hover:bg-border-strong/40 disabled:opacity-50"
      >
        {include ? t("excludeBusiness") : t("includeBusiness")}
      </button>
    </div>
  );
}

function InstitutionPanel({
  node,
  accounts,
  meta,
  currency,
  now,
  onClose,
  embedded = false,
}: {
  node: ConstellationNode;
  accounts: AccountLite[];
  meta?: { country: string | null; entityKinds: EntityKind[] };
  currency: string;
  now: string;
  onClose: () => void;
  embedded?: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const color = node.color ?? "var(--fg-subtle)";
  const nowDate = new Date(now);
  return (
    <motion.div
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 16 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
      className={embedded ? "" : "rounded-[2rem] bg-bg-elevated/85 p-6 shadow-soft hairline backdrop-blur-xl"}
    >
      <div className="flex items-start gap-4">
        <motion.span
          layoutId={`inst-${node.key}`}
          className="grid size-14 shrink-0 place-items-center rounded-full text-[15px] font-semibold text-fg"
          style={{
            background: `radial-gradient(circle at 35% 30%, color-mix(in oklch, ${color} 32%, var(--bg-elevated)), color-mix(in oklch, ${color} 14%, var(--bg-elevated)))`,
            boxShadow: `inset 0 0 0 2px color-mix(in oklch, ${color} 70%, transparent)`,
          }}
        >
          {node.short}
        </motion.span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[2rem] leading-none text-fg">{node.name}</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {meta?.country ? <Badge>{meta.country}</Badge> : null}
            {meta?.entityKinds.map((k) => (
              <Badge key={k} tone={k === "business" ? "accent" : "neutral"}>
                {t(`common.${k}`)}
              </Badge>
            ))}
          </div>
        </div>
        {embedded ? null : (
          <button type="button" onClick={onClose} className="grid size-9 place-items-center rounded-full bg-surface-2 text-fg-muted transition hover:text-fg" aria-label={t("common.close")}>
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="mt-6">
        <AnimatedMoney
          amount={node.value}
          currency={currency}
          locale={locale}
          className={cn("font-display text-[2.6rem] leading-none", node.value.startsWith("-") ? "text-negative" : "text-fg")}
        />
        <p className="mt-2 text-[12.5px] text-fg-subtle">
          {node.lastUpdated ? t("common.updated", { when: formatRelative(node.lastUpdated, nowDate, locale) }) : t("common.neverUpdated")} · {t("home.freshnessHint")}
        </p>
      </div>
      <ul className="mt-5 flex flex-col divide-y divide-border">
        {accounts.map((a, i) => {
          const fresh = freshnessOf(a.lastUpdated, nowDate);
          return (
            <motion.li key={a.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 + i * 0.04 }}>
              <Link href={`/${locale}/explore/${a.id}`} className="group flex items-center gap-3 py-3">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    fresh === "fresh" ? "bg-positive" : fresh === "aging" ? "bg-warning" : fresh === "stale" ? "bg-negative" : "bg-fg-subtle",
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-medium text-fg">{a.name}</span>
                  <span className="block truncate text-[12px] text-fg-subtle">
                    {t(`accountTypes.${a.type}` as "accountTypes.checking")}
                    {a.mask ? ` · ${t("explore.mask", { mask: a.mask })}` : ""}
                    {a.holdings.length > 0 ? ` · ${a.holdings.map((h) => h.symbol).join(", ")}` : ""}
                  </span>
                </span>
                <span className="flex flex-col items-end">
                  {a.nativeBalance !== null ? (
                    <Money amount={a.nativeBalance} currency={a.currency} className={cn("text-[14px] font-medium", a.nativeBalance.startsWith("-") ? "text-negative" : "text-fg")} />
                  ) : a.value !== null ? (
                    <Money amount={a.value} currency={currency} className="text-[14px] font-medium text-fg" />
                  ) : (
                    <span className="text-[13px] text-fg-subtle">—</span>
                  )}
                  {a.value !== null && a.currency !== currency && a.nativeBalance !== null ? (
                    <Money amount={a.value} currency={currency} className="text-[11.5px] text-fg-subtle" />
                  ) : null}
                </span>
                <ChevronRight className="size-4 text-fg-subtle transition group-hover:translate-x-0.5" />
              </Link>
            </motion.li>
          );
        })}
      </ul>
      <Link href={`/${locale}/explore`} className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent">
        {t("home.openExplore")}
        <ArrowUpRight className="size-4" />
      </Link>
    </motion.div>
  );
}

function InstitutionList({ model, selected, onSelect }: { model: HomeViewModel; selected: string | null; onSelect: (k: string | null) => void }) {
  const locale = useLocale();
  const t = useTranslations();
  const max = Math.max(...model.nodes.map((n) => Math.abs(Number(n.value))), 1);
  return (
    <ul className="flex flex-col gap-1.5" aria-label={t("home.constellationLabel")}>
      {model.nodes.map((n) => {
        const negative = n.value.startsWith("-");
        return (
          <li key={n.key}>
            <button
              type="button"
              onClick={() => onSelect(selected === n.key ? null : n.key)}
              aria-pressed={selected === n.key}
              className={cn("flex w-full items-center gap-4 rounded-2xl px-3 py-3 text-left transition hover:bg-surface", selected === n.key && "bg-surface hairline")}
            >
              <span
                className="grid size-10 shrink-0 place-items-center rounded-full text-[12px] font-semibold"
                style={{ background: `color-mix(in oklch, ${n.color ?? "var(--fg-subtle)"} 22%, var(--bg-elevated))` }}
              >
                {n.short}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium text-fg">{n.name}</span>
                <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-2">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${(Math.abs(Number(n.value)) / max) * 100}%`, background: negative ? "var(--negative)" : (n.color ?? "var(--accent)") }}
                  />
                </span>
              </span>
              <span className={cn("text-[14px] font-medium tabular", negative ? "text-negative" : "text-fg")}>{formatMoney(n.value, model.currency, locale)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AttentionList({ items, count }: { items: InboxItemData[]; count: number }) {
  const t = useTranslations();
  const locale = useLocale();
  const text = useInboxText();
  return (
    <div>
      <SectionHeader
        title={t("home.attention")}
        action={
          count > 0 ? (
            <Link href={`/${locale}/inbox`} className="flex items-center gap-1 text-[13px] text-fg-muted transition hover:text-fg">
              {t("home.attentionCount", { count })}
              <ChevronRight className="size-4" />
            </Link>
          ) : null
        }
      />
      {items.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl bg-positive-soft px-4 py-3.5 text-[14px] text-positive">
          <Sparkles className="size-4" />
          {t("inbox.empty")}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/${locale}/inbox#${item.id}`}
                className="group flex items-start gap-3 rounded-2xl bg-bg-elevated/70 px-4 py-3.5 hairline transition hover:shadow-soft"
              >
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" aria-hidden />
                <span className="sensitive-prose flex-1 text-[14px] leading-relaxed text-fg">{text(item)}</span>
                <ArrowRight className="mt-1 size-4 shrink-0 text-fg-subtle transition group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HomeEmpty() {
  const t = useTranslations("home");
  const { setOpen } = useAddSheet();
  return (
    <section className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
      <div className="relative mb-8 grid size-40 place-items-center">
        <motion.span
          className="absolute inset-0 rounded-full"
          style={{ background: "radial-gradient(circle, var(--accent-soft), transparent 70%)" }}
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
        />
        <span className="grid size-20 place-items-center rounded-full bg-bg-elevated shadow-float hairline">
          <Sparkles className="size-8 text-accent" />
        </span>
      </div>
      <h1 className="font-display text-[2.6rem] leading-tight text-fg">{t("emptyTitle")}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">{t("emptyBody")}</p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-8 inline-flex h-12 items-center gap-2 rounded-full bg-fg px-6 text-[15px] font-medium text-bg shadow-soft transition hover:opacity-90"
      >
        {t("emptyCta")}
        <ArrowRight className="size-4" />
      </button>
    </section>
  );
}
