import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DocumentLimitError,
  EmptyDocumentError,
  MAX_TRANSACTIONS,
  parseDocument,
  UnsupportedDocumentError,
} from "./parse-document";

const FIXTURES = path.resolve(import.meta.dirname, "../../../tests/fixtures/statements");
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));
const encode = (value: string) => new TextEncoder().encode(value);
const parseText = (csv: string, filename = "export.csv", ctx = {}) => parseDocument({ bytes: encode(csv), filename }, ctx);

describe("parseDocument errors and limits", () => {
  it("throws EmptyDocumentError for empty or blank files", async () => {
    await expect(parseDocument({ bytes: new Uint8Array(0), filename: "a.csv" })).rejects.toBeInstanceOf(EmptyDocumentError);
    await expect(parseText(" \r\n\t\n")).rejects.toBeInstanceOf(EmptyDocumentError);
    await expect(parseDocument({ bytes: new Uint8Array([0xef, 0xbb, 0xbf]), filename: "a.csv" })).rejects.toBeInstanceOf(EmptyDocumentError);
  });

  it("throws UnsupportedDocumentError for images, executables and unknown binaries", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    for (const bytes of [png, exe, elf]) {
      await expect(parseDocument({ bytes, filename: "statement.csv" })).rejects.toBeInstanceOf(UnsupportedDocumentError);
    }
  });

  it("enforces the transaction limit", async () => {
    const header = "Data,Valor,Identificador,Descrição";
    const row = (i: number) => `01/03/2026,-1.00,id-${i},Compra ${i}`;
    const big = [header, ...Array.from({ length: MAX_TRANSACTIONS + 1 }, (_, i) => row(i))].join("\n");
    await expect(parseText(big)).rejects.toBeInstanceOf(DocumentLimitError);

    const small = [header, row(1), row(2), row(3)].join("\n");
    await expect(parseText(small, "x.csv", { maxTransactions: 2 })).rejects.toBeInstanceOf(DocumentLimitError);
    const ok = await parseText(small, "x.csv", { maxTransactions: 3 });
    expect(ok.accounts[0]!.transactions).toHaveLength(3);
  });

  it("returns an empty_document warning for a header-only export", async () => {
    const st = await parseText("Data,Valor,Identificador,Descrição\n");
    expect(st.accounts.flatMap((a) => a.transactions)).toEqual([]);
    expect(st.warnings.map((w) => w.code)).toEqual(["empty_document"]);
  });
});

describe("parseDocument post-processing", () => {
  it("warns when opening balance + transactions != closing balance, without altering data", async () => {
    const csv = [
      "Data;Descrição;Valor;Saldo",
      "01/03/2026;SALDO ANTERIOR;;1.000,00",
      "02/03/2026;COMPRA EXEMPLO;-100,00;900,00",
      "05/03/2026;TARIFA;-10,00;850,00",
    ].join("\n");
    const st = await parseText(csv, "xp.csv");
    expect(st.accounts[0]!.transactions.map((t) => t.amount)).toEqual(["-100", "-10"]);
    expect(st.accounts[0]!.closingBalance).toEqual({ amount: "850", asOf: "2026-03-05" });
    const mismatch = st.warnings.find((w) => w.code === "balance_mismatch");
    expect(mismatch?.message).toContain("difference -40");
  });

  it("sorts transactions chronologically, keeping the intra-day order of descending exports", async () => {
    const csv = [
      "Date,Description,Amount,Currency",
      "2026-03-05,Third,-3.00,EUR",
      "2026-03-04,Second B,-2.00,EUR",
      "2026-03-04,Second A,-2.00,EUR",
      "2026-03-01,First,-1.00,EUR",
    ].join("\n");
    const st = await parseText(csv);
    expect(st.accounts[0]!.transactions.map((t) => t.description)).toEqual(["First", "Second A", "Second B", "Third"]);
    expect(st.period).toEqual({ start: "2026-03-01", end: "2026-03-05" });
  });

  it("normalizes descriptions and strips control/bidi characters", async () => {
    const csv = 'Date,Description,Amount,Currency\n2026-03-01,"  Café \t‮exe.pdf‬   Exemplo\u0007 ",-1.00,EUR\n';
    const st = await parseText(csv);
    expect(st.accounts[0]!.transactions[0]!.description).toBe("Café exe.pdf Exemplo");
  });

  it("treats instruction-like text as data", async () => {
    const st = await parseDocument({ bytes: fixture("generic-unknown-bank.csv"), filename: "extrato.csv" });
    const tx = st.accounts[0]!.transactions.find((t) => t.description.includes("IGNORE ALL PREVIOUS INSTRUCTIONS"))!;
    expect(tx.amount).toBe("-1");
    expect(st.accounts[0]!.transactions).toHaveLength(4);
  });

  it("handles very long lines quickly and caps descriptions", async () => {
    const huge = "A".repeat(200_000);
    const csv = `Date,Description,Amount,Currency\n2026-03-01,${huge},-1.00,EUR\n2026-03-02,${"1,".repeat(50_000)}x,-1.00,EUR\n`;
    const started = Date.now();
    const st = await parseText(csv);
    expect(Date.now() - started).toBeLessThan(3000);
    const first = st.accounts[0]!.transactions[0]!;
    expect(first.description.length).toBeLessThanOrEqual(500);
  });

  it("uses the file name only as a low-confidence institution hint", async () => {
    const csv = "Date,Description,Amount,Currency\n2026-03-01,Coffee Example,-1.00,EUR\n";
    const st = await parseText(csv, "revolut-export-2026.csv");
    expect(st.institution).toMatchObject({ slug: "revolut" });
    expect(st.institution!.confidence).toBeLessThanOrEqual(0.3);
  });

  it("detects the institution from preamble text for unknown layouts", async () => {
    const csv = "Banco Inter - extrato (dados fictícios)\nData;Descrição;Valor;Moeda\n02/03/2026;Padaria Exemplo;-5,00;BRL\n";
    const st = await parseText(csv);
    expect(st.profile).toBe("generic");
    expect(st.institution).toMatchObject({ slug: "inter", confidence: 0.8 });
  });

  it("routes every fixture format to its parser", async () => {
    const cases: [string, string][] = [
      ["nubank-account.csv", "csv"],
      ["santander-br-checking.ofx", "ofx"],
      ["nubank-card.ofx", "ofx"],
    ];
    for (const [name, format] of cases) {
      const st = await parseDocument({ bytes: fixture(name), filename: name });
      expect(st.format).toBe(format);
      expect(st.accounts[0]!.transactions.length).toBeGreaterThan(0);
    }
  });
});
