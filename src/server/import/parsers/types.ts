import type { ParseContext, ParsedStatement } from "@/domain/import/types";
import type { PdfDocumentAssist } from "./document-ai";
import type { InstitutionMatch } from "../institution-catalog";
import type { LayoutMemory, PdfTableRecipe } from "./layout-memory";

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
  /** Issuer name copied from source-verified full-document AI output. */
  documentInstitution?: string;
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

/** Column indexes proposed by a model for a table (headers plus a few sample rows). */
export interface TableColumnProposal {
  date: number;
  description: number;
  amount?: number;
  debit?: number;
  credit?: number;
  balance?: number;
  currency?: number;
  valueDate?: number;
}
export type TableColumnAssist = (table: { headers: string[]; rows: string[][] }) => Promise<TableColumnProposal | undefined>;

export interface DocumentParseContext extends ParseContext {
  /** Layouts learned from earlier imports of this user; new ones are saved to it. */
  layoutMemory?: LayoutMemory;
  /** PDF table recipes already loaded from the layout memory (set by the PDF parser). */
  learnedPdfTables?: ReadonlyMap<string, PdfTableRecipe>;
  /** Model-assisted column mapping for CSV/XLSX headers no profile recognizes. */
  tableAssist?: TableColumnAssist;
  aiAssist?: PdfAiAssist;
  /** Full-document fallback for unknown/incomplete PDF layouts. */
  documentAssist?: PdfDocumentAssist;
  /** Upper bound on transactions per document (default 20,000). */
  maxTransactions?: number;
}
