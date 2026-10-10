/**
 * Row isolation between tenants, against the real local Supabase stack.
 *
 * User A builds a full graph (one row in every user-owned table) through A's OWN client.
 * User B (own client) then tries to read, update, delete, forge and reference A's rows.
 * Every "unchanged" claim is verified with the service role, not with B's (blind) view.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, anonClient, createTestUser, type TestUser } from "../helpers";
import {
  PG,
  USER_TABLES,
  adminRow,
  countOwnedRows,
  createBareUser,
  ethereumNativeAssetId,
  expectPgError,
  fakeEvmAddress,
  loose,
  rand,
  seedGraph,
  sha256Hex,
  type OwnedGraph,
} from "./fixtures";

let A: TestUser;
let B: TestUser;
let a: OwnedGraph;
let b: OwnedGraph;
let assetId: string;

beforeAll(async () => {
  A = await createTestUser("sec-iso-a");
  B = await createTestUser("sec-iso-b");
  a = await seedGraph(A.client, A.id, A.personalEntityId);
  b = await seedGraph(B.client, B.id, B.personalEntityId);
  assetId = await ethereumNativeAssetId();
});

afterAll(async () => {
  await A?.cleanup();
  await B?.cleanup();
});

const txRow = (userId: string, accountId: string, extra: Record<string, unknown> = {}) => ({
  user_id: userId,
  account_id: accountId,
  booked_on: "2026-04-01",
  description_original: "FICTIONAL INJECTED ROW",
  amount: "-1.00",
  currency: "EUR",
  fingerprint: `fp-inject-${rand()}`,
  source: "manual",
  ...extra,
});

interface Spec {
  table: string;
  idColumn: string;
  victimId: (g: OwnedGraph) => string | number;
  update: Record<string, unknown>;
  /** Row B inserts while claiming A as owner (references point at A's rows, so only RLS can stop it). */
  forge: (a: OwnedGraph) => Record<string, unknown>;
  /** Rows B inserts under its OWN user_id that reference A's rows: composite FKs must reject them. */
  crossRefs?: (a: OwnedGraph, b: OwnedGraph) => Record<string, Record<string, unknown>>;
}

