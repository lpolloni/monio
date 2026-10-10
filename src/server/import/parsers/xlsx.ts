/**
 * XLSX reader (exceljs). Every sheet with data becomes a table; the profile
 * layer picks the sheet/header row that best matches a known layout.
 *
 * Cell conversion: Date cells -> ISO date via parseDate (calendar date as
 * stored, no timezone shift), numeric cells -> canonical decimal strings via
 * parseAmount (marked as numeric so locale separators are never re-applied),
 * rich text / hyperlinks / formula results -> their text.
 *
 * Before handing the archive to exceljs, the ZIP central directory is checked
 * so that a tiny "zip bomb" cannot expand into gigabytes in memory.
 */
import ExcelJS from "exceljs";
import { parseAmount } from "@/domain/import/parse-amount";
import { parseDate } from "@/domain/import/parse-date";
import type { ParseContext } from "@/domain/import/types";
import { parseTables } from "../profiles";
import type { TableData } from "../profiles/types";
import { sanitizeCell } from "./text";
import type { ParserOutput } from "./types";

export const MAX_XLSX_ROWS = 50_000;
const MAX_COLUMNS = 200;
const MAX_SHEETS = 20;
const MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 5_000;

export class XlsxRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxRejectedError";
  }
}

/** Reads the ZIP central directory and rejects archives that would expand too much. */
export function assertZipWithinLimits(bytes: Uint8Array, maxUncompressed = MAX_UNCOMPRESSED_BYTES): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxRejectedError("Not a valid XLSX archive (no central directory).");
  const entries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw new XlsxRejectedError("ZIP64 archives are not supported.");
  if (entries > MAX_ZIP_ENTRIES) throw new XlsxRejectedError("XLSX archive has too many entries.");
  let offset = cdOffset;
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new XlsxRejectedError("Corrupted XLSX central directory.");
    }
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw new XlsxRejectedError("ZIP64 archives are not supported.");
    }
    total += uncompressed;
    if (total > maxUncompressed) throw new XlsxRejectedError("XLSX expands beyond the allowed size.");
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
}

/** Spreadsheet number -> canonical decimal string (float noise past 15 digits removed). */
function numberToDecimal(value: number): string {
  if (!Number.isFinite(value)) return "";
  const clean = Number(value.toPrecision(15));
  // String() switches to exponent notation outside this range; such values are not money.
  if (clean !== 0 && (Math.abs(clean) < 1e-6 || Math.abs(clean) >= 1e21)) return "";
  return parseAmount(clean)?.amount ?? "";
}

type CellText = { text: string; numeric: boolean };

function convertValue(value: unknown, depth = 0): CellText {
  if (value === null || value === undefined || depth > 3) return { text: "", numeric: false };
  if (typeof value === "number") {
    const text = numberToDecimal(value);
    return { text, numeric: text !== "" };
  }
  if (typeof value === "string") return { text: value, numeric: false };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", numeric: false };
  if (value instanceof Date) return { text: parseDate(value) ?? "", numeric: false };
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return {
        text: obj.richText.map((part) => (part && typeof part === "object" ? String((part as { text?: unknown }).text ?? "") : "")).join(""),
        numeric: false,
      };
    }
    if ("error" in obj) return { text: "", numeric: false };
    if ("formula" in obj || "sharedFormula" in obj) return convertValue(obj.result, depth + 1);
    if ("text" in obj) return convertValue(obj.text, depth + 1);
  }
  return { text: "", numeric: false };
}

export async function readXlsxTables(bytes: Uint8Array): Promise<TableData[]> {
  assertZipWithinLimits(bytes);
  const workbook = new ExcelJS.Workbook();
  // exceljs' types predate Node's generic Buffer; the runtime only needs bytes.
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const tables: TableData[] = [];
  for (const sheet of workbook.worksheets.slice(0, MAX_SHEETS)) {
    const rows: string[][] = [];
    const numeric = new Set<number>();
    let tooLarge = false;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > MAX_XLSX_ROWS) {
        tooLarge = true;
        return;
      }
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber > MAX_COLUMNS) return;
        // Merged ranges repeat the master value in every cell; keep it once.
        const isSlave = cell.isMerged && cell.master && cell.master.address !== cell.address;
        const { text, numeric: isNumber } = isSlave ? { text: "", numeric: false } : convertValue(cell.value);
        while (cells.length < colNumber - 1) cells.push("");
        cells[colNumber - 1] = sanitizeCell(text).trim();
        if (isNumber) numeric.add((rowNumber - 1) * MAX_COLUMNS + (colNumber - 1));
      });
      while (rows.length < rowNumber - 1) rows.push([]);
      rows[rowNumber - 1] = cells;
    });
    if (tooLarge) throw new XlsxRejectedError(`Sheet "${sheet.name}" has more than ${MAX_XLSX_ROWS} rows.`);
    if (rows.some((r) => r.some((c) => c))) {
      tables.push({
        name: sanitizeCell(sheet.name, 100),
        rows,
        numericCell: (r, c) => numeric.has(r * MAX_COLUMNS + c),
      });
    }
  }
  return tables;
}

export async function parseXlsx(bytes: Uint8Array, ctx: ParseContext = {}): Promise<ParserOutput> {
  const tables = await readXlsxTables(bytes);
  return parseTables(tables, "xlsx", ctx);
}
