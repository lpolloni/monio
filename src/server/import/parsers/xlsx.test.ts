import { describe, expect, it } from "vitest";
import { buildXlsx } from "../../../../tests/helpers/xlsx-builder";
import { parseDocument, UnsupportedDocumentError } from "../parse-document";
import { assertZipWithinLimits, readXlsxTables, XlsxRejectedError } from "./xlsx";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("XLSX (BBVA Italia layouts)", () => {
  it("reads date cells, numeric cells, rich text and formulas below a preamble", async () => {
    const bytes = await buildXlsx([
      {
        name: "Movimenti",
        merges: ["A1:E1"],
        rows: [
          ["BBVA Italia - Movimenti conto (dati fittizi)", null, null, null, null],
          ["IBAN", "IT60 X054 2811 1010 0000 0123 456"],
          ["Periodo", "01/03/2026 - 31/03/2026"],
          [],
          ["Data contabile", "Data valuta", "Descrizione", "Importo", "Divisa"],
          [day("2026-03-02"), day("2026-03-02"), "Stipendio Datore Fittizio", 2150, "EUR"],
          [day("2026-03-03"), day("2026-03-03"), "Netflix", -12.99, "EUR"],
          [day("2026-03-05"), day("2026-03-04"), "Bonifico a N26 - giroconto", -500, "EUR"],
          [day("2026-03-06"), day("2026-03-06"), { richText: [{ text: "Spotify " }, { text: "Premium" }] }, { formula: "-10.99", result: -10.99 }, "EUR"],
          [day("2026-03-07"), day("2026-03-07"), "Affitto", -1234.5, "EUR"],
          [day("2026-03-08"), day("2026-03-08"), "Arrotondamento", 0.1 + 0.2, "EUR"],
        ],
      },
    ]);
    const st = await parseDocument({ bytes, filename: "movimenti.xlsx" });
    expect(st.format).toBe("xlsx");
    expect(st.profile).toBe("bbva-it");
    // Weak header signature confirmed by the preamble text.
    expect(st.institution).toMatchObject({ slug: "bbva-it", confidence: 0.85 });
    const account = st.accounts[0]!;
    expect(account).toMatchObject({ identifier: "IT60X0542811101000000123456", identifierMask: "3456", currency: "EUR" });
    expect(account.transactions.map((t) => [t.bookedOn, t.valueOn, t.description, t.amount, t.sourceRow])).toEqual([
      ["2026-03-02", "2026-03-02", "Stipendio Datore Fittizio", "2150", 6],
      ["2026-03-03", "2026-03-03", "Netflix", "-12.99", 7],
      ["2026-03-05", "2026-03-04", "Bonifico a N26 - giroconto", "-500", 8],
      ["2026-03-06", "2026-03-06", "Spotify Premium", "-10.99", 9],
      ["2026-03-07", "2026-03-07", "Affitto", "-1234.5", 10],
      ["2026-03-08", "2026-03-08", "Arrotondamento", "0.3", 11],
    ]);
    expect(st.warnings).toEqual([]);
  });

  it("reads string dates, in/out columns and never re-applies the comma decimal to numeric cells", async () => {
    const bytes = await buildXlsx([
      { name: "Note", rows: [["Questo foglio contiene solo note (dati fittizi)"]] },
      {
        name: "Movimenti",
        rows: [
          ["Data operazione", "Data valuta", "Descrizione", "Entrate", "Uscite"],
          ["02/03/2026", "02/03/2026", "Stipendio", "2.150,00", null],
          ["03/03/2026", "03/03/2026", "Spesa supermercato", null, 45.3],
          ["04/03/2026", "04/03/2026", "Rimborso", 1.5, null],
          ["05/03/2026", "05/03/2026", "Bonifico affitto", null, "1.234,56"],
        ],
      },
    ]);
    const st = await parseDocument({ bytes, filename: "export.xlsx" });
    expect(st.profile).toBe("bbva-it");
    expect(st.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount])).toEqual([
      ["2026-03-02", "2150"],
      ["2026-03-03", "-45.3"],
      ["2026-03-04", "1.5"],
      ["2026-03-05", "-1234.56"],
    ]);
  });

  it("reads unknown spreadsheets with the generic profile", async () => {
    const bytes = await buildXlsx([
      {
        name: "Export",
        rows: [
          ["Booking date", "Description", "Amount", "Currency"],
          [day("2026-03-01"), "Coffee Example", -3.2, "EUR"],
          [day("2026-03-02"), "Salary Example", 2500, "EUR"],
        ],
      },
    ]);
    const st = await parseDocument({ bytes, filename: "unknown.xlsx" });
    expect(st.profile).toBe("generic");
    expect(st.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount, t.currency, t.extraction])).toEqual([
      ["2026-03-01", "-3.2", "EUR", "heuristic"],
      ["2026-03-02", "2500", "EUR", "heuristic"],
    ]);
  });

  it("marks numeric cells so profiles can read them exactly", async () => {
    const bytes = await buildXlsx([{ name: "S", rows: [["a", "b"], [1234.5, "1234,5"]] }]);
    const [table] = await readXlsxTables(bytes);
    expect(table!.rows[1]).toEqual(["1234.5", "1234,5"]);
    expect(table!.numericCell?.(1, 0)).toBe(true);
    expect(table!.numericCell?.(1, 1)).toBe(false);
  });

  it("guards against archives that expand beyond the limit", async () => {
    const bytes = await buildXlsx([{ name: "S", rows: [["a", "b"]] }]);
    expect(() => assertZipWithinLimits(bytes)).not.toThrow();
    expect(() => assertZipWithinLimits(bytes, 100)).toThrow(XlsxRejectedError);
  });

  it("reports corrupted workbooks as unsupported", async () => {
    const bytes = await buildXlsx([{ name: "S", rows: [["a", "b"]] }]);
    const corrupted = bytes.slice();
    corrupted.fill(0, 40, Math.min(corrupted.length - 200, 400));
    await expect(parseDocument({ bytes: corrupted, filename: "x.xlsx" })).rejects.toBeInstanceOf(UnsupportedDocumentError);
  });
});
