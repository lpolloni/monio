"use client";

import { ChevronRight, Eye, Landmark, Link2, Wallet } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "use-intl";
import type { AssetGroup, EntityKind } from "@/domain/accounts/classification";
import { Money } from "@/components/finance/money";
import { Badge } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/segmented";
import { formatMoney, formatRelative, freshnessOf } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ExploreAccount {
  id: string;
  name: string;
  type: string;
  group: AssetGroup;
  currency: string;
  balance: string | null;
  value: string | null;
  mask: string | null;
  creditLimit: string | null;
  entityKind: EntityKind;
  entityName: string;
  lastUpdated: string | null;
  holdings: { symbol: string; quantity: string }[];
  isWallet: boolean;
  countedInNetWorth: boolean;
}

export interface ExploreInstitution {
  key: string;
  name: string;
  short: string;
  color: string | null;
  country: string;
  value: string;
  accounts: ExploreAccount[];
}

type TypeFilter = "all" | "banks" | "cards" | "investments" | "crypto" | "loans";
type EntityFilter = "all" | EntityKind;

const TYPE_MATCH: Record<TypeFilter, (a: ExploreAccount) => boolean> = {
  all: () => true,
  banks: (a) => ["checking", "savings", "cash"].includes(a.type),
  cards: (a) => a.type === "credit_card",
  investments: (a) => a.type === "investment",
  crypto: (a) => a.type === "crypto_wallet",
  loans: (a) => a.type === "loan" || a.type === "mortgage",
};

const COUNTRY_KEYS: Record<string, string> = { BR: "countryBR", IT: "countryIT", DE: "countryDE", LT: "countryLT", BE: "countryBE" };

export function ExploreView({ institutions, currency, now }: { institutions: ExploreInstitution[]; currency: string; now: string }) {
  const t = useTranslations();
  const [type, setType] = useState<TypeFilter>("all");
  const [entity, setEntity] = useState<EntityFilter>("all");

  const groups = useMemo(() => {
    const filtered = institutions
      .map((inst) => ({
        ...inst,
        accounts: inst.accounts.filter((a) => TYPE_MATCH[type](a) && (entity === "all" || a.entityKind === entity)),
      }))
      .filter((inst) => inst.accounts.length > 0);
    const byCountry = new Map<string, ExploreInstitution[]>();
    for (const inst of filtered) {
      const list = byCountry.get(inst.country) ?? [];
      list.push(inst);
      byCountry.set(inst.country, list);
    }
    const order = ["BR", "IT", "DE", "LT", "BE"];
    return [...byCountry.entries()].sort(
      (a, b) => (order.indexOf(a[0]) === -1 ? 99 : order.indexOf(a[0])) - (order.indexOf(b[0]) === -1 ? 99 : order.indexOf(b[0])),
    );
  }, [institutions, type, entity]);

  const countryLabel = (code: string) => {
    if (code === "chain") return t("explore.wallets");
    if (code === "none") return t("explore.countryUnknown");
    const key = COUNTRY_KEYS[code];
    return key ? t(`explore.${key}` as "explore.countryBR") : code;
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0">
          <Segmented
            label={t("common.filters")}
            value={type}
            onChange={setType}
            options={[
              { value: "all", label: t("explore.filterAll") },
              { value: "banks", label: t("explore.filterBanks") },
              { value: "cards", label: t("explore.filterCards") },
              { value: "investments", label: t("explore.filterInvestments") },
              { value: "crypto", label: t("explore.filterCrypto") },
              { value: "loans", label: t("explore.filterLoans") },
            ]}
          />
        </div>
        <Segmented
          size="sm"
          label={t("common.entity")}
          value={entity}
          onChange={setEntity}
          options={[
            { value: "all", label: t("explore.allEntities") },
            { value: "personal", label: t("common.personal") },
            { value: "business", label: t("common.business") },
            { value: "shared", label: t("common.shared") },
          ]}
        />
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {groups.length === 0 ? (
          <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="py-16 text-center text-fg-muted">
            {t("explore.noAccounts")}
          </motion.p>
        ) : (
          groups.map(([country, list]) => (
            <motion.section key={country} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <h2 className="mb-4 flex items-center gap-3 text-[13px] font-medium uppercase tracking-[0.14em] text-fg-subtle">
                <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] tracking-normal text-fg-muted">
                  {country === "chain" ? <Link2 className="size-3" /> : country === "none" ? "—" : country}
                </span>
                {countryLabel(country)}
              </h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {list.map((inst, i) => (
                  <InstitutionCard key={inst.key} inst={inst} currency={currency} now={now} index={i} />
                ))}
              </div>
            </motion.section>
          ))
        )}
      </AnimatePresence>
    </div>
  );
}

