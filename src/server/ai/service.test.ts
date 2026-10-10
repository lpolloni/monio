import { describe, expect, it } from "vitest";
import type { AiConfig } from "./config";
import { aiConfigFromEnv } from "./config";
import type { TransactionInterpretationInput } from "./schemas";
import { createAiService } from "./service";
import { MOCK_CONFIG, OMLX_CONFIG, chatResponse, fakeFetch, item, jsonResponse, payloadOf } from "./test-utils";

function txs(n: number): TransactionInterpretationInput[] {
  return Array.from({ length: n }, (_, i) => ({ id: `id-${i + 1}`, description: `ESSELUNGA ${i + 1}`, amount: "-10.00", currency: "EUR" }));
}

/** A fake model that answers every transaction of every batch correctly. */
function echoModel(status: (batchIndex: number) => number = () => 200) {
  return fakeFetch((call, index) => {
    const code = status(index);
    if (code !== 200) return jsonResponse({ error: { message: "boom" } }, code);
    const wire = payloadOf(call).transactions ?? [];
    return chatResponse(JSON.stringify({ items: wire.map((t) => item(String(t.id), { merchant: "Esselunga", category: "groceries", recurring_candidate: false })) }));
  });
}

describe("disabled & misconfigured", () => {
  it("disabled mode returns typed errors and never touches the network", async () => {
    const { fetchImpl, calls } = fakeFetch(() => chatResponse("{}"));
    const service = createAiService(aiConfigFromEnv({ AI_PROVIDER: "disabled" }), { fetchImpl });
    expect(service.mode).toBe("disabled");
    const r1 = await service.interpretTransactions(txs(1));
    const r2 = await service.proposeStatementRows([{ line: 1, text: "05/03/2026 X 1,00" }]);
    expect(r1).toMatchObject({ ok: false, error: { code: "disabled", retryable: false }, meta: { provider: "disabled", confidenceIsCalibrated: false } });
    expect(r2).toMatchObject({ ok: false, error: { code: "disabled" } });
    expect(await service.health()).toMatchObject({ ok: false, mode: "disabled" });
    expect(calls).toHaveLength(0);
  });

  it("an invalid env configuration resolves to disabled with its reason", async () => {
    const service = createAiService(aiConfigFromEnv({ AI_PROVIDER: "omlx", AI_BASE_URL: "https://api.openai.com/v1", AI_MODEL: "m" }));
    const result = await service.interpretTransactions(txs(1));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("disabled");
      expect(result.error.message).toMatch(/local/);
    }
  });
});

describe("cloud gating", () => {
  const cloud: AiConfig = {
    mode: "cloud",
    cloudFlavor: "openai",
    apiKey: "sk-secret",
    model: "gpt-test",
    timeoutMs: 2_000,
    allowCloudDocuments: false,
  };

  it("refuses to send transactions or document lines to the cloud without authorization", async () => {
    const { fetchImpl, calls } = fakeFetch(() => chatResponse("{}"));
    const service = createAiService(cloud, { fetchImpl });
    const r1 = await service.interpretTransactions(txs(3));
    const r2 = await service.proposeStatementRows([{ line: 1, text: "05/03/2026 PADARIA 12,50" }]);
    expect(r1).toMatchObject({ ok: false, error: { code: "cloud_not_authorized", retryable: false }, meta: { provider: "openai" } });
    expect(r2).toMatchObject({ ok: false, error: { code: "cloud_not_authorized" } });
    expect(calls).toHaveLength(0);
  });

  it("calls the cloud once authorized", async () => {
    const { fetchImpl, calls } = echoModel();
    const result = await createAiService({ ...cloud, allowCloudDocuments: true }, { fetchImpl }).interpretTransactions(txs(2));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("health checks do not send financial data and are allowed", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ data: [{ id: "gpt-test" }] }));
    const health = await createAiService(cloud, { fetchImpl }).health();
    expect(health.ok).toBe(true);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();
  });

  it("never falls back from a failing local provider to the cloud", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ error: "down" }, 503));
    const service = createAiService(
      { ...OMLX_CONFIG, apiKey: undefined, cloudFlavor: "openai", allowCloudDocuments: true },
      { fetchImpl },
    );
    const result = await service.interpretTransactions(txs(1));
    expect(result).toMatchObject({ ok: false, error: { code: "http_error" } });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["192.168.68.115:8000"]);
  });
});

