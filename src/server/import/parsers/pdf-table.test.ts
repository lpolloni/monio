import { describe, expect, it, vi } from "vitest";
import { buildPdf, type PdfLineSpec } from "../../../../tests/helpers/pdf-writer";
import { parseDocument } from "../parse-document";
import type { PdfDocumentAssist } from "./document-ai";
import type { LayoutMemory, LayoutRecipe } from "./layout-memory";
import { extractPdfLines, parsePdfLines } from "./pdf";
import { learnPdfTable, parsePdfTable, tableHeaderColumns } from "./pdf-table";
import type { ParserOutput } from "./types";

// Fictional statement imitating a "description | date | amount" layout: the
// date is NOT at the start of the line and the currency trails the amount.
const row = (text: string, date: string, amount: string): PdfLineSpec => [{ x: 44, text }, { x: 388, text: date }, { x: 500, text: amount }];
const header: PdfLineSpec = [{ x: 45, text: "Descrizione" }, { x: 422, text: "Data" }, { x: 509, text: "Importo" }];
const footer = (page: number): PdfLineSpec[] => [
  [{ x: 43, text: "Cliente Fittizio" }, { x: 486, text: "Emesso in data" }],
  [{ x: 43, text: "IBAN: DE89370400440532013000 - BIC: FITTDEFFXXX" }, { x: 500, text: "N. 09/2026" }],
  [{ x: 534, text: `${page} / 4` }],
];
const title = ["Banca Fittizia Aurora - Estratto conto corrente N. 09/2026", "01.09.2026 fino al 30.09.2026"];
const pages: PdfLineSpec[][] = [
  [
    ...title, header,
    row("Da Risparmi", "03.09.2026", "+300,00€"),
    "Valuta 03.09.2026",
    row("PEDAGGIO FITTIZIO -", "05.09.2026", "-5,60€"),
    "Carta - Auto",
    "Valuta 04.09.2026",
    ...footer(1),
  ],
  [
    ...title, header,
    row("AZIENDA FITTIZIA SRL", "15.09.2026", "+2.592,00€"),
    "Entrate",
    "IBAN: IT60X0542811101000000123456 - BIC: FITTITMMXXX",
    "Valuta 15.09.2026",
    row("Cliente Fittizio", "20.09.2026", "-500,00€"),
    "Bonifici in uscita",
    ...footer(2),
  ],
  [
    "Panoramica N. 09/2026", "01.09.2026 fino al 30.09.2026", "Descrizione",
    [{ x: 44, text: "Saldo precedente" }, { x: 508, text: "+52,65€" }],
    [{ x: 44, text: "Operazioni in uscita" }, { x: 498, text: "-505,60€" }],
    [{ x: 44, text: "Operazioni in entrata" }, { x: 490, text: "+2.892,00€" }],
    [{ x: 45, text: "Il tuo nuovo saldo" }, { x: 499, text: "+2.439,05€" }],
    ...footer(3),
  ],
  [
    "Movimenti dello Spazio N. 09/2026", "Spazio: Risparmi", "01.09.2026 fino al 30.09.2026", header,
    row("A Conto principale", "03.09.2026", "-300,00€"),
    "Valuta 03.09.2026",
    "Saldo precedente +300,00€",
    "Il tuo nuovo saldo 0,00€",
    ...footer(4),
  ],
];

