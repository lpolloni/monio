import { describe, expect, it, vi } from "vitest";
import type { DocumentBatch, DocumentLine, DocumentProposal } from "@/server/ai/document-contract";
import { parseDocument } from "../parse-document";
import { buildPdf } from "../../../../tests/helpers/pdf-writer";
import { mergeDocumentInterpretation, validateDocumentInterpretation, type PdfDocumentAssist } from "./document-ai";

const texts = [
  "Banco Fictício Aurora", "Conta 12345-6",
  "Período 01/09/2026 a 30/09/2026 BRL",
  "Saldo inicial 100,00", "02/09/2026 Saídas",
  "Pagamento LOJA FICTICIA", "10,00", "Saldo final 90,00",
];
const lines: DocumentLine[] = texts.map((text, i) => ({ line: i + 1, page: 1, text, items: [] }));
const proposal = (): DocumentProposal => ({
  institution: { name: texts[0]!, line: 1 },
  period: { start: "2026-09-01", startLine: 3, end: "2026-09-30", endLine: 3 },
  accounts: [{ key: "account-1", type: "checking", currency: "BRL", currencyLine: 3, identifier: "12345-6", identifierLine: 2,
    openingBalance: { amount: "100", amountLine: 4, asOf: "2026-09-01", dateLine: 3 },
    closingBalance: { amount: "90", amountLine: 8, asOf: "2026-09-30", dateLine: 3 },
    transactions: [{ line: 6, date: "2026-09-02", dateLine: 5, description: "Pagamento LOJA FICTICIA", descriptionLines: [6], amount: "-10", amountLine: 7, directionLine: 5 }],
  }], unparsedLines: [],
});
function result(p = proposal(), source = lines, primaryLines = source.map(l => l.line)): { batches: DocumentBatch[]; skippedLines: number[] } {
  return { batches: [{ proposal: p, lines: source, primaryLines }], skippedLines: [] };
}

