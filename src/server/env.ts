import "server-only";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const ServerEnvSchema = z.object({
  APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  AI_PROVIDER: z.string().default("mock"),
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_TIMEOUT_MS: z.string().optional(),
  AI_ALLOW_CLOUD_DOCUMENTS: booleanString,
  AI_CLOUD_FLAVOR: z.string().optional(),
  BLOCKCHAIN_PROVIDER: z.enum(["mock", "live"]).default("mock"),
  BLOCKCHAIN_API_URL: z.string().optional(),
  BLOCKCHAIN_API_KEY: z.string().optional(),
  EXCHANGE_RATE_PROVIDER: z.enum(["mock", "live"]).default("mock"),
  EXCHANGE_RATE_API_URL: z.string().optional(),
  EXCHANGE_RATE_API_KEY: z.string().optional(),
  IMPORT_MAX_FILE_MB: z.coerce.number().int().min(1).max(50).default(15),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cached: ServerEnv | undefined;

/**
 * Validated server configuration. Throws with the list of invalid variable
 * NAMES (never values) so misconfiguration fails fast at startup.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid or missing environment variables: ${names}. See .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

export function isProduction(): boolean {
  return getServerEnv().APP_ENV === "production";
}
