/**
 * Deterministic mock provider. Interprets descriptions with fixture rules and
 * proposes statement rows only from date/amount tokens literally present in a
 * line. Its answer is serialized to JSON text and goes through exactly the
 * same parsing + validation as a real model's answer.
 */
import { getCategory } from "@/domain/categories/catalog";
import { parseAmount } from "@/domain/import/parse-amount";
import { parseDate } from "@/domain/import/parse-date";
import type { MockBehavior } from "../config";
import {
  KEYWORD_RULES,
  REFUND_MARKERS,
  TRANSACTION_FIXTURES,
  type FixtureOutcome,
  type TransactionFixture,
} from "../fixtures/transactions";
import type { StatementPayload } from "../prompts";
import { aiError } from "../result";
import type { ReasoningCode, WireTransaction } from "../schemas";
import { fiatCurrenciesInText } from "../statement-validation";
import type { AiProvider, ProviderRequest, ProviderResponse } from "./types";

export const MOCK_MODEL = "monio-mock-v1";

/** Uppercase, accents stripped, "*" spaced out, whitespace collapsed, digits-only tokens removed. */
export function normalizeDescription(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\*/g, " * ")
    .split(/\s+/)
    .filter((t) => t && !/^\d+$/.test(t))
    .join(" ");
}

/** Alphanumeric word tokens used for rule matching ("APPLE.COM/BILL" → APPLE COM BILL). */
export function descriptionTokens(raw: string): string[] {
  return normalizeDescription(raw)
    .split(/[^A-Z0-9]+/)
    .filter((t) => t && !/^\d+$/.test(t));
}

