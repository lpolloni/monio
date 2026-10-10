import { describe, expect, it } from "vitest";
import {
  INSTITUTIONS,
  bicContradicts,
  findBic,
  findIban,
  findInstitutionByBic,
  findInstitutionByIban,
  findInstitutionByOfxId,
  findInstitutionByText,
  isValidIban,
} from "./institution-catalog";

describe("institution catalog", () => {
  it("has unique slugs, brand colors and the required institutions", () => {
    const slugs = INSTITUTIONS.map((i) => i.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of ["nubank", "nubank-pj", "xp", "santander-br", "bbva-it", "n26", "revolut", "mps", "itau", "bradesco", "banco-do-brasil", "inter", "intesa-sanpaolo", "unicredit", "fineco", "wise"]) {
      expect(slugs).toContain(slug);
    }
    for (const def of INSTITUTIONS) {
      expect(def.brandColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(["bank", "neobank", "broker"]).toContain(def.kind);
      expect(def.country).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("matches aliases case- and diacritic-insensitively on word boundaries", () => {
    expect(findInstitutionByText("EXTRATO NUBANK - março")?.slug).toBe("nubank");
    expect(findInstitutionByText("Banco Itaú Unibanco S.A.")?.slug).toBe("itau");
    expect(findInstitutionByText("Estratto conto N26 Bank")?.slug).toBe("n26");
    expect(findInstitutionByText("Monte dei Paschi di Siena - estratto")?.slug).toBe("mps");
    expect(findInstitutionByText("code AN26X and revolutionary")).toBeUndefined();
    expect(findInstitutionByText("")).toBeUndefined();
  });

  it("prefers distinctive aliases over weak ones", () => {
    const strong = findInstitutionByText("Santander Brasil - extrato");
    const weak = findInstitutionByText("Santander");
    expect(strong?.slug).toBe("santander-br");
    expect(weak?.slug).toBe("santander-br");
    expect(strong!.confidence).toBeGreaterThan(weak!.confidence);
  });

  it("distinguishes Nubank PJ from Nubank by business markers", () => {
    expect(findInstitutionByText("Nubank - Conta PJ")?.slug).toBe("nubank-pj");
    expect(findInstitutionByText("Nubank - CNPJ 00.000.000/0000-00")?.slug).toBe("nubank-pj");
    expect(findInstitutionByText("Nubank - conta pessoal")?.slug).toBe("nubank");
  });

  it("maps OFX ORG/FID/BANKID values", () => {
    expect(findInstitutionByOfxId(undefined, undefined, "0033")?.slug).toBe("santander-br");
    expect(findInstitutionByOfxId(undefined, "260")?.slug).toBe("nubank");
    expect(findInstitutionByOfxId(undefined, undefined, "102")?.slug).toBe("xp");
    const agreed = findInstitutionByOfxId("NU PAGAMENTOS S.A.", "260");
    expect(agreed).toMatchObject({ slug: "nubank", confidence: 0.95 });
    expect(findInstitutionByOfxId("Some Unknown Credit Union", "99999", "99999")).toBeUndefined();
  });

  it("validates IBANs and maps bank codes", () => {
    expect(isValidIban("IT60X0542811101000000123456")).toBe(true);
    expect(isValidIban("IT61X0542811101000000123456")).toBe(false);
    expect(findIban("Conto: IT60 X054 2811 1010 0000 0123 456 - EUR")).toBe("IT60X0542811101000000123456");
    expect(findInstitutionByIban("IT00X0103000000000000000000")?.slug).toBe("mps");
    expect(findInstitutionByIban("DE00100110010000000000")?.slug).toBe("n26");
    expect(findInstitutionByIban("FR7600000000000000000000000")).toBeUndefined();
  });

  it("reads a labelled BIC and maps it to its bank", () => {
    expect(findBic("IBAN: IT60X0542811101000000123456\nBIC: BBVAITMMXXX")).toBe("BBVAITMMXXX");
    expect(findBic("SWIFT/BIC NTSBDEB1XXX")).toBe("NTSBDEB1XXX");
    expect(findBic("ESTRATTO TRIMESTRALE")).toBeUndefined();
    expect(findInstitutionByBic("BBVAITMMXXX")).toMatchObject({ slug: "bbva-it", confidence: 0.9 });
    expect(findInstitutionByBic("BBVAESMMXXX")).toBeUndefined();
    expect(findInstitutionByIban("IT22Q0357600000000000000000")?.slug).toBe("bbva-it");
  });

  it("knows when a BIC belongs to another bank than the one named", () => {
    expect(bicContradicts("BBVAITMMXXX", "n26")).toBe(true);
    expect(bicContradicts("NTSBITM1XXX", "n26")).toBe(false);
    expect(bicContradicts("BBVAITMMXXX", "nubank")).toBe(false);
  });
});
