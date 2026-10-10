import type { DocumentPayload } from "../document-contract";
import type { StatementPayload, TableColumnsPayload } from "../prompts";
import type { AiError, AiProviderId } from "../result";
import type { WireTransaction } from "../schemas";

/**
 * A request as seen by a provider. Chat providers send `system` + `user`
 * (the user message embeds `payload` as delimited JSON); the deterministic
 * mock reads `payload` directly. Every provider answers with raw text that
 * the service validates the same way.
 */
export type ProviderRequest =
  | { task: "interpret_document"; system: string; user: string; payload: DocumentPayload; timeoutMs?: number }
  | { task: "map_table_columns"; system: string; user: string; payload: TableColumnsPayload }
  | {
      task: "interpret_transactions";
      system: string;
      user: string;
      payload: { transactions: WireTransaction[] };
    }
  | {
      task: "propose_statement_rows";
      system: string;
      user: string;
      payload: StatementPayload;
    };

export type ProviderResponse = { ok: true; text: string } | { ok: false; error: AiError };

export interface ProviderHealth {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /** Whether the configured model is listed by the server (when it can tell). */
  modelAvailable?: boolean;
}

export interface AiProvider {
  readonly id: AiProviderId;
  readonly model: string | undefined;
  /** "cloud" providers are subject to the allowCloudDocuments gate. */
  readonly location: "simulated" | "local" | "cloud";
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  health(): Promise<ProviderHealth>;
}

export interface ProviderRuntime {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  now: () => number;
}
