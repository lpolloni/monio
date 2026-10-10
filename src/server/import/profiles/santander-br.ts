/**
 * Santander Brasil account statement CSV:
 *   Data;Histórico;Docto.;Crédito (R$);Débito (R$);Saldo (R$)
 *
 * NOTE: this layout is based on publicly known export formats and must be
 * validated against real exports before production.
 *
 * ";" delimited, Windows-1252/Latin-1 encoded, comma decimal, DD/MM/YYYY.
 * Debits may be written with or without a minus sign. "SALDO ANTERIOR" rows
 * carry the opening balance and are not transactions. "Docto." (document
 * number) is not unique, so it is kept in `raw` only.
 */
import { parseDate } from "@/domain/import/parse-date";
import { cellAt, columnRate, headerIndex, readTable, signatureScore } from "./table";
import type { StatementProfile } from "./types";

const HEADERS = ["Data", "Histórico", "Docto.", "Crédito (R$)", "Débito (R$)", "Saldo (R$)"];

export const santanderBrProfile: StatementProfile = {
  id: "santander-br",
  label: "Santander Brasil (CSV)",
  institutionSlug: "santander-br",
  accountType: "checking",
  matches(headers, sampleRows) {
    const base = signatureScore(headers, HEADERS);
    if (!base) return 0;
    const dates = columnRate(sampleRows, headerIndex(headers, "Data"), (v) => parseDate(v, "DMY") !== null);
    return (dates >= 0.8 ? base : base * 0.5) * 0.95;
  },
  parse(rows, ctx) {
    const headers = rows[ctx.headerRowIndex] ?? [];
    const col = (name: string) => headerIndex(headers, name);
    return readTable(rows, ctx, {
      date: col("Data"),
      dateOrder: "DMY",
      decimal: ",",
      amount: { kind: "split", creditCol: col("Crédito (R$)"), debitCol: col("Débito (R$)") },
      description: (row) => cellAt(row.cells, col("Histórico")),
      balance: col("Saldo (R$)"),
      currency: "BRL",
      accountType: "checking",
      country: "BR",
      extraction: "exact",
    });
  },
};
