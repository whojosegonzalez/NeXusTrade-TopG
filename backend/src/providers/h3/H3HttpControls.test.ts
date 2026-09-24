import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";
import { ProviderHttpClient } from "../http/ProviderHttpClient.js";
import { ProviderRateLimiter } from "../http/providerRateLimiter.js";
import { withProviderRetries } from "../http/providerRetry.js";
import { H3FakeScheduler } from "./H3FakeScheduler.js";

function fixture(fetchImpl: typeof fetch = async () => new Response("{}")) {
  const scheduler = new H3FakeScheduler();
  const limiter = new ProviderRateLimiter(scheduler.clock, scheduler.sleep, 1);
  const transport = vi.fn(fetchImpl);
  const client = new ProviderHttpClient({
    provider: "MOCK",
    baseUrl: "https://example.test",
    timeoutMs: 100,
    rateLimitPerMinute: 1,
    rateLimiter: limiter,
    fetchImpl: transport,
  });
  return { scheduler, limiter, transport, client };
}

describe("H3 HTTP controls and retries", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["success", "network", "http400", "http429", "body"] as const)(
    "cleans caller listeners and transport timers after %s",
    async (kind) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const fetchImpl: typeof fetch = async () => {
        if (kind === "network") throw new TypeError("synthetic network failure");
        const response = new Response("{}", {
          status: kind === "http400" ? 400 : kind === "http429" ? 429 : 200,
        });
        if (kind === "body")
          vi.spyOn(response, "text").mockRejectedValue(new Error("synthetic body failure"));
        return response;
      };
      const { client } = fixture(fetchImpl);
      const result = await client.getJson({ signal: controller.signal });
      expect(result.httpAttempts).toHaveLength(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains retryable network behavior and stops on nonretryable HTTP errors", async () => {
    let count = 0;
    const fetchImpl = vi.fn(async () => {
      count++;
      if (count === 1) throw new TypeError("synthetic network failure");
      return new Response("{}", { status: 400 });
    });
    const client = new ProviderHttpClient({
      provider: "MOCK",
      baseUrl: "https://example.test",
      timeoutMs: 1000,
      rateLimitPerMinute: 0,
      fetchImpl,
    });
    const result = await withProviderRetries(() => client.getJson(), {
      maxRetries: 4,
      retryBackoffMs: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.httpAttempts?.map((item) => [item.attemptNumber, item.outcome])).toEqual([
      [1, "NETWORK_ERROR"],
      [2, "HTTP_ERROR"],
    ]);
  });

  it("timeout wins when it precedes caller cancellation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { client, scheduler } = fixture(() => new Promise<Response>(() => undefined));
    const pending = client.getJson({ signal: controller.signal });
    await scheduler.flush();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    const result = await pending;
    expect(result.ok ? undefined : result.error.code).toBe("TIMEOUT");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects cancellation without a retry provider before invoking the operation", async () => {
    const { client } = fixture();
    const operation = vi.fn(() => client.getJson());
    await expect(
      withProviderRetries(operation, {
        signal: AbortSignal.abort(),
        maxRetries: 1,
        retryBackoffMs: 0,
      }),
    ).rejects.toMatchObject({ code: "ADMISSION_INVALID_CONFIG" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects pre-abort and invalid waits without dispatch or retries", async () => {
    const { client, transport } = fixture();
    for (const options of [
      { signal: AbortSignal.abort() },
      { maxQueueWaitMs: 0 },
      { maxQueueWaitMs: -1 },
      { maxQueueWaitMs: Number.NaN },
    ]) {
      const operation = vi.fn(() => client.getJson(options));
      const result = await withProviderRetries(operation, { maxRetries: 3, retryBackoffMs: 0 });
      expect(result.ok).toBe(false);
      expect(result.httpAttempts).toEqual([]);
      expect(result.ok ? undefined : result.error.retryable).toBe(false);
      expect(operation).toHaveBeenCalledTimes(1);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("queue-full and queued deadline never manufacture an HTTP attempt", async () => {
    const { client, transport, scheduler, limiter } = fixture();
    await limiter.waitForSlot("MOCK", 1);
    const pending = client.getJson({ maxQueueWaitMs: 10 });
    const full = await client.getJson();
    expect(full.diagnostics).toMatchObject({ admissionControl: "ADMISSION_QUEUE_FULL" });
    expect(full.httpAttempts).toEqual([]);
    await scheduler.advance(10);
    const expired = await pending;
    expect(expired.diagnostics).toMatchObject({ admissionControl: "ADMISSION_DEADLINE" });
    expect(expired.httpAttempts).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(scheduler.pendingTimers).toBe(0);
  });

  it("cancels a queued request and clears its wake without dispatch", async () => {
    const { client, transport, scheduler, limiter } = fixture();
    await limiter.waitForSlot("MOCK", 1);
    const controller = new AbortController();
    const pending = client.getJson({ signal: controller.signal });
    controller.abort();
    expect((await pending).httpAttempts).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
    expect(scheduler.pendingTimers).toBe(0);
  });

  it("abort after synchronous admission prevents fetch without refunding the slot", async () => {
    const { client, transport, scheduler } = fixture();
    const controller = new AbortController();
    const admitted = client.getJson({ signal: controller.signal });
    controller.abort();
    expect((await admitted).httpAttempts).toEqual([]);
    const next = client.getJson();
    await scheduler.flush();
    expect(transport).not.toHaveBeenCalled();
    await scheduler.advance(60_000);
    expect((await next).ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("in-flight abort settles even an uncooperative transport and clears timeout", async () => {
    vi.useFakeTimers();
    const { client, transport, scheduler } = fixture(() => new Promise<Response>(() => undefined));
    const controller = new AbortController();
    const pending = client.getJson({ signal: controller.signal });
    await scheduler.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    controller.abort();
    const result = await pending;
    expect(result.diagnostics).toMatchObject({ admissionControl: "ADMISSION_CANCELLED" });
    expect(result.httpAttempts).toHaveLength(1);
    expect(result.ok ? undefined : result.error.retryable).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("body-read cancellation settles and consumes a later body rejection", async () => {
    vi.useFakeTimers();
    let rejectBody!: (reason: Error) => void;
    const response = new Response("{}");
    vi.spyOn(response, "text").mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectBody = reject;
        }),
    );
    const { client, scheduler } = fixture(async () => response);
    const controller = new AbortController();
    const pending = client.getJson({ signal: controller.signal });
    await scheduler.flush();
    controller.abort();
    expect((await pending).httpAttempts).toHaveLength(1);
    rejectBody(new Error("late body failure"));
    await scheduler.flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts transport timeout only after queue admission", async () => {
    vi.useFakeTimers();
    const { client, limiter, scheduler, transport } = fixture(
      () => new Promise<Response>(() => undefined),
    );
    await limiter.waitForSlot("MOCK", 1);
    const pending = client.getJson();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.advance(60_000);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.ok ? undefined : result.error.code).toBe("TIMEOUT");
    expect(result.httpAttempts).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("429 retries reacquire admission and preserve linear backoff and numbering", async () => {
    const { client, transport, scheduler } = fixture(
      async () => new Response("{}", { status: 429 }),
    );
    const sleep = vi.fn(async () => undefined);
    const pending = withProviderRetries(() => client.getJson(), {
      maxRetries: 2,
      retryBackoffMs: 7,
      sleep,
    });
    // Flush response parsing and the retry loop until the next admission queues.
    for (let i = 0; i < 4; i++) await scheduler.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    await scheduler.advance(60_000);
    for (let i = 0; i < 4; i++) await scheduler.flush();
    expect(transport).toHaveBeenCalledTimes(2);
    await scheduler.advance(60_000);
    const result = await pending;
    expect(transport).toHaveBeenCalledTimes(3);
    expect(result.httpAttempts?.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3]);
    expect(sleep.mock.calls).toEqual([[7], [14]]);
  });

  it("cancels retry backoff promptly, preserves the real attempt and clears its timer", async () => {
    vi.useFakeTimers();
    const { client, transport, scheduler } = fixture(
      async () => new Response("{}", { status: 429 }),
    );
    const controller = new AbortController();
    const pending = withProviderRetries(() => client.getJson({ signal: controller.signal }), {
      provider: "MOCK",
      signal: controller.signal,
      maxRetries: 3,
      retryBackoffMs: 1000,
    });
    for (let i = 0; i < 4; i++) await scheduler.flush();
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    const result = await pending;
    expect(result.diagnostics).toMatchObject({ admissionControl: "ADMISSION_CANCELLED" });
    expect(result.httpAttempts).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pre-aborted retry reports its explicit provider with no operation", async () => {
    const { client } = fixture();
    const operation = vi.fn(() => client.getJson());
    const result = await withProviderRetries(operation, {
      provider: "MOCK",
      signal: AbortSignal.abort(),
      maxRetries: 2,
      retryBackoffMs: 10,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(result.provider).toBe("MOCK");
    expect(result.httpAttempts).toEqual([]);
  });
});