describe("PDF positioned-table reader", () => {
  it("recognizes a header row whatever the order of its columns", async () => {
    const [line] = await extractPdfLines(buildPdf([[header]]));
    expect(tableHeaderColumns(line!)!.map((c) => c.role)).toEqual(["description", "date", "amount"]);
    const [dated] = await extractPdfLines(buildPdf([[row("Descrizione", "03.09.2026", "+300,00€")]]));
    expect(tableHeaderColumns(dated!)).toBeUndefined();
  });

  it("reads movements, wrapped details, value dates, sub-accounts and printed balances", async () => {
    const st = await parseDocument({ bytes: buildPdf(pages), filename: "september.pdf" });
    expect(st.profile).toBe("pdf-table");
    expect(st.warnings).toEqual([]);
    expect(st.period).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    const [main, space] = st.accounts;
    expect(main).toMatchObject({
      key: "default", type: "checking", currency: "EUR", identifier: "DE89370400440532013000", identifierMask: "3000",
      openingBalance: { amount: "52.65", asOf: "2026-09-01" }, closingBalance: { amount: "2439.05", asOf: "2026-09-30" },
    });
    expect(main!.transactions.map((t) => [t.bookedOn, t.valueOn, t.amount, t.description])).toEqual([
      ["2026-09-03", "2026-09-03", "300", "Da Risparmi"],
      ["2026-09-05", "2026-09-04", "-5.6", "PEDAGGIO FITTIZIO - Carta - Auto"],
      ["2026-09-15", "2026-09-15", "2592", "AZIENDA FITTIZIA SRL Entrate IBAN: IT60X0542811101000000123456 - BIC: FITTITMMXXX"],
      // The page footer under the last movement of a page is not part of its description.
      ["2026-09-20", undefined, "-500", "Cliente Fittizio Bonifici in uscita"],
    ]);
    expect(space).toMatchObject({
      key: "section:risparmi", name: "Risparmi", type: "savings", identifier: "DE89370400440532013000:risparmi",
      openingBalance: { amount: "300" }, closingBalance: { amount: "0" },
    });
    expect(space!.transactions.map((t) => [t.bookedOn, t.amount])).toEqual([["2026-09-03", "-300"]]);
  });

  it("needs no model once every account closes on its printed balance", async () => {
    const documentAssist = vi.fn<PdfDocumentAssist>(async () => ({ batches: [], skippedLines: [] }));
    const st = await parseDocument({ bytes: buildPdf(pages), filename: "september.pdf" }, { documentAssist });
    expect(documentAssist).not.toHaveBeenCalled();
    expect(st.accounts.flatMap((a) => a.transactions)).toHaveLength(5);
  });

  it("flags a table line with an amount but no date instead of dropping it silently", async () => {
    const lines = await extractPdfLines(buildPdf([[...title, header, row("PAGAMENTO FITTIZIO", "05.09.2026", "-5,60€"), [{ x: 44, text: "COMMISSIONE FITTIZIA" }, { x: 500, text: "-1,00€" }]]]));
    expect(parsePdfTable(lines)!.statement.warnings).toEqual([expect.objectContaining({ code: "row_unreadable", row: 5 })]);
  });

  it("refuses unsigned amounts in a single column: the direction is not stated", async () => {
    const lines = await extractPdfLines(buildPdf([[...title, header, row("PAGAMENTO FITTIZIO", "05.09.2026", "5,60€"), row("ACCREDITO FITTIZIO", "06.09.2026", "9,00€")]]));
    expect(parsePdfTable(lines)).toBeUndefined();
  });

  it("uses debit/credit columns for the direction and verifies the running balance", async () => {
    const head: PdfLineSpec = [{ x: 40, text: "Details" }, { x: 250, text: "Date" }, { x: 330, text: "Paid out" }, { x: 410, text: "Paid in" }, { x: 500, text: "Balance" }];
    const line = (text: string, date: string, out: string, into: string, balance: string): PdfLineSpec =>
      [{ x: 40, text }, { x: 250, text: date }, ...(out ? [{ x: 330, text: out }] : []), ...(into ? [{ x: 410, text: into }] : []), { x: 500, text: balance }];
    const table = [
      "Fictional Bank plc - Current account statement GBP", "01/03/2026 to 31/03/2026", head,
      line("CARD PAYMENT FICTIONAL SHOP", "02/03/2026", "12.50", "", "987.50"),
      line("SALARY FICTIONAL LTD", "05/03/2026", "", "2,000.00", "2,987.50"),
    ];
    const out = parsePdfTable(await extractPdfLines(buildPdf([table])))!;
    expect(out.statement.warnings).toEqual([]);
    expect(out.statement.accounts[0]).toMatchObject({ openingBalance: { amount: "1000" }, closingBalance: { amount: "2987.5" } });
    expect(out.statement.accounts[0]!.transactions.map((t) => t.amount)).toEqual(["-12.5", "2000"]);

    const broken = parsePdfTable(await extractPdfLines(buildPdf([[...table.slice(0, 4), line("SALARY FICTIONAL LTD", "05/03/2026", "", "2,000.00", "3,000.00")]])))!;
    expect(broken.statement.warnings).toEqual([expect.objectContaining({ code: "balance_mismatch" })]);
  });
});

