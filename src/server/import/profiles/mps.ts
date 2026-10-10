/**
 * Monte dei Paschi di Siena (MPS) CSV export:
 *   Data Contabile;Data Valuta;Descrizione;Dare;Avere
 *
 * NOTE: this layout is based on publicly known export formats and must be
 * validated against real exports before production.
 *
 * ";" delimited, comma decimal, DD/MM/YYYY. Dare = debit (money out, written
 * with or without a minus sign), Avere = credit. The header is shared with
 * other Italian banks, so the institution it implies is only a weak hint.
 */
import { parseDate } from "@/domain/import/parse-date";
import { cellAt, columnRate, headerIndex, readTable, signatureScore } from "./table";
import type { StatementProfile } from "./types";

const HEADERS = ["Data Contabile", "Data Valuta", "Descrizione", "Dare", "Avere"];
const OPTIONAL = ["Saldo", "Causale", "Categoria"];

export const mpsProfile: StatementProfile = {
  id: "mps",
  label: "Monte dei Paschi di Siena (CSV)",
  institutionSlug: "mps",
  accountType: "checking",
  weakInstitutionSignal: true,
  matches(headers, sampleRows) {
    const base = signatureScore(headers, HEADERS, OPTIONAL);
    if (!base) return 0;
    const dates = columnRate(sampleRows, headerIndex(headers, "Data Contabile"), (v) => parseDate(v, "DMY") !== null);
    return (dates >= 0.8 ? base : base * 0.5) * 0.9;
  },
  parse(rows, ctx) {
    const headers = rows[ctx.headerRowIndex] ?? [];
    const col = (name: string) => headerIndex(headers, name);
    return readTable(rows, ctx, {
      date: col("Data Contabile"),
      valueDate: col("Data Valuta"),
      dateOrder: "DMY",
      decimal: ",",
      amount: { kind: "split", debitCol: col("Dare"), creditCol: col("Avere") },
      description: (row) => cellAt(row.cells, col("Descrizione")),
      currency: "EUR",
      balance: col("Saldo") >= 0 ? col("Saldo") : undefined,
      accountType: "checking",
      country: "IT",
      extraction: "exact",
    });
  },
};
