import { describe, expect, it } from "vitest";
import { ProviderRateLimiter } from "../http/providerRateLimiter.js";
import { H3FakeScheduler } from "./H3FakeScheduler.js";

describe("H3 limiter queue controls", () => {
  it("preserves FIFO across multiple windows and independent providers", async () => {
    const time = new H3FakeScheduler(),
      limiter = new ProviderRateLimiter(time.clock, time.sleep);
    await limiter.waitForSlot("MOCK", 2);
    await limiter.waitForSlot("MOCK", 2);
    const order: number[] = [];
    const work = [0, 1, 2, 3, 4].map((i) =>
      limiter.waitForSlot("MOCK", 2).then(() => order.push(i)),
    );
    expect(time.pendingTimers).toBe(1);
    await expect(limiter.waitForSlot("JUPITER", 1)).resolves.toEqual({
      waitedMs: 0,
      delayed: false,
    });
    await time.advance(59_999);
    expect(order).toEqual([]);
    await time.advance(1);
    expect(order).toEqual([0, 1]);
    await time.advance(60_000);
    expect(order).toEqual([0, 1, 2, 3]);
    await time.advance(60_000);
    await Promise.all(work);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(time.pendingTimers).toBe(0);
  });
  it("cancels a queued head without consuming capacity or stranding the next caller", async () => {
    const time = new H3FakeScheduler(),
      limiter = new ProviderRateLimiter(time.clock, time.sleep),
      controller = new AbortController();
    await limiter.waitForSlot("MOCK", 1);
    const cancelled = limiter
      .waitForSlot("MOCK", 1, { signal: controller.signal })
      .catch((error) => error.code);
    const next = limiter.waitForSlot("MOCK", 1);
    controller.abort();
    expect(await cancelled).toBe("ADMISSION_CANCELLED");
    await time.advance(60_000);
    expect(await next).toEqual({ waitedMs: 60_000, delayed: true });
    expect(time.pendingTimers).toBe(0);
  });
  it("expires at the deadline before granting newly available capacity", async () => {
    const time = new H3FakeScheduler(),
      limiter = new ProviderRateLimiter(time.clock, time.sleep);
    await limiter.waitForSlot("MOCK", 1);
    const expired = limiter
      .waitForSlot("MOCK", 1, { maxQueueWaitMs: 60_000 })
      .catch((error) => error.code);
    await time.advance(60_000);
    expect(await expired).toBe("ADMISSION_DEADLINE");
    expect(await limiter.waitForSlot("MOCK", 1)).toEqual({ waitedMs: 0, delayed: false });
    expect(time.pendingTimers).toBe(0);
  });
  it("cleans the wake when every waiter cancels and preserves the prior reservation", async () => {
    const time = new H3FakeScheduler(),
      limiter = new ProviderRateLimiter(time.clock, time.sleep),
      controller = new AbortController();
    await limiter.waitForSlot("MOCK", 1);
    const pending = limiter
      .waitForSlot("MOCK", 1, { signal: controller.signal })
      .catch((error) => error.code);
    controller.abort();
    expect(await pending).toBe("ADMISSION_CANCELLED");
    expect(time.pendingTimers).toBe(0);
    const next = limiter.waitForSlot("MOCK", 1);
    expect(time.pendingTimers).toBe(1);
    await time.advance(60_000);
    await next;
  });
  it("enforces the queue bound and admits other providers without using queue capacity", async () => {
    const time = new H3FakeScheduler(),
      limiter = new ProviderRateLimiter(time.clock, time.sleep, 1);
    await limiter.waitForSlot("MOCK", 1);
    const pending = limiter.waitForSlot("MOCK", 1);
    await expect(limiter.waitForSlot("MOCK", 1)).rejects.toMatchObject({
      code: "ADMISSION_QUEUE_FULL",
    });
    await expect(limiter.waitForSlot("JUPITER", 1)).resolves.toMatchObject({ delayed: false });
    await time.advance(60_000);
    await pending;
  });
  it("rechecks early wakes and reports actual late elapsed wait", async () => {
    const time = new H3FakeScheduler(),
      limiter = new ProviderRateLimiter(time.clock, time.sleep);
    await limiter.waitForSlot("MOCK", 1);
    let complete = false;
    const pending = limiter.waitForSlot("MOCK", 1).then((result) => {
      complete = true;
      return result;
    });
    await time.wakeEarly();
    expect(complete).toBe(false);
    expect(time.pendingTimers).toBe(1);
    await time.advance(70_000);
    expect(await pending).toEqual({ waitedMs: 70_000, delayed: true });
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid cap %s",
    async (cap) => {
      await expect(new ProviderRateLimiter().waitForSlot("MOCK", cap)).rejects.toMatchObject({
        code: "ADMISSION_INVALID_CONFIG",
      });
    },
  );
  it("binds unlimited mode and rejects conflicting later caps", async () => {
    const limiter = new ProviderRateLimiter();
    await limiter.waitForSlot("MOCK", 0);
    await expect(limiter.waitForSlot("MOCK", 1)).rejects.toMatchObject({
      code: "ADMISSION_INVALID_CONFIG",
    });
  });
  it("rejects pre-aborted and zero-wait deadline requests before reservation", async () => {
    const limiter = new ProviderRateLimiter();
    const controller = new AbortController();
    controller.abort();
    await expect(
      limiter.waitForSlot("MOCK", 1, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "ADMISSION_CANCELLED" });
    await expect(limiter.waitForSlot("MOCK", 1, { maxQueueWaitMs: 0 })).rejects.toMatchObject({
      code: "ADMISSION_DEADLINE",
    });
    expect(await limiter.waitForSlot("MOCK", 1)).toMatchObject({ delayed: false });
  });
  it("settles a queued request when its scheduler rejects", async () => {
    const limiter = new ProviderRateLimiter(
      () => 0,
      async () => {
        throw new Error("scheduler unavailable");
      },
    );
    await limiter.waitForSlot("MOCK", 1);
    await expect(limiter.waitForSlot("MOCK", 1)).rejects.toMatchObject({
      code: "ADMISSION_SCHEDULER_FAILED",
    });
  });
});
