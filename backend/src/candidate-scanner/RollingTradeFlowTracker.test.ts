/**
 * Phase 12.94-D Milestone D.3.3: Rolling 60-Second Trade Flow Tracker Unit Tests
 *
 * Comprehensive offline verification of:
 * 1. Strict pool and token mint identity binding.
 * 2. Stable event identifiers distinguishing multiple swaps per transaction.
 * 3. Exact deduplication and out-of-order event ingestion.
 * 4. Dynamic 60-second moving window recalculation and boundary enforcement.
 * 5. Explicit coverage classification: WARM_UP, COLLECTION_GAP, STALE_DATA, SUFFICIENT.
 * 6. Unavailable counts (null) for insufficient coverage vs honest zero for observed empty window.
 * 7. Bounded retention and memory protection.
 * 8. Narrow integration with RetestGateEvaluator (unavailable flow never produces entry confirmation).
 *
 * ALL tests execute 100% offline with synthetic fixtures and zero network activity.
 */

import { describe, expect, it } from "vitest";
import { RollingTradeFlowTracker, type TradeEvent } from "./RollingTradeFlowTracker.js";
import { evaluateRetestGate } from "./RetestGateEvaluator.js";

// Canonical 32-byte test fixture addresses
const CANONICAL_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const CANONICAL_TOKEN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const OTHER_POOL_ID = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const OTHER_TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC

