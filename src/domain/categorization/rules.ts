import { normalizeDescription } from "../transactions/normalize";

export interface CategorizationRule {
  id: string;
  /** null = system rule */
  userId: string | null;
  matchType: "contains" | "starts_with" | "exact";
  pattern: string;
  merchant: string | null;
  categoryId: string;
  categorySlug: string;
  direction: "in" | "out" | null;
  priority: number;
}

export interface RuleMatch {
  ruleId: string;
  categoryId: string;
  categorySlug: string;
  merchant: string | null;
  source: "rule";
  /** User rules are explicit decisions; system rules are strong defaults. */
  confidence: number;
}

/**
 * Orders rules so that user decisions win over system defaults, then by priority
 * (lower first) and longer (more specific) patterns first.
 */
export function sortRules(rules: CategorizationRule[]): CategorizationRule[] {
  return [...rules].sort((a, b) => {
    if ((a.userId === null) !== (b.userId === null)) return a.userId === null ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.pattern.length - a.pattern.length;
  });
}

export function matchRule(
  description: string,
  amount: string,
  sortedRules: CategorizationRule[],
): RuleMatch | null {
  const text = normalizeDescription(description);
  const direction = amount.trim().startsWith("-") ? "out" : "in";
  for (const rule of sortedRules) {
    if (rule.direction && rule.direction !== direction) continue;
    const pattern = normalizeDescription(rule.pattern);
    if (!pattern) continue;
    const hit =
      rule.matchType === "exact"
        ? text === pattern
        : rule.matchType === "starts_with"
          ? text.startsWith(pattern)
          : ` ${text} `.includes(pattern.length <= 4 ? ` ${pattern} ` : pattern);
    if (hit) {
      return {
        ruleId: rule.id,
        categoryId: rule.categoryId,
        categorySlug: rule.categorySlug,
        merchant: rule.merchant,
        source: "rule",
        confidence: rule.userId ? 1 : 0.9,
      };
    }
  }
  return null;
}

/**
 * Builds a reusable user rule from a confirmed categorisation (Smart Inbox or
 * manual edit), so the same pattern is never sent to the AI again.
 */
export function ruleFromConfirmation(description: string, merchant: string | null): { matchType: "contains"; pattern: string } | null {
  const source = merchant ?? description;
  const pattern = normalizeDescription(source)
    .split(" ")
    .filter((t) => t.length > 1 && !/^\d+$/.test(t))
    .slice(0, 3)
    .join(" ");
  if (pattern.length < 3) return null;
  return { matchType: "contains", pattern };
}
