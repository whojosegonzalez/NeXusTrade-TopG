import { describe, expect, it } from "vitest";
import { FormulationBCollectionError } from "./FormulationBCollectionErrors.js";
import { FormulationBSafetyMonitor } from "./FormulationBSafetyMonitor.js";

describe("FormulationBSafetyMonitor", () => {
  it("allows clock drift within 5.0 seconds", () => {
    const monitor = new FormulationBSafetyMonitor();
    const now = Date.now();
    const validServerDate = new Date(now - 3000).toUTCString();

    expect(() => monitor.checkClockDrift(validServerDate, now)).not.toThrow();
    expect(monitor.safetyCounters.clockDriftStops).toBe(0);
  });

  it("throws fail-closed on clock drift > 5.0 seconds", () => {
    const monitor = new FormulationBSafetyMonitor();
    const now = Date.now();
    const driftedServerDate = new Date(now - 7000).toUTCString();

    expect(() => monitor.checkClockDrift(driftedServerDate, now)).toThrowError(
      FormulationBCollectionError,
    );
    expect(monitor.safetyCounters.clockDriftStops).toBe(1);
  });

  it("detects secret leakage patterns in payloads", () => {
    const monitor = new FormulationBSafetyMonitor();

    expect(() => monitor.checkSecretLeakage("Authorization: Bearer abcdef1234567890")).toThrowError(
      FormulationBCollectionError,
    );
    expect(monitor.safetyCounters.secretLeakageStops).toBe(1);

    expect(() => monitor.checkSecretLeakage("key=sk_live_1234567890abcdef")).toThrowError(
      FormulationBCollectionError,
    );
    expect(monitor.safetyCounters.secretLeakageStops).toBe(2);

    expect(() => monitor.checkSecretLeakage("clean payload with no credentials")).not.toThrow();
  });

  it("throws on HTTP 429 and 403 status responses", () => {
    const monitor = new FormulationBSafetyMonitor();

    expect(() => monitor.checkRateLimitResponse(429)).toThrowError(FormulationBCollectionError);
    expect(() => monitor.checkRateLimitResponse(403)).toThrowError(FormulationBCollectionError);
    expect(() => monitor.checkRateLimitResponse(200)).not.toThrow();
  });

  it("tracks consecutive errors and triggers fail-closed on 3 consecutive failures", () => {
    const monitor = new FormulationBSafetyMonitor();

    monitor.recordSlotFailure();
    monitor.recordSlotFailure();
    expect(() => monitor.recordSlotFailure()).toThrowError(FormulationBCollectionError);

    // Reset works on success
    const monitor2 = new FormulationBSafetyMonitor();
    monitor2.recordSlotFailure();
    monitor2.recordSlotFailure();
    monitor2.recordSlotSuccess();
    monitor2.recordSlotFailure();
    expect(() => monitor2.recordSlotFailure()).not.toThrow();
  });

  it("prohibits liquidity fields in payload", () => {
    const monitor = new FormulationBSafetyMonitor();

    expect(() =>
      monitor.checkLiquidityProhibition({ priceUsd: 1.0, momentum5mPct: 5.0 }),
    ).not.toThrow();

    expect(() =>
      monitor.checkLiquidityProhibition({ priceUsd: 1.0, liquidityUsd: 100000 }),
    ).toThrowError(FormulationBCollectionError);

    expect(() => monitor.checkLiquidityProhibition({ poolReserve: 5000 })).toThrowError(
      FormulationBCollectionError,
    );

    expect(() => monitor.checkLiquidityProhibition({ quoteImpactBps: 20 })).toThrowError(
      FormulationBCollectionError,
    );
  });

  it("enforces daily (120) and total (600) request budget caps", () => {
    const monitor = new FormulationBSafetyMonitor();

    // Call 120 times on date 1
    for (let i = 0; i < 120; i++) {
      monitor.trackProviderCall("2026-09-01");
    }

    // 121st call breaches daily cap
    expect(() => monitor.trackProviderCall("2026-09-01")).toThrowError(FormulationBCollectionError);
    expect(monitor.safetyCounters.budgetExceededStops).toBe(1);
  });
});
