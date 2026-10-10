/**
 * Import pipeline: turns a stored statement into accounts, transactions and
 * balance snapshots, then runs the shared post-processing (transfers,
 * duplicates, recurring payments, Smart Inbox, insights).
 *
 * Guarantees
 * - Idempotent: rows are keyed by (account_id, fingerprint); re-running a job or
 *   re-importing an overlapping statement never duplicates transactions.
 * - Provenance: every row keeps document_id, import_job_id, source_row,
 *   extraction and the parser's raw per-row values; originals are never converted.
 * - Data is never lost: unknown institutions or weakly identified accounts are
 *   still imported and raised as Smart Inbox questions.
 * - Privacy: full account identifiers only exist in memory (hash + last 4 are
 *   stored); document text and rows are never logged; job errors carry a short
 *   safe message only.
 * - Works with a user-scoped (RLS) client and with the worker's service-role
 *   client: every query is filtered by user id.
 */
import "server-only";
import { addDaysIso } from "@/domain/analytics/periods";
import type { AccountType, DocumentFormat, ParsedAccount, ParsedStatement, ParseWarning } from "@/domain/import/types";
import { dec, isDecimalString } from "@/domain/money/decimal";
import { cleanDescription, computeFingerprints, hashIdentifier, maskIdentifier } from "@/domain/transactions/normalize";
import type { AiService } from "../ai";
import { categorizeBatch, loadRules, persistLearnedRules, type CategorizeInput } from "../processing/categorize";
import { postProcessUser } from "../processing/post-process";
import type { Json } from "../supabase/database.types";
import { dbNumeric } from "../supabase/numeric";
import type { MonioClient } from "../supabase/server";
import { workerPdfLearningStore } from "./pdf-learning-store";
import { detectFormat } from "./detect-format";
import { DOCUMENTS_BUCKET, sha256Hex, UploadRejectedError } from "./intake";
import { DocumentLimitError, EmptyDocumentError, parseDocument, UnsupportedDocumentError, type PdfAiAssist } from "./parse-document";

// ---------------------------------------------------------------------------
// Stages, errors and stats (pure, unit-tested)
// ---------------------------------------------------------------------------

/** Ordered pipeline stages; the UI translates `import.stage_<name>`. */
export const IMPORT_STAGES = [
  "validating",
  "stored",
  "detecting",
  "identifying",
  "extracting",
  "normalizing",
  "deduplicating",
  "categorizing",
  "reconciling",
  "recurring",
  "persisting",
  "completed",
] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

/** Progress (0..100) reported when a stage starts. `received` is the intake stage. */
export const STAGE_PROGRESS: Readonly<Record<ImportStage | "received", number>> = {
  received: 0,
  validating: 5,
  stored: 10,
  detecting: 15,
  identifying: 25,
  extracting: 35,
  normalizing: 45,
  deduplicating: 55,
  categorizing: 65,
  reconciling: 75,
  recurring: 85,
  persisting: 92,
  completed: 100,
};

export function stageProgress(stage: string): number {
  return (STAGE_PROGRESS as Record<string, number>)[stage] ?? 0;
}

export type ImportErrorCode = "unsupported" | "empty" | "too_large" | "unreadable" | "limit" | "internal";

/** Failure with a known, user-presentable code. */
export class ImportJobError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode, message?: string) {
    super(message ?? SAFE_ERROR_MESSAGES[code]);
    this.name = "ImportJobError";
    this.code = code;
  }
}

/** Short messages stored on failed jobs: never document content, paths or stack traces. */
export const SAFE_ERROR_MESSAGES: Readonly<Record<ImportErrorCode, string>> = {
  unsupported: "The file is not a supported statement format (CSV, OFX, XLSX or PDF).",
  empty: "The file is empty.",
  too_large: "The file exceeds the maximum allowed size.",
  unreadable: "No transactions could be read from this document.",
  limit: "The document exceeds the processing limits (size, pages or rows).",
  internal: "The import failed because of an internal error.",
};

/** Maps any thrown value to a job error code. The pipeline has already validated the format. */
export function toImportErrorCode(error: unknown): ImportErrorCode {
  if (error instanceof ImportJobError) return error.code;
  if (error instanceof UploadRejectedError) return error.code;
  if (error instanceof EmptyDocumentError) return "empty";
  if (error instanceof DocumentLimitError) return "limit";
  // Detected as CSV/OFX/XLSX/PDF but the parser could not read it (corrupted, encrypted, unknown layout).
  if (error instanceof UnsupportedDocumentError) return "unreadable";
  return "internal";
}

/** Safe one-line description for server logs (error class and DB code only, never messages or values). */
export function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const name = error instanceof Error ? error.name : "object";
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code) ? `${name} (${code})` : name;
  }
  return typeof error;
}

/** Jobs stuck in `processing` longer than this may be claimed again. */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;

