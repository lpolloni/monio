/**
 * System category catalog. Mirrors the rows inserted into `public.categories`
 * (user_id IS NULL) by the initial migration. Labels are translated in the UI via
 * `categories.<slug>` message keys; slugs are stable identifiers.
 */
export type CategoryKind = "expense" | "income" | "transfer";

export interface CategoryDefinition {
  slug: string;
  kind: CategoryKind;
  /** lucide-react icon name */
  icon: string;
  /** OKLCH hue used to derive the category color in both themes. */
  hue: number;
}

export const CATEGORY_CATALOG = [
  { slug: "groceries", kind: "expense", icon: "ShoppingBasket", hue: 145 },
  { slug: "dining", kind: "expense", icon: "UtensilsCrossed", hue: 40 },
  { slug: "transport", kind: "expense", icon: "TramFront", hue: 230 },
  { slug: "fuel", kind: "expense", icon: "Fuel", hue: 60 },
  { slug: "housing", kind: "expense", icon: "House", hue: 265 },
  { slug: "utilities", kind: "expense", icon: "Zap", hue: 85 },
  { slug: "telecom", kind: "expense", icon: "Wifi", hue: 210 },
  { slug: "subscriptions", kind: "expense", icon: "Repeat", hue: 300 },
  { slug: "shopping", kind: "expense", icon: "ShoppingBag", hue: 335 },
  { slug: "health", kind: "expense", icon: "HeartPulse", hue: 15 },
  { slug: "travel", kind: "expense", icon: "Plane", hue: 195 },
  { slug: "entertainment", kind: "expense", icon: "Clapperboard", hue: 320 },
  { slug: "education", kind: "expense", icon: "GraduationCap", hue: 250 },
  { slug: "personal_care", kind: "expense", icon: "Sparkles", hue: 350 },
  { slug: "insurance", kind: "expense", icon: "ShieldCheck", hue: 180 },
  { slug: "taxes", kind: "expense", icon: "Landmark", hue: 25 },
  { slug: "fees", kind: "expense", icon: "Receipt", hue: 10 },
  { slug: "gifts_donations", kind: "expense", icon: "Gift", hue: 355 },
  { slug: "business_expenses", kind: "expense", icon: "Briefcase", hue: 205 },
  { slug: "cash_withdrawal", kind: "expense", icon: "Banknote", hue: 120 },
  { slug: "other_expense", kind: "expense", icon: "CircleDashed", hue: 260 },
  { slug: "salary", kind: "income", icon: "BadgeDollarSign", hue: 155 },
  { slug: "business_income", kind: "income", icon: "Building2", hue: 170 },
  { slug: "freelance", kind: "income", icon: "PenTool", hue: 160 },
  { slug: "interest", kind: "income", icon: "Percent", hue: 140 },
  { slug: "dividends", kind: "income", icon: "TrendingUp", hue: 150 },
  { slug: "refunds", kind: "income", icon: "Undo2", hue: 175 },
  { slug: "other_income", kind: "income", icon: "CirclePlus", hue: 165 },
  { slug: "internal_transfer", kind: "transfer", icon: "ArrowLeftRight", hue: 240 },
  { slug: "card_payment", kind: "transfer", icon: "CreditCard", hue: 240 },
  { slug: "investment", kind: "transfer", icon: "ChartLine", hue: 275 },
  { slug: "fx_exchange", kind: "transfer", icon: "Repeat2", hue: 220 },
] as const satisfies readonly CategoryDefinition[];

export type CategorySlug = (typeof CATEGORY_CATALOG)[number]["slug"];

export const CATEGORY_SLUGS = CATEGORY_CATALOG.map((c) => c.slug) as unknown as readonly [
  CategorySlug,
  ...CategorySlug[],
];

const BY_SLUG = new Map<string, CategoryDefinition>(CATEGORY_CATALOG.map((c) => [c.slug, c]));

export function getCategory(slug: string): CategoryDefinition | undefined {
  return BY_SLUG.get(slug);
}

export function isCategorySlug(slug: string): slug is CategorySlug {
  return BY_SLUG.has(slug);
}

/** Categories that represent money moving between the user's own pockets. */
export function isTransferCategory(slug: string | null | undefined): boolean {
  return !!slug && BY_SLUG.get(slug)?.kind === "transfer";
}