// Fictional quarterly statement whose header is stacked on two lines (plus a
// line of units) and whose dates/amounts are vertically centred on a wrapped
// description: half of it is printed above the dated line, half below.
const centredRow = (booked: string, value: string, amount: string, balance: string, text?: string): PdfLineSpec =>
  [{ x: 41, text: booked }, { x: 129, text: value }, ...(text ? [{ x: 231, text }] : []), { x: 465, text: amount }, { x: 515, text: balance }];
const cell = (text: string): PdfLineSpec => [{ x: 231, text }];
const centredPages: PdfLineSpec[][] = [
  [
    "Cliente Fittizio", "Estratto conto trimestrale", "", "IBAN: IT60 X054 2811 1010 0000 0123 456", "", "BIC: FITTITMMXXX", "",
    "Periodo di riferimento 01/07/2026 fino a 30/09/2026", "",
    [{ x: 383, text: "Saldo inizio trimestre: 100,00 (EUR)" }], "", "",
    [{ x: 460, text: "Importo" }, { x: 525, text: "Saldo" }],
    [{ x: 42, text: "Data contabile" }, { x: 148, text: "Data valuta" }, { x: 306, text: "Causale" }],
    [{ x: 471, text: "(EUR)" }, { x: 524, text: "(EUR)" }],
    "",
    cell("BONIFICI"), centredRow("02/07", "01/07", "950,00", "1.050,00"), cell("Sent from N26"),
    "",
    cell("ORDINI DI PAGAMENTO EMESSI IN"), "", cell("VALUTA LOCALE"),
    centredRow("03/07", "03/07", "-50,00", "1.000,00"),
    cell("Prat. 0000001-26 del 30/04/2026:"), "", cell("Compravendita"),
    "",
    cell("IMPOSTA DI BOLLO"), "", centredRow("04/07", "04/07", "-8,55", "991,45", "IMPOSTA DI BOLLO CONTO 01-04/30-06"), "", cell("S.MEDIO 1.000,00 EUR"),
  ],
  [
    [{ x: 460, text: "Importo" }, { x: 525, text: "Saldo" }],
    [{ x: 42, text: "Data contabile" }, { x: 148, text: "Data valuta" }, { x: 306, text: "Causale" }],
    [{ x: 471, text: "(EUR)" }, { x: 524, text: "(EUR)" }],
    "",
    cell("TRASFERIMENTO"), centredRow("30/09", "30/09", "-91,45", "900,00"), cell("CLIENTE FITTIZIO"),
    "", "",
    [{ x: 383, text: "Saldo fine trimestre: 900,00 (EUR)" }],
  ],
  ["Ti ringraziamo per la collaborazione.", "Banca Fittizia Aurora S.p.A. - Sede legale: Via Inventata 1, Milano"],
];
// Half the usual line pitch, so that a dated line can sit between two description lines.
const centredPdf = (pages = centredPages) => buildPdf(pages, { lineHeight: 7.5 });