describe("batching", () => {
  it("splits into batches of 25 and merges results in input order", async () => {
    const { fetchImpl, calls } = echoModel();
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(txs(60));
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => payloadOf(c).transactions?.length)).toEqual([25, 25, 10]);
    expect(payloadOf(calls[1]!).transactions?.[0]?.id).toBe("t1"); // aliases restart per batch
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((d) => d.id)).toEqual(txs(60).map((t) => t.id));
    expect(result.meta).toMatchObject({ batches: 3, confidenceIsCalibrated: false });
    expect(result.meta.failedIds).toBeUndefined();
  });

  it("a failed batch yields a partial result with failedIds", async () => {
    const { fetchImpl } = echoModel((i) => (i === 1 ? 500 : 200));
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(txs(60));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(35);
    expect(result.meta.failedIds).toEqual(txs(60).slice(25, 50).map((t) => t.id));
    expect(result.meta.notes).toEqual([expect.objectContaining({ code: "batch_failed" })]);
  });

  it("when every batch fails the result is ok:false", async () => {
    const { fetchImpl } = echoModel(() => 502);
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(txs(30));
    expect(result).toMatchObject({ ok: false, error: { code: "http_error", retryable: true }, meta: { batches: 2 } });
    if (!result.ok) expect(result.meta.failedIds).toHaveLength(30);
  });

  it("empty input → ok with no provider call", async () => {
    const { fetchImpl, calls } = echoModel();
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions([]);
    expect(result).toMatchObject({ ok: true, data: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("input validation", () => {
  const service = createAiService(MOCK_CONFIG);

  it("rejects duplicate ids and non-decimal amounts without echoing values", async () => {
    const dup = await service.interpretTransactions([
      { id: "a", description: "X", amount: "-1", currency: "EUR" },
      { id: "a", description: "Y", amount: "-2", currency: "EUR" },
    ]);
    expect(dup).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const bad = await service.interpretTransactions([{ id: "a", description: "SECRET DESC", amount: "1.234,56", currency: "EUR" }]);
    expect(bad).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    if (!bad.ok) {
      expect(bad.error.message).not.toContain("SECRET");
      expect(bad.error.message).not.toContain("1.234,56");
    }
  });

  it("strips unknown input fields so they never reach the model", async () => {
    const { fetchImpl, calls } = echoModel();
    const row = { id: "a", description: "ESSELUNGA", amount: "-1", currency: "eur", iban: "IT60X0542811101000000123456", userId: "u-1" };
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions([row]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("IT60X0542811101000000123456");
    expect(payloadOf(calls[0]!).transactions?.[0]).toEqual({ id: "t1", description: "ESSELUNGA", amount: "-1", currency: "EUR", direction: "out" });
  });
});

describe("mock failure simulation", () => {
  it.each([
    ["timeout", "timeout", true],
    ["error", "http_error", true],
    ["malformed", "malformed_output", false],
    ["schema_invalid", "schema_invalid", false],
  ] as const)("mockBehavior=%s → %s", async (behavior, code, retryable) => {
    const service = createAiService({ ...MOCK_CONFIG, mockBehavior: behavior });
    const r1 = await service.interpretTransactions(txs(2));
    expect(r1).toMatchObject({ ok: false, error: { code, retryable }, meta: { provider: "mock", confidenceIsCalibrated: false } });
    const r2 = await service.proposeStatementRows([{ line: 1, text: "05/03/2026 PADARIA 12,50" }]);
    expect(r2).toMatchObject({ ok: false, error: { code } });
    expect((await service.health()).ok).toBe(false);
  });

  it("the mock is healthy by default", async () => {
    expect(await createAiService(MOCK_CONFIG).health()).toEqual({ ok: true, mode: "mock", provider: "mock", model: "monio-mock-v1", latencyMs: 0 });
  });

  it("failure modes are not triggered by user data", async () => {
    const result = await createAiService(MOCK_CONFIG).interpretTransactions([
      { id: "a", description: "timeout malformed error schema_invalid", amount: "-1", currency: "EUR" },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe("latency metadata", () => {
  it("uses the injected clock", async () => {
    let t = 0;
    const { fetchImpl } = fakeFetch((call) => {
      t += 250;
      const wire = payloadOf(call).transactions ?? [];
      return chatResponse(JSON.stringify({ items: wire.map((w) => item(String(w.id))) }));
    });
    const result = await createAiService(OMLX_CONFIG, { fetchImpl, now: () => t }).interpretTransactions(txs(30));
    expect(result.meta.latencyMs).toBe(500);
  });
});
