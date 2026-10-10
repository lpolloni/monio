/**
 * Entry point of the statement parsing layer: detects the format of an upload,
 * routes it to the matching parser and finalizes the result (institution hint,
 * period, ordering, description normalization, balance validation, limits).
 *
 * Document content is untrusted data: it is never executed or interpreted as
 * instructions (a description reading "IGNORE PREVIOUS INSTRUCTIONS" is just a
 * description), every line is length-capped before pattern matching, control
 * and bidi characters are stripped, and sizes/row counts are bounded.
 */
import type { InstitutionHint, ParsedAccount, ParsedStatement, ParsedTransaction } from "@/domain/import/types";
import { dec, sum, toPlain } from "@/domain/money/decimal";
import { detectFormat } from "./detect-format";
import {
  bicContradicts,
  findBic,
  findInstitutionByBic,
  findInstitutionByIban,
  findInstitutionByText,
  findIssuerName,
  getInstitution,
  type InstitutionMatch,
} from "./institution-catalog";
import { CsvTooLargeError, parseCsvLearning } from "./parsers/csv";
import { OfxTooLargeError, parseOfx } from "./parsers/ofx";
import { parsePdf, PdfRejectedError } from "./parsers/pdf";
import { normalizeDescription } from "./parsers/text";
import type { DocumentParseContext, ParserOutput } from "./parsers/types";
import { parseXlsxLearning, XlsxRejectedError } from "./parsers/xlsx";

export type { AiProposedRow, DocumentParseContext, PdfAiAssist } from "./parsers/types";

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSACTIONS = 20_000;

/** The upload is not a supported statement format (or could not be read as one). */
export class UnsupportedDocumentError extends Error {
  constructor(message = "Unsupported document format.", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UnsupportedDocumentError";
  }
}

/** The upload is empty (zero bytes or only whitespace). */
export class EmptyDocumentError extends Error {
  constructor(message = "The document is empty.") {
    super(message);
    this.name = "EmptyDocumentError";
  }
}

/** The upload exceeds size, page or row limits. */
export class DocumentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentLimitError";
  }
}

export interface DocumentInput {
  bytes: Uint8Array;
  filename: string;
  mimeType?: string;
}

function isBlank(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    // whitespace or UTF-8/UTF-16 BOM bytes
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0xef && b !== 0xbb && b !== 0xbf && b !== 0xfe && b !== 0xff && b !== 0x00) {
      return false;
    }
  }
  return true;
}

export async function parseDocument(input: DocumentInput, ctx: DocumentParseContext = {}): Promise<ParsedStatement> {
  const { bytes, filename, mimeType } = input;
  if (!bytes || bytes.length === 0 || isBlank(bytes)) throw new EmptyDocumentError();
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new DocumentLimitError(`The document exceeds ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB.`);
  }
  const format = detectFormat(bytes, filename, mimeType);
  if (!format) {
    throw new UnsupportedDocumentError("Unsupported document: expected a CSV, OFX, XLSX or PDF bank statement.");
  }
  const parseCtx: DocumentParseContext = { ...ctx, filename: ctx.filename ?? filename };

  let output: ParserOutput;
  try {
    switch (format) {
      case "csv":
        output = await parseCsvLearning(bytes, parseCtx);
        break;
      case "ofx":
        output = parseOfx(bytes, parseCtx);
        break;
      case "xlsx":
        output = await parseXlsxLearning(bytes, parseCtx);
        break;
      case "pdf":
        output = await parsePdf(bytes, parseCtx);
        break;
    }
  } catch (error) {
    if (error instanceof CsvTooLargeError || error instanceof OfxTooLargeError) throw new DocumentLimitError(error.message);
    if (error instanceof PdfRejectedError) throw new DocumentLimitError(error.message);
    if (error instanceof XlsxRejectedError) {
      throw /rows|expands|entries/.test(error.message)
        ? new DocumentLimitError(error.message)
        : new UnsupportedDocumentError(error.message, { cause: error });
    }
    if (format === "pdf" || format === "xlsx") {
      // Corrupted/encrypted files: report as unreadable, never leak parser internals.
      throw new UnsupportedDocumentError(`The ${format.toUpperCase()} file could not be read.`, { cause: error });
    }
    throw error;
  }

  return finalize(output, parseCtx);
}

function finalize(output: ParserOutput, ctx: DocumentParseContext): ParsedStatement {
  const statement = output.statement;
  const max = ctx.maxTransactions ?? MAX_TRANSACTIONS;
  const total = statement.accounts.reduce((n, a) => n + a.transactions.length, 0);
  if (total > max) throw new DocumentLimitError(`The document has more than ${max} transactions.`);

  for (const account of statement.accounts) {
    for (const tx of account.transactions) {
      tx.description = normalizeDescription(tx.description);
      if (tx.counterparty !== undefined) {
        const counterparty = normalizeDescription(tx.counterparty);
        if (counterparty) tx.counterparty = counterparty;
        else delete tx.counterparty;
      }
    }
    account.transactions = sortChronologically(account.transactions);
    if (!account.currency && account.transactions[0]) account.currency = account.transactions[0].currency;
    if (account.name) account.name = normalizeDescription(account.name);
  }

  statement.period = computePeriod(statement.accounts, output.statedPeriod);
  checkBalances(statement);

  const institution = resolveInstitution(output, statement, ctx.filename);
  if (institution) statement.institution = institution;
  else delete statement.institution;

  if (total === 0 && !statement.warnings.some((w) => w.code === "unsupported_layout")) {
    statement.warnings.push({ code: "empty_document", message: "No transactions were found in the document." });
  }
  return statement;
}

