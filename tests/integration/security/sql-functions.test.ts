/**
 * RPC surface: apply_transaction_updates, log_user_action, record_rule_hits,
 * delete_my_financial_data. Each must act only on the caller's rows and be closed to anon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Json } from "@/server/supabase/database.types";
import { adminClient, anonClient, createTestUser, type TestUser } from "../helpers";
import { PG, adminRow, countOwnedRows, expectPgError, loose, must, rand, seedGraph, systemCategoryId, uuid, type OwnedGraph } from "./fixtures";

let A: TestUser;
let B: TestUser;
let a: OwnedGraph;
let b: OwnedGraph;
let systemRule: { id: string; hits: number; last_hit_at: string | null };

beforeAll(async () => {
  A = await createTestUser("sec-fn-a");
  B = await createTestUser("sec-fn-b");
  a = await seedGraph(A.client, A.id, A.personalEntityId);
  b = await seedGraph(B.client, B.id, B.personalEntityId);
  systemRule = must(
    await adminClient().from("categorization_rules").select("id, hits, last_hit_at").is("user_id", null).order("id").limit(1).single(),
    "system rule",
  );
});

afterAll(async () => {
  // record_rule_hits touches a shared system row: restore it.
  if (systemRule) {
    await adminClient().from("categorization_rules").update({ hits: systemRule.hits, last_hit_at: systemRule.last_hit_at }).eq("id", systemRule.id);
  }
  await A?.cleanup();
  await B?.cleanup();
});

const auditCount = async (userId: string) => {
  const { count } = await adminClient().from("audit_log").select("*", { count: "exact", head: true }).eq("user_id", userId);
  return count ?? 0;
};

describe("apply_transaction_updates", () => {
  it("updates the caller's own transactions", async () => {
    const { data, error } = await A.client.rpc("apply_transaction_updates", {
      p_updates: [{ id: a.tx2Id, merchant: "Fictional Employer" }] as Json,
    });
    expect(error).toBeNull();
    expect(data).toBe(1);
    expect((await adminRow("transactions", "id", a.tx2Id))?.merchant).toBe("Fictional Employer");
  });

  it("called by B with A's transaction ids changes nothing", async () => {
    const before = [await adminRow("transactions", "id", a.txId), await adminRow("transactions", "id", a.tx2Id)];
    const auditBefore = await auditCount(A.id);
    const groceries = await systemCategoryId("groceries");
    const { data, error } = await B.client.rpc("apply_transaction_updates", {
      p_updates: [
        { id: a.txId, category_id: groceries, merchant: "HIJACKED", classification: "internal_transfer", duplicate_of: null },
        { id: a.tx2Id, category_id: null, recurring_series_id: null, transfer_group_id: uuid() },
      ] as Json,
    });
    expect(error).toBeNull();
    expect(data).toBe(0);
    expect([await adminRow("transactions", "id", a.txId), await adminRow("transactions", "id", a.tx2Id)]).toEqual(before);
    expect(await auditCount(A.id)).toBe(auditBefore);
  });

  it("a mixed batch only touches the caller's rows", async () => {
    const aBefore = await adminRow("transactions", "id", a.txId);
    const { data, error } = await B.client.rpc("apply_transaction_updates", {
      p_updates: [
        { id: a.txId, merchant: "MIXED" },
        { id: b.txId, merchant: "MIXED" },
      ] as Json,
    });
    expect(error).toBeNull();
    expect(data).toBe(1);
    expect(await adminRow("transactions", "id", a.txId)).toEqual(aBefore);
    expect((await adminRow("transactions", "id", b.txId))?.merchant).toBe("MIXED");
  });

  it("cannot link the caller's transaction to another user's transaction or series", async () => {
    for (const patch of [{ counterpart_transaction_id: b.txId }, { duplicate_of: b.txId }, { recurring_series_id: b.recurringId }]) {
      const { error } = await A.client.rpc("apply_transaction_updates", { p_updates: [{ id: a.txId, ...patch }] as Json });
      expectPgError(error, PG.FK);
    }
  });

  it("rejects more than 5000 items and accepts exactly 5000", async () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ id: uuid() }));
    const tooMany = await A.client.rpc("apply_transaction_updates", { p_updates: items(5001) as Json });
    expect(tooMany.error?.message).toMatch(/too many updates/);
    const limit = await A.client.rpc("apply_transaction_updates", { p_updates: items(5000) as Json });
    expect(limit.error).toBeNull();
    expect(limit.data).toBe(0);
  });

  it("rejects non-array payloads", async () => {
    const { error } = await A.client.rpc("apply_transaction_updates", { p_updates: { id: a.txId } as Json });
    expect(error?.message).toMatch(/must be a JSON array/);
  });
});

describe("log_user_action", () => {
  it("always writes for the caller, never for the referenced target's owner", async () => {
    const aBefore = await auditCount(A.id);
    const action = `sec.probe.${rand()}`;
    const { error } = await B.client.rpc("log_user_action", {
      p_action: action,
      p_target_table: "transactions",
      p_target_id: a.txId,
      p_details: { note: "fictional" },
    });
    expect(error).toBeNull();
    expect(await auditCount(A.id)).toBe(aBefore);
    const own = await B.client.from("audit_log").select("user_id, actor, action").eq("action", action);
    expect(own.data).toEqual([{ user_id: B.id, actor: "user", action }]);
    const fromA = await A.client.from("audit_log").select("id").eq("action", action);
    expect(fromA.data).toEqual([]);
  });

  it("truncates the action to 80 characters", async () => {
    const action = `sec.long.${"x".repeat(200)}`;
    expect((await B.client.rpc("log_user_action", { p_action: action, p_target_table: "x", p_target_id: B.id, p_details: {} })).error).toBeNull();
    const { data } = await B.client.from("audit_log").select("action").eq("action", action.slice(0, 80));
    expect(data).toHaveLength(1);
  });
});

describe("record_rule_hits", () => {
  it("cannot touch another user's rules", async () => {
    const before = await adminRow("categorization_rules", "id", a.ruleId);
    const { error } = await B.client.rpc("record_rule_hits", { p_rule_ids: [a.ruleId] });
    expect(error).toBeNull();
    expect(await adminRow("categorization_rules", "id", a.ruleId)).toEqual(before);
  });

  it("counts hits on the caller's own rules", async () => {
    const { error } = await B.client.rpc("record_rule_hits", { p_rule_ids: [b.ruleId, a.ruleId] });
    expect(error).toBeNull();
    expect((await adminRow("categorization_rules", "id", b.ruleId))?.hits).toBe(1);
    expect((await adminRow("categorization_rules", "id", a.ruleId))?.hits).toBe(0);
  });

  // Finding F3 (low): system rules are global rows shared by every tenant. Any user can bump
  // their counters without limit, and every other user can read the result (SELECT policy on
  // system rules), so one tenant's categorisation activity is observable by others and the
  // global counters are user-controlled. Remove `.fails` once fixed.
  it("one user's rule hits are not observable by (or tamperable for) other users", async () => {
    const read = async () =>
      must(await A.client.from("categorization_rules").select("hits, last_hit_at").eq("id", systemRule.id).single(), "rule as A");
    const before = await read();
    await B.client.rpc("record_rule_hits", { p_rule_ids: Array.from({ length: 50 }, () => systemRule.id) });
    await B.client.rpc("record_rule_hits", { p_rule_ids: [systemRule.id] });
    expect(await read()).toEqual(before);
  });
});

describe("function privileges", () => {
  const CALLS: [string, Record<string, unknown>][] = [
    ["apply_transaction_updates", { p_updates: [] }],
    ["delete_my_financial_data", {}],
    ["log_user_action", { p_action: "anon.probe", p_target_table: null, p_target_id: null, p_details: {} }],
    ["record_rule_hits", { p_rule_ids: [] }],
  ];

  it.each(CALLS)("anon cannot execute %s", async (fn, args) => {
    const { error } = await loose(anonClient()).rpc(fn, args);
    expectPgError(error, PG.DENIED);
  });

  it.each(["handle_new_user", "audit_transaction_change", "set_updated_at"])("trigger function %s is not callable over RPC", async (fn) => {
    const { error } = await loose(B.client).rpc(fn, {});
    expect(error).not.toBeNull();
  });
});

describe("delete_my_financial_data", () => {
  it("B calling it never touches A's data", async () => {
    const before = await countOwnedRows(A.id);
    await B.client.rpc("delete_my_financial_data");
    expect(await countOwnedRows(A.id)).toEqual(before);
    expect(await adminRow("transactions", "id", a.txId)).not.toBeNull();
  });

  // Finding F1 (medium): the function is SECURITY INVOKER and ends with a direct INSERT into
  // audit_log, which has no INSERT policy for `authenticated`. The INSERT fails with 42501 and
  // the whole call rolls back, so no user can erase their data. Remove `.fails` once fixed.
  it("erases the caller's financial data, keeps the personal entity and logs the deletion", async () => {
    const logged = async () => (await B.client.from("audit_log").select("action").eq("action", "data.deleted_all")).data?.length ?? 0;
    const loggedBefore = await logged();
    const { error } = await B.client.rpc("delete_my_financial_data");
    expect(error).toBeNull();
    const after = await countOwnedRows(B.id);
    for (const table of [
      "accounts",
      "liability_details",
      "documents",
      "import_jobs",
      "recurring_series",
      "transactions",
      "account_balances",
      "crypto_wallets",
      "wallet_holdings",
      "blockchain_transactions",
      "inbox_items",
      "insights",
      "categorization_rules",
      "categories",
      "institutions",
    ]) {
      expect(after[table], table).toBe(0);
    }
    expect(after.profiles).toBe(1);
    const entities = await B.client.from("financial_entities").select("id, kind");
    expect(entities.data).toEqual([{ id: B.personalEntityId, kind: "personal" }]);
    expect(await logged()).toBe(loggedBefore + 1);
  });
});