const SPECS: Spec[] = [
  {
    table: "profiles",
    idColumn: "id",
    victimId: (g) => g.userId,
    update: { display_name: "Hijacked", ai_cloud_consent: true },
    forge: (g) => ({ id: g.userId, display_name: "Forged" }),
  },
  {
    table: "financial_entities",
    idColumn: "id",
    victimId: (g) => g.businessEntityId,
    update: { name: "Hijacked" },
    forge: (g) => ({ user_id: g.userId, name: "Forged entity", kind: "business" }),
  },
  {
    table: "accounts",
    idColumn: "id",
    victimId: (g) => g.accountId,
    update: { name: "Hijacked", include_in_net_worth: false },
    forge: (g) => ({ user_id: g.userId, entity_id: g.personalEntityId, name: "Forged", type: "checking", currency: "EUR" }),
    crossRefs: (g, own) => ({
      entity_id: { user_id: own.userId, entity_id: g.personalEntityId, name: "Cross", type: "checking", currency: "EUR" },
    }),
  },
  {
    table: "liability_details",
    idColumn: "account_id",
    victimId: (g) => g.loanAccountId,
    update: { monthly_payment: "-1.00", interest_rate_apr: "0.0000" },
    forge: (g) => ({ user_id: g.userId, account_id: g.accountId, original_principal: "1.00" }),
    crossRefs: (g, own) => ({ account_id: { user_id: own.userId, account_id: g.accountId, original_principal: "1.00" } }),
  },
  {
    table: "documents",
    idColumn: "id",
    victimId: (g) => g.documentId,
    update: { status: "failed", storage_path: "attacker/elsewhere.csv" },
    forge: (g) => ({
      user_id: g.userId,
      storage_path: `${g.userId}/forged.csv`,
      original_filename: "forged.csv",
      mime_type: "text/csv",
      size_bytes: 10,
      sha256: sha256Hex(),
    }),
  },
  {
    table: "import_jobs",
    idColumn: "id",
    victimId: (g) => g.importJobId,
    update: { status: "failed", error_message: "hijacked" },
    forge: (g) => ({ user_id: g.userId, document_id: g.documentId }),
    crossRefs: (g, own) => ({ document_id: { user_id: own.userId, document_id: g.documentId } }),
  },
  {
    table: "recurring_series",
    idColumn: "id",
    victimId: (g) => g.recurringId,
    update: { status: "dismissed", is_subscription: true },
    forge: (g) => ({
      user_id: g.userId,
      account_id: g.accountId,
      merchant: "Forged",
      cadence: "monthly",
      average_amount: "-1.00",
      last_amount: "-1.00",
      currency: "EUR",
      first_seen_on: "2026-01-01",
      last_seen_on: "2026-02-01",
      occurrences: 2,
      fingerprint: `forged-${rand()}`,
    }),
    crossRefs: (g, own) => ({
      account_id: {
        user_id: own.userId,
        account_id: g.accountId,
        merchant: "Cross",
        cadence: "monthly",
        average_amount: "-1.00",
        last_amount: "-1.00",
        currency: "EUR",
        first_seen_on: "2026-01-01",
        last_seen_on: "2026-02-01",
        occurrences: 2,
        fingerprint: `cross-${rand()}`,
      },
    }),
  },
  {
    table: "transactions",
    idColumn: "id",
    victimId: (g) => g.txId,
    update: { notes: "hijacked", amount: "-999999.00", category_id: null },
    forge: (g) => txRow(g.userId, g.accountId),
    crossRefs: (g, own) => ({
      account_id: txRow(own.userId, g.accountId),
      document_id: txRow(own.userId, own.accountId, { document_id: g.documentId }),
      import_job_id: txRow(own.userId, own.accountId, { import_job_id: g.importJobId }),
      recurring_series_id: txRow(own.userId, own.accountId, { recurring_series_id: g.recurringId }),
      counterpart_transaction_id: txRow(own.userId, own.accountId, { counterpart_transaction_id: g.txId }),
      duplicate_of: txRow(own.userId, own.accountId, { duplicate_of: g.txId }),
    }),
  },
  {
    table: "account_balances",
    idColumn: "id",
    victimId: (g) => g.balanceId,
    update: { balance: "0.01" },
    forge: (g) => ({ user_id: g.userId, account_id: g.accountId, as_of: "2026-04-30", balance: "1.00", currency: "EUR", source: "manual" }),
    crossRefs: (g, own) => ({
      account_id: { user_id: own.userId, account_id: g.accountId, as_of: "2026-04-30", balance: "1.00", currency: "EUR", source: "manual" },
      document_id: {
        user_id: own.userId,
        account_id: own.accountId,
        as_of: "2026-05-31",
        balance: "1.00",
        currency: "EUR",
        source: "manual",
        document_id: g.documentId,
      },
    }),
  },
  {
    table: "crypto_wallets",
    idColumn: "id",
    victimId: (g) => g.walletId,
    update: { label: "hijacked", sync_status: "error" },
    forge: (g) => ({ user_id: g.userId, account_id: g.walletAccountId, family: "evm", watch_kind: "address", public_identifier: fakeEvmAddress() }),
    crossRefs: (g, own) => ({
      account_id: { user_id: own.userId, account_id: g.walletAccountId, family: "evm", watch_kind: "address", public_identifier: fakeEvmAddress() },
    }),
  },
  {
    table: "wallet_holdings",
    idColumn: "id",
    victimId: (g) => g.holdingId,
    update: { quantity: "0" },
    forge: (g) => ({ user_id: g.userId, wallet_id: g.walletId, asset_id: assetId, as_of: "2026-04-30", quantity: "9" }),
    crossRefs: (g, own) => ({ wallet_id: { user_id: own.userId, wallet_id: g.walletId, asset_id: assetId, as_of: "2026-04-30", quantity: "9" } }),
  },
  {
    table: "blockchain_transactions",
    idColumn: "id",
    victimId: (g) => g.chainTxId,
    update: { classification: "internal", quantity: "0" },
    forge: (g) => ({
      user_id: g.userId,
      wallet_id: g.walletId,
      asset_id: assetId,
      network: "ethereum",
      tx_hash: `0x${sha256Hex()}`,
      block_time: "2026-04-01T00:00:00Z",
      direction: "out",
      quantity: "1",
    }),
    crossRefs: (g, own) => ({
      wallet_id: {
        user_id: own.userId,
        wallet_id: g.walletId,
        asset_id: assetId,
        network: "ethereum",
        tx_hash: `0x${sha256Hex()}`,
        block_time: "2026-04-01T00:00:00Z",
        direction: "out",
        quantity: "1",
      },
    }),
  },
  {
    table: "inbox_items",
    idColumn: "id",
    victimId: (g) => g.inboxId,
    update: { status: "dismissed", resolution: { by: "attacker" } },
    forge: (g) => ({ user_id: g.userId, kind: "stale_source", dedupe_key: `forged-${rand()}` }),
    crossRefs: (g, own) => ({
      account_id: { user_id: own.userId, kind: "stale_source", dedupe_key: `cross-a-${rand()}`, account_id: g.accountId },
      document_id: { user_id: own.userId, kind: "document_incomplete", dedupe_key: `cross-d-${rand()}`, document_id: g.documentId },
      recurring_series_id: { user_id: own.userId, kind: "subscription_candidate", dedupe_key: `cross-r-${rand()}`, recurring_series_id: g.recurringId },
    }),
  },
  {
    table: "insights",
    idColumn: "id",
    victimId: (g) => g.insightId,
    update: { dismissed_at: "2026-04-01T00:00:00Z" },
    forge: (g) => ({ user_id: g.userId, kind: "forged", fingerprint: `forged-${rand()}` }),
  },
  {
    table: "categorization_rules",
    idColumn: "id",
    victimId: (g) => g.ruleId,
    update: { pattern: "HIJACKED PATTERN", priority: 1 },
    forge: (g) => ({ user_id: g.userId, match_type: "contains", pattern: `FORGED ${rand()}`, category_id: g.categoryId, source: "user" }),
  },
  {
    table: "categories",
    idColumn: "id",
    victimId: (g) => g.categoryId,
    update: { name: "Hijacked", hue: 1 },
    forge: (g) => ({ user_id: g.userId, slug: `forged_${rand()}`, kind: "expense" }),
  },
  {
    table: "institutions",
    idColumn: "id",
    victimId: (g) => g.institutionId,
    update: { name: "Hijacked", aliases: ["evil"] },
    forge: (g) => ({ owner_id: g.userId, slug: `forged-${rand()}`, name: "Forged" }),
  },
  {
    table: "audit_log",
    idColumn: "id",
    victimId: (g) => g.auditId,
    update: { action: "tampered", details: {} },
    forge: (g) => ({ user_id: g.userId, actor: "system", action: "forged.entry" }),
  },
];

