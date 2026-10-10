import { describe, expect, it } from "vitest";
import { recognizeCategory } from "./recognize";
import { ruleFromConfirmation } from "./rules";

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
});
