import { z } from "zod";
import { DocumentProposalSchema } from "../document-contract";
import { aiError } from "../result";
import { requestJson } from "./http";
import type { AiProvider, ProviderHealth, ProviderRequest, ProviderResponse, ProviderRuntime } from "./types";

export interface OpenAiCompatibleOptions extends ProviderRuntime {
  id: "omlx" | "openai" | "openrouter" | "generic";
  location: "local" | "cloud";
  /** e.g. "http://192.168.68.115:8000/v1" or "https://api.openai.com/v1" (no trailing slash). */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** OpenRouter attribution headers (optional). */
  appTitle?: string;
  appUrl?: string;
}

const ContentPart = z.looseObject({ type: z.string().optional(), text: z.string().optional() });
const ChatCompletionSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
});

const ModelsListSchema = z.looseObject({ data: z.array(z.looseObject({ id: z.string() })) });

/** Mentions of an unsupported `response_format` in a 400 body (llama.cpp, mlx servers, older vLLM...). */
const RESPONSE_FORMAT_REJECTED = /response_format|json_object|json[ _]mode/i;

/**
 * OpenAI Chat Completions adapter, used for oMLX (local) and for the
 * openai / openrouter / generic cloud flavors. No tools are ever declared.
 */
export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): AiProvider {
  const { baseUrl, apiKey, model, id, location } = options;
  // Remembered per provider instance once a server rejected response_format.
  let useResponseFormat = true;

  function headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (apiKey) h.authorization = `Bearer ${apiKey}`;
    if (id === "openrouter") {
      h["x-title"] = options.appTitle ?? "Monio";
      if (options.appUrl) h["http-referer"] = options.appUrl;
    }
    return h;
  }

  function body(request: ProviderRequest, withResponseFormat: boolean): string {
    return JSON.stringify({
      model,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      temperature: 0,
      ...(id === "omlx" && request.task === "interpret_document" && { enable_thinking: false, max_tokens: 6000 }),
      // A column mapping is a dozen tokens: reasoning only makes a local model miss the timeout.
      ...(id === "omlx" && request.task === "map_table_columns" && { enable_thinking: false, max_tokens: 200 }),
      ...(withResponseFormat && { response_format: id === "omlx" && request.task === "interpret_document"
        ? { type: "json_schema", json_schema: { name: "statement_document", strict: true, schema: z.toJSONSchema(DocumentProposalSchema) } }
        : { type: "json_object" } }),
    });
  }

  return {
    id,
    model,
    location,

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const url = `${baseUrl}/chat/completions`;
      const runtime = request.task === "interpret_document" && request.timeoutMs ? { ...options, timeoutMs: Math.min(options.timeoutMs, request.timeoutMs) } : options;
      let outcome = await requestJson(url, { method: "POST", headers: headers(), body: body(request, useResponseFormat) }, runtime);
      if (
        !outcome.ok &&
        useResponseFormat &&
        (outcome.error.status === 400 || outcome.error.status === 422) &&
        RESPONSE_FORMAT_REJECTED.test(outcome.bodyText ?? "")
      ) {
        useResponseFormat = false;
        outcome = await requestJson(url, { method: "POST", headers: headers(), body: body(request, false) }, runtime);
      }
      if (!outcome.ok) return { ok: false, error: outcome.error };

      const parsed = ChatCompletionSchema.safeParse(outcome.body);
      if (!parsed.success) {
        return { ok: false, error: aiError("malformed_output", "The provider response has no choices[0].message.") };
      }
      const choice = parsed.data.choices[0]!;
      const content = choice.message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((p) => (p.type === undefined || p.type === "text" ? (p.text ?? "") : "")).join("")
            : "";
      if (!text.trim()) {
        const truncated = choice.finish_reason === "length";
        return {
          ok: false,
          error: aiError(
            "malformed_output",
            truncated ? "The model ran out of tokens before answering." : "The model returned no content.",
            truncated,
          ),
        };
      }
      return { ok: true, text };
    },

    async health(): Promise<ProviderHealth> {
      const started = options.now();
      const outcome = await requestJson(`${baseUrl}/models`, { method: "GET", headers: headers() }, options);
      const latencyMs = Math.max(0, Math.round(options.now() - started));
      if (!outcome.ok) return { ok: false, latencyMs, error: outcome.error.message };
      const list = ModelsListSchema.safeParse(outcome.body);
      if (!list.success) return { ok: true, latencyMs };
      const modelAvailable = list.data.data.some((m) => m.id === model);
      return modelAvailable
        ? { ok: true, latencyMs, modelAvailable }
        : { ok: false, latencyMs, modelAvailable, error: `Model "${model}" is not listed by the server.` };
    },
  };
}
