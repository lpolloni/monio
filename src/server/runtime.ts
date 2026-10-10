import "server-only";
import { aiConfigFromEnv, createAiService, describeAiConfig, type AiService } from "./ai";
import { createBlockchainService } from "./blockchain/service";
import { getServerEnv } from "./env";
import { createMarketDataService } from "./market/service";

/**
 * Builds external-provider services from validated environment variables.
 * Credentials stay on the server; nothing here is exposed to the browser.
 */
export function getAiConfig() {
  return aiConfigFromEnv(process.env);
}

export function getAiSummary() {
  return describeAiConfig(getAiConfig());
}

/**
 * AI service for a user. Cloud providers only receive financial data when the
 * user explicitly consented; otherwise AI is skipped (rules still work). There is
 * never an automatic fallback to the cloud.
 */
export function getAiServiceFor(profile: { aiCloudConsent: boolean }): AiService | null {
  const config = getAiConfig();
  if (config.mode === "disabled") return null;
  if (config.mode === "cloud" && !profile.aiCloudConsent) return null;
  return createAiService({ ...config, allowCloudDocuments: config.mode === "cloud" ? profile.aiCloudConsent && config.allowCloudDocuments : config.allowCloudDocuments });
}

export function getBlockchainService() {
  const env = getServerEnv();
  return createBlockchainService({
    provider: env.BLOCKCHAIN_PROVIDER,
    bitcoinApiUrl: env.BLOCKCHAIN_API_URL || undefined,
    apiKey: env.BLOCKCHAIN_API_KEY || undefined,
  });
}

export function getMarketService() {
  const env = getServerEnv();
  return createMarketDataService({
    provider: env.EXCHANGE_RATE_PROVIDER,
    frankfurterUrl: env.EXCHANGE_RATE_API_URL || undefined,
    apiKey: env.EXCHANGE_RATE_API_KEY || undefined,
  });
}