describe("rows vertically centred on a wrapped description", () => {
  it("reads a header stacked on two lines and joins the text above and below each dated line", async () => {
    const st = await parseDocument({ bytes: centredPdf(), filename: "estratto.pdf" });
    expect(st.profile).toBe("pdf-table");
    expect(st.warnings).toEqual([]);
    expect(st.period).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    const account = st.accounts[0]!;
    expect(account).toMatchObject({
      currency: "EUR", identifier: "IT60X0542811101000000123456",
      openingBalance: { amount: "100", asOf: "2026-07-01" }, closingBalance: { amount: "900", asOf: "2026-09-30" },
    });
    expect(account.transactions.map((t) => [t.bookedOn, t.valueOn, t.amount, t.description])).toEqual([
      ["2026-07-02", "2026-07-01", "950", "BONIFICI Sent from N26"],
      ["2026-07-03", undefined, "-50", "ORDINI DI PAGAMENTO EMESSI IN VALUTA LOCALE Prat. 0000001-26 del 30/04/2026: Compravendita"],
      ["2026-07-04", undefined, "-8.55", "IMPOSTA DI BOLLO IMPOSTA DI BOLLO CONTO 01-04/30-06 S.MEDIO 1.000,00 EUR"],
      ["2026-09-30", undefined, "-91.45", "TRASFERIMENTO CLIENTE FITTIZIO"],
    ]);
  });

  it("never takes a bank named in a movement for the issuer of the statement", async () => {
    const st = await parseDocument({ bytes: centredPdf(), filename: "estratto.pdf" });
    expect(st.institution).toBeUndefined();
  });

  it("lets the statement's own BIC name the issuer", async () => {
    const pages = centredPages.map((page) => page.map((line) => (line === "BIC: FITTITMMXXX" ? "BIC: BBVAITMMXXX" : line)));
    const st = await parseDocument({ bytes: centredPdf(pages), filename: "estratto.pdf" });
    expect(st.institution).toMatchObject({ slug: "bbva-it", confidence: 0.9 });
  });

  it("keeps reading the lines under a row as its details when the table is not centred", async () => {
    const lines = await extractPdfLines(buildPdf(pages));
    const st = parsePdfTable(lines)!.statement;
    expect(st.accounts[0]!.transactions[1]!.description).toBe("PEDAGGIO FITTIZIO - Carta - Auto");
  });

  it("flags rows without a description instead of guessing when the lines do not mirror", async () => {
    const broken = centredPages.map((page) => page.filter((line) => !(Array.isArray(line) && line[0]!.text === "Sent from N26")));
    const lines = await extractPdfLines(centredPdf(broken));
    expect(parsePdfTable(lines)!.statement.warnings.some((w) => w.code === "row_unreadable")).toBe(true);
  });
});

