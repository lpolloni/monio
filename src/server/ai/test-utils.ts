/**
 * Test helpers for the AI service (fake fetch, canned provider answers).
 * Not used by production code.
 */
import type { AiConfig } from "./config";
import { DATA_CLOSE, DATA_OPEN } from "./prompts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON request body (undefined for GET). */
  body: Record<string, unknown> | undefined;
  signal: AbortSignal | undefined;
}

export type FakeHandler = (call: RecordedCall, index: number) => Response | Promise<Response>;

/** A fetch implementation that records every call and answers with `handler`. */
export function fakeFetch(handler: FakeHandler): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch that never answers but rejects with AbortError when its signal aborts. */
export function hangingFetch(): { fetchImpl: typeof fetch; calls: number } {
  const state = { calls: 0 };
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => {
    state.calls++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** OpenAI Chat Completions response carrying `content`. */
export function chatResponse(content: string): Response {
  return jsonResponse({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

/** Anthropic Messages API response carrying `text`. */
export function anthropicResponse(text: string): Response {
  return jsonResponse({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  });
}

/** Extracts the delimited JSON payload from a recorded chat request. */
export function payloadOf(call: RecordedCall): { transactions?: Array<Record<string, unknown>>; lines?: Array<{ line: number; text: string }> } {
  const messages = (call.body?.messages ?? []) as Array<{ role: string; content: string }>;
  const user = messages.find((m) => m.role === "user")?.content ?? "";
  const start = user.indexOf(`${DATA_OPEN}\n`);
  const end = user.lastIndexOf(`\n${DATA_CLOSE}`);
  return JSON.parse(user.slice(start + DATA_OPEN.length + 1, end)) as ReturnType<typeof payloadOf>;
}

export function systemOf(call: RecordedCall): string {
  const body = call.body ?? {};
  if (typeof body.system === "string") return body.system;
  const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === "system")?.content ?? "";
}

export function userOf(call: RecordedCall): string {
  const messages = (call.body?.messages ?? []) as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === "user")?.content ?? "";
}

/** A well-formed interpretation item for wire id `id`. */
export function item(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    merchant: "Netflix",
    category: "subscriptions",
    recurring_candidate: true,
    transfer_candidate: false,
    confidence: 0.9,
    ...overrides,
  };
}

export const OMLX_CONFIG: AiConfig = {
  mode: "omlx",
  baseUrl: "http://192.168.68.115:8000/v1",
  model: "Qwen3.5-9B-MLX-4bit",
  timeoutMs: 2_000,
  allowCloudDocuments: false,
};

export const MOCK_CONFIG: AiConfig = { mode: "mock", timeoutMs: 2_000, allowCloudDocuments: false };
