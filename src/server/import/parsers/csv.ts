/**
 * CSV reader: decodes bytes (UTF-8 with Windows-1252 fallback, BOM aware),
 * infers the delimiter (`,` `;` tab `|`), parses quoted fields with papaparse and
 * hands the rows to the profile layer.
 */
import Papa from "papaparse";
import type { ParseContext } from "@/domain/import/types";
import { parseTables } from "../profiles";
import type { TableData } from "../profiles/types";
import { decodeText, detectDelimiter, sanitizeCell, type Delimiter, type TextEncodingName } from "./text";
import type { ParserOutput } from "./types";

/** Hard cap on rows read from a CSV (guards memory before the transaction limit applies). */
export const MAX_CSV_ROWS = 50_000;
const MAX_COLUMNS = 200;

export class CsvTooLargeError extends Error {
  constructor(readonly rows: number) {
    super(`CSV has more than ${rows} rows`);
    this.name = "CsvTooLargeError";
  }
}

export interface CsvRows {
  rows: string[][];
  delimiter: Delimiter;
  encoding: TextEncodingName;
}

export function readCsvRows(bytes: Uint8Array, maxRows = MAX_CSV_ROWS): CsvRows {
  const { text, encoding } = decodeText(bytes);
  const delimiter = detectDelimiter(text)?.delimiter ?? ",";
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    quoteChar: '"',
    skipEmptyLines: false,
    // Read one row more than allowed so an oversized file is detected, not truncated.
    preview: maxRows + 1,
  });
  if (parsed.data.length > maxRows) throw new CsvTooLargeError(maxRows);
  const rows = parsed.data.map((row) =>
    (Array.isArray(row) ? row : []).slice(0, MAX_COLUMNS).map((cell) => sanitizeCell(String(cell ?? "")).trim()),
  );
  // Drop the trailing empty row produced by a final newline.
  while (rows.length && rows[rows.length - 1]!.every((c) => !c)) rows.pop();
  return { rows, delimiter, encoding };
}

export function parseCsv(bytes: Uint8Array, ctx: ParseContext = {}): ParserOutput {
  const { rows } = readCsvRows(bytes);
  const table: TableData = { rows };
  return parseTables([table], "csv", ctx);
}
