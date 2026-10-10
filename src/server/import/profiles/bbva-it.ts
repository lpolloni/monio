/**
 * BBVA Italia statement export (XLSX, also accepted as CSV).
 *
 * NOTE: this layout is based on publicly known export formats and must be
 * validated against real exports before production.
 *
 * Two variants, usually below a preamble (holder, IBAN, period):
 *   A) Data contabile | Data valuta | Descrizione | Importo | Divisa   (signed)
 *   B) Data operazione | Data valuta | Descrizione | Entrate | Uscite  (in/out)
 * Dates DD/MM/YYYY (or real date cells); text amounts use comma decimals,
 * spreadsheet numeric cells are read exactly. These headers are shared with
 * other Italian banks, so the institution they imply is only a weak hint.
 */
import { parseDate } from "@/domain/import/parse-date";
import { cellAt, columnRate, headerIndex, readTable, signatureScore } from "./table";
import type { StatementProfile } from "./types";

const SIGNED = ["Data contabile", "Data valuta", "Descrizione", "Importo", "Divisa"];
const SPLIT = ["Data operazione", "Data valuta", "Descrizione", "Entrate", "Uscite"];
const OPTIONAL = ["Saldo", "Categoria", "Descrizione completa", "Causale", "Stato"];

const isItalianDate = (v: string) => parseDate(v, "DMY") !== null;

function withDates(base: number, sampleRows: string[][], dateCol: number): number {
  if (!base) return 0;
  return columnRate(sampleRows, dateCol, isItalianDate) >= 0.8 ? base : base * 0.5;
}

export const bbvaItalyProfile: StatementProfile = {
  id: "bbva-it",
  label: "BBVA Italia (XLSX/CSV)",
  institutionSlug: "bbva-it",
  accountType: "checking",
  weakInstitutionSignal: true,
  matches(headers, sampleRows) {
    const signed = signatureScore(headers, SIGNED, OPTIONAL);
    if (signed) return withDates(signed, sampleRows, headerIndex(headers, "Data contabile")) * 0.9;
    const split = signatureScore(headers, SPLIT, OPTIONAL);
    return withDates(split, sampleRows, headerIndex(headers, "Data operazione")) * 0.9;
  },
  parse(rows, ctx) {
    const headers = rows[ctx.headerRowIndex] ?? [];
    const col = (name: string) => headerIndex(headers, name);
    const signed = col("Importo") >= 0;
    return readTable(rows, ctx, {
      date: signed ? col("Data contabile") : col("Data operazione"),
      valueDate: col("Data valuta"),
      dateOrder: "DMY",
      decimal: ",",
      amount: signed
        ? { kind: "signed", col: col("Importo") }
        : { kind: "split", creditCol: col("Entrate"), debitCol: col("Uscite") },
      description: (row) => cellAt(row.cells, col("Descrizione")),
      currencyCol: col("Divisa") >= 0 ? col("Divisa") : undefined,
      currency: "EUR",
      balance: col("Saldo") >= 0 ? col("Saldo") : undefined,
      accountType: "checking",
      country: "IT",
      extraction: "exact",
    });
  },
};
