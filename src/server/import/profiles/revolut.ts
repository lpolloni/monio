/**
 * Revolut CSV export:
 *   Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
 *
 * NOTE: this layout is based on the publicly known Revolut export format and
 * must be validated against real exports before production.
 *
 * - One account per Product + Currency (Revolut keeps a pocket per currency).
 * - Booked date = Completed Date (falls back to Started Date for pending rows).
 * - The fee is booked as its own transaction (same source row, `raw._part =
 *   "fee"`), so that amount + fee effects both reach the ledger and the running
 *   Balance column reconciles.
 * - REVERTED / DECLINED / FAILED rows never moved money: skipped with a warning.
 *   PENDING rows are kept and flagged `pending`.
 */
import type { AccountType, ParsedTransaction } from "@/domain/import/types";
import { parseAmount } from "@/domain/import/parse-amount";
import { normalizeDescription } from "../parsers/text";
import { cellAt, columnRate, headerIndex, isZeroAmount, negateAmount, readTable, signatureScore } from "./table";
import type { StatementProfile } from "./types";

const HEADERS = ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount", "Fee", "Currency", "State", "Balance"];
const ISO = /^\d{4}-\d{2}-\d{2}/;
const SKIPPED = new Set(["REVERTED", "DECLINED", "FAILED", "CANCELLED", "CANCELED"]);

function productType(product: string): AccountType {
  const p = product.toLowerCase();
  if (p.includes("saving") || p.includes("deposit") || p.includes("vault")) return "savings";
  if (p.includes("invest")) return "investment";
  if (p.includes("crypto")) return "crypto_wallet";
  return "checking";
}

export const revolutProfile: StatementProfile = {
  id: "revolut",
  label: "Revolut (CSV)",
  institutionSlug: "revolut",
  accountType: "checking",
  matches(headers, sampleRows) {
    const base = signatureScore(headers, HEADERS);
    if (!base) return 0;
    return columnRate(sampleRows, headerIndex(headers, "Started Date"), (v) => ISO.test(v)) >= 0.8 ? base * 0.97 : base * 0.5;
  },
  parse(rows, ctx) {
    const headers = rows[ctx.headerRowIndex] ?? [];
    const col = (name: string) => headerIndex(headers, name);
    const state = col("State");
    const fee = col("Fee");
    const product = col("Product");
    return readTable(rows, ctx, {
      date: col("Completed Date"),
      dateFallback: col("Started Date"),
      dateOrder: "YMD",
      decimal: ".",
      amount: { kind: "signed", col: col("Amount") },
      description: (row) => cellAt(row.cells, col("Description")),
      currencyCol: col("Currency"),
      balance: col("Balance"),
      account: (row, currency) => {
        const name = cellAt(row.cells, product) || "Current";
        return { key: `${name}:${currency}`, name: `${name} ${currency}`, type: productType(name) };
      },
      skip: (row) => {
        const value = cellAt(row.cells, state).toUpperCase();
        return SKIPPED.has(value) ? { reason: `Revolut ${value} transaction skipped (not booked).`, warn: true } : undefined;
      },
      pending: (row) => cellAt(row.cells, state).toUpperCase() === "PENDING",
      extra: (row, base): ParsedTransaction[] => {
        const feeRaw = cellAt(row.cells, fee);
        const parsed = feeRaw ? parseAmount(feeRaw, ".") : null;
        if (!parsed || isZeroAmount(parsed.amount)) return [];
        // Revolut reports fees as positive charges.
        const feeTx: ParsedTransaction = {
          bookedOn: base.bookedOn,
          description: normalizeDescription(`Fee: ${base.description}`),
          amount: negateAmount(parsed.amount),
          currency: base.currency,
          sourceRow: base.sourceRow,
          raw: { ...base.raw, _part: "fee" },
          extraction: base.extraction,
        };
        if (base.pending) feeTx.pending = true;
        return [feeTx];
      },
      accountType: "checking",
      extraction: "exact",
    });
  },
};
