import { expect, it } from "vitest";
import { parseAmount } from "@/domain/import/parse-amount";
import { amountAppearsInLine } from "@/server/ai/statement-validation";
import { buildPdf, type PdfLineSpec } from "../../../../tests/helpers/pdf-writer";
import { extractPdfLines, parsePdf } from "./pdf";
import { parseSignedLedger } from "./signed-ledger";

const row = (date: string, history: string, value: string): PdfLineSpec => [{ x: 30, text: date }, { x: 100, text: "12345" }, ...(history ? [{ x: 260, text: history }] : []), { x: 520, text: value }];
const fixture = (daily = "90,00 (+)", issuer = "Nubank", product = "Fundo Ficticio") => buildPdf([[
  `${issuer} Extrato de Conta Corrente`, "Cliente Ficticio",
  "Período: 01 a 30/04/2026 Agência: 0001-0 Conta: 12345-6",
  [{ x: 30, text: "Dia" }, { x: 100, text: "Lote" }, { x: 150, text: "Documento" }, { x: 260, text: "Histórico" }, { x: 550, text: "Valor" }],
  row("31/03/2026", "Saldo Anterior", "100,00 (+)"),
  [{ x: 260, text: "Compra Ficticia" }], row("01/04/2026", "", "10,00 (-)"),
  [{ x: 260, text: "01/04 11:54 LOJA FICTICIA" }],
  row("01/04/2026", "Saldo do dia", daily),
  row("02/04/2026", "Credito Ficticio", "20,00 (+)"),
], [
  "Extrato de Conta Corrente", "Cliente: Ficticio",
  "Período: 01 a 30/04/2026 Agência: 0001-0 Conta: 12345-6",
  [{ x: 30, text: "Dia" }, { x: 100, text: "Lote" }, { x: 150, text: "Documento" }, { x: 260, text: "Histórico" }, { x: 550, text: "Valor" }],
  row("30/04/2026", "S A L D O", "110,00 (+)"),
  "Aplicações Financeiras", `${product} 200,00`, "LCI Ficticia 300,00",
]]);

it.each([["43,63 (-)", "-43.63"], ["43,63 (+)", "43.63"], ["1.621,00 (-)", "-1621"], ["0,00 (+)", "0"]])("reads post-value sign %s", (source, expected) => {
  expect(parseAmount(source)?.amount).toBe(expected);
  expect(amountAppearsInLine(expected, source)).toBe("match");
});

it("rebuilds wrapped history, preserves booked dates, skips daily balances and keeps positions separate", async () => {
  const p = await parsePdf(fixture());
  expect(p.statedPeriod).toEqual({ start: "2026-04-01", end: "2026-04-30" });
  expect(p.statement.warnings).toEqual([]);
  const [checking, fund, lci] = p.statement.accounts;
  expect(checking!.transactions.map(t => [t.bookedOn, t.amount, t.description])).toEqual([
    ["2026-04-01", "-10", "Compra Ficticia 01/04 11:54 LOJA FICTICIA"],
    ["2026-04-02", "20", "Credito Ficticio"],
  ]);
  expect(checking).toMatchObject({ openingBalance: { amount: "100", asOf: "2026-03-31" }, closingBalance: { amount: "110", asOf: "2026-04-30" } });
  expect(fund).toMatchObject({ type: "investment", name: "Fundo Ficticio", transactions: [], closingBalance: { amount: "200", asOf: "2026-04-30" } });
  expect(lci).toMatchObject({ type: "investment", transactions: [], closingBalance: { amount: "300" } });
  expect(checking!.transactions[0]!.raw.description_lines!.split(",")).toHaveLength(3);
});

it("retains a review warning when a daily balance contradicts movements", async () => {
  const p = await parsePdf(fixture("99,00 (+)"));
  expect(p.statement.warnings).toContainEqual(expect.objectContaining({ code: "balance_mismatch" }));
});

it("uses branded owned positions only as weak issuer evidence, not transaction counterparties", async () => {
  const own = await parsePdf(fixture("90,00 (+)", "", "BB Rende Facil"));
  expect(own.profileInstitution).toMatchObject({ slug: "banco-do-brasil", weak: true });
  const lines = await extractPdfLines(fixture("90,00 (+)", ""));
  const movement = lines.find(l => l.text.includes("Credito Ficticio"))!;
  movement.text += " BB Rende Facil";
  const p = parseSignedLedger(lines, { fallbackCurrency: "BRL" })!;
  expect(p.profileInstitution).toBeUndefined();
});
