import { z } from "zod";
import { aiError } from "../result";
import { requestJson } from "./http";
import type { AiProvider, ProviderHealth, ProviderRequest, ProviderResponse, ProviderRuntime } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

export interface AnthropicOptions extends ProviderRuntime {
  /** API origin, e.g. "https://api.anthropic.com" (a trailing "/v1" is tolerated). */
  baseUrl: string;
  apiKey: string;
  model: string;
}

const MessagesResponseSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullish(),
});

/** Minimal Anthropic Messages API adapter. Always a cloud provider; no tools. */
export function createAnthropicProvider(options: AnthropicOptions): AiProvider {
  const root = options.baseUrl.replace(/\/v1$/, "");
  const headers = {
    "content-type": "application/json",
    "x-api-key": options.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };

  return {
    id: "anthropic",
    model: options.model,
    location: "cloud",

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const outcome = await requestJson(
        `${root}/v1/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: options.model,
            max_tokens: MAX_TOKENS,
            temperature: 0,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
          }),
        },
        request.task === "interpret_document" && request.timeoutMs ? { ...options, timeoutMs: Math.min(options.timeoutMs, request.timeoutMs) } : options,
      );
      if (!outcome.ok) return { ok: false, error: outcome.error };
      const parsed = MessagesResponseSchema.safeParse(outcome.body);
      if (!parsed.success) {
        return { ok: false, error: aiError("malformed_output", "The provider response has no content blocks.") };
      }
      const text = parsed.data.content.find((block) => block.type === "text")?.text ?? "";
      if (!text.trim()) {
        const truncated = parsed.data.stop_reason === "max_tokens";
        return {
          ok: false,
          error: aiError("malformed_output", truncated ? "The model ran out of tokens." : "The model returned no text.", truncated),
        };
      }
      return { ok: true, text };
    },

    async health(): Promise<ProviderHealth> {
      const started = options.now();
      const outcome = await requestJson(`${root}/v1/models`, { method: "GET", headers }, options);
      const latencyMs = Math.max(0, Math.round(options.now() - started));
      return outcome.ok ? { ok: true, latencyMs } : { ok: false, latencyMs, error: outcome.error.message };
    },
  };
}
