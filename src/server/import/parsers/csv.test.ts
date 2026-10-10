import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readCsvRows } from "./csv";
import { decodeText, detectDelimiter, normalizeDescription, sanitizeCell } from "./text";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../tests/fixtures/statements");
const text = (value: string) => new TextEncoder().encode(value);

describe("decodeText", () => {
  it("decodes strict UTF-8 and strips the BOM", () => {
    const decoded = decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...text("Descrição")]));
    expect(decoded).toEqual({ text: "Descrição", encoding: "utf-8" });
  });

  it("falls back to Windows-1252 when bytes are not valid UTF-8", () => {
    const decoded = decodeText(new Uint8Array(Buffer.from("Histórico;Crédito ç", "latin1")));
    expect(decoded).toEqual({ text: "Histórico;Crédito ç", encoding: "windows-1252" });
    // 0x80 is the euro sign in Windows-1252 (and invalid as a UTF-8 start byte).
    expect(decodeText(new Uint8Array([0x80])).text).toBe("€");
  });

  it("honours UTF-16 byte order marks", () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from("Data;Valor", "utf16le")]);
    expect(decodeText(utf16)).toEqual({ text: "Data;Valor", encoding: "utf-16le" });
  });
});

describe("readCsvRows", () => {
  it("reads a Latin-1 encoded Santander export", () => {
    const { rows, delimiter, encoding } = readCsvRows(new Uint8Array(readFileSync(path.join(FIXTURES, "santander-br.csv"))));
    expect(encoding).toBe("windows-1252");
    expect(delimiter).toBe(";");
    expect(rows[2]).toEqual(["Data", "Histórico", "Docto.", "Crédito (R$)", "Débito (R$)", "Saldo (R$)"]);
    expect(rows[4]?.[1]).toBe("PIX RECEBIDO JOÃO FICTÍCIO");
  });

  it("handles quoted fields with delimiters, quotes and newlines", () => {
    const csv = 'Date,Description,Amount\r\n2026-03-01,"Coffee, ""large""\nwith milk","-1,234.50"\r\n';
    const { rows } = readCsvRows(text(csv));
    expect(rows).toEqual([
      ["Date", "Description", "Amount"],
      ["2026-03-01", 'Coffee, "large"\nwith milk', "-1,234.50"],
    ]);
  });

  it("detects tab and pipe delimiters", () => {
    expect(readCsvRows(text("a\tb\tc\n1\t2\t3\n")).delimiter).toBe("\t");
    expect(readCsvRows(text("a|b|c\n1|2|3\n")).delimiter).toBe("|");
  });

  it("prefers the consistent delimiter over commas inside amounts", () => {
    expect(detectDelimiter("Data;Valor\n01/03/2026;1.234,56\n02/03/2026;-9,90\n")?.delimiter).toBe(";");
  });

  it("strips control and bidi characters from cells", () => {
    const { rows } = readCsvRows(text("a,b\nx\u0000y,‮gnp.exe\n"));
    expect(rows[1]).toEqual(["xy", "gnp.exe"]);
  });
});

describe("description helpers", () => {
  it("collapses whitespace, keeps case and caps length", () => {
    expect(normalizeDescription("  PAG*Netflix \t\n  Assinatura  ")).toBe("PAG*Netflix Assinatura");
    expect(normalizeDescription("x".repeat(5000)).length).toBe(500);
    expect(sanitizeCell("y".repeat(10_000)).length).toBe(2000);
  });
});
