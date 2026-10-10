/**
 * Detects the format of an uploaded statement from its content.
 *
 * Order: magic bytes (PDF, ZIP-based XLSX, known binary types that are always
 * rejected) → OFX markers → CSV text sniffing → file extension as a last, weak
 * hint for text content. Anything else (executables, images, archives that are
 * not spreadsheets, legacy .xls) returns null and must be rejected by the caller.
 */
import type { DocumentFormat } from "@/domain/import/types";
import { decodeText, detectDelimiter } from "./parsers/text";

const SNIFF_BYTES = 64 * 1024;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

function indexOfAscii(bytes: Uint8Array, needle: string, from = 0, to = bytes.length): number {
  const codes = Array.from(needle, (c) => c.charCodeAt(0));
  const end = Math.min(to, bytes.length) - codes.length;
  outer: for (let i = from; i <= end; i++) {
    for (let j = 0; j < codes.length; j++) if (bytes[i + j] !== codes[j]) continue outer;
    return i;
  }
  return -1;
}

/** Binary types that are never statements. */
const REJECTED_SIGNATURES: readonly (readonly number[])[] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x52, 0x49, 0x46, 0x46], // RIFF (WebP/WAV/AVI)
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // MZ (Windows PE/EXE/DLL)
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32 LE
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64 LE
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0x00, 0x61, 0x73, 0x6d], // WebAssembly
  [0x1f, 0x8b], // gzip
  [0x42, 0x5a, 0x68], // bzip2
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0xd0, 0xcf, 0x11, 0xe0], // OLE2 (legacy .xls/.doc) — unsupported
  [0x23, 0x21], // "#!" script
];

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

/** An XLSX is a ZIP whose entries include the workbook part. */
function isXlsxZip(bytes: Uint8Array): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return buf.indexOf("xl/workbook.xml", 0, "latin1") >= 0 && buf.indexOf("[Content_Types].xml", 0, "latin1") >= 0;
}

function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename.trim());
  return match ? match[1]!.toLowerCase() : "";
}

/** True when the decoded sample looks like text (no NULs, few control chars). */
function isPlainText(sample: string): boolean {
  if (!sample) return false;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return false;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) control++;
  }
  // Random binary has ~11% C0 controls; a stray control char in a small text file is fine.
  return control / sample.length < 0.05;
}

export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 4096);
  return /^\s*OFXHEADER\s*:/i.test(head) || /<\?OFX[\s?]/i.test(head) || /<OFX>/i.test(head);
}

export function detectFormat(bytes: Uint8Array, filename: string, mimeType?: string): DocumentFormat | null {
  if (bytes.length === 0) return null;
  if (REJECTED_SIGNATURES.some((sig) => startsWith(bytes, sig))) return null;

  // PDF: the header must appear within the first 1024 bytes (PDF 1.7 §7.5.2).
  if (indexOfAscii(bytes, "%PDF-", 0, 1024 + 5) >= 0) return "pdf";

  if (startsWith(bytes, ZIP_SIGNATURE)) return isXlsxZip(bytes) ? "xlsx" : null;

  const { text } = decodeText(bytes.subarray(0, SNIFF_BYTES));
  // A multi-byte character may be cut at the sniff boundary; ignore the tail.
  const sample = bytes.length > SNIFF_BYTES ? text.slice(0, -4) : text;
  if (!isPlainText(sample) || !sample.trim()) return null;

  if (looksLikeOfx(sample)) return "ofx";
  if (detectDelimiter(sample)) return "csv";

  const ext = extensionOf(filename);
  const mime = (mimeType ?? "").toLowerCase();
  if (ext === "csv" || ext === "tsv" || ext === "txt" || mime === "text/csv" || mime === "text/tab-separated-values") {
    return "csv";
  }
  return null;
}
