import { describe, expect, it } from "vitest";
import { getCategory, isCategorySlug } from "@/domain/categories/catalog";
import { TRANSACTION_FIXTURES } from "./fixtures/transactions";
import { descriptionTokens, interpretWithFixtures, matchFixture, normalizeDescription, proposeRowsFromLines } from "./providers/mock";
import type { TransactionInterpretationInput } from "./schemas";
import { createAiService } from "./service";
import { MOCK_CONFIG } from "./test-utils";

const service = createAiService(MOCK_CONFIG);

async function interpretOne(description: string, amount: string, currency = "EUR", extra: Partial<TransactionInterpretationInput> = {}) {
  const result = await service.interpretTransactions([{ id: "x", description, amount, currency, ...extra }]);
  if (!result.ok) throw new Error(`unexpected failure: ${result.error.code}`);
  expect(result.data).toHaveLength(1);
  return result.data[0]!;
}

describe("mock provider — the Netflix example", () => {
  it("PAG*NETFLIX → Netflix / subscriptions / recurring / 0.98", async () => {
    const result = await service.interpretTransactions([{ id: "tx-1", description: "PAG*NETFLIX", amount: "-39.90", currency: "BRL" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      {
        id: "tx-1",
        merchant: "Netflix",
        category: "subscriptions",
        recurring_candidate: true,
        transfer_candidate: false,
        confidence: 0.98,
        reasoning_code: "fixture_match",
      },
    ]);
    expect(result.meta).toMatchObject({ provider: "mock", model: "monio-mock-v1", confidenceIsCalibrated: false, batches: 1 });
    expect(result.meta.failedIds).toBeUndefined();
  });
});

describe("mock provider — fixture coverage", () => {
  it.each([
    ["NETFLIX.COM 866-579-7172", "-15.99", "Netflix", "subscriptions", true],
    ["Spotify AB", "-10.99", "Spotify", "subscriptions", true],
    ["SPOTIFY P2A1B3C4", "-21.90", "Spotify", "subscriptions", true],
    ["APPLE.COM/BILL", "-9.90", "Apple", "subscriptions", true],
    ["GOOGLE *YouTube", "-24.90", "YouTube Premium", "subscriptions", true],
    ["AMAZON PRIME*2K4LM", "-19.90", "Amazon Prime", "subscriptions", true],
    ["DISNEY PLUS", "-33.90", "Disney+", "subscriptions", true],
    ["OPENAI *CHATGPT SUBSCR", "-20.00", "OpenAI", "subscriptions", true],
    ["GITHUB, INC.", "-4.00", "GitHub", "subscriptions", true],
    ["ADOBE *CREATIVE CLOUD", "-60.49", "Adobe", "subscriptions", true],
    ["UBER *TRIP", "-23.50", "Uber", "transport", false],
    ["UBER* EATS", "-41.20", "Uber Eats", "dining", false],
    ["99APP *99APP", "-18.30", "99", "transport", false],
    ["IFOOD *IFOOD", "-56.80", "iFood", "dining", false],
    ["RAPPI*RAPPI BRASIL", "-38.00", "Rappi", "dining", false],
    ["PAG*ZEDELIVERY", "-89.70", "Zé Delivery", "groceries", false],
    ["CARREFOUR COM BRASIL 123", "-210.45", "Carrefour", "groceries", false],
    ["CARREFOUR MARKET MILANO", "-32.10", "Carrefour Market", "groceries", false],
    ["PÃO DE AÇÚCAR 1234", "-150.00", "Pão de Açúcar", "groceries", false],
    ["ASSAI ATACADISTA LJ 45", "-480.10", "Assaí Atacadista", "groceries", false],
    ["DROGASIL 1234", "-45.90", "Drogasil", "health", false],
    ["DROGA RAIA 0099", "-27.35", "Droga Raia", "health", false],
    ["POSTO IPIRANGA", "-250.00", "Ipiranga", "fuel", false],
    ["SHELL SELECT", "-180.00", "Shell", "fuel", false],
    ["VIVO FIBRA", "-129.99", "Vivo", "telecom", true],
    ["CLARO S.A.", "-89.99", "Claro", "telecom", true],
    ["TIM S.p.A.", "-9.99", "TIM", "telecom", true],
    ["ENEL DISTRIBUICAO SP", "-210.33", "Enel", "utilities", true],
    ["SABESP", "-95.12", "Sabesp", "utilities", true],
    ["CEMIG DISTRIBUICAO", "-140.00", "Cemig", "utilities", true],
    ["ESSELUNGA SPA", "-64.30", "Esselunga", "groceries", false],
    ["CONAD SUPERSTORE", "-22.10", "Conad", "groceries", false],
    ["COOP LOMBARDIA", "-18.40", "Coop", "groceries", false],
    ["LIDL ITALIA", "-31.75", "Lidl", "groceries", false],
    ["TRENITALIA", "-49.90", "Trenitalia", "transport", false],
    ["ITALO NTV", "-39.90", "Italo", "transport", false],
    ["ATM MILANO", "-2.20", "ATM Milano", "transport", false],
    ["ENI STATION 1234", "-60.00", "Eni", "fuel", false],
    ["IP 12345 MILANO", "-55.00", "IP", "fuel", false],
    ["IREN MERCATO", "-80.10", "Iren", "utilities", true],
    ["A2A ENERGIA", "-75.00", "A2A Energia", "utilities", true],
    ["FASTWEB SPA", "-29.95", "Fastweb", "telecom", true],
    ["ILIAD ITALIA", "-9.99", "Iliad", "telecom", true],
    ["WINDTRE", "-12.99", "WindTre", "telecom", true],
    ["AMAZON MKTPLACE PMTS", "-35.99", "Amazon", "shopping", false],
    ["ZARA ITALIA", "-59.95", "Zara", "shopping", false],
    ["IKEA MILANO", "-120.00", "IKEA", "shopping", false],
    ["BOOKING.COM", "-320.00", "Booking.com", "travel", false],
    ["RYANAIR", "-89.99", "Ryanair", "travel", false],
    ["AIRBNB * HMXYZ", "-410.00", "Airbnb", "travel", false],
  ])("%s (%s) → %s / %s", async (description, amount, merchant, category, recurring) => {
    const r = await interpretOne(description, amount);
    expect(r).toMatchObject({ merchant, category, recurring_candidate: recurring, reasoning_code: "fixture_match" });
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it.each([
    ["PAGAMENTO SALARIO", "5000.00", "salary", false],
    ["SALARIO ACME LTDA", "5000.00", "salary", false],
    ["STIPENDIO SETTEMBRE", "2500.00", "salary", false],
    ["TRANSFERENCIA ENVIADA JOAO", "-300.00", "internal_transfer", true],
    ["BONIFICO A MARIO ROSSI", "-150.00", "internal_transfer", true],
    ["Transfer to Revolut account", "-50.00", "internal_transfer", true],
    ["GIROCONTO", "-1000.00", "internal_transfer", true],
    ["PAGAMENTO DE FATURA", "-2300.10", "card_payment", true],
    ["PAGAMENTO CARTA DI CREDITO", "-800.00", "card_payment", true],
    ["Card payment", "-120.00", "card_payment", true],
    ["RENDIMENTO POUPANCA", "12.34", "interest", false],
    ["INTERESSI CREDITORI", "0.85", "interest", false],
    ["DIVIDENDOS ITSA4", "45.10", "dividends", false],
    ["IOF COMPRA INTERNACIONAL", "-3.80", "fees", false],
    ["TARIFA PACOTE SERVICOS", "-39.00", "fees", false],
    ["COMMISSIONI BONIFICO", "-1.50", "fees", false],
    ["CANONE MENSILE CONTO", "-6.00", "fees", false],
    ["DARF IRPF", "-560.00", "taxes", false],
    ["F24 AGENZIA ENTRATE", "-320.00", "taxes", false],
    ["ALUGUEL APTO 101", "-2500.00", "housing", false],
    ["AFFITTO OTTOBRE", "-900.00", "housing", false],
    ["NUBANK PJ", "8000.00", "business_income", false],
  ])("%s (%s) → %s", async (description, amount, category, transfer) => {
    const r = await interpretOne(description, amount);
    expect(r.category).toBe(category);
    expect(r.transfer_candidate).toBe(transfer);
    expect(r.merchant).toBeNull();
  });

  it("PIX RECEBIDO from an unknown counterparty stays uncategorized with low confidence", async () => {
    const r = await interpretOne("PIX RECEBIDO JOAO DA SILVA", "150.00", "BRL");
    expect(r).toMatchObject({ merchant: null, category: null, transfer_candidate: false });
    expect(r.confidence).toBeLessThanOrEqual(0.3);
  });

  it("keyword fallback and no match", async () => {
    expect(await interpretOne("SUPERMERCADO BOM PRECO", "-80.00", "BRL")).toMatchObject({
      merchant: null,
      category: "groceries",
      reasoning_code: "keyword",
    });
    expect(await interpretOne("RISTORANTE DA MARIO", "-45.00")).toMatchObject({ category: "dining", reasoning_code: "keyword" });
    expect(await interpretOne("XQZ 123 WPLK", "-9.00")).toEqual({
      id: "x",
      merchant: null,
      category: null,
      recurring_candidate: false,
      transfer_candidate: false,
      confidence: 0.2,
      reasoning_code: "no_match",
    });
  });
});

describe("mock provider — direction rules", () => {
  it("an incoming PIX is never categorized as an expense", async () => {
    for (const d of ["PIX RECEBIDO", "PIX IFOOD", "PIX CARREFOUR", "TRANSFERENCIA RECEBIDA PELO PIX"]) {
      const r = await interpretOne(d, "40.00", "BRL");
      if (r.category) expect(getCategory(r.category)?.kind).not.toBe("expense");
    }
  });

  it("incoming money at a merchant becomes a refund", async () => {
    const r = await interpretOne("NETFLIX.COM", "39.90", "BRL");
    expect(r).toMatchObject({ merchant: "Netflix", category: "refunds", recurring_candidate: false, reasoning_code: "direction_rule" });
    expect(r.confidence).toBeCloseTo(0.78, 5);
    expect(await interpretOne("ESTORNO COMPRA AMAZON", "99.00", "BRL")).toMatchObject({ merchant: "Amazon", category: "refunds" });
  });

  it("outgoing money is never income", async () => {
    expect(await interpretOne("PAGAMENTO SALARIO", "-3000.00", "BRL")).toMatchObject({ category: null, reasoning_code: "direction_rule" });
    expect(await interpretOne("INTERESSI", "-12.00")).toMatchObject({ category: "fees" });
  });

  it("an explicit direction wins over the amount sign", async () => {
    expect((await interpretOne("ESSELUNGA", "64.30", "EUR", { direction: "out" })).category).toBe("groceries");
    expect((await interpretOne("ESSELUNGA", "-64.30", "EUR", { direction: "in" })).category).toBe("refunds");
  });

  it("transfers keep their category in both directions; overrides apply per direction", async () => {
    expect((await interpretOne("GIROCONTO", "500.00")).category).toBe("internal_transfer");
    expect((await interpretOne("GIROCONTO", "-500.00")).category).toBe("internal_transfer");
    expect((await interpretOne("AFFITTO VIA ROMA", "900.00")).category).toBe("other_income");
    expect((await interpretOne("NUBANK PJ", "-100.00", "BRL")).category).toBe("business_expenses");
  });

  it("no fixture ever yields an expense for incoming or income for outgoing money", () => {
    for (const fixture of TRANSACTION_FIXTURES) {
      for (const pattern of fixture.patterns) {
        for (const direction of ["in", "out"] as const) {
          const r = interpretWithFixtures({ id: "t1", description: pattern, amount: direction === "in" ? "10" : "-10", currency: "EUR", direction });
          if (!r.category) continue;
          const kind = getCategory(r.category)?.kind;
          if (direction === "in") expect(kind, `${pattern} in`).not.toBe("expense");
          else expect(kind, `${pattern} out`).not.toBe("income");
        }
      }
    }
  });
});

describe("mock provider — determinism & normalization", () => {
  const batch: TransactionInterpretationInput[] = [
    { id: "a", description: "PAG*NETFLIX", amount: "-39.90", currency: "BRL" },
    { id: "b", description: "ESSELUNGA SPA", amount: "-64.30", currency: "EUR" },
    { id: "c", description: "PIX RECEBIDO", amount: "100", currency: "BRL" },
    { id: "d", description: "?? unknown ??", amount: "-1", currency: "EUR" },
  ];

  it("returns identical results across runs and input orders", async () => {
    const first = await service.interpretTransactions(batch);
    const second = await service.interpretTransactions(batch);
    const reversed = await service.interpretTransactions([...batch].reverse());
    expect(first.ok && second.ok && reversed.ok).toBe(true);
    if (!first.ok || !second.ok || !reversed.ok) return;
    expect(second.data).toEqual(first.data);
    expect([...reversed.data].sort((x, y) => x.id.localeCompare(y.id))).toEqual(first.data);
  });

  it("normalizes case, accents, asterisk spacing and numeric tokens", async () => {
    expect(normalizeDescription("  pão   de açúcar 0042 ")).toBe("PAO DE ACUCAR");
    expect(normalizeDescription("UBER*TRIP")).toBe("UBER * TRIP");
    expect(descriptionTokens("APPLE.COM/BILL 12345")).toEqual(["APPLE", "COM", "BILL"]);
    for (const d of ["pag*netflix", "PAG * NETFLIX 000123", "Pag*Netflix.com"]) {
      expect((await interpretOne(d, "-39.90", "BRL")).merchant).toBe("Netflix");
    }
  });

  it("short brand tokens only match whole words", () => {
    expect(matchFixture("TIMBERLAND OUTLET")?.id).not.toBe("tim");
    expect(matchFixture("PAGAMENTO TIM")?.id).toBe("tim");
    expect(matchFixture("ZIP CODE")?.id).toBeUndefined();
    expect(matchFixture("SHIPPING IP")?.id).not.toBe("ip"); // "IP" is prefix-only
  });
});

describe("fixture catalog", () => {
  it("has at least 60 rules with unique ids, valid categories and simulated confidences", () => {
    expect(TRANSACTION_FIXTURES.length).toBeGreaterThanOrEqual(60);
    const ids = new Set(TRANSACTION_FIXTURES.map((f) => f.id));
    expect(ids.size).toBe(TRANSACTION_FIXTURES.length);
    for (const f of TRANSACTION_FIXTURES) {
      if (f.category) expect(isCategorySlug(f.category)).toBe(true);
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(f.merchant === null || f.merchant.length <= 80).toBe(true);
    }
  });

  it("every pattern is reachable (not shadowed by a higher-priority rule)", () => {
    for (const f of TRANSACTION_FIXTURES) {
      for (const pattern of f.patterns) {
        expect(descriptionTokens(pattern).length, pattern).toBeGreaterThan(0);
        expect(matchFixture(pattern)?.id, pattern).toBe(f.id);
      }
    }
  });
});

describe("mock statement rows", () => {
  it("proposes rows only from literal date + amount tokens", () => {
    const rows = proposeRowsFromLines({
      lines: [
        { line: 1, text: "EXTRATO CONTA CORRENTE" },
        { line: 2, text: "05/03/2026 PADARIA REAL -12,50" },
        { line: 3, text: "06/03 UBER *TRIP R$ 23,90 D" },
        { line: 4, text: "SALDO ANTERIOR 1.234,56" },
        { line: 5, text: "2026-03-07 ESSELUNGA SPA 64.30 EUR" },
        { line: 6, text: "07/03/2026 SEM VALOR" },
      ],
      year_hint: 2026,
    });
    expect(rows).toEqual([
      { line: 2, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.5" },
      { line: 3, date: "2026-03-06", description: "UBER *TRIP", amount: "-23.9", currency: "BRL" },
      { line: 5, date: "2026-03-07", description: "ESSELUNGA SPA", amount: "64.3", currency: "EUR" },
    ]);
  });

  it("does not guess the year of a day/month date without a hint", () => {
    expect(proposeRowsFromLines({ lines: [{ line: 1, text: "06/03 UBER *TRIP 23,90" }] })).toEqual([]);
  });
});
