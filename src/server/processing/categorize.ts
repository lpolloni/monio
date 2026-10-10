import { matchRule, sortRules, type CategorizationRule } from "@/domain/categorization/rules";
import { isCategorySlug } from "@/domain/categories/catalog";
import { normalizeDescription } from "@/domain/transactions/normalize";
import type { AiService } from "../ai";
import type { MonioClient } from "../supabase/server";

export interface CategorizeInput {
  key: string;
  description: string;
  amount: string;
  currency: string;
  bookedOn?: string;
  accountType?: string;
  country?: string | null;
}

export interface CategorizeResult {
  categoryId: string | null;
  categorySlug: string | null;
  merchant: string | null;
  source: "rule" | "ai" | null;
  confidence: number | null;
  ruleId?: string;
  recurringHint?: boolean;
}

export interface LearnedRule {
  pattern: string;
  merchant: string | null;
  categoryId: string;
  direction: "in" | "out";
}

/** Minimum (simulated) confidence for applying an AI category automatically. */
export const AI_APPLY_THRESHOLD = 0.75;
/** Minimum confidence for turning an AI answer into a reusable rule. */
export const AI_LEARN_THRESHOLD = 0.9;

export async function loadRules(db: MonioClient, userId: string): Promise<CategorizationRule[]> {
  const { data, error } = await db
    .from("categorization_rules")
    .select("id, user_id, match_type, pattern, merchant, category_id, direction, priority, category:categories(slug)")
    .or(`user_id.is.null,user_id.eq.${userId}`);
  if (error) throw error;
  return (data ?? []).map((r) => {
    const cat = Array.isArray(r.category) ? r.category[0] : r.category;
    return {
      id: r.id,
      userId: r.user_id,
      matchType: r.match_type as CategorizationRule["matchType"],
      pattern: r.pattern,
      merchant: r.merchant,
      categoryId: r.category_id,
      categorySlug: cat?.slug ?? "",
      direction: (r.direction as "in" | "out" | null) ?? null,
      priority: r.priority,
    };
  });
}

/**
 * Deterministic rules first (user rules win); AI only for what rules could not
 * classify. AI answers are applied only above a confidence threshold and never
 * change amounts, dates or descriptions. High-confidence AI answers become user
 * rules so the same pattern is never sent to the model again.
 */
export async function categorizeBatch(
  items: CategorizeInput[],
  rules: CategorizationRule[],
  systemCategoryIds: Map<string, string>,
  ai: AiService | null,
): Promise<{ results: Map<string, CategorizeResult>; learned: LearnedRule[]; aiUsed: boolean; aiError: string | null }> {
  const sorted = sortRules(rules);
  const results = new Map<string, CategorizeResult>();
  const pending: CategorizeInput[] = [];
  for (const item of items) {
    const match = matchRule(item.description, item.amount, sorted);
    if (match) {
      results.set(item.key, {
        categoryId: match.categoryId,
        categorySlug: match.categorySlug,
        merchant: match.merchant,
        source: "rule",
        confidence: match.confidence,
        ruleId: match.ruleId,
      });
    } else {
      pending.push(item);
    }
  }

  const learned: LearnedRule[] = [];
  let aiUsed = false;
  let aiError: string | null = null;
  if (ai && pending.length > 0) {
    // Ask once per distinct description pattern.
    const byPattern = new Map<string, CategorizeInput>();
    for (const p of pending) {
      const k = `${normalizeDescription(p.description)}|${p.amount.startsWith("-") ? "out" : "in"}`;
      if (!byPattern.has(k)) byPattern.set(k, p);
    }
    const unique = [...byPattern.entries()];
    const response = await ai.interpretTransactions(
      unique.map(([, p], i) => ({
        id: `p${i}`,
        description: p.description,
        amount: p.amount,
        currency: p.currency,
        date: p.bookedOn,
        accountType: p.accountType,
        country: p.country ?? undefined,
      })),
      { purpose: "categorization" },
    );
    aiUsed = true;
    if (!response.ok) {
      aiError = response.error.code;
    } else {
      const idToPattern = new Map(unique.map(([k], i) => [`p${i}`, k]));
      const byKey = new Map<string, (typeof response.data)[number]>();
      for (const interp of response.data) {
        const k = idToPattern.get(interp.id);
        if (k) byKey.set(k, interp);
      }
      for (const p of pending) {
        const k = `${normalizeDescription(p.description)}|${p.amount.startsWith("-") ? "out" : "in"}`;
        const interp = byKey.get(k);
        if (!interp || !interp.category || !isCategorySlug(interp.category)) continue;
        if (interp.confidence < AI_APPLY_THRESHOLD) continue;
        const categoryId = systemCategoryIds.get(interp.category);
        if (!categoryId) continue;
        results.set(p.key, {
          categoryId,
          categorySlug: interp.category,
          merchant: interp.merchant,
          source: "ai",
          confidence: interp.confidence,
          recurringHint: interp.recurring_candidate,
        });
      }
      for (const [k, interp] of byKey) {
        if (!interp.category || interp.confidence < AI_LEARN_THRESHOLD) continue;
        const categoryId = systemCategoryIds.get(interp.category);
        const sample = byPattern.get(k);
        if (!categoryId || !sample) continue;
        const pattern = normalizeDescription(sample.description).split(" ").filter((t) => t.length > 1).slice(0, 3).join(" ");
        if (pattern.length < 3) continue;
        learned.push({ pattern, merchant: interp.merchant, categoryId, direction: sample.amount.startsWith("-") ? "out" : "in" });
      }
    }
  }
  for (const item of items) {
    if (!results.has(item.key)) results.set(item.key, { categoryId: null, categorySlug: null, merchant: null, source: null, confidence: null });
  }
  return { results, learned, aiUsed, aiError };
}

export async function persistLearnedRules(db: MonioClient, userId: string, learned: LearnedRule[]): Promise<number> {
  if (learned.length === 0) return 0;
  const unique = new Map(learned.map((l) => [`${l.pattern}|${l.direction}`, l]));
  const { data: existing, error: readError } = await db
    .from("categorization_rules")
    .select("pattern, direction")
    .eq("user_id", userId)
    .eq("match_type", "contains");
  if (readError) throw readError;
  for (const r of existing ?? []) unique.delete(`${r.pattern}|${r.direction}`);
  if (unique.size === 0) return 0;
  const { error } = await db.from("categorization_rules").insert(
    [...unique.values()].map((l) => ({
      user_id: userId,
      match_type: "contains" as const,
      pattern: l.pattern,
      merchant: l.merchant,
      category_id: l.categoryId,
      direction: l.direction,
      priority: 120,
      source: "ai" as const,
    })),
  );
  if (error) throw error;
  return unique.size;
}
