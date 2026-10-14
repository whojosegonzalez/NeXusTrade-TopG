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
  repairAndQuarantineDamagedTail,
  resolveStrategyRevision,
  type CandidateDecisionRecord,
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
import { CANDIDATE_SCANNER_DEFAULTS } from "../candidate-scanner/CandidateScannerConfig.js";
import type { ScannedPoolRecord } from "../candidate-scanner/CandidateScannerTypes.js";

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
                  burnPercent: p.lpBurnPct / 100,
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
      expect(rateController.getAvailableTokens()).toBe(1.0);

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
});