describe("source-verified full document interpretation", () => {
  it("interprets an unknown layout whose movements have no date/amount on the description line", async () => {
    const documentAssist = vi.fn<PdfDocumentAssist>(async input => result(proposal(), input));
    const st = await parseDocument({ bytes: buildPdf([texts]), filename: "unknown.pdf" }, { documentAssist });
    expect(documentAssist).toHaveBeenCalledOnce();
    expect(documentAssist.mock.calls[0]![0].map(l => l.text)).toEqual(texts);
    expect(documentAssist.mock.calls[0]![0][0]!.items[0]!.x).toBeGreaterThan(0);
    expect(st.institution?.name).toBe(texts[0]);
    expect(st.accounts[0]).toMatchObject({ identifier: "bank:bancoficticioaurora:123456", type: "checking", currency: "BRL" });
    expect(st.accounts[0]!.transactions).toEqual([expect.objectContaining({ bookedOn: "2026-09-02", description: "Pagamento LOJA FICTICIA", amount: "-10", extraction: "ai", sourceRow: 6 })]);
    expect(st.warnings).toEqual([]);
  });

  it.each([
    ["invented amount", (p: DocumentProposal) => { p.accounts[0]!.transactions[0]!.amount = "-999"; }],
    ["invented date", (p: DocumentProposal) => { p.accounts[0]!.transactions[0]!.date = "2026-09-03"; }],
    ["invented description", (p: DocumentProposal) => { p.accounts[0]!.transactions[0]!.description = "Invented transaction"; }],
    ["wrong direction", (p: DocumentProposal) => { p.accounts[0]!.transactions[0]!.amount = "10"; }],
    ["nonexistent evidence", (p: DocumentProposal) => { p.accounts[0]!.transactions[0]!.amountLine = 999; }],
    ["summary as transaction", (p: DocumentProposal) => { const t = p.accounts[0]!.transactions[0]!; t.line = 4; t.amountLine = 4; t.amount = "-100"; t.description = "Saldo inicial"; t.descriptionLines = [4]; }],
  ])("rejects %s", (_name, mutate) => {
    const p = proposal(); mutate(p);
    const out = validateDocumentInterpretation(result(p));
    expect(out.statement.accounts.flatMap(a => a.transactions)).toEqual([]);
    // References outside the owned batch cannot create transactions.
    if (p.accounts[0]!.transactions[0]!.amountLine !== 999) expect(out.statement.warnings.some(w => w.code === "ai_rejected_row")).toBe(true);
  });

  it("rejects conflicting duplicates without collapsing legitimate identical payments on different lines", () => {
    const p = proposal(); p.accounts[0]!.transactions.push({ ...p.accounts[0]!.transactions[0]! });
    const out = validateDocumentInterpretation(result(p));
    expect(out.statement.accounts[0]!.transactions).toEqual([]);
    expect(out.statement.warnings.filter(w => w.code === "ai_rejected_row")).toHaveLength(2);
  });

  it("rejects unsupported currency, account, issuer and balance evidence", () => {
    const p = proposal(); p.accounts[0]!.currency = "USD";
    expect(validateDocumentInterpretation(result(p)).statement.accounts).toEqual([]);
    const bad = proposal(); bad.institution = { name: "Other Bank", line: 6 }; bad.accounts[0]!.identifierLine = 6; bad.accounts[0]!.closingBalance!.amount = "999";
    const out = validateDocumentInterpretation(result(bad));
    expect(out.documentInstitution).toBeUndefined();
    expect(out.statement.accounts[0]!.identifier).toBeUndefined();
    expect(out.statement.accounts[0]!.closingBalance).toBeUndefined();
    expect(out.statement.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts unsigned amounts only under the correct positioned debit/credit column", () => {
    const p = proposal(); p.accounts[0]!.transactions[0]!.directionLine = 5;
    const source = structuredClone(lines);
    source[4]!.text = "02/09/2026 Debit Credit";
    source[4]!.items = [{ x: 300, width: 30, text: "Debit" }, { x: 400, width: 30, text: "Credit" }];
    source[6]!.items = [{ x: 300, width: 30, text: "10,00" }];
    expect(validateDocumentInterpretation(result(p, source)).statement.accounts[0]!.transactions).toHaveLength(1);
    source[6]!.items[0]!.x = 400;
    expect(validateDocumentInterpretation(result(p, source)).statement.accounts[0]!.transactions).toHaveLength(0);
  });

  it("keeps deterministic results on failure and flags incomplete interpretation", async () => {
    const bytes = buildPdf([["Banco Fictício BRL", "Período 01/09/2026 a 30/09/2026", "02/09/2026 LOJA FICTICIA -10,00"]]);
    const st = await parseDocument({ bytes, filename: "unknown.pdf" }, { documentAssist: async () => { throw new Error("offline"); } });
    expect(st.accounts[0]!.transactions).toHaveLength(1);
    expect(st.accounts[0]!.transactions[0]!.extraction).toBe("heuristic");
    expect(st.warnings.some(w => w.code === "ai_rejected_row")).toBe(true);
  });

  it("reports skipped document sections for review", () => {
    const r = result(); r.skippedLines = [42];
    expect(validateDocumentInterpretation(r).statement.warnings).toContainEqual(expect.objectContaining({ code: "row_unreadable", row: 42 }));
  });

  it("does not use the statement period as a movement date or a daily total as a movement amount", () => {
    const p = proposal(); const tx = p.accounts[0]!.transactions[0]!;
    tx.date = "2026-09-01"; tx.dateLine = 3;
    expect(validateDocumentInterpretation(result(p)).statement.accounts[0]!.transactions).toHaveLength(0);
    tx.date = "2026-09-02"; tx.dateLine = 5; tx.amountLine = 5;
    const source = structuredClone(lines); source[4]!.text = "02 SET 2026 Total de saídas - 10,00";
    expect(validateDocumentInterpretation(result(p, source)).statement.accounts[0]!.transactions).toHaveLength(0);
  });

  it("does not borrow a nearby balance label to accept a movement as a balance", () => {
    const p = proposal(); p.accounts[0]!.openingBalance!.amount = "10"; p.accounts[0]!.openingBalance!.amountLine = 6;
    const source = structuredClone(lines); source[5]!.text = "Pagamento LOJA FICTICIA 10,00";
    expect(validateDocumentInterpretation(result(p, source)).statement.accounts[0]!.openingBalance).toBeUndefined();
  });

  it("preserves legitimate identical payments on separate source lines", () => {
    const source = structuredClone(lines); source.push({ line: 9, page: 1, text: "Pagamento LOJA FICTICIA 10,00", items: [] });
    const p = proposal(); p.accounts[0]!.transactions.push({ ...p.accounts[0]!.transactions[0]!, line: 9, amountLine: 9, descriptionLines: [9] });
    expect(validateDocumentInterpretation(result(p, source)).statement.accounts[0]!.transactions).toHaveLength(2);
  });

  it("splits a generic bucket into identified accounts without duplicating its deterministic rows", () => {
    const interpreted = validateDocumentInterpretation(result());
    const first = interpreted.statement.accounts[0]!;
    const second = { ...first, identifier: "bank:bancoficticioaurora:999", key: "second", transactions: [{ ...first.transactions[0]!, sourceRow: 20, raw: { evidence_lines: "20" } }] };
    interpreted.statement.accounts.push(second);
    const original = { statement: { ...interpreted.statement, profile: "pdf-lines", accounts: [{ ...first, identifier: undefined, transactions: [first.transactions[0]!, second.transactions[0]!] }] } };
    const merged = mergeDocumentInterpretation(original, interpreted);
    expect(merged.statement.accounts).toHaveLength(2);
    expect(merged.statement.accounts.map(a => a.transactions.length)).toEqual([1, 1]);
  });

  it("flags a balance mismatch before a fully interpreted document is persisted", async () => {
    const source = structuredClone(lines); source[7]!.text = "Saldo final 80,00";
    const p = proposal(); p.accounts[0]!.closingBalance!.amount = "80";
    const st = await parseDocument({ bytes: buildPdf([source.map(l => l.text)]), filename: "unknown.pdf" }, { documentAssist: async () => result(p, source) });
    expect(st.warnings.some(w => w.code === "balance_mismatch")).toBe(true);
  });

  it("never overwrites a deterministic transaction with conflicting AI output", () => {
    const interpreted = validateDocumentInterpretation(result());
    const original = structuredClone(interpreted); original.documentInstitution = undefined; original.statement.accounts[0]!.transactions[0]!.amount = "-20";
    const merged = mergeDocumentInterpretation(original, interpreted);
    expect(merged.statement.accounts[0]!.transactions).toHaveLength(1);
    expect(merged.statement.accounts[0]!.transactions[0]!.amount).toBe("-20");
    expect(merged.statement.warnings.some(w => w.code === "ai_rejected_row")).toBe(true);
  });
});

it("reads calendar-month periods, inherited movement dates and a distant reference dash", () => {
  const source: DocumentLine[] = [
    "Banco Ficticio", "Agencia Conta Corrente", "0001 12345-6", "setembro/2026",
    "Movimento (R$) Saldo (R$)", "SALDO EM 31/08 100,00",
    "21/09 PAGAMENTO CARTAO 10,00-", "REMUNERACAO APLICACAO AUTOMATICA - 0,02 90,02",
    "28/09 PIX RECEBIDO Pessoa Ficticia - 20,00 110,02", "SALDO EM 30/09 110,02",
  ].map((text, i) => ({ line: i + 1, page: 1, text, items: [] }));
  source[7]!.items = [{ x: 50, width: 200, text: "REMUNERACAO APLICACAO AUTOMATICA" }, { x: 320, width: 3, text: "-" }, { x: 440, width: 20, text: "0,02" }, { x: 520, width: 30, text: "90,02" }];
  source[8]!.items = [{ x: 50, width: 200, text: "28/09 PIX RECEBIDO Pessoa Ficticia" }, { x: 320, width: 3, text: "-" }, { x: 440, width: 20, text: "20,00" }, { x: 520, width: 30, text: "110,02" }];
  source[1]!.items = [{ x: 40, width: 30, text: "Agencia" }, { x: 130, width: 80, text: "Conta Corrente" }];
  source[2]!.items = [{ x: 40, width: 20, text: "0001" }, { x: 130, width: 40, text: "12345-6" }];
  const p: DocumentProposal = {
    institution: { name: "Banco Ficticio", line: 1 }, period: { start: "2026-09-01", startLine: 4, end: "2026-09-30", endLine: 4 },
    accounts: [{ key: "12345-6", type: "checking", currency: "BRL", currencyLine: 5, identifier: "0001 12345-6", identifierLine: 3,
      openingBalance: { amount: "100", amountLine: 6, asOf: "2026-08-31", dateLine: 6 },
      closingBalance: { amount: "110.02", amountLine: 9, asOf: "2026-09-30", dateLine: 10 },
      transactions: [
        { line: 7, date: "2026-09-21", dateLine: 7, description: "PAGAMENTO CARTAO", descriptionLines: [7], amount: "-10", amountLine: 7, directionLine: 7 },
        { line: 8, date: "2026-09-21", dateLine: 8, description: "REMUNERACAO APLICACAO AUTOMATICA", descriptionLines: [8], amount: "0.02", amountLine: 8, directionLine: 8 },
        { line: 9, date: "2026-09-28", dateLine: 9, description: "PIX RECEBIDO Pessoa Ficticia", descriptionLines: [9], amount: "20", amountLine: 9, directionLine: 9 },
      ],
    }], unparsedLines: [],
  };
  const out = validateDocumentInterpretation(result(p, source));
  expect(out.statedPeriod).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  expect(out.statement.accounts[0]!.transactions.map(t => t.amount)).toEqual(["-10", "0.02", "20"]);
  expect(out.statement.accounts[0]!.identifier).toBe("bank:bancoficticio:123456");
  expect(out.statement.accounts[0]!.openingBalance?.amount).toBe("100");
  expect(out.statement.accounts[0]!.closingBalance?.amount).toBe("110.02");
  expect(out.statement.warnings).toEqual([]);
  p.accounts[0]!.transactions[2]!.amount = "-20";
  expect(validateDocumentInterpretation(result(p, source)).statement.accounts[0]!.transactions).toHaveLength(2);
});

it("reads the movement column instead of an AI-proposed running balance", () => {
  const source: DocumentLine[] = [
    { line: 1, page: 1, text: "Banco Fictício Aurora", items: [] },
    { line: 2, page: 1, text: "Conta: 12345-6", items: [] },
    { line: 3, page: 1, text: "Período: 01/09/2026 a 30/09/2026 BRL", items: [] },
    { line: 4, page: 1, text: "Data Descrição Movimento (R$) Saldo (R$)", items: [{ x: 400, width: 40, text: "Movimento" }, { x: 500, width: 30, text: "Saldo" }] },
    { line: 5, page: 1, text: "21/09/2026 Remuneração fictícia 0,02 32,02", items: [{ x: 40, width: 60, text: "21/09/2026" }, { x: 120, width: 150, text: "Remuneração fictícia" }, { x: 425, width: 20, text: "0,02" }, { x: 515, width: 25, text: "32,02" }] },
  ];
  const p = proposal();
  p.accounts[0]!.openingBalance = null; p.accounts[0]!.closingBalance = null;
  p.accounts[0]!.transactions = [{ line: 5, date: "2026-09-21", dateLine: 5, description: "Remuneração fictícia", descriptionLines: [5], amount: "32.02", amountLine: 5, directionLine: 5 }];
  const out = validateDocumentInterpretation(result(p, source));
  expect(out.statement.accounts[0]!.transactions[0]).toMatchObject({ amount: "0.02", raw: { model_amount_proposal: "32.02", amount_correction: "source_movement_column" } });
  // A missing movement cannot be replaced by the balance cell.
  source[4]!.items = source[4]!.items.filter(i => i.x !== 425);
  expect(validateDocumentInterpretation(result(p, source)).statement.accounts[0]!.transactions).toEqual([]);
});
