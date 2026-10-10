import type { ParseContext, ParsedStatement } from "@/domain/import/types";
import type { InstitutionMatch } from "../institution-catalog";

/** Internal result of a format parser, finalized by parseDocument(). */
export interface ParserOutput {
  statement: ParsedStatement;
  /**
   * Document text that is *not* transaction data (preamble, PDF header/footer,
   * OFX ORG) — the only text used for institution alias matching.
   */
  institutionText?: string;
  /** Institution implied by a matched profile. */
  profileInstitution?: { slug: string; weak: boolean; evidence: string };
  /** Institution from OFX sign-on/account ids. */
  ofxInstitution?: InstitutionMatch & { name?: string };
  /** Statement period explicitly stated by the document (OFX DTSTART/DTEND, PDF header). */
  statedPeriod?: { start: string; end: string };
}

/** One transaction proposed by an AI model for an ambiguous PDF line. */
export interface AiProposedRow {
  line: number;
  date: string;
  description: string;
  amount: string;
  currency?: string;
}

/**
 * Optional model-assisted extraction for PDF lines the deterministic parser
 * could not read. Receives at most 200 lines that look transactional; every
 * proposed row is validated against the line text before being accepted.
 */
export type PdfAiAssist = (lines: { line: number; text: string }[]) => Promise<AiProposedRow[]>;

export interface DocumentParseContext extends ParseContext {
  aiAssist?: PdfAiAssist;
  /** Upper bound on transactions per document (default 20,000). */
  maxTransactions?: number;
}
