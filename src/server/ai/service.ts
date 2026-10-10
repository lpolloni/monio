/**
 * Provider-independent AI service.
 *
 * Every method resolves to an `AiResult` and never throws for provider
 * failures, so Monio keeps working when AI is disabled, slow or broken.
 * AI here only *interprets* (merchant / category / recurring & transfer
 * hints) or *proposes* statement rows that are verified against the source
 * text. It never produces amounts or balances that Monio would trust as-is.
 */
import { z } from "zod";
import { DOCUMENT_SYSTEM_PROMPT, parseDocumentProposal, type DocumentBatch, type DocumentLine } from "./document-contract";
import { DATA_OPEN, DATA_CLOSE } from "./prompts";
import { checkAiConfig, providerIdForConfig, type AiConfig, type AiMode } from "./config";
import { validateInterpretationBatch, type BatchEntry } from "./interpretation-validation";
import {
  buildInterpretUserMessage,
  buildStatementUserMessage,
  INTERPRET_SYSTEM_PROMPT,
  STATEMENT_ROWS_SYSTEM_PROMPT,
  type StatementPayload,
} from "./prompts";
import { createAnthropicProvider } from "./providers/anthropic";
import { createMockProvider } from "./providers/mock";
import { createOpenAiCompatibleProvider } from "./providers/openai-compatible";
import type { AiProvider, ProviderRequest, ProviderResponse } from "./providers/types";
import {
  aiError,
  type AiError,
  type AiItemNote,
  type AiProviderId,
  type AiResult,
  type AiResultMeta,
  type RejectedStatementRow,
} from "./result";
import { AI_LIMITS, extractModelJson, sanitizeUntrustedText } from "./sanitize";
import {
  StatementContextSchema,
  StatementLineInputSchema,
  StatementRowsEnvelopeSchema,
  TransactionInterpretationInputSchema,
  type StatementContext,
  type StatementLineInput,
  type StatementRowProposal,
  type TransactionInterpretation,
  type TransactionInterpretationInput,
  type WireStatementLine,
  type WireTransaction,
} from "./schemas";
import { validateStatementRows } from "./statement-validation";

export interface AiServiceDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface AiHealth {
  ok: boolean;
  mode: AiMode;
  provider: AiProviderId;
  model?: string;
  latencyMs?: number;
  error?: string;
  modelAvailable?: boolean;
}

export interface InterpretOptions {
  purpose?: "categorization";
}

export interface AiService {
  readonly mode: AiMode;
  readonly provider: AiProviderId;
  /**
   * Labels transactions (merchant, category, recurring / transfer hints).
   * Batches of ≤ 25. If some batches or items fail, the result is still
   * `ok: true` with the accepted interpretations in `data` and the other ids
   * in `meta.failedIds` (treat them as "not interpreted"). Only when every
   * batch fails is the result `ok: false`.
   */
  interpretTransactions(
    items: readonly TransactionInterpretationInput[],
    opts?: InterpretOptions,
  ): Promise<AiResult<TransactionInterpretation[]>>;
  /**
   * Proposes transaction rows for document lines the deterministic parser
   * could not read. Each proposal is verified against its line (date, amount
   * and description literally present); failures go to `meta.rejected`.
   */
  proposeStatementRows(
    lines: readonly StatementLineInput[],
    ctx?: StatementContext,
  ): Promise<AiResult<StatementRowProposal[]>>;
  /** Interpret all PDF content in bounded batches; proposals still require source validation. */
  interpretDocument(lines: readonly DocumentLine[], options?: { onProgress?: (completed: number, total: number) => Promise<void> | void }): Promise<AiResult<DocumentBatch[]>>;
  health(): Promise<AiHealth>;
}

const InterpretItemsSchema = z.array(TransactionInterpretationInputSchema).max(10_000);
const StatementLinesSchema = z.array(StatementLineInputSchema).max(10_000);

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function issuesSummary(error: z.ZodError): string {
  // Paths and messages only: never echo input values (they hold financial data).
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ");
}

