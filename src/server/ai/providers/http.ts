import { aiError, type AiError } from "../result";
import { sanitizeUntrustedText } from "../sanitize";
import type { ProviderRuntime } from "./types";

export type HttpOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; error: AiError; /** Truncated raw body of an HTTP error, for retry decisions. */ bodyText?: string };

const TIMED_OUT = Symbol("timed-out");

/**
 * fetch with a hard timeout (AbortController + race, so even a fetch
 * implementation that ignores the signal cannot hang the caller) and typed
 * errors. Never throws.
 */
export async function requestJson(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  runtime: ProviderRuntime,
): Promise<HttpOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, runtime.timeoutMs);
  });
  const timeoutError = () =>
    aiError("timeout", `The AI provider did not answer within ${runtime.timeoutMs} ms.`, true);

  try {
    const attempt = (async () => {
      const res = await runtime.fetchImpl(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { res, text };
    })();
    // Avoid unhandled rejections if the attempt fails after the timeout won.
    attempt.catch(() => undefined);
    const raced = await Promise.race([attempt, timeout]);
    if (raced === TIMED_OUT) return { ok: false, error: timeoutError() };
    const { res, text } = raced;
    if (!res.ok) return { ok: false, error: httpError(res.status, text), bodyText: text.slice(0, 4000) };
    try {
      return { ok: true, status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, error: aiError("malformed_output", "The AI provider returned a non-JSON HTTP body.") };
    }
  } catch (err) {
    if (controller.signal.aborted || isAbortError(err)) return { ok: false, error: timeoutError() };
    return { ok: false, error: aiError("network_error", `Could not reach the AI provider (${describeError(err)}).`, true) };
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    ((err as { name: unknown }).name === "AbortError" || (err as { name: unknown }).name === "TimeoutError")
  );
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "unknown error";
  const cause = (err as Error & { cause?: unknown }).cause;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof (cause as { code: unknown }).code === "string"
      ? ` ${(cause as { code: string }).code}`
      : "";
  return sanitizeUntrustedText(`${err.message}${code}`, 160);
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function httpError(status: number, bodyText: string): AiError {
  if (status === 401 || status === 403) {
    return aiError("http_error", `The AI provider rejected the credentials (HTTP ${status}). Check AI_API_KEY.`, false, status);
  }
  const detail = errorDetail(bodyText);
  return aiError(
    "http_error",
    `The AI provider returned HTTP ${status}${detail ? `: ${detail}` : "."}`,
    isRetryableStatus(status),
    status,
  );
}

function errorDetail(bodyText: string): string {
  let detail: unknown = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    if (parsed && typeof parsed === "object") {
      const p = parsed as { error?: unknown; message?: unknown; detail?: unknown };
      const e = p.error;
      detail =
        e && typeof e === "object" && "message" in e
          ? (e as { message: unknown }).message
          : typeof e === "string"
            ? e
            : (p.message ?? p.detail ?? "");
    }
  } catch {
    // plain-text body
  }
  return typeof detail === "string" ? sanitizeUntrustedText(detail, 200) : "";
}
