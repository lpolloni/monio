import { describe, expect, it } from "vitest";
import { buildPdf, type PdfLineSpec } from "../../../../tests/helpers/pdf-writer";
import { parseDocument } from "../parse-document";
import { extractPdfLines } from "./pdf";
import { parsePdfStructure } from "./pdf-structure";

// Every statement here is fictional, and each one is drawn in a different way:
// the reader is told nothing about any of them.
const at = (...cells: [x: number, text: string][]): PdfLineSpec => cells.map(([x, text]) => ({ x, text }));
const read = (pages: PdfLineSpec[][], filename = "statement.pdf") => parseDocument({ bytes: buildPdf(pages), filename });
const rows = (st: Awaited<ReturnType<typeof read>>) => st.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount, t.description]);
const infer = async (pages: PdfLineSpec[][]) => parsePdfStructure(await extractPdfLines(buildPdf(pages)));

describe("structure inference for statement layouts nobody described", () => {
  it("reads unsigned amounts listed newest first: the running balance gives the direction", async () => {
    const st = await read([[
      "Northwind Savings Bank", "Account activity 01/03/2026 to 31/03/2026 (GBP)",
      "Opening balance 1,000.00",
      at([40, "20/03/2026"], [120, "CARD PAYMENT BOOKSHOP"], [400, "25.50"], [480, "1,874.50"]),
      at([40, "12/03/2026"], [120, "SALARY FICTIONAL LTD"], [392, "1,000.00"], [480, "1,900.00"]),
      at([40, "05/03/2026"], [120, "RENT STANDING ORDER"], [395, "100.00"], [487, "900.00"]),
      "Closing balance 1,874.50",
    ]]);
    expect(st.profile).toBe("pdf-inferred");
    expect(st.warnings).toEqual([]);
    expect(rows(st)).toEqual([
      ["2026-03-05", "-100", "RENT STANDING ORDER"],
      ["2026-03-12", "1000", "SALARY FICTIONAL LTD"],
      ["2026-03-20", "-25.5", "CARD PAYMENT BOOKSHOP"],
    ]);
    expect(st.accounts[0]).toMatchObject({ currency: "GBP", openingBalance: { amount: "1000" }, closingBalance: { amount: "1874.5" } });
    expect(st.institution).toMatchObject({ name: "Northwind Savings Bank" });
  });

  it("reads cards printed three across, each with its own date, text, reference and amount", async () => {
    const card = (x: number, date: string, text: string, ref: string, amount: string) => ({ x, date, text, ref, amount });
    const band = (cards: ReturnType<typeof card>[]): PdfLineSpec[] => [
      cards.map((c) => ({ x: c.x, text: c.date })),
      cards.map((c) => ({ x: c.x, text: c.text })),
      cards.map((c) => ({ x: c.x, text: c.ref })),
      cards.map((c) => ({ x: c.x + 60, text: c.amount })),
      "",
    ];
    const st = await read([[
      "Banco Fictício Maré", "Período: 01/04/2026 a 30/04/2026 - BRL",
      at([40, "Saldo anterior"], [200, "Total de entradas"], [360, "Total de saídas"], [500, "Saldo atual"]),
      at([40, "200,00"], [200, "1.500,00"], [360, "330,00"], [500, "1.370,00"]),
      "",
      ...band([card(40, "02/04/2026", "PIX recebido Ana", "Doc. 11-22", "+1.000,00"), card(220, "03/04/2026", "Mercado Fictício", "Doc. 33-44", "-80,00"), card(400, "05/04/2026", "Conta de luz", "Doc. 55-66", "-150,00")]),
      ...band([card(40, "09/04/2026", "Farmácia Fictícia", "Doc. 77-88", "-100,00"), card(220, "15/04/2026", "PIX recebido Beto", "Doc. 99-00", "+500,00")]),
    ]]);
    expect(st.profile).toBe("pdf-inferred");
    expect(st.warnings).toEqual([]);
    expect(rows(st)).toEqual([
      ["2026-04-02", "1000", "PIX recebido Ana"],
      ["2026-04-03", "-80", "Mercado Fictício"],
      ["2026-04-05", "-150", "Conta de luz"],
      ["2026-04-09", "-100", "Farmácia Fictícia"],
      ["2026-04-15", "500", "PIX recebido Beto"],
    ]);
    expect(st.accounts[0]!.transactions[0]!.raw.reference).toBe("Doc. 11-22");
  });

  it("reads day numbers under month headings, with the direction written next to each amount", async () => {
    const st = await read([[
      "Cassa Fittizia del Lago", "Dal 01/05/2026 al 30/06/2026 - EUR",
      "Saldo iniziale: 50,00", "Saldo finale: 1.158,00",
      "Maggio 2026",
      at([60, "03"], [90, "Stipendio Ditta Fittizia"]), at([90, "Entrata"], [300, "1.200,00"]),
      at([60, "18"], [90, "Affitto"]), at([90, "Uscita"], [308, "600,00"]),
      "Giugno 2026",
      at([60, "02"], [90, "Bolletta gas"]), at([90, "Uscita"], [313, "42,00"]),
      at([60, "27"], [90, "Rimborso"]), at([90, "Entrata"], [308, "550,00"]),
    ]]);
    expect(st.profile).toBe("pdf-inferred");
    expect(rows(st)).toEqual([
      ["2026-05-03", "1200", "Stipendio Ditta Fittizia"],
      ["2026-05-18", "-600", "Affitto"],
      ["2026-06-02", "-42", "Bolletta gas"],
      ["2026-06-27", "550", "Rimborso"],
    ]);
  });

  it("reads rows drawn as one fragment each, with D/C markers and day-month dates", async () => {
    const st = await read([[
      "Fictional Harbour Credit Union", "Statement period 01/02/2026 - 28/02/2026 USD",
      "Previous balance 1,000.00",
      "03/02 Coffee Fictional 4.50 D 995.50",
      "11/02 Payroll Fictional Inc 2,000.00 C 2,995.50",
      "19/02 Hardware Store 95.50 D 2,900.00",
      "New balance 2,900.00",
    ]]);
    expect(st.warnings).toEqual([]);
    expect(rows(st)).toEqual([
      ["2026-02-03", "-4.5", "Coffee Fictional"],
      ["2026-02-11", "2000", "Payroll Fictional Inc"],
      ["2026-02-19", "-95.5", "Hardware Store"],
    ]);
  });

  it("tells money out from money in by the printed totals when the columns have no known name", async () => {
    const st = await read([[
      "Banca Fittizia Tramontana", "Movimenti 01/07/2026 - 31/07/2026 EUR",
      at([40, "Giorno"], [110, "Che cosa"], [380, "Via"], [470, "Qui"]),
      at([40, "02.07.2026"], [110, "Spesa alimentare"], [380, "61,20"]),
      at([40, "10.07.2026"], [110, "Bonifico ricevuto"], [470, "900,00"]),
      at([40, "21.07.2026"], [110, "Abbonamento palestra"], [380, "38,80"]),
      at([300, "Totale uscite"], [380, "100,00"]),
      at([300, "Totale entrate"], [470, "900,00"]),
    ]]);
    expect(st.profile).toBe("pdf-inferred");
    expect(rows(st)).toEqual([
      ["2026-07-02", "-61.2", "Spesa alimentare"],
      ["2026-07-10", "900", "Bonifico ricevuto"],
      ["2026-07-21", "-38.8", "Abbonamento palestra"],
    ]);
  });

  it("reads dates whose month is written out, and month-day dates when only that order fits the period", async () => {
    const named = await read([[
      "Banco Fictício Serra Azul", "Extrato de 01/08/2026 a 31/08/2026 (R$)", "Saldo inicial 10,00",
      at([40, "05 ago"], [120, "Padaria Fictícia"], [400, "-7,50"]),
      at([40, "20 ago"], [120, "Salário Fictício"], [385, "+2.000,00"]),
      "Saldo final 2.002,50",
    ]]);
    expect(rows(named)).toEqual([["2026-08-05", "-7.5", "Padaria Fictícia"], ["2026-08-20", "2000", "Salário Fictício"]]);

    const monthFirst = await read([[
      "Fictional Prairie Bank", "Period: 2026-08-01 - 2026-08-31 USD", "Opening balance 10.00",
      at([40, "08-05"], [120, "Bakery"], [400, "-7.50"]),
      at([40, "08-20"], [120, "Payroll"], [385, "+2,000.00"]),
      "Closing balance 2,002.50",
    ]]);
    expect(rows(monthFirst)).toEqual([["2026-08-05", "-7.5", "Bakery"], ["2026-08-20", "2000", "Payroll"]]);
  });

  it("keeps wrapped details with their movement and leaves the closing section out of the last one", async () => {
    const inferred = await infer([[
      "Banco Fictício Pedra Branca", "Período: 01/09/2026 a 30/09/2026 - BRL",
      at([40, "2026-09-04"], [130, "Transferência enviada"], [420, "-300,00"]),
      at([130, "Para: Fulano Fictício"]),
      at([40, "2026-09-11"], [130, "Tarifa"], [420, "-5,00"]),
      at([40, "2026-09-18"], [130, "Depósito"], [420, "+455,00"]),
      at([130, "Agência Centro"]),
      at([60, "RESUMO DO PERÍODO"]),
      at([60, "Saldo inicial"], [200, "100,00"]),
      at([60, "Saldo final"], [200, "250,00"]),
    ]]);
    expect(inferred!.verified).toBe(true);
    expect(inferred!.output.statement.accounts[0]!.transactions.map((t) => [t.bookedOn, t.amount, t.description])).toEqual([
      ["2026-09-04", "-300", "Transferência enviada Para: Fulano Fictício"],
      ["2026-09-11", "-5", "Tarifa"],
      ["2026-09-18", "455", "Depósito Agência Centro"],
    ]);
  });

  it("reads several movements listed under one date heading", async () => {
    const st = await read([[
      "Banco Fictício Vale Verde", "Período: 01/10/2026 a 31/10/2026 - BRL",
      "Saldo inicial 500,00",
      at([40, "05/10/2026"]),
      at([60, "Supermercado Fictício"], [400, "-120,00"]),
      at([60, "Compra no débito"]),
      at([60, "Pix recebido de Ciclano"], [400, "+300,00"]),
      at([40, "19/10/2026"]),
      at([60, "Conta de água"], [400, "-80,00"]),
      "Saldo final 600,00",
    ]]);
    expect(st.profile).toBe("pdf-inferred");
    expect(st.warnings).toEqual([]);
    expect(rows(st)).toEqual([
      ["2026-10-05", "-120", "Supermercado Fictício Compra no débito"],
      ["2026-10-05", "300", "Pix recebido de Ciclano"],
      ["2026-10-19", "-80", "Conta de água"],
    ]);
  });

  it("reads a table that runs over several pages, with its header and footer repeated", async () => {
    const header = at([40, "Buchung"], [110, "Wertstellung"], [190, "Vorgang"], [400, "Betrag"], [480, "Kontostand"]);
    const top = ["Fiktive Sparkasse Nordwind", "Kontoauszug 01.11.2026 - 30.11.2026 EUR"];
    const st = await read([
      [...top, header,
        at([40, "02.11.26"], [110, "02.11.26"], [190, "Lastschrift Stadtwerke"], [400, "45,10-"], [480, "954,90"]),
        at([40, "09.11.26"], [110, "10.11.26"], [190, "Gehalt Fiktiv GmbH"], [392, "2.100,00"], [472, "3.054,90"]),
        "Seite 1 von 2"],
      [...top, header,
        at([40, "23.11.26"], [110, "23.11.26"], [190, "Miete"], [397, "800,00-"], [472, "2.254,90"]),
        "Seite 2 von 2"],
    ]);
    expect(st.warnings).toEqual([]);
    expect(st.accounts[0]!.transactions.map((t) => [t.bookedOn, t.valueOn, t.amount, t.description])).toEqual([
      ["2026-11-02", undefined, "-45.1", "Lastschrift Stadtwerke"],
      ["2026-11-09", "2026-11-10", "2100", "Gehalt Fiktiv GmbH"],
      ["2026-11-23", undefined, "-800", "Miete"],
    ]);
    expect(st.accounts[0]).toMatchObject({ openingBalance: { amount: "1000" }, closingBalance: { amount: "2254.9" } });
  });

  it("reads two tables printed side by side, telling money out from money in by the totals", async () => {
    const st = await read([[
      "Fictional Lakeside Bank", "Activity for March 2026 (USD)",
      "Previous balance", at([450, "$ 1,000.00"]),
      "Deposits", at([450, "$ 2,300.00"]),
      "Withdrawals", at([450, "$ 730.00"]),
      "Ending balance", at([450, "$ 2,570.00"]),
      at([40, "WHAT LEFT"], [310, "WHAT CAME"]),
      at([40, "03-04"], [75, "Rent"], [230, "600.00"], [310, "03-02"], [345, "Payroll"], [500, "2,000.00"]),
      at([40, "03-19"], [75, "Groceries"], [230, "130.00"], [310, "04-01"], [345, "Refund"], [505, "300.00"]),
    ]]);
    expect(st.profile).toBe("pdf-inferred");
    expect(st.warnings).toEqual([]);
    expect(rows(st)).toEqual([
      ["2026-03-02", "2000", "Payroll"],
      ["2026-03-04", "-600", "Rent"],
      ["2026-03-19", "-130", "Groceries"],
      ["2026-04-01", "300", "Refund"],
    ]);
    expect(st.accounts[0]).toMatchObject({ currency: "USD", openingBalance: { amount: "1000" }, closingBalance: { amount: "2570" } });
  });

  it("ignores a side panel, splits fragments on their separators and reads totals written in one sentence", async () => {
    const st = await read([[
      at([40, "ZAFFIRO"], [200, "Saldo di partenza iniziale"], [470, "100,00 EUR"]),
      at([40, "RAPPORTO"]),
      at([200, "02/06 | Spesa mercato"], [320, "•"], [330, "Rif 7781"]),
      at([40, "GIUGNO 2026"]),
      at([200, "Dare"], [480, "-40,00 EUR"]),
      at([200, "15/06 | Stipendio"], [320, "•"], [330, "Ri"]),
      at([200, "Avere"], [470, "+900,00 EUR"]),
      at([40, "CLIENTE"]),
      at([40, "Anna Bruni"]),
      at([200, "Accrediti 900,00 | Addebiti 40,00 | Saldo 960,00 EUR"]),
      "Assistenza: aiuto@zaffiro.example - Via Inventata 3, Torino, Italia",
    ]]);
    expect(st.profile).toBe("pdf-inferred");
    expect(st.warnings).toEqual([]);
    expect(rows(st)).toEqual([["2026-06-02", "-40", "Spesa mercato"], ["2026-06-15", "900", "Stipendio"]]);
    expect(st.accounts[0]!.transactions[0]!.raw.reference).toBe("Rif 7781");
    expect(st.accounts[0]).toMatchObject({ country: "IT", openingBalance: { amount: "100" }, closingBalance: { amount: "960" } });
    expect(st.institution).toMatchObject({ name: "ZAFFIRO" });
  });

  it("reads a currency printed without cents, with the balance after each movement and a total glued to its neighbour", async () => {
    const st = await read([[
      "Cooperativa Ficticia Ñandutí", "Periodo: 01/11/2026 — 30/11/2026",
      at([46, "04/11"], [107, "Cobro de alquiler"]), at([470, "+2.400.000 Gs."]), at([107, "Disponible: 3.400.000 Gs."]),
      at([46, "18/11"], [107, "Pago de luz"]), at([480, "-350.000 Gs."]), at([107, "Disponible: 3.050.000 Gs."]),
      at([40, "SALDO ANTERIOR"], [200, "ABONOS"], [340, "CARGOS"]),
      at([40, "1.000.000 Gs."], [200, "2.400.000 Gs."], [340, "350.000 Gs.CIERRE: 3.050.000 Gs."]),
    ]]);
    expect(st.profile).toBe("pdf-inferred");
    expect(st.warnings).toEqual([]);
    expect(rows(st)).toEqual([["2026-11-04", "2400000", "Cobro de alquiler"], ["2026-11-18", "-350000", "Pago de luz"]]);
    expect(st.accounts[0]).toMatchObject({ currency: "PYG", country: "PY", openingBalance: { amount: "1000000" }, closingBalance: { amount: "3050000" } });
  });
});

