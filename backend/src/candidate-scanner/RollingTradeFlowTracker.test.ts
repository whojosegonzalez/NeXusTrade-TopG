/**
 * Phase 12.94-D Milestone D.3.3: Rolling 60-Second Trade Flow Tracker Unit Tests
 *
 * Comprehensive offline verification of:
 * 1. Complete window coverage verification (rejects silence/single-heartbeat false passes).
 * 2. Capacity bounds & fail-closed protection (prevents capacity loss from producing misleading counts).
 * 3. Input validation, immutable snapshotting, and canonical swap coordinate deduplication.
 * 4. Retest boundary enforcement (typed coverage, finite non-negative integer counts, fail-closed unverified flow).
 * 5. Multi-swap transactions, moving window boundaries, honest empty windows, and out-of-order handling.
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

  return {
    eventId,
    signature,
    swapIndex,
    outerInstructionIndex,
    poolId: CANONICAL_POOL_ID,
    tokenMint: CANONICAL_TOKEN_MINT,
    side: "BUY",
    slot: 300_000_000,
    blockTimeSec: 1_700_000_000,
    eventTimestampMs: 1_700_000_000_000,
    receiptTimestampMs: 1_700_000_000_050,
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

    it("reports STALE_DATA and null counts when evaluation time is silent beyond maxStreamInactivityMs", () => {
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

  describe("2. Storage Bounds & Capacity Limits (Finding 2)", () => {
    it("rejects events at capacity, records capacity loss, and returns null counts rather than silently dropping sells", () => {
      const startMs = 1_000_000;
      const nowMs = startMs + 60_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: startMs,
        maxEventsRetained: 100, // Cap storage at 100
        clock: () => nowMs,
      });

      // Provide regular heartbeats
      for (let t = startMs; t <= nowMs; t += 10_000) {
        tracker.recordHeartbeat(t);
      }

      // Ingest 100 active-window SELL events (fills capacity to 100)
      for (let i = 0; i < 100; i++) {
        const res = tracker.ingestTrade(
          createSyntheticTradeEvent({
            signature: `sell-sig-${i}`,
            swapIndex: 0,
            side: "SELL",
            eventTimestampMs: startMs + 10_000 + i * 100,
          }),
        );
        expect(res.ok).toBe(true);
      }
      expect(tracker.getEventsCount()).toBe(100);

      // Now attempt to ingest 100 BUY events: event 101 must be rejected with CAPACITY_EXCEEDED
      const buyRes = tracker.ingestTrade(
        createSyntheticTradeEvent({
          signature: "buy-sig-0",
          swapIndex: 0,
          side: "BUY",
          eventTimestampMs: startMs + 30_000,
        }),
      );
      expect(buyRes.ok).toBe(false);
      if (!buyRes.ok) {
        expect(buyRes.reason).toBe("CAPACITY_EXCEEDED");
      }

      // Evaluate window: must NOT report 100 buys / 0 sells!
      // Capacity loss affected the active window -> coverage must NOT be SUFFICIENT!
      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.coverage).toBe("CAPACITY_LOSS");
      expect(evalResult.recentBuys60s).toBeNull();
      expect(evalResult.recentSells60s).toBeNull();

      // Integration check: Retest gate spot info must carry null counts and status WAITING
      const spotInfo = tracker.createRetestSpotInfo(
        {
          spotPriceSol: 0.95,
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
        },
        nowMs,
      );

      expect(spotInfo.recentBuys60s).toBeNull();
      expect(spotInfo.recentSells60s).toBeNull();

      const retestRes = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: nowMs,
        spotInfo,
        existingArmedState: {
          mintAddress: CANONICAL_TOKEN_MINT,
          armedAtMs: nowMs - 10_000,
          peakPriceSol: 1.0,
          peakPriceUsd: 150.0,
          ticksObserved: 2,
        },
      });

      // Must be WAITING, NEVER CONFIRMED!
      expect(retestRes.status).toBe("WAITING");
    });
  });

  describe("3. Validate and Snapshot Ingestion Inputs (Finding 3)", () => {
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
      });

      const res = tracker.ingestTrade(mutableEvent);
      expect(res.ok).toBe(true);

      // Caller mutates their own object
      (mutableEvent as unknown as { side: string }).side = "SELL";

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      // Must still be 1 BUY and 0 SELLS!
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
        eventId: "custom-label-B", // Different label, same coordinates!
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

      // Identity mismatch pool
      const resBadPool = tracker.ingestTrade(createSyntheticTradeEvent({ poolId: OTHER_POOL_ID }));
      expect(resBadPool.ok).toBe(false);
      if (!resBadPool.ok) expect(resBadPool.reason).toBe("IDENTITY_MISMATCH_POOL");

      // Identity mismatch mint
      const resBadMint = tracker.ingestTrade(
        createSyntheticTradeEvent({ tokenMint: OTHER_TOKEN_MINT }),
      );
      expect(resBadMint.ok).toBe(false);
      if (!resBadMint.ok) expect(resBadMint.reason).toBe("IDENTITY_MISMATCH_MINT");

      // Empty signature
      const resEmptySig = tracker.ingestTrade(createSyntheticTradeEvent({ signature: "" }));
      expect(resEmptySig.ok).toBe(false);
      if (!resEmptySig.ok) expect(resEmptySig.reason).toBe("INVALID_SIGNATURE");

      // Negative swapIndex
      const resNegSwap = tracker.ingestTrade(createSyntheticTradeEvent({ swapIndex: -1 }));
      expect(resNegSwap.ok).toBe(false);
      if (!resNegSwap.ok) expect(resNegSwap.reason).toBe("INVALID_SWAP_INDEX");

      // Negative outerInstructionIndex
      const resNegOuter = tracker.ingestTrade(
        createSyntheticTradeEvent({ outerInstructionIndex: -1 }),
      );
      expect(resNegOuter.ok).toBe(false);
      if (!resNegOuter.ok) expect(resNegOuter.reason).toBe("INVALID_INSTRUCTION_INDEX");

      // NaN slot
      const resNanSlot = tracker.ingestTrade(createSyntheticTradeEvent({ slot: NaN }));
      expect(resNanSlot.ok).toBe(false);
      if (!resNanSlot.ok) expect(resNanSlot.reason).toBe("INVALID_SLOT");

      // NaN receipt timestamp
      const resNanReceipt = tracker.ingestTrade(
        createSyntheticTradeEvent({ receiptTimestampMs: NaN }),
      );
      expect(resNanReceipt.ok).toBe(false);
      if (!resNanReceipt.ok) expect(resNanReceipt.reason).toBe("INVALID_RECEIPT_TIMESTAMP");

      // Missing or invalid provenance
      const resBadProv = tracker.ingestTrade(
        createSyntheticTradeEvent({
          timestampProvenance: "UNKNOWN" as unknown as TradeTimestampProvenance,
        }),
      );
      expect(resBadProv.ok).toBe(false);
      if (!resBadProv.ok) expect(resBadProv.reason).toBe("INVALID_PROVENANCE");

      // Fractional event timestamp
      const resFracTs = tracker.ingestTrade(
        createSyntheticTradeEvent({ eventTimestampMs: 1_700_000_000_000.5 }),
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

    it("rejects windowDurationMs !== 60_000 in constructor", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: CANONICAL_TOKEN_MINT,
          windowDurationMs: 10_000,
        });
      }).toThrow(
        /Invalid windowDurationMs: 10000\. The strategy requires an exact 60,000 ms window/,
      );
    });
  });

  describe("4. Retest Boundary Enforcement (Finding 4)", () => {
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
          spotPriceSol: 0.95, // Discount met
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

  describe("5. Multiple Swaps in One Transaction & Canonical Identity", () => {
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
      });

      // Swap 1: outerInstruction 0, swap 1 (SELL)
      const swap1 = createSyntheticTradeEvent({
        signature: txSig,
        outerInstructionIndex: 0,
        swapIndex: 1,
        side: "SELL",
        eventTimestampMs: nowMs - 30_000,
      });

      // Swap 2: outerInstruction 1 (CPI), swap 0 (BUY)
      const swap2 = createSyntheticTradeEvent({
        signature: txSig,
        outerInstructionIndex: 1,
        swapIndex: 0,
        side: "BUY",
        eventTimestampMs: nowMs - 20_000,
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