/** Stable ascending sort by booked date; descending exports are reversed first to keep intra-day order. */
function sortChronologically(transactions: ParsedTransaction[]): ParsedTransaction[] {
  let up = 0;
  let down = 0;
  for (let i = 1; i < transactions.length; i++) {
    const a = transactions[i - 1]!.bookedOn;
    const b = transactions[i]!.bookedOn;
    if (b > a) up++;
    else if (b < a) down++;
  }
  const ordered = down > up ? [...transactions].reverse() : [...transactions];
  return ordered
    .map((tx, index) => ({ tx, index }))
    .sort((x, y) => (x.tx.bookedOn < y.tx.bookedOn ? -1 : x.tx.bookedOn > y.tx.bookedOn ? 1 : x.index - y.index))
    .map(({ tx }) => tx);
}

function computePeriod(accounts: ParsedAccount[], stated?: { start: string; end: string }): ParsedStatement["period"] {
  let start: string | undefined;
  let end: string | undefined;
  for (const account of accounts) {
    for (const tx of account.transactions) {
      if (!start || tx.bookedOn < start) start = tx.bookedOn;
      if (!end || tx.bookedOn > end) end = tx.bookedOn;
    }
  }
  if (!start || !end) return stated;
  // A period stated by the document wins only if it is consistent with the data.
  if (stated && stated.start <= start && stated.end >= end) return stated;
  return { start, end };
}

function checkBalances(statement: ParsedStatement): void {
  for (const account of statement.accounts) {
    const { openingBalance, closingBalance } = account;
    if (!openingBalance || !closingBalance) continue;
    const booked = account.transactions.filter((t) => !t.pending && (!account.currency || t.currency === account.currency));
    const expected = dec(openingBalance.amount).plus(sum(booked.map((t) => t.amount)));
    if (!expected.equals(dec(closingBalance.amount))) {
      statement.warnings.push({
        code: "balance_mismatch",
        message:
          `Account "${account.key}": opening balance ${openingBalance.amount} plus transactions ` +
          `(${toPlain(expected)}) does not match the closing balance ${closingBalance.amount} ` +
          `(difference ${toPlain(dec(closingBalance.amount).minus(expected))}). Some transactions may be missing.`,
      });
    }
  }
}

function hint(match: InstitutionMatch, confidence = match.confidence, name?: string): InstitutionHint {
  return {
    slug: match.slug,
    name: name ?? getInstitution(match.slug)?.name,
    confidence: Math.round(confidence * 100) / 100,
    evidence: match.evidence,
  };
}

/**
 * Institution precedence: profile header signature > OFX ids > the statement's
 * own BIC > document text (preamble/header/footer, never transaction
 * descriptions) > IBAN bank code > file name (low confidence). A profile whose
 * header is shared by many banks yields to a different institution named in
 * the document text, and a name contradicted by the statement's BIC is dropped.
 * A PDF from a bank outside the catalog is attributed to the issuer its header
 * names, so that it becomes an institution of its own instead of an unknown one.
 */
function resolveInstitution(output: ParserOutput, statement: ParsedStatement, filename?: string): InstitutionHint | undefined {
  if (output.documentInstitution && !output.profileInstitution) {
    const match = findInstitutionByText(output.documentInstitution);
    return match ? hint(match) : { name: output.documentInstitution, confidence: 0.8, evidence: "Issuer copied from a source-verified document header/footer" };
  }
  const bic = output.institutionText ? findBic(output.institutionText) : undefined;
  const named = output.institutionText ? findInstitutionByText(output.institutionText) : undefined;
  const textMatch = named && bic && bicContradicts(bic, named.slug) ? undefined : named;
  if (output.profileInstitution) {
    const { slug, weak, evidence } = output.profileInstitution;
    if (!weak) return hint({ slug, confidence: 0.9, evidence });
    if (textMatch && textMatch.slug !== slug && textMatch.confidence >= 0.7) return hint(textMatch);
    if (textMatch?.slug === slug) return hint({ slug, confidence: 0.85, evidence: `${evidence}; ${textMatch.evidence}` });
    return hint({ slug, confidence: 0.55, evidence });
  }
  if (output.ofxInstitution) return hint(output.ofxInstitution, output.ofxInstitution.confidence, output.ofxInstitution.name);
  const byBic = bic ? findInstitutionByBic(bic) : undefined;
  if (byBic) return hint(byBic);
  if (textMatch) return hint(textMatch);
  for (const account of statement.accounts) {
    const byIban = account.identifier ? findInstitutionByIban(account.identifier) : undefined;
    if (byIban) return hint(byIban);
  }
  if (statement.format === "ofx" && output.institutionText) {
    return { name: output.institutionText.slice(0, 100), confidence: 0.3, evidence: "OFX ORG (not in catalog)" };
  }
  const issuer = statement.format === "pdf" && output.institutionText ? findIssuerName(output.institutionText) : undefined;
  if (issuer) return { name: issuer, confidence: 0.6, evidence: "Issuer named in the document header" };
  if (filename) {
    const byName = findInstitutionByText(filename.replace(/[_\-.]+/g, " "));
    if (byName) return hint({ ...byName, evidence: `File name mentions it (${byName.evidence})` }, Math.min(0.3, byName.confidence));
  }
  return undefined;
}
