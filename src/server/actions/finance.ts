"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { ruleFromConfirmation } from "@/domain/categorization/rules";
import { todayIso } from "../data/dates";
import { getSession } from "../data/session";
import { postProcessUser } from "../processing/post-process";

type Result = { ok: true } | { ok: false; error: "unauthorized" | "validation" | "not_found" | "failed" };

const uuid = z.uuid();

/**
 * Sets a transaction's category as a user decision and (optionally) remembers it
 * as a rule so similar transactions are categorized deterministically next time.
 */
export async function updateTransactionCategory(transactionId: string, categoryId: string, remember: boolean): Promise<Result> {
  if (!uuid.safeParse(transactionId).success || !uuid.safeParse(categoryId).success) return { ok: false, error: "validation" };
  const s = await getSession();
  if (!s) return { ok: false, error: "unauthorized" };
  const { data: tx } = await s.supabase.from("transactions").select("id, description_original, merchant, amount:amount::text").eq("id", transactionId).single();
  const { data: category } = await s.supabase.from("categories").select("id, kind").eq("id", categoryId).single();
  if (!tx || !category) return { ok: false, error: "not_found" };
  const { error } = await s.supabase
    .from("transactions")
    .update({
      category_id: categoryId,
      category_source: "user",
      category_confidence: 1,
      ...(category.kind === "transfer" ? {} : { classification: "regular" }),
    })
    .eq("id", transactionId);
  if (error) return { ok: false, error: "failed" };
  if (remember) {
    const rule = ruleFromConfirmation(tx.description_original, tx.merchant);
    if (rule) {
      const direction = tx.amount.startsWith("-") ? "out" : "in";
      const { data: existing } = await s.supabase
        .from("categorization_rules")
        .select("id")
        .eq("user_id", s.userId)
        .eq("pattern", rule.pattern)
        .eq("direction", direction)
        .maybeSingle();
      if (existing) {
        await s.supabase.from("categorization_rules").update({ category_id: categoryId, source: "user", priority: 50 }).eq("id", existing.id);
      } else {
        await s.supabase.from("categorization_rules").insert({
          user_id: s.userId,
          match_type: rule.matchType,
          pattern: rule.pattern,
          merchant: tx.merchant,
          category_id: categoryId,
          direction,
          priority: 50,
          source: "user",
        });
      }
    }
  }
  await s.supabase
    .from("inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution: { categoryId } })
    .eq("dedupe_key", `uncategorized:${transactionId}`)
    .eq("status", "open");
  refresh();
  return { ok: true };
}

const DecisionSchema = z.object({
  itemId: uuid,
  decision: z.enum(["transfer", "not_transfer", "duplicate", "keep", "yes", "no", "dismiss", "categorize", "institution"]),
  categoryId: uuid.optional(),
  institutionId: uuid.optional(),
});

/** Resolves a Smart Inbox question and applies the user's answer. */
export async function resolveInboxItem(input: z.input<typeof DecisionSchema>): Promise<Result> {
  const parsed = DecisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation" };
  const { itemId, decision, categoryId, institutionId } = parsed.data;
  const s = await getSession();
  if (!s) return { ok: false, error: "unauthorized" };
  const { data: item } = await s.supabase.from("inbox_items").select("id, kind, payload, status, document_id, recurring_series_id").eq("id", itemId).single();
  if (!item || item.status !== "open") return { ok: false, error: "not_found" };
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let rerun = false;

  if (decision === "dismiss") {
    await s.supabase.from("inbox_items").update({ status: "dismissed", resolved_at: new Date().toISOString() }).eq("id", itemId);
    refresh();
    return { ok: true };
  }

  switch (item.kind) {
    case "transfer_match":
      if (decision !== "transfer" && decision !== "not_transfer") return { ok: false, error: "validation" };
      rerun = true; // post-processing applies the remembered pair decision
      break;
    case "possible_duplicate":
      if (decision === "duplicate") {
        const txId = str(payload.transactionId);
        const dupOf = str(payload.duplicateOfId);
        if (!uuid.safeParse(txId).success || !uuid.safeParse(dupOf).success) return { ok: false, error: "validation" };
        const { error } = await s.supabase.from("transactions").update({ duplicate_of: dupOf }).eq("id", txId);
        if (error) return { ok: false, error: "failed" };
      } else if (decision !== "keep") return { ok: false, error: "validation" };
      break;
    case "uncategorized": {
      if (decision !== "categorize" || !categoryId) return { ok: false, error: "validation" };
      const r = await updateTransactionCategory(str(payload.transactionId), categoryId, true);
      if (!r.ok) return r;
      break;
    }
    case "subscription_candidate":
      if (!item.recurring_series_id || (decision !== "yes" && decision !== "no")) return { ok: false, error: "validation" };
      await s.supabase
        .from("recurring_series")
        .update(decision === "yes" ? { status: "confirmed", is_subscription: true } : { status: "dismissed", is_subscription: false })
        .eq("id", item.recurring_series_id);
      break;
    case "unknown_institution": {
      if (decision !== "institution" || !institutionId || !item.document_id) return { ok: false, error: "validation" };
      await s.supabase.from("documents").update({ detected_institution_id: institutionId }).eq("id", item.document_id);
      const { data: txs } = await s.supabase.from("transactions").select("account_id").eq("document_id", item.document_id).limit(5000);
      const accountIds = [...new Set((txs ?? []).map((t) => t.account_id))];
      if (accountIds.length) await s.supabase.from("accounts").update({ institution_id: institutionId }).in("id", accountIds).is("institution_id", null);
      break;
    }
    default:
      if (decision !== "yes" && decision !== "no") return { ok: false, error: "validation" };
  }

  const { error } = await s.supabase
    .from("inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString(), resolution: { decision, ...(categoryId ? { categoryId } : {}), ...(institutionId ? { institutionId } : {}) } })
    .eq("id", itemId);
  if (error) return { ok: false, error: "failed" };
  await s.supabase.rpc("log_user_action", { p_action: `inbox.${item.kind}.${decision}`, p_target_table: "inbox_items", p_target_id: itemId, p_details: {} });
  if (rerun) await postProcessUser(s.supabase, s.userId, { today: todayIso() });
  refresh();
  return { ok: true };
}

/**
 * Deletes every financial record of the current user: stored documents (via the
 * Storage API) and all rows (via an RLS-scoped SQL function). The account itself
 * and the personal entity remain.
 */
export async function deleteAllFinancialData(confirmation: string): Promise<Result> {
  if (confirmation !== "DELETE") return { ok: false, error: "validation" };
  const s = await getSession();
  if (!s) return { ok: false, error: "unauthorized" };
  const { data: docs } = await s.supabase.from("documents").select("storage_path");
  const paths = (docs ?? []).map((d) => d.storage_path).filter(Boolean);
  for (let i = 0; i < paths.length; i += 100) {
    await s.supabase.storage.from("documents").remove(paths.slice(i, i + 100));
  }
  const { error } = await s.supabase.rpc("delete_my_financial_data");
  if (error) return { ok: false, error: "failed" };
  refresh();
  return { ok: true };
}
