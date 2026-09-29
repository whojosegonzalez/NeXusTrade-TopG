import { describe, expect, it } from "vitest";
import { BirdeyeBudgetTracker } from "./BirdeyeBudgetTracker.js";

describe("BirdeyeBudgetTracker", () => {
  it("initializes with default 30,000 CU monthly limit and 2.5 min poll interval", () => {
    const tracker = new BirdeyeBudgetTracker();
    const snapshot = tracker.getSnapshot();

    expect(snapshot.monthlyCuLimit).toBe(30_000);
    expect(snapshot.monthlyCuUsed).toBe(0);
    expect(snapshot.monthlyCuRemaining).toBe(30_000);
    expect(snapshot.lastTrendingPollMs).toBe(0);
    expect(snapshot.totalTrendingPolls).toBe(0);
  });

  it("permits consumption within budget and blocks when quota is exceeded", () => {
    const tracker = new BirdeyeBudgetTracker({ monthlyCuLimit: 100 });

    expect(tracker.canConsume(50)).toBe(true);
    expect(tracker.consume(50)).toBe(true);

    expect(tracker.getSnapshot().monthlyCuUsed).toBe(50);
    expect(tracker.getSnapshot().monthlyCuRemaining).toBe(50);

    // Can consume exact remaining
    expect(tracker.canConsume(50)).toBe(true);
    expect(tracker.consume(50)).toBe(true);
    expect(tracker.getSnapshot().monthlyCuRemaining).toBe(0);

    // Cannot consume when exhausted
    expect(tracker.canConsume(1)).toBe(false);
    expect(tracker.consume(1)).toBe(false);
  });

  it("throttles trending polls to the configured interval", () => {
    const tracker = new BirdeyeBudgetTracker({
      monthlyCuLimit: 1000,
      trendingPollIntervalMs: 150_000,
      trendingCuCost: 25,
    });

    const t0 = 1_000_000;
    // First poll succeeds
    expect(tracker.canPollTrending(t0)).toBe(true);
    expect(tracker.recordTrendingPoll(t0)).toBe(true);

    const snap1 = tracker.getSnapshot();
    expect(snap1.monthlyCuUsed).toBe(25);
    expect(snap1.totalTrendingPolls).toBe(1);
    expect(snap1.lastTrendingPollMs).toBe(t0);

    // Immediate second poll fails due to interval throttle
    expect(tracker.canPollTrending(t0 + 10_000)).toBe(false);
    expect(tracker.recordTrendingPoll(t0 + 10_000)).toBe(false);

    // Poll at 2.5 minutes (150,000ms) succeeds
    const t1 = t0 + 150_000;
    expect(tracker.canPollTrending(t1)).toBe(true);
    expect(tracker.recordTrendingPoll(t1)).toBe(true);

    const snap2 = tracker.getSnapshot();
    expect(snap2.monthlyCuUsed).toBe(50);
    expect(snap2.totalTrendingPolls).toBe(2);
  });

  it("blocks trending polls if CU budget is insufficient", () => {
    const tracker = new BirdeyeBudgetTracker({
      monthlyCuLimit: 20, // Less than 25 CU cost
      trendingCuCost: 25,
    });

    expect(tracker.canPollTrending()).toBe(false);
    expect(tracker.recordTrendingPoll()).toBe(false);
    expect(tracker.getSnapshot().totalTrendingPolls).toBe(0);
  });

  it("resets budget tracker state cleanly", () => {
    const tracker = new BirdeyeBudgetTracker({ monthlyCuLimit: 500 });
    tracker.consume(250);
    tracker.recordTrendingPoll(12345);

    expect(tracker.getSnapshot().monthlyCuUsed).toBe(275);
    expect(tracker.getSnapshot().totalTrendingPolls).toBe(1);

    tracker.reset();
    const snap = tracker.getSnapshot();
    expect(snap.monthlyCuUsed).toBe(0);
    expect(snap.monthlyCuRemaining).toBe(500);
    expect(snap.lastTrendingPollMs).toBe(0);
    expect(snap.totalTrendingPolls).toBe(0);
  });
});
