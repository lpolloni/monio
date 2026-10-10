/**
 * Validation of a model's interpretation answer for one batch.
 *
 * Contract (identical for mock and real providers):
 * - The answer must be exactly `{"items":[...]}`; anything else fails the
 *   batch with `schema_invalid`.
 * - Each item must match the strict item schema. Extra keys (`amount`,
 *   `date`, ...), wrong types, or out-of-range values reject that item.
 * - Ids must be the requested per-batch aliases; unknown ids are ignored,
 *   duplicated ids reject every answer for that id, unanswered ids are
 *   reported as `missing`.
 * - Unknown category slugs, and categories whose kind contradicts the money
 *   direction (expense for incoming money, income for outgoing money), keep
 *   the item but with `category: null` and a note — never coerced.
 * - A merchant containing a number (3+ digits) absent from the description is
 *   treated as manipulated and the item is rejected.
 * - If no item survives, the batch fails with `schema_invalid`.
 */
import { getCategory, isCategorySlug } from "@/domain/categories/catalog";
import { aiError, type AiError, type AiItemNote } from "./result";
import { sanitizeUntrustedText } from "./sanitize";
import {
  InterpretationEnvelopeSchema,
  ModelInterpretationItemSchema,
  TransactionInterpretationSchema,
  type ModelInterpretationItem,
  type TransactionInterpretation,
} from "./schemas";

export interface BatchEntry {
  /** Alias sent to the model ("t1"). */
  wireId: string;
  /** Caller's id. */
  callerId: string;
  /** Sanitized description that was sent. */
  description: string;
  direction: "in" | "out" | "unknown";
}

export type BatchValidation =
  | { ok: true; accepted: TransactionInterpretation[]; failedIds: string[]; notes: AiItemNote[] }
  | { ok: false; error: AiError; failedIds: string[]; notes: AiItemNote[] };

export interface BatchValidationOptions {
  /**
   * Whether the provider may set `reasoning_code` itself. Only the
   * deterministic mock may; for real models it is always "model" (a model
   * cannot claim a deterministic provenance).
   */
  trustReasoningCode: boolean;
}

const safe = (v: unknown) => sanitizeUntrustedText(typeof v === "string" ? v : JSON.stringify(v) ?? "", 40);

function digitRuns(s: string): string[] {
  return s.match(/\d{3,}/g) ?? [];
}

export function validateInterpretationBatch(
  raw: unknown,
  batch: readonly BatchEntry[],
  options: BatchValidationOptions,
): BatchValidation {
  const notes: AiItemNote[] = [];
  const allIds = batch.map((b) => b.callerId);
  const envelope = InterpretationEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return {
      ok: false,
      error: aiError("schema_invalid", 'The model answer is not an object of the form {"items":[...]}.'),
      failedIds: allIds,
      notes,
    };
  }

  const byWireId = new Map(batch.map((b) => [b.wireId, b]));
  const occurrences = new Map<string, number>();
  for (const item of envelope.data.items) {
    const id = item && typeof item === "object" && "id" in item ? (item as { id: unknown }).id : undefined;
    if (typeof id === "string" && byWireId.has(id)) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
  }

  const accepted = new Map<string, TransactionInterpretation>();
  const noted = new Set<string>();
  const note = (code: AiItemNote["code"], message: string, entry?: BatchEntry) => {
    notes.push(entry ? { id: entry.callerId, code, message } : { code, message });
    if (entry) noted.add(entry.wireId);
  };

  for (const rawItem of envelope.data.items) {
    const rawId = rawItem && typeof rawItem === "object" && "id" in rawItem ? (rawItem as { id: unknown }).id : undefined;
    const entry = typeof rawId === "string" ? byWireId.get(rawId) : undefined;
    if (!entry) {
      note("unknown_id", `Ignored an answer for an id that was not requested (${safe(rawId)}).`);
      continue;
    }
    if ((occurrences.get(entry.wireId) ?? 0) > 1) {
      if (!noted.has(entry.wireId)) note("duplicate_id", "The model answered this transaction more than once.", entry);
      continue;
    }
    const parsed = ModelInterpretationItemSchema.safeParse(rawItem);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "item"}: ${i.message}`).join("; ");
      note("item_schema_invalid", `Rejected: ${sanitizeUntrustedText(issues, 200)}`, entry);
      continue;
    }
    const result = interpretItem(parsed.data, entry, options, note);
    if (result) accepted.set(entry.wireId, result);
  }

  for (const entry of batch) {
    if (!accepted.has(entry.wireId) && !noted.has(entry.wireId)) note("missing", "The model did not answer this transaction.", entry);
  }

  const failedIds = batch.filter((b) => !accepted.has(b.wireId)).map((b) => b.callerId);
  if (accepted.size === 0) {
    return {
      ok: false,
      error: aiError("schema_invalid", "The model answer contained no valid interpretation."),
      failedIds,
      notes,
    };
  }
  const ordered = batch.flatMap((b) => {
    const a = accepted.get(b.wireId);
    return a ? [a] : [];
  });
  return { ok: true, accepted: ordered, failedIds, notes };
}

function interpretItem(
  item: ModelInterpretationItem,
  entry: BatchEntry,
  options: BatchValidationOptions,
  note: (code: AiItemNote["code"], message: string, entry?: BatchEntry) => void,
): TransactionInterpretation | null {
  const merchant = item.merchant === null ? null : item.merchant.replace(/\s+/g, " ").trim() || null;
  if (merchant !== null) {
    if (merchant !== sanitizeUntrustedText(merchant, Number.MAX_SAFE_INTEGER)) {
      note("item_schema_invalid", "Rejected: the merchant contains control or delimiter characters.", entry);
      return null;
    }
    const sourceDigits = entry.description.replace(/\D+/g, " ");
    if (digitRuns(merchant).some((run) => !sourceDigits.includes(run))) {
      note("ungrounded_number", "Rejected: the merchant contains a number that is not in the description.", entry);
      return null;
    }
  }

  let category: TransactionInterpretation["category"] = null;
  if (item.category !== null) {
    if (!isCategorySlug(item.category)) {
      note("unknown_category", `Unknown category "${safe(item.category)}" was discarded.`, entry);
    } else {
      const kind = getCategory(item.category)?.kind;
      if ((entry.direction === "in" && kind === "expense") || (entry.direction === "out" && kind === "income")) {
        note(
          "category_direction_mismatch",
          `Category "${item.category}" contradicts the money direction (${entry.direction}) and was discarded.`,
          entry,
        );
      } else {
        category = item.category;
      }
    }
  }

  const candidate: TransactionInterpretation = {
    id: entry.callerId,
    merchant,
    category,
    recurring_candidate: item.recurring_candidate,
    transfer_candidate: item.transfer_candidate,
    confidence: item.confidence,
    reasoning_code: options.trustReasoningCode ? (item.reasoning_code ?? "model") : "model",
  };
  // Final belt-and-braces check against the public output schema.
  const final = TransactionInterpretationSchema.safeParse(candidate);
  if (!final.success) {
    note("item_schema_invalid", "Rejected: the interpretation failed the output schema.", entry);
    return null;
  }
  return final.data;
}
