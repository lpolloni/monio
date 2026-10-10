import { describe, expect, it } from "vitest";
import { canLearnPdf, pdfLayoutKey, reusablePdf } from "./pdf-learning";
import type { ParserOutput } from "./types";
import type { DocumentAiResult } from "./document-ai";
import type { PdfLine } from "./pdf";

function fixture() {
  const native: ParserOutput = {
    profileInstitution: { slug: "nubank", weak: false, evidence: "fixture" },
    statedPeriod: { start: "2026-09-01", end: "2026-09-30" },
    statement: { format: "pdf", profile: "nubank-account-pdf", warnings: [], accounts: [{ key: "default", type: "checking", identifier: "nubank:0001:1234", currency: "BRL", openingBalance: { amount: "100", asOf: "2026-09-01" }, closingBalance: { amount: "90", asOf: "2026-09-30" }, transactions: [{ sourceRow: 2, bookedOn: "2026-09-04", amount: "-10", currency: "BRL", description: "Compra fictícia", extraction: "heuristic", raw: {} }] }] },
  };
  const lines: PdfLine[] = ["Saldo inicial 100,00", "04/09/2026 Compra fictícia -10,00", "Saldo final 90,00"].map((text, i) => ({ line: i + 1, page: 1, text, items: [] }));
  const result: DocumentAiResult = { skippedLines: [], batches: [{ primaryLines: [1, 2, 3], lines, proposal: { institution: null, period: null, accounts: [], unparsedLines: [] } }] };
  return { native, interpreted: structuredClone(native), result, lines };
}

describe("safe PDF learning", () => {
  it("certifies only independent complete agreement with all source sections", () => {
    const f = fixture();
    expect(canLearnPdf(f.native, f.interpreted, f.result, f.lines)).toBe(true);
    f.result.batches[0]!.primaryLines.pop();
    expect(canLearnPdf(f.native, f.interpreted, f.result, f.lines)).toBe(false);
  });
  it("does not learn partial, unresolved, conflicting or unreconciled interpretations", () => {
    for (const corrupt of [
      (f: ReturnType<typeof fixture>) => { f.result.skippedLines = [3]; },
      (f: ReturnType<typeof fixture>) => { f.result.batches[0]!.proposal.unparsedLines = [1]; },
      (f: ReturnType<typeof fixture>) => { f.interpreted.statement.accounts[0]!.transactions[0]!.amount = "10"; },
      (f: ReturnType<typeof fixture>) => { f.native.statement.accounts[0]!.closingBalance!.amount = "80"; },
      (f: ReturnType<typeof fixture>) => { f.interpreted.statement.accounts[0]!.identifier = "other"; },
      (f: ReturnType<typeof fixture>) => { f.interpreted.statement.warnings.push({ code: "row_unreadable", message: "fixture" }); },
    ]) {
      const f = fixture(); corrupt(f);
      expect(canLearnPdf(f.native, f.interpreted, f.result, f.lines)).toBe(false);
    }
  });
  it("detects new monetary content even when omitted debits and credits cancel", () => {
    const f = fixture();
    f.lines.push({ line: 4, page: 2, text: "Nova seção +20,00 -20,00", items: [] });
    expect(reusablePdf(f.native, f.lines)).toBe(false);
  });
  it("revalidates the current file rather than reusing prior money", () => {
    const f = fixture();
    const key = pdfLayoutKey(f.native, []);
    f.native.statement.accounts[0]!.transactions[0]!.amount = "-20";
    expect(pdfLayoutKey(f.native, [])).toBe(key);
    expect(reusablePdf(f.native, f.lines)).toBe(false);
    f.native.statement.accounts[0]!.closingBalance!.amount = "80";
    expect(reusablePdf(f.native, f.lines)).toBe(true);
  });
  it("keys strategies by reader, issuer and column geometry, without account values", () => {
    const f = fixture();
    const columns = [[{ role: "amount", center: 400 }, { role: "balance", center: 480 }]];
    f.native.statement.profile = "pdf-column-statement";
    const key = pdfLayoutKey(f.native, columns);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    f.native.statement.accounts[0]!.identifier = "different-account";
    expect(pdfLayoutKey(f.native, columns)).toBe(key);
    expect(pdfLayoutKey(f.native, [[{ role: "amount", center: 480 }, { role: "balance", center: 400 }]])).not.toBe(key);
    f.native.statement.profile = "pdf-lines";
    expect(pdfLayoutKey(f.native, columns)).toBeUndefined();
  });
});