export function isStaleProcessing(startedAt: string | null, nowMs: number): boolean {
  if (!startedAt) return true;
  const started = Date.parse(startedAt);
  return !Number.isFinite(started) || nowMs - started > STALE_PROCESSING_MS;
}

export interface ImportStats {
  transactionsOrganized: number;
  duplicatesSkipped: number;
  accountsIdentified: number;
  recurringDetected: number;
  reviewItems: number;
  warnings: number;
  institution: { slug: string; name: string } | null;
  format: DocumentFormat;
  period: { start: string; end: string } | null;
}

export interface ImportJobOutcome {
  jobId: string;
  /** `skipped`: job not found for this user, already finished, or being processed elsewhere. */
  status: "completed" | "needs_review" | "failed" | "skipped";
  errorCode?: ImportErrorCode;
  stats?: ImportStats;
}

export interface RunImportDeps {
  /** Original bytes when the caller still has them; otherwise downloaded from storage. */
  bytes?: Uint8Array;
  /** YYYY-MM-DD used by post-processing. */
  today: string;
  /** AI service (already gated by the user's cloud consent) or null: rules only. */
  ai: AiService | null;
  now?: () => Date;
}

/** Warning codes meaning some lines were not read (or read ambiguously): the user should look. */
export const INCOMPLETE_WARNING_CODES: ReadonlySet<ParseWarning["code"]> = new Set([
  "row_unreadable",
  "missing_amount",
  "missing_date",
  "unknown_currency",
  "ambiguous_date_order",
  "ambiguous_decimal_separator",
  "balance_mismatch",
  "unsupported_layout",
  "ai_rejected_row",
]);

/** Number of affected lines: distinct rows, plus one per document-level warning. */
export function incompleteLineCount(warnings: readonly ParseWarning[], extraRows: Iterable<number> = []): number {
  const rows = new Set<number>(extraRows);
  let documentLevel = 0;
  for (const w of warnings) {
    if (!INCOMPLETE_WARNING_CODES.has(w.code)) continue;
    if (typeof w.row === "number") rows.add(w.row);
    else documentLevel++;
  }
  return rows.size + documentLevel;
}

/** Business variants of an institution (e.g. Nubank PJ) go to a business entity. */
export function isBusinessVariant(institutionSlug?: string | null, profile?: string | null): boolean {
  return [institutionSlug, profile].some((v) => typeof v === "string" && /(^|-)pj($|-)/.test(v));
}

const TYPE_LABELS: Readonly<Record<"en" | "pt" | "it", Record<AccountType, string>>> = {
  en: {
    checking: "Checking",
    savings: "Savings",
    credit_card: "Credit card",
    investment: "Investments",
    loan: "Loan",
    mortgage: "Mortgage",
    crypto_wallet: "Wallet",
    cash: "Cash",
    other: "Account",
  },
  pt: {
    checking: "Conta corrente",
    savings: "Poupança",
    credit_card: "Cartão de crédito",
    investment: "Investimentos",
    loan: "Empréstimo",
    mortgage: "Financiamento imobiliário",
    crypto_wallet: "Carteira",
    cash: "Dinheiro",
    other: "Conta",
  },
  it: {
    checking: "Conto corrente",
    savings: "Risparmio",
    credit_card: "Carta di credito",
    investment: "Investimenti",
    loan: "Prestito",
    mortgage: "Mutuo",
    crypto_wallet: "Wallet",
    cash: "Contanti",
    other: "Conto",
  },
};

