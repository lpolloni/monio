/**
 * Profile registry and selection for tabular documents (CSV / XLSX).
 *
 * Every candidate header row in the first rows of every table (preamble lines
 * are allowed above it) is scored by every profile; the best score wins. When
 * the best score is shared by several specific profiles, or by a specific
 * profile and the generic one, the generic profile is used — an ambiguous
 * signature must not silently pick one bank's conventions.
 */
import type { DocumentFormat, ParseContext } from "@/domain/import/types";
import { findIban } from "../institution-catalog";
import type { ParserOutput } from "../parsers/types";
import { bbvaItalyProfile } from "./bbva-it";
import { genericProfile } from "./generic";
import { mpsProfile } from "./mps";
import { n26Profile } from "./n26";
import { nubankAccountProfile, nubankCardProfile, nubankPjProfile } from "./nubank";
import { revolutProfile } from "./revolut";
import { santanderBrProfile } from "./santander-br";
import type { StatementProfile, TableData } from "./types";
import { xpProfile } from "./xp";

export type { StatementProfile, TableData } from "./types";

export const PROFILES: readonly StatementProfile[] = [
  nubankAccountProfile,
  nubankPjProfile,
  nubankCardProfile,
  n26Profile,
  revolutProfile,
  bbvaItalyProfile,
  mpsProfile,
  xpProfile,
  santanderBrProfile,
  genericProfile,
];

/** Header rows are searched within the first rows only (preamble allowance). */
const HEADER_SCAN_ROWS = 30;
const SAMPLE_ROWS = 20;

export interface ProfileChoice {
  profile: StatementProfile;
  table: TableData;
  headerRowIndex: number;
  score: number;
}

function sampleAfter(rows: string[][], start: number): string[][] {
  const out: string[][] = [];
  for (let i = start; i < rows.length && out.length < SAMPLE_ROWS; i++) {
    const row = rows[i]!;
    if (row.some((c) => c.trim())) out.push(row);
  }
  return out;
}

function preambleText(rows: string[][], headerRowIndex: number): string {
  return rows
    .slice(0, headerRowIndex)
    .map((r) => r.filter((c) => c.trim()).join(" "))
    .filter(Boolean)
    .join("\n");
}

export function chooseProfile(
  tables: TableData[],
  hints: { filename?: string } = {},
  profiles: readonly StatementProfile[] = PROFILES,
): ProfileChoice | undefined {
  const bestByProfile = new Map<string, ProfileChoice>();
  for (const table of tables) {
    const limit = Math.min(table.rows.length, HEADER_SCAN_ROWS);
    for (let h = 0; h < limit; h++) {
      const headers = table.rows[h]!;
      if (headers.filter((c) => c.trim()).length < 2) continue;
      const sample = sampleAfter(table.rows, h + 1);
      const preamble = preambleText(table.rows, h);
      for (const profile of profiles) {
        const score = profile.matches(headers, sample, { filename: hints.filename, preamble });
        const current = bestByProfile.get(profile.id);
        if (score > 0 && (!current || score > current.score)) {
          bestByProfile.set(profile.id, { profile, table, headerRowIndex: h, score });
        }
      }
    }
  }
  const choices = [...bestByProfile.values()];
  if (!choices.length) return undefined;
  const top = Math.max(...choices.map((c) => c.score));
  const leaders = choices.filter((c) => Math.abs(c.score - top) < 1e-9);
  const generic = bestByProfile.get(genericProfile.id);
  if (leaders.length > 1) {
    return generic ?? { ...leaders[0]!, profile: genericProfile };
  }
  return leaders[0];
}

/** Parses already-read tables (CSV rows or spreadsheet sheets) with the best profile. */
export function parseTables(tables: TableData[], format: DocumentFormat, ctx: ParseContext): ParserOutput {
  const nonEmpty = tables.filter((t) => t.rows.some((r) => r.some((c) => c.trim())));
  const choice = chooseProfile(nonEmpty, { filename: ctx.filename });
  if (!choice) {
    return {
      statement: {
        format,
        accounts: [],
        warnings: [
          {
            code: "unsupported_layout",
            message: "No header row with recognizable columns was found; no transactions were imported.",
          },
        ],
        profile: genericProfile.id,
      },
      institutionText: nonEmpty[0] ? preambleText(nonEmpty[0].rows, Math.min(nonEmpty[0].rows.length, 10)) : undefined,
    };
  }

  const { profile, table, headerRowIndex } = choice;
  const preamble = preambleText(table.rows, headerRowIndex);
  const result = profile.parse(table.rows, {
    ...ctx,
    headerRowIndex,
    numericCell: table.numericCell,
    preamble,
  });

  const iban = preamble ? findIban(preamble) : undefined;
  if (iban && result.accounts.length === 1) {
    const account = result.accounts[0]!;
    account.identifier ??= iban;
    account.identifierMask ??= iban.slice(-4);
    account.country ??= iban.slice(0, 2);
  }

  return {
    statement: { format, accounts: result.accounts, warnings: result.warnings, profile: profile.id },
    institutionText: [table.name, preamble].filter(Boolean).join("\n") || undefined,
    profileInstitution: profile.institutionSlug
      ? {
          slug: profile.institutionSlug,
          weak: profile.weakInstitutionSignal === true,
          evidence: `${format.toUpperCase()} header signature: ${profile.label}`,
        }
      : undefined,
  };
}