// Exercise the actual PDF entry point: new files are interpreted before a fast path is enabled.
import { vi } from "vitest";
vi.mock("./pdf-ocr", () => ({ createPdfOcrWorker: async () => { throw new Error("OCR unavailable in this learning test"); } }));
import { buildPdf } from "../../../../tests/helpers/pdf-writer";
import { parsePdf } from "./pdf";
import type { PdfLearningStore } from "./pdf-learning";
import type { PdfDocumentAssist } from "./document-ai";

it("learns from two distinct imports, then re-extracts new values without document AI", async () => {
  const evidence = new Set<string>();
  let document = "one";
  const store: PdfLearningStore = {
    confirmations: async () => evidence.size,
    confirm: async () => { evidence.add(document); },
    invalidate: async () => { evidence.clear(); },
  };
  const makePdf = (debit: string, closing: string) => buildPdf([[
    "Cliente Fictício CPF Agência 0001 Conta 1234567-8",
    "01 DE SETEMBRO DE 2026 a 30 DE SETEMBRO DE 2026 VALORES EM R$",
    "Saldo inicial 100,00", `Saldo final do período ${closing}`,
    `04 SET 2026 Total de saídas - ${debit}`,
    `Transferência enviada pelo Pix LOJA FICTICIA ${debit}`,
    "Nu Pagamentos S.A.",
  ]]);
  const assist = vi.fn<PdfDocumentAssist>(async lines => {
    const amount = lines[5]!.text.endsWith("10,00") ? "-10" : "-20";
    return { skippedLines: [], batches: [{ lines, primaryLines: lines.map(l => l.line), proposal: {
      institution: { name: "Nu Pagamentos S.A.", line: 7 },
      period: { start: "2026-09-01", end: "2026-09-30", startLine: 2, endLine: 2 },
      unparsedLines: [], accounts: [{ key: "one", type: "checking", currency: "BRL", currencyLine: 2, identifier: "1234567-8", identifierLine: 1,
        openingBalance: { amount: "100", amountLine: 3, asOf: "2026-09-01", dateLine: 2 },
        closingBalance: { amount: amount === "-10" ? "90" : "80", amountLine: 4, asOf: "2026-09-30", dateLine: 2 },
        transactions: [{ line: 6, date: "2026-09-04", dateLine: 5, description: "Transferência enviada pelo Pix LOJA FICTICIA", descriptionLines: [6], amount, amountLine: 6, directionLine: 5 }],
      }],
    } }] };
  });
  const ctx = { documentAssist: assist, pdfLearning: store };
  await parsePdf(makePdf("10,00", "90,00"), ctx);
  expect(evidence.size).toBe(1);
  // Retrying the same original cannot count as independent confirmation.
  await parsePdf(makePdf("10,00", "90,00"), ctx);
  expect(evidence.size).toBe(1);
  document = "two";
  await parsePdf(makePdf("20,00", "80,00"), ctx);
  expect(evidence.size).toBe(2);
  const calls = assist.mock.calls.length;
  const third = await parsePdf(makePdf("30,00", "70,00"), ctx);
  expect(assist).toHaveBeenCalledTimes(calls);
  expect(third.statement.accounts[0]!.transactions[0]!.amount).toBe("-30");
  expect(third.statement.accounts[0]!.closingBalance!.amount).toBe("70");
  // A drift that breaks reconciliation must return to AI and revoke the strategy.
  await parsePdf(makePdf("20,00", "70,00"), ctx);
  expect(assist.mock.calls.length).toBe(calls + 1);
  expect(evidence.size).toBe(0);
});
