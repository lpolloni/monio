/**
 * Layout memory: what was learned the first time a file of an unknown layout
 * was interpreted, so the next file with the same structure is read
 * deterministically, without a model.
 *
 * A recipe only says WHERE things are (column indexes, column positions) —
 * never what they contain. Signatures are hashes of the header wording; apart
 * from the issuer's name of a learned PDF layout, no document text, account
 * identifier or amount is stored. A recipe is not
 * trusted blindly either: every file it reads goes through the same column
 * and balance checks as any other file.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeHeader } from "./text";

const column = z.number().int().min(0).max(199);

/** Column mapping of a CSV/XLSX export, learned for one header row. */
export const TableRecipeSchema = z.strictObject({
  kind: z.literal("table"),
  date: column,
  valueDate: column.optional(),
  description: column,
  counterparty: column.optional(),
  amount: column.optional(),
  debit: column.optional(),
  credit: column.optional(),
  currency: column.optional(),
  balance: column.optional(),
  id: column.optional(),
  status: column.optional(),
});
export type TableRecipe = z.infer<typeof TableRecipeSchema>;

const edge = z.number().finite().min(-10_000).max(100_000);

/** Column positions of a PDF table whose header row no keyword list recognizes. */
export const PdfTableRecipeSchema = z.strictObject({
  kind: z.literal("pdf-table"),
  columns: z.array(z.strictObject({
    role: z.enum(["date", "valueDate", "description", "amount", "debit", "credit", "balance"]),
    left: edge,
    right: edge,
  })).min(2).max(12),
  /** Issuer named by the statement's own header/footer when the layout was learned (a bank name, never a holder). */
  issuer: z.string().trim().min(1).max(120).optional(),
});
export type PdfTableRecipe = z.infer<typeof PdfTableRecipeSchema>;

export const LayoutRecipeSchema = z.discriminatedUnion("kind", [TableRecipeSchema, PdfTableRecipeSchema]);
export type LayoutRecipe = z.infer<typeof LayoutRecipeSchema>;
export type LayoutKind = LayoutRecipe["kind"];

export interface LayoutMemory {
  /** Recipes this user's imports have learned, by signature. */
  load<K extends LayoutKind>(kind: K): Promise<Map<string, Extract<LayoutRecipe, { kind: K }>>>;
  save(signature: string, recipe: LayoutRecipe): Promise<void>;
  /** A recipe that no longer reads its layout cleanly is dropped and relearned. */
  forget(signature: string): Promise<void>;
}

function signature(kind: LayoutKind, parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([kind, ...parts])).digest("hex");
}

/** Signature of a CSV/XLSX header row: its column names, in order. */
export function tableSignature(headers: readonly string[]): string {
  const cells = headers.map(normalizeHeader);
  while (cells.length && !cells.at(-1)) cells.pop();
  return signature("table", cells);
}

/** Signature of a PDF table header line: its cell texts, digits aside. */
export function pdfHeaderSignature(cells: readonly string[]): string {
  return signature("pdf-table", cells.map((c) => normalizeHeader(c).replace(/\d+/g, "#")));
}
