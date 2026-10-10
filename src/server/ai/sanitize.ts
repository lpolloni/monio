/**
 * Hardening for untrusted text (bank descriptions, PDF lines) before it is
 * placed in a model payload, and for raw model output before JSON.parse.
 */
import { aiError, type AiError } from "./result";

export const AI_LIMITS = {
  /** Max characters of one transaction description sent to a model. */
  descriptionChars: 300,
  /** Max characters of document text sent in one proposeStatementRows call. */
  documentChars: 24_000,
  /** Max lines sent in one proposeStatementRows call. */
  documentLines: 200,
  /** Max characters of a single document line. */
  lineChars: 1_000,
  /** Transactions per model request. */
  interpretBatchSize: 25,
  /** Document lines per model request. */
  statementBatchLines: 40,
  /** Max characters of a model response we are willing to parse. */
  responseChars: 200_000,
} as const;

// C0/C1 controls, DEL, soft hyphen, zero-width chars, line/paragraph separators,
// bidi embeddings/overrides/isolates, word joiners and BOM.
const CONTROL_CHARS =
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// Our payload delimiters are <<<DATA ... DATA>>>; untrusted text must not be able to fake them.
const DELIMITER_SEQUENCES = /<{3,}|>{3,}/g;

/**
 * Normalizes untrusted text for a model payload: NFC, control/invisible
 * characters replaced by spaces, delimiter sequences removed, whitespace
 * collapsed, then truncated to `maxChars` code points.
 */
export function sanitizeUntrustedText(raw: string, maxChars: number): string {
  let s = raw
    .normalize("NFC")
    .replace(CONTROL_CHARS, " ")
    .replace(DELIMITER_SEQUENCES, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxChars) {
    const points = Array.from(s);
    if (points.length > maxChars) s = points.slice(0, maxChars).join("").trimEnd();
  }
  return s;
}

export type JsonExtraction = { ok: true; value: unknown } | { ok: false; error: AiError };

/**
 * Extracts the JSON object from a model's text answer. Tolerates (only) a
 * leading `<think>…</think>` reasoning block, Markdown code fences and stray
 * prose around a single top-level object. Anything else → `malformed_output`.
 */
export function extractModelJson(text: string): JsonExtraction {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: aiError("malformed_output", "The model returned an empty answer.") };
  }
  if (text.length > AI_LIMITS.responseChars) {
    return { ok: false, error: aiError("malformed_output", "The model answer is too large to be trusted.") };
  }
  let s = text.replace(/^\uFEFF/, "").trim();

  // Reasoning models (Qwen3 & co.) may prefix the answer with <think>…</think>;
  // some chat templates only emit the closing tag.
  const closeIdx = s.lastIndexOf("</think>");
  if (closeIdx >= 0) {
    s = s.slice(closeIdx + "</think>".length).trim();
  } else if (/^<think>/i.test(s)) {
    return { ok: false, error: aiError("malformed_output", "The model answer ended inside its reasoning block.", true) };
  }

  const fenced = s.match(/```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/);
  if (fenced) s = fenced[1]!.trim();

  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return { ok: true, value: JSON.parse(s) as unknown };
    } catch {
      // fall through: maybe trailing prose after the object
    }
  }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return { ok: false, error: aiError("malformed_output", "The model answer does not contain a JSON object.") };
  }
  s = s.slice(first, last + 1);
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false, error: aiError("malformed_output", "The model answer is not valid JSON.") };
  }
}
