/**
 * Catalog of known financial institutions, used only to *suggest* which
 * institution a statement came from. Detection is a hint (with a confidence and
 * a human-readable evidence string) that the user confirms; parsers never depend
 * on an institution being known — unknown banks go through the generic parsers.
 *
 * Identifiers (OFX bank ids, BICs, IBAN bank codes) are public routing codes.
 */
import { escapeRegExp, fold } from "./parsers/text";

export type InstitutionKind = "bank" | "neobank" | "broker";

export interface InstitutionDefinition {
  slug: string;
  name: string;
  /** ISO 3166-1 alpha-2 of the main operating entity. */
  country: string;
  kind: InstitutionKind;
  brandColor: `#${string}`;
  /** Distinctive names; matched case/diacritic-insensitively on word boundaries. */
  aliases: string[];
  /** Ambiguous names (shared with other entities/countries): weak evidence only. */
  weakAliases?: string[];
  /** Branded names in the holder's own position summary, never counterparties. */
  ownedProductAliases?: string[];
  /** OFX <ORG>, <FID> or <BANKID> values (numeric ids compared without leading zeros). */
  ofxIds?: string[];
  bic?: string;
  /** "<IBAN country>:<bank code>" pairs, e.g. "IT:01030" (ABI) or "DE:10011001" (BLZ). */
  ibanBankCodes?: string[];
  /** Usual account currency, used as a last-resort hint by parsers. */
  defaultCurrency?: string;
  /**
   * A variant (e.g. a business account) of another institution: chosen instead of
   * `variantOf` when the parent matches and one of `variantMarkers` is present.
   */
  variantOf?: string;
  variantMarkers?: string[];
}

