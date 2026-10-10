import { describe, expect, it } from "vitest";
import { FxTable } from "../fx/fx-table";
import { findPossibleDuplicates, matchTransfers, type MatchableTransaction } from "./matching";
import { computeFingerprints, descriptionSimilarity, hashIdentifier, maskIdentifier, normalizeDescription } from "./normalize";
import { detectRecurring, type RecurringInput } from "./recurring";

describe("normalization and fingerprints", () => {
  it("normalizes descriptions for matching only", () => {
    expect(normalizeDescription("  Pág*Netflix   12/03 ref 1234567 ")).toBe("PAG*NETFLIX REF");
  });

  it("produces stable fingerprints and disambiguates identical rows", () => {
    const rows = [
      { bookedOn: "2026-03-01", amount: "-4.50", currency: "EUR", description: "Bar Roma" },
      { bookedOn: "2026-03-01", amount: "-4.5", currency: "EUR", description: "BAR ROMA" },
      { bookedOn: "2026-03-02", amount: "-4.50", currency: "EUR", description: "Bar Roma" },
    ];
    const a = computeFingerprints(rows);
    const b = computeFingerprints(rows);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
  });

  it("prefers source ids when present", () => {
    const [a] = computeFingerprints([{ bookedOn: "2026-03-01", amount: "-1", currency: "EUR", description: "x", externalId: "FIT1" }]);
    const [b] = computeFingerprints([{ bookedOn: "2026-03-09", amount: "-2", currency: "EUR", description: "y", externalId: "FIT1" }]);
    expect(a).toBe(b);
  });

  it("hashes and masks identifiers without keeping them", () => {
    expect(hashIdentifier("IT60 X054 2811 1010 0000 0123 456")).toMatch(/^[0-9a-f]{64}$/);
    expect(maskIdentifier("IT60X0542811101000000123456")).toBe("3456");
  });

  it("measures description similarity", () => {
    expect(descriptionSimilarity("UBER *TRIP HELP.UBER.COM", "UBER TRIP")).toBeGreaterThan(0.3);
    expect(descriptionSimilarity("NETFLIX", "SPOTIFY")).toBe(0);
  });
});

const tx = (p: Partial<MatchableTransaction> & Pick<MatchableTransaction, "id" | "accountId" | "amount" | "bookedOn">): MatchableTransaction => ({
  accountType: "checking",
  currency: "EUR",
  description: "x",
  ...p,
});

describe("possible duplicates", () => {
  it("flags same amount, close dates and similar descriptions in the same account", () => {
    const existing = [tx({ id: "a", accountId: "acc", amount: "-25.00", bookedOn: "2026-03-01", description: "AMAZON MKTPLACE PMTS", fingerprint: "f1" })];
    const incoming = [tx({ id: "b", accountId: "acc", amount: "-25", bookedOn: "2026-03-03", description: "Amazon Mktplace", fingerprint: "f2" })];
    const r = findPossibleDuplicates(incoming, existing);
    expect(r).toHaveLength(1);
    expect(r[0]?.duplicateOfId).toBe("a");
  });

  it("ignores different accounts, amounts or distant dates", () => {
    const existing = [tx({ id: "a", accountId: "acc", amount: "-25", bookedOn: "2026-03-01", description: "AMAZON" })];
    expect(findPossibleDuplicates([tx({ id: "b", accountId: "other", amount: "-25", bookedOn: "2026-03-01", description: "AMAZON" })], existing)).toEqual([]);
    expect(findPossibleDuplicates([tx({ id: "c", accountId: "acc", amount: "-26", bookedOn: "2026-03-01", description: "AMAZON" })], existing)).toEqual([]);
    expect(findPossibleDuplicates([tx({ id: "d", accountId: "acc", amount: "-25", bookedOn: "2026-03-10", description: "AMAZON" })], existing)).toEqual([]);
  });
});

