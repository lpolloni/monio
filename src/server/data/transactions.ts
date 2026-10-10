import "server-only";
import type { FlowTransaction } from "@/domain/analytics/cashflow";
import type { CategoryKind } from "@/domain/categories/catalog";
import type { MonioClient } from "../supabase/server";
import type { AccountRecord } from "./finance";

export interface CategoryRecord {
  id: string;
  slug: string;
  kind: CategoryKind;
  name: string | null;
  hue: number | null;
  icon: string | null;
  isSystem: boolean;
}

export interface TransactionRow {
  id: string;
  accountId: string;
  bookedOn: string;
  description: string;
  merchant: string | null;
  amount: string;
  currency: string;
  originalAmount: string | null;
  originalCurrency: string | null;
  status: string;
  classification: string;
  categoryId: string | null;
  categorySource: string | null;
  categoryConfidence: string | null;
  transferGroupId: string | null;
  counterpartId: string | null;
  duplicateOf: string | null;
  recurringSeriesId: string | null;
  documentId: string | null;
  sourceRow: number | null;
  source: string;
  extraction: string | null;
}

const SELECT =
  "id, account_id, booked_on, description_original, merchant, amount:amount::text, currency, original_amount:original_amount::text, original_currency, status, classification, category_id, category_source, category_confidence:category_confidence::text, transfer_group_id, counterpart_transaction_id, duplicate_of, recurring_series_id, document_id, source_row, source, extraction";

type RawRow = {
  id: string;
  account_id: string;
  booked_on: string;
  description_original: string;
  merchant: string | null;
  amount: string;
  currency: string;
  original_amount: string | null;
  original_currency: string | null;
  status: string;
  classification: string;
  category_id: string | null;
  category_source: string | null;
  category_confidence: string | null;
  transfer_group_id: string | null;
  counterpart_transaction_id: string | null;
  duplicate_of: string | null;
  recurring_series_id: string | null;
  document_id: string | null;
  source_row: number | null;
  source: string;
  extraction: string | null;
};

export function mapRow(r: RawRow): TransactionRow {
  return {
    id: r.id,
    accountId: r.account_id,
    bookedOn: r.booked_on,
    description: r.description_original,
    merchant: r.merchant,
    amount: r.amount,
    currency: r.currency,
    originalAmount: r.original_amount,
    originalCurrency: r.original_currency,
    status: r.status,
    classification: r.classification,
    categoryId: r.category_id,
    categorySource: r.category_source,
    categoryConfidence: r.category_confidence,
    transferGroupId: r.transfer_group_id,
    counterpartId: r.counterpart_transaction_id,
    duplicateOf: r.duplicate_of,
    recurringSeriesId: r.recurring_series_id,
    documentId: r.document_id,
    sourceRow: r.source_row,
    source: r.source,
    extraction: r.extraction,
  };
}

export async function loadCategories(db: MonioClient, userId: string): Promise<CategoryRecord[]> {
  const { data, error } = await db
    .from("categories")
    .select("id, slug, kind, name, hue, icon, user_id")
    .or(`user_id.is.null,user_id.eq.${userId}`);
  if (error) throw error;
  return (data ?? []).map((c) => ({
    id: c.id,
    slug: c.slug,
    kind: c.kind as CategoryKind,
    name: c.name,
    hue: c.hue,
    icon: c.icon,
    isSystem: c.user_id === null,
  }));
}


export async function loadTransactionsInRange(db: MonioClient, userId: string, from: string, to: string, max = 20_000): Promise<TransactionRow[]> {
  const out: TransactionRow[] = [];
  for (let offset = 0; offset < max; offset += 1000) {
    const { data, error } = await db
      .from("transactions")
      .select(SELECT)
      .eq("user_id", userId)
      .gte("booked_on", from)
      .lte("booked_on", to)
      .order("booked_on", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw error;
    const rows = (data ?? []) as RawRow[];
    out.push(...rows.map(mapRow));
    if (rows.length < 1000) break;
  }
  return out;
}


/** Booked movements of one account that change its balance: posted, not duplicates, in the account currency. */
export async function loadAccountMovements(db: MonioClient, accountId: string, currency: string, max = 20_000): Promise<{ bookedOn: string; amount: string }[]> {
  const out: { bookedOn: string; amount: string }[] = [];
  for (let offset = 0; offset < max; offset += 1000) {
    const { data, error } = await db
      .from("transactions")
      .select("booked_on, amount:amount::text")
      .eq("account_id", accountId)
      .eq("currency", currency)
      .eq("status", "posted")
      .is("duplicate_of", null)
      .order("booked_on", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows.map((r) => ({ bookedOn: r.booked_on, amount: r.amount })));
    if (rows.length < 1000) break;
  }
  return out;
}

export function toFlow(
  tx: TransactionRow,
  accounts: Map<string, AccountRecord>,
  categories: Map<string, CategoryRecord>,
): FlowTransaction {
  const account = accounts.get(tx.accountId);
  const category = tx.categoryId ? categories.get(tx.categoryId) : undefined;
  return {
    id: tx.id,
    bookedOn: tx.bookedOn,
    amount: tx.amount,
    currency: tx.currency,
    classification: tx.classification,
    categorySlug: category?.slug ?? null,
    categoryKind: category?.kind ?? null,
    accountId: tx.accountId,
    entityKind: account?.entityKind ?? "personal",
    country: account?.country ?? null,
    institutionId: account?.institutionId ?? null,
    status: tx.status,
    duplicateOf: tx.duplicateOf,
    merchant: tx.merchant,
  };
}

export interface ActivityFilters {
  from?: string;
  to?: string;
  accountIds?: string[];
  categoryId?: string | "uncategorized";
  search?: string;
  currency?: string;
  limit: number;
  offset: number;
}

/** Server-side filtered, paginated transaction list for the Activity view. */
export async function queryActivity(db: MonioClient, filters: ActivityFilters): Promise<{ rows: TransactionRow[]; total: number }> {
  let q = db.from("transactions").select(SELECT, { count: "exact" });
  if (filters.from) q = q.gte("booked_on", filters.from);
  if (filters.to) q = q.lte("booked_on", filters.to);
  if (filters.accountIds && filters.accountIds.length > 0) q = q.in("account_id", filters.accountIds);
  if (filters.categoryId === "uncategorized") q = q.is("category_id", null);
  else if (filters.categoryId) q = q.eq("category_id", filters.categoryId);
  if (filters.currency) q = q.eq("currency", filters.currency);
  if (filters.search) {
    // Escape PostgREST/LIKE metacharacters; the value is passed as data, never as SQL.
    const term = filters.search.replace(/[%_\\,()*]/g, " ").trim().slice(0, 60);
    if (term) q = q.or(`description_original.ilike.*${term}*,merchant.ilike.*${term}*`);
  }
  const { data, error, count } = await q
    .order("booked_on", { ascending: false })
    .order("created_at", { ascending: false })
    .range(filters.offset, filters.offset + filters.limit - 1);
  if (error) throw error;
  return { rows: ((data ?? []) as RawRow[]).map(mapRow), total: count ?? 0 };
}
