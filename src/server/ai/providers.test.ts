import { describe, expect, it } from "vitest";
import type { AiConfig } from "./config";
import { INTERPRET_SYSTEM_PROMPT } from "./prompts";
import type { TransactionInterpretationInput } from "./schemas";
import { createAiService } from "./service";
import {
  OMLX_CONFIG,
  anthropicResponse,
  chatResponse,
  fakeFetch,
  hangingFetch,
  item,
  jsonResponse,
  payloadOf,
  systemOf,
  userOf,
} from "./test-utils";

const TXS: TransactionInterpretationInput[] = [
  { id: "db-uuid-1", description: "PAG*NETFLIX", amount: "-39.90", currency: "BRL", date: "2026-03-05" },
  { id: "db-uuid-2", description: "ESSELUNGA SPA", amount: "-64.30", currency: "EUR", country: "it" },
];

const GOOD = JSON.stringify({
  items: [
    item("t1"),
    item("t2", { merchant: "Esselunga", category: "groceries", recurring_candidate: false, confidence: 0.8 }),
  ],
});

describe("OpenAI-compatible provider (oMLX)", () => {
  it("sends a well-formed chat completion and returns validated interpretations", async () => {
    const { fetchImpl, calls } = fakeFetch(() => chatResponse(GOOD));
    const service = createAiService({ ...OMLX_CONFIG, apiKey: "local-key" }, { fetchImpl });
    const result = await service.interpretTransactions(TXS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([
      { id: "db-uuid-1", merchant: "Netflix", category: "subscriptions", recurring_candidate: true, transfer_candidate: false, confidence: 0.9, reasoning_code: "model" },
      { id: "db-uuid-2", merchant: "Esselunga", category: "groceries", recurring_candidate: false, transfer_candidate: false, confidence: 0.8, reasoning_code: "model" },
    ]);
    expect(result.meta).toMatchObject({ provider: "omlx", model: "Qwen3.5-9B-MLX-4bit", confidenceIsCalibrated: false });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://192.168.68.115:8000/v1/chat/completions");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe("Bearer local-key");
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.body).toMatchObject({ model: "Qwen3.5-9B-MLX-4bit", temperature: 0, response_format: { type: "json_object" } });
    expect(call.body).not.toHaveProperty("tools");
    expect(systemOf(call)).toBe(INTERPRET_SYSTEM_PROMPT);
    // Caller ids never leave the server; the model sees per-batch aliases.
    expect(JSON.stringify(call.body)).not.toContain("db-uuid");
    expect(payloadOf(call).transactions).toEqual([
      { id: "t1", description: "PAG*NETFLIX", amount: "-39.90", currency: "BRL", direction: "out", date: "2026-03-05" },
      { id: "t2", description: "ESSELUNGA SPA", amount: "-64.30", currency: "EUR", direction: "out", country: "IT" },
    ]);
  });

  it("omits Authorization without an API key", async () => {
    const { fetchImpl, calls } = fakeFetch(() => chatResponse(GOOD));
    await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it.each([
    ["```json fences", "```json\n" + GOOD + "\n```"],
    ["bare fences", "```\n" + GOOD + "\n```"],
    ["a <think> prefix", "<think>\nThe user wants labels. Netflix is a {subscription}.\n</think>\n\n" + GOOD],
    ["a closing </think> only", "reasoning... </think>" + GOOD],
    ["think + fences + prose", "<think>ok</think>Here you go:\n```json\n" + GOOD + "\n```\nHope it helps!"],
  ])("tolerates %s", async (_label, content) => {
    const { fetchImpl } = fakeFetch(() => chatResponse(content));
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map((d) => d.category)).toEqual(["subscriptions", "groceries"]);
  });

  it.each([
    ["prose only", "I cannot help with that."],
    ["truncated JSON", '{"items":[{"id":"t1","merchant":"Netf'],
    ["unterminated <think>", "<think>let me think about {items}"],
    ["empty content", ""],
  ])("malformed output (%s) → malformed_output", async (_label, content) => {
    const { fetchImpl } = fakeFetch(() => chatResponse(content));
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("malformed_output");
      expect(result.meta.failedIds).toEqual(["db-uuid-1", "db-uuid-2"]);
    }
  });

  it("an HTTP body without choices → malformed_output", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ object: "list" }));
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
    expect(result).toMatchObject({ ok: false, error: { code: "malformed_output" } });
  });

  describe("schema validation", () => {
    it("a bare array or extra top-level keys fail the batch with schema_invalid", async () => {
      for (const content of [JSON.stringify([item("t1"), item("t2")]), JSON.stringify({ items: [item("t1"), item("t2")], total: "99999" })]) {
        const { fetchImpl } = fakeFetch(() => chatResponse(content));
        const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
        expect(result).toMatchObject({ ok: false, error: { code: "schema_invalid", retryable: false } });
      }
    });

    it("an unknown category is nulled for that item only, with a note", async () => {
      const content = JSON.stringify({ items: [item("t1", { category: "streaming_services" }), item("t2", { category: "groceries" })] });
      const { fetchImpl } = fakeFetch(() => chatResponse(content));
      const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data[0]).toMatchObject({ id: "db-uuid-1", merchant: "Netflix", category: null });
      expect(result.data[1]).toMatchObject({ id: "db-uuid-2", category: "groceries" });
      expect(result.meta.notes).toEqual([expect.objectContaining({ id: "db-uuid-1", code: "unknown_category" })]);
      expect(result.meta.failedIds).toBeUndefined();
    });

    it("an item with an extra amount field is rejected; the rest is kept", async () => {
      const content = JSON.stringify({ items: [item("t1", { amount: "-99999" }), item("t2", { category: "groceries" })] });
      const { fetchImpl } = fakeFetch(() => chatResponse(content));
      const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.map((d) => d.id)).toEqual(["db-uuid-2"]);
      expect(result.data[0]).not.toHaveProperty("amount");
      expect(result.meta.failedIds).toEqual(["db-uuid-1"]);
      expect(result.meta.notes).toEqual([expect.objectContaining({ id: "db-uuid-1", code: "item_schema_invalid" })]);
      expect(result.meta.notes?.[0]?.message).toMatch(/amount/);
    });

    it.each([
      ["confidence > 1", { confidence: 1.5 }],
      ["string confidence", { confidence: "high" }],
      ["merchant too long", { merchant: "M".repeat(81) }],
      ["missing flag", { recurring_candidate: undefined }],
      ["unknown reasoning code", { reasoning_code: "fixture_match_trust_me" }],
    ])("rejects an item with %s", async (_label, overrides) => {
      const content = JSON.stringify({ items: [item("t1", overrides), item("t2")] });
      const { fetchImpl } = fakeFetch(() => chatResponse(content));
      const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.meta.failedIds).toEqual(["db-uuid-1"]);
    });

    it("wrong ids: all unknown → schema_invalid; partially unknown → missing reported", async () => {
      const allWrong = JSON.stringify({ items: [item("db-uuid-1"), item("t9")] });
      const r1 = await createAiService(OMLX_CONFIG, { fetchImpl: fakeFetch(() => chatResponse(allWrong)).fetchImpl }).interpretTransactions(TXS);
      expect(r1).toMatchObject({ ok: false, error: { code: "schema_invalid" } });
      if (!r1.ok) {
        expect(r1.meta.failedIds).toEqual(["db-uuid-1", "db-uuid-2"]);
        expect(r1.meta.notes?.map((n) => n.code)).toEqual(["unknown_id", "unknown_id", "missing", "missing"]);
      }

      const partial = JSON.stringify({ items: [item("t1"), item("t3")] });
      const r2 = await createAiService(OMLX_CONFIG, { fetchImpl: fakeFetch(() => chatResponse(partial)).fetchImpl }).interpretTransactions(TXS);
      expect(r2.ok).toBe(true);
      if (r2.ok) {
        expect(r2.data.map((d) => d.id)).toEqual(["db-uuid-1"]);
        expect(r2.meta.failedIds).toEqual(["db-uuid-2"]);
        expect(r2.meta.notes).toEqual([
          expect.objectContaining({ code: "unknown_id" }),
          expect.objectContaining({ id: "db-uuid-2", code: "missing" }),
        ]);
      }
    });

    it("duplicate answers for one id reject that id", async () => {
      const content = JSON.stringify({ items: [item("t1"), item("t1", { category: "salary" }), item("t2")] });
      const { fetchImpl } = fakeFetch(() => chatResponse(content));
      const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.map((d) => d.id)).toEqual(["db-uuid-2"]);
        expect(result.meta.notes).toEqual([expect.objectContaining({ id: "db-uuid-1", code: "duplicate_id" })]);
      }
    });

    it("a category contradicting the direction is nulled", async () => {
      const content = JSON.stringify({ items: [item("t1", { category: "salary" }), item("t2", { category: "groceries" })] });
      const { fetchImpl } = fakeFetch(() => chatResponse(content));
      const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
      expect(result.ok && result.data[0]?.category).toBe(null);
      if (result.ok) expect(result.meta.notes?.[0]?.code).toBe("category_direction_mismatch");
    });

    it("a model cannot claim deterministic provenance", async () => {
      const content = JSON.stringify({ items: [item("t1", { reasoning_code: "fixture_match" }), item("t2")] });
      const { fetchImpl } = fakeFetch(() => chatResponse(content));
      const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
      expect(result.ok && result.data.every((d) => d.reasoning_code === "model")).toBe(true);
    });
  });

  describe("transport errors", () => {
    it("HTTP 500 → http_error, retryable", async () => {
      const { fetchImpl } = fakeFetch(() => jsonResponse({ error: { message: "model crashed" } }, 500));
      const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
      expect(result).toMatchObject({ ok: false, error: { code: "http_error", retryable: true, status: 500 } });
      if (!result.ok) expect(result.error.message).toContain("model crashed");
    });

    it("HTTP 429 → retryable; HTTP 401 / 404 → not retryable", async () => {
      for (const [status, retryable] of [[429, true], [401, false], [404, false]] as const) {
        const { fetchImpl } = fakeFetch(() => jsonResponse({ error: "nope" }, status));
        const result = await createAiService({ ...OMLX_CONFIG, apiKey: "secret-key-123" }, { fetchImpl }).interpretTransactions(TXS);
        expect(result).toMatchObject({ ok: false, error: { code: "http_error", retryable, status } });
        if (!result.ok) expect(result.error.message).not.toContain("secret-key-123");
      }
    });

    it("network failure → network_error, retryable", async () => {
      const fetchImpl = (async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
      }) as unknown as typeof fetch;
      const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
      expect(result).toMatchObject({ ok: false, error: { code: "network_error", retryable: true } });
      if (!result.ok) expect(result.error.message).toContain("ECONNREFUSED");
    });

    it("a never-answering server → timeout (signal aborted)", async () => {
      const hanging = hangingFetch();
      const started = Date.now();
      const result = await createAiService({ ...OMLX_CONFIG, timeoutMs: 30 }, { fetchImpl: hanging.fetchImpl }).interpretTransactions(TXS);
      expect(result).toMatchObject({ ok: false, error: { code: "timeout", retryable: true } });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(hanging.calls).toBe(1);
    });

    it("even a fetch that ignores the abort signal cannot hang the service", async () => {
      const fetchImpl = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
      const result = await createAiService({ ...OMLX_CONFIG, timeoutMs: 30 }, { fetchImpl }).interpretTransactions(TXS);
      expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    });
  });

  it("retries once without response_format when the server rejects it, then remembers", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.body && "response_format" in call.body
        ? jsonResponse({ error: { message: "Unsupported parameter: response_format" } }, 400)
        : chatResponse(GOOD),
    );
    const service = createAiService(OMLX_CONFIG, { fetchImpl });
    const first = await service.interpretTransactions(TXS);
    expect(first.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toHaveProperty("response_format");
    expect(calls[1]!.body).not.toHaveProperty("response_format");

    const second = await service.interpretTransactions(TXS);
    expect(second.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.body).not.toHaveProperty("response_format");
  });

  it("does not retry other 400 errors", async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse({ error: { message: "context length exceeded" } }, 400));
    const result = await createAiService(OMLX_CONFIG, { fetchImpl }).interpretTransactions(TXS);
    expect(result).toMatchObject({ ok: false, error: { code: "http_error", retryable: false, status: 400 } });
    expect(calls).toHaveLength(1);
  });

  it("health lists models and measures latency", async () => {
    let t = 1_000;
    const { fetchImpl, calls } = fakeFetch(() => {
      t += 42;
      return jsonResponse({ object: "list", data: [{ id: "Qwen3.5-9B-MLX-4bit" }, { id: "other" }] });
    });
    const health = await createAiService(OMLX_CONFIG, { fetchImpl, now: () => t }).health();
    expect(health).toEqual({ ok: true, mode: "omlx", provider: "omlx", model: "Qwen3.5-9B-MLX-4bit", latencyMs: 42, modelAvailable: true });
    expect(calls[0]!.url).toBe("http://192.168.68.115:8000/v1/models");

    const missing = fakeFetch(() => jsonResponse({ data: [{ id: "llama" }] }));
    const h2 = await createAiService(OMLX_CONFIG, { fetchImpl: missing.fetchImpl }).health();
    expect(h2).toMatchObject({ ok: false, modelAvailable: false, error: expect.stringContaining("not listed") });

    const down = await createAiService({ ...OMLX_CONFIG, timeoutMs: 30 }, { fetchImpl: hangingFetch().fetchImpl }).health();
    expect(down.ok).toBe(false);
  });
});

