import { describe, expect, it } from "vitest";
import { recognizeCategory } from "./recognize";
import { matchRule, ruleFromConfirmation, type CategorizationRule } from "./rules";

describe("automatic category recognition", () => {
  it.each([
    ["PIX enviado para Farmácia Aurora", "-20", "health"],
    ["PAG*SUPERMERCADO AURORA", "-80", "groceries"],
    ["UBER *EATS 123456", "-30", "dining"],
    ["UBER TRIP", "-10", "transport"],
    ["AMZN PRIME", "-15", "subscriptions"],
    ["AMAZON MKTPLACE", "-25", "shopping"],
    ["Bonifico stipendio", "2500", "salary"],
    ["Remuneração conta", "0.02", "interest"],
    ["RESGATE CDB", "1000", "investment"],
    ["APLICACAO CDB", "-1000", "investment"],
    ["ESTORNO AMAZON", "25", "refunds"],
    ["RIMBORSO HOTEL", "50", "refunds"],
    ["PAGAMENTO DE FATURA", "-200", "card_payment"],
    ["CONTA DE AGUA", "-30", "utilities"],
    ["PARRUCCHIERE AURORA", "-25", "personal_care"],
    ["RATA MUTUO", "-500", "loan_payment"],
  ])("%s → %s / %s", (description, amount, categorySlug) => {
    expect(recognizeCategory(description, amount)?.categorySlug).toBe(categorySlug);
  });
  it.each(["PIX RECEBIDO MARIA", "TED ENVIADA JOAO", "BONIFICO MARIO", "MERCADO PAGO", "PAYPAL", "TIMOTEO", "POSTOLOGIA", "AMAZONIA"]) (
    "%s has insufficient evidence", (description) => expect(recognizeCategory(description, "-30")).toBeNull(),
  );
  // Descriptions as banks word them, none tied to a known merchant.
  it.each([
    ["Compra débito - Mercado Bairro", "-758.28", "groceries"],
    ["Pagamento boleto - Internet", "-427.02", "telecom"],
    ["Pagamento de energia", "-173.03", "utilities"],
    ["Assinatura streaming", "-445.61", "subscriptions"],
    ["Tarifa de manutenção", "-12", "fees"],
    ["PIX enviado - Aluguel", "-900", "housing"],
    ["Crédito rendimento conta", "3.10", "interest"],
    ["Reembolso de compra", "50", "refunds"],
    ["Pagamento POS - Alimentari", "-40.5", "groceries"],
    ["Pagamento carta - Trasporti", "-12", "transport"],
    ["Addebito SEPA - Energia", "-80", "utilities"],
    ["Addebito SEPA - Telecom", "-30", "telecom"],
    ["Canone conto mensile", "-5", "fees"],
    ["Bonifico disposto - Affitto", "-700", "housing"],
    ["Accredito stipendio - Azienda Vela", "2000", "salary"],
    ["Prelievo ATM", "-100", "cash_withdrawal"],
    ["Interessi attivi", "1.2", "interest"],
    ["Rimborso acquisto online", "20", "refunds"],
    ["Card payment - Coffee Corner", "-4.5", "dining"],
    ["Direct debit water bill", "-35", "utilities"],
    ["Lastschrift Stadtwerke", "-45.1", "utilities"],
    ["Miete November", "-800", "housing"],
    ["Gehalt Fiktiv GmbH", "2100", "salary"],
    ["Compra no débito Posto Avenida", "-200", "fuel"],
    ["Academia Corpo Livre", "-99", "health"],
    ["Abbonamento palestra", "-38.8", "health"],
    ["Abbonamento mensile rivista", "-9.9", "subscriptions"],
    ["Seguro auto parcela 3", "-180", "insurance"],
    ["IPVA 2026", "-950", "taxes"],
    ["Loja Centro", "-75", "shopping"],
  ])("%s → %s", (description, amount, categorySlug) => {
    expect(recognizeCategory(description, amount)?.categorySlug).toBe(categorySlug);
  });

  // A transfer to someone does not say what it paid for; a surname is not a bill.
  it.each([
    ["PIX enviado - Pedro Almeida", "-379.62"],
    ["PIX enviado - Maria Luz", "-50"],
    ["Bonifico a Marco Mercato", "-120"],
    ["Transferência enviada - Loja do João", "-80"],
    ["TED recebida - Cliente Serra", "1460.14"],
    ["Bonifico da Elena Rossi", "458.75"],
    ["Pagamento via Internet Banking", "-300"],
    ["MERCADO PAGO *JOAO", "-45"],
    ["PAG SEGURO *LOJINHA", "-30"],
    ["ENEL ENERGIA SPA", "500"],
  ])("%s is left for the user", (description, amount) => {
    expect(recognizeCategory(description, amount)).toBeNull();
  });

  it("does not turn incoming purchases into expenses or outgoing salary into income", () => {
    expect(recognizeCategory("NETFLIX", "20")).toBeNull();
    expect(recognizeCategory("SALARIO", "-2000")).toBeNull();
    expect(recognizeCategory("SAQUE", "100")).toBeNull();
  });
  it("preserves the counterparty when learning a confirmation", () => {
    expect(ruleFromConfirmation("PIX ENVIADO PARA FARMACIA AURORA 123456", null)?.pattern)
      .toBe("PIX ENVIADO PARA FARMACIA AURORA");
    expect(ruleFromConfirmation("PIX ENVIADO PARA MARIA SILVA", null)?.pattern)
      .not.toBe(ruleFromConfirmation("PIX ENVIADO PARA JOAO SOUZA", null)?.pattern);
  });
  it("matches rule patterns on whole words, keeping punctuation inside the pattern", () => {
    const rule = (pattern: string): CategorizationRule => ({ id: pattern, userId: null, matchType: "contains", pattern, merchant: null, categoryId: "c", categorySlug: "transport", direction: null, priority: 10 });
    expect(matchRule("NTV ITALO TRENO 123", "-30", [rule("ITALO")])).not.toBeNull();
    expect(matchRule("VITALOGY STORE", "-30", [rule("ITALO")])).toBeNull();
    expect(matchRule("INTERCAMBIO CULTURAL", "-30", [rule("CAMBIO")])).toBeNull();
    expect(matchRule("UBER *TRIP HELP.UBER.COM", "-30", [rule("UBER *TRIP")])).not.toBeNull();
    expect(matchRule("APPLE.COM/BILL ITUNES", "-30", [rule("APPLE.COM/BILL")])).not.toBeNull();
  });
});
