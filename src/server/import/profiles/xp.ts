/**
 * XP Investimentos account statement CSV:
 *   Data;Descrição;Valor;Saldo
 *
 * NOTE: this layout is based on publicly known export formats and must be
 * validated against real exports before production.
 *
 * ";" delimited, comma decimal, signed values, DD/MM/YYYY, BRL. This is the
 * brokerage cash account (type "investment"). The header is generic, so the
 * XP institution it implies is only a weak hint that document text overrides.
 */
import { parseDate } from "@/domain/import/parse-date";
import { cellAt, columnRate, headerIndex, readTable, signatureScore } from "./table";
import type { StatementProfile } from "./types";

const HEADERS = ["Data", "Descrição", "Valor", "Saldo"];

export const xpProfile: StatementProfile = {
  id: "xp",
  label: "XP Investimentos (CSV)",
  institutionSlug: "xp",
  accountType: "investment",
  weakInstitutionSignal: true,
  matches(headers, sampleRows) {
    // Exact header only: "Data;Descrição;Valor;Saldo" plus extra columns is some other bank.
    const base = signatureScore(headers, HEADERS, [], { strict: true });
    if (!base) return 0;
    const dates = columnRate(sampleRows, headerIndex(headers, "Data"), (v) => parseDate(v, "DMY") !== null);
    return (dates >= 0.8 ? base : base * 0.5) * 0.85;
  },
  parse(rows, ctx) {
    const headers = rows[ctx.headerRowIndex] ?? [];
    const col = (name: string) => headerIndex(headers, name);
    return readTable(rows, ctx, {
      date: col("Data"),
      dateOrder: "DMY",
      decimal: ",",
      amount: { kind: "signed", col: col("Valor") },
      description: (row) => cellAt(row.cells, col("Descrição")),
      balance: col("Saldo"),
      currency: "BRL",
      accountType: "investment",
      country: "BR",
      extraction: "exact",
    });
  },
};