function InstitutionCard({ inst, currency, now, index }: { inst: ExploreInstitution; currency: string; now: string; index: number }) {
  const t = useTranslations();
  const locale = useLocale();
  const nowDate = new Date(now);
  const color = inst.color ?? "var(--fg-subtle)";
  const negative = inst.value.startsWith("-");
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, type: "spring", stiffness: 300, damping: 30 }}
      className="relative overflow-hidden rounded-[1.75rem] bg-bg-elevated/80 hairline shadow-soft"
    >
      <div
        className="pointer-events-none absolute -top-24 -right-16 size-56 rounded-full opacity-50 blur-3xl"
        // Kept faint: amounts sit on top of this glow and must keep AA contrast.
        style={{ background: `color-mix(in oklch, ${color} 14%, transparent)` }}
        aria-hidden
      />
      <header className="relative flex items-center gap-3 px-5 pt-5">
        <span
          className="grid size-11 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-fg"
          style={{ background: `color-mix(in oklch, ${color} 24%, var(--bg-elevated))`, boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${color} 50%, transparent)` }}
        >
          {inst.short}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[16px] font-semibold text-fg">{inst.name}</h3>
          <p className="text-[12px] text-fg-subtle">{t("home.institutionAccounts", { count: inst.accounts.length })}</p>
        </div>
        <span className={cn("text-right font-display text-[1.45rem] leading-none tabular", negative ? "text-negative" : "text-fg")}>
          {formatMoney(inst.value, currency, locale, { maximumFractionDigits: 0 })}
        </span>
      </header>
      <ul className="relative mt-3 flex flex-col px-2 pb-2">
        {inst.accounts.map((a) => {
          const fresh = freshnessOf(a.lastUpdated, nowDate);
          return (
            <li key={a.id}>
              <Link href={`/${locale}/explore/${a.id}`} className="group flex items-center gap-3 rounded-2xl px-3 py-3 transition hover:bg-surface">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-fg-muted" aria-hidden>
                  {a.isWallet ? <Wallet className="size-4" /> : <Landmark className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium text-fg">{a.name}</span>
                    {a.entityKind !== "personal" ? (
                      <Badge tone={a.entityKind === "business" ? "accent" : "neutral"}>{t(`common.${a.entityKind}`)}</Badge>
                    ) : null}
                    {a.isWallet ? (
                      <Badge tone="positive">
                        <Eye className="size-3" />
                        {t("explore.watchOnly")}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-fg-subtle">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        fresh === "fresh" ? "bg-positive" : fresh === "aging" ? "bg-warning" : fresh === "stale" ? "bg-negative" : "bg-fg-subtle",
                      )}
                    />
                    {t(`accountTypes.${a.type}` as "accountTypes.checking")}
                    {a.mask ? ` · ${t("explore.mask", { mask: a.mask })}` : ""}
                    {" · "}
                    {a.lastUpdated ? formatRelative(a.lastUpdated, nowDate, locale) : t("common.neverUpdated")}
                  </span>
                  {a.creditLimit ? (
                    <span className="mt-0.5 block text-[11.5px] text-fg-subtle">
                      {t("explore.creditLimit", { value: formatMoney(a.creditLimit, a.currency, locale, { maximumFractionDigits: 0 }) })}
                    </span>
                  ) : null}
                  {a.holdings.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {[...new Set(a.holdings.map((h) => h.symbol))].slice(0, 5).map((symbol) => (
                        <span key={symbol} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-fg-muted">
                          {symbol}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
                <span className="flex flex-col items-end">
                  {a.balance !== null ? (
                    <Money amount={a.balance} currency={a.currency} className={cn("text-[14px] font-medium", a.balance.startsWith("-") ? "text-negative" : "text-fg")} />
                  ) : a.value !== null ? (
                    <Money amount={a.value} currency={currency} className="text-[14px] font-medium text-fg" />
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  )}
                  {a.value !== null && a.balance !== null && a.currency !== currency ? (
                    <Money amount={a.value} currency={currency} className="text-[11.5px] text-fg-subtle" />
                  ) : null}
                </span>
                <ChevronRight className="size-4 shrink-0 text-fg-subtle transition group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
      </ul>
    </motion.article>
  );
}
