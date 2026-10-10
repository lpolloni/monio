/**
 * Monio AI service — public API.
 *
 * This barrel intentionally does NOT import "server-only" so that unit tests
 * can import it in plain Node. App code must import it from a server-only
 * module (the app layer adds the guard).
 */
export {
  AI_MODES,
  CLOUD_FLAVORS,
  CLOUD_DEFAULT_BASE_URLS,
  DEFAULT_TIMEOUT_MS,
  MOCK_BEHAVIORS,
  aiConfigFromEnv,
  checkAiConfig,
  describeAiConfig,
  isPrivateNetworkHost,
  providerIdForConfig,
  type AiConfig,
  type AiConfigCheck,
  type AiConfigSummary,
  type AiMode,
  type CloudFlavor,
  type MockBehavior,
} from "./config";
export {
  aiError,
  type AiError,
  type AiErrorCode,
  type AiItemNote,
  type AiItemNoteCode,
  type AiProviderId,
  type AiResult,
  type AiResultMeta,
  type RejectedStatementRow,
  type StatementRowRejectReason,
} from "./result";
export {
  MERCHANT_MAX_CHARS,
  REASONING_CODES,
  StatementContextSchema,
  StatementLineInputSchema,
  StatementRowProposalSchema,
  TransactionInterpretationInputSchema,
  TransactionInterpretationSchema,
  type ReasoningCode,
  type StatementContext,
  type StatementLineInput,
  type StatementRowProposal,
  type TransactionInterpretation,
  type TransactionInterpretationInput,
} from "./schemas";
export { AI_LIMITS, sanitizeUntrustedText } from "./sanitize";
export { PROMPT_VERSION } from "./prompts";
export { amountAppearsInLine, dateAppearsInLine, findDescriptionInLine, validateStatementRows } from "./statement-validation";
export { MOCK_MODEL } from "./providers/mock";
export { createAiService, type AiHealth, type AiService, type AiServiceDeps, type InterpretOptions } from "./service";
