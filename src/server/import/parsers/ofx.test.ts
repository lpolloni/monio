import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../parse-document";
import { parseOfxTree } from "./ofx";

const FIXTURES = path.resolve(import.meta.dirname, "../../../../tests/fixtures/statements");
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(FIXTURES, name)));
const ofx = (body: string) => new TextEncoder().encode(`OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>${body}</OFX>\n`);

describe("OFX 1.x (SGML)", () => {
  it("reads a Santander Brasil checking statement with unclosed tags and CP1252 text", async () => {
    const st = await parseDocument({ bytes: fixture("santander-br-checking.ofx"), filename: "extrato.ofx" });
    expect(st.format).toBe("ofx");
    expect(st.institution).toMatchObject({ slug: "santander-br", name: "SANTANDER", confidence: 0.95 });
    expect(st.period).toEqual({ start: "2026-03-01", end: "2026-03-31" });
    const account = st.accounts[0]!;
    expect(account).toMatchObject({
      key: "default",
      type: "checking",
      currency: "BRL",
      identifier: "000100012345",
      identifierMask: "2345",
      closingBalance: { amount: "709.54", asOf: "2026-03-31" },
    });
    expect(account.transactions.map((t) => [t.bookedOn, t.amount, t.description, t.externalId])).toEqual([
      ["2026-03-02", "2500", "PIX RECEBIDO - EMPREGADOR FICTÍCIO LTDA", "20260302001"],
      ["2026-03-05", "-1234.56", "PAGAMENTO DE FATURA CARTÃO", "20260305001"],
      ["2026-03-10", "-500", "TRANSFERÊNCIA PARA NUBANK - CONTA PRÓPRIA", "20260310001"],
      ["2026-03-15", "-55.9", "DEBITO AUTOMATICO - CONTA DE LUZ EXEMPLO", "20260315001"],
    ]);
    expect(account.transactions[0]!.raw).toMatchObject({ TRNTYPE: "CREDIT", CHECKNUM: "000001" });
    expect(account.transactions[0]!.sourceRow).toBeGreaterThan(30);
    expect(st.warnings).toEqual([]);
  });

  it("reads several statements (bank + savings + card) from one file", async () => {
    const stmt = (type: string, id: string, amount: string) =>
      `<STMTRS><CURDEF>EUR<BANKACCTFROM><BANKID>01030<ACCTID>${id}<ACCTTYPE>${type}</BANKACCTFROM>` +
      `<BANKTRANLIST><DTSTART>20260301<DTEND>20260331<STMTTRN><TRNTYPE>OTHER<DTPOSTED>20260310<TRNAMT>${amount}<FITID>${id}-1<NAME>Movimento ${type}</STMTTRN></BANKTRANLIST>` +
      `<LEDGERBAL><BALAMT>100.00<DTASOF>20260331</LEDGERBAL></STMTRS>`;
    const card =
      "<CCSTMTRS><CURDEF>EUR<CCACCTFROM><ACCTID>4111XXXXXXXX9876</CCACCTFROM><BANKTRANLIST>" +
      "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260312<TRNAMT>-19.99<FITID>c1<NAME>Spotify</STMTTRN></BANKTRANLIST></CCSTMTRS>";
    const bytes = ofx(
      `<SIGNONMSGSRSV1><SONRS><FI><ORG>Banca Fittizia<FID>99</FI></SONRS></SIGNONMSGSRSV1>` +
        `<BANKMSGSRSV1><STMTTRNRS>${stmt("CHECKING", "IT00000000000000000001234", "-10.00")}</STMTTRNRS>` +
        `<STMTTRNRS>${stmt("SAVINGS", "IT00000000000000000005678", "5.00")}</STMTTRNRS></BANKMSGSRSV1>` +
        `<CREDITCARDMSGSRSV1><CCSTMTTRNRS>${card}</CCSTMTTRNRS></CREDITCARDMSGSRSV1>`,
    );
    const st = await parseDocument({ bytes, filename: "multi.ofx" });
    expect(st.accounts.map((a) => [a.key, a.type, a.identifierMask, a.transactions.length])).toEqual([
      ["account-1", "checking", "1234", 1],
      ["account-2", "savings", "5678", 1],
      ["card-3", "credit_card", "9876", 1],
    ]);
    expect(st.accounts[2]!.transactions[0]!.amount).toBe("-19.99");
    // ORG not in the catalog, but BANKID 01030 is not an OFX id either: name-only hint.
    expect(st.institution).toMatchObject({ name: "Banca Fittizia" });
    expect(st.institution?.slug).toBeUndefined();
  });

  it("converts <CURRENCY> amounts with CURRATE and accepts comma decimals", async () => {
    const bytes = ofx(
      "<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>260<ACCTID>123<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>" +
        "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260310<TRNAMT>-10,00<FITID>a<NAME>Compra exterior<CURRENCY><CURRATE>5,5<CURSYM>USD</CURRENCY></STMTTRN>" +
        "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260311<TRNAMT>-3,50<FITID>b<NAME>Padaria</STMTTRN>" +
        "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>",
    );
    const st = await parseDocument({ bytes, filename: "nubank.ofx" });
    expect(st.institution?.slug).toBe("nubank");
    expect(st.accounts[0]!.transactions.map((t) => [t.amount, t.currency, t.originalAmount, t.originalCurrency])).toEqual([
      ["-55", "BRL", "-10", "USD"],
      ["-3.5", "BRL", undefined, undefined],
    ]);
  });

  it("warns about unreadable transactions and unsupported investment statements", async () => {
    const bad = ofx(
      "<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR<BANKTRANLIST>" +
        "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>notadate<TRNAMT>-1.00<FITID>x</STMTTRN>" +
        "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260301<FITID>y</STMTTRN>" +
        "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>",
    );
    const st = await parseDocument({ bytes: bad, filename: "bad.ofx" });
    expect(st.warnings.map((w) => w.code)).toEqual(["row_unreadable", "missing_amount", "empty_document"]);

    const invest = ofx("<INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>");
    const st2 = await parseDocument({ bytes: invest, filename: "broker.ofx" });
    expect(st2.warnings.map((w) => w.code)).toEqual(["unsupported_layout"]);
  });
});

