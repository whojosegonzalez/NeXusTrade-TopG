import { afterEach, describe, expect, it, vi } from "vitest";

import { JupiterDemandController } from "./JupiterDemandController.js";

const config = {
  enabled: true,
  windowMs: 60_000,
  maxLiveRequestsPerWindow: 2,
  baseMinIntervalMs: 1_000,
  maxIntervalMs: 8_000,
  adaptiveEnabled: true,
  rateLimitMultiplier: 2,
  successDecayCount: 2,
  maxLowPriorityRequestsPerWindow: 1,
  deferLowPriorityFirst: true,
  respectRetryAfter: true,
} as const;

describe("JupiterDemandController", () => {
  afterEach(() => vi.useRealTimers());

  it("shares one budget across price and quote work", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const controller = new JupiterDemandController(config);

    expect(controller.tryAcquire({ operation: "PRICE", priority: "LOW" }).allowed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(controller.tryAcquire({ operation: "QUOTE", priority: "HIGH" }).allowed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(controller.tryAcquire({ operation: "QUOTE", priority: "HIGH" })).toMatchObject({
      allowed: false,
      action: "DEFERRED_WINDOW_BUDGET",
    });
  });

  it("defers low priority work before consuming reserved high priority capacity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const controller = new JupiterDemandController(config);

    expect(controller.tryAcquire({ operation: "PRICE", priority: "LOW" }).allowed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(controller.tryAcquire({ operation: "PRICE", priority: "LOW" })).toMatchObject({
      allowed: false,
      action: "DEFERRED_LOW_PRIORITY_BUDGET",
    });
    expect(controller.tryAcquire({ operation: "QUOTE", priority: "HIGH" }).allowed).toBe(true);
  });

  it("raises and gradually decays its effective interval after live outcomes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const controller = new JupiterDemandController(config);

    controller.tryAcquire({ operation: "QUOTE", priority: "HIGH" });
    expect(controller.recordLiveOutcome({ rateLimited: true, retryAfterMs: 3_000 })).toMatchObject({
      adaptiveLevel: 1,
      effectiveIntervalMs: 2_000,
      liveRateLimitObserved: true,
    });

    vi.advanceTimersByTime(3_000);
    controller.tryAcquire({ operation: "QUOTE", priority: "HIGH" });
    controller.recordLiveOutcome({ rateLimited: false });
    vi.advanceTimersByTime(2_000);
    controller.tryAcquire({ operation: "QUOTE", priority: "HIGH" });
    expect(controller.recordLiveOutcome({ rateLimited: false })).toMatchObject({
      adaptiveLevel: 0,
      effectiveIntervalMs: 1_000,
    });
  });

  it("allows requests unchanged when disabled", () => {
    const controller = new JupiterDemandController({ ...config, enabled: false });

    expect(controller.tryAcquire({ operation: "PRICE", priority: "LOW" }).allowed).toBe(true);
    expect(controller.tryAcquire({ operation: "QUOTE", priority: "HIGH" }).allowed).toBe(true);
  });

  it("paces normal-priority requests in FIFO order instead of dropping a same-cycle batch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    const controller = new JupiterDemandController(config);

    const first = controller.acquire({ operation: "QUOTE", priority: "NORMAL" });
    await expect(first).resolves.toMatchObject({ allowed: true });

    const second = controller.acquire({ operation: "QUOTE", priority: "NORMAL" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toMatchObject({ allowed: true, action: "LIVE_ALLOWED" });
  });
});
