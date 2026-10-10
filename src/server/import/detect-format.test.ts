import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPdf } from "../../../tests/helpers/pdf-writer";
import { buildXlsx } from "../../../tests/helpers/xlsx-builder";
import { detectFormat } from "./detect-format";

const FIXTURES = path.resolve(import.meta.dirname, "../../../tests/fixtures/statements");
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));
const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("detectFormat", () => {
  it("detects PDFs by magic bytes, whatever the extension", () => {
    const pdf = buildPdf([["Synthetic statement"]]);
    expect(detectFormat(pdf, "statement.pdf")).toBe("pdf");
    expect(detectFormat(pdf, "statement.csv")).toBe("pdf");
  });

  it("detects XLSX archives and rejects other ZIP files", async () => {
    const xlsx = await buildXlsx([{ name: "Sheet1", rows: [["Data", "Importo"]] }]);
    expect(detectFormat(xlsx, "export.xlsx")).toBe("xlsx");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...text("not-a-workbook/content.txt")]);
    expect(detectFormat(zip, "export.xlsx")).toBeNull();
  });

  it("detects OFX 1.x (SGML) and 2.x (XML)", () => {
    expect(detectFormat(fixture("santander-br-checking.ofx"), "x.ofx")).toBe("ofx");
    expect(detectFormat(fixture("nubank-card.ofx"), "x.txt")).toBe("ofx");
    expect(detectFormat(text("<OFX>\n<SIGNONMSGSRSV1>"), "bank.qfx")).toBe("ofx");
  });

  it("detects CSV by sniffing delimiters (comma, semicolon, tab, pipe), including Latin-1 files", () => {
    expect(detectFormat(fixture("nubank-account.csv"), "a.csv")).toBe("csv");
    expect(detectFormat(fixture("mps.csv"), "movimenti")).toBe("csv");
    expect(detectFormat(fixture("santander-br.csv"), "extrato.txt")).toBe("csv");
    expect(detectFormat(fixture("generic-unknown-bank.csv"), "unknown")).toBe("csv");
    expect(detectFormat(text("Date\tAmount\n2026-01-01\t1.00\n"), "x")).toBe("csv");
    expect(detectFormat(text("Date|Amount\n2026-01-01|1.00\n"), "x")).toBe("csv");
  });

  it("falls back to the extension only for plain text", () => {
    expect(detectFormat(text("just one column\nof text\n"), "export.csv")).toBe("csv");
    expect(detectFormat(text("just one column\nof text\n"), "notes.md")).toBeNull();
  });

  it("rejects images, executables, archives and legacy binaries", () => {
    expect(detectFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0), "statement.csv")).toBeNull();
    expect(detectFormat(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10), "statement.pdf")).toBeNull();
    expect(detectFormat(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0), "statement.csv")).toBeNull();
    expect(detectFormat(new Uint8Array([0x4d, 0x5a, 0x90, 0, ...text("This program cannot be run in DOS mode")]), "a.csv")).toBeNull();
    expect(detectFormat(bytes(0x1f, 0x8b, 8, 0), "statement.csv")).toBeNull();
    expect(detectFormat(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), "old.xls")).toBeNull();
    expect(detectFormat(text("#!/bin/sh\nrm -rf /\n"), "statement.csv")).toBeNull();
  });

  it("rejects binary content that is not a known format", () => {
    const random = new Uint8Array(256).map((_, i) => (i * 37) % 256);
    expect(detectFormat(random, "statement.csv")).toBeNull();
    expect(detectFormat(new Uint8Array(0), "empty.csv")).toBeNull();
  });
});
