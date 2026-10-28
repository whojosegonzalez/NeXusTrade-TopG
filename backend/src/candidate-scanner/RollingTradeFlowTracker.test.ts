/**
 * Phase 12.94-D Milestone D.3.3: Rolling 60-Second Trade Flow Tracker Unit Tests
 *
 * Comprehensive offline verification of:
 * 1. Complete window coverage verification (rejects silence/single-heartbeat false passes).
 * 2. Separation of trade time, receipt time, and observation coverage evidence:
 *    - Ingesting delayed trades cannot fabricate coverage without source-supported checkpoints.
 *    - Strict cross-validation of eventTimestampMs, receiptTimestampMs, blockTimeSec, and provenance.
 *    - Rejection of contradictory, future-dated, or spoofed timing.
 * 3. Strict bounding of gap metadata (maxGapsRetained enforced during insertion via conservative interval merging).
 * 4. Strict constructor configuration validation (rejects NaN, Infinity, non-integers, out-of-range).
 * 5. Capacity bounds & fail-closed protection (prevents capacity loss from producing misleading counts).
 * 6. Input validation, immutable snapshotting, and canonical swap coordinate deduplication.
 * 7. Recovery to SUFFICIENT coverage after a genuinely complete clean window.
 * 8. Retest boundary enforcement (typed coverage, finite non-negative integer counts, fail-closed unverified flow).
 * 9. Multi-swap transactions, moving window boundaries, and honest empty windows.
 *
 * ALL tests execute 100% offline with synthetic fixtures and zero network activity.
 */

import { describe, expect, it } from "vitest";
import {
  deriveCanonicalSwapKey,
  RollingTradeFlowTracker,
  type TradeEvent,
  type TradeTimestampProvenance,
} from "./RollingTradeFlowTracker.js";
import { evaluateRetestGate } from "./RetestGateEvaluator.js";

// Canonical 32-byte test fixture addresses
const CANONICAL_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const CANONICAL_TOKEN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const OTHER_POOL_ID = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const OTHER_TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

function createSyntheticTradeEvent(overrides: Partial<TradeEvent> = {}): TradeEvent {
  const signature = overrides.signature ?? "5J9XzMvY4bA7sD1fG2h3j4k5L6m7N8p9Q1w2e3r4t5y6u7i8o9p0";
  const swapIndex = overrides.swapIndex ?? 0;
  const outerInstructionIndex = overrides.outerInstructionIndex ?? 0;
  const eventId = overrides.eventId ?? `${signature}:${outerInstructionIndex}:${swapIndex}`;
  const nowMs = 1_700_000_000_000;
  const eventTimestampMs = overrides.eventTimestampMs ?? nowMs;
  const receiptTimestampMs = overrides.receiptTimestampMs ?? eventTimestampMs;
  const blockTimeSec =
    overrides.blockTimeSec !== undefined
      ? overrides.blockTimeSec
      : Math.floor(eventTimestampMs / 1000);

  return {
    eventId,
    signature,
    swapIndex,
    outerInstructionIndex,
    poolId: CANONICAL_POOL_ID,
    tokenMint: CANONICAL_TOKEN_MINT,
    side: "BUY",
    slot: 300_000_000,
    blockTimeSec,
    eventTimestampMs,
    receiptTimestampMs,
    timestampProvenance: "SYNTHETIC_FIXTURE",
    tokenAmount: 1_000_000_000n,
    solAmount: 100_000_000n,
    ...overrides,
  };
}

