import { describe, expect, it } from "vitest";
import { matchRule, ruleFromConfirmation, sortRules, type CategorizationRule } from "../categorization/rules";
import { FxTable } from "../fx/fx-table";
import { generateInsights } from "../insights/generate";
import { computeCashflow, type FlowTransaction } from "./cashflow";
import { computeNetWorthHistory } from "./net-worth-history";
import { isMonthComplete, monthEnd, monthsBetween } from "./periods";

const fx = new FxTable([
  { base: "EUR", quote: "BRL", asOf: "2026-01-01", rate: "6", source: "t" },
  { base: "EUR", quote: "BRL", asOf: "2026-02-01", rate: "5", source: "t" },
]);

const flow = (p: Partial<FlowTransaction> & Pick<FlowTransaction, "id" | "bookedOn" | "amount">): FlowTransaction => ({
  currency: "EUR",
  classification: "regular",
  categorySlug: null,
  categoryKind: null,
  accountId: "a",
  entityKind: "personal",
  country: "IT",
  institutionId: "i",
  status: "posted",
  duplicateOf: null,
  ...p,
});

describe("cash flow", () => {
  const txs = [
    flow({ id: "salary", bookedOn: "2026-01-27", amount: "3000", categorySlug: "salary", categoryKind: "income" }),
    flow({ id: "rent", bookedOn: "2026-01-02", amount: "-900", categorySlug: "housing", categoryKind: "expense" }),
    flow({ id: "food", bookedOn: "2026-01-10", amount: "-120", currency: "BRL", categorySlug: "groceries", categoryKind: "expense", country: "BR" }),
    flow({ id: "refund", bookedOn: "2026-01-12", amount: "20", categorySlug: "refunds", categoryKind: "income" }),
    flow({ id: "transfer", bookedOn: "2026-01-15", amount: "-500", classification: "internal_transfer" }),
    flow({ id: "cardpay", bookedOn: "2026-01-20", amount: "-400", classification: "card_payment" }),
    flow({ id: "dup", bookedOn: "2026-01-11", amount: "-120", duplicateOf: "food" }),
    flow({ id: "pending", bookedOn: "2026-01-11", amount: "-60", status: "pending" }),
    flow({ id: "biz", bookedOn: "2026-01-11", amount: "5000", entityKind: "business" }),
    flow({ id: "invest", bookedOn: "2026-01-16", amount: "-700", categorySlug: "investment", categoryKind: "transfer" }),
  ];

  it("excludes transfers, card payments, duplicates, pending and business rows", () => {
    const r = computeCashflow(txs, fx, "EUR", { from: "2026-01-01", to: "2026-01-31", includeBusiness: false });
    expect(r.income).toBe("3000");
    // 900 + 20 (120 BRL @ 6) - 20 refund
    expect(r.expenses).toBe("900");
    expect(r.net).toBe("2100");
    expect(r.excludedTransfers).toBe(3);
  });

  it("converts each transaction at its own date", () => {
    const r = computeCashflow(
      [flow({ id: "x", bookedOn: "2026-02-10", amount: "-100", currency: "BRL", categorySlug: "groceries", categoryKind: "expense" })],
      fx,
      "EUR",
      { from: "2026-02-01", to: "2026-02-28", includeBusiness: false },
    );
    expect(r.expenses).toBe("20");
  });

  it("breaks expenses down by category and country", () => {
    const r = computeCashflow(txs, fx, "EUR", { from: "2026-01-01", to: "2026-01-31", includeBusiness: false });
    expect(r.expensesByCategory.map((b) => b.key)).toEqual(["housing", "groceries", "refunds"]);
    expect(r.expensesByCountry.find((b) => b.key === "BR")?.amount).toBe("20");
    expect(r.byMonth).toEqual([{ month: "2026-01", income: "3000", expenses: "900", net: "2100" }]);
  });

  it("breaks income down by category, country, institution and currency", () => {
    const more = [
      ...txs,
      flow({ id: "freelance", bookedOn: "2026-01-20", amount: "1200", currency: "BRL", categorySlug: "other_income", categoryKind: "income", country: "BR", institutionId: "j" }),
    ];
    const r = computeCashflow(more, fx, "EUR", { from: "2026-01-01", to: "2026-01-31", includeBusiness: false });
    expect(r.incomeByCategory.map((b) => [b.key, b.amount])).toEqual([["salary", "3000"], ["other_income", "200"]]);
    expect(r.incomeByCountry.map((b) => [b.key, b.amount])).toEqual([["IT", "3000"], ["BR", "200"]]);
    expect(r.incomeByInstitution.map((b) => [b.key, b.amount])).toEqual([["i", "3000"], ["j", "200"]]);
    expect(r.incomeByCurrency.map((b) => [b.key, b.amount])).toEqual([["EUR", "3000"], ["BRL", "200"]]);
    // A refund lowers expenses; it is never income.
    expect(r.income).toBe("3200");
  });
});

describe("periods", () => {
  it("only treats ended, fully covered months as complete", () => {
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthsBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(isMonthComplete("2026-02", "2026-03-10", "2026-03-09")).toBe(true);
    expect(isMonthComplete("2026-02", "2026-03-10", "2026-02-20")).toBe(false);
    expect(isMonthComplete("2026-03", "2026-03-10", "2026-03-10")).toBe(false);
  });
});