describe("bootstrap", () => {
  it("a new user gets exactly one profile and one personal entity", async () => {
    const counts = await countOwnedRows(A.id);
    expect(counts.profiles).toBe(1);
    const { count } = await adminClient()
      .from("financial_entities")
      .select("*", { count: "exact", head: true })
      .eq("user_id", A.id)
      .eq("kind", "personal");
    expect(count).toBe(1);
  });

  it("a user sees only its own profile", async () => {
    const { data, error } = await B.client.from("profiles").select("id, locale, primary_currency");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: B.id, locale: "pt", primary_currency: "EUR" }]);
  });

  it("a user cannot read another profile even when filtering by its id", async () => {
    const { data, error } = await B.client.from("profiles").select("*").eq("id", A.id);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("signup metadata is sanitised by the bootstrap trigger", async () => {
    const admin = adminClient();
    const userId = await createBareUser("sec-boot", { display_name: "X".repeat(200), locale: "fr", primary_currency: "XYZ" });
    try {
      const profile = await adminRow("profiles", "id", userId);
      expect(profile).toMatchObject({ locale: "pt", primary_currency: "EUR" });
      expect(String(profile?.display_name)).toHaveLength(80);
      const { count } = await admin.from("financial_entities").select("*", { count: "exact", head: true }).eq("user_id", userId);
      expect(count).toBe(1);
    } finally {
      await admin.auth.admin.deleteUser(userId);
    }
  });
});

