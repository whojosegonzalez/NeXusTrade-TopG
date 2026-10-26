/**
 * Phase 12.94-D Milestone D.3.3: Shadow Observation Runner Offline Integration Tests
 *
 * Verifies the 10 operational invariants required before prospective observation:
 * 1. Accepted candidate evaluation, gate check capture, and forward horizon scheduling.
 * 2. Rejected candidate categorization, failed rule capture, and forward horizon scheduling.
 * 3. Prevention of premature forward horizon observations.
 * 4. Duplicate horizon outcome rejection invariant.
 * 5. Candidate intake deadline enforcement and fail-closed candidate rejection.
 * 6. Session closure truncation of future horizons while preserving already-due observations.
 * 7. Aggregate request ceiling and per-provider pacing enforcement.
 * 8. Provider failure resilience and safe error outcome recording.
 * 9. Cryptographic SHA-256 session manifest generation and hash verification.
 * 10. Safety invariant assertions (wallet frozen at 7.9259 SOL, zero paper mutations).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ShadowObservationRunner,
  type IShadowMarketDataProvider,
  type ShadowCandidateInput,
  type ShadowQuoteResult,
} from "./ShadowObservationRunner.js";

function createCandidate(overrides: Partial<ShadowCandidateInput> = {}): ShadowCandidateInput {
  return {
    poolId: "Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF",
    mintAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    symbol: "SOLRUN",
    discoveryTimestampMs: 1_000_000,
    streamSource: "RAYDIUM_TOP_TRADED",
    indicativePriceSol: 0.000005,
    priceQuoteTimestampMs: 1_000_000,
    liquidityUsd: 65000,
    marketCapUsd: 250000,
    lmcRatio: 0.26,
    lpBurnPct: 100,
    assetAgeSeconds: 2400,
    volume5mUsd: 35000,
    buys5m: 45,
    sells5m: 20,
    buyToSellRatio: 2.25,
    holdersCount: 450,
    rugScore: 120,
    bundlerPct: 0.12,
    top10HolderPct: 0.18,
    recentBuys60s: 18,
    recentSells60s: 8,
    ...overrides,
  };
}

class MockMarketDataProvider implements IShadowMarketDataProvider {
  public readonly providerName = "MOCK_PROVIDER";
  public callsCount = 0;
  public failNextWith: Error | null = null;
  public nextQuoteOverrides: Partial<ShadowQuoteResult> = {};

  async fetchQuote(_poolId: string, _mintAddress: string): Promise<ShadowQuoteResult> {
    void _poolId;
    void _mintAddress;
    this.callsCount++;
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }
    return {
      indicativePriceSol: 0.000006,
      liquidityUsd: 70000,
      quoteTimestampMs: 1_300_010,
      quoteSource: "MOCK_PROVIDER",
      isExecutableQuote: false,
      isPoolDrained: false,
      ...this.nextQuoteOverrides,
    };
  }
}

describe("ShadowObservationRunner Integration Suite", () => {
  it("Invariant 1: Evaluates accepted candidates, records gates, and schedules forward horizons", () => {
    const virtualClock = 1_000_000;
    const runner = new ShadowObservationRunner({
      sessionId: "test-accepted-candidate",
      configFingerprint: "sha256:fp1",
      clock: () => virtualClock,
    });

    const decisionId = runner.ingestCandidate(createCandidate());
    expect(decisionId).toBeDefined();

    const decisionRecord = runner
      .getRecorder()
      .getDecisionRecords()
      .find((d) => d.decisionEventId === decisionId);
    expect(decisionRecord).toBeDefined();
    expect(decisionRecord?.gateOutcome.decision).toBe("ACCEPTED_ARMED");
    expect(decisionRecord?.strategyCohort).toBe("ESTABLISHED_RUNNER");

    // Check that 4 forward horizons (+5m, +15m, +30m, +60m) are scheduled
    const tasks = runner.getScheduledTasks();
    expect(tasks.length).toBe(4);
    expect(tasks.map((t) => t.horizonSec)).toEqual([300, 900, 1800, 3600]);
    expect(tasks.every((t) => t.status === "PENDING")).toBe(true);
  });

  it("Invariant 2: Evaluates rejected candidates, captures rejection categories, and schedules forward horizons", () => {
    const virtualClock = 1_000_000;
    const runner = new ShadowObservationRunner({
      sessionId: "test-rejected-candidate",
      configFingerprint: "sha256:fp2",
      clock: () => virtualClock,
    });

    // High rug score triggers risk rejection
    const decisionId = runner.ingestCandidate(
      createCandidate({
        mintAddress: "MINT_HIGH_RUG",
        rugScore: 850, // exceeds maxRugScore 700
      }),
    );
    expect(decisionId).toBeDefined();

    const decisionRecord = runner
      .getRecorder()
      .getDecisionRecords()
      .find((d) => d.decisionEventId === decisionId);
    expect(decisionRecord).toBeDefined();
    expect(decisionRecord?.gateOutcome.decision).toBe("FILTERED_REJECTED");
    expect(decisionRecord?.gateOutcome.rejectionCategory).toBe("REJECTED_BY_RISK");

    // Rejected candidates also schedule forward horizons for counterfactual tracking
    const tasks = runner.getScheduledTasks();
    expect(tasks.length).toBe(4);
    expect(tasks.every((t) => t.status === "PENDING")).toBe(true);
  });

  it("Invariant 3 & 4: Prevents premature forward observation and rejects duplicate finalizations", () => {
    let virtualClock = 1_000_000;
    const runner = new ShadowObservationRunner({
      sessionId: "test-causality-guard",
      configFingerprint: "sha256:fp3",
      clock: () => virtualClock,
    });

    const decisionId = runner.ingestCandidate(createCandidate())!;
    const recorder = runner.getRecorder();

    // 1. Premature observation before scheduledDue (1_000_000 + 300_000 = 1_300_000) must throw
    virtualClock = 1_250_000; // 50 seconds too early
    expect(() => {
      recorder.recordHorizonOutcome({
        decisionEventId: decisionId,
        horizonSec: 300,
        observationTimestampMs: 1_250_000,
        outcomeStatus: "OBSERVED_PRICE",
        indicativePriceSol: 0.000006,
        liquidityUsd: 70000,
      });
    }).toThrow(/PREMATURE_OBSERVATION/);

    // 2. Valid observation at due timestamp
    virtualClock = 1_300_005;
    recorder.recordHorizonOutcome({
      decisionEventId: decisionId,
      horizonSec: 300,
      observationTimestampMs: 1_300_005,
      outcomeStatus: "OBSERVED_PRICE",
      indicativePriceSol: 0.000006,
      liquidityUsd: 70000,
    });

    // 3. Duplicate finalization for 300s must throw
    expect(() => {
      recorder.recordHorizonOutcome({
        decisionEventId: decisionId,
        horizonSec: 300,
        observationTimestampMs: 1_300_010,
        outcomeStatus: "OBSERVED_PRICE",
        indicativePriceSol: 0.0000065,
        liquidityUsd: 75000,
      });
    }).toThrow(/DUPLICATE_HORIZON/);
  });

  it("Invariant 5: Enforces intake deadline and rejects subsequent candidates fail-closed", () => {
    let virtualClock = 1_000_000;
    const runner = new ShadowObservationRunner({
      sessionId: "test-intake-deadline",
      configFingerprint: "sha256:fp5",
      intakeDurationMs: 300_000, // 5 minute intake window
      clock: () => virtualClock,
    });

    const d1 = runner.ingestCandidate(createCandidate({ mintAddress: "MINT_ONE" }));
    expect(d1).toBeDefined();

    // Advance clock past intake deadline (1_000_000 + 300_000 = 1_300_000)
    virtualClock = 1_300_001;
    const d2 = runner.ingestCandidate(createCandidate({ mintAddress: "MINT_TWO" }));
    expect(d2).toBeNull(); // Rejected fail-closed

    expect(runner.getCandidateCount()).toBe(1);
  });

  it("Invariant 6: Session closure preserves already-due observations while truncating future horizons", () => {
    let virtualClock = 1_000_000;
    const runner = new ShadowObservationRunner({
      sessionId: "test-drain-truncation",
      configFingerprint: "sha256:fp6",
      clock: () => virtualClock,
    });

    runner.ingestCandidate(createCandidate());

    // Advance clock to 1_500_000 ms.
    // At this time:
    // +5m (300s = 1_300_000) was already due!
    // +15m (900s = 1_900_000) is in the future.
    // +30m (1800s = 2_800_000) is in the future.
    // +60m (3600s = 4_600_000) is in the future.
    virtualClock = 1_500_000;
    runner.closeSession();

    const forwardRecords = runner.getRecorder().getForwardRecords();
    expect(forwardRecords.length).toBe(4);

    const fwd5m = forwardRecords.find((f) => f.horizonSec === 300)!;
    expect(fwd5m.outcomeStatus).toBe("MISSING_QUOTE_UNAVAILABLE");
    expect(fwd5m.missingReason).toBe("UNOBSERVED_AT_SESSION_CLOSE_ALREADY_DUE");

    const fwd15m = forwardRecords.find((f) => f.horizonSec === 900)!;
    expect(fwd15m.outcomeStatus).toBe("WINDOW_TRUNCATED");
    expect(fwd15m.missingReason).toBe("SESSION_CLOSED_BEFORE_HORIZON_ELAPSED");

    const fwd30m = forwardRecords.find((f) => f.horizonSec === 1800)!;
    expect(fwd30m.outcomeStatus).toBe("WINDOW_TRUNCATED");

    const fwd60m = forwardRecords.find((f) => f.horizonSec === 3600)!;
    expect(fwd60m.outcomeStatus).toBe("WINDOW_TRUNCATED");
  });

  it("Invariant 7: Enforces aggregate request ceiling and per-provider pacing", async () => {
    let virtualClock = 1_000_000;
    const mockProvider = new MockMarketDataProvider();
    const runner = new ShadowObservationRunner(
      {
        sessionId: "test-pacing-ceiling",
        configFingerprint: "sha256:fp7",
        minProviderSpacingMs: 2_000,
        maxAggregateRequests: 2, // Hard ceiling of 2 requests
        clock: () => virtualClock,
      },
      { marketDataProvider: mockProvider },
    );

    runner.ingestCandidate(createCandidate({ mintAddress: "MINT_REQ1" }));
    runner.ingestCandidate(createCandidate({ mintAddress: "MINT_REQ2" }));
    runner.ingestCandidate(createCandidate({ mintAddress: "MINT_REQ3" }));

    // Advance clock to +5m (1_300_000)
    virtualClock = 1_300_000;

    // First due observation executes
    const processed1 = await runner.processDueObservations();
    expect(processed1).toBe(1);
    expect(runner.getTotalRequestsMade()).toBe(1);

    // Immediate second call at same millisecond is deferred by provider pacing (2,000 ms)
    const processedPaced = await runner.processDueObservations();
    expect(processedPaced).toBe(0); // Deferred by pacing

    // Advance clock by 2,000 ms -> second request permitted, third task reaches ceiling
    virtualClock = 1_302_000;
    const processed2 = await runner.processDueObservations();
    // In this pass: Task 2 executes via provider, Task 3 immediately fails-closed on ceiling (max 2)
    expect(processed2).toBe(2);
    expect(runner.getTotalRequestsMade()).toBe(2);

    const forwardRecords = runner.getRecorder().getForwardRecords();
    const ceilingRecord = forwardRecords.find(
      (f) => f.missingReason === "AGGREGATE_REQUEST_CEILING_REACHED",
    );
    expect(ceilingRecord).toBeDefined();
    expect(ceilingRecord?.outcomeStatus).toBe("MISSING_QUOTE_UNAVAILABLE");
  });

  it("Invariant 8: Provider failure and pool drainage resilience", async () => {
    let virtualClock = 1_000_000;
    const mockProvider = new MockMarketDataProvider();
    const runner = new ShadowObservationRunner(
      {
        sessionId: "test-provider-resilience",
        configFingerprint: "sha256:fp8",
        clock: () => virtualClock,
      },
      { marketDataProvider: mockProvider },
    );

    runner.ingestCandidate(createCandidate({ mintAddress: "MINT_ERROR" }));
    runner.ingestCandidate(createCandidate({ mintAddress: "MINT_DRAINED" }));

    virtualClock = 1_300_000;

    // Simulate provider network 503 error
    mockProvider.failNextWith = new Error("HTTP 503 Service Unavailable");
    await runner.processDueObservations();

    // Advance clock for next task
    virtualClock = 1_302_000;
    // Simulate pool drainage event
    mockProvider.nextQuoteOverrides = {
      isPoolDrained: true,
      indicativePriceSol: 0,
      liquidityUsd: 100,
    };
    await runner.processDueObservations();

    const forwardRecords = runner.getRecorder().getForwardRecords();
    const errorRecord = forwardRecords.find((f) =>
      f.missingReason?.includes("HTTP 503 Service Unavailable"),
    );
    expect(errorRecord).toBeDefined();
    expect(errorRecord?.outcomeStatus).toBe("MISSING_QUOTE_UNAVAILABLE");

    const drainedRecord = forwardRecords.find((f) => f.outcomeStatus === "POOL_DRAINED");
    expect(drainedRecord).toBeDefined();
    expect(drainedRecord?.priceReturnPct).toBe(-100);
  });

  it("Invariant 9: Cryptographic SHA-256 session manifest verifies all output records", () => {
    const tmpDir = path.join(os.tmpdir(), `shadow-manifest-test-${Date.now()}`);
    let virtualClock = 1_000_000;

    const runner = new ShadowObservationRunner({
      sessionId: "test-manifest-verification",
      configFingerprint: "sha256:expectedconfigdigest",
      outputDir: tmpDir,
      clock: () => virtualClock,
    });

    runner.ingestCandidate(createCandidate({ mintAddress: "MINT_MANIFEST_1" }));
    virtualClock = 1_300_000;
    const { manifest, summary } = runner.closeSession();

    expect(manifest).toBeDefined();
    expect(summary).toBeDefined();
    expect(manifest?.verificationStatus).toBe("VERIFIED_OFFLINE");
    expect(manifest?.files.length).toBe(3);

    // Verify cryptographic SHA-256 integrity for each file
    for (const fileEntry of manifest!.files) {
      const filePath = path.join(tmpDir, fileEntry.filename);
      expect(fs.existsSync(filePath)).toBe(true);
      const actualContent = fs.readFileSync(filePath);
      const actualHash = crypto.createHash("sha256").update(actualContent).digest("hex");
      expect(actualHash).toBe(fileEntry.sha256);
      expect(actualContent.length).toBe(fileEntry.byteSize);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Invariant 10: Enforces safety invariants (wallet frozen at 7.9259 SOL, zero balance mutations)", () => {
    const runner = new ShadowObservationRunner({
      sessionId: "test-safety-invariants",
      configFingerprint: "sha256:fp10",
    });

    const safety = runner.verifySafetyInvariants();
    expect(safety.walletFrozen).toBe(true);
    expect(safety.balanceSol).toBe(7.9259);
    expect(safety.paperTradingActive).toBe(false);
    expect(safety.openPositionsCount).toBe(0);
    expect(safety.networkMutationsAllowed).toBe(false);
  });
});
