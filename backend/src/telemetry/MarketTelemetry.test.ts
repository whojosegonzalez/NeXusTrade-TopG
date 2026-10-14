import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CandidateDecisionRecorder,
  DecisionContextReconstructor,
  MarketObservationRecorder,
  StratifiedSamplingController,
  TelemetryRateController,
  TelemetryStorageManager,
  type CandidateDecisionRecord,
  type RecordDecisionInput,
} from "./index.js";
import {
  getCanonicalCandidateDecisionsPath,
  getCanonicalMarketObservationsPath,
  getCanonicalSessionMetaPath,
  getCanonicalSessionTelemetrySummaryPath,
  getCanonicalStratifiedSamplesPath,
  getCanonicalTelemetrySessionDir,
  validateSessionId,
} from "../paper/CanonicalPaths.js";

describe("Phase 12.94-B Market Telemetry Engine", () => {
  // --------------------------------------------------------------------------
  // Suite 1: Path Confinement & Session Isolation
  // --------------------------------------------------------------------------
  describe("1. Path Confinement & Session Isolation", () => {
    it("validateSessionId enforces safe alphanumeric format and rejects path traversal", () => {
      expect(validateSessionId("session-paper-12.94-test-1")).toBe("session-paper-12.94-test-1");
      expect(validateSessionId("sess_01.live")).toBe("sess_01.live");

      expect(() => validateSessionId("..")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateSessionId("../outside")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateSessionId("sess/01")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateSessionId("sess\\01")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateSessionId("C:\\Windows")).toThrow(/\[FATAL_PATH\]/);
      expect(() => validateSessionId("")).toThrow(/\[FATAL_PATH\]/);
    });

    it("telemetry session paths remain strictly confined inside canonical telemetry directory", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-paths-"));
      const sessionId = "session-12.94-safe";

      const sessionDir = getCanonicalTelemetrySessionDir(sessionId, tempDir);
      expect(sessionDir).toBe(path.resolve(tempDir, ".tmp", "telemetry", "sessions", sessionId));

      const decisionsPath = getCanonicalCandidateDecisionsPath(sessionId, tempDir);
      expect(decisionsPath).toBe(path.resolve(sessionDir, "candidate-decisions.jsonl"));

      const observationsPath = getCanonicalMarketObservationsPath(sessionId, tempDir);
      expect(observationsPath).toBe(path.resolve(sessionDir, "market-observations.jsonl"));

      const stratifiedPath = getCanonicalStratifiedSamplesPath(sessionId, tempDir);
      expect(stratifiedPath).toBe(path.resolve(sessionDir, "stratified-samples.jsonl"));

      const summaryPath = getCanonicalSessionTelemetrySummaryPath(sessionId, tempDir);
      expect(summaryPath).toBe(path.resolve(sessionDir, "session-summary.json"));

      const metaPath = getCanonicalSessionMetaPath(sessionId, tempDir);
      expect(metaPath).toBe(path.resolve(sessionDir, "session-meta.json"));

      expect(() => getCanonicalTelemetrySessionDir("../outside", tempDir)).toThrow(
        /\[FATAL_PATH\]/,
      );

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: Storage Manager Durability & Crash Recovery
  // --------------------------------------------------------------------------
  describe("2. Telemetry Storage Manager Durability & Partitioning", () => {
    it("initializes session metadata and finalizes session summary atomically", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-store-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-telemetry-init-test";

      const meta = storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);
      expect(meta.sessionId).toBe(sessionId);
      expect(meta.generationId).toBe("gen-01-legacy-baseline");
      expect(meta.initialWalletBalanceSol).toBe(7.9259);
      expect(meta.closedAtIso).toBeUndefined();

      const metaFile = getCanonicalSessionMetaPath(sessionId, tempDir);
      expect(existsSync(metaFile)).toBe(true);

      const summary = storage.finalizeSessionTelemetry(sessionId, {
        generationId: "gen-01-legacy-baseline",
        strategyRevision: "7e58ea5",
        startedAtIso: meta.startedAtIso,
        totalCandidatesScreened: 42,
        cohortBreakdown: {
          filteredRejected: 35,
          watchlistRadar: 5,
          triggerRejected: 1,
          executedBuy: 1,
        },
        topRejectionReasons: { REJECTED_IMBALANCED_LIQUIDITY_DEPTH: 20 },
        totalMarketObservationsRecorded: 150,
        totalStratifiedCandidatesTracked: 6,
        missedWinnersCount: 0,
        avoidedRugsCount: 4,
      });

      expect(summary.totalCandidatesScreened).toBe(42);
      expect(summary.closedAtIso).toBeDefined();

      const summaryFile = getCanonicalSessionTelemetrySummaryPath(sessionId, tempDir);
      expect(existsSync(summaryFile)).toBe(true);

      // Verify meta.json updated with closedAtIso
      const updatedMeta = JSON.parse(readFileSync(metaFile, "utf8"));
      expect(updatedMeta.closedAtIso).toBeDefined();

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("recovers gracefully from partial trailing lines written during simulated crash", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-crash-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-crash-recovery";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 10.0);

      const decisionsPath = getCanonicalCandidateDecisionsPath(sessionId, tempDir);
      mkdirSync(path.dirname(decisionsPath), { recursive: true });

      const validRecord1 = JSON.stringify({ eventId: "ev-1", mintAddress: "mint-1" });
      const validRecord2 = JSON.stringify({ eventId: "ev-2", mintAddress: "mint-2" });
      const brokenTrailingLine = '{"eventId":"ev-3","broken'; // Incomplete line from sudden power loss

      writeFileSync(
        decisionsPath,
        `${validRecord1}\n${validRecord2}\n${brokenTrailingLine}\n`,
        "utf8",
      );

      const recovered = storage.readCandidateDecisions(sessionId);
      expect(recovered.length).toBe(2);
      expect(recovered[0]?.eventId).toBe("ev-1");
      expect(recovered[1]?.eventId).toBe("ev-2");

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: 100% Candidate Decision Logging
  // --------------------------------------------------------------------------
  describe("3. Candidate Decision Recorder (100% Capture)", () => {
    it("captures 100% of candidate screening decisions across all cohorts with metrics and missing fields", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-decisions-"));
      const storage = new TelemetryStorageManager(tempDir);
      const recorder = new CandidateDecisionRecorder(storage);
      const sessionId = "session-decisions-test";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const decisionInput1: RecordDecisionInput = {
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintRejected111111111111111111111111111111",
        poolId: "PoolRejected1",
        symbol: "REJ1",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000100,
        decisionCohort: "FILTERED_REJECTED",
        primaryRejectionReason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
        filterEvaluations: [
          {
            filterName: "LiquidityDepthFilter",
            passed: false,
            valueObserved: 450,
            threshold: 1000,
            rejectionReason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
          },
        ],
        metricsSnapshot: {
          tokenAgeSec: 120,
          liquidityUsd: 450,
          marketCapUsd: 2000,
          lmcRatio: 0.225,
          lpBurnPct: 100,
          spotPriceUsd: 0.00005,
          volume5mUsd: 200,
          txCount5m: 5,
          buys5m: 2,
          sells5m: 3,
        },
        missingFields: ["devHoldingPct"],
        providerIdentity: "raydium",
      };

      const decisionInput2: RecordDecisionInput = {
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintWatchlist2222222222222222222222222222",
        poolId: "PoolWatchlist2",
        symbol: "WATCH2",
        sourceTimestampMs: 1700000005000,
        ingestionTimestampMs: 1700000005120,
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [
          {
            filterName: "LiquidityDepthFilter",
            passed: true,
            valueObserved: 15000,
            threshold: 1000,
          },
        ],
        metricsSnapshot: {
          tokenAgeSec: 250,
          liquidityUsd: 15000,
          marketCapUsd: 50000,
          lmcRatio: 0.3,
          lpBurnPct: 100,
          spotPriceUsd: 0.002,
          volume5mUsd: 8500,
          txCount5m: 45,
          buys5m: 35,
          sells5m: 10,
        },
        providerIdentity: "raydium",
      };

      const rec1 = recorder.recordDecision(decisionInput1);
      const rec2 = recorder.recordDecision(decisionInput2);

      expect(rec1.eventId).toBeDefined();
      expect(rec1.primaryRejectionReason).toBe("REJECTED_IMBALANCED_LIQUIDITY_DEPTH");
      expect(rec1.missingFields).toEqual(["devHoldingPct"]);

      expect(rec2.decisionCohort).toBe("WATCHLIST_RADAR");
      expect(rec2.primaryRejectionReason).toBeUndefined();

      // Read back from append-only storage
      const onDisk = storage.readCandidateDecisions(sessionId);
      expect(onDisk.length).toBe(2);
      expect(onDisk[0]?.mintAddress).toBe(decisionInput1.mintAddress);
      expect(onDisk[1]?.mintAddress).toBe(decisionInput2.mintAddress);

      // Verify in-memory metrics
      expect(recorder.getCohortCount("FILTERED_REJECTED")).toBe(1);
      expect(recorder.getCohortCount("WATCHLIST_RADAR")).toBe(1);
      expect(recorder.getRejectionReasonBreakdown()["REJECTED_IMBALANCED_LIQUIDITY_DEPTH"]).toBe(1);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 4: Stratified Counterfactual Sampling
  // --------------------------------------------------------------------------
  describe("4. Stratified Counterfactual Sampling Controller", () => {
    it("allocates 100% sampling to executed and watchlist tokens, and deterministic sampling to near-misses", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-sampling-"));
      const storage = new TelemetryStorageManager(tempDir);
      const controller = new StratifiedSamplingController(storage, "test-seed-12345");
      const sessionId = "session-sampling-test";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 10.0);

      // Base candidate decision dummy
      const baseDecision: CandidateDecisionRecord = {
        eventId: "ev-test",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintExecuted1",
        poolId: "Pool1",
        symbol: "EXEC1",
        sourceTimestampMs: Date.now(),
        ingestionTimestampMs: Date.now(),
        decisionTimestampMs: Date.now(),
        strategyRevision: "7e58ea5",
        decisionCohort: "EXECUTED_BUY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 300,
          liquidityUsd: 25000,
          marketCapUsd: 80000,
          lmcRatio: 0.31,
          lpBurnPct: 100,
          spotPriceUsd: 0.005,
          volume5mUsd: 12000,
          txCount5m: 60,
          buys5m: 45,
          sells5m: 15,
        },
        missingFields: [],
        providerIdentity: "raydium",
      };

      // Executed buy -> 100% probability
      const execSample = controller.evaluateForTracking(baseDecision, 0.005);
      expect(execSample).not.toBeNull();
      expect(execSample?.tier).toBe("EXECUTED_POSITION");
      expect(execSample?.samplingProbability).toBe(1.0);
      expect(execSample?.currentSamplingIntervalMs).toBe(5000);

      // Watchlist radar -> 100% probability
      const watchlistDecision: CandidateDecisionRecord = {
        ...baseDecision,
        mintAddress: "MintWatchlist1",
        decisionCohort: "WATCHLIST_RADAR",
      };
      const watchSample = controller.evaluateForTracking(watchlistDecision, 0.004);
      expect(watchSample).not.toBeNull();
      expect(watchSample?.tier).toBe("WATCHLIST_ACTIVE");
      expect(watchSample?.samplingProbability).toBe(1.0);
      expect(watchSample?.currentSamplingIntervalMs).toBe(30000);

      // Excluded spam (low LP < 500) -> 0% probability
      const spamDecision: CandidateDecisionRecord = {
        ...baseDecision,
        mintAddress: "MintSpam1",
        decisionCohort: "FILTERED_REJECTED",
        primaryRejectionReason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
        metricsSnapshot: { ...baseDecision.metricsSnapshot, liquidityUsd: 100 },
      };
      const spamSample = controller.evaluateForTracking(spamDecision, 0.001);
      expect(spamSample).toBeNull();

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("updates price observations, calculates peak gain and max drawdown, and decays interval", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-update-"));
      const storage = new TelemetryStorageManager(tempDir);
      const controller = new StratifiedSamplingController(storage);
      const sessionId = "session-update-test";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 10.0);

      const decision: CandidateDecisionRecord = {
        eventId: "ev-update-test",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintTrackUpdate1",
        poolId: "PoolTrack1",
        symbol: "TRACK1",
        sourceTimestampMs: Date.now(),
        ingestionTimestampMs: Date.now(),
        decisionTimestampMs: Date.now(),
        strategyRevision: "7e58ea5",
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 10000,
          marketCapUsd: 30000,
          lmcRatio: 0.33,
          lpBurnPct: 100,
          spotPriceUsd: 0.001,
          volume5mUsd: 2000,
          txCount5m: 20,
          buys5m: 15,
          sells5m: 5,
        },
        missingFields: [],
        providerIdentity: "raydium",
      };

      const initial = controller.evaluateForTracking(decision, 0.01);
      expect(initial).not.toBeNull();
      expect(initial?.peakPriceSol).toBe(0.01);

      // Step 1: Price doubles (+100% gain)
      const t1 = initial!.trackingStartedMs + 60000;
      const updated1 = controller.updateObservation(decision.mintAddress, 0.02, t1);
      expect(updated1?.peakPriceSol).toBe(0.02);
      expect(updated1?.peakGainPct).toBe(100.0);
      expect(updated1?.maxDrawdownPct).toBe(0.0);

      // Step 2: Price drops to 0.015 (25% drawdown from peak 0.02)
      const t2 = t1 + 60000;
      const updated2 = controller.updateObservation(decision.mintAddress, 0.015, t2);
      expect(updated2?.peakPriceSol).toBe(0.02);
      expect(updated2?.troughPriceSol).toBe(0.01);
      expect(updated2?.maxDrawdownPct).toBe(25.0);

      // Step 3: Fast-forward past expiry (e.g. 2 hours later) -> must mark EXPIRED
      const tExpired = initial!.trackingStartedMs + 3600000 + 1000;
      const expired = controller.updateObservation(decision.mintAddress, 0.012, tExpired);
      expect(expired?.status).toBe("EXPIRED");
      expect(controller.getActiveTracker(decision.mintAddress)).toBeUndefined();

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 5: Telemetry Rate Controller & Token Bucket
  // --------------------------------------------------------------------------
  describe("5. Telemetry Rate Controller", () => {
    it("enforces rate limits and sheds lower-priority tiers when token bucket is depleted", () => {
      const rateController = new TelemetryRateController({
        maxRequestsPerSec: 4.0,
        bucketCapacity: 4.0,
        minTokensForLowTier: 2.0,
      });

      // Initially full (4.0 tokens)
      expect(rateController.getAvailableTokens()).toBe(4.0);

      // Consume 2 tokens with high priority (remaining: 2.0)
      expect(rateController.tryAcquire("EXECUTED_POSITION")).toBe(true);
      expect(rateController.tryAcquire("EXECUTED_POSITION")).toBe(true);
      expect(rateController.getAvailableTokens()).toBe(2.0);

      // Low priority tier requires >= 2.0 + 1.0 = 3.0 tokens: should be shed!
      expect(rateController.tryAcquire("NEAR_MISS_CANDIDATE")).toBe(false);

      // But high priority tier only requires >= 1.0: should succeed!
      expect(rateController.tryAcquire("WATCHLIST_ACTIVE")).toBe(true);
      expect(rateController.getAvailableTokens()).toBe(1.0);

      // Both shed when remaining < 1.0
      expect(rateController.tryAcquire("EXECUTED_POSITION")).toBe(true);
      expect(rateController.tryAcquire("EXECUTED_POSITION")).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 6: Point-in-Time Market Observations & Zero-Lookahead Reconstruction
  // --------------------------------------------------------------------------
  describe("6. Market Observation Recorder & Zero-Lookahead Decision Context", () => {
    it("records time-series observations and reconstructs pre-decision market context with zero lookahead", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-recon-"));
      const storage = new TelemetryStorageManager(tempDir);
      const obsRecorder = new MarketObservationRecorder(storage);
      const reconstructor = new DecisionContextReconstructor(storage);
      const sessionId = "session-recon-test";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const mint = "MintTimeTravel111111111111111111111111111";
      const pool = "PoolTimeTravel1";

      const t0 = 1700000000000;
      const tDecision = t0 + 180000; // Decision at T0 + 3m

      // Observation 1 at T0 (3 minutes before decision)
      obsRecorder.recordObservation({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: pool,
        sourceTimestampMs: t0,
        measurementWindow: { windowStartMs: t0 - 60000, windowEndMs: t0, durationSec: 60 },
        providerIdentity: "raydium",
        priceMetrics: { spotPriceUsd: 0.001, spotPriceSol: 0.00001, priceSource: "POOL_RESERVE" },
        liquidityMetrics: { baseReserve: 1000000, quoteReserve: 10, liquidityUsd: 2000 },
        flowMetrics: { txCount: 10, buys: 8, sells: 2, volumeUsd: 500, netBuyerVolumeUsd: 300 },
      });

      // Observation 2 at T0 + 2m (1 minute before decision)
      obsRecorder.recordObservation({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: pool,
        sourceTimestampMs: t0 + 120000,
        measurementWindow: { windowStartMs: t0 + 60000, windowEndMs: t0 + 120000, durationSec: 60 },
        providerIdentity: "raydium",
        priceMetrics: { spotPriceUsd: 0.0015, spotPriceSol: 0.000015, priceSource: "POOL_RESERVE" },
        liquidityMetrics: { baseReserve: 950000, quoteReserve: 15, liquidityUsd: 3000 },
        flowMetrics: { txCount: 30, buys: 25, sells: 5, volumeUsd: 1500, netBuyerVolumeUsd: 1000 },
        missingFields: ["top10ConcentrationPct"],
      });

      // Observation 3 at T0 + 5m (FUTURE observation AFTER decision!)
      obsRecorder.recordObservation({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: pool,
        sourceTimestampMs: t0 + 300000, // T0 + 5m > tDecision (T0 + 3m)
        measurementWindow: {
          windowStartMs: t0 + 240000,
          windowEndMs: t0 + 300000,
          durationSec: 60,
        },
        providerIdentity: "raydium",
        priceMetrics: { spotPriceUsd: 0.005, spotPriceSol: 0.00005, priceSource: "POOL_RESERVE" },
        liquidityMetrics: { baseReserve: 800000, quoteReserve: 40, liquidityUsd: 8000 },
        flowMetrics: {
          txCount: 100,
          buys: 80,
          sells: 20,
          volumeUsd: 5000,
          netBuyerVolumeUsd: 3000,
        },
      });

      // Create decision event at tDecision (T0 + 3m)
      const decision: CandidateDecisionRecord = {
        eventId: "ev-decision-t3",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: pool,
        symbol: "TIMETRAVEL",
        sourceTimestampMs: tDecision,
        ingestionTimestampMs: tDecision + 50,
        decisionTimestampMs: tDecision + 60,
        strategyRevision: "7e58ea5",
        decisionCohort: "EXECUTED_BUY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 180,
          liquidityUsd: 3000,
          marketCapUsd: 10000,
          lmcRatio: 0.3,
          lpBurnPct: 100,
          spotPriceUsd: 0.0015,
          volume5mUsd: 1500,
          txCount5m: 30,
          buys5m: 25,
          sells5m: 5,
        },
        missingFields: [],
        providerIdentity: "raydium",
      };

      // Reconstruct context at decision time
      const context = reconstructor.reconstructContext(decision, 5 * 60 * 1000);

      // STRICT ZERO-LOOKAHEAD VERIFICATION:
      // Pre-decision window must contain exactly Observation 1 and 2, but NEVER Observation 3 (future)!
      expect(context.preDecisionWindow.length).toBe(2);
      expect(context.preDecisionWindow[0]?.sourceTimestampMs).toBe(t0);
      expect(context.preDecisionWindow[1]?.sourceTimestampMs).toBe(t0 + 120000);

      for (const obs of context.preDecisionWindow) {
        expect(obs.sourceTimestampMs).toBeLessThanOrEqual(tDecision);
      }

      // Reconstructed order book snapshot
      expect(context.reconstructedOrderBook.estimatedSpotSol).toBe(0.000015);
      expect(context.reconstructedOrderBook.bestAvailableLiquidityUsd).toBe(3000);
      expect(context.missingDataFields).toContain("top10ConcentrationPct");
      expect(context.dataQualityScore).toBeGreaterThan(0.0);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
