/**
 * Authentication and token handling: credentials, password policy, tampered/forged JWTs,
 * crafted PostgREST filters, schema exposure, and isolation of the seeded demo accounts.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/server/supabase/database.types";
import { adminClient, anonClient, createTestUser, type TestUser } from "../helpers";
import { loose, rand, seedGraph, type OwnedGraph } from "./fixtures";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUBLISHABLE = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const DEMO_EMAIL = "demo@monio.dev";
const ISOLATION_EMAIL = "isolation@monio.dev";
const DEMO_PASSWORD = "MonioDemo!2026";

let A: TestUser;
let B: TestUser;
let a: OwnedGraph;
let b: OwnedGraph;

beforeAll(async () => {
  A = await createTestUser("sec-auth-a");
  B = await createTestUser("sec-auth-b");
  a = await seedGraph(A.client, A.id, A.personalEntityId);
  b = await seedGraph(B.client, B.id, B.personalEntityId);
});

afterAll(async () => {
  await A?.cleanup();
  await B?.cleanup();
});

const b64url = (value: object | string) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

/** Re-encodes a JWT payload while keeping the ORIGINAL header and signature. */
function tamper(token: string, patch: Record<string, unknown>): string {
  const [header, payload, signature] = token.split(".");
  return [header, b64url({ ...decode(payload!), ...patch }), signature].join(".");
}

async function rest(path: string, token: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${token}`, ...headers },
  });
  return { status: res.status, body: await res.text() };
}

describe("credentials and password policy", () => {
  it("a wrong password does not create a session", async () => {
    const { data, error } = await anonClient().auth.signInWithPassword({ email: A.email, password: `${A.password}-wrong` });
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it("sign-up with a password shorter than 8 characters is rejected", async () => {
    const email = `sec-short-${rand()}@test.monio.dev`;
    const { data, error } = await anonClient().auth.signUp({ email, password: "Ab1!xyz" });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("weak_password");
    expect(data.user).toBeNull();
    const { data: users } = await adminClient().auth.admin.listUsers({ perPage: 1000 });
    expect(users.users.map((u) => u.email)).not.toContain(email);
  });

  it("anonymous sign-ins are disabled", async () => {
    const { data, error } = await anonClient().auth.signInAnonymously();
    expect(error).not.toBeNull();
    expect(data.session).toBeNull();
  });

  it("a user token cannot call the auth admin API", async () => {
    const res = await fetch(`${URL_}/auth/v1/admin/users`, { headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${B.accessToken}` } });
    expect([401, 403]).toContain(res.status);
  });
});

