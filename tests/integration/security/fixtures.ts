/**
 * Shared fixtures for the security integration suite.
 *
 * Everything here talks to the REAL local Supabase DEV stack. All data is fictional.
 * Rows are created through the given client: a user's own RLS-scoped client in most tests
 * (proving the owner can write them), or the service-role client when a test must not
 * consume an auth sign-in (GoTrue rate-limits sign-ins per IP).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { expect } from "vitest";
import { adminClient, type TestClient } from "../helpers";

/** Postgres SQLSTATE codes surfaced by PostgREST. */
export const PG = {
  /** insufficient_privilege: RLS WITH CHECK / USING violation or missing GRANT. */
  DENIED: "42501",
  FK: "23503",
  UNIQUE: "23505",
  CHECK: "23514",
  RAISE: "P0001",
} as const;

/**
 * Untyped view of a client: the suite iterates over many tables by name, which the
 * generated `Database` types cannot express. Payloads still go through PostgREST unchanged.
 */
export function loose(client: TestClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

export function rand(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

export function sha256Hex(): string {
  return randomBytes(32).toString("hex");
}

/** Unwraps a supabase-js response (PostgREST or Auth), failing loudly on error or empty data. */
export function must<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): NonNullable<T> {
  if (res.error) throw new Error(`${what}: ${res.error.code ?? ""} ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${what}: no data`);
  return res.data as NonNullable<T>;
}

/** Rejections that may come from RLS (42501) or, earlier, from an ownership trigger (23503). */
export const REJECTED_FOR_OWNERSHIP = [PG.DENIED, PG.FK] as const;

export function expectPgError(error: PostgrestError | null, code: string | readonly string[]): void {
  const codes = typeof code === "string" ? [code] : code;
  expect(error, `expected Postgres error ${codes.join("|")}`).not.toBeNull();
  expect(codes).toContain(error?.code);
}

let ethAssetId: string | undefined;
export async function ethereumNativeAssetId(): Promise<string> {
  if (ethAssetId) return ethAssetId;
  const row = must(
    await adminClient().from("crypto_assets").select("id").eq("network", "ethereum").is("contract_address", null).single(),
    "eth asset",
  );
  ethAssetId = row.id;
  return row.id;
}

export async function systemCategoryId(slug: string): Promise<string> {
  const row = must(await adminClient().from("categories").select("id").eq("slug", slug).is("user_id", null).single(), slug);
  return row.id;
}

/** A complete, fictional graph of every user-owned table for one user. */
export interface OwnedGraph {
  userId: string;
  personalEntityId: string;
  businessEntityId: string;
  institutionId: string;
  categoryId: string;
  ruleId: string;
  accountId: string;
  loanAccountId: string;
  documentId: string;
  importJobId: string;
  recurringId: string;
  txId: string;
  tx2Id: string;
  balanceId: string;
  walletAccountId: string;
  walletId: string;
  holdingId: string;
  chainTxId: string;
  inboxId: string;
  insightId: string;
  /** audit_log row written by the transaction trigger (category change on tx2). */
  auditId: number;
}

/**
 * Creates one row in every user-owned table. `client` is either the owner's own
 * RLS-scoped client or the admin client; user_id is always explicit so both work.
 */
export async function seedGraph(client: TestClient, userId: string, personalEntityId: string): Promise<OwnedGraph> {
  const db = loose(client);
  const tag = rand();
  const one = async (table: string, row: Record<string, unknown>, idColumn = "id"): Promise<string> => {
    const data = must(await db.from(table).insert(row).select(idColumn).single(), `seed ${table}`);
    return (data as unknown as Record<string, string>)[idColumn]!;
  };

  const businessEntityId = await one("financial_entities", { user_id: userId, name: "Fictional Studio Lda", kind: "business", country: "PT" });
  const institutionId = await one("institutions", { owner_id: userId, slug: `fictional-bank-${tag}`, name: "Fictional Credit Union", kind: "bank" });
  const categoryId = await one("categories", { user_id: userId, slug: `pets_${tag}`, kind: "expense", name: "Pets" });
  const ruleId = await one("categorization_rules", {
    user_id: userId,
    match_type: "contains",
    pattern: `FICTIONAL PET SHOP ${tag}`,
    category_id: categoryId,
    source: "user",
  });
  const accountId = await one("accounts", {
    user_id: userId,
    entity_id: personalEntityId,
    institution_id: institutionId,
    name: "Fictional Checking",
    type: "checking",
    currency: "EUR",
    account_mask: "0042",
  });
  const loanAccountId = await one("accounts", { user_id: userId, entity_id: personalEntityId, name: "Fictional Car Loan", type: "loan", currency: "EUR" });
  await one(
    "liability_details",
    { user_id: userId, account_id: loanAccountId, original_principal: "12000.00", interest_rate_apr: "4.2500", monthly_payment: "-250.00" },
    "account_id",
  );
  const documentId = await one("documents", {
    user_id: userId,
    storage_path: `${userId}/fictional-statement-${tag}.csv`,
    original_filename: "fictional-statement.csv",
    mime_type: "text/csv",
    size_bytes: 512,
    sha256: sha256Hex(),
    detected_format: "csv",
  });
  const importJobId = await one("import_jobs", { user_id: userId, document_id: documentId, status: "completed", progress: 100 });
  const recurringId = await one("recurring_series", {
    user_id: userId,
    account_id: accountId,
    merchant: "Fictional Streaming",
    cadence: "monthly",
    average_amount: "-9.99",
    last_amount: "-9.99",
    currency: "EUR",
    first_seen_on: "2026-01-05",
    last_seen_on: "2026-03-05",
    occurrences: 3,
    fingerprint: `rec-${tag}`,
  });
  const txId = await one("transactions", {
    user_id: userId,
    account_id: accountId,
    booked_on: "2026-03-05",
    description_original: "FICTIONAL STREAMING CO",
    amount: "-9.99",
    currency: "EUR",
    fingerprint: `fp-${tag}-0001`,
    source: "import",
    document_id: documentId,
    import_job_id: importJobId,
    recurring_series_id: recurringId,
    category_id: categoryId,
    category_source: "user",
  });
  const tx2Id = await one("transactions", {
    user_id: userId,
    account_id: accountId,
    booked_on: "2026-03-28",
    description_original: "FICTIONAL EMPLOYER PAYROLL",
    amount: "2150.00",
    currency: "EUR",
    fingerprint: `fp-${tag}-0002`,
    source: "manual",
  });
  const balanceId = await one("account_balances", {
    user_id: userId,
    account_id: accountId,
    as_of: "2026-03-31",
    balance: "3140.01",
    currency: "EUR",
    source: "import",
    document_id: documentId,
  });
  const walletAccountId = await one("accounts", { user_id: userId, entity_id: personalEntityId, name: "Fictional Watch Wallet", type: "crypto_wallet", currency: "ETH" });
  const walletId = await one("crypto_wallets", {
    user_id: userId,
    account_id: walletAccountId,
    family: "evm",
    networks: ["ethereum"],
    watch_kind: "address",
    public_identifier: `0x${randomBytes(20).toString("hex")}`,
    label: "Fictional cold wallet",
  });
  const assetId = await ethereumNativeAssetId();
  const holdingId = await one("wallet_holdings", { user_id: userId, wallet_id: walletId, asset_id: assetId, as_of: "2026-03-31", quantity: "1.5" });
  const chainTxId = await one("blockchain_transactions", {
    user_id: userId,
    wallet_id: walletId,
    asset_id: assetId,
    network: "ethereum",
    tx_hash: `0x${randomBytes(32).toString("hex")}`,
    block_time: "2026-03-15T10:00:00Z",
    direction: "in",
    quantity: "0.5",
  });
  const inboxId = await one("inbox_items", {
    user_id: userId,
    kind: "uncategorized",
    dedupe_key: `uncategorized-${tag}`,
    transaction_ids: [tx2Id],
    account_id: accountId,
    document_id: documentId,
    recurring_series_id: recurringId,
  });
  const insightId = await one("insights", { user_id: userId, kind: "spending_spike", fingerprint: `insight-${tag}`, params: { pct: "12" } });

  // Category change → audit trigger writes an audit_log row for this user.
  must(await db.from("transactions").update({ category_id: await systemCategoryId("salary") }).eq("id", tx2Id).select("id").single(), "categorise tx2");
  const audit = must(
    await adminClient().from("audit_log").select("id").eq("user_id", userId).eq("target_id", tx2Id).order("id", { ascending: false }).limit(1).single(),
    "audit row",
  );

  return {
    userId,
    personalEntityId,
    businessEntityId,
    institutionId,
    categoryId,
    ruleId,
    accountId,
    loanAccountId,
    documentId,
    importJobId,
    recurringId,
    txId,
    tx2Id,
    balanceId,
    walletAccountId,
    walletId,
    holdingId,
    chainTxId,
    inboxId,
    insightId,
    auditId: audit.id,
  };
}

/** Every relation in `public` that holds per-user data, with the column naming its owner. */
export const USER_TABLES = [
  { table: "profiles", owner: "id" },
  { table: "financial_entities", owner: "user_id" },
  { table: "accounts", owner: "user_id" },
  { table: "liability_details", owner: "user_id" },
  { table: "documents", owner: "user_id" },
  { table: "import_jobs", owner: "user_id" },
  { table: "recurring_series", owner: "user_id" },
  { table: "transactions", owner: "user_id" },
  { table: "account_balances", owner: "user_id" },
  { table: "crypto_wallets", owner: "user_id" },
  { table: "wallet_holdings", owner: "user_id" },
  { table: "blockchain_transactions", owner: "user_id" },
  { table: "inbox_items", owner: "user_id" },
  { table: "insights", owner: "user_id" },
  { table: "categorization_rules", owner: "user_id" },
  { table: "categories", owner: "user_id" },
  { table: "institutions", owner: "owner_id" },
  { table: "audit_log", owner: "user_id" },
] as const;

/** Row counts per user-owned table for one user, read with the service role. */
export async function countOwnedRows(userId: string): Promise<Record<string, number>> {
  const db = loose(adminClient());
  const out: Record<string, number> = {};
  for (const { table, owner } of USER_TABLES) {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).eq(owner, userId);
    if (error) throw new Error(`count ${table}: ${error.message}`);
    out[table] = count ?? 0;
  }
  return out;
}

/** Service-role snapshot of a single row (used to prove "data unchanged"). */
export async function adminRow(table: string, idColumn: string, id: string | number): Promise<Record<string, unknown> | null> {
  const { data, error } = await loose(adminClient()).from(table).select("*").eq(idColumn, id).maybeSingle();
  if (error) throw new Error(`adminRow ${table}: ${error.message}`);
  return data as Record<string, unknown> | null;
}

/**
 * Creates a confirmed user with the service role WITHOUT signing in (sign-ins are
 * rate-limited per IP by GoTrue). Caller must delete it.
 */
export async function createBareUser(label: string, metadata: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient().auth.admin.createUser({
    email: `${label}-${rand()}@test.monio.dev`,
    password: `Test-${randomUUID()}`,
    email_confirm: true,
    user_metadata: metadata,
  });
  if (error || !data.user) throw error ?? new Error("createUser failed");
  return data.user.id;
}

/** Fictional helper: an obviously fake EVM address. */
export function fakeEvmAddress(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

export function uuid(): string {
  return randomUUID();
}
