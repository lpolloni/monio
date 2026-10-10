import { z } from "zod";
import type { AiProviderId } from "./result";

export const AI_MODES = ["mock", "omlx", "cloud", "disabled"] as const;
export type AiMode = (typeof AI_MODES)[number];

export const CLOUD_FLAVORS = ["openai", "openrouter", "anthropic", "generic"] as const;
export type CloudFlavor = (typeof CLOUD_FLAVORS)[number];

/** Simulated failure modes of the mock provider (tests / e2e only, never driven by user data). */
export const MOCK_BEHAVIORS = ["normal", "timeout", "malformed", "schema_invalid", "error"] as const;
export type MockBehavior = (typeof MOCK_BEHAVIORS)[number];

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MIN_TIMEOUT_MS = 1;
export const MAX_TIMEOUT_MS = 600_000;

/** Base URLs used when a cloud flavor is selected without AI_BASE_URL. `generic` has none. */
export const CLOUD_DEFAULT_BASE_URLS: Readonly<Record<CloudFlavor, string | undefined>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com",
  generic: undefined,
};

export interface AiConfig {
  mode: AiMode;
  /** OpenAI-compatible base URL (".../v1"); for anthropic the API origin. No trailing slash. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  /**
   * Explicit authorization to send transaction descriptions / document text to a
   * `cloud` provider. Without it every data-bearing cloud call fails with
   * `cloud_not_authorized` before touching the network.
   */
  allowCloudDocuments: boolean;
  cloudFlavor?: CloudFlavor;
  /** Mock only: simulated failure mode. */
  mockBehavior?: MockBehavior;
  /** Set when the configuration resolved to `disabled`: why (safe to show, no secrets). */
  disabledReason?: string;
  /** The AI_PROVIDER value that was requested when the config fell back to `disabled`. */
  requestedMode?: string;
}

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const lowerTrim = (v: unknown) => {
  const b = blankToUndefined(v);
  return typeof b === "string" ? b.trim().toLowerCase() : b;
};
const trimmed = (v: unknown) => {
  const b = blankToUndefined(v);
  return typeof b === "string" ? b.trim() : b;
};

const AiEnvSchema = z.object({
  AI_PROVIDER: z.preprocess(lowerTrim, z.enum(AI_MODES).default("mock")),
  AI_BASE_URL: z.preprocess(trimmed, z.string().max(2048).optional()),
  AI_API_KEY: z.preprocess(trimmed, z.string().max(4096).optional()),
  AI_MODEL: z.preprocess(trimmed, z.string().max(256).optional()),
  AI_TIMEOUT_MS: z.preprocess(
    trimmed,
    z
      .string()
      .regex(/^\d+$/, "must be a positive integer (milliseconds)")
      .transform(Number)
      .pipe(z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS))
      .optional(),
  ),
  AI_ALLOW_CLOUD_DOCUMENTS: z.preprocess(
    lowerTrim,
    z
      .enum(["true", "false", "1", "0", "yes", "no"])
      .optional()
      .transform((v) => v === "true" || v === "1" || v === "yes"),
  ),
  AI_CLOUD_FLAVOR: z.preprocess(lowerTrim, z.enum(CLOUD_FLAVORS).optional()),
  AI_MOCK_BEHAVIOR: z.preprocess(lowerTrim, z.enum(MOCK_BEHAVIORS).optional()),
});

/**
 * Builds the AI configuration from environment variables. Never throws: any
 * invalid value resolves to `mode: "disabled"` with a `disabledReason` that
 * names the variable but never echoes its value.
 */