describe("row isolation: user B against user A's rows", () => {
  it("A can read every row of its own graph through its own client", async () => {
    const db = loose(A.client);
    for (const spec of SPECS) {
      const { data, error } = await db.from(spec.table).select(spec.idColumn).eq(spec.idColumn, spec.victimId(a));
      expect(error, spec.table).toBeNull();
      expect(data, spec.table).toHaveLength(1);
    }
  });

  describe.each(SPECS.map((s) => [s.table, s] as const))("%s", (_name, spec) => {
    it("B cannot select A's row (by id or by listing)", async () => {
      const db = loose(B.client);
      const byId = await db.from(spec.table).select("*").eq(spec.idColumn, spec.victimId(a));
      expect(byId.error).toBeNull();
      expect(byId.data).toEqual([]);
      const all = await db.from(spec.table).select(spec.idColumn).limit(10_000);
      expect(all.error).toBeNull();
      const ids = (all.data as unknown as Record<string, unknown>[]).map((r) => r[spec.idColumn]);
      expect(ids).not.toContain(spec.victimId(a));
    });

    it("B cannot update A's row (0 rows, data unchanged)", async () => {
      const before = await adminRow(spec.table, spec.idColumn, spec.victimId(a));
      const { data, error } = await loose(B.client).from(spec.table).update(spec.update).eq(spec.idColumn, spec.victimId(a)).select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
      expect(await adminRow(spec.table, spec.idColumn, spec.victimId(a))).toEqual(before);
    });

    it("B cannot delete A's row (0 rows, row still there)", async () => {
      const before = await adminRow(spec.table, spec.idColumn, spec.victimId(a));
      expect(before).not.toBeNull();
      const { data, error } = await loose(B.client).from(spec.table).delete().eq(spec.idColumn, spec.victimId(a)).select();
      expect(error).toBeNull();
      expect(data).toEqual([]);
      expect(await adminRow(spec.table, spec.idColumn, spec.victimId(a))).toEqual(before);
    });

    it("B cannot insert a row owned by A (RLS rejects)", async () => {
      const before = await countOwnedRows(A.id);
      const { error } = await loose(B.client).from(spec.table).insert(spec.forge(a)).select();
      expectPgError(error, PG.DENIED);
      expect(await countOwnedRows(A.id)).toEqual(before);
    });

    if (spec.crossRefs) {
      it("B cannot insert its own rows that reference A's rows (composite FK rejects)", async () => {
        const attempts = spec.crossRefs!(a, b);
        for (const [column, row] of Object.entries(attempts)) {
          const { error } = await loose(B.client).from(spec.table).insert(row).select();
          expect(error?.code, `${spec.table}.${column}`).toBe(PG.FK);
        }
      });
    }
  });

  it("B cannot re-parent its own rows onto A's rows via UPDATE (composite FK rejects)", async () => {
    const db = loose(B.client);
    const attempts: [string, string, Record<string, unknown>][] = [
      ["transactions", b.txId, { account_id: a.accountId }],
      ["transactions", b.tx2Id, { duplicate_of: a.txId }],
      ["accounts", b.accountId, { entity_id: a.businessEntityId }],
      ["crypto_wallets", b.walletId, { account_id: a.walletAccountId }],
      ["import_jobs", b.importJobId, { document_id: a.documentId }],
      ["inbox_items", b.inboxId, { recurring_series_id: a.recurringId }],
    ];
    for (const [table, id, patch] of attempts) {
      const { error } = await db.from(table).update(patch).eq("id", id).select();
      expect(error?.code, `${table} ${Object.keys(patch).join()}`).toBe(PG.FK);
    }
  });

  it("B cannot hand its own rows over to A by rewriting the owner column", async () => {
    const db = loose(B.client);
    const attempts: [string, string, string, string][] = [
      ["accounts", "id", b.accountId, "user_id"],
      ["transactions", "id", b.txId, "user_id"],
      ["documents", "id", b.documentId, "user_id"],
      ["categories", "id", b.categoryId, "user_id"],
      ["categorization_rules", "id", b.ruleId, "user_id"],
      ["institutions", "id", b.institutionId, "owner_id"],
      ["profiles", "id", B.id, "id"],
    ];
    for (const [table, idColumn, id, owner] of attempts) {
      const { error } = await db.from(table).update({ [owner]: A.id }).eq(idColumn, id).select();
      // RLS WITH CHECK, or the ownership trigger when the row references B's private institution/category.
      expect([PG.DENIED, PG.FK], table).toContain(error?.code);
    }
    expect((await countOwnedRows(B.id)).accounts).toBe(3);
  });

  it("B cannot hijack A's rows through upsert on A's primary key", async () => {
    const before = await adminRow("accounts", "id", a.accountId);
    const { error } = await loose(B.client)
      .from("accounts")
      .upsert({ id: a.accountId, user_id: B.id, entity_id: B.personalEntityId, name: "Hijacked", type: "checking", currency: "EUR" }, { onConflict: "id" })
      .select();
    expectPgError(error, PG.DENIED);
    expect(await adminRow("accounts", "id", a.accountId)).toEqual(before);

    const txBefore = await adminRow("transactions", "id", a.txId);
    const res = await loose(B.client)
      .from("transactions")
      .upsert({ ...txRow(B.id, b.accountId), id: a.txId, amount: "-0.01" }, { onConflict: "id" })
      .select();
    expectPgError(res.error, PG.DENIED);
    expect(await adminRow("transactions", "id", a.txId)).toEqual(txBefore);
  });

  it("security_invoker views expose only the caller's rows", async () => {
    const balances = await B.client.from("account_latest_balances").select("account_id, user_id");
    expect(balances.error).toBeNull();
    expect(balances.data?.every((r) => r.user_id === B.id)).toBe(true);
    expect(balances.data?.map((r) => r.account_id)).toContain(b.accountId);
    expect(balances.data?.map((r) => r.account_id)).not.toContain(a.accountId);

    const holdings = await B.client.from("wallet_latest_holdings").select("wallet_id, user_id");
    expect(holdings.error).toBeNull();
    expect(holdings.data?.map((r) => r.wallet_id)).toEqual([b.walletId]);
  });

  it("embedded resources never leak A's children into B's results", async () => {
    const { data, error } = await B.client
      .from("accounts")
      .select("id, user_id, transactions(id, user_id), account_balances(id, user_id), crypto_wallets(id, user_id, wallet_holdings(id, user_id))");
    expect(error).toBeNull();
    const json = JSON.stringify(data);
    expect(json).not.toContain(A.id);
    expect(json).toContain(b.txId);
  });
});

