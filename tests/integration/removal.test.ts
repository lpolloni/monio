import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aiConfigFromEnv, createAiService, type AiService } from "@/server/ai";
import { receiveUpload, type UploadResult } from "@/server/import/intake";
import { runImportJob } from "@/server/import/pipeline";
import { RemovalBlockedError, removeAccount, removeDocument } from "@/server/processing/removal";
import { adminClient, createTestUser, type TestUser } from "./helpers";

// Fictional fixtures (see tests/fixtures/statements/README.md).
const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/statements");
const TODAY = "2026-10-10";
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));

describe("removing accounts and documents (local Supabase)", () => {
  let user: TestUser;
  let other: TestUser;
  let ai: AiService;

  const importFile = async (name: string): Promise<UploadResult> => {
    const upload = await receiveUpload(user.client, user.id, { bytes: fixture(name), filename: name }, { maxBytes: 15 * 1024 * 1024 });
    if (!upload.alreadyImported) await runImportJob(user.client, user.id, upload.jobId, { bytes: fixture(name), today: TODAY, ai });
    return upload;
  };
  const count = async (table: "transactions" | "account_balances" | "accounts" | "documents" | "import_jobs") => {
    const { count: n, error } = await user.client.from(table).select("id", { count: "exact", head: true });
    if (error) throw error;
    return n ?? 0;
  };
  const stored = async (documentId: string) => (await adminClient().storage.from("documents").list(`${user.id}/${documentId}`)).data?.length ?? 0;

  beforeAll(async () => {
    user = await createTestUser("removal");
    other = await createTestUser("removal-other");
    ai = createAiService(aiConfigFromEnv({ AI_PROVIDER: "mock" }));
  });

  afterAll(async () => {
    for (const u of [user, other]) await u?.cleanup();
  });

  it("deletes a document with its transactions, balances, jobs, stored original and the account it created", async () => {
    const upload = await importFile("n26.csv");
    expect(await count("transactions")).toBe(6);
    expect(await stored(upload.documentId)).toBe(1);

    const removed = await removeDocument(user.client, user.id, upload.documentId);
    expect(removed).toEqual({ transactions: 6, documents: 1, accounts: 1 });
    for (const table of ["transactions", "account_balances", "accounts", "documents", "import_jobs"] as const) expect(await count(table)).toBe(0);
    expect(await stored(upload.documentId)).toBe(0);

    // The same file is a new import again.
    expect((await importFile("n26.csv")).alreadyImported).toBe(false);
    expect(await count("transactions")).toBe(6);
  });

  it("deletes an account with its transactions and the documents that only fed it", async () => {
    await importFile("revolut.csv");
    const { data: accounts } = await user.client.from("accounts").select("id, institution:institutions(slug)");
    const n26 = accounts!.find((a) => (Array.isArray(a.institution) ? a.institution[0] : a.institution)?.slug === "n26")!;
    const before = await count("transactions");

    const removed = await removeAccount(user.client, user.id, n26.id);
    expect(removed).toMatchObject({ transactions: 6, documents: 1, accounts: 1 });
    expect(await count("transactions")).toBe(before - 6);
    expect(await count("documents")).toBe(1);
    const { data: left } = await user.client.from("transactions").select("account_id");
    expect(left!.every((t) => t.account_id !== n26.id)).toBe(true);
  });

  it("refuses rows of another user and unknown ids", async () => {
    const { data: doc } = await user.client.from("documents").select("id").single();
    const { data: account } = await user.client.from("accounts").select("id").limit(1).single();
    await expect(removeDocument(other.client, other.id, doc!.id)).rejects.toBeInstanceOf(RemovalBlockedError);
    await expect(removeAccount(other.client, other.id, account!.id)).rejects.toBeInstanceOf(RemovalBlockedError);
    expect(await count("documents")).toBe(1);
  });
});
