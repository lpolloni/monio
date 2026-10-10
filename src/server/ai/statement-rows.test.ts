import { describe, expect, it } from "vitest";
import { createAiService } from "./service";
import { amountAppearsInLine, dateAppearsInLine, findDescriptionInLine, validateStatementRows } from "./statement-validation";
import { MOCK_CONFIG, OMLX_CONFIG, chatResponse, fakeFetch, payloadOf } from "./test-utils";

describe("amountAppearsInLine", () => {
  it.each([
    ["1234.56", "05/03/2026 ALUGUEL 1.234,56"],
    ["1234.56", "03/05/2026 RENT 1,234.56"],
    ["1234.56", "05.03.2026 AFFITTO 1234,56"],
    ["1234.56", "2026-03-05 RENT 1234.56"],
    ["1234.56", "05/03 RENT 1'234.56"],
    ["39.9", "05/03 NETFLIX 39,90"],
    ["39.90", "05/03 NETFLIX R$ 39,90"],
    ["-39.9", "05/03 NETFLIX -39,90"],
    ["-39.9", "05/03 NETFLIX R$ -39,90"],
    ["-39.9", "05/03 NETFLIX 39,90-"],
    ["-39.9", "05/03 NETFLIX 39,90 D"],
    ["-39.9", "05/03 NETFLIX (39,90)"],
    ["39.9", "05/03 ESTORNO NETFLIX 39,90 C"],
    ["1.234", "05/03 BTC 1,234"],
  ])("finds %s in %j", (amount, line) => {
    expect(amountAppearsInLine(amount, line)).toBe("match");
  });

  it("rejects invented or misread amounts", () => {
    expect(amountAppearsInLine("99999", "05/03/2026 PADARIA 12,50")).toBe("absent");
    expect(amountAppearsInLine("1250", "05/03/2026 PADARIA 12,50")).toBe("absent");
    expect(amountAppearsInLine("12.5", "05/03/2026 PADARIA 125,00")).toBe("absent");
    // Digits of the date are not an amount.
    expect(amountAppearsInLine("2026", "05/03/2026 PADARIA 12,50")).toBe("absent");
    expect(amountAppearsInLine("5", "05/03/2026 PADARIA 12,50")).toBe("absent");
    // Digits glued to letters (codes such as F24, A2A, NSU123) are not amounts.
    expect(amountAppearsInLine("24", "05/03/2026 F24 12,50")).toBe("absent");
  });

  it("checks the sign", () => {
    expect(amountAppearsInLine("-12.5", "05/03/2026 PADARIA 12,50")).toBe("sign_mismatch");
    expect(amountAppearsInLine("12.5", "05/03/2026 PADARIA -12,50")).toBe("sign_mismatch");
    expect(amountAppearsInLine("12.5", "05/03/2026 PADARIA 12,50 D")).toBe("sign_mismatch");
  });
});