function indexOfSequence(haystack: readonly string[], needle: readonly string[]): number {
  if (!needle.length || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const COMPILED_FIXTURES = TRANSACTION_FIXTURES.map((fixture) => ({
  fixture,
  patterns: fixture.patterns.map((p) => descriptionTokens(p)),
}));

/** First fixture (in priority order) matching the description, if any. */
export function matchFixture(description: string): TransactionFixture | undefined {
  const tokens = descriptionTokens(description);
  for (const { fixture, patterns } of COMPILED_FIXTURES) {
    for (const pattern of patterns) {
      const at = indexOfSequence(tokens, pattern);
      if (at === 0 || (at > 0 && fixture.match === "contains")) return fixture;
    }
  }
  return undefined;
}

export interface MockInterpretation {
  id: string;
  merchant: string | null;
  category: string | null;
  recurring_candidate: boolean;
  transfer_candidate: boolean;
  confidence: number;
  reasoning_code: ReasoningCode;
}

/** Deterministic interpretation of one transaction (pure function). */
export function interpretWithFixtures(tx: WireTransaction): MockInterpretation {
  const tokens = descriptionTokens(tx.description);
  const direction = tx.direction;
  const fixture = matchFixture(tx.description);

  let outcome: FixtureOutcome | undefined;
  let code: ReasoningCode = "no_match";
  if (fixture) {
    const override = direction === "in" ? fixture.incoming : direction === "out" ? fixture.outgoing : undefined;
    outcome = {
      merchant: fixture.merchant,
      category: fixture.category,
      recurring: fixture.recurring,
      transfer: fixture.transfer,
      confidence: fixture.confidence,
      ...override,
    };
    code = "fixture_match";
  } else {
    const keyword = KEYWORD_RULES.find((r) => r.keywords.some((k) => tokens.includes(k)));
    if (keyword) {
      outcome = { merchant: null, category: keyword.category, recurring: false, transfer: false, confidence: keyword.confidence };
      code = "keyword";
    }
  }

  // Money returned by a merchant.
  if (direction === "in" && tokens.some((t) => REFUND_MARKERS.includes(t))) {
    const merchant = outcome?.merchant ?? null;
    return { id: tx.id, merchant, category: "refunds", recurring_candidate: false, transfer_candidate: false, confidence: 0.85, reasoning_code: "keyword" };
  }

  if (!outcome) {
    return { id: tx.id, merchant: null, category: null, recurring_candidate: false, transfer_candidate: false, confidence: 0.2, reasoning_code: "no_match" };
  }

  const kind = outcome.category ? getCategory(outcome.category)?.kind : undefined;
  if (direction === "in" && kind === "expense") {
    // Incoming money at a merchant is a refund, never an expense.
    return {
      id: tx.id,
      merchant: outcome.merchant,
      category: "refunds",
      recurring_candidate: false,
      transfer_candidate: false,
      confidence: round2(outcome.confidence * 0.8),
      reasoning_code: "direction_rule",
    };
  }
  if (direction === "out" && kind === "income") {
    // Outgoing money cannot be income; leave it uncategorized.
    return { id: tx.id, merchant: outcome.merchant, category: null, recurring_candidate: false, transfer_candidate: false, confidence: 0.3, reasoning_code: "direction_rule" };
  }
  return {
    id: tx.id,
    merchant: outcome.merchant,
    category: outcome.category,
    recurring_candidate: outcome.recurring,
    transfer_candidate: outcome.transfer,
    confidence: outcome.confidence,
    reasoning_code: code,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------------- */
/* Statement rows                                                            */
/* ------------------------------------------------------------------------- */

const MOCK_DATE = /(?<![\d/.-])(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})|\d{1,2}\/\d{1,2})(?![\d/])/;
const MOCK_AMOUNT = /(?<![\d.,A-Za-z])([-−]\s?)?(\d{1,3}(?:[.,]\d{3})+|\d+)[.,]\d{2}(?!\d)(\s?(?:-|D\b|C\b))?/g;

export interface MockStatementRow {
  line: number;
  date: string;
  description: string;
  amount: string;
  currency?: string;
}

/**
 * Proposes a row for a line only when a date token and an amount token are
 * literally present (first amount after the date). Never invents anything.
 */
export function proposeRowsFromLines(payload: StatementPayload): MockStatementRow[] {
  const rows: MockStatementRow[] = [];
  for (const { line, text } of payload.lines) {
    const dateMatch = MOCK_DATE.exec(text);
    if (!dateMatch) continue;
    const dateToken = dateMatch[1]!;
    let date: string | null;
    if (/^\d{1,2}\/\d{1,2}$/.test(dateToken)) {
      if (payload.year_hint === undefined) continue;
      date = parseDate(`${dateToken}/${payload.year_hint}`, "DMY");
    } else {
      date = parseDate(dateToken, "DMY");
    }
    if (!date) continue;

    const afterDate = dateMatch.index + dateMatch[0].length;
    MOCK_AMOUNT.lastIndex = afterDate;
    const amountMatch = MOCK_AMOUNT.exec(text);
    if (!amountMatch) continue;
    const parsed = parseAmount(amountMatch[0].trim());
    if (!parsed) continue;

    const description = text
      .slice(afterDate, amountMatch.index)
      .replace(/(?:R\$|US\$|€|£|\$|\b(?:EUR|BRL|USD|GBP|CHF)\b)\s*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!description) continue;

    const currencies = fiatCurrenciesInText(text);
    const only = currencies.size === 1 ? [...currencies][0] : undefined;
    rows.push({ line, date, description, amount: parsed.amount, ...(only && { currency: only }) });
  }
  return rows;
}

/* ------------------------------------------------------------------------- */
/* Provider                                                                  */
/* ------------------------------------------------------------------------- */

export interface MockProviderOptions {
  behavior?: MockBehavior;
}

export function createMockProvider(options: MockProviderOptions = {}): AiProvider {
  const behavior = options.behavior ?? "normal";
  return {
    id: "mock",
    model: MOCK_MODEL,
    location: "simulated",

    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      switch (behavior) {
        case "timeout":
          return { ok: false, error: aiError("timeout", "Simulated timeout (mock).", true) };
        case "error":
          return { ok: false, error: aiError("http_error", "Simulated HTTP 503 (mock).", true, 503) };
        case "malformed":
          return { ok: true, text: "Sure! Here are the results: {items: [oops" };
        case "schema_invalid":
          return {
            ok: true,
            text: JSON.stringify(
              request.task === "interpret_transactions"
                ? { items: [{ id: "zz", category: "salary", amount: "99999" }], note: "simulated" }
                : { rows: "none" },
            ),
          };
        default:
          break;
      }
      if (request.task === "interpret_transactions") {
        return { ok: true, text: JSON.stringify({ items: request.payload.transactions.map(interpretWithFixtures) }) };
      }
      return { ok: true, text: JSON.stringify({ rows: proposeRowsFromLines(request.payload) }) };
    },

    async health() {
      return behavior === "normal" ? { ok: true, latencyMs: 0 } : { ok: false, latencyMs: 0, error: `Simulated ${behavior} (mock).` };
    },
  };
}