describe("OFX 2.x (XML)", () => {
  it("reads a credit card statement with ORIGCURRENCY and XML entities", async () => {
    const st = await parseDocument({ bytes: fixture("nubank-card.ofx"), filename: "fatura.ofx" });
    expect(st.institution).toMatchObject({ slug: "nubank", confidence: 0.95 });
    const account = st.accounts[0]!;
    expect(account).toMatchObject({ type: "credit_card", currency: "BRL", identifierMask: "4321", closingBalance: { amount: "-512.3", asOf: "2026-03-31" } });
    const steam = account.transactions.find((t) => t.externalId === "card-0003")!;
    expect(steam).toMatchObject({ bookedOn: "2026-03-07", valueOn: "2026-03-06", amount: "-54.35", originalAmount: "-10", originalCurrency: "USD" });
    expect(account.transactions.find((t) => t.externalId === "card-0004")!.description).toBe("Padaria & Café Exemplo");
    expect(account.transactions.find((t) => t.externalId === "card-0005")!.amount).toBe("1234.56");
    expect(account.transactions.find((t) => t.externalId === "card-0001")!.description).toBe("Netflix.com");
  });

  it("does not expand custom entities or DTDs", () => {
    const tree = parseOfxTree(
      '<?xml version="1.0"?><!DOCTYPE OFX [<!ENTITY x "boom">]><OFX><NAME>&x;&amp;&#65;</NAME></OFX>',
    );
    expect(tree.children[0]!.children[0]!.text).toBe("&x;&A");
  });
});
