import { expect, it, vi } from "vitest";
import { buildPdf } from "../../../../tests/helpers/pdf-writer";
import { extractPdfLines, parsePdf, parsePdfLines } from "./pdf";

async function recovered(closing = "2.216,02", intermediate = "32,02") {
  return extractPdfLines(buildPdf([[
    "Nubank - Extrato de Conta Corrente",
    "Resumo - setembro/2026",
    [{ x: 40, text: "Agência" }, { x: 130, text: "Conta Corrente" }],
    [{ x: 40, text: "0001" }, { x: 130, text: "01.123456-7" }],
    [{ x: 40, text: "Data" }, { x: 120, text: "Descrição" }, { x: 300, text: "Documento" }, { x: 400, text: "Movimento (R$)" }, { x: 510, text: "Saldo" }],
    [{ x: 120, text: "SALDO EM 31/08" }, { x: 510, text: "134,50" }],
    [{ x: 40, text: "21/09" }, { x: 120, text: "PAGAMENTO FICTICIO" }, { x: 300, text: "123456" }, { x: 430, text: "102,50-" }],
    [{ x: 120, text: "21/09 20:53 CONTINUACAO FICTICIA" }],
    [{ x: 120, text: "REMUNERACAO FICTICIA" }, { x: 320, text: "-" }, { x: 430, text: "0,02" }, { x: 510, text: intermediate }],
    [{ x: 40, text: "28/09" }, { x: 120, text: "PIX RECEBIDO FICTICIO" }, { x: 320, text: "-" }, { x: 430, text: "2.184,00" }, { x: 510, text: "2.216,02" }],
    [{ x: 120, text: "SALDO EM 30/09" }, { x: 510, text: closing }],
  ]]));
}

it("reads grouped dates and positioned movement values with independent running/closing reconciliation", async () => {
  const p = await parsePdfLines(await recovered());
  expect(p.statement.profile).toBe("pdf-column-statement");
  expect(p.statement.accounts[0]).toMatchObject({
    identifier: "bank:nubank:011234567", currency: "BRL",
    openingBalance: { amount: "134.5", asOf: "2026-08-31" },
    closingBalance: { amount: "2216.02", asOf: "2026-09-30" },
  });
  expect(p.statement.accounts[0]!.transactions.map(t => [t.bookedOn, t.amount])).toEqual([
    ["2026-09-21", "-102.5"], ["2026-09-21", "0.02"], ["2026-09-28", "2184"],
  ]);
});

it("skips the model when the visually recovered statement reconciles with its printed balances", async () => {
  const full = await recovered();
  const partial = await extractPdfLines(buildPdf([["Nubank extrato", "21/09/2026 PAGAMENTO FICTICIO -102,50"]]));
  const extractor = vi.fn(async (_bytes: Uint8Array, visual?: boolean) => visual ? full : partial);
  const assist = vi.fn(async () => ({ batches: [], skippedLines: [] }));
  const p = await parsePdf(new Uint8Array([1]), { documentAssist: assist }, { extractLines: extractor });
  expect(extractor.mock.calls.map(c => c[1])).toEqual([undefined, true]);
  expect(assist).not.toHaveBeenCalled();
  expect(p.statement.accounts[0]!.transactions).toHaveLength(3);
  expect(p.statement.accounts[0]!.closingBalance!.amount).toBe("2216.02");
  expect(p.statement.warnings).toEqual([]);
});

it.each(["timeout", "empty"])("keeps the visually recovered deterministic read on AI %s when the statement does not reconcile", async failure => {
  // An intermediate printed balance disagrees: the reconciled reader refuses, the model is asked.
  const full = await recovered("2.216,02", "99,00");
  const deterministic = await parsePdfLines(full);
  const partial = await extractPdfLines(buildPdf([["Nubank extrato", "21/09/2026 PAGAMENTO FICTICIO -102,50"]]));
  const extractor = vi.fn(async (_bytes: Uint8Array, visual?: boolean) => visual ? full : partial);
  const assist = vi.fn(async () => {
    if (failure === "timeout") throw new Error("Fictional provider timeout");
    return { batches: [], skippedLines: [] };
  });
  const p = await parsePdf(new Uint8Array([1]), { documentAssist: assist }, { extractLines: extractor });
  expect(extractor.mock.calls.map(c => c[1])).toEqual([undefined, true]);
  expect(assist).toHaveBeenCalledOnce();
  expect(p.statement.accounts[0]!.transactions).toEqual(deterministic.statement.accounts[0]!.transactions);
  expect(p.statement.warnings.some(w => w.code === "ai_rejected_row")).toBe(true);
});

it.each([["999,00", "32,02"], ["2.216,02", "99,00"]])("refuses certification when closing/intermediate source balances disagree", async (closing, intermediate) => {
  const p = await parsePdfLines(await recovered(closing, intermediate));
  // The existing generic parser remains reviewable; the reconciled reader cannot certify it.
  expect(p.statement.accounts[0]!.transactions.some(t => t.raw.date_source_row)).toBe(false);
});
