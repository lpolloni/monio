/**
 * Reference data is readable but immutable for users; database constraints protect
 * financial integrity even when a client bypasses the app and talks to PostgREST directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestUser, type TestUser } from "../helpers";
import { PG, adminRow, expectPgError,
  REJECTED_FOR_OWNERSHIP, fakeEvmAddress, loose, must, rand, seedGraph, sha256Hex, type OwnedGraph } from "./fixtures";

let U: TestUser;
let g: OwnedGraph;

beforeAll(async () => {
  U = await createTestUser("sec-ref");
  g = await seedGraph(U.client, U.id, U.personalEntityId);
});

afterAll(async () => {
  await U?.cleanup();
});

/** Reference relations; for mixed tables only the global rows (NULL owner) are reference data. */
const REFERENCE: { table: string; globalOwner?: string }[] = [
  { table: "currencies" },
  { table: "crypto_assets" },
  { table: "exchange_rates" },
  { table: "institutions", globalOwner: "owner_id" },
  { table: "categories", globalOwner: "user_id" },
  { table: "categorization_rules", globalOwner: "user_id" },
];

async function globalCount(spec: (typeof REFERENCE)[number], user?: TestUser): Promise<number> {
  let builder = loose(user ? user.client : adminClient())
    .from(spec.table)
    .select("*", { count: "exact", head: true });
  if (spec.globalOwner) builder = builder.is(spec.globalOwner, null);
  const res = await builder;
  if (res.error) throw new Error(`${spec.table}: ${res.error.message}`);
  return res.count ?? 0;
}

describe("reference data: readable by authenticated users", () => {
  it.each(REFERENCE.map((r) => [r.table, r] as const))("%s: a user sees every global row", async (table, spec) => {
    // Bracket the user's count with two service-role counts: other processes on the DEV
    // stack (e.g. the worker refreshing exchange rates) may add rows concurrently.
    const adminBefore = await globalCount(spec);
    const userCount = await globalCount(spec, U);
    const adminAfter = await globalCount(spec);
    expect(userCount).toBeGreaterThanOrEqual(Math.min(adminBefore, adminAfter));
    expect(userCount).toBeLessThanOrEqual(Math.max(adminBefore, adminAfter));
    if (table !== "exchange_rates") expect(adminBefore).toBeGreaterThan(0);
  });
});

describe("reference data: not writable by authenticated users", () => {
  const INSERTS: Record<string, Record<string, unknown>> = {
    currencies: { code: "ZZZ", kind: "fiat", name: "Fictional Zed", decimals: 2, display_decimals: 2 },
    crypto_assets: { network: "base", symbol: "FAKE", name: "Fictional Token", contract_address: fakeEvmAddress(), decimals: 18 },
    exchange_rates: { base: "EUR", quote: "USD", as_of: "2099-01-01", rate: "9.99", source: "attacker" },
    institutions: { owner_id: null, slug: `catalog-${rand()}`, name: "Fictional Catalog Bank" },
    categories: { user_id: null, slug: `system_${rand()}`, kind: "expense" },
    categorization_rules: { user_id: null, match_type: "contains", pattern: `GLOBAL ${rand()}`, category_id: null, source: "system" },
  };

  it.each(Object.keys(INSERTS))("%s: insert of a global row is rejected", async (table) => {
    const row = { ...INSERTS[table] };
    if (table === "categorization_rules") row.category_id = g.categoryId;
    const { error } = await loose(U.client).from(table).insert(row).select();
    // A global rule pointing at the user's private category is also stopped by the ownership trigger.
    expectPgError(error, table === "categorization_rules" ? REJECTED_FOR_OWNERSHIP : PG.DENIED);
  });

  it("currencies: upsert over an existing code is rejected", async () => {
    const { error } = await loose(U.client)
      .from("currencies")
      .upsert({ code: "EUR", kind: "fiat", name: "Hijacked", decimals: 0, display_decimals: 0 }, { onConflict: "code" })
      .select();
    expectPgError(error, PG.DENIED);
    expect((await adminRow("currencies", "code", "EUR"))?.name).toBe("Euro");
  });

  it("global rows cannot be updated or deleted (0 rows, unchanged)", async () => {
    const admin = adminClient();
    const inst = must(await admin.from("institutions").select("id").is("owner_id", null).limit(1).single(), "inst");
    const cat = must(await admin.from("categories").select("id").is("user_id", null).limit(1).single(), "cat");
    const rule = must(await admin.from("categorization_rules").select("id").is("user_id", null).limit(1).single(), "rule");
    const asset = must(await admin.from("crypto_assets").select("id").limit(1).single(), "asset");
    const targets: [string, string, string | number, Record<string, unknown>][] = [
      ["currencies", "code", "EUR", { name: "Hijacked", decimals: 0 }],
      ["crypto_assets", "id", asset.id, { decimals: 0, contract_address: null }],
      ["institutions", "id", inst.id, { name: "Hijacked", brand_color: "#000000" }],
      ["categories", "id", cat.id, { kind: "income", name: "Hijacked" }],
      ["categorization_rules", "id", rule.id, { pattern: "HIJACKED", priority: -1 }],
    ];
    for (const [table, key, id, patch] of targets) {
      const before = await adminRow(table, key, id);
      const upd = await loose(U.client).from(table).update(patch).eq(key, id).select();
      expect(upd.error, table).toBeNull();
      expect(upd.data, table).toEqual([]);
      const del = await loose(U.client).from(table).delete().eq(key, id).select();
      expect(del.error, table).toBeNull();
      expect(del.data, table).toEqual([]);
      expect(await adminRow(table, key, id), table).toEqual(before);
    }
    const rates = await loose(U.client).from("exchange_rates").update({ rate: "1" }).eq("base", "EUR").select();
    expect(rates.data).toEqual([]);
    const ratesDel = await loose(U.client).from("exchange_rates").delete().eq("base", "EUR").select();
    expect(ratesDel.data).toEqual([]);
  });

  it("a user cannot promote its own row into a global (system/catalog) row", async () => {
    const db = loose(U.client);
    expectPgError((await db.from("categories").update({ user_id: null }).eq("id", g.categoryId).select()).error, PG.DENIED);
    expectPgError((await db.from("categorization_rules").update({ user_id: null }).eq("id", g.ruleId).select()).error, REJECTED_FOR_OWNERSHIP);
    expectPgError((await db.from("institutions").update({ owner_id: null }).eq("id", g.institutionId).select()).error, PG.DENIED);
    expect((await adminRow("categories", "id", g.categoryId))?.user_id).toBe(U.id);
  });
});

