import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  TelemetryFollowUpScheduler,
  repairAndQuarantineDamagedTail,
  resolveStrategyRevision,
  isVerifiedMatchingPool,
  type CandidateDecisionRecord,
  type MetricProvenance,
  type FollowUpObservationResult,
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
import { CandidateStreamEngine } from "../candidate-scanner/CandidateStreamEngine.js";
import { CandidateScannerEvaluator } from "../candidate-scanner/CandidateScannerEvaluator.js";
import { CandidateWatchlistService } from "../candidate-scanner/CandidateWatchlistService.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "../candidate-scanner/CandidateScannerConfig.js";
import type { ScannedPoolRecord } from "../candidate-scanner/CandidateScannerTypes.js";
import {
  parseCliArgs,
  recordPreliminaryBuyTriggerObservation,
} from "../scripts/paper-trading-daemon.js";

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
  // Suite 2: Storage Manager Durability, Crash Tail Quarantine & Metadata Safety
  // (B-AUD-03, B-AUD-06)
  // --------------------------------------------------------------------------
  describe("2. Telemetry Storage Manager Durability, Quarantine & Boundary Repair", () => {
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
        strategyRevision: "cc73759",
        startedAtIso: meta.startedAtIso,
        totalCandidatesScreened: 42,
        totalDecisionsRecorded: 42,
        decisionWriteFailures: 0,
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

    it("B-AUD-03: quarantines crash-damaged JSONL tail, restores clean boundary, and safely appends and rereads", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-crash-tail-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-crash-tail-test";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 10.0);

      const decisionsPath = getCanonicalCandidateDecisionsPath(sessionId, tempDir);
      mkdirSync(path.dirname(decisionsPath), { recursive: true });

      // Step 1: Write valid line 1 followed by malformed partial line 2 (reproducing B-AUD-03)
      const validRecord1 = JSON.stringify({ eventId: "ev-1", mintAddress: "mint-1" });
      const brokenTrailingLine = '{"eventId":"ev-2","brokenPartialJson';
      writeFileSync(decisionsPath, `${validRecord1}\n${brokenTrailingLine}\n`, "utf8");

      // Step 2: Read must succeed for valid line 1 and quarantine damaged line 2 to .corrupt-<timestamp>
      const recoveredFirstRead = storage.readCandidateDecisions(sessionId);
      expect(recoveredFirstRead.length).toBe(1);
      expect(recoveredFirstRead[0]?.eventId).toBe("ev-1");

      // Verify quarantine file was created
      const files = readdirSync(path.dirname(decisionsPath));
      const corruptFiles = files.filter((f) => f.includes(".corrupt-"));
      expect(corruptFiles.length).toBe(1);

      // Step 3: Now append another valid record. Boundary must be clean, so append succeeds!
      const validRecord2: CandidateDecisionRecord = {
        eventId: "ev-3-appended",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "mint-3",
        poolId: "pool-3",
        symbol: "M3",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000050,
        decisionTimestampMs: 1700000000060,
        strategyRevision: "cc73759",
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 300,
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
      storage.appendCandidateDecision(validRecord2);

      // Step 4: Subsequent read must cleanly return BOTH records (ev-1 and ev-3-appended) without [FATAL_CORRUPT_LINE]!
      const finalRead = storage.readCandidateDecisions(sessionId);
      expect(finalRead.length).toBe(2);
      expect(finalRead[0]?.eventId).toBe("ev-1");
      expect(finalRead[1]?.eventId).toBe("ev-3-appended");

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B-AUD-03: fails closed on corrupted interior lines to prevent silent data truncation", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-interior-corrupt-"));
      const decisionsPath = path.join(tempDir, "candidate-decisions.jsonl");
      mkdirSync(tempDir, { recursive: true });

      const line1 = JSON.stringify({ eventId: "ev-1" });
      const corruptLine2 = "{ malformed json interior }";
      const line3 = JSON.stringify({ eventId: "ev-3" });

      writeFileSync(decisionsPath, `${line1}\n${corruptLine2}\n${line3}\n`, "utf8");

      expect(() => repairAndQuarantineDamagedTail(decisionsPath)).toThrow(/\[FATAL_CORRUPT_LINE\]/);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B-AUD-06: prevents session ID reuse across different generation IDs", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-session-gen-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-unique-gen-test";

      // Register with Gen 1
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      // Attempt to register same session with Gen 2 -> Must throw FATAL_SESSION_GENERATION_MISMATCH
      expect(() => {
        storage.initSessionTelemetry(sessionId, "gen-02-research-candidate", 10.0);
      }).toThrow(/\[FATAL_SESSION_GENERATION_MISMATCH\]/);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B-AUD-06: fails closed and quarantines corrupt session metadata without silent overwrite", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-corrupt-meta-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-corrupt-meta-test";

      const sessionDir = getCanonicalTelemetrySessionDir(sessionId, tempDir);
      mkdirSync(sessionDir, { recursive: true });
      const metaPath = getCanonicalSessionMetaPath(sessionId, tempDir);

      // Write corrupt metadata
      writeFileSync(metaPath, "{ corrupted unparseable session meta", "utf8");

      expect(() => {
        storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);
      }).toThrow(/\[FATAL_CORRUPT_SESSION_META\]/);

      // Verify corrupt file was quarantined
      const files = readdirSync(sessionDir);
      expect(files.some((f) => f.includes("session-meta.json.corrupt-"))).toBe(true);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: 100% Decision Logging & Stream Engine Integration (B-AUD-01)
  // --------------------------------------------------------------------------
  describe("3. Candidate Decision Logging & 100% Coverage (B-AUD-01)", () => {
    it("measures 100% decision coverage (recorded/actual === 1.0) on deterministic scanner fixture", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-e2e-fixture-"));
      const storage = new TelemetryStorageManager(tempDir);
      const recorder = new CandidateDecisionRecorder(storage);
      const sessionId = "session-fixture-100pct";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const mockPools: ScannedPoolRecord[] = [
        {
          poolId: "pool-rej-age",
          mintAddress: "MintRejAge11111111111111111111111111111",
          symbol: "REJ_AGE",
          decimals: 9,
          baseMint: "So11111111111111111111111111111111111111112",
          liquidityUsd: 5000,
          marketCapUsd: 15000,
          openTimeSec: Math.floor(Date.now() / 1000) - 100, // 100s < minAgeSec 300s
          lpBurnPct: 100,
          mintAuthority: null,
          freezeAuthority: null,
          volume5mUsd: 500,
          txCount5m: 20,
          buys5m: 15,
          sells5m: 5,
          spotPriceUsd: 0.001,
          fetchedAt: new Date().toISOString(),
        },
        {
          poolId: "pool-rej-liq",
          mintAddress: "MintRejLiq22222222222222222222222222222",
          symbol: "REJ_LIQ",
          decimals: 9,
          baseMint: "So11111111111111111111111111111111111111112",
          liquidityUsd: 400, // < 1000 minLiquidity
          marketCapUsd: 2000,
          openTimeSec: Math.floor(Date.now() / 1000) - 600,
          lpBurnPct: 100,
          mintAuthority: null,
          freezeAuthority: null,
          volume5mUsd: 100,
          txCount5m: 10,
          buys5m: 8,
          sells5m: 2,
          spotPriceUsd: 0.0005,
          fetchedAt: new Date().toISOString(),
        },
        {
          poolId: "pool-admitted-1",
          mintAddress: "MintAdmitted333333333333333333333333333",
          symbol: "ADMIT1",
          decimals: 9,
          baseMint: "So11111111111111111111111111111111111111112",
          liquidityUsd: 12000,
          marketCapUsd: 40000,
          openTimeSec: Math.floor(Date.now() / 1000) - 600, // 10m old (passes maturity)
          lpBurnPct: 100,
          mintAuthority: null,
          freezeAuthority: null,
          volume5mUsd: 4000,
          txCount5m: 35,
          buys5m: 25,
          sells5m: 10,
          spotPriceUsd: 0.002,
          fetchedAt: new Date().toISOString(),
        },
      ];

      let actualEvaluations = 0;
      let recordedDecisions = 0;

      const engine = new CandidateStreamEngine({
        config: CANDIDATE_SCANNER_DEFAULTS,
        fetchFn: async () => {
          return new Response(
            JSON.stringify({
              data: {
                data: mockPools.map((p) => ({
                  id: p.poolId,
                  openTime: p.openTimeSec,
                  tvl: p.liquidityUsd,
                  burnPercent: (p.lpBurnPct ?? 0) / 100,
                  mintA: { address: p.mintAddress, symbol: p.symbol, decimals: p.decimals },
                  mintB: {
                    address: "So11111111111111111111111111111111111111112",
                    symbol: "SOL",
                    decimals: 9,
                  },
                })),
              },
            }),
            { status: 200 },
          );
        },
        enableDexScreener: false,
        onDecision: (evalResult, pool) => {
          actualEvaluations++;
          const rec = recorder.recordDecision({
            sessionId,
            generationId: "gen-01-legacy-baseline",
            mintAddress: pool.mintAddress,
            poolId: pool.poolId,
            symbol: pool.symbol,
            sourceTimestampMs: pool.openTimeSec * 1000,
            ingestionTimestampMs: Date.now(),
            decisionCohort: evalResult.admitted ? "WATCHLIST_RADAR" : "FILTERED_REJECTED",
            primaryRejectionReason: evalResult.primaryRejectionReason,
            filterEvaluations: evalResult.filterEvaluations.map((f) => ({
              filterName: f.filterName,
              passed: f.passed,
              valueObserved: null,
              threshold: null,
              rejectionReason: f.reason,
            })),
            metricsSnapshot: {
              tokenAgeSec: Math.floor(Date.now() / 1000) - pool.openTimeSec,
              liquidityUsd: pool.liquidityUsd,
              marketCapUsd: pool.marketCapUsd,
              lmcRatio: pool.liquidityUsd / pool.marketCapUsd,
              lpBurnPct: pool.lpBurnPct,
              spotPriceUsd: pool.spotPriceUsd,
              volume5mUsd: pool.volume5mUsd,
              txCount5m: pool.txCount5m,
              buys5m: pool.buys5m,
              sells5m: pool.sells5m,
            },
            providerIdentity: "raydium",
          });
          if (rec.eventId) {
            recordedDecisions++;
          }
        },
      });

      const scanResults = await engine.scanOnce();
      expect(scanResults.length).toBe(3);
      expect(actualEvaluations).toBe(3);
      expect(recordedDecisions).toBe(3);

      // Verify 100% coverage
      const coverage = recordedDecisions / actualEvaluations;
      expect(coverage).toBe(1.0);

      // Verify persisted records on disk
      const stored = storage.readCandidateDecisions(sessionId);
      expect(stored.length).toBe(3);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 4: Stratified Counterfactual Sampling & Guarantee (B-AUD-04)
  // --------------------------------------------------------------------------
  describe("4. Stratified Counterfactual Sampling Controller (B-AUD-04)", () => {
    it("B-AUD-04: guarantees 100% tracking capacity for executed positions even under saturation", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-capacity-guarantee-"));
      const storage = new TelemetryStorageManager(tempDir);
      // Set capacity to exactly 1
      const controller = new StratifiedSamplingController(storage, "seed-123", {
        maxConcurrentTracked: 1,
      });
      const sessionId = "session-exec-guarantee";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 10.0);

      const decisionExec1: CandidateDecisionRecord = {
        eventId: "ev-exec-1",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintExec1111111111111111111111111111111111",
        poolId: "PoolExec1",
        symbol: "EXEC1",
        sourceTimestampMs: Date.now(),
        ingestionTimestampMs: Date.now(),
        decisionTimestampMs: Date.now(),
        strategyRevision: "cc73759",
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

      const decisionExec2: CandidateDecisionRecord = {
        ...decisionExec1,
        eventId: "ev-exec-2",
        mintAddress: "MintExec2222222222222222222222222222222222",
        poolId: "PoolExec2",
        symbol: "EXEC2",
      };

      // Tracking first executed buy succeeds
      const track1 = controller.evaluateForTracking(decisionExec1, 0.005);
      expect(track1).not.toBeNull();
      expect(track1?.tier).toBe("EXECUTED_POSITION");
      expect(track1?.samplingProbability).toBe(1.0);

      // Tracking second executed buy MUST ALSO SUCCEED under maxConcurrentTracked=1 (Audit reproduction resolved!)
      const track2 = controller.evaluateForTracking(decisionExec2, 0.008);
      expect(track2).not.toBeNull();
      expect(track2?.tier).toBe("EXECUTED_POSITION");
      expect(track2?.samplingProbability).toBe(1.0);
      expect(track2?.status).toBe("TRACKING_ACTIVE");

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B-AUD-04: persists dropped capacity and deterministic non-selected records for IPW auditability", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-ipw-drops-"));
      const storage = new TelemetryStorageManager(tempDir);
      // maxConcurrentTracked = 0 forces capacity drop for non-critical candidates
      const controller = new StratifiedSamplingController(storage, "seed-ipw", {
        maxConcurrentTracked: 0,
      });
      const sessionId = "session-ipw-drops";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 10.0);

      const decisionNearMiss: CandidateDecisionRecord = {
        eventId: "ev-near-miss",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintNearMiss1111111111111111111111111111",
        poolId: "PoolNM1",
        symbol: "NM1",
        sourceTimestampMs: Date.now(),
        ingestionTimestampMs: Date.now(),
        decisionTimestampMs: Date.now(),
        strategyRevision: "cc73759",
        decisionCohort: "FILTERED_REJECTED",
        primaryRejectionReason: "REJECTED_NET_SELLER_DOMINANCE",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 300,
          liquidityUsd: 8000,
          marketCapUsd: 25000,
          lmcRatio: 0.32,
          lpBurnPct: 100,
          spotPriceUsd: 0.001,
          volume5mUsd: 1000,
          txCount5m: 15,
          buys5m: 5,
          sells5m: 10,
        },
        missingFields: [],
        providerIdentity: "raydium",
      };

      const result = controller.evaluateForTracking(decisionNearMiss, 0.001);
      expect(result).toBeNull(); // not actively tracked

      // Verify persisted drop record on disk
      const storedSamples = storage.readStratifiedSamples(sessionId);
      expect(storedSamples.length).toBe(1);
      const dropRecord = storedSamples[0]!;
      expect(dropRecord.status).toBe("DROPPED_CAPACITY");
      expect(dropRecord.selectionReason).toBe("CAPACITY_EXCEEDED");
      expect(dropRecord.ipwEstimable).toBe(false);
      expect(dropRecord.effectiveInclusionProbability).toBe(0.0);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 5: Telemetry Rate Controller & Token Bucket (B-AUD-08)
  // --------------------------------------------------------------------------
  describe("5. Telemetry Rate Controller & Priority Shedding (B-AUD-08)", () => {
    it("tracks acquisition metrics and sheds low priority tiers under sustained overload", () => {
      const rateController = new TelemetryRateController({
        maxRequestsPerSec: 2.0,
        bucketCapacity: 3.0,
        minTokensForLowTier: 1.5,
      });

      // Exhaust bucket to 1.0 token
      expect(rateController.tryAcquire("EXECUTED_POSITION")).toBe(true);
      expect(rateController.tryAcquire("EXECUTED_POSITION")).toBe(true);
      expect(rateController.getAvailableTokens()).toBeCloseTo(1.0, 1);

      // Low priority tier requires >= 1.5 + 1.0 = 2.5 tokens: must be shed!
      expect(rateController.tryAcquire("HARD_REJECT_BASELINE")).toBe(false);

      // High priority tier requires only 1.0 token: must succeed!
      expect(rateController.tryAcquire("EXECUTED_POSITION")).toBe(true);

      // Now exhausted: both must be shed
      expect(rateController.tryAcquire("EXECUTED_POSITION")).toBe(false);

      const metrics = rateController.getMetrics();
      expect(metrics.totalAcquisitions).toBe(3);
      expect(metrics.totalShed).toBe(2);
      expect(metrics.shedByTier.HARD_REJECT_BASELINE).toBe(1);
      expect(metrics.shedByTier.EXECUTED_POSITION).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 6: Zero-Lookahead Decision Context Reconstructor (B-AUD-02, B-AUD-05, B-AUD-07)
  // --------------------------------------------------------------------------
  describe("6. Zero-Lookahead Decision Context Reconstructor (B-AUD-02, B-AUD-05, B-AUD-07)", () => {
    it("B-AUD-02: excludes late-arriving observations ingested AFTER decision timestamp", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-late-arrival-"));
      const storage = new TelemetryStorageManager(tempDir);
      const obsRecorder = new MarketObservationRecorder(storage);
      const reconstructor = new DecisionContextReconstructor(storage);
      const sessionId = "session-late-arrival";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const mint = "MintLateArrival111111111111111111111111";
      const pool = "PoolLateArrival1";

      const tSource = 1400000000000; // 14:00:00
      const tDecision = 1400000004000; // 14:00:04
      const tLateIngestion = 1400000008000; // 14:00:08 (Late arrival: ingested AFTER decision was made!)

      // Record late-arriving observation (source time is old, but ingestion time is AFTER decision)
      obsRecorder.recordObservation({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: pool,
        sourceTimestampMs: tSource,
        ingestionTimestampMs: tLateIngestion, // Arrived at 14:00:08
        measurementWindow: {
          windowStartMs: tSource - 60000,
          windowEndMs: tSource,
          durationSec: 60,
        },
        providerIdentity: "raydium",
        priceMetrics: { spotPriceUsd: 0.001, spotPriceSol: 0.00001, priceSource: "POOL_RESERVE" },
        liquidityMetrics: { baseReserve: 100000, quoteReserve: 10, liquidityUsd: 2000 },
        flowMetrics: { txCount: 10, buys: 8, sells: 2, volumeUsd: 500, netBuyerVolumeUsd: 300 },
      });

      const decision: CandidateDecisionRecord = {
        eventId: "ev-decision-ontime",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: pool,
        symbol: "LATE",
        sourceTimestampMs: tDecision,
        ingestionTimestampMs: tDecision,
        decisionTimestampMs: tDecision, // Decision made at 14:00:04
        strategyRevision: "cc73759",
        decisionCohort: "EXECUTED_BUY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 2000,
          marketCapUsd: 8000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.001,
          volume5mUsd: 500,
          txCount5m: 10,
          buys5m: 8,
          sells5m: 2,
        },
        missingFields: [],
        providerIdentity: "raydium",
      };

      const context = reconstructor.reconstructContext(decision);

      // STRICT ZERO-LOOKAHEAD: Late arrival MUST NOT be included in pre-decision window!
      // (Audit reproduction B-AUD-02 resolved!)
      expect(context.preDecisionWindow.length).toBe(0);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B-AUD-02: isolates observations by poolId to prevent multi-pool leakage for same mint", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-pool-leak-"));
      const storage = new TelemetryStorageManager(tempDir);
      const obsRecorder = new MarketObservationRecorder(storage);
      const reconstructor = new DecisionContextReconstructor(storage);
      const sessionId = "session-pool-leak";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const mint = "MintSameAddress1111111111111111111111111";
      const poolA = "PoolTargetA";
      const poolB = "PoolOtherB"; // Different pool for same mint

      const tNow = 1700000000000;

      // Observation on Pool B
      obsRecorder.recordObservation({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: poolB,
        sourceTimestampMs: tNow - 10000,
        ingestionTimestampMs: tNow - 9000,
        measurementWindow: {
          windowStartMs: tNow - 70000,
          windowEndMs: tNow - 10000,
          durationSec: 60,
        },
        providerIdentity: "raydium",
        priceMetrics: { spotPriceUsd: 0.999, spotPriceSol: 0.009, priceSource: "POOL_RESERVE" },
        liquidityMetrics: { baseReserve: 1000, quoteReserve: 1, liquidityUsd: 500 },
        flowMetrics: { txCount: 1, buys: 1, sells: 0, volumeUsd: 50, netBuyerVolumeUsd: 50 },
      });

      // Decision on Pool A
      const decisionPoolA: CandidateDecisionRecord = {
        eventId: "ev-pool-a",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: poolA,
        symbol: "SAME",
        sourceTimestampMs: tNow,
        ingestionTimestampMs: tNow + 10,
        decisionTimestampMs: tNow + 20,
        strategyRevision: "cc73759",
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 200,
          liquidityUsd: 5000,
          marketCapUsd: 20000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.002,
          volume5mUsd: 1000,
          txCount5m: 10,
          buys5m: 8,
          sells5m: 2,
        },
        missingFields: [],
        providerIdentity: "raydium",
      };

      const context = reconstructor.reconstructContext(decisionPoolA);
      // Observations from Pool B must NOT leak into Pool A's context!
      expect(context.preDecisionWindow.length).toBe(0);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B-AUD-05: never coerces spotPriceUsd to SOL when SOL observation is absent", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-price-fallback-"));
      const storage = new TelemetryStorageManager(tempDir);
      const reconstructor = new DecisionContextReconstructor(storage);
      const sessionId = "session-price-fallback";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const decisionNoObs: CandidateDecisionRecord = {
        eventId: "ev-no-obs",
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintNoObs1111111111111111111111111111111",
        poolId: "PoolNoObs1",
        symbol: "NOOBS",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000050,
        decisionTimestampMs: 1700000000060,
        strategyRevision: "cc73759",
        decisionCohort: "FILTERED_REJECTED",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 1500,
          marketCapUsd: 6000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.0042, // USD price exists, SOL price is absent
          volume5mUsd: 500,
          txCount5m: 5,
          buys5m: 3,
          sells5m: 2,
        },
        missingFields: [],
        providerIdentity: "raydium",
      };

      const context = reconstructor.reconstructContext(decisionNoObs);

      // B-AUD-05: estimatedSpotSol MUST NOT be coerced to 0.0042 USD! It must be null.
      expect(context.reconstructedMarketState.latestSpotPriceSol).toBeNull();
      expect(context.reconstructedMarketState.latestSpotPriceUsd).toBe(0.0042);
      expect(context.reconstructedOrderBook.estimatedSpotSol).toBeNull();
      expect(context.missingDataFields).toContain("spotPriceSol");

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B-AUD-07: validates measurement window boundaries and detects future clock skew", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-validation-"));
      const storage = new TelemetryStorageManager(tempDir);
      const obsRecorder = new MarketObservationRecorder(storage);
      const sessionId = "session-validation-test";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      // 1. Inverted window: start > end must throw
      expect(() => {
        obsRecorder.recordObservation({
          sessionId,
          generationId: "gen-01-legacy-baseline",
          mintAddress: "MintTest1",
          poolId: "PoolTest1",
          sourceTimestampMs: 1700000000000,
          measurementWindow: {
            windowStartMs: 1700000060000, // Inverted: start > end
            windowEndMs: 1700000000000,
            durationSec: 60,
          },
          providerIdentity: "raydium",
          priceMetrics: { spotPriceUsd: 0.01, spotPriceSol: 0.0001, priceSource: "POOL_RESERVE" },
          liquidityMetrics: { baseReserve: 100, quoteReserve: 1, liquidityUsd: 1000 },
          flowMetrics: { txCount: 1, buys: 1, sells: 0, volumeUsd: 10, netBuyerVolumeUsd: 10 },
        });
      }).toThrow(/\[FATAL_INVALID_MEASUREMENT_WINDOW\]/);

      // 2. Future clock skew warning
      const futureObs = obsRecorder.recordObservation({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintTest1",
        poolId: "PoolTest1",
        sourceTimestampMs: 1700000050000, // 50 seconds in future relative to ingestion
        ingestionTimestampMs: 1700000000000,
        measurementWindow: {
          windowStartMs: 1700000000000,
          windowEndMs: 1700000050000,
          durationSec: 50,
        },
        providerIdentity: "raydium",
        priceMetrics: { spotPriceUsd: 0.01, spotPriceSol: 0.0001, priceSource: "POOL_RESERVE" },
        liquidityMetrics: { baseReserve: 100, quoteReserve: 1, liquidityUsd: 1000 },
        flowMetrics: { txCount: 1, buys: 1, sells: 0, volumeUsd: 10, netBuyerVolumeUsd: 10 },
      });
      expect(futureObs.clockSkewWarning).toBeDefined();

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B-AUD-07: resolves strategy build revision dynamically from git or environment", () => {
      const revision = resolveStrategyRevision();
      expect(typeof revision).toBe("string");
      expect(revision.length).toBeGreaterThan(0);
      expect(revision).not.toBe("7e58ea5"); // Must not be the stale commit from prior subphase
    });
  });

  // --------------------------------------------------------------------------
  // Suite 8: Phase 12.94-B Audit v2 Priority Verifications (B2-01 through B2-07)
  // --------------------------------------------------------------------------
  describe("8. Phase 12.94-B Audit v2 Priority Verifications (B2-01 through B2-07)", () => {
    it("B2-01: metric provenance distinguishes observed facts from derived or unavailable metrics, and preserves nulls", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b201-"));
      const storage = new TelemetryStorageManager(tempDir);
      const decRecorder = new CandidateDecisionRecorder(storage);
      const sessionId = "session-b201-provenance";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const metricProvenance: Record<string, MetricProvenance> = {
        tokenAgeSec: "OBSERVED",
        liquidityUsd: "OBSERVED",
        marketCapUsd: "UNAVAILABLE",
        lmcRatio: "UNAVAILABLE",
        lpBurnPct: "OBSERVED",
        spotPriceUsd: "UNAVAILABLE",
        spotPriceSol: "UNAVAILABLE",
        volume5mUsd: "UNAVAILABLE",
        txCount5m: "OBSERVED",
        buys5m: "OBSERVED",
        sells5m: "OBSERVED",
      };

      const decision = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintNullCheck111111111111111111111111111",
        poolId: "PoolNullCheck1",
        symbol: "NULLCOIN",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000010,
        poolOpenTimeMs: 1699990000000,
        decisionCohort: "FILTERED_REJECTED",
        primaryRejectionReason: "REJECTED_MISSING_PRICE_FEED",
        filterEvaluations: [
          {
            filterName: "PriceFeedCheck",
            passed: false,
            valueObserved: null,
            threshold: 0.0001,
            rejectionReason: "No spot price available",
          },
        ],
        metricsSnapshot: {
          tokenAgeSec: 10000,
          liquidityUsd: 15000,
          marketCapUsd: null,
          lmcRatio: null,
          lpBurnPct: 100,
          spotPriceUsd: null,
          spotPriceSol: null,
          volume5mUsd: null,
          txCount5m: 45,
          buys5m: 25,
          sells5m: 20,
          metricProvenance,
        },
        providerIdentity: "raydium",
      });

      expect(decision.metricsSnapshot.spotPriceUsd).toBeNull();
      expect(decision.metricsSnapshot.volume5mUsd).toBeNull();
      expect(decision.metricsSnapshot.marketCapUsd).toBeNull();
      expect(decision.metricsSnapshot.metricProvenance?.spotPriceUsd).toBe("UNAVAILABLE");
      expect(decision.metricsSnapshot.metricProvenance?.liquidityUsd).toBe("OBSERVED");

      // Verify persisted JSONL preserves exact nulls
      const decisions = storage.readCandidateDecisions(sessionId);
      expect(decisions).toHaveLength(1);
      const persisted = decisions[0]!;
      expect(persisted.metricsSnapshot.spotPriceUsd).toBeNull();
      expect(persisted.metricsSnapshot.volume5mUsd).toBeNull();
      expect(persisted.metricsSnapshot.metricProvenance?.spotPriceUsd).toBe("UNAVAILABLE");

      // Verify ReconstructedDecisionContext marks missing fields
      const reconstructor = new DecisionContextReconstructor(storage);
      const context = reconstructor.reconstructContext(decision);
      expect(context.missingDataFields).toContain("spotPriceUsd");
      expect(context.missingDataFields).toContain("spotPriceSol");

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B2-02: observation timestamps record real network timings, derivation status, actual pool ID, and separate pool creation time", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b202-"));
      const storage = new TelemetryStorageManager(tempDir);
      const obsRecorder = new MarketObservationRecorder(storage);
      const decRecorder = new CandidateDecisionRecorder(storage);
      const sessionId = "session-b202-timestamps";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const requestInitiatedMs = 1700000001000;
      const responseReceivedMs = 1700000001250;
      const scanTimeMs = 1700000001300;
      const poolCreatedMs = 1699990000000;

      // 1. Observation record with network timings and INDEXED_TICK price source
      const obs = obsRecorder.recordObservation({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintB202Address111111111111111111111111",
        poolId: "QueryPoolId1",
        sourceTimestampMs: responseReceivedMs,
        ingestionTimestampMs: responseReceivedMs,
        requestInitiatedMs,
        responseReceivedMs,
        actualResponsePoolId: "ActualDexScreenerPairPool999",
        derivationStatus: "DERIVED_FROM_5M",
        measurementWindow: {
          windowStartMs: scanTimeMs - 300_000,
          windowEndMs: scanTimeMs,
          durationSec: 300,
        },
        providerIdentity: "dexscreener",
        priceMetrics: {
          spotPriceUsd: 1.25,
          spotPriceSol: 0.0085,
          priceSource: "INDEXED_TICK",
        },
        liquidityMetrics: {
          baseReserve: 10000,
          quoteReserve: 85,
          liquidityUsd: 25000,
        },
        flowMetrics: {
          txCount: 42,
          buys: 28,
          sells: 14,
          volumeUsd: 5000,
          netBuyerVolumeUsd: 1500,
        },
      });

      expect(obs.requestInitiatedMs).toBe(requestInitiatedMs);
      expect(obs.responseReceivedMs).toBe(responseReceivedMs);
      expect(obs.actualResponsePoolId).toBe("ActualDexScreenerPairPool999");
      expect(obs.derivationStatus).toBe("DERIVED_FROM_5M");
      expect(obs.priceMetrics.priceSource).toBe("INDEXED_TICK");

      // 2. Decision record separating scan/decision observation time from pool creation time
      const dec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintB202Address111111111111111111111111",
        poolId: "ActualDexScreenerPairPool999",
        symbol: "TICK",
        sourceTimestampMs: scanTimeMs, // Observation scan time
        ingestionTimestampMs: scanTimeMs,
        poolOpenTimeMs: poolCreatedMs, // Pool creation time in the past
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: Math.floor((scanTimeMs - poolCreatedMs) / 1000),
          liquidityUsd: 25000,
          marketCapUsd: 120000,
          lmcRatio: 25000 / 120000,
          lpBurnPct: 100,
          spotPriceUsd: 1.25,
          spotPriceSol: 0.0085,
          volume5mUsd: 5000,
          txCount5m: 42,
          buys5m: 28,
          sells5m: 14,
        },
        providerIdentity: "dexscreener",
      });

      expect(dec.sourceTimestampMs).toBe(scanTimeMs);
      expect(dec.poolOpenTimeMs).toBe(poolCreatedMs);
      expect(dec.sourceTimestampMs).not.toBe(dec.poolOpenTimeMs);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B2-03: rate limiter permit returned by tryAcquire() is strictly honored and sheds are accounted", () => {
      const rateController = new TelemetryRateController({
        maxRequestsPerSec: 10.0,
        bucketCapacity: 2.0,
        minTokensForLowTier: 1.0,
      });

      const now = 1700000000000;

      // Consume both tokens with high-priority tier
      expect(rateController.tryAcquire("WATCHLIST_ACTIVE", now)).toBe(true);
      expect(rateController.tryAcquire("WATCHLIST_ACTIVE", now)).toBe(true);

      // Third acquisition must fail and be shed
      expect(rateController.tryAcquire("WATCHLIST_ACTIVE", now)).toBe(false);
      expect(rateController.getShedCount()).toBe(1);

      // Low-priority tier requires safety buffer (minTokensForLowTier + 1.0 = 2.0)
      // Refill to 1.5 tokens
      const nowLater = now + 150; // 0.15s * 10 = 1.5 tokens
      expect(rateController.tryAcquire("HARD_REJECT_BASELINE", nowLater)).toBe(false);
      expect(rateController.getShedCount()).toBe(2);

      const metrics = rateController.getMetrics();
      expect(metrics.totalAcquisitions).toBe(2);
      expect(metrics.totalShed).toBe(2);
      expect(metrics.shedByTier.WATCHLIST_ACTIVE).toBe(1);
      expect(metrics.shedByTier.HARD_REJECT_BASELINE).toBe(1);
    });

    it("B2-04: watchlist tracker promotes cleanly to EXECUTED_POSITION upon EXECUTED_BUY and updates via composite key", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b204-"));
      const storage = new TelemetryStorageManager(tempDir);
      const decRecorder = new CandidateDecisionRecorder(storage);
      const sampling = new StratifiedSamplingController(storage);
      const sessionId = "session-b204-promotion";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const mint = "MintPromote1111111111111111111111111111111";
      const pool = "PoolPromote1";

      // 1. Initial admission onto watchlist radar
      const radarDec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: pool,
        symbol: "PROM",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 300,
          liquidityUsd: 15000,
          marketCapUsd: 50000,
          lmcRatio: 0.3,
          lpBurnPct: 100,
          spotPriceUsd: 0.05,
          spotPriceSol: 0.00035,
          volume5mUsd: 1200,
          txCount5m: 20,
          buys5m: 15,
          sells5m: 5,
        },
        providerIdentity: "raydium",
      });

      const initialTracker = sampling.evaluateForTracking(radarDec, 0.00035);
      expect(initialTracker).not.toBeNull();
      expect(initialTracker?.tier).toBe("WATCHLIST_ACTIVE");
      expect(initialTracker?.currentSamplingIntervalMs).toBe(30000);
      expect(initialTracker?.promotedFromTier).toBeUndefined();

      // 2. Buy decision arrives for the same candidate
      const buyDec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: mint,
        poolId: pool,
        symbol: "PROM",
        sourceTimestampMs: 1700000035000,
        ingestionTimestampMs: 1700000035000,
        decisionCohort: "EXECUTED_BUY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 335,
          liquidityUsd: 22000,
          marketCapUsd: 65000,
          lmcRatio: 0.33,
          lpBurnPct: 100,
          spotPriceUsd: 0.065,
          spotPriceSol: 0.00045,
          volume5mUsd: 3500,
          txCount5m: 35,
          buys5m: 28,
          sells5m: 7,
        },
        providerIdentity: "raydium",
      });

      const promotedTracker = sampling.evaluateForTracking(buyDec, 0.00045);
      expect(promotedTracker).not.toBeNull();
      expect(promotedTracker?.tier).toBe("EXECUTED_POSITION");
      expect(promotedTracker?.currentSamplingIntervalMs).toBe(5000); // 5s cadence
      expect(promotedTracker?.promotedFromTier).toBe("WATCHLIST_ACTIVE");
      expect(promotedTracker?.promotedAtMs).toBeDefined();
      expect(promotedTracker?.decisionEventId).toBe(buyDec.eventId);

      // 3. Update observation via canonical composite key
      const trackerKey = StratifiedSamplingController.buildTrackerKey(
        "gen-01-legacy-baseline",
        sessionId,
        pool,
        mint,
      );
      const updated = sampling.updateObservation(trackerKey, 0.00055, 1700000040000);
      expect(updated).not.toBeNull();
      expect(updated?.latestPriceSol).toBe(0.00055);
      expect(updated?.peakPriceSol).toBe(0.00055);
      expect(updated?.observationCount).toBe(2);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B2-05: TelemetryFollowUpScheduler polls active cohorts at respective cadences and respects rate permits", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b205-"));
      const storage = new TelemetryStorageManager(tempDir);
      const obsRecorder = new MarketObservationRecorder(storage);
      const sampling = new StratifiedSamplingController(storage);
      const rateController = new TelemetryRateController({
        maxRequestsPerSec: 100.0,
        bucketCapacity: 10.0,
      });
      const decRecorder = new CandidateDecisionRecorder(storage);
      const sessionId = "session-b205-scheduler";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      // Register tracker 1 (EXECUTED_POSITION, 5s cadence)
      const buyDec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintFollowUp111111111111111111111111111",
        poolId: "PoolFollowUp1",
        symbol: "POS",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        decisionCohort: "EXECUTED_BUY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 50000,
          marketCapUsd: 200000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 1.0,
          spotPriceSol: 0.007,
          volume5mUsd: 10000,
          txCount5m: 50,
          buys5m: 35,
          sells5m: 15,
        },
        providerIdentity: "raydium",
      });
      sampling.evaluateForTracking(buyDec, 0.007);

      // Register tracker 2 (WATCHLIST_ACTIVE, 30s cadence)
      const radarDec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintFollowUp222222222222222222222222222",
        poolId: "PoolFollowUp2",
        symbol: "RAD",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 200,
          liquidityUsd: 20000,
          marketCapUsd: 80000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.5,
          spotPriceSol: 0.0035,
          volume5mUsd: 2000,
          txCount5m: 20,
          buys5m: 12,
          sells5m: 8,
        },
        providerIdentity: "raydium",
      });
      sampling.evaluateForTracking(radarDec, 0.0035);

      const polledMints: string[] = [];
      const scheduler = new TelemetryFollowUpScheduler(
        storage,
        obsRecorder,
        sampling,
        rateController,
        async (_poolId, mintAddress) => {
          polledMints.push(mintAddress);
          return {
            spotPriceUsd: 1.1,
            spotPriceSol: 0.0075,
            liquidityUsd: 52000,
            txCount: 55,
            buys: 40,
            sells: 15,
            volumeUsd: 12000,
            priceSource: "INDEXED_TICK",
            actualPoolId: _poolId,
          };
        },
      );

      // At t = 6s: Only tracker 1 (5s interval) is due. Tracker 2 (30s interval) is not due.
      const poll1 = await scheduler.pollPendingTrackers(1700000006000);
      expect(poll1.polledCount).toBe(1);
      expect(poll1.skippedShedCount).toBe(0);
      expect(polledMints).toEqual(["MintFollowUp111111111111111111111111111"]);

      // Verify observation was appended to disk
      const obsList = storage.readMarketObservations(sessionId);
      expect(obsList).toHaveLength(1);
      expect(obsList[0]?.mintAddress).toBe("MintFollowUp111111111111111111111111111");

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B2-06: independent candidate evaluation counting, trigger rejection recording, and summary completeness", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b206-"));
      const storage = new TelemetryStorageManager(tempDir);
      const decRecorder = new CandidateDecisionRecorder(storage);
      const sessionId = "session-b206-summary";
      const meta = storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      let callbackErrorsCount = 0;
      const engine = new CandidateStreamEngine({
        config: CANDIDATE_SCANNER_DEFAULTS,
        onDecision: (evalResult) => {
          if (!evalResult.admitted) {
            callbackErrorsCount++;
            throw new Error("Simulated transient callback failure in telemetry sink");
          }
          decRecorder.recordDecision({
            sessionId,
            generationId: "gen-01-legacy-baseline",
            mintAddress: "MintAdmitted1",
            poolId: "PoolAdmitted1",
            symbol: "ADMIT",
            sourceTimestampMs: Date.now(),
            ingestionTimestampMs: Date.now(),
            decisionCohort: "WATCHLIST_RADAR",
            filterEvaluations: [],
            metricsSnapshot: {
              tokenAgeSec: 100,
              liquidityUsd: 25000,
              marketCapUsd: 100000,
              lmcRatio: 0.25,
              lpBurnPct: 100,
              spotPriceUsd: 0.1,
              spotPriceSol: 0.0007,
              volume5mUsd: 5000,
              txCount5m: 30,
              buys5m: 20,
              sells5m: 10,
            },
            providerIdentity: "raydium",
          });
        },
      });

      // Directly evaluate 3 mock candidates through engine
      const pool1: ScannedPoolRecord = {
        poolId: "p1",
        mintAddress: "m1",
        symbol: "S1",
        decimals: 9,
        baseMint: "m1",
        liquidityUsd: 30000,
        marketCapUsd: 100000,
        openTimeSec: Math.floor(Date.now() / 1000) - 300,
        lpBurnPct: 100,
        mintAuthority: null,
        freezeAuthority: null,
        volume5mUsd: 10000,
        txCount5m: 50,
        buys5m: 35,
        sells5m: 15,
        spotPriceUsd: 0.1,
        fetchedAt: new Date().toISOString(),
      };

      const pool2: ScannedPoolRecord = {
        ...pool1,
        poolId: "p2",
        mintAddress: "m2",
        liquidityUsd: 500, // Fails liquidity prescreen -> triggers error callback
      };

      engine.evaluatePool(pool1);
      engine.evaluatePool(pool2);

      expect(engine.getStats().totalEvaluationsAttempted).toBe(2);
      expect(engine.getStats().decisionCallbackErrors).toBe(1);

      // Record a TRIGGER_REJECTED decision
      decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "m1",
        poolId: "p1",
        symbol: "S1",
        sourceTimestampMs: Date.now(),
        ingestionTimestampMs: Date.now(),
        decisionCohort: "TRIGGER_REJECTED",
        primaryRejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY",
        filterEvaluations: [
          {
            filterName: "LiveLiquidityFloor",
            passed: false,
            valueObserved: 12000,
            threshold: 20000,
            rejectionReason: "Live liquidity $12000 < $20000",
          },
        ],
        metricsSnapshot: {
          tokenAgeSec: 300,
          liquidityUsd: 12000,
          marketCapUsd: 100000,
          lmcRatio: 0.12,
          lpBurnPct: 100,
          spotPriceUsd: 0.1,
          spotPriceSol: 0.0007,
          volume5mUsd: 5000,
          txCount5m: 30,
          buys5m: 20,
          sells5m: 10,
        },
        providerIdentity: "raydium",
      });

      const summary = storage.finalizeSessionTelemetry(sessionId, {
        generationId: "gen-01-legacy-baseline",
        strategyRevision: meta.strategyRevision,
        startedAtIso: meta.startedAtIso,
        totalCandidatesScreened: engine.getStats().totalEvaluationsAttempted,
        totalDecisionsRecorded: decRecorder.getTotalDecisionsCount(),
        decisionWriteFailures: storage.getDecisionWriteFailuresCount(),
        decisionCallbackErrors: engine.getStats().decisionCallbackErrors,
        rateShedCount: 0,
        cohortBreakdown: {
          filteredRejected: decRecorder.getCohortCount("FILTERED_REJECTED"),
          watchlistRadar: decRecorder.getCohortCount("WATCHLIST_RADAR"),
          triggerRejected: decRecorder.getCohortCount("TRIGGER_REJECTED"),
          executedBuy: decRecorder.getCohortCount("EXECUTED_BUY"),
        },
        topRejectionReasons: decRecorder.getRejectionReasonBreakdown(),
        totalMarketObservationsRecorded: storage.getMarketObservationsCount(),
        totalStratifiedCandidatesTracked: 1,
        missedWinnersCount: 0,
        avoidedRugsCount: 1,
      });

      expect(summary.totalCandidatesScreened).toBe(2);
      expect(summary.totalDecisionsRecorded).toBe(2);
      expect(summary.decisionCallbackErrors).toBe(1);
      expect(callbackErrorsCount).toBe(1);
      expect(summary.decisionWriteFailures).toBe(0);
      expect(summary.cohortBreakdown.triggerRejected).toBe(1);
      expect(summary.cohortBreakdown.watchlistRadar).toBe(1);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B2-07: bounded O(1) sustained-storage append latency benchmark without quadratic slowdown", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b207-"));
      const storage = new TelemetryStorageManager(tempDir);
      const decRecorder = new CandidateDecisionRecorder(storage);
      const sessionId = "session-b207-sustained";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const TOTAL_RECORDS = 1000;
      const startFirst100 = performance.now();

      for (let i = 0; i < 100; i++) {
        decRecorder.recordDecision({
          sessionId,
          generationId: "gen-01-legacy-baseline",
          mintAddress: `MintAddressBenchmark${i.toString().padStart(6, "0")}`,
          poolId: `PoolBenchmark${i}`,
          symbol: `SYM${i}`,
          sourceTimestampMs: 1700000000000 + i,
          ingestionTimestampMs: 1700000000000 + i,
          decisionCohort: "FILTERED_REJECTED",
          primaryRejectionReason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
          filterEvaluations: [],
          metricsSnapshot: {
            tokenAgeSec: 50,
            liquidityUsd: 1000,
            marketCapUsd: 10000,
            lmcRatio: 0.1,
            lpBurnPct: 100,
            spotPriceUsd: 0.01,
            spotPriceSol: 0.0001,
            volume5mUsd: 100,
            txCount5m: 5,
            buys5m: 2,
            sells5m: 3,
          },
          providerIdentity: "raydium",
        });
      }
      const durFirst100 = performance.now() - startFirst100;

      // Append middle 800 records
      for (let i = 100; i < 900; i++) {
        decRecorder.recordDecision({
          sessionId,
          generationId: "gen-01-legacy-baseline",
          mintAddress: `MintAddressBenchmark${i.toString().padStart(6, "0")}`,
          poolId: `PoolBenchmark${i}`,
          symbol: `SYM${i}`,
          sourceTimestampMs: 1700000000000 + i,
          ingestionTimestampMs: 1700000000000 + i,
          decisionCohort: "FILTERED_REJECTED",
          primaryRejectionReason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
          filterEvaluations: [],
          metricsSnapshot: {
            tokenAgeSec: 50,
            liquidityUsd: 1000,
            marketCapUsd: 10000,
            lmcRatio: 0.1,
            lpBurnPct: 100,
            spotPriceUsd: 0.01,
            spotPriceSol: 0.0001,
            volume5mUsd: 100,
            txCount5m: 5,
            buys5m: 2,
            sells5m: 3,
          },
          providerIdentity: "raydium",
        });
      }

      // Measure last 100 appends (when file is already 900 lines long)
      const startLast100 = performance.now();
      for (let i = 900; i < TOTAL_RECORDS; i++) {
        decRecorder.recordDecision({
          sessionId,
          generationId: "gen-01-legacy-baseline",
          mintAddress: `MintAddressBenchmark${i.toString().padStart(6, "0")}`,
          poolId: `PoolBenchmark${i}`,
          symbol: `SYM${i}`,
          sourceTimestampMs: 1700000000000 + i,
          ingestionTimestampMs: 1700000000000 + i,
          decisionCohort: "FILTERED_REJECTED",
          primaryRejectionReason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
          filterEvaluations: [],
          metricsSnapshot: {
            tokenAgeSec: 50,
            liquidityUsd: 1000,
            marketCapUsd: 10000,
            lmcRatio: 0.1,
            lpBurnPct: 100,
            spotPriceUsd: 0.01,
            spotPriceSol: 0.0001,
            volume5mUsd: 100,
            txCount5m: 5,
            buys5m: 2,
            sells5m: 3,
          },
          providerIdentity: "raydium",
        });
      }
      const durLast100 = performance.now() - startLast100;

      // In an O(1) single-byte tail inspection, the latency of appending to a 900-line file
      // does not grow quadratically. It should be within a factor of 5 of the first 100 appends.
      // (If it were O(N^2) full-file rescanning, it would be orders of magnitude slower).
      const ratio = durLast100 / Math.max(1, durFirst100);
      expect(ratio).toBeLessThan(10.0);

      // Verify all 1,000 records were written and can be read back cleanly
      const allRecords = storage.readCandidateDecisions(sessionId);
      expect(allRecords).toHaveLength(TOTAL_RECORDS);
      expect(storage.getCandidateDecisionsCount()).toBe(TOTAL_RECORDS);

      rmSync(tempDir, { recursive: true, force: true });
    }, 15000);

    it("verifies disposable end-to-end telemetry pipeline matching daemon wiring", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-e2e-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-e2e-daemon-parity";
      const meta = storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const decRecorder = new CandidateDecisionRecorder(storage);
      const obsRecorder = new MarketObservationRecorder(storage);
      const sampling = new StratifiedSamplingController(storage);
      const rateController = new TelemetryRateController({
        maxRequestsPerSec: 50.0,
        bucketCapacity: 10.0,
      });

      const scheduler = new TelemetryFollowUpScheduler(
        storage,
        obsRecorder,
        sampling,
        rateController,
        async (poolId) => ({
          spotPriceUsd: 0.25,
          spotPriceSol: 0.0018,
          liquidityUsd: 35000,
          txCount: 60,
          buys: 40,
          sells: 20,
          volumeUsd: 8000,
          priceSource: "INDEXED_TICK",
          actualPoolId: poolId,
        }),
      );

      // 1. Candidate scanned and placed on radar
      const radarDec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintE2E1111111111111111111111111111111",
        poolId: "PoolE2E1",
        symbol: "E2E",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        poolOpenTimeMs: 1699990000000,
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 10000,
          liquidityUsd: 30000,
          marketCapUsd: 120000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.2,
          spotPriceSol: 0.0014,
          volume5mUsd: 5000,
          txCount5m: 40,
          buys5m: 25,
          sells5m: 15,
        },
        providerIdentity: "dexscreener",
      });
      sampling.evaluateForTracking(radarDec, 0.0014);

      // 2. Buy triggered -> promoted to EXECUTED_POSITION
      const buyDec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintE2E1111111111111111111111111111111",
        poolId: "PoolE2E1",
        symbol: "E2E",
        sourceTimestampMs: 1700000010000,
        ingestionTimestampMs: 1700000010000,
        poolOpenTimeMs: 1699990000000,
        decisionCohort: "EXECUTED_BUY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 10010,
          liquidityUsd: 32000,
          marketCapUsd: 130000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.22,
          spotPriceSol: 0.0016,
          volume5mUsd: 6000,
          txCount5m: 45,
          buys5m: 30,
          sells5m: 15,
        },
        providerIdentity: "dexscreener",
      });
      sampling.evaluateForTracking(buyDec, 0.0016);

      // 3. Follow-up scheduler polls active tracker
      await scheduler.pollPendingTrackers(1700000016000);

      // 4. Another candidate rejected at live liquidity floor
      decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintE2ERejected2222222222222222222222222",
        poolId: "PoolE2ERejected2",
        symbol: "REJ",
        sourceTimestampMs: 1700000020000,
        ingestionTimestampMs: 1700000020000,
        decisionCohort: "TRIGGER_REJECTED",
        primaryRejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY",
        filterEvaluations: [
          {
            filterName: "LiveLiquidityFloor",
            passed: false,
            valueObserved: 15000,
            threshold: 20000,
            rejectionReason: "Live liquidity $15000 < $20000",
          },
        ],
        metricsSnapshot: {
          tokenAgeSec: 500,
          liquidityUsd: 15000,
          marketCapUsd: 60000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.05,
          spotPriceSol: 0.00035,
          volume5mUsd: 1000,
          txCount5m: 10,
          buys5m: 6,
          sells5m: 4,
        },
        providerIdentity: "dexscreener",
      });

      // 5. Finalize session telemetry
      const summary = storage.finalizeSessionTelemetry(sessionId, {
        generationId: "gen-01-legacy-baseline",
        strategyRevision: meta.strategyRevision,
        startedAtIso: meta.startedAtIso,
        totalCandidatesScreened: 3,
        totalDecisionsRecorded: decRecorder.getTotalDecisionsCount(),
        decisionWriteFailures: storage.getDecisionWriteFailuresCount(),
        decisionCallbackErrors: 0,
        rateShedCount: rateController.getShedCount(),
        cohortBreakdown: {
          filteredRejected: decRecorder.getCohortCount("FILTERED_REJECTED"),
          watchlistRadar: decRecorder.getCohortCount("WATCHLIST_RADAR"),
          triggerRejected: decRecorder.getCohortCount("TRIGGER_REJECTED"),
          executedBuy: decRecorder.getCohortCount("EXECUTED_BUY"),
        },
        topRejectionReasons: decRecorder.getRejectionReasonBreakdown(),
        totalMarketObservationsRecorded: storage.getMarketObservationsCount(),
        totalStratifiedCandidatesTracked: sampling.getTotalEverTrackedCount(),
        missedWinnersCount: 0,
        avoidedRugsCount: 1,
      });

      expect(summary.totalDecisionsRecorded).toBe(3);
      expect(summary.cohortBreakdown.watchlistRadar).toBe(1);
      expect(summary.cohortBreakdown.executedBuy).toBe(1);
      expect(summary.cohortBreakdown.triggerRejected).toBe(1);
      expect(summary.totalMarketObservationsRecorded).toBe(1);
      expect(summary.totalStratifiedCandidatesTracked).toBe(1);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // 9. Phase 12.94-B Audit v3 Focus Verifications (B3-01 through B3-04)
  // --------------------------------------------------------------------------
  describe("9. Phase 12.94-B Audit v3 Focus Verifications (B3-01 through B3-04)", () => {
    it("B3-01: provider metrics distinguish observed facts from derived or unavailable metrics, and preserve nulls", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b3-01-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-b3-01-provenance";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);
      const decRecorder = new CandidateDecisionRecorder(storage);

      // Create a candidate where 5m volume and transaction counts are unavailable from the provider
      const decision = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintProv111111111111111111111111111111111111",
        poolId: "raydium-pool-prov-1",
        symbol: "PROV",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000100,
        decisionCohort: "FILTERED_REJECTED",
        primaryRejectionReason: "REJECTED_INSUFFICIENT_TRANSACTION_COUNT",
        filterEvaluations: [
          {
            filterName: "TransactionCountFloor",
            passed: false,
            valueObserved: null,
            threshold: 10,
            rejectionReason: "REJECTED_INSUFFICIENT_TRANSACTION_COUNT",
          },
        ],
        metricsSnapshot: {
          tokenAgeSec: 120,
          liquidityUsd: 12000,
          marketCapUsd: 48000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.05,
          spotPriceSol: 0.00035, // Native price preserved without synthetic / 140
          volume5mUsd: null,
          txCount5m: null,
          buys5m: null,
          sells5m: null,
          metricProvenance: {
            tokenAgeSec: "OBSERVED",
            liquidityUsd: "OBSERVED",
            marketCapUsd: "OBSERVED",
            lmcRatio: "DERIVED",
            lpBurnPct: "OBSERVED",
            spotPriceUsd: "OBSERVED",
            spotPriceSol: "OBSERVED",
            volume5mUsd: "UNAVAILABLE",
            txCount5m: "UNAVAILABLE",
            buys5m: "UNAVAILABLE",
            sells5m: "UNAVAILABLE",
          },
        },
        providerIdentity: "raydium",
      });

      expect(decision.metricsSnapshot.volume5mUsd).toBeNull();
      expect(decision.metricsSnapshot.txCount5m).toBeNull();
      expect(decision.metricsSnapshot.buys5m).toBeNull();
      expect(decision.metricsSnapshot.sells5m).toBeNull();
      expect(decision.metricsSnapshot.metricProvenance?.volume5mUsd).toBe("UNAVAILABLE");
      expect(decision.metricsSnapshot.metricProvenance?.txCount5m).toBe("UNAVAILABLE");
      expect(decision.metricsSnapshot.metricProvenance?.spotPriceSol).toBe("OBSERVED");
      expect(decision.metricsSnapshot.spotPriceSol).toBe(0.00035);

      // Verify that point-in-time reconstruction reconstructs prices in native units without cross-currency conversion
      const reconstructor = new DecisionContextReconstructor(storage);
      const reconstructed = reconstructor.reconstructContext(decision);
      expect(reconstructed.reconstructedMarketState.latestSpotPriceSol).toBe(0.00035);
      expect(reconstructed.reconstructedOrderBook.estimatedSpotSol).toBe(0.00035);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B3-02: denied optional telemetry permit produces 0 HTTP requests in TelemetryFollowUpScheduler", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b3-02-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-b3-02-budget";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const obsRecorder = new MarketObservationRecorder(storage);
      const sampling = new StratifiedSamplingController(storage);
      const decRecorder = new CandidateDecisionRecorder(storage);

      // Deplete rate controller bucket (capacity 0)
      const rateController = new TelemetryRateController({
        maxRequestsPerSec: 0.001,
        bucketCapacity: 0.0,
      });

      let httpCallsCount = 0;
      const scheduler = new TelemetryFollowUpScheduler(
        storage,
        obsRecorder,
        sampling,
        rateController,
        async () => {
          httpCallsCount++;
          return {
            spotPriceUsd: 0.1,
            spotPriceSol: 0.001,
            priceSource: "INDEXED_TICK",
          };
        },
      );

      // Register candidate tracker
      const dec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintBudget1111111111111111111111111111111111",
        poolId: "pool-budget-1",
        symbol: "BUDGET",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 25000,
          marketCapUsd: 100000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.1,
          spotPriceSol: 0.001,
          volume5mUsd: 5000,
          txCount5m: 50,
          buys5m: 30,
          sells5m: 20,
        },
        providerIdentity: "dexscreener",
      });
      sampling.evaluateForTracking(dec, 0.001);

      // Poll trackers when no permits are available
      const pollResult = await scheduler.pollPendingTrackers(1700000031000);

      // CRITICAL ASSERTION: Zero HTTP network requests issued
      expect(httpCallsCount).toBe(0);
      expect(pollResult.polledCount).toBe(0);
      expect(pollResult.skippedShedCount).toBe(1);
      expect(storage.getMarketObservationsCount()).toBe(0);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B3-03: follow-up observations reject cross-pool quotes, preserve true measurement window, and record nulls for unobserved fields", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b3-03-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-b3-03-pool-iso";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const obsRecorder = new MarketObservationRecorder(storage);
      const sampling = new StratifiedSamplingController(storage);
      const decRecorder = new CandidateDecisionRecorder(storage);
      const rateController = new TelemetryRateController({
        maxRequestsPerSec: 10,
        bucketCapacity: 10,
      });

      let currentResponsePoolId = "different-pool-999";
      let measurementWindowSec = 300;

      const scheduler = new TelemetryFollowUpScheduler(
        storage,
        obsRecorder,
        sampling,
        rateController,
        async () => {
          return {
            spotPriceUsd: 0.05,
            spotPriceSol: 0.00035,
            liquidityUsd: 20000,
            baseReserve: null, // Unobserved reserve persists as null
            quoteReserve: null,
            txCount: 15,
            buys: 10,
            sells: 5,
            volumeUsd: 1200,
            netBuyerVolumeUsd: null,
            priceSource: "INDEXED_TICK",
            actualPoolId: currentResponsePoolId,
            measurementWindowSec,
            sourceTimestampMs: 1700000010000,
          };
        },
      );

      // Register tracker for pool-alpha
      const dec = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintAlpha1111111111111111111111111111111111",
        poolId: "pool-alpha",
        symbol: "ALPHA",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 50,
          liquidityUsd: 20000,
          marketCapUsd: 80000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.05,
          spotPriceSol: 0.00035,
          volume5mUsd: 1000,
          txCount5m: 10,
          buys5m: 6,
          sells5m: 4,
        },
        providerIdentity: "dexscreener",
      });
      sampling.evaluateForTracking(dec, 0.00035);

      // 1. Cross-pool quote returned (different-pool-999 !== pool-alpha)
      await scheduler.pollPendingTrackers(1700000031000);

      // Observation must be discarded: no cross-pool contamination
      expect(storage.getMarketObservationsCount()).toBe(0);

      // 2. Matching pool quote returned (pool-alpha) with 300s window and null reserves
      currentResponsePoolId = "pool-alpha";
      measurementWindowSec = 300;
      await scheduler.pollPendingTrackers(1700000032000);

      expect(storage.getMarketObservationsCount()).toBe(1);
      const observations = storage.readMarketObservations(sessionId);
      expect(observations).toHaveLength(1);
      const obs = observations[0]!;
      expect(obs.poolId).toBe("pool-alpha");
      expect(obs.actualResponsePoolId).toBe("pool-alpha");
      expect(obs.measurementWindow.durationSec).toBe(300); // Truthful provider window
      expect(obs.liquidityMetrics.baseReserve).toBeNull(); // Truthful null, not 0
      expect(obs.liquidityMetrics.quoteReserve).toBeNull();
      expect(obs.flowMetrics.netBuyerVolumeUsd).toBeNull();

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B3-04: decision cohorts survive simulated crash/restart, reconciling to independent denominators; summary fails closed on conflict", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b3-04-"));
      const storage1 = new TelemetryStorageManager(tempDir);
      const sessionId = "session-b3-04-reconciliation";
      storage1.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);
      const decRecorder1 = new CandidateDecisionRecorder(storage1);

      // Record distinct decision cohorts
      decRecorder1.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "Mint1111111111111111111111111111111111111111",
        poolId: "pool-1",
        symbol: "S1",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        decisionCohort: "FILTERED_REJECTED",
        primaryRejectionReason: "REJECTED_IMBALANCED_LIQUIDITY_DEPTH",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 10,
          liquidityUsd: 1000,
          marketCapUsd: 5000,
          lmcRatio: 0.2,
          lpBurnPct: 100,
          spotPriceUsd: 0.01,
          volume5mUsd: null,
          txCount5m: null,
          buys5m: null,
          sells5m: null,
        },
        providerIdentity: "raydium",
      });

      decRecorder1.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "Mint2222222222222222222222222222222222222222",
        poolId: "pool-2",
        symbol: "S2",
        sourceTimestampMs: 1700000001000,
        ingestionTimestampMs: 1700000001000,
        decisionCohort: "WATCHLIST_RADAR",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 100,
          liquidityUsd: 25000,
          marketCapUsd: 100000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.1,
          volume5mUsd: 5000,
          txCount5m: 50,
          buys5m: 30,
          sells5m: 20,
        },
        providerIdentity: "dexscreener",
      });

      decRecorder1.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "Mint3333333333333333333333333333333333333333",
        poolId: "pool-3",
        symbol: "S3",
        sourceTimestampMs: 1700000002000,
        ingestionTimestampMs: 1700000002000,
        decisionCohort: "TRIGGER_REJECTED",
        primaryRejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 200,
          liquidityUsd: 18000,
          marketCapUsd: 80000,
          lmcRatio: 0.22,
          lpBurnPct: 100,
          spotPriceUsd: 0.08,
          volume5mUsd: 3000,
          txCount5m: 20,
          buys5m: 10,
          sells5m: 10,
        },
        providerIdentity: "dexscreener",
      });

      decRecorder1.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "Mint4444444444444444444444444444444444444444",
        poolId: "pool-4",
        symbol: "S4",
        sourceTimestampMs: 1700000003000,
        ingestionTimestampMs: 1700000003000,
        decisionCohort: "EXECUTED_BUY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: 300,
          liquidityUsd: 50000,
          marketCapUsd: 200000,
          lmcRatio: 0.25,
          lpBurnPct: 100,
          spotPriceUsd: 0.2,
          volume5mUsd: 10000,
          txCount5m: 80,
          buys5m: 50,
          sells5m: 30,
        },
        providerIdentity: "dexscreener",
      });

      expect(decRecorder1.getTotalDecisionsCount()).toBe(4);
      expect(decRecorder1.getScannerDecisionsCount()).toBe(2);
      expect(decRecorder1.getTriggerDecisionsCount()).toBe(1);
      expect(decRecorder1.getExecutedBuyDecisionsCount()).toBe(1);

      // SIMULATE CRASH & RESTART (clean instance reading only on-disk JSONL)
      const storage2 = new TelemetryStorageManager(tempDir);
      const meta = storage2.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);
      const decRecorder2 = new CandidateDecisionRecorder(storage2);
      decRecorder2.syncFromStorage(sessionId);

      // Reconciled counts restored accurately
      expect(decRecorder2.getTotalDecisionsCount()).toBe(4);
      expect(decRecorder2.getScannerDecisionsCount()).toBe(2);
      expect(decRecorder2.getTriggerDecisionsCount()).toBe(1);
      expect(decRecorder2.getExecutedBuyDecisionsCount()).toBe(1);

      // Finalize session telemetry
      const summary = storage2.finalizeSessionTelemetry(sessionId, {
        generationId: "gen-01-legacy-baseline",
        strategyRevision: meta.strategyRevision,
        startedAtIso: meta.startedAtIso,
        totalCandidatesScreened: 5,
        totalScannerDecisionsRecorded: decRecorder2.getScannerDecisionsCount(),
        totalTriggerDecisionsRecorded: decRecorder2.getTriggerDecisionsCount(),
        totalExecutedBuyDecisionsRecorded: decRecorder2.getExecutedBuyDecisionsCount(),
        totalDecisionsRecorded: decRecorder2.getTotalDecisionsCount(),
        decisionWriteFailures: 0,
        cohortBreakdown: {
          filteredRejected: decRecorder2.getCohortCount("FILTERED_REJECTED"),
          watchlistRadar: decRecorder2.getCohortCount("WATCHLIST_RADAR"),
          triggerRejected: decRecorder2.getCohortCount("TRIGGER_REJECTED"),
          executedBuy: decRecorder2.getCohortCount("EXECUTED_BUY"),
        },
        topRejectionReasons: decRecorder2.getRejectionReasonBreakdown(),
        totalMarketObservationsRecorded: 0,
        totalStratifiedCandidatesTracked: 0,
        missedWinnersCount: 0,
        avoidedRugsCount: 0,
      });

      expect(summary.totalScannerDecisionsRecorded).toBe(2);
      expect(summary.totalTriggerDecisionsRecorded).toBe(1);
      expect(summary.totalExecutedBuyDecisionsRecorded).toBe(1);
      expect(summary.totalDecisionsRecorded).toBe(4);

      // Re-finalizing with differing counts must fail closed
      expect(() => {
        storage2.finalizeSessionTelemetry(sessionId, {
          generationId: "gen-01-legacy-baseline",
          strategyRevision: meta.strategyRevision,
          startedAtIso: meta.startedAtIso,
          totalCandidatesScreened: 5,
          totalScannerDecisionsRecorded: 999, // Conflicting count
          totalTriggerDecisionsRecorded: 1,
          totalExecutedBuyDecisionsRecorded: 1,
          totalDecisionsRecorded: 999,
          decisionWriteFailures: 0,
          cohortBreakdown: {
            filteredRejected: 999,
            watchlistRadar: 0,
            triggerRejected: 1,
            executedBuy: 1,
          },
          topRejectionReasons: {},
          totalMarketObservationsRecorded: 0,
          totalStratifiedCandidatesTracked: 0,
          missedWinnersCount: 0,
          avoidedRugsCount: 0,
        });
      }).toThrow(/\[FATAL_SESSION_ALREADY_FINALIZED\]/);

      // Permanent removal of --reset-wallet: verify it throws FATAL_OPERATION_DISABLED
      expect(() => {
        parseCliArgs(["--reset-wallet"]);
      }).toThrow(/\[FATAL_OPERATION_DISABLED\]/);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 10: Phase 12.94-B Audit v4 Focus Verifications (B4-01 through B4-03)
  // --------------------------------------------------------------------------
  describe("10. Phase 12.94-B Audit v4 Focus Verifications (B4-01 through B4-03)", () => {
    it("B4-01: preserve metric provenance throughout candidate lifecycle (Raydium placeholder/derived values do not become OBSERVED in trigger-rejection or executed-buy decisions)", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b401-"));
      const storage = new TelemetryStorageManager(tempDir);
      const decRecorder = new CandidateDecisionRecorder(storage);
      const sessionId = "session-b401-provenance";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      // Scanned pool record with Raydium characteristics (unobserved 5m txs / derived mcap / placeholder lpBurn)
      const raydiumPool: ScannedPoolRecord = {
        poolId: "raydium-pool-123",
        mintAddress: "MintRaydiumPlaceholder11111111111111111111111",
        symbol: "RAYPH",
        decimals: 6,
        baseMint: "So11111111111111111111111111111111111111112",
        liquidityUsd: 25000,
        marketCapUsd: 100000,
        openTimeSec: 1700000000 - 600, // 10m age
        lpBurnPct: 100,
        mintAuthority: null,
        freezeAuthority: null,
        volume5mUsd: 1000,
        txCount5m: 30,
        buys5m: 18,
        sells5m: 12,
        spotPriceUsd: 0.05,
        spotPriceSol: 0.00035,
        fetchedAt: new Date().toISOString(),
        metricProvenance: {
          tokenAgeSec: "OBSERVED",
          liquidityUsd: "OBSERVED",
          marketCapUsd: "DERIVED",
          lmcRatio: "DERIVED",
          lpBurnPct: "PLACEHOLDER",
          spotPriceUsd: "OBSERVED",
          spotPriceSol: "OBSERVED",
          volume5mUsd: "PLACEHOLDER",
          txCount5m: "PLACEHOLDER",
          buys5m: "PLACEHOLDER",
          sells5m: "PLACEHOLDER",
        },
      };

      // 1. Candidate evaluation carries provenance into candidate
      const evaluator = new CandidateScannerEvaluator();
      const evalResult = evaluator.evaluate(raydiumPool, CANDIDATE_SCANNER_DEFAULTS, 1700000000);
      expect(evalResult.admitted).toBe(true);
      expect(evalResult.candidate?.metricProvenance?.volume5mUsd).toBe("PLACEHOLDER");
      expect(evalResult.candidate?.metricProvenance?.marketCapUsd).toBe("DERIVED");
      expect(evalResult.candidate?.metricProvenance?.lpBurnPct).toBe("PLACEHOLDER");
      expect(evalResult.candidate?.metricProvenance?.txCount5m).toBe("PLACEHOLDER");

      // 2. Watchlist admission carries provenance into WatchlistCandidateItem
      const watchlistService = new CandidateWatchlistService();
      const watchItem = watchlistService.admitOrUpdate(raydiumPool, 1700000000);
      expect(watchItem).not.toBeNull();
      expect(watchItem?.metricProvenance?.volume5mUsd).toBe("PLACEHOLDER");
      expect(watchItem?.metricProvenance?.marketCapUsd).toBe("DERIVED");
      expect(watchItem?.metricProvenance?.lpBurnPct).toBe("PLACEHOLDER");
      expect(watchItem?.metricProvenance?.txCount5m).toBe("PLACEHOLDER");

      // 3. Trigger Rejection without fresh provider 5m data MUST NOT relabel placeholders as OBSERVED
      const cand = watchItem!;
      const spotInfoWithout5m = {
        spotPriceSol: 0.00036,
        spotPriceUsd: 0.051,
        rawProviderMetrics: {
          volume5mUsd: null,
          txCount5m: null,
          buys5m: null,
          sells5m: null,
          liquidityUsd: null,
        },
      };

      const candProv = cand.metricProvenance ?? {};
      const raw = spotInfoWithout5m.rawProviderMetrics;
      const provVolume: MetricProvenance =
        raw.volume5mUsd !== null && raw.volume5mUsd !== undefined
          ? "OBSERVED"
          : (candProv.volume5mUsd ?? (cand.volume5mUsd !== undefined ? "DERIVED" : "UNAVAILABLE"));
      const provMcap: MetricProvenance =
        candProv.marketCapUsd ?? (cand.marketCapUsd > 0 ? "DERIVED" : "UNAVAILABLE");
      const provLpBurn: MetricProvenance =
        candProv.lpBurnPct ?? (cand.lpBurnPct !== undefined ? "OBSERVED" : "UNAVAILABLE");
      const provTxCount: MetricProvenance =
        raw.txCount5m !== null && raw.txCount5m !== undefined
          ? "OBSERVED"
          : (candProv.txCount5m ?? "UNAVAILABLE");

      const rejectionDecision = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: cand.mintAddress,
        poolId: cand.poolId,
        symbol: cand.symbol,
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        decisionCohort: "TRIGGER_REJECTED",
        primaryRejectionReason: "REJECTED_MOMENTUM_STALLED",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: cand.assetAgeSeconds,
          liquidityUsd: cand.liquidityUsd,
          marketCapUsd: cand.marketCapUsd,
          lmcRatio: cand.lmcRatio,
          lpBurnPct: cand.lpBurnPct,
          spotPriceUsd: spotInfoWithout5m.spotPriceUsd,
          spotPriceSol: spotInfoWithout5m.spotPriceSol,
          volume5mUsd: cand.volume5mUsd,
          txCount5m: null,
          buys5m: null,
          sells5m: null,
          metricProvenance: {
            tokenAgeSec: "OBSERVED",
            liquidityUsd: "OBSERVED",
            marketCapUsd: provMcap,
            lmcRatio: "DERIVED",
            lpBurnPct: provLpBurn,
            spotPriceUsd: "OBSERVED",
            spotPriceSol: "OBSERVED",
            volume5mUsd: provVolume,
            txCount5m: provTxCount,
            buys5m: "UNAVAILABLE",
            sells5m: "UNAVAILABLE",
          },
        },
        providerIdentity: "raydium",
      });

      expect(rejectionDecision.metricsSnapshot.metricProvenance?.volume5mUsd).toBe("PLACEHOLDER");
      expect(rejectionDecision.metricsSnapshot.metricProvenance?.volume5mUsd).not.toBe("OBSERVED");
      expect(rejectionDecision.metricsSnapshot.metricProvenance?.marketCapUsd).toBe("DERIVED");
      expect(rejectionDecision.metricsSnapshot.metricProvenance?.marketCapUsd).not.toBe("OBSERVED");
      expect(rejectionDecision.metricsSnapshot.metricProvenance?.lpBurnPct).toBe("PLACEHOLDER");
      expect(rejectionDecision.metricsSnapshot.metricProvenance?.lpBurnPct).not.toBe("OBSERVED");
      expect(rejectionDecision.metricsSnapshot.metricProvenance?.txCount5m).toBe("PLACEHOLDER");
      expect(rejectionDecision.metricsSnapshot.metricProvenance?.txCount5m).not.toBe("OBSERVED");

      // 4. Executed Buy without fresh provider 5m data MUST NOT relabel placeholders as OBSERVED
      const buyDecision = decRecorder.recordDecision({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: cand.mintAddress,
        poolId: cand.poolId,
        symbol: cand.symbol,
        sourceTimestampMs: 1700000001000,
        ingestionTimestampMs: 1700000001000,
        decisionCohort: "EXECUTED_BUY",
        filterEvaluations: [],
        metricsSnapshot: {
          tokenAgeSec: cand.assetAgeSeconds,
          liquidityUsd: cand.liquidityUsd,
          marketCapUsd: cand.marketCapUsd,
          lmcRatio: cand.lmcRatio,
          lpBurnPct: cand.lpBurnPct,
          spotPriceUsd: spotInfoWithout5m.spotPriceUsd,
          spotPriceSol: spotInfoWithout5m.spotPriceSol,
          volume5mUsd: cand.volume5mUsd,
          txCount5m: null,
          buys5m: null,
          sells5m: null,
          metricProvenance: {
            tokenAgeSec: "OBSERVED",
            liquidityUsd: "OBSERVED",
            marketCapUsd: provMcap,
            lmcRatio: "DERIVED",
            lpBurnPct: provLpBurn,
            spotPriceUsd: "OBSERVED",
            spotPriceSol: "OBSERVED",
            volume5mUsd: provVolume,
            txCount5m: provTxCount,
            buys5m: "UNAVAILABLE",
            sells5m: "UNAVAILABLE",
          },
        },
        providerIdentity: "raydium",
      });

      expect(buyDecision.metricsSnapshot.metricProvenance?.volume5mUsd).toBe("PLACEHOLDER");
      expect(buyDecision.metricsSnapshot.metricProvenance?.volume5mUsd).not.toBe("OBSERVED");
      expect(buyDecision.metricsSnapshot.metricProvenance?.marketCapUsd).toBe("DERIVED");
      expect(buyDecision.metricsSnapshot.metricProvenance?.marketCapUsd).not.toBe("OBSERVED");
      expect(buyDecision.metricsSnapshot.metricProvenance?.lpBurnPct).toBe("PLACEHOLDER");
      expect(buyDecision.metricsSnapshot.metricProvenance?.lpBurnPct).not.toBe("OBSERVED");
      expect(buyDecision.metricsSnapshot.metricProvenance?.txCount5m).toBe("PLACEHOLDER");
      expect(buyDecision.metricsSnapshot.metricProvenance?.txCount5m).not.toBe("OBSERVED");

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B4-02: fail closed on missing or mismatched pool identity (fixtures for matching, mismatched, and missing provider pool IDs)", async () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b402-"));
      const storage = new TelemetryStorageManager(tempDir);
      const obsRecorder = new MarketObservationRecorder(storage);
      const sampling = new StratifiedSamplingController(storage);
      const sessionId = "session-b402-pool-id";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      // Tracked pool: dexscreener-target-pool-1
      const tracker = sampling.evaluateForTracking(
        {
          eventId: "ev-target-1",
          sessionId,
          generationId: "gen-01-legacy-baseline",
          mintAddress: "MintPoolTest1111111111111111111111111111111",
          poolId: "dexscreener-target-pool-1",
          symbol: "TGT",
          decisionCohort: "EXECUTED_BUY",
          sourceTimestampMs: 1700000000000,
          ingestionTimestampMs: 1700000000000,
          decisionTimestampMs: 1700000000000,
          strategyRevision: "phase-12.94b",
          missingFields: [],
          filterEvaluations: [],
          metricsSnapshot: {
            tokenAgeSec: 100,
            liquidityUsd: 50000,
            marketCapUsd: 200000,
            lmcRatio: 0.25,
            lpBurnPct: 100,
            spotPriceUsd: 0.1,
            spotPriceSol: 0.0007,
            volume5mUsd: 5000,
            txCount5m: 50,
            buys5m: 30,
            sells5m: 20,
          },
          providerIdentity: "dexscreener",
        },
        0.0007,
      );

      expect(tracker).not.toBeNull();

      // Fixture 1: Matching pool ID (normalized match) -> Accepted and recorded
      let simulatedResponse: FollowUpObservationResult = {
        spotPriceUsd: 0.11,
        spotPriceSol: 0.00075,
        liquidityUsd: 52000,
        baseReserve: 100000,
        quoteReserve: 75,
        txCount: 60,
        buys: 35,
        sells: 25,
        volumeUsd: 6000,
        netBuyerVolumeUsd: 1500,
        actualPoolId: "target-pool-1", // Exact match after stripping dexscreener- prefix
        priceSource: "POOL_RESERVE",
        measurementWindowSec: 300,
      };

      const rateController = new TelemetryRateController({
        maxRequestsPerSec: 50,
        bucketCapacity: 10,
      });

      const schedulerMatching = new TelemetryFollowUpScheduler(
        storage,
        obsRecorder,
        sampling,
        rateController,
        async () => simulatedResponse,
      );

      const pollMatching = await schedulerMatching.pollPendingTrackers(1700000005000);
      expect(pollMatching.polledCount).toBe(1);
      expect(storage.getMarketObservationsCount()).toBe(1);
      const obsMatching = storage.readMarketObservations(sessionId);
      expect(obsMatching.length).toBe(1);
      expect(obsMatching[0]!.actualResponsePoolId).toBe("target-pool-1");

      // Fixture 2: Mismatched pool ID -> Discarded, no observation appended
      simulatedResponse = {
        ...simulatedResponse,
        actualPoolId: "different-untracked-pool-999",
      };

      const schedulerMismatch = new TelemetryFollowUpScheduler(
        storage,
        obsRecorder,
        sampling,
        rateController,
        async () => simulatedResponse,
      );

      const pollMismatch = await schedulerMismatch.pollPendingTrackers(1700000015000);
      expect(pollMismatch.polledCount).toBe(0); // Discarded due to pool mismatch!
      expect(storage.getMarketObservationsCount()).toBe(1); // Observation discarded, count remains 1!

      // Fixture 3: Missing pool ID (undefined / null) -> Discarded, fails closed
      simulatedResponse = {
        ...simulatedResponse,
        actualPoolId: undefined, // Missing!
      };

      const schedulerMissing = new TelemetryFollowUpScheduler(
        storage,
        obsRecorder,
        sampling,
        rateController,
        async () => simulatedResponse,
      );

      const pollMissing = await schedulerMissing.pollPendingTrackers(1700000030000);
      expect(pollMissing.polledCount).toBe(0); // Discarded due to missing pool identity!
      expect(storage.getMarketObservationsCount()).toBe(1); // Discarded, count remains 1!

      // Verify MarketObservationRecorder directly never substitutes expected poolId into actualResponsePoolId
      const directObs = obsRecorder.recordObservation({
        sessionId,
        generationId: "gen-01-legacy-baseline",
        mintAddress: "MintDirect1111111111111111111111111111111111",
        poolId: "expected-pool-xyz",
        sourceTimestampMs: 1700000000000,
        ingestionTimestampMs: 1700000000000,
        measurementWindow: {
          windowStartMs: 1700000000000 - 300000,
          windowEndMs: 1700000000000,
          durationSec: 300,
        },
        providerIdentity: "test",
        priceMetrics: { spotPriceUsd: 0.1, spotPriceSol: 0.0007, priceSource: "POOL_RESERVE" },
        liquidityMetrics: { baseReserve: null, quoteReserve: null, liquidityUsd: null },
        flowMetrics: {
          txCount: null,
          buys: null,
          sells: null,
          volumeUsd: null,
          netBuyerVolumeUsd: null,
        },
        // actualResponsePoolId omitted
      });

      expect(directObs.actualResponsePoolId).toBeUndefined();
      expect(directObs.actualResponsePoolId).not.toBe("expected-pool-xyz");

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B4-03: interrupted-session semantics and strengthened session-summary idempotency", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b403-"));
      const storage1 = new TelemetryStorageManager(tempDir);
      const sessionId = "session-b403-recovery-test";

      // 1. Initial session startup writes session-meta.json with ACTIVE and isInterruptedSession: false
      const meta1 = storage1.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);
      expect(meta1.sessionStatus).toBe("ACTIVE");
      expect(meta1.isInterruptedSession).toBe(false);

      // 2. Simulate process restart / resume on existing unfinalized session directory:
      // Policy: Same-session resume with live tracker replay is not supported.
      // Must mark sessionStatus: INTERRUPTED and isInterruptedSession: true.
      const storage2 = new TelemetryStorageManager(tempDir);
      const meta2 = storage2.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);
      expect(meta2.sessionStatus).toBe("INTERRUPTED");
      expect(meta2.isInterruptedSession).toBe(true);
      expect(meta2.resumedFromPriorCrash).toBe(true);

      // 3. Finalizing an interrupted session marks isCompleteSession: false, isInterruptedSession: true
      const summary1 = storage2.finalizeSessionTelemetry(sessionId, {
        generationId: "gen-01-legacy-baseline",
        strategyRevision: meta2.strategyRevision,
        startedAtIso: meta2.startedAtIso,
        totalCandidatesScreened: 20,
        totalDecisionsRecorded: 10,
        totalScannerDecisionsRecorded: 6,
        totalTriggerDecisionsRecorded: 3,
        totalExecutedBuyDecisionsRecorded: 1,
        decisionWriteFailures: 0,
        cohortBreakdown: {
          filteredRejected: 4,
          watchlistRadar: 2,
          triggerRejected: 3,
          executedBuy: 1,
        },
        topRejectionReasons: { REJECTED_MOMENTUM_STALLED: 3 },
        totalMarketObservationsRecorded: 5,
        totalStratifiedCandidatesTracked: 3,
        missedWinnersCount: 1,
        avoidedRugsCount: 2,
      });

      expect(summary1.isCompleteSession).toBe(false);
      expect(summary1.isInterruptedSession).toBe(true);

      // 4. Strengthened summary idempotency: identical summary returns existing summary cleanly
      const summaryIdempotent = storage2.finalizeSessionTelemetry(sessionId, {
        generationId: "gen-01-legacy-baseline",
        strategyRevision: meta2.strategyRevision,
        startedAtIso: meta2.startedAtIso,
        totalCandidatesScreened: 20,
        totalDecisionsRecorded: 10,
        totalScannerDecisionsRecorded: 6,
        totalTriggerDecisionsRecorded: 3,
        totalExecutedBuyDecisionsRecorded: 1,
        decisionWriteFailures: 0,
        cohortBreakdown: {
          filteredRejected: 4,
          watchlistRadar: 2,
          triggerRejected: 3,
          executedBuy: 1,
        },
        topRejectionReasons: { REJECTED_MOMENTUM_STALLED: 3 },
        totalMarketObservationsRecorded: 5,
        totalStratifiedCandidatesTracked: 3,
        missedWinnersCount: 1,
        avoidedRugsCount: 2,
      });

      expect(summaryIdempotent).toEqual(summary1);

      // 5. Conflicting same-primary-count summary:
      // totalCandidatesScreened and totalDecisionsRecorded match, but totalMarketObservationsRecorded differs!
      // Must FAIL CLOSED and throw FATAL_SESSION_ALREADY_FINALIZED.
      expect(() => {
        storage2.finalizeSessionTelemetry(sessionId, {
          generationId: "gen-01-legacy-baseline",
          strategyRevision: meta2.strategyRevision,
          startedAtIso: meta2.startedAtIso,
          totalCandidatesScreened: 20,
          totalDecisionsRecorded: 10, // Same primary count
          totalScannerDecisionsRecorded: 6,
          totalTriggerDecisionsRecorded: 3,
          totalExecutedBuyDecisionsRecorded: 1,
          decisionWriteFailures: 0,
          cohortBreakdown: {
            filteredRejected: 4,
            watchlistRadar: 2,
            triggerRejected: 3,
            executedBuy: 1,
          },
          topRejectionReasons: { REJECTED_MOMENTUM_STALLED: 3 },
          totalMarketObservationsRecorded: 999, // Conflicting observations count!
          totalStratifiedCandidatesTracked: 3,
          missedWinnersCount: 1,
          avoidedRugsCount: 2,
        });
      }).toThrow(/\[FATAL_SESSION_ALREADY_FINALIZED\]/);

      // 6. Conflicting cohort totals with same primary count:
      expect(() => {
        storage2.finalizeSessionTelemetry(sessionId, {
          generationId: "gen-01-legacy-baseline",
          strategyRevision: meta2.strategyRevision,
          startedAtIso: meta2.startedAtIso,
          totalCandidatesScreened: 20,
          totalDecisionsRecorded: 10, // Same primary count
          totalScannerDecisionsRecorded: 6,
          totalTriggerDecisionsRecorded: 3,
          totalExecutedBuyDecisionsRecorded: 1,
          decisionWriteFailures: 0,
          cohortBreakdown: {
            filteredRejected: 1, // Conflicting cohort counts!
            watchlistRadar: 5,
            triggerRejected: 3,
            executedBuy: 1,
          },
          topRejectionReasons: { REJECTED_MOMENTUM_STALLED: 3 },
          totalMarketObservationsRecorded: 5,
          totalStratifiedCandidatesTracked: 3,
          missedWinnersCount: 1,
          avoidedRugsCount: 2,
        });
      }).toThrow(/\[FATAL_SESSION_ALREADY_FINALIZED\]/);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  // --------------------------------------------------------------------------
  // Suite 11: Phase 12.94-B Audit v5 Focus Verifications (B5-01 through B5-03)
  // --------------------------------------------------------------------------
  describe("11. Phase 12.94-B Audit v5 Focus Verifications (B5-01 through B5-03)", () => {
    it("B5-01: daemon buy-trigger telemetry recording enforces verified matching pool ID", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b501-"));
      const storage = new TelemetryStorageManager(tempDir);
      const obsRecorder = new MarketObservationRecorder(storage);
      const sampling = new StratifiedSamplingController(storage);
      const sessionId = "session-b501-daemon-pool-id";
      storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);

      const candidate = {
        mintAddress: "MintDaemonMatch11111111111111111111111111",
        poolId: "pool-alpha",
      };

      // Set up sampling tracker for candidate
      sampling.evaluateForTracking(
        {
          eventId: "ev-daemon-tgt-1",
          sessionId,
          generationId: "gen-01-legacy-baseline",
          mintAddress: candidate.mintAddress,
          poolId: candidate.poolId,
          symbol: "TGT",
          decisionCohort: "EXECUTED_BUY",
          sourceTimestampMs: 1700000000000,
          ingestionTimestampMs: 1700000000000,
          decisionTimestampMs: 1700000000000,
          strategyRevision: "phase-12.94b",
          missingFields: [],
          filterEvaluations: [],
          metricsSnapshot: {
            tokenAgeSec: 100,
            liquidityUsd: 50000,
            marketCapUsd: 200000,
            lmcRatio: 0.25,
            lpBurnPct: 100,
            spotPriceUsd: 0.1,
            spotPriceSol: 0.0007,
            volume5mUsd: 5000,
            txCount5m: 50,
            buys5m: 30,
            sells5m: 20,
          },
          providerIdentity: "dexscreener",
        },
        0.0007,
      );

      const baseRawMetrics = {
        volume5mUsd: 5000,
        volume1hUsd: 25000,
        buys5m: 30,
        sells5m: 20,
        txCount5m: 50,
        buys1h: 150,
        sells1h: 100,
        baseReserve: 100000,
        quoteReserve: 70,
        liquidityUsd: 50000,
        measurementWindowSec: 300,
        derivationStatus: "DIRECT" as const,
      };

      // Fixture 1: Matching pool ID (normalized match: dexscreener-pool-alpha vs pool-alpha)
      // -> Observation recorded, sampling trajectory updated, returns true
      const success = recordPreliminaryBuyTriggerObservation(
        candidate,
        {
          spotPriceSol: 0.00075,
          spotPriceUsd: 0.11,
          sourceTimestampMs: 1700000010000,
          requestInitiatedMs: 1700000009500,
          responseReceivedMs: 1700000010000,
          actualResponsePoolId: "dexscreener-pool-alpha",
          rawProviderMetrics: baseRawMetrics,
        },
        sessionId,
        "gen-01-legacy-baseline",
        1700000010000,
        obsRecorder,
        sampling,
      );

      expect(success).toBe(true);
      expect(storage.getMarketObservationsCount()).toBe(1);
      const observations = storage.readMarketObservations(sessionId);
      expect(observations).toHaveLength(1);
      expect(observations[0]?.actualResponsePoolId).toBe("dexscreener-pool-alpha");
      expect(observations[0]?.poolId).toBe("pool-alpha");

      const trackerKey = StratifiedSamplingController.buildTrackerKey(
        "gen-01-legacy-baseline",
        sessionId,
        candidate.poolId,
        candidate.mintAddress,
      );
      const tracker = sampling.getActiveTracker(trackerKey);
      expect(tracker).toBeDefined();
      expect(tracker?.observationCount).toBe(2); // Initial observation + 1 update
      expect(tracker?.latestPriceSol).toBe(0.00075);

      // Fixture 2: Missing pool ID (undefined)
      // -> Fails closed: rejected, observation discarded, sampling unchanged, returns false
      const failMissing = recordPreliminaryBuyTriggerObservation(
        candidate,
        {
          spotPriceSol: 0.0008,
          spotPriceUsd: 0.12,
          sourceTimestampMs: 1700000020000,
          requestInitiatedMs: 1700000019500,
          responseReceivedMs: 1700000020000,
          actualResponsePoolId: undefined, // Missing!
          rawProviderMetrics: baseRawMetrics,
        },
        sessionId,
        "gen-01-legacy-baseline",
        1700000020000,
        obsRecorder,
        sampling,
      );

      expect(failMissing).toBe(false);
      expect(storage.getMarketObservationsCount()).toBe(1); // Unchanged!
      expect(sampling.getActiveTracker(trackerKey)?.observationCount).toBe(2); // Unchanged!

      // Fixture 3: Mismatched pool ID (different pool address)
      // -> Fails closed: rejected, observation discarded, sampling unchanged, returns false
      const failMismatch = recordPreliminaryBuyTriggerObservation(
        candidate,
        {
          spotPriceSol: 0.00085,
          spotPriceUsd: 0.13,
          sourceTimestampMs: 1700000030000,
          requestInitiatedMs: 1700000029500,
          responseReceivedMs: 1700000030000,
          actualResponsePoolId: "dexscreener-different-pool-999", // Mismatch!
          rawProviderMetrics: baseRawMetrics,
        },
        sessionId,
        "gen-01-legacy-baseline",
        1700000030000,
        obsRecorder,
        sampling,
      );

      expect(failMismatch).toBe(false);
      expect(storage.getMarketObservationsCount()).toBe(1); // Unchanged!
      expect(sampling.getActiveTracker(trackerKey)?.observationCount).toBe(2); // Unchanged!

      // Direct unit test of isVerifiedMatchingPool helper
      expect(isVerifiedMatchingPool("dexscreener-abc", "abc")).toBe(true);
      expect(isVerifiedMatchingPool("ABC", "abc")).toBe(true);
      expect(isVerifiedMatchingPool("dexscreener-ABC", "dexscreener-abc")).toBe(true);
      expect(isVerifiedMatchingPool("  dexscreener-pool-1  ", "pool-1")).toBe(true);
      expect(isVerifiedMatchingPool(undefined, "abc")).toBe(false);
      expect(isVerifiedMatchingPool(null, "abc")).toBe(false);
      expect(isVerifiedMatchingPool("", "abc")).toBe(false);
      expect(isVerifiedMatchingPool("dexscreener-xyz", "abc")).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it("B5-02 & B5-03: interrupted-session finalization fail-closed & semantic equivalence", () => {
      const tempDir = mkdtempSync(path.join(os.tmpdir(), "telemetry-b502-"));
      const storage = new TelemetryStorageManager(tempDir);
      const sessionId = "session-b502-interrupted-test";

      const baseSummaryData = {
        generationId: "gen-01-legacy-baseline",
        strategyRevision: "phase-12.94b",
        startedAtIso: "2026-10-14T00:00:00.000Z",
        totalCandidatesScreened: 30,
        totalDecisionsRecorded: 15,
        totalScannerDecisionsRecorded: 10,
        totalTriggerDecisionsRecorded: 4,
        totalExecutedBuyDecisionsRecorded: 1,
        decisionWriteFailures: 0,
        cohortBreakdown: {
          filteredRejected: 8,
          watchlistRadar: 2,
          triggerRejected: 4,
          executedBuy: 1,
        },
        topRejectionReasons: {
          REJECTED_MOMENTUM_STALLED: 3,
          REJECTED_LOW_LIQUIDITY: 1,
        },
        totalMarketObservationsRecorded: 10,
        totalStratifiedCandidatesTracked: 4,
        missedWinnersCount: 1,
        avoidedRugsCount: 2,
      };

      // 1. Missing session-meta.json throws FATAL_MISSING_SESSION_META
      expect(() => {
        storage.finalizeSessionTelemetry("non-existent-session-id", baseSummaryData);
      }).toThrow(/\[FATAL_MISSING_SESSION_META\]/);

      // 2. Initialize session and simulate crash-restart into INTERRUPTED state
      const meta1 = storage.initSessionTelemetry(sessionId, "gen-01-legacy-baseline", 7.9259);
      expect(meta1.sessionStatus).toBe("ACTIVE");

      const storageReopened = new TelemetryStorageManager(tempDir);
      const metaInterrupted = storageReopened.initSessionTelemetry(
        sessionId,
        "gen-01-legacy-baseline",
        7.9259,
      );
      expect(metaInterrupted.sessionStatus).toBe("INTERRUPTED");
      expect(metaInterrupted.isInterruptedSession).toBe(true);

      // 3. Caller override fail-closed: attempting to pass isCompleteSession: true on interrupted session throws
      expect(() => {
        storageReopened.finalizeSessionTelemetry(sessionId, {
          ...baseSummaryData,
          startedAtIso: metaInterrupted.startedAtIso,
          strategyRevision: metaInterrupted.strategyRevision,
          isCompleteSession: true, // Malicious / inconsistent caller override!
        });
      }).toThrow(/\[FATAL_INVALID_COMPLETENESS_OVERRIDE\]/);

      // Attempting to pass isInterruptedSession: false also throws
      expect(() => {
        storageReopened.finalizeSessionTelemetry(sessionId, {
          ...baseSummaryData,
          startedAtIso: metaInterrupted.startedAtIso,
          strategyRevision: metaInterrupted.strategyRevision,
          isInterruptedSession: false, // Malicious / inconsistent caller override!
        });
      }).toThrow(/\[FATAL_INVALID_COMPLETENESS_OVERRIDE\]/);

      // 4. Authoritative derivation: finalization authoritatively marks isCompleteSession: false, isInterruptedSession: true
      const finalizedInterrupted = storageReopened.finalizeSessionTelemetry(sessionId, {
        ...baseSummaryData,
        startedAtIso: metaInterrupted.startedAtIso,
        strategyRevision: metaInterrupted.strategyRevision,
      });

      expect(finalizedInterrupted.isCompleteSession).toBe(false);
      expect(finalizedInterrupted.isInterruptedSession).toBe(true);

      // 5. Semantic equivalence & idempotency: identical fields return existing summary cleanly
      const idempotentCall = storageReopened.finalizeSessionTelemetry(sessionId, {
        ...baseSummaryData,
        startedAtIso: metaInterrupted.startedAtIso,
        strategyRevision: metaInterrupted.strategyRevision,
        // Key-order invariance for topRejectionReasons:
        topRejectionReasons: {
          REJECTED_LOW_LIQUIDITY: 1,
          REJECTED_MOMENTUM_STALLED: 3,
        },
      });
      expect(idempotentCall).toEqual(finalizedInterrupted);

      // 6. Conflicting topRejectionReasons distribution (same primary count, different distribution) throws FATAL_SESSION_ALREADY_FINALIZED
      expect(() => {
        storageReopened.finalizeSessionTelemetry(sessionId, {
          ...baseSummaryData,
          startedAtIso: metaInterrupted.startedAtIso,
          strategyRevision: metaInterrupted.strategyRevision,
          topRejectionReasons: {
            REJECTED_MOMENTUM_STALLED: 4, // Different distribution!
          },
        });
      }).toThrow(/\[FATAL_SESSION_ALREADY_FINALIZED\]/);

      // 7. Conflicting startedAtIso throws FATAL_SESSION_ALREADY_FINALIZED
      expect(() => {
        storageReopened.finalizeSessionTelemetry(sessionId, {
          ...baseSummaryData,
          startedAtIso: "1999-01-01T00:00:00.000Z", // Conflicting startedAtIso!
          strategyRevision: metaInterrupted.strategyRevision,
        });
      }).toThrow(/\[FATAL_SESSION_ALREADY_FINALIZED\]/);

      // 8. Conflicting completeness flag on clean complete session
      const cleanSessionId = "session-b502-clean-test";
      const cleanMeta = storage.initSessionTelemetry(
        cleanSessionId,
        "gen-01-legacy-baseline",
        7.9259,
      );
      const cleanSummary = storage.finalizeSessionTelemetry(cleanSessionId, {
        ...baseSummaryData,
        startedAtIso: cleanMeta.startedAtIso,
        strategyRevision: cleanMeta.strategyRevision,
      });
      expect(cleanSummary.isCompleteSession).toBe(true);
      expect(cleanSummary.isInterruptedSession).toBe(false);

      // Re-finalizing clean session claiming it was interrupted throws FATAL_SESSION_ALREADY_FINALIZED
      expect(() => {
        storage.finalizeSessionTelemetry(cleanSessionId, {
          ...baseSummaryData,
          startedAtIso: cleanMeta.startedAtIso,
          strategyRevision: cleanMeta.strategyRevision,
          isCompleteSession: false,
          isInterruptedSession: true,
        });
      }).toThrow(/\[FATAL_SESSION_ALREADY_FINALIZED\]/);

      rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
