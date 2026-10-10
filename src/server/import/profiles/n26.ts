/**
 * N26 CSV exports.
 *
 * NOTE: these layouts are based on publicly known N26 export formats and must
 * be validated against real exports before production. Two header variants:
 *
 *  v1: "Date","Payee","Account number","Transaction type","Payment reference",
 *      "Amount (EUR)","Amount (Foreign Currency)","Type Foreign Currency","Exchange Rate"
 *  v2: "Booking Date","Value Date","Partner Name","Partner Iban","Type",
 *      "Payment Reference","Account Name","Amount (EUR)","Original Amount",
 *      "Original Currency","Exchange Rate"
 *
 * ISO dates, dot decimal, signed EUR amounts. Foreign-currency card payments
 * carry the original amount/currency. v2 exports may mix the main account and
 * Spaces ("Account Name"), which become separate accounts. The counterparty
 * IBAN ("Account number"/"Partner Iban") is kept only in `raw`.
 */
import { cellAt, columnRate, headerIndex, readTable, signatureScore } from "./table";
import type { StatementProfile } from "./types";

const V1 = [
  "Date",
  "Payee",
  "Account number",
  "Transaction type",
  "Payment reference",
  "Amount (EUR)",
  "Amount (Foreign Currency)",
  "Type Foreign Currency",
  "Exchange Rate",
];
const V2 = [
  "Booking Date",
  "Value Date",
  "Partner Name",
  "Partner Iban",
  "Type",
  "Payment Reference",
  "Account Name",
  "Amount (EUR)",
  "Original Amount",
  "Original Currency",
  "Exchange Rate",
];
const ISO = /^\d{4}-\d{2}-\d{2}/;

function joinDescription(payee: string, reference: string): string {
  const ref = reference === "-" ? "" : reference;
  if (!payee) return ref;
  if (!ref || payee.toLowerCase().includes(ref.toLowerCase())) return payee;
  return `${payee} - ${ref}`;
}

export const n26Profile: StatementProfile = {
  id: "n26",
  label: "N26 (CSV)",
  institutionSlug: "n26",
  accountType: "checking",
  matches(headers, sampleRows) {
    const v1 = signatureScore(headers, V1, ["Category"]);
    const v2 = signatureScore(headers, V2, ["Category"]);
    const base = Math.max(v1, v2);
    if (!base) return 0;
    const dateCol = v2 >= v1 ? headerIndex(headers, "Booking Date") : headerIndex(headers, "Date");
    return columnRate(sampleRows, dateCol, (v) => ISO.test(v)) >= 0.8 ? base * 0.97 : base * 0.5;
  },
  parse(rows, ctx) {
    const headers = rows[ctx.headerRowIndex] ?? [];
    const isV2 = headerIndex(headers, "Booking Date") >= 0;
    const payee = headerIndex(headers, isV2 ? "Partner Name" : "Payee");
    const reference = headerIndex(headers, "Payment Reference");
    const accountName = headerIndex(headers, "Account Name");
    return readTable(rows, ctx, {
      date: headerIndex(headers, isV2 ? "Booking Date" : "Date"),
      valueDate: isV2 ? headerIndex(headers, "Value Date") : undefined,
      dateOrder: "YMD",
      decimal: ".",
      amount: { kind: "signed", col: headerIndex(headers, "Amount (EUR)") },
      description: (row) => joinDescription(cellAt(row.cells, payee), cellAt(row.cells, reference)),
      counterparty: (row) => cellAt(row.cells, payee) || undefined,
      currency: "EUR",
      originalAmountCol: headerIndex(headers, isV2 ? "Original Amount" : "Amount (Foreign Currency)"),
      originalCurrencyCol: headerIndex(headers, isV2 ? "Original Currency" : "Type Foreign Currency"),
      account:
        accountName >= 0
          ? (row) => {
              const name = cellAt(row.cells, accountName) || "Main Account";
              return { key: name, name };
            }
          : undefined,
      accountType: "checking",
      extraction: "exact",
    });
  },
};
