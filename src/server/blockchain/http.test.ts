import { describe, expect, it } from "vitest";
import { fromBaseUnits } from "@/domain/money/decimal";
import { mapWithConcurrency, parseJsonPreservingNumbers, requestJson } from "./http";
import { parseResponse, providerErrorFactory, zBaseUnits, zDecimalString, zHexQuantity } from "./shared";
import { fakeFetch, hangingFetch, jsonResponse } from "./testing/fake-fetch";
import { BlockchainProviderError } from "./types";
import { z } from "zod";

const toError = providerErrorFactory("test", "ethereum");
const SECRET_URL = "https://api.example.test/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045?apikey=SUPERSECRET";

async function failure(p: Promise<unknown>): Promise<BlockchainProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BlockchainProviderError);
    const err = e as BlockchainProviderError;
    expect(err.message).not.toContain("SUPERSECRET");
    expect(err.message).not.toContain("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    return err;
  }
  throw new Error("expected rejection");
}

describe("parseJsonPreservingNumbers", () => {
  it("keeps every JSON number as its exact source text", () => {
    const parsed = parseJsonPreservingNumbers(
      '{"wei":123456789012345678901234567890,"price":0.1,"tiny":1e-7,"list":[21000000,-3.50]}',
    );
    expect(parsed).toEqual({ wei: "123456789012345678901234567890", price: "0.1", tiny: "1e-7", list: ["21000000", "-3.50"] });
  });
});

describe("unit conversion (never via floats)", () => {
  it("converts wei to ETH exactly with 18 decimals", () => {
    expect(fromBaseUnits(1_000_000_000_000_000_000n, 18)).toBe("1");
    expect(fromBaseUnits(1_234_567_890_123_456_789n, 18)).toBe("1.234567890123456789");
    expect(fromBaseUnits(1n, 18)).toBe("0.000000000000000001");
    expect(fromBaseUnits(123_456_789_012_345_678_901_234_567_890n, 18)).toBe("123456789012.34567890123456789");
  });

  it("converts sats to BTC exactly with 8 decimals", () => {
    expect(fromBaseUnits(1n, 8)).toBe("0.00000001");
    expect(fromBaseUnits(2_100_000_000_000_000n, 8)).toBe("21000000");
    expect(fromBaseUnits(4_248_590n, 8)).toBe("0.0424859");
  });

  it("parses base-unit and hex quantities to bigint", () => {
    expect(zBaseUnits.parse("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
    expect(zBaseUnits.parse(42)).toBe(42n);
    expect(zBaseUnits.safeParse("-1").success).toBe(false);
    expect(zBaseUnits.safeParse("1.5").success).toBe(false);
    expect(zBaseUnits.safeParse(1.5).success).toBe(false);
    expect(zHexQuantity.parse("0xde0b6b3a7640000")).toBe(10n ** 18n);
    expect(zHexQuantity.parse("0x")).toBe(0n);
    expect(zDecimalString.parse("1e-7")).toBe("0.0000001");
    expect(zDecimalString.parse("65432.10")).toBe("65432.1");
  });
});

describe("requestJson", () => {
  it("returns parsed JSON on success and sends JSON bodies for POST", async () => {
    const f = fakeFetch(() => jsonResponse({ ok: 1 }));
    await expect(
      requestJson("https://x.test/a", { fetchImpl: f, timeoutMs: 1000, method: "POST", body: { a: 1 } }, toError),
    ).resolves.toEqual({ ok: "1" });
    expect(f.calls[0]).toMatchObject({ method: "POST", body: { a: 1 } });
    expect(f.calls[0]!.headers["content-type"]).toBe("application/json");
    // Redirects are refused so header-borne API keys can never be forwarded to another origin.
    expect(f.calls[0]!.redirect).toBe("error");
  });

  it("maps 429 to rate_limited with Retry-After", async () => {
    const f = fakeFetch(() => jsonResponse({ error: "slow down" }, 429, { "retry-after": "30" }));
    const err = await failure(requestJson(SECRET_URL, { fetchImpl: f, timeoutMs: 1000 }, toError));
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.status).toBe(429);
  });

  it("maps 404 to not_found and 5xx to network", async () => {
    expect((await failure(requestJson(SECRET_URL, { fetchImpl: fakeFetch(() => jsonResponse({}, 404)), timeoutMs: 1000 }, toError))).code).toBe("not_found");
    const err = await failure(requestJson(SECRET_URL, { fetchImpl: fakeFetch(() => jsonResponse({}, 502)), timeoutMs: 1000 }, toError));
    expect(err).toMatchObject({ code: "network", status: 502 });
  });

  it("maps malformed JSON to invalid_response", async () => {
    const f = fakeFetch(() => new Response("<html>oops", { status: 200 }));
    expect((await failure(requestJson(SECRET_URL, { fetchImpl: f, timeoutMs: 1000 }, toError))).code).toBe("invalid_response");
  });

  it("maps a thrown fetch to network", async () => {
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed for ${SECRET_URL}`);
    });
    expect((await failure(requestJson(SECRET_URL, { fetchImpl: f, timeoutMs: 1000 }, toError))).code).toBe("network");
  });

  it("times out via AbortController", async () => {
    const err = await failure(requestJson(SECRET_URL, { fetchImpl: hangingFetch(), timeoutMs: 20 }, toError));
    expect(err.code).toBe("timeout");
  });

  it("honours a caller abort signal", async () => {
    const controller = new AbortController();
    const p = requestJson(SECRET_URL, { fetchImpl: hangingFetch(), timeoutMs: 5000, signal: controller.signal }, toError);
    controller.abort();
    expect((await failure(p)).code).toBe("aborted");
  });

  it("parseResponse throws invalid_response without echoing the payload", () => {
    try {
      parseResponse(z.object({ a: z.string() }), { b: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, "test");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as BlockchainProviderError).code).toBe("invalid_response");
      expect((e as Error).message).not.toContain("0xd8dA");
    }
  });
});

describe("mapWithConcurrency", () => {
  it("preserves order and bounds concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
