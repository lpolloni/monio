/**
 * Tables no profile recognizes (a new bank, headers in unexpected words).
 *
 * 1. A layout this user already imported is read with the column mapping
 *    remembered for its header row — no model involved.
 * 2. Otherwise the columns are inferred when the data itself proves them: a
 *    column that is the running balance of another one.
 * 3. Otherwise a model is shown the header row and a few sample rows and
 *    proposes which column is which. It only points at columns: every date,
 *    description and amount is then read from the file by the same engine as
 *    any other table, and the proposal is rejected unless the columns really
 *    hold dates, text and amounts.
 * 4. A mapping that read the file is remembered for the next one.
 */
import type { DocumentFormat } from "@/domain/import/types";
import { findIban } from "../institution-catalog";
import { tableSignature, type TableRecipe } from "../parsers/layout-memory";
import type { DocumentParseContext, ParserOutput } from "../parsers/types";
import { inferMappingFromBalances, mappingFitsData, parseMapped, type GenericMapping } from "./generic";
import { parseTables } from "./index";
import type { TableData } from "./types";

export const LEARNED_TABLE_PROFILE = "learned-table";
export const AI_TABLE_PROFILE = "ai-table";
export const INFERRED_TABLE_PROFILE = "inferred-table";

const HEADER_SCAN_ROWS = 30;
const SAMPLE_ROWS = 8;
const MAX_ASSIST_COLUMNS = 40;

function unread(output: ParserOutput): boolean {
  return output.statement.accounts.every((a) => !a.transactions.length);
}

interface Candidate {
  table: TableData;
  headerRowIndex: number;
}

/** Rows that may be a header: several named cells, followed by data rows. */
function headerCandidates(tables: TableData[]): Candidate[] {
  const out: Candidate[] = [];
  for (const table of tables) {
    for (let h = 0; h < Math.min(table.rows.length - 1, HEADER_SCAN_ROWS); h++) {
      if (table.rows[h]!.filter((c) => c.trim()).length >= 3) out.push({ table, headerRowIndex: h });
    }
  }
  return out;
}

/** The most likely header among the candidates: text-only cells above the widest run of data rows. */
function likelyHeader(candidates: Candidate[]): Candidate | undefined {
  let best: { candidate: Candidate; score: number } | undefined;
  for (const candidate of candidates) {
    const { table, headerRowIndex } = candidate;
    const header = table.rows[headerRowIndex]!;
    const named = header.filter((c) => c.trim());
    if (named.some((c) => !/\p{L}/u.test(c) || /\d{2}[/.\-]\d{2}/.test(c))) continue;
    const below = table.rows.slice(headerRowIndex + 1, headerRowIndex + 1 + 20).filter((r) => r.some((c) => c.trim()));
    const alike = below.filter((r) => Math.abs(r.filter((c) => c.trim()).length - named.length) <= 2 && r.some((c) => /\d/.test(c))).length;
    const score = alike * named.length;
    if (alike >= 1 && (!best || score > best.score)) best = { candidate, score };
  }
  return best?.candidate;
}

function output(candidate: Candidate, mapping: GenericMapping, format: DocumentFormat, ctx: DocumentParseContext, profile: string): ParserOutput | undefined {
  const { table, headerRowIndex } = candidate;
  if (!mappingFitsData(mapping, table.rows.slice(headerRowIndex + 1))) return undefined;
  const preamble = table.rows.slice(0, headerRowIndex).map((r) => r.filter((c) => c.trim()).join(" ")).filter(Boolean).join("\n");
  const result = parseMapped(table.rows, { ...ctx, headerRowIndex, numericCell: table.numericCell, preamble }, mapping);
  if (!result.accounts.some((a) => a.transactions.length)) return undefined;
  const iban = preamble ? findIban(preamble) : undefined;
  if (iban && result.accounts.length === 1) {
    const account = result.accounts[0]!;
    account.identifier ??= iban;
    account.identifierMask ??= iban.slice(-4);
    account.country ??= iban.slice(0, 2);
  }
  return {
    statement: { format, accounts: result.accounts, warnings: result.warnings, profile },
    institutionText: [table.name, preamble].filter(Boolean).join("\n") || undefined,
  };
}

export async function parseTablesLearning(tables: TableData[], format: DocumentFormat, ctx: DocumentParseContext): Promise<ParserOutput> {
  const known = parseTables(tables, format, ctx);
  if (!unread(known)) return known;
  const candidates = headerCandidates(tables.filter((t) => t.rows.some((r) => r.some((c) => c.trim()))));
  if (!candidates.length) return known;

  if (ctx.layoutMemory) {
    try {
      const remembered = await ctx.layoutMemory.load("table");
      for (const candidate of remembered.size ? candidates : []) {
        const signature = tableSignature(candidate.table.rows[candidate.headerRowIndex]!);
        const recipe = remembered.get(signature);
        if (!recipe) continue;
        const read = output(candidate, recipe, format, ctx, LEARNED_TABLE_PROFILE);
        if (read) return read;
        // Same header wording, different content: relearn it below.
        await ctx.layoutMemory.forget(signature);
      }
    } catch {
      console.warn("[import] Layout memory unavailable; reading without it");
    }
  }

  const candidate = likelyHeader(candidates);
  if (!candidate) return known;
  const data = candidate.table.rows.slice(candidate.headerRowIndex + 1);
  let mapping: GenericMapping | undefined = inferMappingFromBalances(data);
  let read = mapping ? output(candidate, mapping, format, ctx, INFERRED_TABLE_PROFILE) : undefined;
  if (!read && ctx.tableAssist) {
    const headers = candidate.table.rows[candidate.headerRowIndex]!.slice(0, MAX_ASSIST_COLUMNS);
    const rows = data.filter((r) => r.some((c) => c.trim())).slice(0, SAMPLE_ROWS).map((r) => r.slice(0, MAX_ASSIST_COLUMNS));
    try {
      mapping = await ctx.tableAssist({ headers, rows });
    } catch {
      mapping = undefined;
    }
    read = mapping ? output(candidate, mapping, format, ctx, AI_TABLE_PROFILE) : undefined;
    if (!read) known.statement.warnings.push({ code: "ai_rejected_row", message: "AI could not identify the columns of this table; no transactions were imported." });
  }
  if (!read || !mapping) return known;
  if (ctx.layoutMemory) {
    const recipe: TableRecipe = { kind: "table", ...mapping };
    try {
      await ctx.layoutMemory.save(tableSignature(candidate.table.rows[candidate.headerRowIndex]!), recipe);
    } catch {
      console.warn("[import] Layout memory could not be updated");
    }
  }
  return read;
}
