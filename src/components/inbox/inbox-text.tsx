"use client";

import { useLocale, useTranslations } from "use-intl";
import { formatDate, formatMoney } from "@/lib/format";

export interface InboxItemData {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
}

/** Builds the human question for a Smart Inbox item from its structured payload. */
export function useInboxText() {
  const t = useTranslations("inbox");
  const tActivity = useTranslations("activity");
  const locale = useLocale();
  const money = (amount: unknown, currency: unknown) => formatMoney(str(amount, "0"), str(currency, "EUR"), locale);
  const date = (v: unknown) => (typeof v === "string" && v ? formatDate(v, locale, "medium") : "");
  return (item: InboxItemData): string => {
    const p = item.payload;
    switch (item.kind) {
      case "transfer_match":
        return t("transfer_match_question", {
          outAmount: money(p.outAmount, p.outCurrency),
          inAmount: money(p.inAmount, p.inCurrency),
          from: str(p.fromAccount),
          to: str(p.toAccount),
        });
      case "possible_duplicate":
        return t("possible_duplicate_question", { description: str(p.description), amount: money(p.amount, p.currency), date: date(p.date) });
      case "unknown_institution":
        return t("unknown_institution_question", { file: str(p.file) });
      case "uncategorized":
        return t("uncategorized_question", { description: str(p.description), amount: money(p.amount, p.currency) });
      case "subscription_candidate":
        return t("subscription_candidate_question", {
          merchant: str(p.merchant),
          amount: money(p.amount, p.currency),
          cadence: tActivity(`cadence_${str(p.cadence, "monthly")}` as "cadence_monthly").toLowerCase(),
        });
      case "stale_source":
        return t("stale_source_question", { account: str(p.account), date: date(p.date) });
      case "document_incomplete":
        return t("document_incomplete_question", { file: str(p.file) });
      case "account_confirmation":
        return t("account_confirmation_question", { account: str(p.account) });
      default:
        return item.kind;
    }
  };
}