export function accountTypeLabel(type: AccountType, locale: string): string {
  const labels = TYPE_LABELS[(locale in TYPE_LABELS ? locale : "en") as keyof typeof TYPE_LABELS];
  return labels[type];
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Name for an account created by an import (≤ 120 chars). */
export function deriveAccountName(opts: {
  institutionName?: string | null;
  parsedName?: string | null;
  type: AccountType;
  locale: string;
  /** Institution name found in the document but not in the catalog (e.g. OFX ORG). */
  hintName?: string | null;
}): string {
  const parsed = opts.parsedName?.trim();
  const brand = opts.institutionName?.trim() || opts.hintName?.trim() || "";
  const label = accountTypeLabel(opts.type, opts.locale);
  let name: string;
  if (parsed) name = brand && !fold(parsed).includes(fold(brand)) ? `${brand} ${parsed}` : parsed;
  else if (!brand) name = label;
  else name = fold(brand).includes(fold(label)) ? brand : `${brand} ${label}`;
  return [...name].slice(0, 120).join("").trim() || label;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Balance snapshots (end of day) for an account. Opening balances describe the
 * balance BEFORE the first transaction: when dated on/after the first
 * transaction day they are stored as the previous day's closing. A closing
 * balance on the same date wins.
 */
export function balanceSnapshots(account: Pick<ParsedAccount, "openingBalance" | "closingBalance">, firstBookedOn?: string): { asOf: string; amount: string }[] {
  const out = new Map<string, string>();
  const valid = (b?: { amount: string; asOf: string }) => b && ISO_DATE.test(b.asOf) && isDecimalString(b.amount);
  if (valid(account.openingBalance)) {
    const opening = account.openingBalance!;
    const asOf = firstBookedOn && opening.asOf >= firstBookedOn ? addDaysIso(firstBookedOn, -1) : opening.asOf;
    out.set(asOf, opening.amount);
  }
  if (valid(account.closingBalance)) out.set(account.closingBalance!.asOf, account.closingBalance!.amount);
  return [...out].map(([asOf, amount]) => ({ asOf, amount }));
}

/** Adapts the AI service to the PDF parser hook. Never throws; failures mean "no proposals". */
export function pdfAiAssist(ai: AiService, onUse?: () => void): PdfAiAssist {
  return async (lines) => {
    onUse?.();
    const result = await ai.proposeStatementRows(lines);
    if (!result.ok) return [];
    return result.data.map((r) => ({
      line: r.line,
      date: r.date,
      description: r.description,
      amount: r.amount,
      ...(r.currency ? { currency: r.currency } : {}),
    }));
  };
}

/** Raw per-row provenance, bounded so a hostile file cannot bloat the database. */
function boundedRaw(raw: Record<string, string> | undefined): Json {
  const out: Record<string, string> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (n++ >= 40) break;
    out[key.slice(0, 80)] = typeof value === "string" ? value.slice(0, 500) : String(value).slice(0, 500);
  }
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

interface ExistingAccount {
  id: string;
  name: string;
  type: string;
  currency: string;
  institution_id: string | null;
  account_mask: string | null;
  external_ref_hash: string | null;
  is_archived: boolean;
}

interface CatalogInstitution {
  id: string;
  slug: string;
  name: string;
  country: string | null;
}

interface ResolvedAccount {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  created: boolean;
  /** Created without identifier and without institution: ask the user. */
  needsConfirmation: boolean;
}

interface InboxDraft {
  kind: "unknown_institution" | "document_incomplete" | "account_confirmation";
  dedupe_key: string;
  priority: number;
  payload: { [key: string]: Json | undefined };
  account_id?: string | null;
  document_id: string;
}

async function upsertInbox(db: MonioClient, userId: string, items: InboxDraft[]): Promise<number> {
  if (items.length === 0) return 0;
  const { data, error } = await db
    .from("inbox_items")
    .upsert(
      items.map((i) => ({ ...i, user_id: userId, transaction_ids: [] })),
      { onConflict: "user_id,dedupe_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

class AccountResolver {
  private claimed = new Set<string>();
  private personalEntityId: string | null = null;
  private businessEntityId: string | null = null;

  constructor(
    private readonly db: MonioClient,
    private readonly userId: string,
    private readonly existing: ExistingAccount[],
    private readonly nowIso: string,
  ) {}

  private async entityFor(business: boolean, institution: CatalogInstitution | null): Promise<string> {
    const { db, userId } = this;
    if (!business) {
      if (this.personalEntityId) return this.personalEntityId;
      const { data, error } = await db
        .from("financial_entities")
        .select("id")
        .eq("user_id", userId)
        .eq("kind", "personal")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (data) return (this.personalEntityId = data.id);
      const created = await db.from("financial_entities").insert({ user_id: userId, name: "Personal", kind: "personal" }).select("id").single();
      if (created.error) throw created.error;
      return (this.personalEntityId = created.data.id);
    }
    if (this.businessEntityId) return this.businessEntityId;
    const { data, error } = await db
      .from("financial_entities")
      .select("id")
      .eq("user_id", userId)
      .eq("kind", "business")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return (this.businessEntityId = data.id);
    const created = await db
      .from("financial_entities")
      .insert({ user_id: userId, name: (institution?.name ?? "Business").slice(0, 80), kind: "business", country: institution?.country ?? null })
      .select("id")
      .single();
    if (created.error) throw created.error;
    return (this.businessEntityId = created.data.id);
  }

  async resolve(args: {
    parsed: ParsedAccount;
    type: AccountType;
    currency: string;
    institution: CatalogInstitution | null;
    business: boolean;
    name: string;
    /** Parsed accounts in this document sharing the same weak key. */
    siblings: number;
  }): Promise<ResolvedAccount> {
    const { parsed, type, currency, institution, name } = args;
    const identifier = parsed.identifier?.trim() || undefined;
    const hash = identifier ? hashIdentifier(identifier) : null;
    const rawMask = parsed.identifierMask?.trim() || (identifier ? maskIdentifier(identifier) : "");
    const mask = rawMask ? rawMask.slice(-4) : null;
    const institutionId = institution?.id ?? null;

    const take = async (account: ExistingAccount): Promise<ResolvedAccount> => {
      this.claimed.add(account.id);
      // Learn the identity of a weakly matched account (never the full identifier).
      const patch: { external_ref_hash?: string; account_mask?: string } = {};
      if (hash && !account.external_ref_hash) patch.external_ref_hash = hash;
      if (mask && !account.account_mask) patch.account_mask = mask;
      if (Object.keys(patch).length) {
        const { error } = await this.db.from("accounts").update(patch).eq("id", account.id).eq("user_id", this.userId);
        if (error && error.code !== "23505") throw error;
        if (!error) Object.assign(account, patch);
      }
      return { id: account.id, name: account.name, type: account.type as AccountType, currency: account.currency, created: false, needsConfirmation: false };
    };

    // 1. Strong identity: hash of the full identifier.
    if (hash) {
      const byHash = this.existing.find((a) => a.external_ref_hash === hash);
      if (byHash) return take(byHash);
    }

    // 2. Weak identity: institution + type + currency (+ last 4 when known).
    const candidates = this.existing.filter(
      (a) =>
        !a.is_archived &&
        !this.claimed.has(a.id) &&
        a.institution_id === institutionId &&
        a.type === type &&
        a.currency === currency &&
        (!hash || !a.external_ref_hash || a.external_ref_hash === hash) &&
        (!mask || !a.account_mask || a.account_mask === mask),
    );
    const byName = candidates.find((a) => a.name === name || (parsed.name && a.name === parsed.name));
    const byMask = mask ? candidates.filter((a) => a.account_mask === mask) : [];
    let match: ExistingAccount | undefined;
    if (!institutionId && !mask) {
      // Nothing identifies the account: only the same derived name is the same account.
      match = byName;
    } else if (byMask.length === 1) {
      match = byMask[0];
    } else if (byName) {
      match = byName;
    } else if (candidates.length === 1 && args.siblings <= 1) {
      match = candidates[0];
    }
    if (match) return take(match);
    const ambiguous = candidates.length > 0;

    // 3. Create.
    const entityId = await this.entityFor(args.business, institution);
    const country = institution?.country ?? (parsed.country && /^[A-Z]{2}$/.test(parsed.country) ? parsed.country : null);
    const insert = {
      user_id: this.userId,
      entity_id: entityId,
      institution_id: institutionId,
      name,
      type,
      currency,
      country,
      account_mask: mask,
      external_ref_hash: hash,
      sync_source: "import",
      last_synced_at: this.nowIso,
    };
    const { data, error } = await this.db.from("accounts").insert(insert).select("id").single();
    if (error) {
      if (error.code === "23505" && hash) {
        // Created concurrently by another import of the same account.
        const { data: again, error: againError } = await this.db
          .from("accounts")
          .select("id, name, type, currency, institution_id, account_mask, external_ref_hash, is_archived")
          .eq("user_id", this.userId)
          .eq("external_ref_hash", hash)
          .maybeSingle();
        if (againError) throw againError;
        if (again) {
          this.existing.push(again);
          return take(again);
        }
      }
      throw error;
    }
    const created: ExistingAccount = {
      id: data.id,
      name,
      type,
      currency,
      institution_id: institutionId,
      account_mask: mask,
      external_ref_hash: hash,
      is_archived: false,
    };
    this.existing.push(created);
    this.claimed.add(created.id);
    return {
      id: created.id,
      name,
      type,
      currency,
      created: true,
      needsConfirmation: (!identifier && !institutionId) || ambiguous,
    };
  }
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  document_id: string;
  status: string;
  started_at: string | null;
  attempt: number;
}

/** Atomically moves a queued (or stale processing) job to processing. Returns false if someone else has it. */
async function claimJob(db: MonioClient, userId: string, job: JobRow, nowIso: string, nowMs: number): Promise<boolean> {
  const base = {
    status: "processing",
    stage: "validating",
    progress: STAGE_PROGRESS.validating,
    started_at: nowIso,
    finished_at: null,
    error_code: null,
    error_message: null,
  };
  if (job.status === "queued") {
    const { data, error } = await db.from("import_jobs").update(base).eq("id", job.id).eq("user_id", userId).eq("status", "queued").select("id");
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }
  if (job.status === "processing" && isStaleProcessing(job.started_at, nowMs)) {
    const cutoff = new Date(nowMs - STALE_PROCESSING_MS).toISOString();
    let query = db
      .from("import_jobs")
      .update({ ...base, attempt: Math.min(job.attempt + 1, 32767) })
      .eq("id", job.id)
      .eq("user_id", userId)
      .eq("status", "processing");
    query = job.started_at ? query.lt("started_at", cutoff) : query.is("started_at", null);
    const { data, error } = await query.select("id");
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  }
  return false;
}

/**
 * Runs one import job end to end. Never throws: failures are recorded on the job
 * (status failed, error_code, safe message) and returned.
 */
export async function runImportJob(db: MonioClient, userId: string, jobId: string, deps: RunImportDeps): Promise<ImportJobOutcome> {
  const now = deps.now ?? (() => new Date());
  let job: JobRow | null;
  try {
    const { data, error } = await db
      .from("import_jobs")
      .select("id, document_id, status, started_at, attempt")
      .eq("id", jobId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    job = data;
    if (!job) return { jobId, status: "skipped" };
    const started = now();
    if (!(await claimJob(db, userId, job, started.toISOString(), started.getTime()))) return { jobId, status: "skipped" };
  } catch (error) {
    console.error(`[import] job ${jobId}: could not be claimed: ${describeError(error)}`);
    return { jobId, status: "skipped" };
  }

  const state = { stage: "validating" as ImportStage, documentId: job.document_id };
  try {
    return await processJob(db, userId, job, deps, now, state);
  } catch (error) {
    const code = toImportErrorCode(error);
    if (code === "internal") console.error(`[import] job ${jobId} failed at stage ${state.stage}: ${describeError(error)}`);
    try {
      await db
        .from("import_jobs")
        .update({
          status: "failed",
          error_code: code,
          error_message: SAFE_ERROR_MESSAGES[code].slice(0, 500),
          finished_at: now().toISOString(),
        })
        .eq("id", jobId)
        .eq("user_id", userId);
      await db.from("documents").update({ status: "failed" }).eq("id", state.documentId).eq("user_id", userId);
    } catch (recordError) {
      console.error(`[import] job ${jobId}: failure could not be recorded: ${describeError(recordError)}`);
    }
    return { jobId, status: "failed", errorCode: code };
  }
}

async function processJob(
  db: MonioClient,
  userId: string,
  job: JobRow,
  deps: RunImportDeps,
  now: () => Date,
  state: { stage: ImportStage; documentId: string },
): Promise<ImportJobOutcome> {
  const jobStartedAt = now().toISOString();
  const setStage = async (stage: ImportStage) => {
    state.stage = stage;
    const { error } = await db.from("import_jobs").update({ stage, progress: STAGE_PROGRESS[stage] }).eq("id", job.id).eq("user_id", userId);
    if (error) throw error;
  };

  // validating ------------------------------------------------------------------
  const { data: doc, error: docError } = await db
    .from("documents")
    .select("id, storage_path, original_filename, mime_type, sha256")
    .eq("id", job.document_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (docError) throw docError;
  if (!doc || !doc.storage_path.startsWith(`${userId}/`)) throw new ImportJobError("internal");
  {
    const { error } = await db.from("documents").update({ status: "processing" }).eq("id", doc.id).eq("user_id", userId);
    if (error) throw error;
  }
  const { data: profile, error: profileError } = await db.from("profiles").select("primary_currency, locale").eq("id", userId).maybeSingle();
  if (profileError) throw profileError;
  const locale = profile?.locale ?? "en";
  const primaryCurrency = profile?.primary_currency ?? "EUR";

  // stored -----------------------------------------------------------------------
  await setStage("stored");
  let bytes = deps.bytes;
  if (!bytes) {
    const { data: blob, error } = await db.storage.from(DOCUMENTS_BUCKET).download(doc.storage_path);
    if (error || !blob) throw error ?? new ImportJobError("internal");
    bytes = new Uint8Array(await blob.arrayBuffer());
  }
  if (bytes.length === 0) throw new ImportJobError("empty");
  // The stored original and the bytes being parsed must be the same document.
  if (sha256Hex(bytes) !== doc.sha256) throw new ImportJobError("internal");

  // detecting --------------------------------------------------------------------
  await setStage("detecting");
  const format = detectFormat(bytes, doc.original_filename, doc.mime_type);
  if (!format) throw new ImportJobError("unsupported");

  // identifying (parsing reads the institution signature together with the rows) --
  await setStage("identifying");
  let aiUsed = false;
  const ai = deps.ai;
  const statement: ParsedStatement = await parseDocument(
    { bytes, filename: doc.original_filename, mimeType: doc.mime_type },
    {
      filename: doc.original_filename,
      fallbackCurrency: primaryCurrency,
      ...(ai && format === "pdf" ? { aiAssist: pdfAiAssist(ai, () => (aiUsed = true)) } : {}),
      ...(ai && format === "pdf" && ai.mode !== "mock" && ai.mode !== "disabled" ? {
        pdfLearning: workerPdfLearningStore(db, userId, doc.sha256),
        documentAssist: async (lines: import("../ai/document-contract").DocumentLine[]) => {
          aiUsed = true;
          console.info(`[import] job ${job.id}: document AI started`);
          const result = await ai.interpretDocument(lines, {
            onProgress: async (completed, total) => {
              const progress = STAGE_PROGRESS.identifying + Math.floor(9 * completed / total);
              const { error } = await db.from("import_jobs").update({ progress }).eq("id", job.id).eq("user_id", userId);
              if (error) throw error;
            },
          });
          console.info(`[import] job ${job.id}: document AI ${result.ok ? "completed" : "failed"}`);
          if (!result.ok) throw new Error("Document AI unavailable");
          return { batches: result.data, skippedLines: result.meta.skippedLines ?? [] };
        },
      } : {}),
    },
  );
  let institution: CatalogInstitution | null = null;
  const hintSlug = statement.institution?.slug;
  if (hintSlug) {
    const { data, error } = await db.from("institutions").select("id, slug, name, country").is("owner_id", null).eq("slug", hintSlug).maybeSingle();
    if (error) throw error;
    institution = data;
  }
  // A source-verified issuer outside our catalog becomes a private institution,
  // with a stable key across monthly imports. RLS still scopes every operation.
  if (!institution && !hintSlug && statement.profile === "pdf-with-document-ai" && statement.institution?.name) {
    const name = statement.institution.name.slice(0, 120);
    const slug = `import-${hashIdentifier(fold(name).replace(/\s+/g, " ")).slice(0, 40)}`;
    const lookup = () => db.from("institutions").select("id, slug, name, country").eq("owner_id", userId).eq("slug", slug).maybeSingle();
    const existing = await lookup();
    if (existing.error) throw existing.error;
    institution = existing.data;
    if (!institution) {
      const created = await db.from("institutions").insert({ owner_id: userId, slug, name, kind: "bank" }).select("id, slug, name, country").single();
      if (created.error?.code === "23505") {
        const concurrent = await lookup();
        if (concurrent.error) throw concurrent.error;
        institution = concurrent.data;
        if (!institution) throw created.error;
      } else if (created.error) throw created.error;
      else institution = created.data;
    }
  }
  const business = isBusinessVariant(institution?.slug ?? hintSlug, statement.profile);

  // extracting: map parsed accounts to the user's accounts -------------------------
  await setStage("extracting");
  const totalParsed = statement.accounts.reduce((n, a) => n + a.transactions.length, 0);
  const hasBalances = statement.accounts.some((a) => a.closingBalance || a.openingBalance);
  if (totalParsed === 0 && !hasBalances) throw new ImportJobError("unreadable");

  const [{ data: currencyRows, error: currencyError }, { data: accountRows, error: accountsError }] = await Promise.all([
    db.from("currencies").select("code"),
    db.from("accounts").select("id, name, type, currency, institution_id, account_mask, external_ref_hash, is_archived").eq("user_id", userId),
  ]);
  if (currencyError) throw currencyError;
  if (accountsError) throw accountsError;
  const knownCurrencies = new Set((currencyRows ?? []).map((c) => c.code));
  const resolver = new AccountResolver(db, userId, accountRows ?? [], now().toISOString());

  const skippedRows: number[] = [];
  let zeroAmountRows = 0;
  const weakKey = (a: ParsedAccount) => `${a.type ?? "checking"}|${a.currency ?? ""}|${a.identifierMask ?? ""}`;
  const keyCounts = new Map<string, number>();
  for (const a of statement.accounts) keyCounts.set(weakKey(a), (keyCounts.get(weakKey(a)) ?? 0) + 1);

  const resolved: { parsed: ParsedAccount; account: ResolvedAccount }[] = [];
  for (const parsed of statement.accounts) {
    const currency = (parsed.currency ?? parsed.transactions[0]?.currency ?? primaryCurrency).toUpperCase();
    if (!knownCurrencies.has(currency)) {
      // Currency not in the catalog: the rows stay in the stored original and are raised for review.
      skippedRows.push(...parsed.transactions.map((t) => t.sourceRow));
      continue;
    }
    if (parsed.transactions.length === 0 && !parsed.closingBalance && !parsed.openingBalance) continue;
    const type: AccountType = parsed.type ?? "checking";
    const name = deriveAccountName({
      institutionName: institution?.name,
      parsedName: parsed.name,
      type,
      locale,
      hintName: institution ? null : statement.institution?.name,
    });
    const account = await resolver.resolve({ parsed, type, currency, institution, business, name, siblings: keyCounts.get(weakKey(parsed)) ?? 1 });
    resolved.push({ parsed, account });
  }
  if (resolved.length === 0) throw new ImportJobError("unreadable");

  // normalizing ------------------------------------------------------------------
  await setStage("normalizing");
  interface Candidate {
    key: string;
    accountId: string;
    accountType: AccountType;
    fingerprint: string;
    row: {
      booked_on: string;
      value_on: string | null;
      description_original: string;
      description_clean: string;
      amount: string;
      currency: string;
      original_amount: string | null;
      original_currency: string | null;
      external_id: string | null;
      source_row: number;
      extraction: string;
      raw: Json;
      status: "posted" | "pending";
    };
  }
  const candidates: Candidate[] = [];
  for (const [accountIndex, { parsed, account }] of resolved.entries()) {
    const kept = parsed.transactions.filter((tx) => {
      if (!knownCurrencies.has(tx.currency) || !ISO_DATE.test(tx.bookedOn) || !isDecimalString(tx.amount)) {
        skippedRows.push(tx.sourceRow);
        return false;
      }
      if (dec(tx.amount).isZero()) {
        zeroAmountRows++;
        return false;
      }
      return true;
    });
    const fingerprints = computeFingerprints(kept);
    kept.forEach((tx, i) => {
      const description = (tx.description || tx.counterparty || "-").slice(0, 500);
      const hasOriginal =
        !!tx.originalAmount && !!tx.originalCurrency && knownCurrencies.has(tx.originalCurrency) && isDecimalString(tx.originalAmount);
      candidates.push({
        key: `${accountIndex}:${i}`,
        accountId: account.id,
        accountType: account.type,
        fingerprint: fingerprints[i]!,
        row: {
          booked_on: tx.bookedOn,
          value_on: tx.valueOn && ISO_DATE.test(tx.valueOn) ? tx.valueOn : null,
          description_original: description,
          description_clean: cleanDescription(description),
          amount: tx.amount,
          currency: tx.currency,
          original_amount: hasOriginal ? tx.originalAmount! : null,
          original_currency: hasOriginal ? tx.originalCurrency! : null,
          external_id: tx.externalId ? tx.externalId.slice(0, 200) : null,
          source_row: tx.sourceRow,
          extraction: tx.extraction,
          raw: boundedRaw(tx.raw),
          status: tx.pending ? "pending" : "posted",
        },
      });
    });
  }
  const attempted = candidates.length;

  // deduplicating: rows already imported (same account + fingerprint) are skipped --
  await setStage("deduplicating");
  const seen = new Set<string>();
  const byAccount = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = `${c.accountId}|${c.fingerprint}`;
    if (seen.has(k)) continue;
    seen.add(k);
    byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
  }
  const fresh: Candidate[] = [];
  for (const [accountId, list] of byAccount) {
    const known = new Set<string>();
    for (const part of chunk(list.map((c) => c.fingerprint), 200)) {
      const { data, error } = await db.from("transactions").select("fingerprint").eq("user_id", userId).eq("account_id", accountId).in("fingerprint", part);
      if (error) throw error;
      for (const r of data ?? []) known.add(r.fingerprint);
    }
    fresh.push(...list.filter((c) => !known.has(c.fingerprint)));
  }

  // categorizing (rules first, AI only for leftovers) + writing -------------------
  await setStage("categorizing");
  const insertedIds: string[] = [];
  if (fresh.length > 0) {
    const [rules, { data: systemCategories, error: categoriesError }] = await Promise.all([
      loadRules(db, userId),
      db.from("categories").select("id, slug").is("user_id", null),
    ]);
    if (categoriesError) throw categoriesError;
    const systemCategoryIds = new Map((systemCategories ?? []).map((c) => [c.slug, c.id]));
    const country = institution?.country ?? null;
    const items: CategorizeInput[] = fresh.map((c) => ({
      key: c.key,
      description: c.row.description_original,
      amount: c.row.amount,
      currency: c.row.currency,
      bookedOn: c.row.booked_on,
      accountType: c.accountType,
      country,
    }));
    const { results, learned, aiUsed: categorizedWithAi } = await categorizeBatch(items, rules, systemCategoryIds, ai);
    if (categorizedWithAi) aiUsed = true;
    await persistLearnedRules(db, userId, learned);

    const documentId = doc.id;
    const rows = fresh.map((c) => {
      const cat = results.get(c.key);
      return {
        user_id: userId,
        account_id: c.accountId,
        booked_on: c.row.booked_on,
        value_on: c.row.value_on,
        description_original: c.row.description_original,
        description_clean: c.row.description_clean,
        merchant: cat?.merchant ? cat.merchant.slice(0, 80) : null,
        amount: dbNumeric(c.row.amount),
        currency: c.row.currency,
        original_amount: dbNumeric(c.row.original_amount),
        original_currency: c.row.original_currency,
        status: c.row.status,
        category_id: cat?.categoryId ?? null,
        category_source: cat?.source ?? null,
        category_confidence: cat?.confidence ?? null,
        fingerprint: c.fingerprint,
        external_id: c.row.external_id,
        document_id: documentId,
        import_job_id: job.id,
        source_row: c.row.source_row,
        source: "import",
        extraction: c.row.extraction,
        raw: c.row.raw,
      };
    });
    for (const part of chunk(rows, 500)) {
      const { data, error } = await db
        .from("transactions")
        .upsert(part, { onConflict: "account_id,fingerprint", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      for (const r of data ?? []) insertedIds.push(r.id);
    }
  }

  // Balances and sync markers are written before post-processing so freshly
  // imported accounts are not reported as stale sources.
  const balanceRows = resolved.flatMap(({ parsed, account }) => {
    const booked = parsed.transactions.filter((t) => !t.pending).map((t) => t.bookedOn).filter((d) => ISO_DATE.test(d));
    const first = booked.length ? booked.reduce((a, b) => (a < b ? a : b)) : undefined;
    return balanceSnapshots(parsed, first).map((b) => ({
      user_id: userId,
      account_id: account.id,
      as_of: b.asOf,
      balance: dbNumeric(b.amount),
      currency: account.currency,
      source: "import",
      document_id: doc.id,
    }));
  });
  const uniqueBalances = [...new Map(balanceRows.map((b) => [`${b.account_id}|${b.as_of}`, b])).values()];
  if (uniqueBalances.length > 0) {
    const { error } = await db.from("account_balances").upsert(uniqueBalances, { onConflict: "account_id,as_of,source" });
    if (error) throw error;
  }
  const accountIds = [...new Set(resolved.map((r) => r.account.id))];
  {
    const { error } = await db
      .from("accounts")
      .update({ last_synced_at: now().toISOString(), sync_source: "import" })
      .eq("user_id", userId)
      .in("id", accountIds);
    if (error) throw error;
  }

  // reconciling: transfers, duplicates, recurring, inbox questions, insights --------
  await setStage("reconciling");
  try {
    await postProcessUser(db, userId, { today: deps.today, scopeTransactionIds: insertedIds });
  } catch (error) {
    // The import itself is complete; post-processing is idempotent and reruns on the next import.
    console.error(`[import] job ${job.id}: post-processing failed: ${describeError(error)}`);
  }

  // recurring: series that include at least one transaction of this import --------
  await setStage("recurring");
  const series = new Set<string>();
  for (const part of chunk(insertedIds, 200)) {
    const { data, error } = await db
      .from("transactions")
      .select("recurring_series_id")
      .eq("user_id", userId)
      .in("id", part)
      .not("recurring_series_id", "is", null);
    if (error) throw error;
    for (const r of data ?? []) if (r.recurring_series_id) series.add(r.recurring_series_id);
  }

  // persisting: review questions for this document, document metadata, stats -------
  await setStage("persisting");
  const inbox: InboxDraft[] = [];
  if (!institution) {
    inbox.push({
      kind: "unknown_institution",
      dedupe_key: `unknown_institution:${doc.id}`,
      priority: 50,
      payload: { file: doc.original_filename, documentId: doc.id },
      document_id: doc.id,
    });
  }
  const incompleteLines = incompleteLineCount(statement.warnings, skippedRows);
  if (incompleteLines > 0) {
    inbox.push({
      kind: "document_incomplete",
      dedupe_key: `document_incomplete:${doc.id}`,
      priority: 45,
      payload: { file: doc.original_filename, lines: incompleteLines, documentId: doc.id },
      document_id: doc.id,
    });
  }
  for (const { account } of resolved) {
    if (!account.created || !account.needsConfirmation) continue;
    inbox.push({
      kind: "account_confirmation",
      dedupe_key: `account_confirmation:${account.id}`,
      priority: 55,
      payload: { account: account.name, accountId: account.id, file: doc.original_filename, documentId: doc.id },
      account_id: account.id,
      document_id: doc.id,
    });
  }
  await upsertInbox(db, userId, inbox);

  const [{ count: documentOpen, error: openError }, { count: reviewCount, error: reviewError }] = await Promise.all([
    db.from("inbox_items").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("document_id", doc.id).eq("status", "open"),
    db
      .from("inbox_items")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "open")
      .or(`created_at.gte."${jobStartedAt}",document_id.eq.${doc.id}`),
  ]);
  if (openError) throw openError;
  if (reviewError) throw reviewError;
  const needsReview = (documentOpen ?? 0) > 0;

  const stats: ImportStats = {
    transactionsOrganized: insertedIds.length,
    duplicatesSkipped: Math.max(0, attempted - insertedIds.length),
    accountsIdentified: accountIds.length,
    recurringDetected: series.size,
    reviewItems: reviewCount ?? 0,
    warnings: statement.warnings.length + skippedRows.length + zeroAmountRows,
    institution: institution ? { slug: institution.slug, name: institution.name } : null,
    format,
    period: statement.period ?? null,
  };

  {
    const { error } = await db
      .from("documents")
      .update({
        detected_format: format,
        detected_institution_id: institution?.id ?? null,
        period_start: statement.period?.start ?? null,
        period_end: statement.period?.end ?? null,
        status: needsReview ? "needs_review" : "processed",
      })
      .eq("id", doc.id)
      .eq("user_id", userId);
    if (error) throw error;
  }

  // completed --------------------------------------------------------------------
  state.stage = "completed";
  const status = needsReview ? "needs_review" : "completed";
  const { error: finishError } = await db
    .from("import_jobs")
    .update({
      status,
      stage: "completed",
      progress: STAGE_PROGRESS.completed,
      stats: stats as unknown as { [key: string]: Json },
      ai_provider: aiUsed && ai ? ai.provider : null,
      error_code: null,
      error_message: null,
      finished_at: now().toISOString(),
    })
    .eq("id", job.id)
    .eq("user_id", userId);
  if (finishError) throw finishError;
  return { jobId: job.id, status, stats };
}
