import { describe, expect, it } from "vitest";
import {
  ContinuousQuietIntervalTracker,
  type QuietWindowObservation,
} from "./ContinuousQuietIntervalTracker.js";

describe("ContinuousQuietIntervalTracker", () => {
  const poolAddress = "PoolTestAddress11111111111111111111111111111";
  const tokenMint = "MintTestAddress11111111111111111111111111111";
  const connectionEpoch = 0;

  it("reports 0 continuous span initially", () => {
    const tracker = new ContinuousQuietIntervalTracker();
    expect(tracker.getContinuousSpanMs()).toBe(0);
    expect(tracker.isStagnant3m()).toBe(false);
  });

  it("records a single 60s quiet window and rejects 3m stagnation on 60s evidence", () => {
    const tracker = new ContinuousQuietIntervalTracker();
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });

    expect(tracker.getContinuousSpanMs()).toBe(60_000);
    expect(tracker.isStagnant3m()).toBe(false);
  });

  it("does not advance continuous span on repeated identical snapshots", () => {
    const tracker = new ContinuousQuietIntervalTracker();
    const obs: QuietWindowObservation = {
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    };

    tracker.recordQuietWindow(obs);
    expect(tracker.getContinuousSpanMs()).toBe(60_000);

    // Repeated identical observations
    tracker.recordQuietWindow(obs);
    tracker.recordQuietWindow(obs);
    expect(tracker.getContinuousSpanMs()).toBe(60_000);
    expect(tracker.isStagnant3m()).toBe(false);
  });

  it("merges overlapping intervals and achieves 180s stagnation when continuous quiet coverage reaches 180s", () => {
    const tracker = new ContinuousQuietIntervalTracker();

    // Window 1: [1_000_000, 1_060_000] (60s)
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(60_000);
    expect(tracker.isStagnant3m()).toBe(false);

    // Window 2: [1_030_000, 1_090_000] (overlaps with Window 1, span -> 90s)
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_030_000,
      windowEndMs: 1_090_000,
      evaluationTimestampMs: 1_090_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(90_000);
    expect(tracker.isStagnant3m()).toBe(false);

    // Window 3: [1_060_000, 1_120_000] (contiguous with Window 1, overlaps Window 2, span -> 120s)
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_060_000,
      windowEndMs: 1_120_000,
      evaluationTimestampMs: 1_120_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(120_000);
    expect(tracker.isStagnant3m()).toBe(false);

    // Window 4: [1_100_000, 1_160_000] (span -> 160s)
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_100_000,
      windowEndMs: 1_160_000,
      evaluationTimestampMs: 1_160_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(160_000);
    expect(tracker.isStagnant3m()).toBe(false);

    // Window 5: [1_140_000, 1_180_000] (span -> 180s)
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_140_000,
      windowEndMs: 1_180_000,
      evaluationTimestampMs: 1_180_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(180_000);
    expect(tracker.isStagnant3m()).toBe(true);
  });

  it("breaks continuity on an unobserved temporal gap", () => {
    const tracker = new ContinuousQuietIntervalTracker();

    // Window 1: [1_000_000, 1_060_000]
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(60_000);

    // Window 2: [1_070_000, 1_130_000] (Gap of 10,000ms between 1_060_000 and 1_070_000)
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_070_000,
      windowEndMs: 1_130_000,
      evaluationTimestampMs: 1_130_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });

    // Continuity is broken: prior span is discarded, new span begins at 1_070_000 (span = 60s)
    expect(tracker.getContinuousSpanMs()).toBe(60_000);
    expect(tracker.getState().continuousStartMs).toBe(1_070_000);
    expect(tracker.getState().continuousEndMs).toBe(1_130_000);
    expect(tracker.getState().lastResetReason).toBe("UNOBSERVED_GAP");
    expect(tracker.isStagnant3m()).toBe(false);
  });

  it("breaks continuity when trade activity is observed", () => {
    const tracker = new ContinuousQuietIntervalTracker();

    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(60_000);

    // Trade observed in next window
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_030_000,
      windowEndMs: 1_090_000,
      evaluationTimestampMs: 1_090_000,
      isQuiet: false,
      isCoverageSufficient: true,
    });

    expect(tracker.getContinuousSpanMs()).toBe(0);
    expect(tracker.getState().lastResetReason).toBe("OBSERVED_TRADE_ACTIVITY");
    expect(tracker.isStagnant3m()).toBe(false);
  });

  it("breaks continuity when coverage is insufficient (collection gap)", () => {
    const tracker = new ContinuousQuietIntervalTracker();

    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(60_000);

    // Insufficient coverage
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_030_000,
      windowEndMs: 1_090_000,
      evaluationTimestampMs: 1_090_000,
      isQuiet: true,
      isCoverageSufficient: false,
    });

    expect(tracker.getContinuousSpanMs()).toBe(0);
    expect(tracker.getState().lastResetReason).toBe("INSUFFICIENT_COVERAGE");
    expect(tracker.isStagnant3m()).toBe(false);
  });

  it("breaks continuity on pool identity or token mint change", () => {
    const tracker = new ContinuousQuietIntervalTracker();

    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(60_000);

    // Different pool address
    tracker.recordQuietWindow({
      poolAddress: "DifferentPoolAddress1111111111111111111111111",
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_030_000,
      windowEndMs: 1_090_000,
      evaluationTimestampMs: 1_090_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });

    // Continuity reset and new span started for new pool
    expect(tracker.getContinuousSpanMs()).toBe(60_000);
    expect(tracker.getState().poolAddress).toBe("DifferentPoolAddress1111111111111111111111111");
  });

  it("breaks continuity on connection epoch change", () => {
    const tracker = new ContinuousQuietIntervalTracker();

    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch: 0,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(60_000);

    // New connection epoch
    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch: 1,
      windowStartMs: 1_030_000,
      windowEndMs: 1_090_000,
      evaluationTimestampMs: 1_090_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });

    // Continuity reset and new span started for new epoch
    expect(tracker.getContinuousSpanMs()).toBe(60_000);
    expect(tracker.getState().connectionEpoch).toBe(1);
  });

  it("resets span on explicit reset (e.g. price change or feed outage)", () => {
    const tracker = new ContinuousQuietIntervalTracker();

    tracker.recordQuietWindow({
      poolAddress,
      tokenMint,
      connectionEpoch,
      windowStartMs: 1_000_000,
      windowEndMs: 1_060_000,
      evaluationTimestampMs: 1_060_000,
      isQuiet: true,
      isCoverageSufficient: true,
    });
    expect(tracker.getContinuousSpanMs()).toBe(60_000);

    tracker.reset("PRICE_CHANGED");
    expect(tracker.getContinuousSpanMs()).toBe(0);
    expect(tracker.getState().lastResetReason).toBe("PRICE_CHANGED");
    expect(tracker.isStagnant3m()).toBe(false);
  });
});
