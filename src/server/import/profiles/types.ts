import type { AccountType, ParseContext, ParsedAccount, ParseWarning } from "@/domain/import/types";

/** A rectangular-ish table read from a CSV file or a spreadsheet sheet. */
export interface TableData {
  /** Sheet name for spreadsheets. */
  name?: string;
  /** Cell text, already sanitized. rows[i] is source row i + 1. */
  rows: string[][];
  /**
   * True when rows[r][c] came from a numeric spreadsheet cell, i.e. it is a
   * canonical decimal string ("-1234.5") that must not be reinterpreted with a
   * locale decimal separator.
   */
  numericCell?: (row: number, col: number) => boolean;
}

/** Non-tabular context a profile may use to disambiguate (never transaction text). */
export interface ProfileHints {
  filename?: string;
  /** Text of the rows above the header row (bank name, IBAN, period...). */
  preamble?: string;
}

export interface ProfileContext extends ParseContext {
  /** 0-based index of the header row within `rows`. */
  headerRowIndex: number;
  numericCell?: (row: number, col: number) => boolean;
  preamble?: string;
}

export interface ProfileResult {
  accounts: ParsedAccount[];
  warnings: ParseWarning[];
}

export interface StatementProfile {
  id: string;
  label: string;
  institutionSlug?: string;
  accountType?: AccountType;
  /**
   * True when the header signature is common to many banks: the institution
   * implied by the profile is then only a weak hint that document text may
   * override.
   */
  weakInstitutionSignal?: boolean;
  /** 0..1 — how well a header row (and the rows below it) fit this profile. */
  matches(headers: string[], sampleRows: string[][], hints?: ProfileHints): number;
  parse(rows: string[][], ctx: ProfileContext): ProfileResult;
}
