/**
 * Removal of an account or of an imported document, with everything that
 * belongs to it. Runs with the user's own client: RLS scopes every statement,
 * and each one is also filtered by `user_id`.
 *
 * The steps are not one database transaction. They are ordered so that a
 * failure midway leaves the parent row in place and the removal can simply be
 * run again.
 */
import "server-only";
import { DOCUMENTS_BUCKET } from "../import/intake";
import type { MonioClient } from "../supabase/server";

const PAGE = 1000;
const MAX_ROWS = 100_000;
const CHUNK = 200;

export class RemovalBlockedError extends Error {
  constructor(readonly reason: "not_found" | "busy") {
    super(reason);
    this.name = "RemovalBlockedError";
  }
}

export interface RemovalStats {
  transactions: number;
  documents: number;
  accounts: number;
}

/** Ids and source documents of the transactions matching one column. */
async function transactionRefs(db: MonioClient, userId: string, column: "account_id" | "document_id", value: string) {
  const out: { id: string; account_id: string; document_id: string | null }[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const { data, error } = await db
      .from("transactions")
      .select("id, account_id, document_id")
      .eq("user_id", userId)
      .eq(column, value)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

/** Smart Inbox questions about transactions that no longer exist. */
async function dropInboxItemsAbout(db: MonioClient, userId: string, transactionIds: string[]): Promise<void> {
  for (let i = 0; i < transactionIds.length; i += CHUNK) {
    const { error } = await db.from("inbox_items").delete().eq("user_id", userId).overlaps("transaction_ids", transactionIds.slice(i, i + CHUNK));
    if (error) throw error;
  }
}

async function hasRows(db: MonioClient, userId: string, table: "transactions" | "account_balances", column: "account_id" | "document_id", value: string): Promise<boolean> {
  const { count, error } = await db.from(table).select("id", { count: "exact", head: true }).eq("user_id", userId).eq(column, value);
  if (error) throw error;
  return (count ?? 0) > 0;
}

/** Deletes the stored original and the document row (import jobs and its inbox items cascade). */
async function dropDocument(db: MonioClient, userId: string, documentId: string): Promise<boolean> {
  const { data: doc, error } = await db.from("documents").select("id, storage_path").eq("id", documentId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!doc) return false;
  // A missing object is fine; one that could not be removed is left to the orphan purge.
  if (doc.storage_path) await db.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path]);
  const { error: deleteError } = await db.from("documents").delete().eq("id", documentId).eq("user_id", userId);
  if (deleteError) throw deleteError;
  return true;
}

/**
 * Deletes an account with its transactions, balances, recurring series, loan
 * details, wallet and inbox items (database cascades). Documents that only fed
 * this account are deleted too, so the same file can be imported again;
 * documents that also fed other accounts are kept.
 */
export async function removeAccount(db: MonioClient, userId: string, accountId: string): Promise<RemovalStats> {
  const { data: account, error } = await db.from("accounts").select("id").eq("id", accountId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!account) throw new RemovalBlockedError("not_found");

  const refs = await transactionRefs(db, userId, "account_id", accountId);
  const { data: balances, error: balanceError } = await db.from("account_balances").select("document_id").eq("user_id", userId).eq("account_id", accountId).not("document_id", "is", null).limit(5000);
  if (balanceError) throw balanceError;
  const documentIds = [...new Set([...refs.map((r) => r.document_id), ...(balances ?? []).map((b) => b.document_id)].filter((d): d is string => !!d))];

  await dropInboxItemsAbout(db, userId, refs.map((r) => r.id));
  const { error: deleteError } = await db.from("accounts").delete().eq("id", accountId).eq("user_id", userId);
  if (deleteError) throw deleteError;

  let documents = 0;
  for (const documentId of documentIds) {
    if ((await hasRows(db, userId, "transactions", "document_id", documentId)) || (await hasRows(db, userId, "account_balances", "document_id", documentId))) continue;
    if (await dropDocument(db, userId, documentId)) documents++;
  }
  return { transactions: refs.length, documents, accounts: 1 };
}

/**
 * Deletes an imported document with the transactions and balances it brought
 * in, its import jobs, inbox items and stored original. Accounts created by
 * imports that are left without any transaction or balance are deleted as well.
 * Refused while an import of the document is still running.
 */
export async function removeDocument(db: MonioClient, userId: string, documentId: string): Promise<RemovalStats> {
  const { data: doc, error } = await db.from("documents").select("id").eq("id", documentId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  if (!doc) throw new RemovalBlockedError("not_found");
  const { data: running, error: jobError } = await db.from("import_jobs").select("id").eq("user_id", userId).eq("document_id", documentId).in("status", ["queued", "processing"]).limit(1);
  if (jobError) throw jobError;
  if (running?.length) throw new RemovalBlockedError("busy");

  const refs = await transactionRefs(db, userId, "document_id", documentId);
  const { data: balances, error: balanceError } = await db.from("account_balances").select("account_id").eq("user_id", userId).eq("document_id", documentId).limit(5000);
  if (balanceError) throw balanceError;
  const accountIds = [...new Set([...refs.map((r) => r.account_id), ...(balances ?? []).map((b) => b.account_id)])];

  await dropInboxItemsAbout(db, userId, refs.map((r) => r.id));
  const { error: txError } = await db.from("transactions").delete().eq("user_id", userId).eq("document_id", documentId);
  if (txError) throw txError;
  const { error: balError } = await db.from("account_balances").delete().eq("user_id", userId).eq("document_id", documentId);
  if (balError) throw balError;

  let accounts = 0;
  for (const accountId of accountIds) {
    if ((await hasRows(db, userId, "transactions", "account_id", accountId)) || (await hasRows(db, userId, "account_balances", "account_id", accountId))) continue;
    const { data: removed, error: accountError } = await db.from("accounts").delete().eq("id", accountId).eq("user_id", userId).eq("sync_source", "import").select("id");
    if (accountError) throw accountError;
    accounts += removed?.length ?? 0;
  }
  await dropDocument(db, userId, documentId);
  return { transactions: refs.length, documents: 1, accounts };
}