describe("net worth history", () => {
  it("separates exchange-rate effects from position changes", () => {
    const points = computeNetWorthHistory(
      [{ accountId: "nu", entityKind: "personal", includeInNetWorth: true, isCrypto: false }],
      [{ accountId: "nu", asOf: "2026-01-01", balance: "6000", currency: "BRL" }],
      [],
      fx,
      "EUR",
      ["2026-01-15", "2026-02-15"],
      { includeBusiness: false },
    );
    // Same BRL balance: 1000 EUR at 6, 1200 EUR at 5 — the whole change is FX.
    expect(points.map((p) => p.netWorth)).toEqual(["1000", "1200"]);
    expect(points.map((p) => p.netWorthAtConstantRates)).toEqual(["1200", "1200"]);
  });
});

describe("categorization rules", () => {
  const rules: CategorizationRule[] = [
    { id: "s1", userId: null, matchType: "contains", pattern: "NETFLIX", merchant: "Netflix", categoryId: "c1", categorySlug: "subscriptions", direction: "out", priority: 10 },
    { id: "s2", userId: null, matchType: "contains", pattern: "AMAZON", merchant: "Amazon", categoryId: "c2", categorySlug: "shopping", direction: "out", priority: 60 },
    { id: "u1", userId: "me", matchType: "contains", pattern: "AMAZON PRIME", merchant: "Amazon Prime", categoryId: "c1", categorySlug: "subscriptions", direction: null, priority: 100 },
    { id: "s3", userId: null, matchType: "contains", pattern: "SALARIO", merchant: null, categoryId: "c3", categorySlug: "salary", direction: "in", priority: 10 },
  ];
  const sorted = sortRules(rules);

  it("lets user rules win over system rules", () => {
    expect(matchRule("AMAZON PRIME*2X7Y", "-14.90", sorted)).toMatchObject({ ruleId: "u1", confidence: 1 });
    expect(matchRule("AMAZON MKTPLACE", "-30", sorted)).toMatchObject({ ruleId: "s2", confidence: 0.9 });
  });

  it("respects direction", () => {
    expect(matchRule("PAG*NETFLIX", "-39.90", sorted)?.categorySlug).toBe("subscriptions");
    expect(matchRule("NETFLIX REEMBOLSO", "39.90", sorted)).toBeNull();
    expect(matchRule("SALARIO ACME", "3000", sorted)?.categorySlug).toBe("salary");
  });

  it("derives a reusable pattern from a confirmation", () => {
    expect(ruleFromConfirmation("PAG*PADARIA SAO JOSE 1234", null)).toEqual({ matchType: "contains", pattern: "PAG*PADARIA SAO JOSE" });
    expect(ruleFromConfirmation("x", null)).toBeNull();
  });
});

describe("insights", () => {
  it("compares complete months only and keeps the evidence", () => {
    const insights = generateInsights({
      today: "2026-03-10",
      currency: "EUR",
      dataCoveredUntil: "2026-03-09",
      categoryExpensesByMonth: {
        "2026-01": [{ key: "groceries", amount: "300", count: 10 }],
        "2026-02": [{ key: "groceries", amount: "420", count: 12 }],
        "2026-03": [{ key: "groceries", amount: "50", count: 2 }],
      },
      monthlyTotals: [{ month: "2026-02", income: "3000", expenses: "2100", net: "900" }],
      recurring: [],
      netWorthWindow: [],
    });
    const change = insights.find((i) => i.kind === "category_spend_change");
    expect(change?.params).toMatchObject({ category: "groceries", direction: "up", changePct: 40, month: "2026-02" });
    expect(change?.evidence).toMatchObject({ current: "420", previous: "300" });
    expect(insights.find((i) => i.kind === "savings_rate")?.params.rate).toBe(30);
  });

  it("does not compare when the latest month is not fully covered", () => {
    const insights = generateInsights({
      today: "2026-03-10",
      currency: "EUR",
      dataCoveredUntil: "2026-02-15",
      categoryExpensesByMonth: { "2026-01": [{ key: "groceries", amount: "300", count: 1 }], "2026-02": [{ key: "groceries", amount: "50", count: 1 }] },
      monthlyTotals: [],
      recurring: [],
      netWorthWindow: [],
    });
    expect(insights.filter((i) => i.kind === "category_spend_change" && i.params.month === "2026-02")).toEqual([]);
  });

  it("explains wealth changes driven by exchange rates", () => {
    const insights = generateInsights({
      today: "2026-02-15",
      currency: "EUR",
      dataCoveredUntil: null,
      categoryExpensesByMonth: {},
      monthlyTotals: [],
      recurring: [],
      netWorthWindow: [
        { date: "2026-01-15", netWorth: "1000", assets: "1000", liabilities: "0", crypto: "0", netWorthAtConstantRates: "1200" },
        { date: "2026-02-15", netWorth: "1200", assets: "1200", liabilities: "0", crypto: "0", netWorthAtConstantRates: "1200" },
      ],
    });
    expect(insights.find((i) => i.kind === "fx_effect")?.params).toMatchObject({ direction: "up", total: "200.00", fxEffect: "200.00", share: 100 });
  });
});
