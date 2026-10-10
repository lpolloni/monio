/**
 * Contracts shared by every statement parser (CSV, OFX, XLSX, PDF).
 *
 * Parsers are deterministic and side-effect free: they receive the document
 * content and return what they could read, with provenance (row/line numbers
 * and the raw values). They never invent amounts, dates or transactions; rows
 * they cannot read become warnings, not guesses.
 */

export type DocumentFormat = "csv" | "ofx" | "xlsx" | "pdf";

export type AccountType =
  | "checking"
  | "savings"
  | "credit_card"
  | "investment"
  | "loan"
  | "mortgage"
  | "crypto_wallet"
  | "cash"
  | "other";

export interface InstitutionHint {
  /** Slug from the institution catalog, e.g. "nubank", "n26", "revolut". */
  slug?: string;
  /** Free-text name found in the document (OFX <ORG>, PDF header...). */
  name?: string;
  /** 0..1 — simulated/heuristic confidence of the detection, not calibrated. */
  confidence: number;
  /** Short human-readable reason, e.g. "CSV header signature: Nubank account". */
  evidence: string;
}

export interface ParsedTransaction {
  /** ISO date YYYY-MM-DD as written in the statement (no timezone shifts). */
  bookedOn: string;
  valueOn?: string;
  /** Original description exactly as found (trimmed, whitespace collapsed). */
  description: string;
  /** Signed decimal string, negative = money leaving the account. */
  amount: string;
  /** ISO 4217 / catalog code. */
  currency: string;
  /** Foreign amount/currency when a card was charged in another currency. */
  originalAmount?: string;
  originalCurrency?: string;
  /** Stable id provided by the source (OFX FITID, Revolut id...). */
  externalId?: string;
  counterparty?: string;
  /** 1-based row (CSV/XLSX) or line (PDF/OFX) number in the source document. */
  sourceRow: number;
  /** Raw source values for provenance (column -> value). */
  raw: Record<string, string>;
  /** How the row was read: exact = structured field mapping, heuristic = pattern match, ai = model-assisted. */
  extraction: "exact" | "heuristic" | "ai";
  /** Pending/authorized transactions are kept but flagged. */
  pending?: boolean;
}

export interface ParsedBalance {
  amount: string;
  asOf: string;
}

export interface ParsedAccount {
  /** Stable key within the document ("default" when the file holds one account). */
  key: string;
  /** Full account identifier if present. Used only in memory to compute a hash; never persisted. */
  identifier?: string;
  /** Last 4 characters of the identifier for display. */
  identifierMask?: string;
  type?: AccountType;
  currency?: string;
  /** ISO 3166-1 alpha-2 */
  country?: string;
  name?: string;
  closingBalance?: ParsedBalance;
  openingBalance?: ParsedBalance;
  transactions: ParsedTransaction[];
}

export interface ParseWarning {
  code:
    | "row_unreadable"
    /** Row intentionally not imported (e.g. declined/reverted card payment) — informational. */
    | "row_skipped"
    | "missing_amount"
    | "missing_date"
    | "unknown_currency"
    | "ambiguous_date_order"
    | "ambiguous_decimal_separator"
    | "balance_mismatch"
    | "empty_document"
    | "unsupported_layout"
    | "ai_rejected_row";
  message: string;
  row?: number;
}

export interface ParsedStatement {
  format: DocumentFormat;
  institution?: InstitutionHint;
  accounts: ParsedAccount[];
  period?: { start: string; end: string };
  warnings: ParseWarning[];
  /** Name of the parser profile that read the file, for provenance. */
  profile: string;
}

export interface ParseContext {
  /** Original file name (used only as a weak detection hint). */
  filename?: string;
  /** User/primary currency used when a document does not state one. */
  fallbackCurrency?: string;
}