describe("dateAppearsInLine", () => {
  it("accepts any reading of a date written in the line", () => {
    expect(dateAppearsInLine("2026-03-05", "05/03/2026 PADARIA 12,50")).toBe(true);
    expect(dateAppearsInLine("2026-05-03", "05/03/2026 PADARIA 12,50")).toBe(true); // MDY reading
    expect(dateAppearsInLine("2026-03-05", "05.03.26 PADARIA 12,50")).toBe(true);
    expect(dateAppearsInLine("2026-03-05", "2026-03-05 PADARIA 12,50")).toBe(true);
    expect(dateAppearsInLine("2026-03-05", "05 MAR 2026 PADARIA 12,50")).toBe(true);
    expect(dateAppearsInLine("2026-03-05", "5 de março de 2026 PADARIA 12,50")).toBe(true);
    expect(dateAppearsInLine("2026-05-05", "05-mag-2026 ESSELUNGA 12,50")).toBe(true);
    expect(dateAppearsInLine("2026-03-05", "Mar 5, 2026 STARBUCKS 4.50")).toBe(true);
  });

  it("day/month without year uses the year hint ± 1", () => {
    expect(dateAppearsInLine("2026-03-05", "05/03 PADARIA 12,50", 2026)).toBe(true);
    expect(dateAppearsInLine("2025-12-30", "30/12 PADARIA 12,50", 2026)).toBe(true);
    expect(dateAppearsInLine("2019-03-05", "05/03 PADARIA 12,50", 2026)).toBe(false);
    expect(dateAppearsInLine("2026-03-05", "05 MAR PADARIA 12,50", 2026)).toBe(true);
  });

  it("rejects dates that are not in the line", () => {
    expect(dateAppearsInLine("2026-03-06", "05/03/2026 PADARIA 12,50")).toBe(false);
    expect(dateAppearsInLine("2026-03-05", "PADARIA 12,50")).toBe(false);
    // An amount such as 12.05 is not a date.
    expect(dateAppearsInLine("2026-05-12", "PADARIA 12.05", 2026)).toBe(false);
  });
});

describe("findDescriptionInLine", () => {
  it("is case-insensitive and whitespace-normalized, returning the line's own text", () => {
    expect(findDescriptionInLine("padaria  real", "05/03/2026 PADARIA   REAL 12,50")).toBe("PADARIA REAL");
    expect(findDescriptionInLine("Pão de Açúcar", "05/03 PÃO DE AÇÚCAR 50,00")).toBe("PÃO DE AÇÚCAR");
    expect(findDescriptionInLine("PADARIA IDEAL", "05/03/2026 PADARIA REAL 12,50")).toBeNull();
    expect(findDescriptionInLine("a.*", "05/03 abc 1,00")).toBeNull(); // regex metacharacters are literal
  });
});