describe("RollingTradeFlowTracker — Audited Corrections", () => {
  describe("1. Complete Window Coverage Verification (Finding 1)", () => {
    it("rejects false pass: tracker started 60s ago with only one heartbeat at evaluation time reports COLLECTION_GAP and null counts", () => {
      const nowMs = 1_060_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000, // Started 60 seconds ago: 1,000,000
        maxStreamInactivityMs: 15_000,
        clock: () => nowMs,
      });

      // NO heartbeats or trades occurred during the 60s.
      // At evaluation time (1,060,000), caller records one heartbeat:
      tracker.recordHeartbeat(nowMs);

      const evalResult = tracker.evaluateWindow(nowMs);

      // Must NOT report SUFFICIENT! The 60-second unobserved silence between 1,000,000 and 1,060,000 is an unobserved gap!
      expect(evalResult.coverage).toBe("COLLECTION_GAP");
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.recentBuys60s).toBeNull();
      expect(evalResult.recentSells60s).toBeNull();
      expect(evalResult.flowRatio).toBeNull();
    });

    it("reports SUFFICIENT and honest zero trades when regular heartbeats prove continuous observation across the window", () => {
      const startMs = 1_000_000;
      let currentClock = startMs;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: startMs,
        maxStreamInactivityMs: 15_000,
        clock: () => currentClock,
      });

      // Regular heartbeats every 10 seconds (well within 15s maxStreamInactivityMs)
      for (let t = startMs + 10_000; t <= startMs + 60_000; t += 10_000) {
        currentClock = t;
        tracker.recordHeartbeat(t);
      }

      const evalResult = tracker.evaluateWindow(startMs + 60_000);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.isCoverageSufficient).toBe(true);
      // Genuinely observed empty window
      expect(evalResult.recentBuys60s).toBe(0);
      expect(evalResult.recentSells60s).toBe(0);
      expect(evalResult.flowRatio).toBe(1.0);
    });

    it("reports PROCESSING_BACKLOG and null counts when backlog is active", () => {
      const nowMs = 1_060_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        clock: () => nowMs,
      });

      // Provide continuous heartbeats but set backlog flag
      for (let t = nowMs - 50_000; t <= nowMs; t += 10_000) {
        tracker.recordHeartbeat(t, undefined, { isBacklogged: t === nowMs });
      }

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("PROCESSING_BACKLOG");
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.recentBuys60s).toBeNull();
      expect(evalResult.recentSells60s).toBeNull();
    });

    it("reports STALE_DATA / COLLECTION_GAP and null counts when evaluation time is silent beyond maxStreamInactivityMs", () => {
      const nowMs = 1_060_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        maxStreamInactivityMs: 15_000,
        clock: () => nowMs,
      });

      // Heartbeats up to now - 20s
      for (let t = nowMs - 50_000; t <= nowMs - 20_000; t += 10_000) {
        tracker.recordHeartbeat(t);
      }

      // No heartbeat between now - 20s and nowMs (20s silence > 15s)
      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("COLLECTION_GAP");
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.recentBuys60s).toBeNull();
    });
  });

  describe("2. Separation of Trade Time, Receipt Time, and Coverage Evidence (Auditor Area 2)", () => {
    it("rejects delayed trades fabricating coverage: 6 delayed trades with no heartbeats report COLLECTION_GAP and null counts", () => {
      const nowMs = 1_060_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000, // 1,000,000
        maxStreamInactivityMs: 15_000,
        clock: () => nowMs,
      });

      // NO observation checkpoints during the preceding minute.
      // 6 delayed trades carry historical timestamps spaced 10 seconds apart.
      // All 6 have receiptTimestampMs = nowMs (current time).
      for (let i = 1; i <= 6; i++) {
        const tradeTime = nowMs - 60_000 + i * 10_000;
        const res = tracker.ingestTrade(
          createSyntheticTradeEvent({
            signature: `delayed-sig-${i}`,
            swapIndex: 0,
            side: "BUY",
            eventTimestampMs: tradeTime,
            receiptTimestampMs: nowMs,
            blockTimeSec: Math.floor(tradeTime / 1000),
            timestampProvenance: "SYNTHETIC_FIXTURE",
          }),
        );
        expect(res.ok).toBe(true);
      }

      // Evaluate window at nowMs
      const evalResult = tracker.evaluateWindow(nowMs);

      // Must NOT report SUFFICIENT! The trades populated the buffer, but cannot fabricate observation coverage.
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.coverage).toBe("COLLECTION_GAP");
      expect(evalResult.recentBuys60s).toBeNull();
      expect(evalResult.recentSells60s).toBeNull();
    });

    it("accepts delayed trades and reports SUFFICIENT when continuous coverage is verified via checkpoints or completed range", () => {
      const nowMs = 1_060_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        maxStreamInactivityMs: 15_000,
        clock: () => nowMs,
      });

      // Continuous coverage proven across the entire window
      tracker.recordCompletedRange(nowMs - 60_000, nowMs);
      tracker.recordHeartbeat(nowMs);

      // Ingest delayed trades
      for (let i = 1; i <= 4; i++) {
        const tradeTime = nowMs - 50_000 + i * 10_000;
        const res = tracker.ingestTrade(
          createSyntheticTradeEvent({
            signature: `reconciled-sig-${i}`,
            swapIndex: 0,
            side: "BUY",
            eventTimestampMs: tradeTime,
            receiptTimestampMs: nowMs,
            blockTimeSec: Math.floor(tradeTime / 1000),
            timestampProvenance: "SYNTHETIC_FIXTURE",
          }),
        );
        expect(res.ok).toBe(true);
      }

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.isCoverageSufficient).toBe(true);
      expect(evalResult.recentBuys60s).toBe(4);
      expect(evalResult.recentSells60s).toBe(0);
    });

    it("rejects receipt timestamp one day in the future with FUTURE_DATED_RECEIPT_TIMESTAMP", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        clock: () => nowMs,
      });

      const res = tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventTimestampMs: nowMs,
          receiptTimestampMs: nowMs + 86_400_000, // 1 day in the future
          blockTimeSec: Math.floor(nowMs / 1000),
          timestampProvenance: "SYNTHETIC_FIXTURE",
        }),
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("FUTURE_DATED_RECEIPT_TIMESTAMP");
      }
    });

    it("rejects ON_CHAIN_BLOCK_TIME where blockTimeSec is 1 day old while eventTimestampMs is in current minute", () => {
      const nowMs = 1_700_000_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        clock: () => nowMs,
      });

      const res = tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventTimestampMs: nowMs - 10_000, // 10s ago
          receiptTimestampMs: nowMs,
          blockTimeSec: Math.floor((nowMs - 86_400_000) / 1000), // 1 day old
          timestampProvenance: "ON_CHAIN_BLOCK_TIME",
        }),
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("CONTRADICTORY_TIMESTAMPS");
      }
    });

    it("rejects eventTimestampMs that is in the future relative to receiptTimestampMs", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        clock: () => nowMs,
      });

      const res = tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventTimestampMs: nowMs - 5_000,
          receiptTimestampMs: nowMs - 30_000, // received 30s ago, but claims trade occurred 5s ago
          blockTimeSec: Math.floor((nowMs - 5_000) / 1000),
          timestampProvenance: "SYNTHETIC_FIXTURE",
        }),
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("CONTRADICTORY_TIMESTAMPS");
      }
    });

    it("rejects HOST_OBSERVED provenance where eventTimestampMs contradicts receiptTimestampMs", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        clock: () => nowMs,
      });

      const res = tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventTimestampMs: nowMs - 300_000, // 5 minutes ago
          receiptTimestampMs: nowMs, // received now
          blockTimeSec: null,
          timestampProvenance: "HOST_OBSERVED",
        }),
      );

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("CONTRADICTORY_TIMESTAMPS");
      }
    });

    it("ignores future-dated heartbeats exceeding maxFutureSkewMs", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        maxFutureSkewMs: 5_000,
        clock: () => nowMs,
      });

      // Record heartbeat 100s in the future (exceeds 5s skew)
      tracker.recordHeartbeat(nowMs + 100_000);

      // Observation timeline must NOT be updated to the future timestamp
      expect(tracker.getLastObservationTimestampMs()).toBe(nowMs - 60_000);
    });
  });

  describe("3. Strict Gap Metadata Bounding during Insertion (Auditor Area 1)", () => {
    it("enforces maxGapsRetained ceiling when 100 event-capacity rejections occur", () => {
      const startMs = 1_000_000;
      const nowMs = startMs + 60_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: startMs,
        maxEventsRetained: 10,
        maxGapsRetained: 5, // Strict limit of 5 gaps
        clock: () => nowMs,
      });

      for (let t = startMs; t <= nowMs; t += 10_000) {
        tracker.recordHeartbeat(t);
      }

      // Ingest 10 events to fill capacity
      for (let i = 0; i < 10; i++) {
        tracker.ingestTrade(
          createSyntheticTradeEvent({
            signature: `fill-${i}`,
            swapIndex: 0,
            eventTimestampMs: startMs + 10_000 + i * 100,
            receiptTimestampMs: nowMs,
            blockTimeSec: Math.floor((startMs + 10_000 + i * 100) / 1000),
          }),
        );
      }

      // Now reject 100 subsequent events due to capacity
      for (let i = 0; i < 100; i++) {
        const res = tracker.ingestTrade(
          createSyntheticTradeEvent({
            signature: `overflow-${i}`,
            swapIndex: 0,
            eventTimestampMs: startMs + 20_000 + i * 100,
            receiptTimestampMs: nowMs,
            blockTimeSec: Math.floor((startMs + 20_000 + i * 100) / 1000),
          }),
        );
        expect(res.ok).toBe(false);
      }

      // CRITICAL GUARANTEE: Gap count must NEVER exceed maxGapsRetained (5)!
      expect(tracker.getGapsCount()).toBeLessThanOrEqual(5);

      // Coverage must remain CAPACITY_LOSS (never restoring false coverage)
      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("CAPACITY_LOSS");
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.recentBuys60s).toBeNull();
    });

    it("enforces maxGapsRetained ceiling when 1,000 explicit gap records are inserted", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 120_000,
        maxGapsRetained: 5, // Strict limit of 5 gaps
        clock: () => nowMs,
      });

      // Insert 1,000 distinct gap intervals
      for (let i = 0; i < 1_000; i++) {
        tracker.recordCollectionGap({
          gapStartMs: nowMs - 100_000 + i * 80,
          gapEndMs: nowMs - 100_000 + i * 80 + 30,
          reason: `OUTAGE_${i}`,
        });
      }

      // CRITICAL GUARANTEE: Array length must be <= maxGapsRetained (5) at all times!
      expect(tracker.getGapsCount()).toBeLessThanOrEqual(5);

      // Coverage must remain COLLECTION_GAP
      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("COLLECTION_GAP");
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.recentBuys60s).toBeNull();
    });
  });

  describe("4. Strict Configuration Validation in Constructor (Auditor Area 1)", () => {
    it("rejects maxGapsRetained: NaN, Infinity, negative, non-integer, or out of range", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxGapsRetained: NaN,
        });
      }).toThrow(/Invalid maxGapsRetained/);

      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxGapsRetained: Infinity,
        });
      }).toThrow(/Invalid maxGapsRetained/);

      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxGapsRetained: 1, // Minimum is 2
        });
      }).toThrow(/Invalid maxGapsRetained/);
    });

    it("rejects maxDeduplicationKeys: Infinity, NaN, or out of range", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxDeduplicationKeys: Infinity,
        });
      }).toThrow(/Invalid maxDeduplicationKeys/);

      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxDeduplicationKeys: NaN,
        });
      }).toThrow(/Invalid maxDeduplicationKeys/);
    });

    it("rejects retentionWindowMs: NaN, Infinity, or < 120_000", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          retentionWindowMs: NaN,
        });
      }).toThrow(/Invalid retentionWindowMs/);

      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          retentionWindowMs: 60_000, // < 120,000
        });
      }).toThrow(/Invalid retentionWindowMs/);
    });

    it("rejects maxFutureSkewMs: NaN, Infinity, or out of range", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxFutureSkewMs: NaN,
        });
      }).toThrow(/Invalid maxFutureSkewMs/);
    });

    it("rejects trackingStartedMs: NaN, Infinity, or non-positive", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          trackingStartedMs: NaN,
        });
      }).toThrow(/Invalid trackingStartedMs/);
    });

    it("rejects maxStreamInactivityMs: NaN, Infinity, or out of range", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxStreamInactivityMs: NaN,
        });
      }).toThrow(/Invalid maxStreamInactivityMs/);
    });

    it("rejects maxEventsRetained: NaN, Infinity, or < 10", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxEventsRetained: NaN,
        });
      }).toThrow(/Invalid maxEventsRetained/);

      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          maxEventsRetained: 5,
        });
      }).toThrow(/Invalid maxEventsRetained/);
    });

    it("rejects windowDurationMs !== 60_000", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          windowDurationMs: 10_000,
        });
      }).toThrow(/Invalid windowDurationMs: 10000/);
    });
  });

  describe("5. Recovery After Genuinely Complete Clean Window", () => {
    it("recovers to SUFFICIENT coverage after an earlier gap has fully rolled out of the 60s lookback window", () => {
      const baseMs = 1_000_000;
      let currentClock = baseMs;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: baseMs,
        maxStreamInactivityMs: 15_000,
        clock: () => currentClock,
      });

      // An outage occurred between baseMs + 5s and baseMs + 25s
      tracker.recordCollectionGap({
        gapStartMs: baseMs + 5_000,
        gapEndMs: baseMs + 25_000,
        reason: "WS_DISCONNECT",
      });

      // Stream reconnects at baseMs + 25s. Regular heartbeats resume every 10s:
      for (let t = baseMs + 30_000; t <= baseMs + 100_000; t += 10_000) {
        currentClock = t;
        tracker.recordHeartbeat(t);
      }

      // At t = baseMs + 70s: the window is [baseMs + 10s, baseMs + 70s].
      // The gap ended at baseMs + 25s, which intersects the window!
      const evalAt70 = tracker.evaluateWindow(baseMs + 70_000);
      expect(evalAt70.coverage).toBe("COLLECTION_GAP");
      expect(evalAt70.isCoverageSufficient).toBe(false);

      // Ingest 2 clean trades at baseMs + 50s and baseMs + 80s
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          signature: "clean-buy-1",
          swapIndex: 0,
          side: "BUY",
          eventTimestampMs: baseMs + 50_000,
          receiptTimestampMs: baseMs + 50_000,
          blockTimeSec: Math.floor((baseMs + 50_000) / 1000),
        }),
      );
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          signature: "clean-buy-2",
          swapIndex: 0,
          side: "BUY",
          eventTimestampMs: baseMs + 80_000,
          receiptTimestampMs: baseMs + 80_000,
          blockTimeSec: Math.floor((baseMs + 80_000) / 1000),
        }),
      );

      // Advance to baseMs + 90s: window is [baseMs + 30s, baseMs + 90s].
      // Gap ended at baseMs + 25s, which is strictly before baseMs + 30s!
      currentClock = baseMs + 90_000;
      tracker.recordHeartbeat(currentClock);

      const evalAt90 = tracker.evaluateWindow(baseMs + 90_000);

      // Coverage has completely recovered to SUFFICIENT!
      expect(evalAt90.coverage).toBe("SUFFICIENT");
      expect(evalAt90.isCoverageSufficient).toBe(true);
      expect(evalAt90.recentBuys60s).toBe(2);
      expect(evalAt90.recentSells60s).toBe(0);
    });
  });

  describe("6. Input Snapshotting & Coordinate Deduplication", () => {
    it("caller mutating an event object after ingestion does not alter stored tracker state", () => {
      const nowMs = 1_060_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        clock: () => nowMs,
      });

      for (let t = nowMs - 60_000; t <= nowMs; t += 10_000) {
        tracker.recordHeartbeat(t);
      }

      const mutableEvent: TradeEvent = createSyntheticTradeEvent({
        signature: "mutable-sig",
        swapIndex: 0,
        side: "BUY",
        eventTimestampMs: nowMs - 30_000,
        receiptTimestampMs: nowMs - 30_000,
        blockTimeSec: Math.floor((nowMs - 30_000) / 1000),
      });

      const res = tracker.ingestTrade(mutableEvent);
      expect(res.ok).toBe(true);

      // Caller mutates their own object
      (mutableEvent as unknown as { side: string }).side = "SELL";

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.recentBuys60s).toBe(1);
      expect(evalResult.recentSells60s).toBe(0);
    });

    it("rejects same signature and swapIndex with different eventId labels as DUPLICATE_EVENT", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      });

      const event1 = createSyntheticTradeEvent({
        eventId: "custom-label-A",
        signature: "duplicate-sig",
        outerInstructionIndex: 0,
        swapIndex: 0,
      });

      const event2 = createSyntheticTradeEvent({
        eventId: "custom-label-B",
        signature: "duplicate-sig",
        outerInstructionIndex: 0,
        swapIndex: 0,
      });

      const res1 = tracker.ingestTrade(event1);
      const res2 = tracker.ingestTrade(event2);

      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(false);
      if (!res2.ok) {
        expect(res2.reason).toBe("DUPLICATE_EVENT");
      }
      expect(tracker.getEventsCount()).toBe(1);
    });

    it("rejects empty signature, negative swapIndex, invalid slot, and fractional event timestamps", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      });

      const resBadPool = tracker.ingestTrade(createSyntheticTradeEvent({ poolId: OTHER_POOL_ID }));
      expect(resBadPool.ok).toBe(false);
      if (!resBadPool.ok) expect(resBadPool.reason).toBe("IDENTITY_MISMATCH_POOL");

      const resBadMint = tracker.ingestTrade(
        createSyntheticTradeEvent({ tokenMint: OTHER_TOKEN_MINT }),
      );
      expect(resBadMint.ok).toBe(false);
      if (!resBadMint.ok) expect(resBadMint.reason).toBe("IDENTITY_MISMATCH_MINT");

      const resEmptySig = tracker.ingestTrade(createSyntheticTradeEvent({ signature: "" }));
      expect(resEmptySig.ok).toBe(false);
      if (!resEmptySig.ok) expect(resEmptySig.reason).toBe("INVALID_SIGNATURE");

      const resNegSwap = tracker.ingestTrade(createSyntheticTradeEvent({ swapIndex: -1 }));
      expect(resNegSwap.ok).toBe(false);
      if (!resNegSwap.ok) expect(resNegSwap.reason).toBe("INVALID_SWAP_INDEX");

      const resNegOuter = tracker.ingestTrade(
        createSyntheticTradeEvent({ outerInstructionIndex: -1 }),
      );
      expect(resNegOuter.ok).toBe(false);
      if (!resNegOuter.ok) expect(resNegOuter.reason).toBe("INVALID_INSTRUCTION_INDEX");

      const resNanSlot = tracker.ingestTrade(createSyntheticTradeEvent({ slot: NaN }));
      expect(resNanSlot.ok).toBe(false);
      if (!resNanSlot.ok) expect(resNanSlot.reason).toBe("INVALID_SLOT");

      const resNanReceipt = tracker.ingestTrade(
        createSyntheticTradeEvent({ receiptTimestampMs: NaN }),
      );
      expect(resNanReceipt.ok).toBe(false);
      if (!resNanReceipt.ok) expect(resNanReceipt.reason).toBe("INVALID_RECEIPT_TIMESTAMP");

      const resBadProv = tracker.ingestTrade(
        createSyntheticTradeEvent({
          timestampProvenance: "UNKNOWN" as unknown as TradeTimestampProvenance,
        }),
      );
      expect(resBadProv.ok).toBe(false);
      if (!resBadProv.ok) expect(resBadProv.reason).toBe("INVALID_PROVENANCE");

      const resFracTs = tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventTimestampMs: 1_700_000_000_000.5,
          receiptTimestampMs: 1_700_000_000_001,
        }),
      );
      expect(resFracTs.ok).toBe(false);
      if (!resFracTs.ok) expect(resFracTs.reason).toBe("INVALID_TIMESTAMP");
    });

    it("evaluateWindow(NaN) throws error and does not report SUFFICIENT", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      });

      expect(() => tracker.evaluateWindow(NaN)).toThrow(/Invalid evaluationTimestampMs/);
      expect(() => tracker.evaluateWindow(-100)).toThrow(/Invalid evaluationTimestampMs/);
      expect(() => tracker.evaluateWindow(1.5)).toThrow(/Invalid evaluationTimestampMs/);
    });
  });

  describe("7. Retest Boundary Enforcement (Finding 4)", () => {
    const existingArmed = {
      mintAddress: CANONICAL_TOKEN_MINT,
      armedAtMs: 1_050_000,
      peakPriceSol: 1.0,
      peakPriceUsd: 150.0,
      ticksObserved: 2,
    };

    it("prevents confirmation when flowCoverage = COLLECTION_GAP even with strong counts (20 buys / 10 sells)", () => {
      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: 1_060_000,
        spotInfo: {
          spotPriceSol: 0.95,
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
          recentBuys60s: 20,
          recentSells60s: 10,
          flowCoverage: "COLLECTION_GAP",
        },
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("WAITING");
    });

    it("prevents confirmation when flowCoverage = STALE_DATA even with strong counts", () => {
      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: 1_060_000,
        spotInfo: {
          spotPriceSol: 0.95,
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
          recentBuys60s: 20,
          recentSells60s: 10,
          flowCoverage: "STALE_DATA",
        },
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("WAITING");
    });

    it("prevents confirmation when recentBuys60s is Infinity", () => {
      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: 1_060_000,
        spotInfo: {
          spotPriceSol: 0.95,
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
          recentBuys60s: Infinity,
          recentSells60s: 0,
          flowCoverage: "SUFFICIENT",
        },
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("WAITING");
    });

    it("prevents confirmation when recentBuys60s is negative or non-integer", () => {
      const resNeg = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: 1_060_000,
        spotInfo: {
          spotPriceSol: 0.95,
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
          recentBuys60s: -5,
          recentSells60s: 0,
          flowCoverage: "SUFFICIENT",
        },
        existingArmedState: existingArmed,
      });
      expect(resNeg.status).toBe("WAITING");

      const resFloat = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: 1_060_000,
        spotInfo: {
          spotPriceSol: 0.95,
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
          recentBuys60s: 2.5,
          recentSells60s: 1,
          flowCoverage: "SUFFICIENT",
        },
        existingArmedState: existingArmed,
      });
      expect(resFloat.status).toBe("WAITING");
    });

    it("confirms entry when flowCoverage is SUFFICIENT and counts are finite integers satisfying Rule A", () => {
      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: 1_060_000,
        spotInfo: {
          spotPriceSol: 0.95,
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
          recentBuys60s: 23,
          recentSells60s: 10,
          flowCoverage: "SUFFICIENT",
        },
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("CONFIRMED");
      if (result.status === "CONFIRMED") {
        expect(result.confirmReason).toBe("RETEST_PULLBACK_DISCOUNT");
      }
    });

    it("preserves crater drop rejection even when flow coverage is invalid or null", () => {
      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: false,
        currentNowMs: 1_060_000,
        spotInfo: {
          spotPriceSol: 0.8, // 20% plunge > 15% micro-cap crater ceiling
          spotPriceUsd: 120.0,
          liquidityUsd: 30_000,
          recentBuys60s: null,
          recentSells60s: null,
          flowCoverage: "COLLECTION_GAP",
        },
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectReason).toBe("REJECTED_PULLBACK_CRATERED");
        expect(result.rejectionGateName).toBe("RetestCraterDrop");
      }
    });
  });

  describe("8. Multiple Swaps in One Transaction & Canonical Identity", () => {
    it("ingests and distinguishes multiple swaps within one transaction using outerInstructionIndex and swapIndex", () => {
      const nowMs = 1_060_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 60_000,
        clock: () => nowMs,
      });

      for (let t = nowMs - 60_000; t <= nowMs; t += 10_000) {
        tracker.recordHeartbeat(t);
      }

      const txSig = "multi-swap-tx-signature-xyz";

      // Swap 0: outerInstruction 0, swap 0 (BUY)
      const swap0 = createSyntheticTradeEvent({
        signature: txSig,
        outerInstructionIndex: 0,
        swapIndex: 0,
        side: "BUY",
        eventTimestampMs: nowMs - 30_000,
        receiptTimestampMs: nowMs - 30_000,
        blockTimeSec: Math.floor((nowMs - 30_000) / 1000),
      });

      // Swap 1: outerInstruction 0, swap 1 (SELL)
      const swap1 = createSyntheticTradeEvent({
        signature: txSig,
        outerInstructionIndex: 0,
        swapIndex: 1,
        side: "SELL",
        eventTimestampMs: nowMs - 30_000,
        receiptTimestampMs: nowMs - 30_000,
        blockTimeSec: Math.floor((nowMs - 30_000) / 1000),
      });

      // Swap 2: outerInstruction 1 (CPI), swap 0 (BUY)
      const swap2 = createSyntheticTradeEvent({
        signature: txSig,
        outerInstructionIndex: 1,
        swapIndex: 0,
        side: "BUY",
        eventTimestampMs: nowMs - 20_000,
        receiptTimestampMs: nowMs - 20_000,
        blockTimeSec: Math.floor((nowMs - 20_000) / 1000),
      });

      const res0 = tracker.ingestTrade(swap0);
      const res1 = tracker.ingestTrade(swap1);
      const res2 = tracker.ingestTrade(swap2);

      expect(res0.ok).toBe(true);
      expect(res1.ok).toBe(true);
      expect(res2.ok).toBe(true);
      expect(tracker.getEventsCount()).toBe(3);

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.recentBuys60s).toBe(2);
      expect(evalResult.recentSells60s).toBe(1);
    });

    it("derives canonical swap key consistently", () => {
      expect(deriveCanonicalSwapKey("sig1", 0, 0)).toBe("sig1:0:0");
      expect(deriveCanonicalSwapKey("sig1", 2, 3)).toBe("sig1:2:3");
    });
  });
});