describe("cloud flavors", () => {
  const cloud = (flavor: AiConfig["cloudFlavor"], extra: Partial<AiConfig> = {}): AiConfig => ({
    mode: "cloud",
    cloudFlavor: flavor,
    apiKey: "sk-cloud-secret",
    model: "some-model",
    timeoutMs: 2_000,
    allowCloudDocuments: true,
    ...extra,
  });

  it("openrouter adds attribution headers and uses the default base URL", async () => {
    const { fetchImpl, calls } = fakeFetch(() => chatResponse(GOOD));
    const result = await createAiService(cloud("openrouter"), { fetchImpl }).interpretTransactions(TXS);
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[0]!.headers["x-title"]).toBe("Monio");
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-cloud-secret");
    if (result.ok) expect(result.meta.provider).toBe("openrouter");
  });

  it("anthropic adapter happy path", async () => {
    const { fetchImpl, calls } = fakeFetch(() => anthropicResponse(GOOD));
    const result = await createAiService(cloud("anthropic", { model: "claude-test" }), { fetchImpl }).interpretTransactions(TXS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((d) => d.id)).toEqual(["db-uuid-1", "db-uuid-2"]);
      expect(result.meta).toMatchObject({ provider: "anthropic", model: "claude-test", confidenceIsCalibrated: false });
    }
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-cloud-secret");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({ model: "claude-test", system: INTERPRET_SYSTEM_PROMPT, temperature: 0 });
    expect(typeof call.body?.max_tokens).toBe("number");
    expect(call.body?.messages).toEqual([{ role: "user", content: expect.stringContaining("<<<DATA") }]);
    expect(userOf(call)).toContain("PAG*NETFLIX");
  });

  it("anthropic: tolerates a custom base URL ending in /v1 and validates the same way", async () => {
    const bad = JSON.stringify({ items: [item("t1", { amount: "1" }), item("t2", { category: "made_up" })] });
    const { fetchImpl, calls } = fakeFetch(() => anthropicResponse(bad));
    const result = await createAiService(cloud("anthropic", { baseUrl: "https://proxy.example.com/v1" }), { fetchImpl }).interpretTransactions(TXS);
    expect(calls[0]!.url).toBe("https://proxy.example.com/v1/messages");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([expect.objectContaining({ id: "db-uuid-2", category: null })]);
      expect(result.meta.failedIds).toEqual(["db-uuid-1"]);
    }
  });

  it("anthropic HTTP errors are typed", async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529));
    const result = await createAiService(cloud("anthropic"), { fetchImpl }).interpretTransactions(TXS);
    expect(result).toMatchObject({ ok: false, error: { code: "http_error", retryable: true, status: 529 } });
  });
});