describe("validateStatementRows", () => {
  const lines = new Map([
    [10, "05/03/2026 PADARIA REAL -12,50"],
    [11, "06/03/2026 SALARIO ACME 5.000,00 C"],
    [12, "07/03/2026 TARIFA 9,90 D"],
  ]);

  it("accepts literal rows and canonicalizes amount/description from the line", () => {
    const { accepted, rejected } = validateStatementRows(
      [
        { line: 11, date: "2026-03-06", description: "salario acme", amount: "5000.00" },
        { line: 10, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.50", currency: "BRL" },
      ],
      { lines, currencyHint: "BRL" },
    );
    expect(rejected).toEqual([]);
    expect(accepted).toEqual([
      { line: 10, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.5", currency: "BRL" },
      { line: 11, date: "2026-03-06", description: "SALARIO ACME", amount: "5000" },
    ]);
  });

  it.each([
    [{ line: 10, date: "2026-03-05", description: "PADARIA REAL", amount: "-99999" }, "amount_not_in_line"],
    [{ line: 10, date: "2026-03-05", description: "PADARIA REAL", amount: "12.50" }, "sign_mismatch"],
    [{ line: 99, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.50" }, "line_not_requested"],
    [{ line: 10, date: "2026-03-05", description: "PADARIA DO JOAO", amount: "-12.50" }, "description_not_in_line"],
    [{ line: 10, date: "2026-04-05", description: "PADARIA REAL", amount: "-12.50" }, "date_not_in_line"],
    [{ line: 10, date: "2026-02-30", description: "PADARIA REAL", amount: "-12.50" }, "invalid_date"],
    [{ line: 10, date: "2026-03-05", description: "PADARIA REAL", amount: "-12,50" }, "schema_invalid"],
    [{ line: 10, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.50", balance: "100" }, "schema_invalid"],
    [{ line: 10, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.50", currency: "USD" }, "currency_not_in_line"],
    [{ line: 12, date: "2026-03-07", description: "TARIFA", amount: "9.90" }, "sign_mismatch"],
  ])("rejects %o → %s", (proposal, reason) => {
    const { accepted, rejected } = validateStatementRows([proposal], { lines });
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([expect.objectContaining({ reason })]);
  });

  it("rejects every proposal for a line proposed twice", () => {
    const p = { line: 10, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.50" };
    const { accepted, rejected } = validateStatementRows([p, { ...p, description: "PADARIA" }], { lines });
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["ambiguous_line", "ambiguous_line"]);
  });
});

describe("proposeStatementRows through the service", () => {
  const LINES = [
    { line: 1, text: "EXTRATO DE CONTA - MARÇO 2026" },
    { line: 2, text: "05/03/2026 PADARIA REAL -12,50" },
    { line: 3, text: "06/03/2026 UBER *TRIP 23,90 D" },
    { line: 4, text: "SALDO FINAL 1.234,56" },
  ];

  it("mock proposals pass the same validation", async () => {
    const result = await createAiService(MOCK_CONFIG).proposeStatementRows(LINES, { currencyHint: "BRL", yearHint: 2026 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { line: 2, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.5" },
      { line: 3, date: "2026-03-06", description: "UBER *TRIP", amount: "-23.9" },
    ]);
    expect(result.meta).toMatchObject({ provider: "mock", confidenceIsCalibrated: false });
    expect(result.meta.rejected).toBeUndefined();
  });

  it("keeps verified rows from a model and rejects invented ones", async () => {
    const answer = {
      rows: [
        { line: 2, date: "2026-03-05", description: "PADARIA REAL", amount: "-12.50" },
        { line: 3, date: "2026-03-06", description: "UBER *TRIP", amount: "-2390" },
        { line: 4, date: "2026-03-31", description: "SALDO FINAL", amount: "1234.56" },
        { line: 7, date: "2026-03-07", description: "PIX", amount: "-50.00" },
        { line: 2, extra: true },
      ],
    };
    const { fetchImpl, calls } = fakeFetch(() => chatResponse(JSON.stringify(answer)));
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).proposeStatementRows(LINES, { yearHint: 2026 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
    expect(result.meta.rejected?.map((r) => [r.line, r.reason])).toEqual([
      [2, "schema_invalid"],
      [2, "ambiguous_line"],
      [3, "amount_not_in_line"],
      [4, "date_not_in_line"],
      [7, "line_not_requested"],
    ]);
    expect(payloadOf(calls[0]!)).toEqual({ lines: LINES.map((l) => ({ line: l.line, text: l.text })), year_hint: 2026 });
  });

  it("enforces document limits (≤ 200 lines, ≤ 24k chars) and batches lines", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ line: i + 1, text: `05/03/2026 LINE ${i + 1} 1,00` }));
    const { fetchImpl, calls } = fakeFetch(() => chatResponse('{"rows":[]}'));
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).proposeStatementRows(many);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sent = calls.flatMap((c) => payloadOf(c).lines ?? []);
    expect(sent).toHaveLength(200);
    expect(calls.length).toBe(5);
    expect(result.meta.skippedLines).toEqual(many.slice(200).map((l) => l.line));

    const long = Array.from({ length: 40 }, (_, i) => ({ line: i + 1, text: "X".repeat(5000) }));
    const r2 = await createAiService(OMLX_CONFIG, { fetchImpl }).proposeStatementRows(long);
    expect(r2.ok && r2.meta.skippedLines?.length).toBe(16); // 24 lines × 1000 chars fit
  });

  it("a non-envelope answer fails with schema_invalid", async () => {
    const { fetchImpl } = fakeFetch(() => chatResponse('{"transactions":[]}'));
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).proposeStatementRows(LINES);
    expect(result).toMatchObject({ ok: false, error: { code: "schema_invalid" } });
  });

  it("rejects duplicate line numbers as invalid input", async () => {
    const result = await createAiService(MOCK_CONFIG).proposeStatementRows([
      { line: 1, text: "a" },
      { line: 1, text: "b" },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