describe("transfer matching", () => {
  it("matches an exact same-currency transfer with high confidence", () => {
    const r = matchTransfers([
      tx({ id: "out", accountId: "n26", amount: "-500", bookedOn: "2026-03-01", description: "Transfer to Revolut" }),
      tx({ id: "in", accountId: "rev", amount: "500", bookedOn: "2026-03-01", description: "Top-up from N26" }),
    ]);
    expect(r).toEqual([expect.objectContaining({ outgoingId: "out", incomingId: "in", kind: "internal_transfer", confidence: "high" })]);
  });

  it("classifies payments into a credit card account as card payments", () => {
    const r = matchTransfers([
      tx({ id: "out", accountId: "chk", amount: "-1200.50", bookedOn: "2026-03-10", currency: "BRL", description: "Pagamento de fatura" }),
      tx({ id: "in", accountId: "card", accountType: "credit_card", amount: "1200.50", bookedOn: "2026-03-10", currency: "BRL", description: "Pagamento recebido" }),
    ]);
    expect(r[0]?.kind).toBe("card_payment");
  });

  it("matches cross-currency transfers within FX tolerance, as medium confidence", () => {
    const fx = new FxTable([{ base: "EUR", quote: "BRL", asOf: "2026-03-01", rate: "6.10", source: "t" }]);
    const r = matchTransfers(
      [
        tx({ id: "out", accountId: "nubank", amount: "-2000", currency: "BRL", bookedOn: "2026-03-02", description: "PIX enviado Wise" }),
        tx({ id: "in", accountId: "rev", amount: "325.10", currency: "EUR", bookedOn: "2026-03-04", description: "Payment from Wise" }),
      ],
      { fx },
    );
    expect(r[0]).toMatchObject({ outgoingId: "out", incomingId: "in", confidence: "medium" });
  });

  it("ignores cross-currency coincidences without transfer wording on both sides", () => {
    const fx = new FxTable([{ base: "EUR", quote: "BRL", asOf: "2026-03-01", rate: "6.10", source: "t" }]);
    const r = matchTransfers(
      [
        tx({ id: "out", accountId: "n26", amount: "-42.50", currency: "EUR", bookedOn: "2026-03-02", description: "ESSELUNGA" }),
        tx({ id: "in", accountId: "nu", amount: "259.25", currency: "BRL", bookedOn: "2026-03-02", description: "Pix recebido Maria" }),
      ],
      { fx },
    );
    expect(r).toEqual([]);
  });

  it("does not pair within the same account or with mismatched amounts", () => {
    expect(
      matchTransfers([
        tx({ id: "o", accountId: "a", amount: "-10", bookedOn: "2026-03-01" }),
        tx({ id: "i", accountId: "a", amount: "10", bookedOn: "2026-03-01" }),
        tx({ id: "j", accountId: "b", amount: "11", bookedOn: "2026-03-01" }),
      ]),
    ).toEqual([]);
  });

  it("matches one-to-one", () => {
    const r = matchTransfers([
      tx({ id: "o1", accountId: "a", amount: "-100", bookedOn: "2026-03-01", description: "transfer" }),
      tx({ id: "o2", accountId: "a", amount: "-100", bookedOn: "2026-03-01", description: "transfer" }),
      tx({ id: "i1", accountId: "b", amount: "100", bookedOn: "2026-03-01", description: "transfer" }),
    ]);
    expect(r).toHaveLength(1);
  });
});

describe("recurring detection", () => {
  const monthly = (id: string, date: string, amount: string, merchant = "Netflix"): RecurringInput => ({
    id,
    accountId: "card",
    bookedOn: date,
    amount,
    currency: "BRL",
    description: `PAG*${merchant.toUpperCase()}`,
    merchant,
    categorySlug: "subscriptions",
  });

  it("detects a monthly subscription, its next date and a price change", () => {
    const r = detectRecurring([
      monthly("1", "2026-01-05", "-39.90"),
      monthly("2", "2026-02-05", "-39.90"),
      monthly("3", "2026-03-05", "-39.90"),
      monthly("4", "2026-04-05", "-44.90"),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ cadence: "monthly", isSubscription: true, nextExpectedOn: "2026-05-05", lastAmount: "44.9", previousAmount: "39.9" });
    expect(Number(r[0]?.lastChange)).toBeCloseTo(0.1253, 3);
    expect(r[0]?.changedOn).toBe("2026-04-05");
  });

  it("finds a price change even when it happened several charges ago", () => {
    const r = detectRecurring([
      monthly("1", "2026-01-05", "-13.99"),
      monthly("2", "2026-02-05", "-13.99"),
      monthly("3", "2026-03-05", "-15.99"),
      monthly("4", "2026-04-05", "-15.99"),
    ]);
    expect(r[0]).toMatchObject({ previousAmount: "13.99", lastAmount: "15.99", changedOn: "2026-03-05" });
  });

  it("ignores irregular or too-few payments and transfers", () => {
    expect(detectRecurring([monthly("1", "2026-01-05", "-39.90"), monthly("2", "2026-02-05", "-39.90")])).toEqual([]);
    expect(
      detectRecurring([
        monthly("1", "2026-01-05", "-10"),
        monthly("2", "2026-01-19", "-200"),
        monthly("3", "2026-03-30", "-55"),
      ]),
    ).toEqual([]);
    expect(
      detectRecurring(
        ["2026-01-01", "2026-02-01", "2026-03-01"].map((d, i) => ({ ...monthly(String(i), d, "-500"), classification: "internal_transfer" })),
      ),
    ).toEqual([]);
  });
});
