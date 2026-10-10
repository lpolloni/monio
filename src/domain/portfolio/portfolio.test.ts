import { describe, expect, it } from "vitest";
import { FxTable } from "../fx/fx-table";
import { computePortfolio, type AccountPosition } from "./portfolio";

const fx = new FxTable([
  { base: "EUR", quote: "BRL", asOf: "2026-01-01", rate: "6", source: "t" },
  { base: "EUR", quote: "USD", asOf: "2026-01-01", rate: "1.2", source: "t" },
  { base: "BTC", quote: "USD", asOf: "2026-01-01", rate: "120000", source: "t" },
]);

function pos(p: Partial<AccountPosition> & Pick<AccountPosition, "accountId" | "type" | "currency">): AccountPosition {
  return {
    name: p.accountId,
    entityId: "e1",
    entityKind: "personal",
    entityName: "Personal",
    institutionId: "inst-" + p.accountId,
    institutionName: "Bank " + p.accountId,
    institutionColor: null,
    country: "IT",
    includeInNetWorth: true,
    balance: null,
    balanceAsOf: "2026-01-10",
    lastSyncedAt: null,
    ...p,
  };
}

describe("computePortfolio", () => {
  const positions: AccountPosition[] = [
    pos({ accountId: "checking", type: "checking", currency: "EUR", balance: "1000" }),
    pos({ accountId: "nubank", type: "checking", currency: "BRL", balance: "6000", country: "BR" }),
    pos({ accountId: "card", type: "credit_card", currency: "EUR", balance: "-300", creditLimit: "5000" }),
    pos({ accountId: "broker", type: "investment", currency: "EUR", balance: "2500" }),
    pos({ accountId: "wallet", type: "crypto_wallet", currency: "BTC", holdings: [{ currency: "BTC", quantity: "0.01", symbol: "BTC" }] }),
    pos({ accountId: "pj", type: "checking", currency: "BRL", balance: "12000", entityKind: "business", entityName: "ACME Ltda" }),
  ];

  it("separates assets, liabilities and net worth; never counts credit limits", () => {
    const r = computePortfolio(positions, fx, "EUR", "2026-01-15", { includeBusiness: false });
    // assets: 1000 + 1000 (BRL 6000) + 2500 + 1000 (0.01 BTC = 1200 USD = 1000 EUR)
    expect(r.assets).toBe("5500");
    expect(r.liabilities).toBe("300");
    expect(r.netWorth).toBe("5200");
    expect(r.groups.crypto).toBe("1000");
    expect(r.groups.liabilities).toBe("300");
  });

  it("reports business separately unless explicitly included", () => {
    const personal = computePortfolio(positions, fx, "EUR", "2026-01-15", { includeBusiness: false });
    expect(personal.businessNetWorth).toBe("2000");
    const all = computePortfolio(positions, fx, "EUR", "2026-01-15", { includeBusiness: true });
    expect(all.netWorth).toBe("7200");
  });

  it("available balance only includes liquid personal accounts", () => {
    const r = computePortfolio(positions, fx, "EUR", "2026-01-15", { includeBusiness: false });
    expect(r.available).toBe("2000");
  });

  it("converts to other display currencies consistently", () => {
    const r = computePortfolio(positions, fx, "BRL", "2026-01-15", { includeBusiness: false });
    expect(r.netWorth).toBe("31200");
  });

  it("reports positions without balance or rate instead of guessing", () => {
    const r = computePortfolio(
      [pos({ accountId: "x", type: "checking", currency: "GBP", balance: "10" }), pos({ accountId: "y", type: "savings", currency: "EUR" })],
      fx,
      "EUR",
      "2026-01-15",
      { includeBusiness: false },
    );
    expect(r.netWorth).toBe("0");
    expect(r.unvalued).toEqual([
      { accountId: "x", reason: "no_rate", currency: "GBP" },
      { accountId: "y", reason: "no_balance" },
    ]);
  });

  it("groups by institution with the latest update timestamp", () => {
    const r = computePortfolio(positions, fx, "EUR", "2026-01-15", { includeBusiness: false });
    const nubank = r.institutions.find((i) => i.key === "inst-nubank");
    expect(nubank?.value).toBe("1000");
    expect(nubank?.lastUpdated).toBe("2026-01-10");
  });
});
