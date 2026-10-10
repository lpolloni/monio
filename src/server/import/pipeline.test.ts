import { describe, expect, it, vi } from "vitest";
import type { ParseWarning } from "@/domain/import/types";
import type { AiService } from "../ai";
import { UploadRejectedError } from "./intake";
import { DocumentLimitError, EmptyDocumentError, UnsupportedDocumentError } from "./parse-document";
import {
  balanceSnapshots,
  deriveAccountName,
  describeError,
  IMPORT_STAGES,
  ImportJobError,
  incompleteLineCount,
  isBusinessVariant,
  isStaleProcessing,
  pdfAiAssist,
  SAFE_ERROR_MESSAGES,
  STAGE_PROGRESS,
  STALE_PROCESSING_MS,
  stageProgress,
  toImportErrorCode,
} from "./pipeline";

describe("stages and progress", () => {
  it("uses exactly the stage names the UI translates, in order", () => {
    expect(IMPORT_STAGES).toEqual([
      "validating",
      "stored",
      "detecting",
      "identifying",
      "extracting",
      "normalizing",
      "deduplicating",
      "categorizing",
      "reconciling",
      "recurring",
      "persisting",
      "completed",
    ]);
  });

  it("reports strictly increasing progress from received (0) to completed (100)", () => {
    const values = ["received", ...IMPORT_STAGES].map((s) => stageProgress(s));
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(100);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    expect(Object.keys(STAGE_PROGRESS)).toHaveLength(IMPORT_STAGES.length + 1);
  });

  it("maps unknown stages to 0", () => {
    expect(stageProgress("nope")).toBe(0);
  });
});

describe("error mapping", () => {
  it.each([
    [new UploadRejectedError("too_large"), "too_large"],
    [new UploadRejectedError("unsupported"), "unsupported"],
    [new EmptyDocumentError(), "empty"],
    [new DocumentLimitError("The document has more than 20000 transactions."), "limit"],
    [new UnsupportedDocumentError("The PDF file could not be read."), "unreadable"],
    [new ImportJobError("unreadable"), "unreadable"],
    [new ImportJobError("unsupported"), "unsupported"],
    [new Error("boom"), "internal"],
    [{ code: "23505", message: "duplicate key value" }, "internal"],
    ["string error", "internal"],
    [null, "internal"],
  ] as const)("maps %o to %s", (error, code) => {
    expect(toImportErrorCode(error)).toBe(code);
  });

  it("stores short, fixed messages only", () => {
    for (const message of Object.values(SAFE_ERROR_MESSAGES)) expect(message.length).toBeLessThanOrEqual(500);
    expect(new ImportJobError("empty").message).toBe(SAFE_ERROR_MESSAGES.empty);
  });

  it("describes errors for logs without their messages", () => {
    expect(describeError(new Error("row: 2026-03-01 Salary 2500.00"))).toBe("Error");
    expect(describeError(Object.assign(new Error("Key (fingerprint)=(abc) exists"), { name: "PostgrestError", code: "23505" }))).toBe("PostgrestError (23505)");
    expect(describeError({ code: "not a code; DROP" })).toBe("object");
    expect(describeError("text")).toBe("string");
  });
});

describe("isStaleProcessing", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  it("treats jobs older than the threshold (or without a start) as stale", () => {
    expect(isStaleProcessing(null, now)).toBe(true);
    expect(isStaleProcessing("garbage", now)).toBe(true);
    expect(isStaleProcessing(new Date(now - STALE_PROCESSING_MS - 1000).toISOString(), now)).toBe(true);
    expect(isStaleProcessing(new Date(now - 5 * 60 * 1000).toISOString(), now)).toBe(false);
  });
});

describe("incompleteLineCount", () => {
  const w = (code: ParseWarning["code"], row?: number): ParseWarning => ({ code, message: "x", ...(row !== undefined ? { row } : {}) });

  it("counts distinct rows plus document-level warnings, ignoring informational codes", () => {
    const warnings = [w("row_unreadable", 4), w("missing_amount", 4), w("missing_date", 9), w("ambiguous_date_order"), w("empty_document")];
    expect(incompleteLineCount(warnings)).toBe(3);
  });

  it("adds rows skipped by the pipeline", () => {
    expect(incompleteLineCount([w("unknown_currency", 3)], [3, 5, 6])).toBe(3);
    expect(incompleteLineCount([])).toBe(0);
  });
});

