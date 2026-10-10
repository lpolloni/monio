/**
 * Result contract shared by every AI operation.
 *
 * AI is optional in Monio: callers must keep working when it is unavailable,
 * so provider failures are returned as typed errors and never thrown.
 */

export type AiErrorCode =
  /** AI is turned off (AI_PROVIDER=disabled or an invalid env configuration). */
  | "disabled"
  /** The provider did not answer within `timeoutMs`. */
  | "timeout"
  /** The provider answered with a non-2xx HTTP status. */
  | "http_error"
  /** The provider could not be reached (DNS, connection refused, TLS...). */
  | "network_error"
  /** The response was not parseable JSON. */
  | "malformed_output"
  /** The response was JSON but did not match the strict output schema. */
  | "schema_invalid"
  /** Cloud provider selected but sending financial data to it is not authorized. */
  | "cloud_not_authorized"
  /** The configuration passed to `createAiService` is incomplete or unsafe. */
  | "misconfigured"
  /** The caller passed invalid input (programming error, not a provider failure). */
  | "invalid_input";

export interface AiError {
  code: AiErrorCode;
  /** Human-readable, safe to log: never contains API keys or document content. */
  message: string;
  /** Whether retrying the same request later can reasonably succeed. */
  retryable: boolean;
  /** HTTP status for `http_error`. */
  status?: number;
}

/** Concrete backend that produced (or would produce) the answer. */
export type AiProviderId = "mock" | "omlx" | "openai" | "openrouter" | "anthropic" | "generic" | "disabled";

/** Per-item validation outcome reported back to the caller. */
export type AiItemNoteCode =
  /** Category was not a known slug: the item is kept with `category: null`. */
  | "unknown_category"
  /** Category kind contradicts the money direction: the item is kept with `category: null`. */
  | "category_direction_mismatch"
  /** The item failed the strict item schema (extra keys such as `amount`, bad types...): rejected. */
  | "item_schema_invalid"
  /** The item carried an id that was not requested: ignored. */
  | "unknown_id"
  /** The same id was answered more than once: every answer for it is rejected. */
  | "duplicate_id"
  /** A requested id was not answered. */
  | "missing"
  /** The merchant contained a number that is not in the source description: rejected. */
  | "ungrounded_number"
  /** The whole batch failed (see `error`). */
  | "batch_failed";

export interface AiItemNote {
  /** Caller id, when the note can be attributed to a requested item. */
  id?: string;
  code: AiItemNoteCode;
  message: string;
}

export type StatementRowRejectReason =
  | "schema_invalid"
  | "line_not_requested"
  | "ambiguous_line"
  | "invalid_date"
  | "date_not_in_line"
  | "invalid_amount"
  | "amount_not_in_line"
  | "sign_mismatch"
  | "description_not_in_line"
  | "currency_not_in_line";

export interface RejectedStatementRow {
  /** Line number claimed by the model, when it was a positive integer. */
  line?: number;
  reason: StatementRowRejectReason;
  message: string;
}

export interface AiResultMeta {
  provider: AiProviderId;
  model?: string;
  /** Wall-clock time spent in the operation, all batches included. */
  latencyMs: number;
  /**
   * Confidence values are model/heuristic self-reports (simulated in mock mode).
   * No provider is calibrated yet: never present them as probabilities.
   */
  confidenceIsCalibrated: false;
  /** Number of provider requests issued (batches). */
  batches?: number;
  /**
   * interpretTransactions: caller ids with no accepted interpretation
   * (failed batch, rejected item or missing answer). These items must be
   * treated as "not interpreted", exactly as if AI were unavailable.
   */
  failedIds?: string[];
  /** interpretTransactions: per-item validation notes. */
  notes?: AiItemNote[];
  /** proposeStatementRows: proposals that failed post-validation. */
  rejected?: RejectedStatementRow[];
  /** proposeStatementRows: requested lines not sent (limits) or whose batch failed. */
  skippedLines?: number[];
}

export type AiResult<T> =
  | { ok: true; data: T; meta: AiResultMeta }
  | { ok: false; error: AiError; meta: AiResultMeta };

export function aiError(code: AiErrorCode, message: string, retryable = false, status?: number): AiError {
  return status === undefined ? { code, message, retryable } : { code, message, retryable, status };
}
