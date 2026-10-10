import { z } from "zod";
import { CATEGORY_SLUGS } from "@/domain/categories/catalog";
import { isDecimalString } from "@/domain/money/decimal";

/* ------------------------------------------------------------------------- */
/* Inputs (from Monio code — trusted shape, untrusted text content)          */
/* ------------------------------------------------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Input of `interpretTransactions`. Unknown keys are stripped, so passing a
 * whole transaction row is safe: only these fields can ever reach a model.
 */
export const TransactionInterpretationInputSchema = z.object({
  id: z.string().min(1).max(200),
  description: z.string().max(20_000),
  /** Signed canonical decimal string ("-39.90"). Sent as context only; never returned. */
  amount: z.string().refine(isDecimalString, "must be a decimal string such as -39.90"),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{2,10}$/, "must be a currency code")
    .transform((c) => c.toUpperCase()),
  date: z.string().regex(ISO_DATE, "must be YYYY-MM-DD").optional(),
  accountType: z.string().max(40).optional(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "must be an ISO 3166-1 alpha-2 code")
    .transform((c) => c.toUpperCase())
    .optional(),
  /** Money direction; derived from the amount sign when omitted. */
  direction: z.enum(["in", "out"]).optional(),
});
export type TransactionInterpretationInput = z.input<typeof TransactionInterpretationInputSchema>;

export const StatementLineInputSchema = z.object({
  line: z.number().int().positive(),
  text: z.string().max(100_000),
});
export type StatementLineInput = z.input<typeof StatementLineInputSchema>;

export const StatementContextSchema = z.object({
  currencyHint: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{2,10}$/)
    .transform((c) => c.toUpperCase())
    .optional(),
  yearHint: z.number().int().min(1970).max(2100).optional(),
});
export type StatementContext = z.input<typeof StatementContextSchema>;

/* ------------------------------------------------------------------------- */
/* Outputs (validated results handed back to Monio)                          */
/* ------------------------------------------------------------------------- */

export const REASONING_CODES = ["fixture_match", "keyword", "direction_rule", "no_match", "model"] as const;
export type ReasoningCode = (typeof REASONING_CODES)[number];

export const MERCHANT_MAX_CHARS = 80;

/**
 * A validated interpretation. Deliberately has no amount, date or free-text
 * field: AI only labels transactions, it never produces money values.
 */
export const TransactionInterpretationSchema = z.strictObject({
  id: z.string().min(1),
  merchant: z.string().min(1).max(MERCHANT_MAX_CHARS).nullable(),
  category: z.enum(CATEGORY_SLUGS).nullable(),
  recurring_candidate: z.boolean(),
  transfer_candidate: z.boolean(),
  /** 0..1 self-reported / simulated — NOT calibrated (see meta.confidenceIsCalibrated). */
  confidence: z.number().min(0).max(1),
  reasoning_code: z.enum(REASONING_CODES).optional(),
});
export type TransactionInterpretation = z.infer<typeof TransactionInterpretationSchema>;

export const StatementRowProposalSchema = z.strictObject({
  /** Line number from the request. */
  line: z.number().int().positive(),
  /** YYYY-MM-DD */
  date: z.string().regex(ISO_DATE),
  /** Text copied from the line. */
  description: z.string().trim().min(1).max(300),
  /** Canonical signed decimal string with "." separator ("-1234.56"). */
  amount: z.string().regex(/^-?\d+(\.\d+)?$/),
  currency: z
    .string()
    .regex(/^[A-Z0-9]{3,5}$/)
    .optional(),
});
export type StatementRowProposal = z.infer<typeof StatementRowProposalSchema>;

/* ------------------------------------------------------------------------- */
/* Model wire format                                                         */
/* ------------------------------------------------------------------------- */

/** One transaction as sent to the model (ids are per-batch aliases "t1".."t25"). */
export interface WireTransaction {
  id: string;
  description: string;
  amount: string;
  currency: string;
  direction: "in" | "out" | "unknown";
  date?: string;
  account_type?: string;
  country?: string;
}

export interface WireStatementLine {
  line: number;
  text: string;
}

/** Top-level object the model must return for interpretation. Extra keys are rejected. */
export const InterpretationEnvelopeSchema = z.strictObject({
  items: z.array(z.unknown()).max(500),
});

/**
 * One interpretation item exactly as the model must return it. Strict: any
 * extra key (`amount`, `date`, `note`...) rejects the item. `category` is a
 * string here so that unknown slugs can be reported per item (and nulled)
 * instead of failing the batch.
 */
export const ModelInterpretationItemSchema = z.strictObject({
  id: z.string().min(1).max(64),
  merchant: z.string().max(MERCHANT_MAX_CHARS).nullable(),
  category: z.string().max(64).nullable(),
  recurring_candidate: z.boolean(),
  transfer_candidate: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning_code: z.enum(REASONING_CODES).optional(),
});
export type ModelInterpretationItem = z.infer<typeof ModelInterpretationItemSchema>;

const columnIndex = z.number().int().min(0).max(199).nullish();
/** Model answer of proposeTableColumns: column indexes only, never cell values. */
export const TableColumnsAnswerSchema = z.object({
  date: columnIndex,
  description: columnIndex,
  amount: columnIndex,
  debit: columnIndex,
  credit: columnIndex,
  balance: columnIndex,
  currency: columnIndex,
  value_date: columnIndex,
});
export interface TableColumns {
  date: number;
  description: number;
  amount?: number;
  debit?: number;
  credit?: number;
  balance?: number;
  currency?: number;
  valueDate?: number;
}

export const StatementRowsEnvelopeSchema = z.strictObject({
  rows: z.array(z.unknown()).max(1000),
});
