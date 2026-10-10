import { describe, expect, it } from "vitest";
import { CANONICAL_MIME_TYPES, MAX_FILENAME_CHARS, sanitizeFilename, sha256Hex, storageObjectName, UploadRejectedError, validateUpload } from "./intake";
import { MAX_DOCUMENT_BYTES } from "./parse-document";

const text = (s: string) => new TextEncoder().encode(s);

describe("sanitizeFilename", () => {
  it("drops directories from both path separators", () => {
    expect(sanitizeFilename("../../etc/passwd.csv")).toBe("passwd.csv");
    expect(sanitizeFilename("C:\\Users\\alex\\Downloads\\extrato.ofx")).toBe("extrato.ofx");
    expect(sanitizeFilename("folder/")).toBe("document.bin");
  });

  it("removes control, bidi and zero-width characters and collapses whitespace", () => {
    expect(sanitizeFilename("evil\u202Egnp.csv")).toBe("evilgnp.csv");
    expect(sanitizeFilename("a\u0000b\u0007c\u200B.csv")).toBe("abc.csv");
    expect(sanitizeFilename("  my \t\n statement   march.csv ")).toBe("my statement march.csv");
  });

  it("strips leading dots and keeps unicode letters", () => {
    expect(sanitizeFilename("...hidden.csv")).toBe("hidden.csv");
    expect(sanitizeFilename("extrato março.csv")).toBe("extrato março.csv");
  });

  it("keeps at most 120 characters and the extension", () => {
    const long = `${"a".repeat(300)}.xlsx`;
    const result = sanitizeFilename(long);
    expect([...result]).toHaveLength(MAX_FILENAME_CHARS);
    expect(result.endsWith(".xlsx")).toBe(true);
  });

  it("falls back to a neutral name for the detected format", () => {
    expect(sanitizeFilename("", "pdf")).toBe("document.pdf");
    expect(sanitizeFilename("\u202E\u0000", "csv")).toBe("document.csv");
  });
});

describe("storageObjectName", () => {
  it("produces ASCII-only keys accepted by Storage", () => {
    expect(storageObjectName("extrato março.csv", "csv")).toBe("extrato_marco.csv");
    expect(storageObjectName("a b(1)'s.csv", "csv")).toBe("a_b_1_s.csv");
    expect(storageObjectName("Ω.pdf", "pdf")).toBe("document.pdf");
    expect(storageObjectName("estratto conto", "xlsx")).toBe("estratto_conto.xlsx");
  });

  it("never exceeds the name limit", () => {
    const name = storageObjectName(`${"é".repeat(200)}.csv`, "csv");
    expect(name.length).toBeLessThanOrEqual(MAX_FILENAME_CHARS);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("validateUpload", () => {
  const csv = text("Date,Description,Amount\n2026-03-01,Coffee,-2.50\n");

  it("detects the format from content", () => {
    expect(validateUpload({ bytes: csv, filename: "x.bin", mimeType: "application/octet-stream" }, 1024)).toBe("csv");
  });

  it.each([
    ["empty", new Uint8Array(), 1024],
    ["empty", text(" \r\n\t "), 1024],
    ["too_large", csv, 10],
    ["unsupported", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 1024],
    ["unsupported", new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]), 1024],
  ] as const)("rejects with %s", (code, bytes, max) => {
    const error = (() => {
      try {
        validateUpload({ bytes, filename: "statement.csv", mimeType: "text/csv" }, max);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(UploadRejectedError);
    expect((error as UploadRejectedError).code).toBe(code);
  });

  it("never accepts more than the parser limit, whatever the configured maximum", () => {
    const big = new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(0x41);
    expect(() => validateUpload({ bytes: big, filename: "a.csv" }, Number.MAX_SAFE_INTEGER)).toThrow(UploadRejectedError);
  });
});

describe("intake helpers", () => {
  it("hashes with SHA-256", () => {
    expect(sha256Hex(text("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("stores originals with the bucket's allowed content types", () => {
    expect(Object.values(CANONICAL_MIME_TYPES).sort()).toEqual(
      ["application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/x-ofx", "text/csv"].sort(),
    );
  });
});
