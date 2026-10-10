/**
 * Audit trail integrity and account-deletion lifecycle.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeOrphanedDocuments } from "@/server/maintenance/purge";
import { adminClient, createTestUser, type TestUser } from "../helpers";
import { PG, USER_TABLES, adminRow, countOwnedRows, createBareUser, expectPgError, loose, must, rand, seedGraph, systemCategoryId, type OwnedGraph } from "./fixtures";

let A: TestUser;
let B: TestUser;
let a: OwnedGraph;
const orphanPrefixes: string[] = [];

beforeAll(async () => {
  A = await createTestUser("sec-audit-a");
  B = await createTestUser("sec-audit-b");
  a = await seedGraph(A.client, A.id, A.personalEntityId);
});

afterAll(async () => {
  const store = adminClient().storage.from("documents");
  for (const prefix of orphanPrefixes) {
    const { data } = await store.list(prefix);
    if (data?.length) await store.remove(data.map((o) => `${prefix}/${o.name}`));
  }
  await A?.cleanup();
  await B?.cleanup();
});

const auditFor = async (userId: string, targetId: string) =>
  must(
    await adminClient().from("audit_log").select("id, user_id, actor, action, target_table, target_id, details").eq("user_id", userId).eq("target_id", targetId).order("id"),
    "audit rows",
  );

describe("audit trigger on transactions", () => {
  let auditId: number;

  it("a category change by the owner writes an audit_log row with actor 'user'", async () => {
    const dining = await systemCategoryId("dining");
    const before = (await auditFor(A.id, a.txId)).length;
    must(await A.client.from("transactions").update({ category_id: dining }).eq("id", a.txId).select("id").single(), "recategorise");
    const rows = await auditFor(A.id, a.txId);
    expect(rows).toHaveLength(before + 1);
    const last = rows.at(-1)!;
    expect(last).toMatchObject({ user_id: A.id, actor: "user", action: "transaction.updated", target_table: "transactions", target_id: a.txId });
    expect(last.details).toEqual({ category_id: [a.categoryId, dining] });
    auditId = last.id;
  });

  it("the owner can read the entry; another user cannot, whatever the filter", async () => {
    const own = await A.client.from("audit_log").select("id").eq("id", auditId);
    expect(own.data).toEqual([{ id: auditId }]);
    for (const res of [
      await B.client.from("audit_log").select("*").eq("id", auditId),
      await B.client.from("audit_log").select("*").eq("target_id", a.txId),
      await B.client.from("audit_log").select("*").eq("user_id", A.id),
    ]) {
      expect(res.error).toBeNull();
      expect(res.data).toEqual([]);
    }
  });

  it("untracked edits (notes) do not write audit rows", async () => {
    const before = (await auditFor(A.id, a.txId)).length;
    must(await A.client.from("transactions").update({ notes: "fictional note" }).eq("id", a.txId).select("id").single(), "notes");
    expect(await auditFor(A.id, a.txId)).toHaveLength(before);
  });

  it("service-role changes are attributed to actor 'system'", async () => {
    must(await adminClient().from("transactions").update({ classification: "card_payment" }).eq("id", a.txId).select("id").single(), "admin update");
    expect((await auditFor(A.id, a.txId)).at(-1)).toMatchObject({ actor: "system", details: { classification: ["regular", "card_payment"] } });
  });

  it("deleting a transaction writes a transaction.deleted entry with the original amount", async () => {
    const victim = must(
      await loose(A.client)
        .from("transactions")
        .insert({
          user_id: A.id,
          account_id: a.accountId,
          booked_on: "2026-04-03",
          description_original: "FICTIONAL TO DELETE",
          amount: "-7.50",
          currency: "EUR",
          fingerprint: `fp-del-${rand()}`,
          source: "manual",
        })
        .select("id")
        .single(),
      "insert",
    ) as { id: string };
    must(await A.client.from("transactions").delete().eq("id", victim.id).select("id").single(), "delete");
    const rows = await auditFor(A.id, victim.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "user", action: "transaction.deleted", details: { amount: "-7.500000000000000000", currency: "EUR" } });
  });
});

describe("audit_log is append-only for users", () => {
  it("users cannot insert audit rows directly (not even for themselves)", async () => {
    const db = loose(A.client);
    for (const row of [
      { user_id: A.id, actor: "user", action: "forged.self" },
      { user_id: A.id, actor: "system", action: "forged.system" },
      { user_id: B.id, actor: "worker", action: "forged.other" },
    ]) {
      expectPgError((await db.from("audit_log").insert(row).select()).error, PG.DENIED);
    }
  });

  it("users cannot update or delete their own audit rows", async () => {
    const before = await adminRow("audit_log", "id", a.auditId);
    const upd = await loose(A.client).from("audit_log").update({ action: "tampered", details: {} }).eq("id", a.auditId).select();
    expect(upd.error).toBeNull();
    expect(upd.data).toEqual([]);
    const del = await loose(A.client).from("audit_log").delete().eq("id", a.auditId).select();
    expect(del.error).toBeNull();
    expect(del.data).toEqual([]);
    expect(await adminRow("audit_log", "id", a.auditId)).toEqual(before);
  });
});

describe("deleting a user (service role) cascades all of their data", () => {
  let victimId: string;

  beforeAll(async () => {
    const admin = adminClient();
    victimId = await createBareUser("sec-del");
    orphanPrefixes.push(victimId);
    const entity = must(await admin.from("financial_entities").select("id").eq("user_id", victimId).single(), "entity");
    const g = await seedGraph(admin, victimId, entity.id);
    // Extra links that fire ON DELETE SET NULL + the audit UPDATE path during the cascade.
    must(await admin.from("transactions").update({ duplicate_of: g.txId, counterpart_transaction_id: g.txId }).eq("id", g.tx2Id).select("id").single(), "link");
    must(await admin.from("transactions").update({ category_id: g.categoryId }).eq("id", g.tx2Id).select("id").single(), "user category");
    const up = await admin.storage
      .from("documents")
      .upload(`${victimId}/fictional-statement.csv`, new Blob(["date,amount\n2026-01-01,-1.00\n"], { type: "text/csv" }), { contentType: "text/csv" });
    if (up.error) throw up.error;
    const counts = await countOwnedRows(victimId);
    for (const { table } of USER_TABLES) expect(counts[table], `seeded ${table}`).toBeGreaterThan(0);
  });

  afterAll(async () => {
    // Normally already deleted by the test below; keeps the DB clean when it is filtered out.
    if (victimId) await adminClient().auth.admin.deleteUser(victimId);
  });

  it("auth.admin.deleteUser succeeds (regression: the audit trigger used to block it)", async () => {
    const { error } = await adminClient().auth.admin.deleteUser(victimId);
    expect(error).toBeNull();
    const { data } = await adminClient().auth.admin.getUserById(victimId);
    expect(data.user).toBeNull();
  });

  it("no row of the deleted user remains in any user-owned table", async () => {
    const counts = await countOwnedRows(victimId);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  // Finding F5 (privacy): storage objects are not linked to auth.users, so deleting a user
  // through the Auth admin API leaves their statements behind. Remedy: account erasure goes
  // through deleteUserCompletely(), and the `purge` worker mode sweeps orphaned folders.
  it("the deleted user's uploaded documents are removed by the purge sweeper", async () => {
    const before = await adminClient().storage.from("documents").list(victimId);
    expect((before.data ?? []).length).toBeGreaterThan(0);
    await purgeOrphanedDocuments(adminClient());
    const { data } = await adminClient().storage.from("documents").list(victimId);
    expect(data ?? []).toEqual([]);
  });
});