export function aiConfigFromEnv(env: Record<string, string | undefined>): AiConfig {
  const parsed = AiEnvSchema.safeParse({
    AI_PROVIDER: env.AI_PROVIDER,
    AI_BASE_URL: env.AI_BASE_URL,
    AI_API_KEY: env.AI_API_KEY,
    AI_MODEL: env.AI_MODEL,
    AI_TIMEOUT_MS: env.AI_TIMEOUT_MS,
    AI_ALLOW_CLOUD_DOCUMENTS: env.AI_ALLOW_CLOUD_DOCUMENTS,
    AI_CLOUD_FLAVOR: env.AI_CLOUD_FLAVOR,
    AI_MOCK_BEHAVIOR: env.AI_MOCK_BEHAVIOR,
  });
  const requestedMode = typeof env.AI_PROVIDER === "string" ? env.AI_PROVIDER.trim().slice(0, 32) : undefined;
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join("; ");
    return disabledConfig(`Invalid AI configuration: ${problems}.`, requestedMode);
  }
  const e = parsed.data;
  if (e.AI_PROVIDER === "disabled") {
    return {
      mode: "disabled",
      timeoutMs: e.AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
      allowCloudDocuments: false,
      disabledReason: "AI is turned off (AI_PROVIDER=disabled).",
    };
  }
  const candidate: AiConfig = {
    mode: e.AI_PROVIDER,
    timeoutMs: e.AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
    allowCloudDocuments: e.AI_ALLOW_CLOUD_DOCUMENTS,
    ...(e.AI_BASE_URL !== undefined && { baseUrl: e.AI_BASE_URL }),
    ...(e.AI_API_KEY !== undefined && { apiKey: e.AI_API_KEY }),
    ...(e.AI_MODEL !== undefined && { model: e.AI_MODEL }),
    ...(e.AI_CLOUD_FLAVOR !== undefined && { cloudFlavor: e.AI_CLOUD_FLAVOR }),
    ...(e.AI_MOCK_BEHAVIOR !== undefined && { mockBehavior: e.AI_MOCK_BEHAVIOR }),
  };
  const checked = checkAiConfig(candidate);
  return checked.ok ? checked.config : disabledConfig(checked.reason, requestedMode);
}

function disabledConfig(reason: string, requestedMode?: string): AiConfig {
  return {
    mode: "disabled",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowCloudDocuments: false,
    disabledReason: reason,
    ...(requestedMode ? { requestedMode } : {}),
  };
}

export type AiConfigCheck = { ok: true; config: AiConfig } | { ok: false; reason: string };

/**
 * Validates a configuration and fills defaults (cloud base URL / flavor). Used
 * by `aiConfigFromEnv` and again by `createAiService`, so a hand-built config
 * gets exactly the same safety rules as one read from the environment.
 */
export function checkAiConfig(input: AiConfig): AiConfigCheck {
  const config: AiConfig = { ...input };
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < MIN_TIMEOUT_MS || config.timeoutMs > MAX_TIMEOUT_MS) {
    return { ok: false, reason: `AI_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.` };
  }
  if (typeof config.allowCloudDocuments !== "boolean") {
    return { ok: false, reason: "allowCloudDocuments must be a boolean." };
  }
  switch (config.mode) {
    case "disabled":
    case "mock":
      return { ok: true, config };
    case "omlx": {
      if (!config.baseUrl) return { ok: false, reason: "AI_PROVIDER=omlx requires AI_BASE_URL (e.g. http://192.168.1.10:8000/v1)." };
      const url = parseBaseUrl(config.baseUrl);
      if (!url.ok) return { ok: false, reason: `AI_BASE_URL ${url.reason}` };
      if (!isPrivateNetworkHost(url.url.hostname)) {
        return {
          ok: false,
          reason:
            "AI_PROVIDER=omlx is treated as local and must point to a loopback or private-network host. " +
            "Use AI_PROVIDER=cloud (with AI_ALLOW_CLOUD_DOCUMENTS) for remote endpoints.",
        };
      }
      if (!config.model) return { ok: false, reason: "AI_PROVIDER=omlx requires AI_MODEL." };
      config.baseUrl = url.normalized;
      return { ok: true, config };
    }
    case "cloud": {
      const flavor: CloudFlavor = config.cloudFlavor ?? "generic";
      config.cloudFlavor = flavor;
      const base = config.baseUrl ?? CLOUD_DEFAULT_BASE_URLS[flavor];
      if (!base) return { ok: false, reason: "AI_PROVIDER=cloud with AI_CLOUD_FLAVOR=generic requires AI_BASE_URL." };
      const url = parseBaseUrl(base);
      if (!url.ok) return { ok: false, reason: `AI_BASE_URL ${url.reason}` };
      if (url.url.protocol !== "https:") return { ok: false, reason: "AI_PROVIDER=cloud requires an https:// AI_BASE_URL." };
      if (!config.apiKey) return { ok: false, reason: "AI_PROVIDER=cloud requires AI_API_KEY." };
      if (!config.model) return { ok: false, reason: "AI_PROVIDER=cloud requires AI_MODEL." };
      config.baseUrl = url.normalized;
      return { ok: true, config };
    }
    default:
      return { ok: false, reason: "Unknown AI mode." };
  }
}

