import { describe, expect, it } from "vitest";
import { aiConfigFromEnv, checkAiConfig, describeAiConfig, isPrivateNetworkHost } from "./config";
import { createAiService } from "./service";

const SECRET = "sk-test-SUPER-SECRET-0123456789";

describe("aiConfigFromEnv", () => {
  it("defaults to the mock provider", () => {
    const config = aiConfigFromEnv({});
    expect(config).toEqual({ mode: "mock", timeoutMs: 20_000, allowCloudDocuments: false });
  });

  it("parses a local oMLX configuration", () => {
    const config = aiConfigFromEnv({
      AI_PROVIDER: "omlx",
      AI_BASE_URL: "http://192.168.68.115:8000/v1/",
      AI_MODEL: "Qwen3.5-9B-MLX-4bit",
      AI_TIMEOUT_MS: "45000",
    });
    expect(config).toMatchObject({
      mode: "omlx",
      baseUrl: "http://192.168.68.115:8000/v1",
      model: "Qwen3.5-9B-MLX-4bit",
      timeoutMs: 45_000,
      allowCloudDocuments: false,
    });
    expect(config.disabledReason).toBeUndefined();
  });

  it("parses a cloud configuration and fills the flavor's default base URL", () => {
    const config = aiConfigFromEnv({
      AI_PROVIDER: "CLOUD",
      AI_CLOUD_FLAVOR: "openrouter",
      AI_API_KEY: SECRET,
      AI_MODEL: "qwen/qwen3-32b",
      AI_ALLOW_CLOUD_DOCUMENTS: "true",
    });
    expect(config).toMatchObject({
      mode: "cloud",
      cloudFlavor: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      allowCloudDocuments: true,
    });
  });

  it.each([
    ["1", true],
    ["yes", true],
    ["TRUE", true],
    ["false", false],
    ["0", false],
    ["", false],
    [undefined, false],
  ])("AI_ALLOW_CLOUD_DOCUMENTS=%s → %s", (value, expected) => {
    const config = aiConfigFromEnv({ AI_PROVIDER: "cloud", AI_CLOUD_FLAVOR: "openai", AI_API_KEY: SECRET, AI_MODEL: "gpt-x", AI_ALLOW_CLOUD_DOCUMENTS: value });
    expect(config.mode).toBe("cloud");
    expect(config.allowCloudDocuments).toBe(expected);
  });

  it.each([
    [{ AI_PROVIDER: "gpt4all" }, /AI_PROVIDER/],
    [{ AI_TIMEOUT_MS: "soon" }, /AI_TIMEOUT_MS/],
    [{ AI_TIMEOUT_MS: "0" }, /AI_TIMEOUT_MS/],
    [{ AI_ALLOW_CLOUD_DOCUMENTS: "maybe" }, /AI_ALLOW_CLOUD_DOCUMENTS/],
    [{ AI_CLOUD_FLAVOR: "gemini" }, /AI_CLOUD_FLAVOR/],
    [{ AI_PROVIDER: "omlx", AI_MODEL: "m" }, /AI_BASE_URL/],
    [{ AI_PROVIDER: "omlx", AI_BASE_URL: "not a url", AI_MODEL: "m" }, /AI_BASE_URL/],
    [{ AI_PROVIDER: "omlx", AI_BASE_URL: "http://192.168.1.2:8000/v1" }, /AI_MODEL/],
    [{ AI_PROVIDER: "omlx", AI_BASE_URL: "https://api.openai.com/v1", AI_MODEL: "m" }, /local/],
    [{ AI_PROVIDER: "omlx", AI_BASE_URL: "http://user:pw@10.0.0.2:8000/v1", AI_MODEL: "m" }, /credentials/],
    [{ AI_PROVIDER: "cloud", AI_MODEL: "m", AI_API_KEY: SECRET }, /AI_BASE_URL/],
    [{ AI_PROVIDER: "cloud", AI_CLOUD_FLAVOR: "openai", AI_MODEL: "m" }, /AI_API_KEY/],
    [{ AI_PROVIDER: "cloud", AI_BASE_URL: "http://example.com/v1", AI_MODEL: "m", AI_API_KEY: SECRET }, /https/],
  ])("invalid %o → disabled with a reason", (env, reason) => {
    const config = aiConfigFromEnv(env);
    expect(config.mode).toBe("disabled");
    expect(config.disabledReason).toMatch(reason);
    expect(config.allowCloudDocuments).toBe(false);
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  it("does not echo the API key in the reason when it is invalid", () => {
    const config = aiConfigFromEnv({ AI_PROVIDER: "cloud", AI_CLOUD_FLAVOR: "openai", AI_MODEL: "m", AI_API_KEY: `${SECRET}${"x".repeat(5000)}` });
    expect(config.mode).toBe("disabled");
    expect(config.disabledReason).toMatch(/AI_API_KEY/);
    expect(config.disabledReason).not.toContain(SECRET);
  });

  it("explicit disabled mode", () => {
    const config = aiConfigFromEnv({ AI_PROVIDER: "disabled" });
    expect(config.mode).toBe("disabled");
    expect(config.disabledReason).toMatch(/turned off/);
  });

  it("parses the mock failure simulation switch", () => {
    expect(aiConfigFromEnv({ AI_MOCK_BEHAVIOR: "timeout" }).mockBehavior).toBe("timeout");
  });
});

describe("describeAiConfig", () => {
  it("never includes the API key", () => {
    const config = aiConfigFromEnv({
      AI_PROVIDER: "cloud",
      AI_CLOUD_FLAVOR: "anthropic",
      AI_API_KEY: SECRET,
      AI_MODEL: "claude-x",
    });
    const summary = describeAiConfig(config);
    expect(summary.apiKey).toBe("set");
    expect(summary.provider).toBe("anthropic");
    expect(summary.dataDestination).toBe("none"); // cloud without authorization
    expect(summary.confidenceIsCalibrated).toBe(false);
    expect(JSON.stringify(summary)).not.toContain(SECRET);
    expect(JSON.stringify(summary)).not.toContain("SUPER-SECRET");
  });

  it("reports not set / local destinations", () => {
    expect(describeAiConfig(aiConfigFromEnv({})).apiKey).toBe("not set");
    expect(describeAiConfig(aiConfigFromEnv({})).dataDestination).toBe("this_server");
    const omlx = describeAiConfig(
      aiConfigFromEnv({ AI_PROVIDER: "omlx", AI_BASE_URL: "http://192.168.68.115:8000/v1", AI_MODEL: "Qwen3.5-9B-MLX-4bit" }),
    );
    expect(omlx).toMatchObject({ dataDestination: "local_network", baseUrl: "http://192.168.68.115:8000/v1" });
  });

  it("shows the disabled reason", () => {
    const summary = describeAiConfig(aiConfigFromEnv({ AI_PROVIDER: "bogus" }));
    expect(summary.mode).toBe("disabled");
    expect(summary.requestedMode).toBe("bogus");
    expect(summary.disabledReason).toMatch(/AI_PROVIDER/);
  });
});

describe("network locality", () => {
  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["192.168.68.115", true],
    ["10.1.2.3", true],
    ["172.20.0.5", true],
    ["100.100.1.1", true],
    ["[::1]", true],
    ["[fd12:3456::1]", true],
    ["omlx", true],
    ["mac-studio.local", true],
    ["api.openai.com", false],
    ["8.8.8.8", false],
    ["172.32.0.1", false],
    ["[2001:db8::1]", false],
  ])("%s private=%s", (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });
});

describe("checkAiConfig on hand-built configs", () => {
  it("a misconfigured service answers misconfigured without throwing", async () => {
    const service = createAiService({ mode: "omlx", timeoutMs: 1000, allowCloudDocuments: false });
    const result = await service.interpretTransactions([{ id: "a", description: "X", amount: "-1", currency: "EUR" }]);
    expect(result).toMatchObject({ ok: false, error: { code: "misconfigured", retryable: false } });
    expect(checkAiConfig({ mode: "omlx", timeoutMs: 1000, allowCloudDocuments: false }).ok).toBe(false);
  });
});
