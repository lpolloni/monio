import "server-only";
import type { Json } from "../supabase/database.types";
import { requireSession } from "./session";

export type InboxKind =
  | "transfer_match"
  | "possible_duplicate"
  | "unknown_institution"
  | "uncategorized"
  | "subscription_candidate"
  | "stale_source"
  | "document_incomplete"
  | "account_confirmation";

export interface InboxItemView {
  id: string;
  kind: InboxKind;
  status: "open" | "resolved" | "dismissed";
  priority: number;
  payload: Record<string, Json | undefined>;
  transactionIds: string[];
  accountId: string | null;
  documentId: string | null;
  recurringSeriesId: string | null;
  createdAt: string;
}

const SELECT = "id, kind, status, priority, payload, transaction_ids, account_id, document_id, recurring_series_id, created_at";

type Row = {
  id: string;
  kind: string;
  status: string;
  priority: number;
  payload: Json;
  transaction_ids: string[];
  account_id: string | null;
  document_id: string | null;
  recurring_series_id: string | null;
  created_at: string;
};

function map(r: Row): InboxItemView {
  return {
    id: r.id,
    kind: r.kind as InboxKind,
    status: r.status as InboxItemView["status"],
    priority: r.priority,
    payload: (r.payload && typeof r.payload === "object" && !Array.isArray(r.payload) ? r.payload : {}) as Record<string, Json | undefined>,
    transactionIds: r.transaction_ids,
    accountId: r.account_id,
    documentId: r.document_id,
    recurringSeriesId: r.recurring_series_id,
    createdAt: r.created_at,
  };
}

export async function getInboxPreview(limit: number): Promise<{ items: InboxItemView[]; total: number }> {
  const { supabase } = await requireSession();
  const { data, error, count } = await supabase
    .from("inbox_items")
    .select(SELECT, { count: "exact" })
    .eq("status", "open")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return { items: ((data ?? []) as Row[]).map(map), total: count ?? 0 };
}

export async function getOpenInbox(): Promise<InboxItemView[]> {
  const { supabase } = await requireSession();
  const { data, error } = await supabase
    .from("inbox_items")
    .select(SELECT)
    .eq("status", "open")
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as Row[]).map(map);
}
