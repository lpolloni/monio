import { describe, expect, it } from "vitest";
import { accountLabel, institutionShortLabel } from "./institutions";

describe("accountLabel", () => {
  it("does not repeat the institution already present in the account name", () => {
    expect(accountLabel("Revolut", "Revolut EUR")).toBe("Revolut EUR");
    expect(accountLabel("Nubank", "Conta Nubank")).toBe("Conta Nubank");
    expect(accountLabel("BBVA Italia", "Conto BBVA")).toBe("Conto BBVA");
  });

  it("prefixes the institution otherwise", () => {
    expect(accountLabel("Monte dei Paschi di Siena", "Conto Casa MPS")).toBe("Monte dei Paschi di Siena Conto Casa MPS");
    expect(accountLabel("N26", "Space Viaggi")).toBe("N26 Space Viaggi");
  });

  it("matches whole words only and handles missing parts", () => {
    expect(accountLabel("Inter", "International savings")).toBe("Inter International savings");
    expect(accountLabel(null, "Cold storage")).toBe("Cold storage");
    expect(accountLabel("XP", "")).toBe("XP");
  });
});

describe("institutionShortLabel", () => {
  it("uses curated labels, chain symbols, then a monogram", () => {
    expect(institutionShortLabel("nubank", "Nubank")).toBe("Nu");
    expect(institutionShortLabel(null, "Wallet", "bitcoin")).toBe("₿");
    expect(institutionShortLabel(null, "Ethereum", "evm")).toBe("Ξ");
  });
});