describe("learning the table of an unknown PDF layout", () => {
  // No keyword of this header row is known to any reader.
  const head: PdfLineSpec = [{ x: 40, text: "Cosa" }, { x: 300, text: "Quando" }, { x: 430, text: "Quanto" }];
  const line = (date: string, text: string, amount: string): PdfLineSpec => [{ x: 40, text }, { x: 300, text: date }, { x: 430, text: amount }];
  const statement = (rows: PdfLineSpec[], opening: string, closing: string) => buildPdf([[
    "Cassa Fittizia Boreale", "01/09/2026 - 30/09/2026 EUR", `Saldo iniziale ${opening}`, head, ...rows, `Saldo finale ${closing}`,
  ]]);
  const september = statement([line("02/09/2026", "NEGOZIO FITTIZIO", "-10,00"), line("09/09/2026", "STIPENDIO FITTIZIO", "+500,00"), line("12/09/2026", "AFFITTO FITTIZIO", "-90,00")], "100,00", "500,00");

  /** A source-verified model interpretation, as produced by validateDocumentInterpretation. */
  const interpretation = (rows: [line: number, date: string, amount: string][]): ParserOutput => ({
    statement: { format: "pdf", profile: "ai-pdf-document", warnings: [], accounts: [{ key: "a", currency: "EUR", transactions: rows.map(([n, bookedOn, amount]) => ({
      bookedOn, amount, description: "x", currency: "EUR", sourceRow: n, extraction: "ai" as const, raw: { evidence_lines: [n, n, n, n, n].join(",") },
    })) }] },
  });

  function memory(): LayoutMemory & { saved: Map<string, LayoutRecipe> } {
    const saved = new Map<string, LayoutRecipe>();
    return {
      saved,
      async load(kind) { return new Map([...saved].filter(([, r]) => r.kind === kind)) as never; },
      async save(signature, recipe) { saved.set(signature, recipe); },
      async forget(signature) { saved.delete(signature); },
    };
  }

  it("is not readable before it is learned", async () => {
    const lines = await extractPdfLines(september);
    expect(parsePdfTable(lines)).toBeUndefined();
    expect((await parsePdfLines(lines)).statement.accounts[0]!.transactions).toHaveLength(0);
  });

  it("derives the columns from verified movements and replays them, including one the model missed", async () => {
    const lines = await extractPdfLines(september);
    // The model returned two of the three movements; the balances prove the third.
    const learnt = learnPdfTable(lines, interpretation([[5, "2026-09-02", "-10"], [6, "2026-09-09", "500"]]))!;
    expect(learnt.recipe.columns.map((c) => c.role)).toEqual(["date", "amount"]);
    expect(learnt.output.statement.profile).toBe("pdf-table-learned");
    expect(learnt.output.statement.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount, t.description])).toEqual([
      ["2026-09-02", "-10", "NEGOZIO FITTIZIO"], ["2026-09-09", "500", "STIPENDIO FITTIZIO"], ["2026-09-12", "-90", "AFFITTO FITTIZIO"],
    ]);
  });

  it("does not learn from an interpretation the source does not replay", async () => {
    const lines = await extractPdfLines(september);
    expect(learnPdfTable(lines, interpretation([[5, "2026-09-02", "-10"], [6, "2026-09-10", "500"]]))).toBeUndefined();
    expect(learnPdfTable(lines, interpretation([[5, "2026-09-02", "-10"], [6, "2026-09-09", "501"]]))).toBeUndefined();
    // Extra movements without printed balances to prove them are not accepted.
    const unproven = await extractPdfLines(buildPdf([["Cassa Fittizia Boreale", "01/09/2026 - 30/09/2026 EUR", head,
      line("02/09/2026", "NEGOZIO FITTIZIO", "-10,00"), line("09/09/2026", "STIPENDIO FITTIZIO", "+500,00"), line("12/09/2026", "AFFITTO FITTIZIO", "-90,00")]]));
    expect(learnPdfTable(unproven, interpretation([[4, "2026-09-02", "-10"], [5, "2026-09-09", "500"]]))).toBeUndefined();
  });

  it("asks the model once, then reads the next statement of that layout from memory", async () => {
    const layoutMemory = memory();
    const documentAssist = vi.fn<PdfDocumentAssist>(async (source) => ({ skippedLines: [], batches: [{
      lines: source, primaryLines: source.map((l) => l.line),
      proposal: { institution: { name: "Cassa Fittizia Boreale", line: 1 }, period: { start: "2026-09-01", startLine: 2, end: "2026-09-30", endLine: 2 }, unparsedLines: [],
        accounts: [{ key: "account-1", type: "checking", currency: "EUR", currencyLine: 2, identifier: null, identifierLine: null, openingBalance: null, closingBalance: null,
          transactions: [
            { line: 5, date: "2026-09-02", dateLine: 5, description: "NEGOZIO FITTIZIO", descriptionLines: [5], amount: "-10.00", amountLine: 5, directionLine: 5 },
            { line: 6, date: "2026-09-09", dateLine: 6, description: "STIPENDIO FITTIZIO", descriptionLines: [6], amount: "500.00", amountLine: 6, directionLine: 6 },
          ] }] },
    }] }));
    const first = await parseDocument({ bytes: september, filename: "settembre.pdf" }, { documentAssist, layoutMemory });
    expect(documentAssist).toHaveBeenCalledOnce();
    expect(layoutMemory.saved.size).toBe(1);
    expect([...layoutMemory.saved.values()][0]).toMatchObject({ kind: "pdf-table", issuer: "Cassa Fittizia Boreale" });
    expect(first.institution?.name).toBe("Cassa Fittizia Boreale");
    expect(first.accounts[0]!.transactions).toHaveLength(3);

    const october = statement([line("03/10/2026", "FARMACIA FITTIZIA", "-25,50"), line("09/10/2026", "STIPENDIO FITTIZIO", "+500,00")], "500,00", "974,50")
    const second = await parseDocument({ bytes: october, filename: "ottobre.pdf" }, { documentAssist, layoutMemory });
    expect(documentAssist).toHaveBeenCalledOnce();
    expect(second.profile).toBe("pdf-table-learned");
    // Same issuer as the first import, so the pipeline files it under the same private institution.
    expect(second.institution?.name).toBe("Cassa Fittizia Boreale");
    expect(second.warnings).toEqual([]);
    expect(second.accounts[0]).toMatchObject({ openingBalance: { amount: "500" }, closingBalance: { amount: "974.5" } });
    expect(second.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount])).toEqual([["2026-10-03", "-25.5"], ["2026-10-09", "500"]]);
  });
});
