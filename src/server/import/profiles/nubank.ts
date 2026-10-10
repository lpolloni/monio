/**
 * Nubank CSV exports (account, business account and credit card).
 *
 * NOTE: these layouts are based on publicly known Nubank export formats
 * ("Data,Valor,Identificador,Descrição" for accounts, "date,title,amount" for
 * card bills). They must be validated against real exports before production.
 *
 * - Account / PJ: DD/MM/YYYY dates, dot decimal, signed amounts, UUID id.
 * - Card: ISO dates, positive = purchase. On a credit-card account money
 *   leaving is negative, so every sign is flipped (payments become positive).
 * - PJ (business) uses the account layout; it is told apart only by markers
 *   outside the header (file name / preamble "PJ", "Conta PJ", "CNPJ") or by
 *   counterparties identified by full CNPJs instead of masked CPFs.
 */
import { cellAt, columnRate, headerIndex, readTable, signatureScore, type TableSpec } from "./table";
import type { ProfileHints, StatementProfile } from "./types";

const ACCOUNT_HEADERS = ["Data", "Valor", "Identificador", "Descrição"];
const CARD_HEADERS = ["date", "title", "amount"];

const DMY = /^\d{2}\/\d{2}\/\d{4}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CNPJ = /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/;
const MASKED_CPF = /[•*]{3}\.\d{3}\.\d{3}-[•*]{2}/;
const PJ_MARKER = /(^|[^a-z])(pj|cnpj|conta pj|pessoa juridica)([^a-z]|$)/i;

/** True when something outside the transaction rows says this is a business (PJ) account. */
export function hasPjMarkers(sampleRows: string[][], descriptionCol: number, hints?: ProfileHints): boolean {
  if (hints?.filename && PJ_MARKER.test(hints.filename.replace(/[_.\-]/g, " "))) return true;
  if (hints?.preamble && PJ_MARKER.test(hints.preamble)) return true;
  const descriptions = sampleRows.map((r) => cellAt(r, descriptionCol)).filter(Boolean);
  if (descriptions.length < 3) return false;
  const cnpj = descriptions.filter((d) => CNPJ.test(d)).length;
  const cpf = descriptions.filter((d) => MASKED_CPF.test(d)).length;
  return cpf === 0 && cnpj / descriptions.length >= 0.5;
}

const accountSpec = (headers: string[]): TableSpec => ({
  date: headerIndex(headers, "Data"),
  dateOrder: "DMY",
  decimal: ".",
  amount: { kind: "signed", col: headerIndex(headers, "Valor") },
  description: (row) => cellAt(row.cells, headerIndex(headers, "Descrição")),
  externalId: headerIndex(headers, "Identificador"),
  currency: "BRL",
  accountType: "checking",
  country: "BR",
  extraction: "exact",
});

function accountScore(headers: string[], sampleRows: string[][]): number {
  const base = signatureScore(headers, ACCOUNT_HEADERS);
  if (!base) return 0;
  return columnRate(sampleRows, headerIndex(headers, "Data"), (v) => DMY.test(v)) >= 0.8 ? base : base * 0.5;
}

export const nubankAccountProfile: StatementProfile = {
  id: "nubank-account",
  label: "Nubank account (CSV)",
  institutionSlug: "nubank",
  accountType: "checking",
  matches(headers, sampleRows, hints) {
    const score = accountScore(headers, sampleRows);
    if (!score) return 0;
    return hasPjMarkers(sampleRows, headerIndex(headers, "Descrição"), hints) ? score * 0.85 : score * 0.95;
  },
  parse(rows, ctx) {
    return readTable(rows, ctx, accountSpec(rows[ctx.headerRowIndex] ?? []));
  },
};

export const nubankPjProfile: StatementProfile = {
  id: "nubank-pj",
  label: "Nubank PJ business account (CSV)",
  institutionSlug: "nubank-pj",
  accountType: "checking",
  matches(headers, sampleRows, hints) {
    const score = accountScore(headers, sampleRows);
    if (!score) return 0;
    return hasPjMarkers(sampleRows, headerIndex(headers, "Descrição"), hints) ? score * 0.95 : score * 0.85;
  },
  parse(rows, ctx) {
    return readTable(rows, ctx, accountSpec(rows[ctx.headerRowIndex] ?? []));
  },
};

export const nubankCardProfile: StatementProfile = {
  id: "nubank-card",
  label: "Nubank credit card (CSV)",
  institutionSlug: "nubank",
  accountType: "credit_card",
  matches(headers, sampleRows) {
    const base = signatureScore(headers, CARD_HEADERS);
    if (!base) return 0;
    return columnRate(sampleRows, headerIndex(headers, "date"), (v) => ISO.test(v)) >= 0.8 ? base * 0.95 : base * 0.5;
  },
  parse(rows, ctx) {
    const headers = rows[ctx.headerRowIndex] ?? [];
    return readTable(rows, ctx, {
      date: headerIndex(headers, "date"),
      dateOrder: "YMD",
      decimal: ".",
      amount: { kind: "signed", col: headerIndex(headers, "amount") },
      // Card export: positive = purchase (money out of the card account).
      invertSign: true,
      description: (row) => cellAt(row.cells, headerIndex(headers, "title")),
      currency: "BRL",
      accountType: "credit_card",
      country: "BR",
      extraction: "exact",
    });
  },
};