type ParsedBaseUrl = { ok: true; url: URL; normalized: string } | { ok: false; reason: string };

function parseBaseUrl(raw: string): ParsedBaseUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "must use http or https." };
  if (url.username || url.password) return { ok: false, reason: "must not embed credentials; use AI_API_KEY." };
  if (url.search || url.hash) return { ok: false, reason: "must not contain a query string or fragment." };
  const normalized = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  return { ok: true, url, normalized };
}

/**
 * True for loopback, RFC 1918, link-local, CGNAT/Tailscale (100.64/10), IPv6
 * ULA/link-local addresses, `localhost`, LAN suffixes (.local, .lan, .internal,
 * .home.arpa) and single-label hostnames (docker service names).
 */
export function isPrivateNetworkHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/\.(local|lan|internal|home\.arpa)$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":")) {
    return h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  }
  return !h.includes(".");
}

export function providerIdForConfig(config: AiConfig): AiProviderId {
  switch (config.mode) {
    case "mock":
      return "mock";
    case "omlx":
      return "omlx";
    case "cloud":
      return config.cloudFlavor ?? "generic";
    default:
      return "disabled";
  }
}

export interface AiConfigSummary {
  mode: AiMode;
  provider: AiProviderId;
  /** Where financial data goes when AI features run. */
  dataDestination: "none" | "this_server" | "local_network" | "cloud";
  baseUrl?: string;
  model?: string;
  timeoutMs: number;
  apiKey: "set" | "not set";
  allowCloudDocuments: boolean;
  cloudFlavor?: CloudFlavor;
  disabledReason?: string;
  requestedMode?: string;
  /** Confidence scores are not calibrated for any provider yet. */
  confidenceIsCalibrated: false;
}

/** Safe summary for the Settings UI. Never includes the API key itself. */
export function describeAiConfig(config: AiConfig): AiConfigSummary {
  let baseUrl: string | undefined;
  if (config.baseUrl) {
    try {
      const u = new URL(config.baseUrl);
      baseUrl = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
    } catch {
      baseUrl = undefined;
    }
  }
  const dataDestination: AiConfigSummary["dataDestination"] =
    config.mode === "mock"
      ? "this_server"
      : config.mode === "omlx"
        ? "local_network"
        : config.mode === "cloud" && config.allowCloudDocuments
          ? "cloud"
          : "none";
  return {
    mode: config.mode,
    provider: providerIdForConfig(config),
    dataDestination,
    ...(baseUrl && { baseUrl }),
    ...(config.model && { model: config.model }),
    timeoutMs: config.timeoutMs,
    apiKey: config.apiKey ? "set" : "not set",
    allowCloudDocuments: config.allowCloudDocuments,
    ...(config.cloudFlavor && { cloudFlavor: config.cloudFlavor }),
    ...(config.disabledReason && { disabledReason: config.disabledReason }),
    ...(config.requestedMode && { requestedMode: config.requestedMode }),
    confidenceIsCalibrated: false,
  };
}
