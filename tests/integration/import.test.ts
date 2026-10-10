import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toPlain } from "@/domain/money/decimal";
import { hashIdentifier } from "@/domain/transactions/normalize";
import { aiConfigFromEnv, createAiService, type AiService } from "@/server/ai";
import { receiveUpload, sha256Hex, UploadRejectedError, type UploadResult } from "@/server/import/intake";
import { runImportJob, type ImportStats } from "@/server/import/pipeline";
import { buildPdf } from "../helpers/pdf-writer";
import { adminClient, createTestUser, type TestClient, type TestUser } from "./helpers";

// Fictional fixtures (see tests/fixtures/statements/README.md).
const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/statements");
const TODAY = "2026-10-10";
const MAX_BYTES = 15 * 1024 * 1024;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)));
}

async function upload(user: TestUser, name: string, opts: { reprocess?: boolean; mimeType?: string } = {}): Promise<UploadResult> {
  return receiveUpload(user.client, user.id, { bytes: fixture(name), filename: name, mimeType: opts.mimeType }, { maxBytes: MAX_BYTES, reprocess: opts.reprocess });
}

async function removeStorage(userId: string): Promise<void> {
  const admin = adminClient();
  const { data: folders } = await admin.storage.from("documents").list(userId, { limit: 1000 });
  const paths: string[] = [];
  for (const folder of folders ?? []) {
    const { data: objects } = await admin.storage.from("documents").list(`${userId}/${folder.name}`, { limit: 1000 });
    for (const o of objects ?? []) paths.push(`${userId}/${folder.name}/${o.name}`);
  }
  if (paths.length) await admin.storage.from("documents").remove(paths);
}

