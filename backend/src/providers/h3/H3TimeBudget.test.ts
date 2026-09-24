import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTokenMintAddress } from "@nexustrade/shared";
import { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { ProviderRateLimiter } from "../http/providerRateLimiter.js";
import { BirdeyeAdapter } from "../birdeye/BirdeyeAdapter.js";
import { BirdeyeBudgetTracker } from "../birdeye/BirdeyeBudgetTracker.js";
import { BirdeyeCache } from "../birdeye/BirdeyeCache.js";
import { H3FakeScheduler } from "./H3FakeScheduler.js";
import { createProviderConfig } from "../config/providerConfig.js";

describe("H3 legacy time and budget characterization", () => {
  afterEach(() => vi.useRealTimers());
  it("preserves configured RPM, retry and Birdeye budget defaults", () => {
    const config = createProviderConfig({});
    expect(config.rateLimitsPerMinute).toEqual({
      ALCHEMY_DAS: 60,
      BIRDEYE: 60,
      DEXSCREENER: 300,
      HELIUS: 60,
      JUPITER: 60,
      MOCK: 60000,
      QUICKNODE_DAS: 60,
      RAYDIUM: 60,
      RUGCHECK: 60,
      SOLANA_RPC: 120,
    });
    expect(config.maxRetries).toBe(2);
    expect(config.retryBackoffMs).toBe(250);
    expect(config.birdeye).toMatchObject({ maxRequestsPerRun: 60, maxCuPerRun: 1200 });
  });
  it("retains invocation fetchedAt and headers latency while excluding delayed body reading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const time = new H3FakeScheduler();
    const limiter = new ProviderRateLimiter(time.clock, time.sleep);
    await limiter.waitForSlot("MOCK", 1);
    let headers!: (response: Response) => void, body!: (value: string) => void;
    const response = new Response("{}");
    vi.spyOn(response, "text").mockImplementation(
      () =>
        new Promise((resolve) => {
          body = resolve;
        }),
    );
    const client = new ProviderHttpClient({
      provider: "MOCK",
      baseUrl: "https://example.test",
      timeoutMs: 1000,
      rateLimitPerMinute: 1,
      rateLimiter: limiter,
      fetchImpl: () =>
        new Promise((resolve) => {
          headers = resolve;
        }),
    });
    const pending = client.getJson();
    vi.setSystemTime(160_000);
    await time.advance(60_000);
    vi.setSystemTime(160_020);
    headers(response);
    await time.flush();
    vi.setSystemTime(160_090);
    body('{"value":1}');
    const result = await pending;
    expect(result.fetchedAt.getTime()).toBe(100_000);
    expect(result.latencyMs).toBe(60_020);
    expect(result.httpAttempts?.[0]?.rateLimiterWaitMs).toBe(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("wall-clock jumps do not grant monotonic capacity and caught body failures include elapsed body time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const time = new H3FakeScheduler();
    const limiter = new ProviderRateLimiter(time.clock, time.sleep);
    await limiter.waitForSlot("MOCK", 1);
    let reject!: (error: Error) => void;
    const response = new Response("{}");
    vi.spyOn(response, "text").mockImplementation(
      () =>
        new Promise((_resolve, rejectBody) => {
          reject = rejectBody;
        }),
    );
    const fetchImpl = vi.fn(async () => response);
    const client = new ProviderHttpClient({
      provider: "MOCK",
      baseUrl: "https://example.test",
      timeoutMs: 1000,
      rateLimitPerMinute: 1,
      rateLimiter: limiter,
      fetchImpl,
    });
    const pending = client.getJson();
    vi.setSystemTime(1_000_000);
    await time.wakeEarly();
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.setSystemTime(160_000);
    await time.advance(60_000);
    vi.setSystemTime(160_090);
    reject(new Error("body failed"));
    const result = await pending;
    expect(result.latencyMs).toBe(60_090);
    expect(result.fetchedAt.getTime()).toBe(100_000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves text fallback for malformed JSON rather than inventing a parse failure", async () => {
    const client = new ProviderHttpClient({
      provider: "MOCK",
      baseUrl: "https://example.test",
      timeoutMs: 1000,
      rateLimitPerMinute: 1,
      fetchImpl: async () => new Response("not JSON"),
    });
    const result = await client.getJson();
    expect(result.ok && result.data).toBe("not JSON");
  });
  it("reserves once for a Birdeye cache miss with retries and never bills cache hits", async () => {
    const budget = new BirdeyeBudgetTracker({ maxRequestsPerRun: 1, maxCuPerRun: 100 });
    let calls = 0;
    const adapter = new BirdeyeAdapter({
      httpClient: new ProviderHttpClient({
        provider: "BIRDEYE",
        baseUrl: "https://example.test",
        timeoutMs: 1000,
        rateLimitPerMinute: 0,
        fetchImpl: async () => {
          calls++;
          return calls === 1
            ? new Response("{}", { status: 429 })
            : new Response(JSON.stringify({ success: true, data: { value: 175.5 } }));
        },
      }),
      maxRetries: 1,
      retryBackoffMs: 0,
      allowRawPayloadLogging: false,
      priceEnabled: true,
      tokenOverviewEnabled: true,
      cacheEnabled: true,
      overviewFrames: ["1m", "5m"],
      budget,
      cache: new BirdeyeCache({ ttlMs: 300_000 }),
    });
    const mint = parseTokenMintAddress("So11111111111111111111111111111111111111112");
    const first = await adapter.getPrice(mint);
    expect(first.ok).toBe(true);
    expect(calls).toBe(2);
    const snapshot = budget.snapshot();
    expect(snapshot.requestsUsed).toBe(1);
    expect(snapshot.cuUsed).toBeGreaterThan(0);
    const cached = await adapter.getPrice(mint);
    expect(cached.warnings).toContain("Birdeye cache hit.");
    expect(cached.fetchedAt).toEqual(first.fetchedAt);
    expect(cached.latencyMs).toBe(0);
    expect(budget.snapshot()).toEqual(snapshot);
    expect(calls).toBe(2);
    const refused = await adapter.getPrice(
      parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    );
    expect(refused.ok).toBe(false);
    expect(calls).toBe(2);
    // Legacy adapter mapping can drop successful HTTP attempt records; wire count is the fake transport count.
    expect(first.httpAttempts).toHaveLength(1);
    expect(cached.httpAttempts ?? []).toHaveLength(0);
  });
});
