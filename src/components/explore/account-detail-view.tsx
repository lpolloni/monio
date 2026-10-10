"use client";

import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Copy, Eye, EyeOff, FileText, LoaderCircle, RefreshCw, Settings2, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { useLocale, useTranslations } from "use-intl";
import { AreaTrend } from "@/components/charts/area-trend";
import { Money } from "@/components/finance/money";
import { TransactionItem } from "@/components/finance/transaction-item";
import { Badge, SectionHeader } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { formatDate, formatMoney, formatNumber, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { syncWallet } from "@/server/actions/wallets";
import { AccountSettingsSheet } from "./account-settings-sheet";
import type { AccountDetail } from "@/server/data/account-detail";

export function AccountDetailView({ detail, short, now }: { detail: AccountDetail; short: string; now: string }) {
  const t = useTranslations();
  const locale = useLocale();
  const { account } = detail;
  const color = account.institutionColor ?? "var(--accent)";
  const [syncing, startSync] = useTransition();
  const [editing, setEditing] = useState(false);
  const nowDate = new Date(now);
  const isLiability = ["credit_card", "loan", "mortgage"].includes(account.type);
  const lastUpdated = account.lastSyncedAt ?? account.balanceAsOf;
  const chartData = detail.balances
    .filter((b) => b.value !== null)
    .map((b) => ({
      date: b.date,
      value: Number(b.balance), // drawing only
      label: formatMoney(b.balance, account.currency, locale),
    }));

  return (
    <div className="flex flex-col gap-10">
      <div>
        <div className="flex items-center justify-between gap-3">
          <Link href={`/${locale}/explore`} className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted transition hover:text-fg">
            <ArrowLeft className="size-4" />
            {t("explore.title")}
          </Link>
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            <Settings2 />
            {t("explore.editAccount")}
          </Button>
        </div>
        <AccountSettingsSheet
          key={`${account.name}|${account.entityId}|${account.includeInNetWorth}`}
          open={editing}
          onOpenChange={setEditing}
          account={account}
          entities={detail.entities}
        />
        <div className="mt-5 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="flex items-center gap-4">
            <span
              className="grid size-16 shrink-0 place-items-center rounded-full text-[17px] font-semibold text-fg"
              style={{ background: `color-mix(in oklch, ${color} 24%, var(--bg-elevated))`, boxShadow: `inset 0 0 0 1.5px color-mix(in oklch, ${color} 55%, transparent)` }}
            >
              {short}
            </span>
            <div>
              <p className="text-[13px] text-fg-muted">{account.institutionName}</p>
              <h1 className="font-display text-[2.4rem] leading-none text-fg sm:text-[2.8rem]">{account.name}</h1>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge>{t(`accountTypes.${account.type}` as "accountTypes.checking")}</Badge>
                <Badge tone={account.entityKind === "business" ? "accent" : "neutral"}>{account.entityName || t(`common.${account.entityKind}`)}</Badge>
                {account.accountMask ? <Badge>{t("explore.mask", { mask: account.accountMask })}</Badge> : null}
                {account.includeInNetWorth ? null : (
                  <Badge tone="warning">
                    <EyeOff className="size-3" />
                    {t("explore.excludedFromNetWorth")}
                  </Badge>
                )}
                {account.wallet ? (
                  <Badge tone="positive">
                    <Eye className="size-3" />
                    {t("explore.watchOnly")}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
          <div className="md:text-right">
            {account.balance !== null ? (
              <Money
                amount={account.balance}
                currency={account.currency}
                className={cn("block font-display text-[2.8rem] leading-none", account.balance.startsWith("-") ? "text-negative" : "text-fg")}
              />
            ) : detail.value !== null ? (
              <Money amount={detail.value} currency={detail.currency} className="block font-display text-[2.8rem] leading-none text-fg" />
            ) : null}
            {detail.value !== null && account.balance !== null && account.currency !== detail.currency ? (
              <Money amount={detail.value} currency={detail.currency} className="mt-1 block text-[14px] text-fg-muted" />
            ) : null}
            <p className="mt-2 text-[12.5px] text-fg-subtle">
              {lastUpdated ? t("common.updated", { when: formatRelative(lastUpdated, nowDate, locale) }) : t("common.neverUpdated")}
              {account.wallet ? null : ` · ${t("home.freshnessHint")}`}
            </p>
            {account.creditLimit ? (
              <p className="mt-1 text-[12.5px] text-fg-subtle">
                {t("explore.creditLimit", { value: formatMoney(account.creditLimit, account.currency, locale, { maximumFractionDigits: 0 }) })}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {account.wallet ? (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
          <div>
            <SectionHeader
              title={t("explore.holdings")}
              action={
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={syncing}
                  onClick={() =>
                    startSync(async () => {
                      const r = await syncWallet(account.wallet!.id);
                      if (r.ok) toast.success(t("explore.synced"));
                      else toast.error(t("explore.syncFailed"));
                    })
                  }
                >
                  {syncing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                  {syncing ? t("explore.syncing") : t("explore.syncNow")}
                </Button>
              }
            />
            <ul className="flex flex-col divide-y divide-border rounded-[1.5rem] bg-bg-elevated/80 px-4 hairline">
              {detail.holdings.map((h) => (
                <li key={`${h.network}-${h.symbol}`} className="flex items-center gap-3 py-3.5">
                  <span className="grid size-10 place-items-center rounded-full bg-crypto/15 text-[12px] font-semibold text-crypto">{h.symbol.slice(0, 4)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14.5px] font-medium text-fg">{h.name}</span>
                    <span className="block text-[12px] text-fg-subtle">
                      {formatNumber(h.quantity, locale, 8)} {h.symbol} · {h.network}
                    </span>
                  </span>
                  {h.value !== null ? <Money amount={h.value} currency={detail.currency} className="text-[14px] font-medium" /> : <span className="text-fg-subtle">—</span>}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[12px] text-fg-subtle">{t("explore.costBasisUnknown")}</p>
          </div>
          <div className="flex flex-col gap-4">
            <div className="rounded-[1.5rem] bg-surface p-5 hairline">
              <p className="text-[12px] uppercase tracking-[0.14em] text-fg-subtle">
                {account.wallet.watchKind === "address" ? t("explore.address") : t("explore.xpub")}
              </p>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(account.wallet!.publicIdentifier);
                }}
                className="mt-2 flex w-full items-center gap-2 text-left font-mono text-[12.5px] break-all text-fg"
              >
                {account.wallet.publicIdentifier}
                <Copy className="size-3.5 shrink-0 text-fg-subtle" />
              </button>
              <p className="mt-3 text-[12px] text-fg-subtle">
                {t("explore.networks")}: {account.wallet.networks.join(", ") || "—"}
              </p>
              <div className="mt-4 flex items-start gap-2 rounded-2xl bg-positive-soft px-3 py-2.5 text-[12.5px] text-positive">
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                {t("wallet.readOnly")}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-fg-subtle">{t("wallet.privacyNotice")}</p>
            </div>
          </div>
        </section>
      ) : null}

      {chartData.length > 1 ? (
        <section>
          <SectionHeader title={t("explore.balanceHistory")} />
          <div className="rounded-[1.75rem] bg-bg-elevated/70 p-4 hairline sm:p-6">
            <AreaTrend data={chartData} currency={account.currency} color={isLiability ? "var(--negative)" : color} />
          </div>
        </section>
      ) : null}

      {detail.liability ? (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            [t("explore.loanDetails"), detail.liability.principal ? formatMoney(detail.liability.principal, account.currency, locale) : "—"],
            [t("explore.interestRate"), detail.liability.rate ? `${formatNumber(detail.liability.rate, locale, 2)}%` : "—"],
            [t("explore.monthlyPayment"), detail.liability.monthly ? formatMoney(detail.liability.monthly, account.currency, locale) : "—"],
            [t("explore.maturity"), detail.liability.maturity ? formatDate(detail.liability.maturity, locale, "medium") : "—"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-surface px-4 py-3.5 hairline">
              <p className="text-[12px] text-fg-subtle">{label}</p>
              <p className="mt-1 text-[15px] font-medium text-fg tabular">{value}</p>
            </div>
          ))}
        </section>
      ) : null}

      <section className="grid grid-cols-1 gap-10 lg:grid-cols-[1.3fr_0.7fr]">
        <div>
          <SectionHeader
            title={account.wallet ? t("explore.blockchainActivity") : t("explore.transactions")}
            action={
              !account.wallet && detail.transactionCount > detail.transactions.length ? (
                <Link href={`/${locale}/activity?account=${account.accountId}&period=all`} className="text-[13px] text-fg-muted hover:text-fg">
                  {t("common.seeAll")} ({detail.transactionCount})
                </Link>
              ) : null
            }
          />
          {account.wallet ? (
            <ul className="flex flex-col">
              {detail.chainTransactions.map((tx, i) => (
                <motion.li key={`${tx.hash}-${i}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.02 }} className="flex items-center gap-3 px-2 py-2.5">
                  <span className={cn("grid size-9 place-items-center rounded-xl", tx.direction === "in" ? "bg-positive-soft text-positive" : "bg-surface-2 text-fg-muted")}>
                    {tx.direction === "in" ? <ArrowDownLeft className="size-4" /> : <ArrowUpRight className="size-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[12.5px] text-fg">{tx.hash.slice(0, 10)}…{tx.hash.slice(-6)}</span>
                    <span className="block text-[12px] text-fg-subtle">
                      {formatDate(tx.time.slice(0, 10), locale, "medium")} · {tx.network}
                    </span>
                  </span>
                  <span className={cn("text-[14px] font-medium tabular", tx.direction === "in" ? "text-positive" : "text-fg")}>
                    {tx.direction === "in" ? "+" : tx.direction === "out" ? "−" : ""}
                    {formatNumber(tx.quantity, locale, 8)} {tx.symbol}
                  </span>
                </motion.li>
              ))}
            </ul>
          ) : detail.transactions.length === 0 ? (
            <p className="text-fg-muted">{t("explore.noTransactions")}</p>
          ) : (
            <div className="-mx-2 flex flex-col">
              {detail.transactions.map((tx) => (
                <TransactionItem
                  key={tx.id}
                  compact
                  showDate
                  tx={{ ...tx, displayCurrency: detail.currency, accountName: account.name, institutionName: account.institutionName }}
                />
              ))}
            </div>
          )}
        </div>
        {!account.wallet ? (
          <div>
            <SectionHeader title={t("explore.sourceDocuments")} />
            {detail.documents.length === 0 ? (
              <p className="text-[14px] text-fg-muted">{t("explore.noDocuments")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {detail.documents.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 rounded-2xl bg-surface px-4 py-3 hairline">
                    <FileText className="size-4 text-fg-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-fg">{d.filename}</span>
                      <span className="text-[11.5px] uppercase text-fg-subtle">
                        {d.format} · {formatDate(d.createdAt.slice(0, 10), locale, "medium")}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