describe("anonymous visitors (publishable key, no session)", () => {
  const RELATIONS = [
    ...USER_TABLES.map((t) => t.table),
    "account_latest_balances",
    "wallet_latest_holdings",
    // Reference data: no anon policy and no anon GRANT either.
    "currencies",
    "crypto_assets",
    "exchange_rates",
  ];

  it.each(RELATIONS)("anon cannot read %s (permission denied)", async (table) => {
    const { data, error } = await loose(anonClient()).from(table).select("*").limit(1);
    expectPgError(error, PG.DENIED);
    expect(data).toBeNull();
  });

  it("anon cannot insert, update or delete user data", async () => {
    const anon = loose(anonClient());
    const ins = await anon.from("transactions").insert(txRow(A.id, a.accountId));
    expectPgError(ins.error, PG.DENIED);
    const upd = await anon.from("accounts").update({ name: "anon" }).eq("id", a.accountId);
    expectPgError(upd.error, PG.DENIED);
    const del = await anon.from("transactions").delete().eq("id", a.txId);
    expectPgError(del.error, PG.DENIED);
    expect(await adminRow("transactions", "id", a.txId)).not.toBeNull();
    expect((await adminRow("accounts", "id", a.accountId))?.name).toBe("Fictional Checking");
  });

  it("anon sees no row of any user even with a forged user_id filter", async () => {
    const res = await loose(anonClient()).from("accounts").select("id").eq("user_id", A.id);
    expectPgError(res.error, PG.DENIED);
  });
});

