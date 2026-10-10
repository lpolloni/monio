/** Conservative compilation gate: learn an existing bounded reader, never executable model output. */
import { createHash } from "node:crypto";
import { dec, sum } from "@/domain/money/decimal";
import type { ParserOutput } from "./types";
import type { DocumentAiResult } from "./document-ai";
import { findInstitutionByText } from "../institution-catalog";
import type { PdfLine } from "./pdf";

// Increment when any certified reader or validation semantics change.
export const PDF_READER_VERSION = 1;
export interface PdfLearningStore {
  confirmations(layout: string): Promise<number>;
  confirm(layout: string): Promise<void>;
  invalidate(layout: string): Promise<void>;
}

/** Only readers with a complete, reconciled account may be reused. Rechecked on EVERY upload. */
export function reusablePdf(output: ParserOutput, lines?: PdfLine[]): boolean {
  const s = output.statement;
  if (s.warnings.length || !output.statedPeriod || s.accounts.length !== 1) return false;
  const a = s.accounts[0]!;
  if (!a.identifier || !a.currency || !a.transactions.length || !a.openingBalance || !a.closingBalance) return false;
  if (a.transactions.some(t => t.currency !== a.currency || t.bookedOn < output.statedPeriod!.start || t.bookedOn > output.statedPeriod!.end)) return false;
  if (lines) {
    const rows = new Set(a.transactions.map(t => t.sourceRow));
    for (const l of lines) {
      if (!/\d[.,]\d{2}(?!\d)/.test(l.text) || rows.has(l.line)) continue;
      // Administrative identifiers and source-labelled summaries are not movements.
      if (/^(?:saldo|total|rendimento l[ií]quido|(?:\d{1,2} .+ )?total de |CPF|CNPJ|ag[eê]ncia|conta)\b/i.test(l.text)) continue;
      if (/^R\$\s*[\d.,]+$/.test(l.text) && /saldo|total/i.test(lines.find(p => p.line === l.line - 1)?.text ?? "")) continue;
      return false; // New monetary content requires fresh interpretation, even if totals reconcile.
    }
  }
  return dec(a.openingBalance.amount).plus(sum(a.transactions.map(t => t.amount))).equals(a.closingBalance.amount);
}

/** Hash only a structural signature. No source text, identities or financial values are stored. */
export function pdfLayoutKey(output: ParserOutput, columns: { role: string; center: number }[][]): string | undefined {
  const profile = output.statement.profile;
  if (!["nubank-account-pdf", "nubank-pj-pdf", "pdf-column-statement"].includes(profile)) return undefined;
  const issuer = output.profileInstitution?.slug ?? findInstitutionByText(output.institutionText ?? "")?.slug;
  if (!issuer) return undefined;
  const geometry = [...new Set(columns.map(c => JSON.stringify(c.map(v => [v.role, Math.round(v.center / 4)]))))].sort();
  if (profile === "pdf-column-statement" && !geometry.length) return undefined;
  return createHash("sha256").update(JSON.stringify([PDF_READER_VERSION, profile, issuer, geometry])).digest("hex");
}

/** Full source coverage + independent agreement, before any training evidence is recorded. */
export function canLearnPdf(native: ParserOutput, interpreted: ParserOutput, result: DocumentAiResult, lines: PdfLine[]): boolean {
  if (!reusablePdf(native, lines) || interpreted.statement.warnings.length || result.skippedLines.length || !result.batches.length || result.batches.some(b => b.proposal.unparsedLines.length)) return false;
  const covered = result.batches.flatMap(b => b.primaryLines);
  if (covered.length !== lines.length || new Set(covered).size !== lines.length || lines.some(l => !covered.includes(l.line))) return false;
  const a = native.statement.accounts[0]!;
  const b = interpreted.statement.accounts[0];
  if (interpreted.statement.accounts.length !== 1 || !b || !b.identifier || a.identifier !== b.identifier || a.currency !== b.currency || a.type !== b.type) return false;
  if (JSON.stringify(native.statedPeriod) !== JSON.stringify(interpreted.statedPeriod)) return false;
  for (const key of ["openingBalance", "closingBalance"] as const) {
    if (!b[key] || a[key]!.asOf !== b[key]!.asOf || !dec(a[key]!.amount).equals(b[key]!.amount)) return false;
  }
  if (a.transactions.length !== b.transactions.length) return false;
  const unmatched = [...b.transactions];
  for (const t of a.transactions) {
    const i = unmatched.findIndex(u => (u.sourceRow === t.sourceRow || u.raw.evidence_lines?.split(",").includes(String(t.sourceRow))) && u.bookedOn === t.bookedOn && dec(u.amount).equals(t.amount) && u.currency === t.currency && u.description.replace(/\s+/g, " ").trim() === t.description.replace(/\s+/g, " ").trim());
    if (i < 0) return false;
    unmatched.splice(i, 1);
  }
  return true;
}