function directionOf(tx: { amount: string; direction?: "in" | "out" }): WireTransaction["direction"] {
  if (tx.direction) return tx.direction;
  const a = tx.amount.trim();
  if (/^-/.test(a)) return /[1-9]/.test(a) ? "out" : "unknown";
  return /[1-9]/.test(a) ? "in" : "unknown";
}

export function createAiService(config: AiConfig, deps: AiServiceDeps = {}): AiService {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const mode = config.mode;
  const providerId = providerIdForConfig(config);

  let gate: AiError | null = null;
  let provider: AiProvider | null = null;
  let documentProvider: AiProvider | null = null;
  if (mode === "disabled") {
    gate = aiError("disabled", config.disabledReason ?? "AI features are disabled.");
  } else {
    const checked = checkAiConfig(config);
    if (!checked.ok) {
      gate = aiError("misconfigured", checked.reason);
    } else {
      provider = buildProvider(checked.config, { fetchImpl, now, timeoutMs: checked.config.timeoutMs });
      documentProvider = buildProvider(checked.config, { fetchImpl, now, timeoutMs: checked.config.documentTimeoutMs ?? 120_000 });
    }
  }
  const model = provider?.model ?? config.model;
  const cloudBlocked = provider?.location === "cloud" && config.allowCloudDocuments !== true;

  function meta(started: number, extra: Partial<AiResultMeta> = {}): AiResultMeta {
    return {
      provider: providerId,
      ...(model && { model }),
      latencyMs: Math.max(0, Math.round(now() - started)),
      confidenceIsCalibrated: false,
      ...extra,
    };
  }

  /** Gate shared by every data-bearing call. */
  function precheck(): AiError | null {
    if (gate) return gate;
    if (cloudBlocked) {
      return aiError(
        "cloud_not_authorized",
        "Sending financial data to a cloud AI provider is not authorized (set AI_ALLOW_CLOUD_DOCUMENTS=true to allow it).",
      );
    }
    return null;
  }

  async function call(request: ProviderRequest): Promise<{ ok: true; value: unknown } | { ok: false; error: AiError }> {
    let response: ProviderResponse;
    try {
      response = await (request.task === "interpret_document" ? documentProvider! : provider!).complete(request);
    } catch {
      return { ok: false, error: aiError("network_error", "The AI provider failed unexpectedly.", true) };
    }
    if (!response.ok) return response;
    return extractModelJson(response.text);
  }

  return {
    mode,
    provider: providerId,

    async interpretTransactions(items) {
      const started = now();
      const blocked = precheck();
      if (blocked) return { ok: false, error: blocked, meta: meta(started) };

      const parsed = InterpretItemsSchema.safeParse(items);
      if (!parsed.success) {
        return { ok: false, error: aiError("invalid_input", `Invalid transactions: ${issuesSummary(parsed.error)}`), meta: meta(started) };
      }
      const txs = parsed.data;
      const ids = new Set(txs.map((t) => t.id));
      if (ids.size !== txs.length) {
        return { ok: false, error: aiError("invalid_input", "Transaction ids must be unique."), meta: meta(started) };
      }
      if (!txs.length) return { ok: true, data: [], meta: meta(started, { batches: 0 }) };

      const data: TransactionInterpretation[] = [];
      const failedIds: string[] = [];
      const notes: AiItemNote[] = [];
      const errors: AiError[] = [];
      const batches = chunk(txs, AI_LIMITS.interpretBatchSize);

      for (const batch of batches) {
        const entries: BatchEntry[] = [];
        const wire: WireTransaction[] = batch.map((tx, i) => {
          const wireId = `t${i + 1}`;
          const description = sanitizeUntrustedText(tx.description, AI_LIMITS.descriptionChars);
          const direction = directionOf(tx);
          entries.push({ wireId, callerId: tx.id, description, direction });
          return {
            id: wireId,
            description,
            amount: tx.amount.trim(),
            currency: tx.currency,
            direction,
            ...(tx.date && { date: tx.date }),
            ...(tx.accountType && { account_type: sanitizeUntrustedText(tx.accountType, 40) }),
            ...(tx.country && { country: tx.country }),
          };
        });
        const outcome = await call({
          task: "interpret_transactions",
          system: INTERPRET_SYSTEM_PROMPT,
          user: buildInterpretUserMessage(wire),
          payload: { transactions: wire },
        });
        if (!outcome.ok) {
          errors.push(outcome.error);
          failedIds.push(...entries.map((e) => e.callerId));
          notes.push({ code: "batch_failed", message: `${entries.length} transactions not interpreted: ${outcome.error.message}` });
          continue;
        }
        const validation = validateInterpretationBatch(outcome.value, entries, {
          trustReasoningCode: provider!.id === "mock",
        });
        notes.push(...validation.notes);
        failedIds.push(...validation.failedIds);
        if (validation.ok) data.push(...validation.accepted);
        else errors.push(validation.error);
      }

      const extra: Partial<AiResultMeta> = {
        batches: batches.length,
        ...(failedIds.length && { failedIds }),
        ...(notes.length && { notes }),
      };
      if (errors.length === batches.length) {
        return { ok: false, error: errors[0]!, meta: meta(started, extra) };
      }
      return { ok: true, data, meta: meta(started, extra) };
    },

    async proposeStatementRows(lines, ctx) {
      const started = now();
      const blocked = precheck();
      if (blocked) return { ok: false, error: blocked, meta: meta(started) };

      const parsedLines = StatementLinesSchema.safeParse(lines);
      if (!parsedLines.success) {
        return { ok: false, error: aiError("invalid_input", `Invalid lines: ${issuesSummary(parsedLines.error)}`), meta: meta(started) };
      }
      const parsedCtx = StatementContextSchema.safeParse(ctx ?? {});
      if (!parsedCtx.success) {
        return { ok: false, error: aiError("invalid_input", `Invalid context: ${issuesSummary(parsedCtx.error)}`), meta: meta(started) };
      }
      const lineNumbers = new Set(parsedLines.data.map((l) => l.line));
      if (lineNumbers.size !== parsedLines.data.length) {
        return { ok: false, error: aiError("invalid_input", "Line numbers must be unique."), meta: meta(started) };
      }
      const { currencyHint, yearHint } = parsedCtx.data;

      // Sanitize and apply document limits (≤ 200 lines, ≤ 24k characters).
      const sendable: WireStatementLine[] = [];
      const skippedLines: number[] = [];
      let totalChars = 0;
      for (const { line, text } of parsedLines.data) {
        const clean = sanitizeUntrustedText(text, AI_LIMITS.lineChars);
        if (!clean) continue;
        if (sendable.length >= AI_LIMITS.documentLines || totalChars + clean.length > AI_LIMITS.documentChars) {
          skippedLines.push(line);
          continue;
        }
        totalChars += clean.length;
        sendable.push({ line, text: clean });
      }
      if (!sendable.length) {
        return { ok: true, data: [], meta: meta(started, { batches: 0, ...(skippedLines.length && { skippedLines }) }) };
      }

      const data: StatementRowProposal[] = [];
      const rejected: RejectedStatementRow[] = [];
      const errors: AiError[] = [];
      const batches = chunk(sendable, AI_LIMITS.statementBatchLines);

      for (const batch of batches) {
        const payload: StatementPayload = {
          lines: batch,
          ...(currencyHint && { currency_hint: currencyHint }),
          ...(yearHint !== undefined && { year_hint: yearHint }),
        };
        const outcome = await call({
          task: "propose_statement_rows",
          system: STATEMENT_ROWS_SYSTEM_PROMPT,
          user: buildStatementUserMessage(payload),
          payload,
        });
        const envelope = outcome.ok ? StatementRowsEnvelopeSchema.safeParse(outcome.value) : null;
        if (!outcome.ok || !envelope?.success) {
          errors.push(
            outcome.ok
              ? aiError("schema_invalid", 'The model answer is not an object of the form {"rows":[...]}.')
              : outcome.error,
          );
          skippedLines.push(...batch.map((l) => l.line));
          continue;
        }
        const validation = validateStatementRows(envelope.data.rows, {
          lines: new Map(batch.map((l) => [l.line, l.text])),
          ...(currencyHint && { currencyHint }),
          ...(yearHint !== undefined && { yearHint }),
        });
        data.push(...validation.accepted);
        rejected.push(...validation.rejected);
      }

      skippedLines.sort((a, b) => a - b);
      const extra: Partial<AiResultMeta> = {
        batches: batches.length,
        ...(rejected.length && { rejected }),
        ...(skippedLines.length && { skippedLines }),
      };
      if (errors.length === batches.length) {
        return { ok: false, error: errors[0]!, meta: meta(started, extra) };
      }
      data.sort((a, b) => a.line - b.line);
      return { ok: true, data, meta: meta(started, extra) };
    },

    async interpretDocument(lines, options) {
      const started = now();
      const blocked = precheck();
      if (blocked) return { ok: false, error: blocked, meta: meta(started) };
      const input = z.array(z.object({
        line: z.number().int().positive(), page: z.number().int().positive(), text: z.string().max(2000),
        items: z.array(z.object({ x: z.number().finite(), width: z.number().finite(), text: z.string().max(2000) })).max(500),
      })).max(50_000).safeParse(lines);
      if (!input.success || new Set(lines.map(l => l.line)).size !== lines.length) {
        return { ok: false, error: aiError("invalid_input", "Invalid PDF document lines."), meta: meta(started) };
      }
      const clean = input.data.map(l => ({ ...l, text: sanitizeUntrustedText(l.text, 2000), items: l.items.map(i => ({ ...i, text: sanitizeUntrustedText(i.text, 2000) })) }));
      // Compact geometry avoids repeating verbose PDF.js objects in the model prompt.
      // Validation retains the exact original objects in DocumentBatch.lines.
      const wireLine = (l: DocumentLine) => ({ line: l.line, page: l.page, text: l.text,
        items: l.items.map(i => [Math.round(i.x), Math.round(i.width), i.text]),
      });
      // Account/period headers may be on a later page, outside first/last context.
      const anchors = clean.flatMap((l, i) =>
        /(?:\b(?:ag[eê]ncia|iban|account number|conta corrente|per[ií]odo|statement period)\b|(?:janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\/\d{4})/i.test(l.text)
          ? clean.slice(Math.max(0, i - 1), i + 3) : []).slice(0, 40);
      // No first-N truncation: every line belongs to one primary batch. Context
      // overlaps preserve dates/descriptions split across a batch/page boundary.
      // Sparse multi-page statements fit one coherent request: preserve the entire
      // file rather than making the model repeatedly rediscover account context.
      const monetaryLines = clean.filter(l => /\d[.,]\d{2}(?!\d)/.test(l.text)).length;
      const wholeDocument = clean.length <= 240 && monetaryLines > 0 && monetaryLines <= 30 &&
        clean.reduce((n, l) => n + JSON.stringify(wireLine(l)).length, 0) <= 48_000;
      const groups: DocumentLine[][] = [];
      let group: DocumentLine[] = [];
      let chars = 0;
      for (const l of clean) {
        const size = JSON.stringify(wireLine(l)).length;
        if (!wholeDocument && group.length && (group.length >= 80 || chars + size > 24_000 || group[0]!.page !== l.page)) { groups.push(group); group = []; chars = 0; }
        group.push(l); chars += size;
      }
      if (group.length) groups.push(group);
      const data: DocumentBatch[] = [];
      const skippedLines: number[] = [];
      let firstError: AiError | undefined;
      let offset = 0;
      let requests = 0;
      for (const [batchIndex, primary] of groups.entries()) {
        if (batchIndex >= 64 || now() - started >= 240_000) {
          skippedLines.push(...primary.map(l => l.line));
          continue;
        }
        const context = [...anchors, ...clean.slice(0, 12), ...clean.slice(-8), ...clean.slice(Math.max(0, offset - 12), offset + primary.length + 8)];
        const payload = { lines: [...new Map(context.map(l => [l.line, l])).values()].sort((a, b) => a.line - b.line), primaryLines: primary.map(l => l.line) };
        offset += primary.length;
        requests++;
        console.info(`[import] Document AI section ${batchIndex + 1}/${groups.length} started`);
        const outcome = await call({ task: "interpret_document", timeoutMs: Math.max(1, 240_000 - (now() - started)), system: DOCUMENT_SYSTEM_PROMPT,
          user: `Interpret this document section. Text item tuples are [x, width, text] in page points.\n${DATA_OPEN}\n${JSON.stringify({ ...payload, lines: payload.lines.map(wireLine) })}\n${DATA_CLOSE}`, payload });
        console.info(`[import] Document AI section ${batchIndex + 1}/${groups.length} ${outcome.ok ? "answered" : "failed"}`);
        await options?.onProgress?.(batchIndex + 1, groups.length);
        const proposal = outcome.ok ? parseDocumentProposal(outcome.value) : null;
        if (!outcome.ok || !proposal?.success) {
          firstError ??= outcome.ok ? aiError("schema_invalid", "The document interpretation has an invalid structure.") : outcome.error;
          skippedLines.push(...payload.primaryLines);
          if (!outcome.ok && (outcome.error.retryable || outcome.error.status === 401 || outcome.error.status === 403)) {
            skippedLines.push(...groups.slice(batchIndex + 1).flatMap(g => g.map(l => l.line)));
            break;
          }
        } else data.push({ proposal: proposal.data, primaryLines: payload.primaryLines, lines: payload.lines });
      }
      const extra = { batches: requests, ...(skippedLines.length ? { skippedLines } : {}) };
      if (firstError && !data.length) return { ok: false, error: firstError, meta: meta(started, extra) };
      return { ok: true, data, meta: meta(started, extra) };
    },

    async health() {
      const base = { mode, provider: providerId, ...(model && { model }) };
      if (gate) return { ...base, ok: false, error: gate.message };
      const started = now();
      try {
        const h = await provider!.health();
        return {
          ...base,
          ok: h.ok,
          latencyMs: h.latencyMs ?? Math.max(0, Math.round(now() - started)),
          ...(h.error && { error: h.error }),
          ...(h.modelAvailable !== undefined && { modelAvailable: h.modelAvailable }),
        };
      } catch {
        return { ...base, ok: false, error: "The AI provider health check failed unexpectedly." };
      }
    },
  };
}

function buildProvider(
  config: AiConfig,
  runtime: { fetchImpl: typeof fetch; now: () => number; timeoutMs: number },
): AiProvider {
  switch (config.mode) {
    case "omlx":
      return createOpenAiCompatibleProvider({
        ...runtime,
        id: "omlx",
        location: "local",
        baseUrl: config.baseUrl!,
        model: config.model!,
        ...(config.apiKey && { apiKey: config.apiKey }),
      });
    case "cloud":
      if (config.cloudFlavor === "anthropic") {
        return createAnthropicProvider({ ...runtime, baseUrl: config.baseUrl!, apiKey: config.apiKey!, model: config.model! });
      }
      return createOpenAiCompatibleProvider({
        ...runtime,
        id: config.cloudFlavor ?? "generic",
        location: "cloud",
        baseUrl: config.baseUrl!,
        model: config.model!,
        ...(config.apiKey && { apiKey: config.apiKey }),
      });
    default:
      return createMockProvider(config.mockBehavior ? { behavior: config.mockBehavior } : {});
  }
}