describe("Finding F2: plain (non-composite) FKs let B reference A's private categories/institutions", () => {
  // Expected (CLAUDE.md invariant): a row can never point at another user's row.
  // Actual: transactions/recurring_series/categorization_rules.category_id and
  // accounts.institution_id / documents.detected_institution_id are plain FKs, so B can
  // attach A's private category/institution. When A later deletes it, ON DELETE CASCADE /
  // SET NULL silently deletes B's rules and rewrites B's transactions (plus writes an audit
  // entry into B's log, attributed to actor 'user'). The FK error also acts as an
  // existence oracle for any UUID. Remove `.fails` once fixed.
  it("B cannot attach A's private category to its own rule, transaction or series", async () => {
    const db = loose(B.client);
    const rule = await db
      .from("categorization_rules")
      .insert({ user_id: B.id, match_type: "contains", pattern: `CROSS ${rand()}`, category_id: a.categoryId, source: "user" })
      .select();
    const tx = await db.from("transactions").update({ category_id: a.categoryId }).eq("id", b.tx2Id).select();
    const series = await db.from("recurring_series").update({ category_id: a.categoryId }).eq("id", b.recurringId).select();
    expect(rule.error, "categorization_rules.category_id").not.toBeNull();
    expect(tx.error, "transactions.category_id").not.toBeNull();
    expect(series.error, "recurring_series.category_id").not.toBeNull();
  });

  it("B cannot attach A's private institution to its own account or document", async () => {
    const db = loose(B.client);
    const acct = await db.from("accounts").update({ institution_id: a.institutionId }).eq("id", b.accountId).select();
    const doc = await db.from("documents").update({ detected_institution_id: a.institutionId }).eq("id", b.documentId).select();
    expect(acct.error, "accounts.institution_id").not.toBeNull();
    expect(doc.error, "documents.detected_institution_id").not.toBeNull();
  });
});

describe("Finding F6: documents.storage_path is not bound to the owner's storage folder", () => {
  // Expected: a document row can only point at `<own uid>/...` in the `documents` bucket.
  // Actual: storage_path is free text, so B can register a document whose path is inside A's
  // folder, or one that *starts* with B's folder and climbs out with `..`. supabase-js / the
  // WHATWG URL parser resolve `B/../A/x` (and `%2e%2e`) to `A/x`, so a service-role download
  // guarded only by `storage_path.startsWith(userId + "/")` fetches A's object; the import
  // worker's sha256 re-check is then the only remaining barrier. Remove `.fails` once a CHECK
  // binds the path to user_id and forbids dot segments.
  it("B cannot create or retarget a document row onto a path inside A's folder", async () => {
    const db = loose(B.client);
    const inserted = await db
      .from("documents")
      .insert({
        user_id: B.id,
        storage_path: `${A.id}/fictional-statement.csv`,
        original_filename: "statement.csv",
        mime_type: "text/csv",
        size_bytes: 512,
        sha256: sha256Hex(),
      })
      .select();
    const retargeted = await db.from("documents").update({ storage_path: `${A.id}/fictional-statement.csv` }).eq("id", b.documentId).select();
    const traversal = await db
      .from("documents")
      .update({ storage_path: `${B.id}/../${A.id}/${a.documentId}/fictional-statement.csv` })
      .eq("id", b.documentId)
      .select();
    expect(inserted.error, "insert").not.toBeNull();
    expect(retargeted.error, "update").not.toBeNull();
    expect(traversal.error, "dot-dot traversal").not.toBeNull();
  });
});
