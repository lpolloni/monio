/**
 * Builds XLSX workbooks in memory (exceljs) for parser tests, so spreadsheet
 * fixtures stay readable in code instead of being committed as binaries.
 * All data passed in by tests must be fictional.
 */
import ExcelJS from "exceljs";

export type XlsxCell =
  | string
  | number
  | boolean
  | Date
  | null
  | { formula: string; result: number | string }
  | { richText: { text: string }[] };

export interface XlsxSheetSpec {
  name: string;
  rows: XlsxCell[][];
  /** Optional number format per 1-based column index (e.g. date or "#,##0.00"). */
  numFmt?: Record<number, string>;
  /** Merged ranges such as "A1:E1". */
  merges?: string[];
}

export async function buildXlsx(sheets: XlsxSheetSpec[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Monio tests (synthetic data)";
  for (const spec of sheets) {
    const sheet = workbook.addWorksheet(spec.name);
    spec.rows.forEach((row, r) => {
      row.forEach((value, c) => {
        if (value === null) return;
        const cell = sheet.getCell(r + 1, c + 1);
        cell.value = value as ExcelJS.CellValue;
        const fmt = spec.numFmt?.[c + 1];
        if (fmt) cell.numFmt = fmt;
        else if (value instanceof Date) cell.numFmt = "dd/mm/yyyy";
      });
    });
    for (const range of spec.merges ?? []) sheet.mergeCells(range);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
