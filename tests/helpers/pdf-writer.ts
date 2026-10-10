/**
 * Tiny dependency-free PDF writer for tests: produces a valid PDF 1.4 with one
 * or more A4 pages of Helvetica text (WinAnsi encoding), so text extraction
 * (unpdf / pdf.js) can be exercised on synthetic statements.
 *
 * A page is a list of lines; a line is either a string (drawn at the left
 * margin) or a list of `{ x, text }` items drawn on the same baseline (to
 * simulate column layouts).
 */

export type PdfLineSpec = string | { x: number; text: string }[];

export interface PdfWriterOptions {
  fontSize?: number;
  lineHeight?: number;
  marginLeft?: number;
  marginTop?: number;
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

/** Windows-1252 code points for the non-Latin-1 characters a statement may need. */
const CP1252: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "„": 0x84, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
};

/** Encodes a JS string as a PDF literal string body in WinAnsi, escaping as needed. */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = CP1252[ch] ?? ch.codePointAt(0)!;
    if (code > 0xff) {
      out += "?";
    } else if (ch === "(" || ch === ")" || ch === "\\") {
      out += `\\${ch}`;
    } else if (code < 0x20 || code > 0x7e) {
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function buildPdf(pages: PdfLineSpec[][], options: PdfWriterOptions = {}): Uint8Array {
  const fontSize = options.fontSize ?? 9;
  const lineHeight = options.lineHeight ?? 14;
  const marginLeft = options.marginLeft ?? 40;
  const marginTop = options.marginTop ?? 50;

  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // object number
  };
  const catalogId = add(""); // placeholder, filled below
  const pagesId = add("");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");

  const pageIds: number[] = [];
  for (const lines of pages) {
    let content = "";
    lines.forEach((line, i) => {
      const y = PAGE_HEIGHT - marginTop - i * lineHeight;
      const items = typeof line === "string" ? [{ x: marginLeft, text: line }] : line;
      for (const item of items) {
        if (!item.text) continue;
        content += `BT /F1 ${fontSize} Tf 1 0 0 1 ${fmt(item.x)} ${fmt(y)} Tm (${pdfString(item.text)}) Tj ET\n`;
      }
    });
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  // Everything above is ASCII (non-ASCII text is octal-escaped), so string length = byte length.
  let pdf = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