describe("JWT tampering", () => {
  it("the genuine token works (control)", async () => {
    const res = await rest(`accounts?select=id&id=eq.${b.accountId}`, B.accessToken);
    expect(res.status).toBe(200);
    expect(res.body).toContain(b.accountId);
  });

  it("changing `sub` to another user invalidates the token", async () => {
    const res = await rest(`accounts?select=id,user_id`, tamper(B.accessToken, { sub: A.id }));
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(a.accountId);
  });

  it("escalating `role` to service_role invalidates the token", async () => {
    const res = await rest(`accounts?select=id,user_id`, tamper(B.accessToken, { role: "service_role" }));
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(a.accountId);
  });

  it("an unsigned (alg=none) token is rejected", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub: A.id, role: "authenticated", aud: "authenticated", iat: now, exp: now + 600 })}.`;
    const res = await rest(`accounts?select=id`, token);
    expect(res.status).toBe(401);
    expect(res.body).not.toContain(a.accountId);
  });

  it("extending `exp` invalidates the token", async () => {
    const res = await rest(`accounts?select=id`, tamper(B.accessToken, { exp: Math.floor(Date.now() / 1000) + 10 * 365 * 86400 }));
    expect(res.status).toBe(401);
  });
});

describe("crafted filters with a valid JWT never reach another user's rows", () => {
  it("eq / in / neq / or / not filters on the client return only the caller's rows", async () => {
    const db = B.client;
    expect((await db.from("accounts").select("id").eq("user_id", A.id)).data).toEqual([]);
    expect((await db.from("transactions").select("id").eq("user_id", A.id)).data).toEqual([]);
    expect((await db.from("transactions").select("id").in("id", [a.txId, a.tx2Id])).data).toEqual([]);
    expect((await db.from("transactions").select("id").neq("user_id", B.id)).data).toEqual([]);
    const ored = await db.from("accounts").select("user_id").or(`user_id.eq.${A.id},user_id.eq.${B.id}`);
    expect(new Set(ored.data?.map((r) => r.user_id))).toEqual(new Set([B.id]));
    const notNull = await db.from("documents").select("user_id").not("user_id", "is", null);
    expect(notNull.data?.every((r) => r.user_id === B.id)).toBe(true);
  });

  it("exact counts with a foreign user_id filter are zero (no count side channel)", async () => {
    for (const table of ["accounts", "transactions", "documents", "audit_log", "profiles"] as const) {
      const column = table === "profiles" ? "id" : "user_id";
      const { count, error } = await loose(B.client).from(table).select("*", { count: "exact", head: true }).eq(column, A.id);
      expect(error, table).toBeNull();
      expect(count, table).toBe(0);
    }
  });

  it("raw PostgREST queries (inner joins, embedded filters, ranges) return nothing of A", async () => {
    for (const path of [
      `accounts?select=*&user_id=eq.${A.id}`,
      `transactions?select=*,accounts!inner(id,user_id)&accounts.user_id=eq.${A.id}`,
      `transactions?select=id&or=(user_id.eq.${A.id},id.eq.${a.txId})`,
      `financial_entities?select=*&id=eq.${A.personalEntityId}`,
      `profiles?select=*&id=eq.${A.id}`,
    ]) {
      const res = await rest(path, B.accessToken, { Range: "0-9999" });
      expect(res.status, path).toBeLessThan(300);
      expect(JSON.parse(res.body), path).toEqual([]);
    }
  });

  it("a valid JWT cannot switch to non-exposed schemas (auth, storage)", async () => {
    for (const schema of ["auth", "storage", "graphql_public", "extensions"]) {
      const res = await rest(`users?select=*`, B.accessToken, { "Accept-Profile": schema });
      expect(res.status, schema).toBeGreaterThanOrEqual(400);
      expect(res.body, schema).not.toContain(A.email);
    }
  });
});

// Only runs when `npm run dev:seed` has created the demo users.
const { data: seededUsers } = await adminClient().auth.admin.listUsers({ perPage: 1000 });
const seededEmails = new Set(seededUsers.users.map((u) => u.email));
const hasDemoUsers = seededEmails.has(DEMO_EMAIL) && seededEmails.has(ISOLATION_EMAIL);

describe.skipIf(!hasDemoUsers)("seeded demo data isolation", () => {
  it("isolation@monio.dev sees none of demo@monio.dev's accounts, transactions or wallets", async () => {
    const admin = adminClient();
    const demoId = seededUsers.users.find((u) => u.email === DEMO_EMAIL)!.id;
    const isoId = seededUsers.users.find((u) => u.email === ISOLATION_EMAIL)!.id;
    const demoAccounts = (await admin.from("accounts").select("id").eq("user_id", demoId)).data!.map((r) => r.id);
    expect(demoAccounts.length).toBeGreaterThan(0);

    const iso = createClient<Database>(URL_, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: session, error } = await iso.auth.signInWithPassword({ email: ISOLATION_EMAIL, password: DEMO_PASSWORD });
    expect(error).toBeNull();
    expect(session.user?.id).toBe(isoId);

    const accounts = await iso.from("accounts").select("id, user_id");
    expect(accounts.error).toBeNull();
    expect(accounts.data?.every((r) => r.user_id === isoId)).toBe(true);
    expect(accounts.data?.some((r) => demoAccounts.includes(r.id))).toBe(false);

    const txs = await iso.from("transactions").select("id, user_id, account_id").range(0, 9999);
    expect(txs.data?.every((r) => r.user_id === isoId && !demoAccounts.includes(r.account_id))).toBe(true);
    const { count: isoTxCount } = await admin.from("transactions").select("*", { count: "exact", head: true }).eq("user_id", isoId);
    expect(txs.data).toHaveLength(isoTxCount ?? 0);

    expect((await iso.from("transactions").select("id").eq("user_id", demoId)).data).toEqual([]);
    expect((await iso.from("transactions").select("id").in("account_id", demoAccounts)).data).toEqual([]);
    expect((await iso.from("crypto_wallets").select("id").eq("user_id", demoId)).data).toEqual([]);
    expect((await iso.from("profiles").select("id").eq("id", demoId)).data).toEqual([]);
  });
});