function createSyntheticTradeEvent(overrides: Partial<TradeEvent> = {}): TradeEvent {
  const eventId = overrides.eventId ?? `tx-${Date.now()}:0`;
  const [signature = "sig123", swapIndexStr = "0"] = eventId.split(":");
  return {
    eventId,
    signature,
    swapIndex: Number(swapIndexStr),
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

describe("RollingTradeFlowTracker", () => {
  describe("Constructor & Initialization Validation", () => {
    it("initializes with canonical pool and mint identities", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: 1_000_000,
      });

      expect(tracker.getPoolId()).toBe(CANONICAL_POOL_ID);
      expect(tracker.getTokenMint()).toBe(CANONICAL_TOKEN_MINT);
      expect(tracker.getTrackingStartedMs()).toBe(1_000_000);
      expect(tracker.getEventsCount()).toBe(0);
    });

    it("fails closed on malformed or non-canonical poolId", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: "invalid_non_base58_0OIl",
          tokenMint: CANONICAL_TOKEN_MINT,
        });
      }).toThrow(/Invalid or non-canonical poolId/);
    });

    it("fails closed on malformed or non-canonical tokenMint", () => {
      expect(() => {
        new RollingTradeFlowTracker({
          poolId: CANONICAL_POOL_ID,
          tokenMint: "short_mint",
        });
      }).toThrow(/Invalid or non-canonical tokenMint/);
    });
  });

  describe("Identity Binding & Ingestion Validation", () => {
    it("rejects trade event with mismatched pool ID", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      });

      const event = createSyntheticTradeEvent({
        poolId: OTHER_POOL_ID,
      });

      const res = tracker.ingestTrade(event);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("IDENTITY_MISMATCH_POOL");
      }
      expect(tracker.getEventsCount()).toBe(0);
    });

    it("rejects trade event with mismatched token mint", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      });

      const event = createSyntheticTradeEvent({
        tokenMint: OTHER_TOKEN_MINT,
      });

      const res = tracker.ingestTrade(event);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("IDENTITY_MISMATCH_MINT");
      }
      expect(tracker.getEventsCount()).toBe(0);
    });

    it("rejects trade event with missing or empty eventId", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      });

      const event = createSyntheticTradeEvent({ eventId: "" });
      const res = tracker.ingestTrade(event);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("MISSING_EVENT_ID");
      }
    });

    it("rejects trade event with invalid or non-positive timestamp", () => {
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
      });

      const resZero = tracker.ingestTrade(createSyntheticTradeEvent({ eventTimestampMs: 0 }));
      expect(resZero.ok).toBe(false);
      if (!resZero.ok) expect(resZero.reason).toBe("INVALID_TIMESTAMP");

      const resNegative = tracker.ingestTrade(
        createSyntheticTradeEvent({ eventTimestampMs: -100 }),
      );
      expect(resNegative.ok).toBe(false);
      if (!resNegative.ok) expect(resNegative.reason).toBe("INVALID_TIMESTAMP");

      const resNaN = tracker.ingestTrade(createSyntheticTradeEvent({ eventTimestampMs: NaN }));
      expect(resNaN.ok).toBe(false);
      if (!resNaN.ok) expect(resNaN.reason).toBe("INVALID_TIMESTAMP");
    });

    it("rejects trade event with future-dated timestamp exceeding allowable skew", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        maxFutureSkewMs: 5_000,
        clock: () => nowMs,
      });

      // 6 seconds in future (exceeds 5s skew)
      const res = tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventTimestampMs: nowMs + 6_000,
        }),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.reason).toBe("FUTURE_DATED_TIMESTAMP");
      }
    });
  });

  describe("Stable Event Identifiers & Multiple Swaps per Transaction", () => {
    it("distinguishes multiple swaps within the same transaction using distinct swapIndex", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 70_000, // Sufficiently warmed up
        clock: () => nowMs,
      });

      const txSig = "5J9XzMvY4bA7sD1fG2h3j4k5L6m7N8p9";

      // Swap 0: User buys candidate token
      const swap0 = createSyntheticTradeEvent({
        eventId: `${txSig}:0`,
        signature: txSig,
        swapIndex: 0,
        side: "BUY",
        eventTimestampMs: nowMs - 30_000,
      });

      // Swap 1: Router sells candidate token in same tx
      const swap1 = createSyntheticTradeEvent({
        eventId: `${txSig}:1`,
        signature: txSig,
        swapIndex: 1,
        side: "SELL",
        eventTimestampMs: nowMs - 30_000,
      });

      const res0 = tracker.ingestTrade(swap0);
      const res1 = tracker.ingestTrade(swap1);
      tracker.recordHeartbeat(nowMs);

      expect(res0.ok).toBe(true);
      expect(res1.ok).toBe(true);
      expect(tracker.getEventsCount()).toBe(2);

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.recentBuys60s).toBe(1);
      expect(evalResult.recentSells60s).toBe(1);
    });
  });

  describe("Deduplication & Out-of-Order Ingestion", () => {
    it("deduplicates identical eventId and prevents double-counting", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 70_000,
        clock: () => nowMs,
      });

      const event = createSyntheticTradeEvent({
        eventId: "sig-repeat:0",
        side: "BUY",
        eventTimestampMs: nowMs - 20_000,
      });

      const first = tracker.ingestTrade(event);
      expect(first.ok).toBe(true);

      const duplicate = tracker.ingestTrade(event);
      expect(duplicate.ok).toBe(false);
      if (!duplicate.ok) {
        expect(duplicate.reason).toBe("DUPLICATE_EVENT");
      }

      expect(tracker.getEventsCount()).toBe(1);

      tracker.recordHeartbeat(nowMs);
      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.recentBuys60s).toBe(1);
      expect(evalResult.diagnostics.deduplicatedEventsCount).toBe(1);
    });

    it("ingests out-of-order events and sorts chronologically", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 100_000,
        clock: () => nowMs,
      });

      // Ingest at t - 10s, then t - 40s, then t - 20s, then t - 50s
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "e1:0",
          eventTimestampMs: nowMs - 10_000,
          side: "BUY",
        }),
      );
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "e2:0",
          eventTimestampMs: nowMs - 40_000,
          side: "SELL",
        }),
      );
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "e3:0",
          eventTimestampMs: nowMs - 20_000,
          side: "BUY",
        }),
      );
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "e4:0",
          eventTimestampMs: nowMs - 50_000,
          side: "BUY",
        }),
      );

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.recentBuys60s).toBe(3);
      expect(evalResult.recentSells60s).toBe(1);
    });
  });

  describe("Dynamic 60-Second Moving Window Recalculation & Boundary Rules", () => {
    it("evaluates window dynamically on demand without imposing a 60-second evaluation interval", () => {
      let currentClock = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: currentClock - 100_000,
        clock: () => currentClock,
      });

      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "t1:0",
          eventTimestampMs: currentClock - 15_000,
          side: "BUY",
        }),
      );
      tracker.recordHeartbeat(currentClock);

      // Evaluate at t = 1,000,000
      const eval1 = tracker.evaluateWindow(currentClock);
      expect(eval1.recentBuys60s).toBe(1);

      // Evaluate 1,500 ms later (ticker interval)
      currentClock += 1_500;
      tracker.recordHeartbeat(currentClock);
      const eval2 = tracker.evaluateWindow(currentClock);
      expect(eval2.recentBuys60s).toBe(1);
      expect(eval2.windowEndMs - eval2.windowStartMs).toBe(60_000);
    });

    it("strictly respects closed window boundaries [now - 60s, now]", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 100_000,
        clock: () => nowMs,
      });

      // Trade 1: Exactly at window start (now - 60,000) -> INCLUDED
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "b-exact-start:0",
          eventTimestampMs: nowMs - 60_000,
          side: "BUY",
        }),
      );

      // Trade 2: Exactly at window end (now) -> INCLUDED
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "b-exact-end:0",
          eventTimestampMs: nowMs,
          side: "BUY",
        }),
      );

      // Trade 3: 1ms before window start (now - 60,001) -> EXCLUDED
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "b-before-start:0",
          eventTimestampMs: nowMs - 60_001,
          side: "SELL",
        }),
      );

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.recentBuys60s).toBe(2);
      expect(evalResult.recentSells60s).toBe(0);
    });

    it("evicts older trades from 60s counts as the evaluation window moves forward", () => {
      const startMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: startMs - 100_000,
        clock: () => startMs,
      });

      // Trade occurred at startMs - 50s
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "decay-trade:0",
          eventTimestampMs: startMs - 50_000,
          side: "BUY",
        }),
      );
      tracker.recordHeartbeat(startMs);

      // At startMs: trade is within [startMs - 60s, startMs]
      const eval1 = tracker.evaluateWindow(startMs);
      expect(eval1.recentBuys60s).toBe(1);

      // Advance evaluation by 15s to startMs + 15s: window is [startMs - 45s, startMs + 15s]
      // Trade at startMs - 50s is now outside window!
      tracker.recordHeartbeat(startMs + 15_000);
      const eval2 = tracker.evaluateWindow(startMs + 15_000);
      expect(eval2.recentBuys60s).toBe(0);
    });
  });

  describe("Coverage Guarantees: Warm-Up, Collection Gaps, Stale Data & Sufficient Coverage", () => {
    it("returns WARM_UP and null counts when tracking duration is under 60 seconds", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 45_000, // Only 45s of tracking (warm-up)
        clock: () => nowMs,
      });

      // Even if trades are ingested during warm-up:
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "warm-buy:0",
          eventTimestampMs: nowMs - 10_000,
          side: "BUY",
        }),
      );

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("WARM_UP");
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.recentBuys60s).toBeNull();
      expect(evalResult.recentSells60s).toBeNull();
      expect(evalResult.flowRatio).toBeNull();
    });

    it("returns COLLECTION_GAP and null counts when a recorded gap intersects the 60-second window", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 100_000, // Warmed up
        clock: () => nowMs,
      });

      // A WebSocket disconnection or collection drop occurred between now - 35s and now - 25s
      tracker.recordCollectionGap({
        gapStartMs: nowMs - 35_000,
        gapEndMs: nowMs - 25_000,
        reason: "WS_DISCONNECT_RECONNECT",
      });

      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "pre-gap:0",
          eventTimestampMs: nowMs - 45_000,
          side: "BUY",
        }),
      );
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "post-gap:0",
          eventTimestampMs: nowMs - 5_000,
          side: "BUY",
        }),
      );

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("COLLECTION_GAP");
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.recentBuys60s).toBeNull();
      expect(evalResult.recentSells60s).toBeNull();
      expect(evalResult.diagnostics.gapCount).toBe(1);
    });

    it("returns STALE_DATA and null counts when stream inactivity exceeds threshold", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 100_000,
        maxStreamInactivityMs: 15_000,
        clock: () => nowMs,
      });

      // Last activity (trade or heartbeat) was 25 seconds ago (exceeds 15s max inactivity)
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "stale-trade:0",
          eventTimestampMs: nowMs - 25_000,
          side: "BUY",
        }),
      );
      tracker.recordHeartbeat(nowMs - 25_000);

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("STALE_DATA");
      expect(evalResult.isCoverageSufficient).toBe(false);
      expect(evalResult.recentBuys60s).toBeNull();
      expect(evalResult.recentSells60s).toBeNull();
    });

    it("recovers to SUFFICIENT coverage when stream heartbeat confirms ongoing liveness", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 100_000,
        maxStreamInactivityMs: 15_000,
        clock: () => nowMs,
      });

      // Heartbeat at now - 2s confirms stream is alive
      tracker.recordHeartbeat(nowMs - 2_000, 300_000_500);
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "live-trade:0",
          eventTimestampMs: nowMs - 10_000,
          side: "BUY",
        }),
      );

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.isCoverageSufficient).toBe(true);
      expect(evalResult.recentBuys60s).toBe(1);
      expect(evalResult.recentSells60s).toBe(0);
      expect(tracker.getLastObservedSlot()).toBe(300_000_500);
    });

    it("reports honest zero (recentBuys60s = 0, recentSells60s = 0) only for a sufficiently observed window containing no trades", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 120_000, // Tracking for 2 minutes
        clock: () => nowMs,
      });

      // Regular heartbeats prove continuous connection, but 0 trades occurred
      tracker.recordHeartbeat(nowMs - 5_000);

      const evalResult = tracker.evaluateWindow(nowMs);
      expect(evalResult.coverage).toBe("SUFFICIENT");
      expect(evalResult.isCoverageSufficient).toBe(true);
      // Genuinely observed empty window: reports 0, NOT null!
      expect(evalResult.recentBuys60s).toBe(0);
      expect(evalResult.recentSells60s).toBe(0);
      expect(evalResult.flowRatio).toBe(1.0);
    });
  });

  describe("Bounded Retention & Storage", () => {
    it("prunes events and deduplication keys older than retention window", () => {
      const startMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: startMs - 300_000,
        retentionWindowMs: 120_000, // 2 minutes retention
        clock: () => startMs,
      });

      // Old event from 200s ago
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "very-old:0",
          eventTimestampMs: startMs - 200_000,
          side: "BUY",
        }),
      );
      // Fresh event from 30s ago
      tracker.ingestTrade(
        createSyntheticTradeEvent({
          eventId: "fresh:0",
          eventTimestampMs: startMs - 30_000,
          side: "BUY",
        }),
      );

      expect(tracker.getEventsCount()).toBe(2);

      // Trigger evaluation -> triggers pruning
      tracker.recordHeartbeat(startMs);
      const evalResult = tracker.evaluateWindow(startMs);
      expect(evalResult.recentBuys60s).toBe(1);
      expect(tracker.getEventsCount()).toBe(1); // Old event pruned from buffer
    });

    it("enforces maxEventsRetained ceiling to protect memory", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 100_000,
        maxEventsRetained: 100,
        clock: () => nowMs,
      });

      // Ingest 150 events
      for (let i = 0; i < 150; i++) {
        tracker.ingestTrade(
          createSyntheticTradeEvent({
            eventId: `burst-${i}:0`,
            eventTimestampMs: nowMs - 50_000 + i * 100,
            side: "BUY",
          }),
        );
      }

      tracker.recordHeartbeat(nowMs);
      tracker.evaluateWindow(nowMs);

      // Must be capped at maxEventsRetained (100)
      expect(tracker.getEventsCount()).toBeLessThanOrEqual(100);
    });
  });

  describe("RetestGateEvaluator Integration Path", () => {
    it("prevents entry confirmation when flow is unavailable (WARM_UP)", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 30_000, // In warm-up (< 60s)
        clock: () => nowMs,
      });

      const spotInfo = tracker.createRetestSpotInfo(
        {
          spotPriceSol: 0.95, // 5% pullback discount (Rule A price criteria met for Established)
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
        },
        nowMs,
      );

      expect(spotInfo.recentBuys60s).toBeNull();
      expect(spotInfo.recentSells60s).toBeNull();

      const existingArmed = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: nowMs - 10_000,
        peakPriceSol: 1.0,
        peakPriceUsd: 150.0,
        ticksObserved: 2,
      };

      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: nowMs,
        spotInfo,
        existingArmedState: existingArmed,
      });

      // Crucial requirement: Unavailable flow MUST NOT produce entry confirmation!
      expect(result.status).toBe("WAITING");
    });

    it("prevents entry confirmation when flow is a genuinely observed empty window (0 buys, 0 sells)", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 120_000, // Fully warmed up
        clock: () => nowMs,
      });

      // Stream is alive, but 0 trades happened
      tracker.recordHeartbeat(nowMs - 2_000);

      const spotInfo = tracker.createRetestSpotInfo(
        {
          spotPriceSol: 0.95, // 5% pullback discount
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
        },
        nowMs,
      );

      expect(spotInfo.recentBuys60s).toBe(0);
      expect(spotInfo.recentSells60s).toBe(0);

      const existingArmed = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: nowMs - 10_000,
        peakPriceSol: 1.0,
        peakPriceUsd: 150.0,
        ticksObserved: 2,
      };

      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: nowMs,
        spotInfo,
        existingArmedState: existingArmed,
      });

      // Empty window (0 buys) must NOT confirm entry: zero volume cannot establish flow absorption!
      expect(result.status).toBe("WAITING");
    });

    it("confirms entry when flow is SUFFICIENT and meets flow absorption threshold (Rule A)", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 120_000,
        clock: () => nowMs,
      });

      // Ingest 23 buys and 10 sells (23 >= 1.15 * 10 = 11.5, ratio = 2.3x)
      for (let i = 0; i < 23; i++) {
        tracker.ingestTrade(
          createSyntheticTradeEvent({
            eventId: `buy-${i}:0`,
            eventTimestampMs: nowMs - 30_000 + i * 500,
            side: "BUY",
          }),
        );
      }
      for (let i = 0; i < 10; i++) {
        tracker.ingestTrade(
          createSyntheticTradeEvent({
            eventId: `sell-${i}:0`,
            eventTimestampMs: nowMs - 20_000 + i * 500,
            side: "SELL",
          }),
        );
      }
      tracker.recordHeartbeat(nowMs - 1_000);

      const spotInfo = tracker.createRetestSpotInfo(
        {
          spotPriceSol: 0.95, // 5% pullback discount
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
        },
        nowMs,
      );

      expect(spotInfo.recentBuys60s).toBe(23);
      expect(spotInfo.recentSells60s).toBe(10);

      const existingArmed = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: nowMs - 10_000,
        peakPriceSol: 1.0,
        peakPriceUsd: 150.0,
        ticksObserved: 2,
      };

      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: nowMs,
        spotInfo,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("CONFIRMED");
      if (result.status === "CONFIRMED") {
        expect(result.confirmReason).toBe("RETEST_PULLBACK_DISCOUNT");
      }
    });

    it("rejects candidate when seller surge is observed during armed wait (Rule E)", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 120_000,
        clock: () => nowMs,
      });

      // Ingest 28 sells and 5 buys (sells >= 25 && sells >= 2.5 * buys: 28 >= 2.5 * 5 = 12.5)
      for (let i = 0; i < 5; i++) {
        tracker.ingestTrade(
          createSyntheticTradeEvent({
            eventId: `b-${i}:0`,
            eventTimestampMs: nowMs - 30_000 + i * 500,
            side: "BUY",
          }),
        );
      }
      for (let i = 0; i < 28; i++) {
        tracker.ingestTrade(
          createSyntheticTradeEvent({
            eventId: `s-${i}:0`,
            eventTimestampMs: nowMs - 20_000 + i * 500,
            side: "SELL",
          }),
        );
      }
      tracker.recordHeartbeat(nowMs - 500);

      const spotInfo = tracker.createRetestSpotInfo(
        {
          spotPriceSol: 0.95,
          spotPriceUsd: 142.5,
          liquidityUsd: 100_000,
        },
        nowMs,
      );

      const existingArmed = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: nowMs - 10_000,
        peakPriceSol: 1.0,
        peakPriceUsd: 150.0,
        ticksObserved: 2,
      };

      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: true,
        currentNowMs: nowMs,
        spotInfo,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectReason).toBe("REJECTED_IN_FLIGHT_SELLER_SURGE");
        expect(result.rejectionGateName).toBe("RetestSellerSurge");
      }
    });

    it("preserves crater drop rejection even when flow is unavailable", () => {
      const nowMs = 1_000_000;
      const tracker = new RollingTradeFlowTracker({
        poolId: CANONICAL_POOL_ID,
        tokenMint: CANONICAL_TOKEN_MINT,
        trackingStartedMs: nowMs - 30_000, // WARM_UP -> flow unavailable
        clock: () => nowMs,
      });

      const spotInfo = tracker.createRetestSpotInfo(
        {
          spotPriceSol: 0.8, // 20% plunge (exceeds 15% micro-cap crater ceiling)
          spotPriceUsd: 120.0,
          liquidityUsd: 30_000,
        },
        nowMs,
      );

      expect(spotInfo.recentBuys60s).toBeNull();

      const existingArmed = {
        mintAddress: CANONICAL_TOKEN_MINT,
        armedAtMs: nowMs - 10_000,
        peakPriceSol: 1.0,
        peakPriceUsd: 150.0,
        ticksObserved: 2,
      };

      const result = evaluateRetestGate({
        mintAddress: CANONICAL_TOKEN_MINT,
        isEstablished: false,
        currentNowMs: nowMs,
        spotInfo,
        existingArmedState: existingArmed,
      });

      expect(result.status).toBe("REJECTED");
      if (result.status === "REJECTED") {
        expect(result.rejectReason).toBe("REJECTED_PULLBACK_CRATERED");
      }
    });
  });
});