describe("isBusinessVariant", () => {
  it("recognises business variants by institution slug or parser profile", () => {
    expect(isBusinessVariant("nubank-pj")).toBe(true);
    expect(isBusinessVariant(undefined, "nubank-pj")).toBe(true);
    expect(isBusinessVariant("nubank", "nubank-account")).toBe(false);
    expect(isBusinessVariant("santander-br", "generic")).toBe(false);
    expect(isBusinessVariant(null, null)).toBe(false);
  });
});

describe("deriveAccountName", () => {
  it("prefixes parsed names with the institution unless already present", () => {
    expect(deriveAccountName({ institutionName: "Revolut", parsedName: "Current EUR", type: "checking", locale: "en" })).toBe("Revolut Current EUR");
    expect(deriveAccountName({ institutionName: "N26", parsedName: "N26 Main", type: "checking", locale: "en" })).toBe("N26 Main");
  });

  it("uses the localized type label otherwise", () => {
    expect(deriveAccountName({ institutionName: "Nubank", type: "credit_card", locale: "pt" })).toBe("Nubank Cartão de crédito");
    expect(deriveAccountName({ institutionName: "Monte dei Paschi di Siena", type: "checking", locale: "it" })).toBe("Monte dei Paschi di Siena Conto corrente");
    expect(deriveAccountName({ institutionName: "XP Investimentos", type: "investment", locale: "pt" })).toBe("XP Investimentos");
    expect(deriveAccountName({ type: "savings", locale: "xx" })).toBe("Savings");
    expect(deriveAccountName({ hintName: "BANCO EXEMPLO", type: "checking", locale: "en" })).toBe("BANCO EXEMPLO Checking");
  });

  it("is capped at 120 characters", () => {
    expect([...deriveAccountName({ parsedName: "x".repeat(400), type: "other", locale: "en" })]).toHaveLength(120);
  });
});

describe("balanceSnapshots", () => {
  it("moves an opening balance dated on the first transaction day to the previous day", () => {
    expect(
      balanceSnapshots({ openingBalance: { amount: "0", asOf: "2026-03-01" }, closingBalance: { amount: "622.51", asOf: "2026-03-08" } }, "2026-03-01"),
    ).toEqual([
      { asOf: "2026-02-28", amount: "0" },
      { asOf: "2026-03-08", amount: "622.51" },
    ]);
  });

  it("keeps opening balances dated before the first transaction", () => {
    expect(balanceSnapshots({ openingBalance: { amount: "1500", asOf: "2026-02-28" } }, "2026-03-02")).toEqual([{ asOf: "2026-02-28", amount: "1500" }]);
    expect(balanceSnapshots({ openingBalance: { amount: "10", asOf: "2026-03-05" } })).toEqual([{ asOf: "2026-03-05", amount: "10" }]);
  });

  it("lets the closing balance win on the same date and skips invalid values", () => {
    expect(
      balanceSnapshots({ openingBalance: { amount: "5", asOf: "2026-03-04" }, closingBalance: { amount: "108", asOf: "2026-03-03" } }, "2026-03-04"),
    ).toEqual([{ asOf: "2026-03-03", amount: "108" }]);
    expect(balanceSnapshots({ closingBalance: { amount: "1,00", asOf: "2026-03-03" } })).toEqual([]);
    expect(balanceSnapshots({ closingBalance: { amount: "1.00", asOf: "03/03/2026" } })).toEqual([]);
  });
});

describe("pdfAiAssist", () => {
  const lines = [{ line: 7, text: "03/03 PADARIA 12,50" }];

  function fakeAi(result: Awaited<ReturnType<AiService["proposeStatementRows"]>>): AiService {
    return { proposeStatementRows: vi.fn(async () => result) } as unknown as AiService;
  }

  it("maps validated proposals to parser rows", async () => {
    const used = vi.fn();
    const ai = fakeAi({
      ok: true,
      data: [{ line: 7, date: "2026-03-03", description: "PADARIA", amount: "-12.50" }],
      meta: { provider: "mock", latencyMs: 1, confidenceIsCalibrated: false },
    });
    await expect(pdfAiAssist(ai, used)(lines)).resolves.toEqual([{ line: 7, date: "2026-03-03", description: "PADARIA", amount: "-12.50" }]);
    expect(used).toHaveBeenCalledOnce();
  });

  it("returns no rows when the AI call fails", async () => {
    const ai = fakeAi({
      ok: false,
      error: { code: "timeout", message: "timed out", retryable: true },
      meta: { provider: "mock", latencyMs: 1, confidenceIsCalibrated: false },
    });
    await expect(pdfAiAssist(ai)(lines)).resolves.toEqual([]);
  });
});
