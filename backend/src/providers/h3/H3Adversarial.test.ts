import { describe, expect, it, vi } from "vitest";
import { ProviderRateLimiter } from "../http/providerRateLimiter.js";
import { H3FakeScheduler } from "./H3FakeScheduler.js";

describe("H3 adversarial scheduler behavior", () => {
  it("rejects a conflicting positive cap without discarding its previous reservation", async () => {
    const time = new H3FakeScheduler();
    const limiter = new ProviderRateLimiter(time.clock, time.sleep);
    await limiter.waitForSlot("MOCK", 1);
    await expect(limiter.waitForSlot("MOCK", 2)).rejects.toMatchObject({
      code: "ADMISSION_INVALID_CONFIG",
    });
    let admitted = false;
    const pending = limiter.waitForSlot("MOCK", 1).then(() => {
      admitted = true;
    });
    await time.flush();
    expect(admitted).toBe(false);
    await time.advance(60_000);
    await pending;
  });
  it("cleans real wake timers and abort listeners when the last waiter cancels", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new ProviderRateLimiter(() => 0);
      await limiter.waitForSlot("MOCK", 1);
      const controller = new AbortController();
      const pending = limiter
        .waitForSlot("MOCK", 1, { signal: controller.signal })
        .catch((error) => error.code);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      expect(await pending).toBe("ADMISSION_CANCELLED");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("checks a deadline again at immediate admission and bounds a throwing clock", async () => {
    const samples = [0, 0, 10];
    const limiter = new ProviderRateLimiter(() => samples.shift() ?? 10);
    await expect(limiter.waitForSlot("MOCK", 1, { maxQueueWaitMs: 5 })).rejects.toMatchObject({
      code: "ADMISSION_DEADLINE",
    });
    expect((await limiter.waitForSlot("MOCK", 1)).delayed).toBe(false);
    await expect(
      new ProviderRateLimiter(() => {
        throw new Error("private clock details");
      }).waitForSlot("MOCK", 1),
    ).rejects.toMatchObject({
      code: "ADMISSION_INVALID_CLOCK",
      message: "ADMISSION_INVALID_CLOCK",
    });
  });
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid queue bound %s",
    (bound) => {
      expect(
        () =>
          new ProviderRateLimiter(
            () => 0,
            async () => undefined,
            bound,
          ),
      ).toThrow("ADMISSION_INVALID_CONFIG");
    },
  );
  it("bounds a sleeper that repeatedly resolves without advancing time", async () => {
    const sleep = vi.fn(async () => undefined);
    const limiter = new ProviderRateLimiter(() => 0, sleep);
    await limiter.waitForSlot("MOCK", 1);
    await expect(limiter.waitForSlot("MOCK", 1)).rejects.toMatchObject({
      code: "ADMISSION_SCHEDULER_FAILED",
    });
    expect(sleep).toHaveBeenCalledTimes(2);
  });
  it.each([-1, NaN, Infinity])(
    "rejects invalid clock sample %s without stranding its queue",
    async (sample) => {
      const time = new H3FakeScheduler();
      const limiter = new ProviderRateLimiter(time.clock, time.sleep);
      await limiter.waitForSlot("MOCK", 1);
      const result = limiter.waitForSlot("MOCK", 1).catch((error) => error.code);
      time.now = sample;
      await time.wakeEarly();
      expect(await result).toBe("ADMISSION_INVALID_CLOCK");
      expect(time.pendingTimers).toBe(0);
    },
  );
  it("rejects a backwards monotonic clock", async () => {
    const time = new H3FakeScheduler();
    time.now = 10;
    const limiter = new ProviderRateLimiter(time.clock, time.sleep);
    await limiter.waitForSlot("MOCK", 1);
    const result = limiter.waitForSlot("MOCK", 1).catch((error) => error.code);
    time.now = 9;
    await time.wakeEarly();
    expect(await result).toBe("ADMISSION_INVALID_CLOCK");
  });
  it("preserves FIFO when an admitted caller immediately submits a newcomer", async () => {
    const time = new H3FakeScheduler();
    const limiter = new ProviderRateLimiter(time.clock, time.sleep);
    await limiter.waitForSlot("MOCK", 1);
    const order: string[] = [];
    let newcomer: Promise<void> | undefined;
    const first = limiter.waitForSlot("MOCK", 1).then(() => {
      order.push("first");
      newcomer = limiter.waitForSlot("MOCK", 1).then(() => {
        order.push("new");
      });
    });
    const second = limiter.waitForSlot("MOCK", 1).then(() => {
      order.push("second");
    });
    await time.advance(60_000);
    expect(order).toEqual(["first"]);
    await time.advance(60_000);
    expect(order).toEqual(["first", "second"]);
    await time.advance(60_000);
    await Promise.all([first, second, newcomer]);
    expect(order).toEqual(["first", "second", "new"]);
  });
  it("middle/tail cancellation frees the global bound without disturbing the head", async () => {
    const time = new H3FakeScheduler();
    const limiter = new ProviderRateLimiter(time.clock, time.sleep, 3);
    await limiter.waitForSlot("MOCK", 1);
    await limiter.waitForSlot("JUPITER", 1);
    const head = limiter.waitForSlot("MOCK", 1);
    const middle = new AbortController(),
      tail = new AbortController();
    const removed = [middle, tail].map((controller) =>
      limiter.waitForSlot("MOCK", 1, { signal: controller.signal }).catch((error) => error.code),
    );
    await expect(limiter.waitForSlot("JUPITER", 1)).rejects.toMatchObject({
      code: "ADMISSION_QUEUE_FULL",
    });
    middle.abort();
    tail.abort();
    const independent = limiter.waitForSlot("JUPITER", 1);
    expect(await Promise.all(removed)).toEqual(["ADMISSION_CANCELLED", "ADMISSION_CANCELLED"]);
    await time.advance(60_001);
    expect((await head).waitedMs).toBe(60_001);
    await independent;
    expect(time.pendingTimers).toBe(0);
  });
  it("ignores stale callbacks from a non-cancellable legacy sleeper", async () => {
    const wakes: (() => void)[] = [];
    let now = 0;
    const limiter = new ProviderRateLimiter(
      () => now,
      () => new Promise<void>((resolve) => wakes.push(resolve)),
    );
    await limiter.waitForSlot("MOCK", 1);
    const controller = new AbortController();
    const cancelled = limiter
      .waitForSlot("MOCK", 1, { signal: controller.signal })
      .catch((error) => error.code);
    controller.abort();
    await cancelled;
    let admitted = false;
    const pending = limiter.waitForSlot("MOCK", 1).then(() => {
      admitted = true;
    });
    wakes[0]!();
    await Promise.resolve();
    expect(admitted).toBe(false);
    now = 60_000;
    wakes[1]!();
    await pending;
    expect(admitted).toBe(true);
  });
});