describe("structure inference never guesses", () => {
  const unsigned = [
    "Banca Fittizia Senza Segni", "01/07/2026 - 31/07/2026 EUR",
    at([40, "02/07/2026"], [110, "Spesa alimentare"], [380, "61,20"]),
    at([40, "10/07/2026"], [110, "Bonifico ricevuto"], [380, "900,00"]),
  ];

  it("refuses unsigned amounts when nothing in the document says which way they went", async () => {
    expect(await infer([unsigned])).toBeUndefined();
    const st = await read([unsigned]);
    expect(st.accounts[0]!.transactions).toEqual([]);
  });

  it("refuses a reading the printed balances contradict", async () => {
    expect(await infer([[...unsigned, "Saldo iniziale 100,00", "Saldo finale 5.000,00"]])).toBeUndefined();
  });

  it("is not verified without printed balances or totals, even when every amount is signed", async () => {
    const signed = await infer([[
      "Banca Fittizia Con Segni", "01/07/2026 - 31/07/2026 EUR",
      at([40, "02/07/2026"], [110, "Spesa alimentare"], [380, "-61,20"]),
      at([40, "10/07/2026"], [110, "Bonifico ricevuto"], [380, "+900,00"]),
    ]]);
    expect(signed).toMatchObject({ verified: false });
    expect(signed!.output.statement.accounts[0]!.transactions.map((t) => t.amount)).toEqual(["-61.2", "900"]);
  });

  it("leaves a description printed above its dated line to the readers that can place it", async () => {
    expect(await infer([[
      "Banca Fittizia Centrata", "01/07/2026 - 31/07/2026 EUR", "Saldo iniziale 100,00",
      at([200, "BONIFICO"]), at([40, "02/07/2026"], [380, "-10,00"]), at([200, "Da Tizio"]),
      at([200, "PRELIEVO"]), at([40, "10/07/2026"], [380, "-20,00"]), at([200, "Sportello"]),
      "Saldo finale 70,00",
    ]])).toBeUndefined();
  });

  it("does not read credit card bills, whose amounts follow the opposite convention", async () => {
    expect(await infer([[
      "Banco Fictício - Fatura do cartão de crédito", "01/07/2026 - 31/07/2026 BRL", "Saldo anterior 0,00",
      at([40, "02/07/2026"], [110, "Loja Fictícia"], [380, "-61,20"]),
      "Saldo final -61,20",
    ]])).toBeUndefined();
  });
});
