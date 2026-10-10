"use client";

import { FileText, LoaderCircle, Search, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import { CategoryPicker, type PickerCategory } from "@/components/finance/category-picker";
import { Money } from "@/components/finance/money";
import { TransactionItem } from "@/components/finance/transaction-item";
import { Badge } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";
import { cn, prettyDescription } from "@/lib/utils";
import { updateTransactionCategory } from "@/server/actions/finance";
import type { ActivityPeriod, ActivityRow } from "@/server/data/activity";

interface Props {
  rows: ActivityRow[];
  total: number;
  hasMore: boolean;
  currency: string;
  today: string;
  summary: { income: string; expenses: string; net: string };
  accounts: { id: string; name: string; institutionName: string | null }[];
  categories: PickerCategory[];
  filters: { period: ActivityPeriod; accountId?: string; categoryId?: string; q?: string; page: number };
}

export function ActivityView(props: Props) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(props.filters.q ?? "");
  const [selected, setSelected] = useState<ActivityRow | null>(null);

  const update = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in patch)) next.delete("page");
    startTransition(() => router.push(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  // Debounced search
  useEffect(() => {
    if ((props.filters.q ?? "") === search) return;
    const id = setTimeout(() => update({ q: search || undefined }), 350);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const groups = useMemo(() => {
    const map = new Map<string, ActivityRow[]>();
    for (const r of props.rows) {
      const list = map.get(r.bookedOn) ?? [];
      list.push(r);
      map.set(r.bookedOn, list);
    }
    return [...map.entries()];
  }, [props.rows]);

  const yesterday = new Date(Date.parse(`${props.today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const dayLabel = (d: string) =>
    d === props.today ? t("activity.today") : d === yesterday ? t("activity.yesterday") : formatDate(d, locale, "weekday");

  const activeAccount = props.accounts.find((a) => a.id === props.filters.accountId);
  const activeCategory = props.categories.find((c) => c.id === props.filters.categoryId);

  return (
    <div className="flex flex-col gap-6">
      {/* Filters */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-fg-subtle" />
            <span className="sr-only">{t("common.search")}</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("activity.searchPlaceholder")}
              className="h-11 w-full rounded-full bg-surface pr-4 pl-11 text-[14px] text-fg placeholder:text-fg-subtle hairline outline-none focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]"
            />
          </label>
          <div className="-mx-4 overflow-x-auto px-4 scrollbar-none lg:mx-0 lg:px-0">
            <Segmented
              label={t("common.period")}
              value={props.filters.period}
              onChange={(v) => update({ period: v === "3m" ? undefined : v })}
              options={[
                { value: "month", label: t("activity.periodThisMonth") },
                { value: "last_month", label: t("activity.periodLastMonth") },
                { value: "3m", label: t("activity.period3m") },
                { value: "12m", label: t("activity.period12m") },
                { value: "all", label: t("activity.periodAll") },
              ]}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label={t("common.account")}
            value={props.filters.accountId ?? ""}
            onChange={(e) => update({ account: e.target.value || undefined })}
            className="h-9 max-w-[16rem] rounded-full bg-surface px-3 text-[13px] text-fg hairline outline-none"
          >
            <option value="">{t("common.accounts")}: {t("common.all")}</option>
            {props.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.institutionName ? `${a.institutionName} · ` : ""}
                {a.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t("common.category")}
            value={props.filters.categoryId ?? ""}
            onChange={(e) => update({ category: e.target.value || undefined })}
            className="h-9 max-w-[14rem] rounded-full bg-surface px-3 text-[13px] text-fg hairline outline-none"
          >
            <option value="">{t("common.category")}: {t("common.all")}</option>
            <option value="uncategorized">{t("categories.uncategorized")}</option>
            {props.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {t(`categories.${c.slug}` as "categories.groceries")}
              </option>
            ))}
          </select>
          <AnimatePresence>
            {activeAccount || activeCategory || props.filters.q ? (
              <motion.button
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                type="button"
                onClick={() => {
                  setSearch("");
                  update({ account: undefined, category: undefined, q: undefined });
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-fg-muted transition hover:text-fg"
              >
                <X className="size-3.5" />
                {t("common.clearFilters")}
              </motion.button>
            ) : null}
          </AnimatePresence>
          {pending ? <LoaderCircle className="size-4 animate-spin text-fg-subtle" /> : null}
        </div>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-2 rounded-[1.5rem] bg-bg-elevated/70 p-2 hairline sm:max-w-xl">
        {[
          [t("activity.summaryIncome"), props.summary.income, "text-positive"],
          [t("activity.summaryExpenses"), props.summary.expenses, "text-fg"],
          [t("activity.summaryNet"), props.summary.net, props.summary.net.startsWith("-") ? "text-negative" : "text-positive"],
        ].map(([label, amount, tone]) => (
          <div key={label} className="rounded-2xl px-3 py-2.5">
            <p className="text-[11.5px] uppercase tracking-[0.12em] text-fg-subtle">{label}</p>
            <p className={cn("mt-1 text-[15px] font-semibold tabular sm:text-[17px]", tone)}>{formatMoney(amount!, props.currency, locale)}</p>
          </div>
        ))}
      </div>
      <p className="-mt-3 text-[12.5px] text-fg-subtle">{t("activity.showing", { count: props.total })}</p>

      {/* List */}
      <div className={cn("flex flex-col transition-opacity", pending && "opacity-60")}>
        {groups.length === 0 ? (
          <p className="py-16 text-center text-fg-muted">{t("activity.noResults")}</p>
        ) : (
          groups.map(([day, rows]) => (
            <section key={day} className="mb-2">
              <h3 className="sticky top-[4.5rem] z-10 -mx-2 mb-1 bg-bg/85 px-2 py-2 text-[12.5px] font-medium text-fg-subtle backdrop-blur-md first-letter:uppercase">
                {dayLabel(day)}
              </h3>
              <div className="-mx-2 flex flex-col">
                {rows.map((r) => (
                  <TransactionItem key={r.id} tx={r} onSelect={() => setSelected(r)} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      {props.hasMore ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => update({ page: String(props.filters.page + 1) })}
          className="mx-auto inline-flex h-10 items-center gap-2 rounded-full bg-surface-2 px-5 text-[13.5px] font-medium text-fg hairline transition hover:shadow-soft disabled:opacity-60"
        >
          {pending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {t("activity.loadMore")}
        </button>
      ) : null}

      <TransactionDetail row={selected} categories={props.categories} onClose={() => setSelected(null)} />
    </div>
  );
}

function TransactionDetail({ row, categories, onClose }: { row: ActivityRow | null; categories: PickerCategory[]; onClose: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [remember, setRemember] = useState(true);
  const [current, setCurrent] = useState<string | null>(null);
  const categoryId = current ?? row?.categoryId ?? null;
  const sourceKey = row?.categorySource
    ? ({ rule: "sourceRule", ai: "sourceAi", user: "sourceUser", import: "sourceImport", default: "sourceDefault" } as const)[row.categorySource as "rule"]
    : null;
  const extractionKey = row?.extraction
    ? ({ exact: "extractionExact", heuristic: "extractionHeuristic", ai: "extractionAi" } as const)[row.extraction as "exact"]
    : null;

  return (
    <Sheet
      open={!!row}
      onOpenChange={(open) => {
        if (!open) {
          setCurrent(null);
          onClose();
        }
      }}
      title={row?.merchant ?? (row ? prettyDescription(row.description) : "")}
      description={row ? `${formatDate(row.bookedOn, locale, "long")} · ${row.institutionName ?? ""} ${row.accountName}` : undefined}
      closeLabel={t("common.close")}
    >
      {row ? (
        <div className="flex flex-col gap-6">
          <div>
            <Money amount={row.amount} currency={row.currency} signDisplay="exceptZero" className={cn("font-display text-[2.6rem] leading-none", row.amount.startsWith("-") ? "text-fg" : "text-positive")} />
            {row.converted ? <Money amount={row.converted} currency={row.displayCurrency} className="mt-1 block text-[14px] text-fg-muted" /> : null}
            {row.originalAmount && row.originalCurrency ? (
              <p className="mt-1 text-[13px] text-fg-muted">{t("activity.originalAmount", { amount: formatMoney(row.originalAmount, row.originalCurrency, locale) })}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {row.classification !== "regular" ? <Badge tone="accent">{t("activity.excludedFromCashflow")}</Badge> : null}
              {row.status === "pending" ? <Badge tone="warning">{t("common.pending")}</Badge> : null}
              {row.duplicateOf ? <Badge tone="warning">{t("activity.duplicate")}</Badge> : null}
            </div>
            {row.counterpartAccount ? (
              <p className="mt-3 text-[13px] text-fg-muted">
                {t("activity.counterpart")}: {row.counterpartAccount}
              </p>
            ) : null}
          </div>

          <div>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle">{t("activity.changeCategory")}</h3>
              {sourceKey ? (
                <span className="text-[12px] text-fg-subtle">
                  {t("activity.categorySource", { source: t(`activity.${sourceKey}`) })}
                  {row.categoryConfidence && row.categorySource === "ai"
                    ? ` · ${t("activity.confidence", { value: `${formatNumber(String(Number(row.categoryConfidence) * 100), locale, 0)}% (${t("activity.simulatedConfidence")})` })}`
                    : ""}
                </span>
              ) : null}
            </div>
            <CategoryPicker
              categories={categories}
              value={categoryId}
              direction={row.amount.startsWith("-") ? "out" : "in"}
              disabled={pending}
              onSelect={(id) => {
                setCurrent(id);
                startTransition(async () => {
                  const r = await updateTransactionCategory(row.id, id, remember);
                  if (r.ok) toast.success(t("activity.categoryUpdated"));
                  else toast.error(t("common.somethingWrong"));
                });
              }}
            />
            <label className="mt-3 flex items-center gap-2 text-[13px] text-fg-muted">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-[var(--accent)]" />
              {t("activity.rememberRule")}
            </label>
          </div>

          <div className="rounded-2xl bg-surface p-4 hairline">
            <h3 className="mb-2 text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle">{t("activity.provenance")}</h3>
            <p className="font-mono text-[12.5px] break-words text-fg">{row.description}</p>
            <ul className="mt-3 flex flex-col gap-1.5 text-[12.5px] text-fg-muted">
              {row.documentName ? (
                <li className="flex items-center gap-2">
                  <FileText className="size-3.5" />
                  {t("activity.importedFrom", { file: row.documentName })}
                  {row.sourceRow ? ` · ${t("activity.sourceRow", { row: row.sourceRow })}` : ""}
                </li>
              ) : null}
              {extractionKey ? <li>{t("activity.extraction", { method: t(`activity.${extractionKey}`) })}</li> : null}
              {row.source === "seed" ? <li>{t("common.fictionalData")}</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