async function countTransactions(client: TestClient, filter: { documentId?: string; accountIds?: string[] }): Promise<number> {
  let query = client.from("transactions").select("id", { count: "exact", head: true });
  if (filter.documentId) query = query.eq("document_id", filter.documentId);
  if (filter.accountIds) query = query.in("account_id", filter.accountIds);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

describe("document import pipeline (local Supabase)", () => {
  let user: TestUser;
  let other: TestUser;
  let ai: AiService;
  let n26: UploadResult;

  beforeAll(async () => {
    user = await createTestUser("import");
    other = await createTestUser("import-other");
    ai = createAiService(aiConfigFromEnv({ AI_PROVIDER: "mock" }));
  });

  afterAll(async () => {
    for (const u of [user, other]) {
      if (!u) continue;
      await removeStorage(u.id);
      await u.cleanup();
    }
  });

  it("imports an N26 CSV with provenance, stores the original and completes the job", async () => {
    n26 = await upload(user, "n26.csv", { mimeType: "application/octet-stream" });
    expect(n26).toMatchObject({ format: "csv", alreadyImported: false });

    const { data: queued } = await user.client.from("import_jobs").select("status, stage, progress").eq("id", n26.jobId).single();
    expect(queued).toEqual({ status: "queued", stage: "received", progress: 0 });

    const outcome = await runImportJob(user.client, user.id, n26.jobId, { bytes: fixture("n26.csv"), today: TODAY, ai });
    expect(outcome.status).toBe("completed");

    const { data: job } = await user.client
      .from("import_jobs")
      .select("status, stage, progress, stats, error_code, started_at, finished_at")
      .eq("id", n26.jobId)
      .single();
    expect(job).toMatchObject({ status: "completed", stage: "completed", progress: 100, error_code: null });
    expect(job!.started_at).toBeTruthy();
    expect(job!.finished_at).toBeTruthy();
    const stats = job!.stats as unknown as ImportStats;
    expect(stats).toMatchObject({
      transactionsOrganized: 6,
      duplicatesSkipped: 0,
      accountsIdentified: 1,
      warnings: 0,
      institution: { slug: "n26", name: "N26" },
      format: "csv",
      period: { start: "2026-03-01", end: "2026-03-06" },
    });
    expect(stats.recurringDetected).toBeGreaterThanOrEqual(0);
    expect(stats.reviewItems).toBeGreaterThanOrEqual(0);

    // Document row: canonical type for the detected format (not the browser's), owner folder.
    const { data: doc } = await user.client
      .from("documents")
      .select("storage_path, mime_type, detected_format, status, sha256, original_filename, period_start, period_end, detected_institution_id")
      .eq("id", n26.documentId)
      .single();
    expect(doc).toMatchObject({
      mime_type: "text/csv",
      detected_format: "csv",
      status: "processed",
      original_filename: "n26.csv",
      period_start: "2026-03-01",
      period_end: "2026-03-06",
    });
    expect(doc!.detected_institution_id).toBeTruthy();
    expect(doc!.storage_path).toBe(`${user.id}/${n26.documentId}/n26.csv`);

    // The original is in private storage and its owner can download it unchanged.
    const { data: blob, error: downloadError } = await user.client.storage.from("documents").download(doc!.storage_path);
    expect(downloadError).toBeNull();
    expect(sha256Hex(new Uint8Array(await blob!.arrayBuffer()))).toBe(doc!.sha256);

    // Transactions keep provenance and the original foreign amount.
    const { data: rows } = await user.client
      .from("transactions")
      .select("account_id, amount:amount::text, currency, original_amount:original_amount::text, original_currency, document_id, import_job_id, source, source_row, extraction, raw, status, fingerprint")
      .eq("document_id", n26.documentId)
      .order("source_row");
    expect(rows).toHaveLength(6);
    for (const r of rows!) {
      expect(r).toMatchObject({ document_id: n26.documentId, import_job_id: n26.jobId, source: "import", extraction: "exact", status: "posted" });
      expect(r.source_row).toBeGreaterThan(1);
      expect(r.raw).toBeTypeOf("object");
    }
    const foreign = rows!.find((r) => r.original_currency === "USD");
    expect(foreign).toMatchObject({ currency: "EUR" });
    expect(toPlain(foreign!.amount)).toBe("-23");
    expect(toPlain(foreign!.original_amount!)).toBe("-25");

    // The account was created under the identified institution, synced by import.
    const { data: account } = await user.client
      .from("accounts")
      .select("type, currency, country, sync_source, last_synced_at, entity_id, institution:institutions(slug)")
      .eq("id", rows![0]!.account_id)
      .single();
    expect(account).toMatchObject({ type: "checking", currency: "EUR", country: "DE", sync_source: "import", entity_id: user.personalEntityId });
    expect(account!.last_synced_at).toBeTruthy();
  });

  it("is idempotent: the same file is reported as already imported, re-processing adds nothing", async () => {
    const again = await upload(user, "n26.csv");
    expect(again).toEqual({ documentId: n26.documentId, jobId: n26.jobId, format: "csv", alreadyImported: true });

    const before = await countTransactions(user.client, { documentId: n26.documentId });
    const reprocess = await upload(user, "n26.csv", { reprocess: true });
    expect(reprocess.documentId).toBe(n26.documentId);
    expect(reprocess.jobId).not.toBe(n26.jobId);
    expect(reprocess.alreadyImported).toBe(false);

    // No bytes passed: the pipeline downloads the stored original.
    const outcome = await runImportJob(user.client, user.id, reprocess.jobId, { today: TODAY, ai });
    expect(outcome.status).toBe("completed");
    expect(outcome.stats).toMatchObject({ transactionsOrganized: 0, duplicatesSkipped: 6, accountsIdentified: 1 });
    expect(await countTransactions(user.client, { documentId: n26.documentId })).toBe(before);

    const { count: accounts } = await user.client.from("accounts").select("id", { count: "exact", head: true });
    expect(accounts).toBe(1);

    // A finished job is never run twice.
    expect((await runImportJob(user.client, user.id, reprocess.jobId, { today: TODAY, ai })).status).toBe("skipped");
  });

  it("imports a Revolut CSV with two currency pockets, pending rows and balances; skipped rows create no review work", async () => {
    const result = await upload(user, "revolut.csv");
    const outcome = await runImportJob(user.client, user.id, result.jobId, { bytes: fixture("revolut.csv"), today: TODAY, ai });
    // DECLINED/REVERTED rows never moved money: they are skipped (informational), not unreadable,
    // so they do not create review work.
    expect(outcome.status).toBe("completed");
    expect(outcome.stats).toMatchObject({ transactionsOrganized: 10, accountsIdentified: 2, warnings: 2, institution: { slug: "revolut" } });

    const { data: rows } = await user.client.from("transactions").select("account_id, currency, status").eq("document_id", result.documentId);
    expect(rows).toHaveLength(10);
    expect(rows!.filter((r) => r.status === "pending")).toHaveLength(1);
    expect(new Set(rows!.map((r) => r.currency))).toEqual(new Set(["EUR", "USD"]));
    const accountIds = [...new Set(rows!.map((r) => r.account_id))];
    expect(accountIds).toHaveLength(2);

    const { data: balances } = await user.client
      .from("account_balances")
      .select("account_id, as_of, balance:balance::text, source, document_id")
      .in("account_id", accountIds)
      .order("as_of");
    expect(balances!.every((b) => b.source === "import" && b.document_id === result.documentId)).toBe(true);
    // Opening balances are the balance BEFORE the first transaction: stored as the previous day's close.
    expect(balances!.map((b) => [b.as_of, toPlain(b.balance)])).toEqual([
      ["2026-02-28", "0"],
      ["2026-03-03", "0"],
      ["2026-03-04", "108"],
      ["2026-03-08", "622.51"],
    ]);

    const { data: inbox } = await user.client.from("inbox_items").select("kind, payload, status").eq("document_id", result.documentId);
    expect((inbox ?? []).filter((i) => i.kind === "document_incomplete")).toEqual([]);
    const { data: doc } = await user.client.from("documents").select("status").eq("id", result.documentId).single();
    expect(doc!.status).toBe("processed");
  });

  it("stores only the masked identifier and its hash for an OFX account", async () => {
    const result = await upload(user, "nubank-card.ofx");
    expect(result.format).toBe("ofx");
    const outcome = await runImportJob(user.client, user.id, result.jobId, { bytes: fixture("nubank-card.ofx"), today: TODAY, ai });
    expect(outcome.status).toBe("completed");
    expect(outcome.stats).toMatchObject({ transactionsOrganized: 5, institution: { slug: "nubank" }, format: "ofx" });

    const { data: doc } = await user.client.from("documents").select("mime_type").eq("id", result.documentId).single();
    expect(doc!.mime_type).toBe("application/x-ofx");

    const { data: accounts } = await user.client.from("accounts").select("*").eq("user_id", user.id);
    const card = accounts!.find((a) => a.type === "credit_card");
    expect(card).toMatchObject({ account_mask: "4321", external_ref_hash: hashIdentifier("0000-0000-0000-4321"), currency: "BRL" });
    const everything = JSON.stringify(accounts);
    for (const full of ["0000-0000-0000-4321", "0000000000004321"]) expect(everything).not.toContain(full);

    const { data: balance } = await user.client.from("account_balances").select("as_of, balance:balance::text").eq("account_id", card!.id).single();
    expect(balance!.as_of).toBe("2026-03-31");
    expect(toPlain(balance!.balance)).toBe("-512.3");

    const { data: foreign } = await user.client
      .from("transactions")
      .select("external_id, original_currency")
      .eq("account_id", card!.id)
      .not("original_currency", "is", null);
    expect(foreign).toEqual([expect.objectContaining({ external_id: "card-0003", original_currency: "USD" })]);
  });

  it("puts business-variant statements (Nubank PJ) under a business entity", async () => {
    const result = await upload(user, "nubank-pj.csv");
    const outcome = await runImportJob(user.client, user.id, result.jobId, { bytes: fixture("nubank-pj.csv"), today: TODAY, ai });
    expect(outcome.stats).toMatchObject({ institution: { slug: "nubank-pj" }, transactionsOrganized: 4 });
    const { data: rows } = await user.client.from("transactions").select("account_id").eq("document_id", result.documentId).limit(1);
    const { data: account } = await user.client.from("accounts").select("entity:financial_entities(kind, name)").eq("id", rows![0]!.account_id).single();
    expect(account!.entity).toMatchObject({ kind: "business", name: "Nubank PJ" });
  });

  it("imports statements from unknown banks and asks about the institution and the account", async () => {
    const result = await upload(user, "generic-unknown-bank.csv");
    const outcome = await runImportJob(user.client, user.id, result.jobId, { bytes: fixture("generic-unknown-bank.csv"), today: TODAY, ai });
    expect(outcome.status).toBe("needs_review");
    expect(outcome.stats).toMatchObject({ transactionsOrganized: 4, institution: null });
    expect(outcome.stats!.reviewItems).toBeGreaterThanOrEqual(2);
    const { data: inbox } = await user.client.from("inbox_items").select("kind, payload, account_id").eq("document_id", result.documentId).order("kind");
    expect(inbox!.map((i) => i.kind)).toEqual(["account_confirmation", "unknown_institution"]);
    expect(inbox![1]!.payload).toEqual({ file: "generic-unknown-bank.csv", documentId: result.documentId });
    expect(inbox![0]!.account_id).toBeTruthy();
  });

  it("imports a text PDF statement (stored as application/pdf, AI assist only for unread lines)", async () => {
    const bytes = buildPdf([
      [
        "Banco Exemplo Ficticio S.A. - Extrato de Conta Corrente - valores em R$",
        "Periodo: 01/03/2026 a 31/03/2026",
        "05/03/2026  PAG*NETFLIX  -39,90",
        "06/03/2026  SALARIO EMPRESA FICTICIA  3.500,00",
        "Compra em 08/03/2026 LOJA EXEMPLO -45,00",
      ],
    ]);
    const result = await receiveUpload(user.client, user.id, { bytes, filename: "extrato.pdf", mimeType: "application/pdf" }, { maxBytes: MAX_BYTES });
    expect(result.format).toBe("pdf");
    const outcome = await runImportJob(user.client, user.id, result.jobId, { bytes, today: TODAY, ai });
    expect(["completed", "needs_review"]).toContain(outcome.status);
    expect(outcome.stats!.transactionsOrganized).toBeGreaterThanOrEqual(2);
    const { data: doc } = await user.client.from("documents").select("mime_type, detected_format").eq("id", result.documentId).single();
    expect(doc).toEqual({ mime_type: "application/pdf", detected_format: "pdf" });
    const { data: rows } = await user.client.from("transactions").select("extraction, source_row").eq("document_id", result.documentId);
    expect(rows!.every((r) => r.extraction === "heuristic" || r.extraction === "ai")).toBe(true);
    const { data: job } = await user.client.from("import_jobs").select("ai_provider").eq("id", result.jobId).single();
    expect(job!.ai_provider).toBe("mock");
  });

  it("counts recurring series that include transactions of the import", async () => {
    const csv = [
      "Date,Description,Amount",
      "2026-07-05,STREAMFLIX MONTHLY,-15.99",
      "2026-07-12,PADARIA EXEMPLO,-8.40",
      "2026-08-05,STREAMFLIX MONTHLY,-15.99",
      "2026-08-19,MERCADO EXEMPLO,-52.10",
      "2026-09-05,STREAMFLIX MONTHLY,-15.99",
      "2026-10-05,STREAMFLIX MONTHLY,-15.99",
    ].join("\n");
    const bytes = new TextEncoder().encode(csv);
    const result = await receiveUpload(user.client, user.id, { bytes, filename: "recurring.csv" }, { maxBytes: MAX_BYTES });
    const outcome = await runImportJob(user.client, user.id, result.jobId, { bytes, today: TODAY, ai: null });
    expect(outcome.stats).toMatchObject({ transactionsOrganized: 6, recurringDetected: 1 });
    const { data: job } = await user.client.from("import_jobs").select("ai_provider").eq("id", result.jobId).single();
    expect(job!.ai_provider).toBeNull();
  });

  it("rejects unsupported, empty and oversized uploads before storing anything", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const cases: [Uint8Array, string, number, string][] = [
      [png, "statement.csv", MAX_BYTES, "unsupported"],
      [new Uint8Array(), "empty.csv", MAX_BYTES, "empty"],
      [new TextEncoder().encode("  \n\r\n"), "blank.csv", MAX_BYTES, "empty"],
      [fixture("n26.csv"), "n26-copy.csv", 100, "too_large"],
    ];
    for (const [bytes, filename, maxBytes, code] of cases) {
      const error = await receiveUpload(user.client, user.id, { bytes, filename }, { maxBytes }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UploadRejectedError);
      expect((error as UploadRejectedError).code).toBe(code);
    }
    const { data: docs } = await user.client.from("documents").select("original_filename");
    expect(docs!.map((d) => d.original_filename)).not.toContain("statement.csv");
  });

  it("marks a job failed with a safe error when the document has no readable transactions", async () => {
    const bytes = new TextEncoder().encode("Date,Description,Amount\n");
    const result = await receiveUpload(user.client, user.id, { bytes, filename: "header-only.csv" }, { maxBytes: MAX_BYTES });
    const outcome = await runImportJob(user.client, user.id, result.jobId, { bytes, today: TODAY, ai: null });
    expect(outcome).toMatchObject({ status: "failed", errorCode: "unreadable" });
    const { data: job } = await user.client.from("import_jobs").select("status, error_code, error_message").eq("id", result.jobId).single();
    expect(job).toEqual({ status: "failed", error_code: "unreadable", error_message: "No transactions could be read from this document." });
    // A failed import can be retried with the same file.
    const retry = await receiveUpload(user.client, user.id, { bytes, filename: "header-only.csv" }, { maxBytes: MAX_BYTES });
    expect(retry).toMatchObject({ documentId: result.documentId, alreadyImported: false });
    expect(retry.jobId).not.toBe(result.jobId);
  });

  it("keeps documents, jobs, transactions and originals private to their owner", async () => {
    const { data: doc } = await user.client.from("documents").select("storage_path").eq("id", n26.documentId).single();

    const { data: docs } = await other.client.from("documents").select("id").eq("id", n26.documentId);
    expect(docs).toEqual([]);
    const { data: jobs } = await other.client.from("import_jobs").select("id").eq("id", n26.jobId);
    expect(jobs).toEqual([]);
    expect(await countTransactions(other.client, { documentId: n26.documentId })).toBe(0);
    const { data: blob, error } = await other.client.storage.from("documents").download(doc!.storage_path);
    expect(blob).toBeNull();
    expect(error).toBeTruthy();

    // Another user cannot run (or even see) someone else's job.
    const outcome = await runImportJob(other.client, other.id, n26.jobId, { today: TODAY, ai });
    expect(outcome.status).toBe("skipped");
    // Nor upload into someone else's folder.
    const { error: uploadError } = await other.client.storage
      .from("documents")
      .upload(`${user.id}/intrusion/x.csv`, new TextEncoder().encode("a,b\n1,2\n"), { contentType: "text/csv" });
    expect(uploadError).toBeTruthy();
  });
});