describe("financial integrity constraints", () => {
  const tx = (extra: Record<string, unknown> = {}) => ({
    user_id: U.id,
    account_id: g.accountId,
    booked_on: "2026-04-02",
    description_original: "FICTIONAL CONSTRAINT PROBE",
    amount: "-12.34",
    currency: "EUR",
    fingerprint: `fp-c-${rand()}`,
    source: "manual",
    ...extra,
  });
  const insertTx = async (extra: Record<string, unknown>) => (await loose(U.client).from("transactions").insert(tx(extra)).select("id")).error;

  it("zero amounts are rejected", async () => {
    for (const amount of ["0", "0.00", "-0.000000000000000000"]) {
      expectPgError(await insertTx({ amount }), PG.CHECK);
    }
  });

  it("original_amount and original_currency must come together", async () => {
    expectPgError(await insertTx({ original_amount: "-50.00" }), PG.CHECK);
    expectPgError(await insertTx({ original_currency: "BRL" }), PG.CHECK);
    expect(await insertTx({ original_amount: "-50.00", original_currency: "BRL", fx_rate: "0.1700" })).toBeNull();
  });

  it("non-positive fx_rate, unknown currency, out-of-range confidence and empty description are rejected", async () => {
    expectPgError(await insertTx({ fx_rate: "0" }), PG.CHECK);
    expectPgError(await insertTx({ fx_rate: "-1.5" }), PG.CHECK);
    expectPgError(await insertTx({ currency: "XYZ" }), PG.FK);
    expectPgError(await insertTx({ category_confidence: "1.5" }), PG.CHECK);
    expectPgError(await insertTx({ description_original: "" }), PG.CHECK);
  });

  it("duplicate (account_id, fingerprint) is rejected; the same fingerprint on another account is allowed", async () => {
    const fingerprint = `fp-dup-${rand()}`;
    expect(await insertTx({ fingerprint })).toBeNull();
    expectPgError(await insertTx({ fingerprint, amount: "-99.00" }), PG.UNIQUE);
    expect(await insertTx({ fingerprint, account_id: g.loanAccountId })).toBeNull();
  });

  it("crypto wallets reject extended private keys (xprv/yprv/zprv/tprv/uprv/vprv, any case)", async () => {
    // Fictional, base58-only body with the length of a real xprv (not a valid key).
    const body = `9s21ZrQH143K2jhgFakeKeyForTestsZZ${"A".repeat(74)}`;
    for (const prefix of ["xprv", "yprv", "zprv", "tprv", "uprv", "vprv", "XPRV", "Zprv"]) {
      const { error } = await loose(U.client)
        .from("crypto_wallets")
        .insert({ user_id: U.id, account_id: g.walletAccountId, family: "bitcoin", watch_kind: "xpub", public_identifier: `${prefix}${body}` })
        .select();
      expect(error?.code, prefix).toBe(PG.CHECK);
    }
    const tooShort = await loose(U.client)
      .from("crypto_wallets")
      .insert({ user_id: U.id, account_id: g.walletAccountId, family: "evm", watch_kind: "address", public_identifier: "0x1234" })
      .select();
    expectPgError(tooShort.error, PG.CHECK);
  });

  // Finding F4 (defense in depth): the CHECK only anchors at the start of the string, so an
  // extended PRIVATE key embedded in an output descriptor (watch_kind 'descriptor' is allowed)
  // or preceded by whitespace is stored. PostgREST lets users insert directly, bypassing
  // detectWatchTarget(). Remove `.fails` once the constraint is widened.
  it("crypto wallets reject private keys embedded in descriptors or behind whitespace", async () => {
    // Fictional, base58-only, real-xprv length (not a valid key).
    const xprv = `xprv9s21ZrQH143K2jhgFakeKeyForTestsZZ${"A".repeat(74)}`;
    const attempts = [`wpkh([d34db33f/84h/0h/0h]${xprv}/0/*)`, ` ${xprv}`];
    for (const public_identifier of attempts) {
      const { error } = await loose(U.client)
        .from("crypto_wallets")
        .insert({ user_id: U.id, account_id: g.walletAccountId, family: "bitcoin", watch_kind: "descriptor", public_identifier })
        .select();
      expect(error?.code, public_identifier.slice(0, 12)).toBe(PG.CHECK);
    }
  });

  it("negative credit_limit is rejected; zero is allowed", async () => {
    const db = loose(U.client);
    expectPgError((await db.from("accounts").update({ credit_limit: "-0.01" }).eq("id", g.accountId).select()).error, PG.CHECK);
    expect((await db.from("accounts").update({ credit_limit: "0" }).eq("id", g.accountId).select()).error).toBeNull();
  });

  it("accounts only store a short mask and a sha256 hash of the external identifier", async () => {
    const db = loose(U.client);
    const fullIban = "PT50000201231234567890154"; // fictional
    expectPgError((await db.from("accounts").update({ account_mask: fullIban }).eq("id", g.accountId).select()).error, PG.CHECK);
    expectPgError((await db.from("accounts").update({ external_ref_hash: fullIban }).eq("id", g.accountId).select()).error, PG.CHECK);
    expect((await db.from("accounts").update({ external_ref_hash: sha256Hex() }).eq("id", g.accountId).select()).error).toBeNull();
  });

  it("negative liability principal / APR and negative crypto quantities are rejected", async () => {
    const db = loose(U.client);
    expectPgError((await db.from("liability_details").update({ original_principal: "-1.00" }).eq("account_id", g.loanAccountId).select()).error, PG.CHECK);
    expectPgError((await db.from("liability_details").update({ interest_rate_apr: "-0.5000" }).eq("account_id", g.loanAccountId).select()).error, PG.CHECK);
    expectPgError((await db.from("wallet_holdings").update({ quantity: "-0.1" }).eq("id", g.holdingId).select()).error, PG.CHECK);
    expectPgError((await db.from("blockchain_transactions").update({ fee_quantity: "-0.1" }).eq("id", g.chainTxId).select()).error, PG.CHECK);
  });

  it("documents require a hex sha256 and a positive size", async () => {
    const db = loose(U.client);
    const doc = { user_id: U.id, storage_path: `${U.id}/x.csv`, original_filename: "x.csv", mime_type: "text/csv", size_bytes: 1, sha256: sha256Hex() };
    expectPgError((await db.from("documents").insert({ ...doc, sha256: "not-a-hash" }).select()).error, PG.CHECK);
    expectPgError((await db.from("documents").insert({ ...doc, sha256: sha256Hex(), size_bytes: 0 }).select()).error, PG.CHECK);
  });

  it("exchange rates must be positive and between two different currencies (service role)", async () => {
    const admin = loose(adminClient());
    const base = { base: "EUR", quote: "USD", as_of: "2099-12-31", source: `sec-test-${rand()}` };
    try {
      expectPgError((await admin.from("exchange_rates").insert({ ...base, rate: "0" })).error, PG.CHECK);
      expectPgError((await admin.from("exchange_rates").insert({ ...base, rate: "-1.1" })).error, PG.CHECK);
      expectPgError((await admin.from("exchange_rates").insert({ ...base, quote: "EUR", rate: "1" })).error, PG.CHECK);
      expect((await admin.from("exchange_rates").insert({ ...base, rate: "1.0842" })).error).toBeNull();
    } finally {
      await admin.from("exchange_rates").delete().eq("source", base.source);
    }
  });

  it("profile locale, currency and display name are validated", async () => {
    const db = loose(U.client);
    expectPgError((await db.from("profiles").update({ locale: "fr" }).eq("id", U.id).select()).error, PG.CHECK);
    expectPgError((await db.from("profiles").update({ primary_currency: "XYZ" }).eq("id", U.id).select()).error, PG.FK);
    expectPgError((await db.from("profiles").update({ display_name: "N".repeat(81) }).eq("id", U.id).select()).error, PG.CHECK);
    const ok = await db.from("profiles").update({ locale: "en", primary_currency: "BRL" }).eq("id", U.id).select("locale, primary_currency");
    expect(ok.data).toEqual([{ locale: "en", primary_currency: "BRL" }]);
  });
});
