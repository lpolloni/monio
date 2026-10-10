import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postProcessUser } from "@/server/processing/post-process";
import { dbNumeric } from "@/server/supabase/numeric";
import { createTestUser, type TestUser } from "./helpers";

const TODAY = "2026-10-10";

/** Post-processing re-runs (after every Smart Inbox answer) must not flood the inbox. */
describe("post-processing re-runs (local Supabase)", () => {
  let user: TestUser;
  let transferOutId: string;
  let uncategorizedIds: string[];

  beforeAll(async () => {
    user = await createTestUser("postprocess");
    const db = user.client;
    const { data: biz, error: bizError } = await db.from("financial_entities").insert({ user_id: user.id, name: "Fictional Studio", kind: "business" }).select("id").single();
    if (bizError) throw bizError;
    const { data: accounts, error: accError } = await db
      .from("accounts")
      .insert([
        { user_id: user.id, entity_id: user.personalEntityId, name: "Personal checking", type: "checking", currency: "EUR", sync_source: "manual" },
        { user_id: user.id, entity_id: biz.id, name: "Studio account", type: "checking", currency: "EUR", sync_source: "manual" },
      ])
      .select("id, name");
    if (accError) throw accError;
    const personal = accounts.find((a) => a.name === "Personal checking")!.id;
    const business = accounts.find((a) => a.name === "Studio account")!.id;

    // Twelve uncategorized expenses with distinct fictional merchants and amounts.
    const expenses = Array.from({ length: 12 }, (_, i) => ({
      user_id: user.id,
      account_id: personal,
      booked_on: `2026-09-${String(i + 1).padStart(2, "0")}`,
      description_original: `Zorblat Vendor ${String.fromCharCode(65 + i)}`,
      amount: dbNumeric(`-${(i + 1) * 101}.00`),
      currency: "EUR",
      fingerprint: `pp-expense-${i}`,
      source: "manual",
    }));
    // A personal -> business move: needs the user's decision, and is the largest outflow.
    const transfer = [
      { user_id: user.id, account_id: personal, booked_on: "2026-09-20", description_original: "Transfer to Fictional Studio", amount: dbNumeric("-5000.00"), currency: "EUR", fingerprint: "pp-transfer-out", source: "manual" },
      { user_id: user.id, account_id: business, booked_on: "2026-09-20", description_original: "Transfer from owner", amount: dbNumeric("5000.00"), currency: "EUR", fingerprint: "pp-transfer-in", source: "manual" },
    ];
    const { data: inserted, error } = await db.from("transactions").insert([...expenses, ...transfer]).select("id, fingerprint");
    if (error) throw error;
    transferOutId = inserted.find((t) => t.fingerprint === "pp-transfer-out")!.id;
    uncategorizedIds = inserted.filter((t) => t.fingerprint.startsWith("pp-expense")).map((t) => t.id);
  });

  afterAll(async () => {
    await user?.cleanup();
  });

  async function openItems(kind: string) {
    const { data, error } = await user.client.from("inbox_items").select("id, transaction_ids").eq("kind", kind).eq("status", "open");
    if (error) throw error;
    return data;
  }

  it("asks a bounded batch of uncategorized questions and never about a pending transfer", async () => {
    await postProcessUser(user.client, user.id, { today: TODAY });
    const transfers = await openItems("transfer_match");
    expect(transfers).toHaveLength(1);
    const uncategorized = await openItems("uncategorized");
    expect(uncategorized).toHaveLength(8);
    expect(uncategorized.flatMap((i) => i.transaction_ids)).not.toContain(transferOutId);
  });

  it("re-running adds no new questions while the batch is still open", async () => {
    const before = (await openItems("uncategorized")).map((i) => i.id).sort();
    await postProcessUser(user.client, user.id, { today: TODAY });
    const after = (await openItems("uncategorized")).map((i) => i.id).sort();
    expect(after).toEqual(before);
  });

  it("closes questions that no longer apply and refills the batch up to its size", async () => {
    const open = await openItems("uncategorized");
    const answeredElsewhere = open.slice(0, 3).flatMap((i) => i.transaction_ids);
    const { data: category } = await user.client.from("categories").select("id").eq("slug", "shopping").is("user_id", null).single();
    const { error } = await user.client.from("transactions").update({ category_id: category!.id, category_source: "user" }).in("id", answeredElsewhere);
    if (error) throw error;

    await postProcessUser(user.client, user.id, { today: TODAY });
    const { data: closed } = await user.client.from("inbox_items").select("status, resolution").eq("kind", "uncategorized").neq("status", "open");
    expect(closed).toHaveLength(3);
    for (const item of closed ?? []) expect(item.resolution).toMatchObject({ decision: "auto", reason: "no_longer_applies" });
    const reopened = await openItems("uncategorized");
    // 12 expenses: 3 categorized, 8 asked before -> 5 still open + 3 of the 4 never asked.
    expect(reopened).toHaveLength(8);
    const asked = new Set(reopened.flatMap((i) => i.transaction_ids));
    for (const id of answeredElsewhere) expect(asked.has(id)).toBe(false);
    expect([...asked].every((id) => uncategorizedIds.includes(id))).toBe(true);
  });
});