export const INSTITUTIONS: readonly InstitutionDefinition[] = [
  {
    slug: "nubank",
    name: "Nubank",
    country: "BR",
    kind: "neobank",
    brandColor: "#820ad1",
    aliases: ["nubank", "nu pagamentos", "nu financeira", "nu bank"],
    ofxIds: ["260", "0260"],
    defaultCurrency: "BRL",
  },
  {
    slug: "nubank-pj",
    name: "Nubank PJ",
    country: "BR",
    kind: "neobank",
    brandColor: "#820ad1",
    aliases: ["nubank pj", "nu pj", "conta pj nubank"],
    defaultCurrency: "BRL",
    variantOf: "nubank",
    variantMarkers: ["pj", "conta pj", "cnpj", "pessoa juridica", "conta empresarial"],
  },
  {
    slug: "xp",
    name: "XP Investimentos",
    country: "BR",
    kind: "broker",
    brandColor: "#ffc800",
    aliases: ["xp investimentos", "xp inc", "banco xp", "xp corretora"],
    ofxIds: ["102", "0102", "348"],
    defaultCurrency: "BRL",
  },
  {
    slug: "santander-br",
    name: "Santander Brasil",
    country: "BR",
    kind: "bank",
    brandColor: "#ec0000",
    aliases: ["santander brasil", "banco santander brasil", "santander br"],
    weakAliases: ["santander"],
    ofxIds: ["033", "33"],
    bic: "BSCHBRSP",
    defaultCurrency: "BRL",
  },
  {
    slug: "bbva-it",
    name: "BBVA Italia",
    country: "IT",
    kind: "bank",
    brandColor: "#004481",
    aliases: ["bbva italia"],
    weakAliases: ["bbva", "banco bilbao vizcaya argentaria"],
    bic: "BBVAITMM",
    ibanBankCodes: ["IT:03576"],
    defaultCurrency: "EUR",
  },
  {
    slug: "n26",
    name: "N26",
    country: "DE",
    kind: "neobank",
    brandColor: "#36a18b",
    aliases: ["n26", "n26 bank"],
    bic: "NTSBDEB1",
    ibanBankCodes: ["DE:10011001"],
    defaultCurrency: "EUR",
  },
  {
    slug: "revolut",
    name: "Revolut",
    country: "LT",
    kind: "neobank",
    brandColor: "#191c1f",
    aliases: ["revolut", "revolut bank", "revolut ltd"],
    bic: "REVOLT21",
    ibanBankCodes: ["LT:32500"],
    defaultCurrency: "EUR",
  },
  {
    slug: "mps",
    name: "Monte dei Paschi di Siena",
    country: "IT",
    kind: "bank",
    brandColor: "#7a1f2b",
    aliases: ["monte dei paschi di siena", "monte dei paschi", "banca monte dei paschi", "banca mps"],
    weakAliases: ["mps"],
    bic: "PASCITMM",
    ibanBankCodes: ["IT:01030"],
    defaultCurrency: "EUR",
  },
  {
    slug: "itau",
    name: "Itaú Unibanco",
    country: "BR",
    kind: "bank",
    brandColor: "#ec7000",
    aliases: ["itau unibanco", "banco itau", "itau"],
    ofxIds: ["341", "0341"],
    bic: "ITAUBRSP",
    defaultCurrency: "BRL",
  },
  {
    slug: "bradesco",
    name: "Bradesco",
    country: "BR",
    kind: "bank",
    brandColor: "#cc092f",
    aliases: ["banco bradesco", "bradesco"],
    ofxIds: ["237", "0237"],
    bic: "BBDEBRSP",
    defaultCurrency: "BRL",
  },
  {
    slug: "banco-do-brasil",
    name: "Banco do Brasil",
    country: "BR",
    kind: "bank",
    brandColor: "#fae128",
    aliases: ["banco do brasil"],
    ownedProductAliases: ["bb rende facil", "bb lci"],
    ofxIds: ["001", "1"],
    bic: "BRASBRRJ",
    defaultCurrency: "BRL",
  },
  {
    slug: "inter",
    name: "Banco Inter",
    country: "BR",
    kind: "neobank",
    brandColor: "#ff7a00",
    aliases: ["banco inter", "inter&co"],
    ofxIds: ["077", "77"],
    defaultCurrency: "BRL",
  },
  {
    slug: "intesa-sanpaolo",
    name: "Intesa Sanpaolo",
    country: "IT",
    kind: "bank",
    brandColor: "#006f3c",
    aliases: ["intesa sanpaolo", "intesa san paolo", "banca intesa"],
    bic: "BCITITMM",
    ibanBankCodes: ["IT:03069"],
    defaultCurrency: "EUR",
  },
  {
    slug: "unicredit",
    name: "UniCredit",
    country: "IT",
    kind: "bank",
    brandColor: "#e2001a",
    aliases: ["unicredit"],
    bic: "UNCRITMM",
    ibanBankCodes: ["IT:02008"],
    defaultCurrency: "EUR",
  },
  {
    slug: "fineco",
    name: "FinecoBank",
    country: "IT",
    kind: "bank",
    brandColor: "#002d72",
    aliases: ["finecobank", "fineco"],
    bic: "FEBIITM1",
    ibanBankCodes: ["IT:03015"],
    defaultCurrency: "EUR",
  },
  {
    slug: "wise",
    name: "Wise",
    country: "GB",
    kind: "neobank",
    brandColor: "#9fe870",
    aliases: ["transferwise", "wise europe", "wise payments"],
    weakAliases: ["wise"],
    bic: "TRWIBEB1",
    ibanBankCodes: ["BE:967"],
  },
];

const BY_SLUG = new Map(INSTITUTIONS.map((def) => [def.slug, def]));

export function getInstitution(slug: string): InstitutionDefinition | undefined {
  return BY_SLUG.get(slug);
}

export interface InstitutionMatch {
  slug: string;
  confidence: number;
  evidence: string;
}

/** Text is capped before matching: detection only needs headers/footers. */
const MAX_MATCH_TEXT = 50_000;

interface CompiledAlias {
  def: InstitutionDefinition;
  alias: string;
  pattern: RegExp;
  weak: boolean;
}

function wordPattern(alias: string): RegExp {
  // Word boundary on letters/digits only, so "n26" matches "N26 Bank" but not "an265".
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(fold(alias))}(?![a-z0-9])`);
}

const COMPILED: CompiledAlias[] = INSTITUTIONS.flatMap((def) => [
  ...def.aliases.map((alias) => ({ def, alias, pattern: wordPattern(alias), weak: false })),
  ...(def.weakAliases ?? []).map((alias) => ({ def, alias, pattern: wordPattern(alias), weak: true })),
]);

const VARIANT_MARKERS = new Map(
  INSTITUTIONS.filter((def) => def.variantOf).map((def) => [def.slug, (def.variantMarkers ?? []).map(wordPattern)]),
);

/**
 * Finds the institution named in a piece of document text (header lines, OFX
 * ORG, file name...). Matching is case- and diacritic-insensitive and requires
 * word boundaries. Callers must not pass transaction descriptions: they often
 * name *other* institutions ("Transferência para Revolut").
 */
export function findInstitutionByText(text: string): InstitutionMatch | undefined {
  if (!text) return undefined;
  const folded = fold(text.slice(0, MAX_MATCH_TEXT));
  let best: { def: InstitutionDefinition; alias: string; confidence: number; index: number } | undefined;
  for (const entry of COMPILED) {
    const m = entry.pattern.exec(folded);
    if (!m) continue;
    // Longer, distinctive aliases are stronger evidence than short/ambiguous ones.
    const confidence = entry.weak ? 0.45 : entry.alias.length >= 6 ? 0.8 : 0.7;
    if (
      !best ||
      confidence > best.confidence ||
      (confidence === best.confidence && entry.alias.length > best.alias.length) ||
      (confidence === best.confidence && entry.alias.length === best.alias.length && m.index < best.index)
    ) {
      best = { def: entry.def, alias: entry.alias, confidence, index: m.index };
    }
  }
  if (!best) return undefined;

  // Prefer a variant (e.g. business account) when its markers are present.
  for (const variant of INSTITUTIONS) {
    if (variant.variantOf !== best.def.slug) continue;
    const marker = VARIANT_MARKERS.get(variant.slug)?.find((p) => p.test(folded));
    if (marker) {
      return {
        slug: variant.slug,
        confidence: Math.min(0.9, best.confidence),
        evidence: `Text mentions "${best.alias}" with a ${variant.name} marker`,
      };
    }
  }
  return { slug: best.def.slug, confidence: best.confidence, evidence: `Text mentions "${best.alias}"` };
}

function normalizeOfxId(value: string): string {
  const trimmed = value.trim().toUpperCase();
  return /^\d+$/.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, "") : trimmed;
}

/**
 * Maps OFX sign-on/account identifiers to an institution: the <ORG> name is
 * matched against aliases, <BANKID>/<FID> against the catalog's numeric ids.
 * Agreement between name and id raises confidence.
 */
export function findInstitutionByOfxId(org?: string, fid?: string, bankId?: string): InstitutionMatch | undefined {
  const byOrg = org ? findInstitutionByText(org) : undefined;
  const findId = (value?: string) => {
    if (!value || !value.trim()) return undefined;
    const id = normalizeOfxId(value);
    return INSTITUTIONS.find((def) => def.ofxIds?.some((candidate) => normalizeOfxId(candidate) === id));
  };
  const byBank = findId(bankId);
  const byFid = findId(fid);

  if (byOrg && (byBank?.slug === byOrg.slug || byFid?.slug === byOrg.slug)) {
    return { slug: byOrg.slug, confidence: 0.95, evidence: `OFX ORG "${org}" and bank id agree` };
  }
  if (byOrg && byOrg.confidence >= 0.7) {
    return { slug: byOrg.slug, confidence: 0.85, evidence: `OFX ORG "${org}"` };
  }
  if (byBank) return { slug: byBank.slug, confidence: 0.8, evidence: `OFX BANKID ${bankId}` };
  if (byFid) return { slug: byFid.slug, confidence: 0.75, evidence: `OFX FID ${fid}` };
  if (byOrg) return { slug: byOrg.slug, confidence: byOrg.confidence, evidence: `OFX ORG "${org}"` };
  return undefined;
}

/** Bank code position inside the BBAN for the countries in the catalog. */
const IBAN_BANK_CODE: Record<string, [number, number]> = {
  IT: [5, 10], // ABI after the CIN letter
  DE: [4, 12], // BLZ
  LT: [4, 9],
  BE: [4, 7],
};

/** Suggests the institution owning an IBAN from its bank code (no network lookups). */
export function findInstitutionByIban(iban: string): InstitutionMatch | undefined {
  const compact = iban.replace(/\s+/g, "").toUpperCase();
  const country = compact.slice(0, 2);
  const range = IBAN_BANK_CODE[country];
  if (!range) return undefined;
  const code = `${country}:${compact.slice(range[0], range[1])}`;
  const def = INSTITUTIONS.find((d) => d.ibanBankCodes?.includes(code));
  return def ? { slug: def.slug, confidence: 0.75, evidence: `IBAN bank code ${code}` } : undefined;
}

const ISSUER_WORD = /(?<![a-z0-9])(banco|banca|bank|banque|caixa|cassa|caja|credito|credit|sparkasse|volksbank|financeira|finanziaria|financial|finance|pagamentos|payments|corretora|investimentos|cooperativa|savings|poste)(?![a-z0-9])/;
const NOT_A_NAME = /(?<![a-z0-9])(saldo|conta|conto|account|extrato|estratto|statement|cliente|customer|titular|titolare|iban|bic|swift|limite|cartao|carta|card|fatura|total|totale)(?![a-z0-9])/;

/**
 * Names the issuer of a statement no catalog entry matches: the first short
 * header phrase that reads like an institution ("Banco Cedro", "Stella Alpina
 * Credito", "Banca Fittizia Aurora S.p.A." before " - Estratto conto"). Callers
 * must not pass transaction text.
 */
export function findIssuerName(text: string): string | undefined {
  for (const line of text.slice(0, MAX_MATCH_TEXT).split("\n")) {
    for (const part of line.split(/\s+[-–—|·•]\s+|[,;:]\s+/)) {
      const name = part.trim();
      const folded = fold(name);
      if (name.length < 5 || name.length > 50 || /\d/.test(name) || name.split(/\s+/).length < 2 || name.split(/\s+/).length > 6) continue;
      if (ISSUER_WORD.test(folded) && !NOT_A_NAME.test(folded)) return name;
    }
  }
  return undefined;
}

/**
 * Finds the statement's own BIC. Only a labelled code counts ("BIC: BBVAITMMXXX",
 * "SWIFT/BIC NTSBDEB1XXX"): any eight capital letters would match otherwise.
 */
export function findBic(text: string): string | undefined {
  const m = /\b(?:BIC|SWIFT)(?:\s*\/\s*(?:BIC|SWIFT))?(?:\s+code)?\s*:?\s*([A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)(?![A-Za-z0-9])/.exec(text.slice(0, MAX_MATCH_TEXT));
  return m?.[1];
}

/** Suggests the institution owning a BIC: bank and country code (first six characters) must match. */
export function findInstitutionByBic(bic: string): InstitutionMatch | undefined {
  const code = bic.trim().toUpperCase();
  const def = INSTITUTIONS.find((d) => d.bic && d.bic.slice(0, 6) === code.slice(0, 6));
  return def ? { slug: def.slug, confidence: 0.9, evidence: `BIC ${code}` } : undefined;
}

/** True when a BIC belongs to another bank than the institution (different four-letter bank code). */
export function bicContradicts(bic: string, slug: string): boolean {
  const own = getInstitution(slug)?.bic;
  return !!own && own.slice(0, 4) !== bic.trim().toUpperCase().slice(0, 4);
}

/** Validates an IBAN checksum (ISO 13616 mod-97). */
export function isValidIban(value: string): boolean {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** Finds the first checksum-valid IBAN in a text. */
export function findIban(text: string): string | undefined {
  const pattern = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/g;
  for (const m of text.slice(0, MAX_MATCH_TEXT).toUpperCase().matchAll(pattern)) {
    const candidate = m[1]!.replace(/\s+/g, "");
    if (isValidIban(candidate)) return candidate;
  }
  return undefined;
}
