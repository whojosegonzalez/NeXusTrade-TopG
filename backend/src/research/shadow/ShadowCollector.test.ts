/**
 * Phase 12.94-D Milestone D.2.2: Shadow Collector & Offline Mock Harness Tests
 *
 * Implements deterministic offline tests for D22-ACC-01 through D22-ACC-08.
 * Verifies canonical D.1/D.2.1 schema interoperability, path confinement,
 * rate-limit backoff, failure recovery, and zero network/wallet mutations.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
} from "../../telemetry/TelemetryTypes.js";
import {
  DeterministicVirtualClock,
  MockMarketDataProvider,
  MOCK_PROVIDER_BRAND,
  isApprovedMockProvider,
} from "./MockMarketDataProvider.js";
import {
  DeterministicBackoffCalculator,
  validatePathConfinement,
  validateSessionId,
  VirtualTokenBucket,
} from "./ShadowResourceController.js";
import { ShadowCollectorEngine } from "./ShadowCollectorEngine.js";
import type { IMarketDataProvider } from "./ShadowCollectorTypes.js";
import { RESEARCH_HYPOTHESES } from "./ShadowCollectorTypes.js";
import { validateShadowEvaluationEligibility } from "../ShadowEvaluationContract.js";
import { determineSessionStatus } from "../ResearchEligibilityGate.js";

function createMockDecisionFixture(
  overrides?: Partial<CandidateDecisionRecord>,
): CandidateDecisionRecord {
  const decisionTime = overrides?.decisionTimestampMs ?? 1_792_000_000_100;
  const ingestionTime =
    overrides?.ingestionTimestampMs ??
    (overrides?.decisionTimestampMs !== undefined
      ? Math.min(decisionTime, decisionTime - 10)
      : 1_792_000_000_050);
  const sourceTime =
    overrides?.sourceTimestampMs ??
    (overrides?.decisionTimestampMs !== undefined
      ? Math.min(ingestionTime, ingestionTime - 10)
      : 1_792_000_000_000);

  return {
    eventId: overrides?.eventId ?? "dec-mock-1",
    sessionId: overrides?.sessionId ?? "session-shadow-test-1",
    generationId: overrides?.generationId ?? "gen-1",
    mintAddress: overrides?.mintAddress ?? "TokenMint111111111111111111111111111111111111",
    poolId: overrides?.poolId ?? "pool-amm-1",
    symbol: overrides?.symbol ?? "SHD",
    sourceTimestampMs: sourceTime,
    ingestionTimestampMs: ingestionTime,
    decisionTimestampMs: decisionTime,
    strategyRevision: overrides?.strategyRevision ?? "rev-12.94-d22",
    decisionCohort: overrides?.decisionCohort ?? "WATCHLIST_RADAR",
    filterEvaluations: overrides?.filterEvaluations ?? [],
    metricsSnapshot: overrides?.metricsSnapshot ?? {
      tokenAgeSec: 3600,
      liquidityUsd: 50_000,
      marketCapUsd: 150_000,
      lmcRatio: 0.33,
      lpBurnPct: 100,
      spotPriceUsd: 0.001,
      volume5mUsd: 12_000,
      txCount5m: 45,
      buys5m: 35,
      sells5m: 10,
    },
    missingFields: overrides?.missingFields ?? [],
    providerIdentity: overrides?.providerIdentity ?? "mock_offline_market_provider",
  };
}

describe("Phase 12.94-D Milestone D.2.2: Passive Shadow Collector & Offline Mock Harness", () => {
  describe("D22-A01 & D22-ACC-01: Canonical Schema & Output Path Confinement", () => {
    it("D22-TEST-01: strictly rejects forbidden paths resolving into canonical telemetry, sessions, or wallet", () => {
      const repoRoot = process.cwd();

      // Attempt 1: Canonical telemetry sessions dir
      const res1 = validatePathConfinement(path.join(repoRoot, ".tmp", "telemetry", "sessions"));
      expect(res1.isConfinementValid).toBe(false);
      expect(res1.rejectionReason).toContain("PATH_CONFINEMENT_VIOLATION");

      // Attempt 2: Canonical sessions dir
      const res2 = validatePathConfinement(path.join(repoRoot, ".tmp", "sessions"));
      expect(res2.isConfinementValid).toBe(false);

      // Attempt 3: Canonical virtual wallet file
      const res3 = validatePathConfinement(path.join(repoRoot, ".tmp", "virtual-wallet.json"));
      expect(res3.isConfinementValid).toBe(false);

      // Attempt 4: Directory traversal trying to escape into .tmp/telemetry/sessions
      const res4 = validatePathConfinement(
        path.join(repoRoot, "backend", "..", ".tmp", "telemetry", "sessions"),
      );
      expect(res4.isConfinementValid).toBe(false);

      // Valid: Unique temporary fixture directory outside forbidden paths
      const validTemp = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-confinement-test-"));
      const resValid = validatePathConfinement(validTemp);
      expect(resValid.isConfinementValid).toBe(true);
      fs.rmSync(validTemp, { recursive: true, force: true });
    });

    it("D22-TEST-02: verifies Generation 1 wallet invariant remains unchanged at 7.9259 SOL", () => {
      const walletPath = path.resolve(".tmp/virtual-wallet.json");
      expect(fs.existsSync(walletPath)).toBe(true);

      const content = fs.readFileSync(walletPath);
      const hash = crypto.createHash("sha256").update(content).digest("hex").toUpperCase();

      expect(hash).toBe("7F2C2353AC2F62CAC1BB98703742AB19C74AC5521635AF6F49BBE777AD020ED9");
      const parsed = JSON.parse(content.toString("utf8"));
      expect(parsed.currentBalanceSol).toBe(7.9259);
    });

    it("D22-TEST-03: generates canonical session-meta.json and session-summary.json with dual-file consensus", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-schema-test-"));
      const clock = new DeterministicVirtualClock(1_792_000_000_000);
      const provider = new MockMarketDataProvider({ clock });

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-consensus-1",
          generationId: "gen-1",
          strategyRevision: "rev-12.94-d22",
          outputRootDir: fixtureRoot,
        },
        provider,
        clock,
      });

      await engine.start();

      const decision = createMockDecisionFixture({
        sessionId: "session-shadow-consensus-1",
        eventId: "dec-c1",
      });
      engine.ingestCandidateDecision(decision);

      clock.advanceBy(100);
      await engine.evaluateShadowCandidate({ decisionEventId: "dec-c1" });

      const drainSummary = await engine.drain();

      expect(drainSummary.finalStatus).toBe("FINALIZED");
      expect(drainSummary.isCompleteSession).toBe(true);

      const sessionDir = path.join(fixtureRoot, "session-shadow-consensus-1");
      const metaPath = path.join(sessionDir, "session-meta.json");
      const summaryPath = path.join(sessionDir, "session-summary.json");

      expect(fs.existsSync(metaPath)).toBe(true);
      expect(fs.existsSync(summaryPath)).toBe(true);

      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

      // Authoritative Dual-File Consensus Invariants:
      expect(meta.sessionStatus).toBe("FINALIZED");
      expect(meta.isInterruptedSession).toBe(false);
      expect(summary.isCompleteSession).toBe(true);
      expect(summary.isInterruptedSession).toBe(false);

      expect(meta.sessionId).toBe(summary.sessionId);
      expect(meta.generationId).toBe(summary.generationId);
      expect(meta.strategyRevision).toBe(summary.strategyRevision);
      expect(meta.startedAtIso).toBe(summary.startedAtIso);
      expect(meta.closedAtIso).toBe(summary.closedAtIso);

      expect(summary.totalDecisionsRecorded).toBe(1);
      expect(summary.cohortBreakdown.executedBuy).toBe(0); // Zero executed buys in shadow

      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
  });

  describe("D22-A02 & D22-ACC-02: Decision Provenance & 1:N Shadow Evaluation Cardinality", () => {
    it("D22-TEST-04: rejects orphan candidate decisions not registered in session fail-closed", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-orphan-test-"));
      const clock = new DeterministicVirtualClock();
      const provider = new MockMarketDataProvider({ clock });

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-orphan-1",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          outputRootDir: fixtureRoot,
        },
        provider,
        clock,
      });

      await engine.start();

      // Attempt to evaluate shadow candidate without ingesting decision first
      await expect(
        engine.evaluateShadowCandidate({ decisionEventId: "nonexistent-decision-id" }),
      ).rejects.toThrow("ORPHAN_DECISION_QUARANTINED");

      await engine.drain();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it("D22-TEST-05: supports 1:N shadow evaluations per decision across different time horizons with unique IDs", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-cardinality-test-"));
      const clock = new DeterministicVirtualClock(1_792_000_000_000);
      const provider = new MockMarketDataProvider({ clock });

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-cardinality-1",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          outputRootDir: fixtureRoot,
        },
        provider,
        clock,
      });

      await engine.start();

      const decision = createMockDecisionFixture({
        sessionId: "session-shadow-cardinality-1",
        eventId: "dec-multi-eval-1",
        decisionTimestampMs: 1_792_000_000_100,
      });
      engine.ingestCandidateDecision(decision);

      // Evaluation 1: At decision time (t)
      clock.advanceBy(100);
      const eval1 = await engine.evaluateShadowCandidate({
        decisionEventId: "dec-multi-eval-1",
        evaluationTimestampMs: 1_792_000_000_100,
      });

      // Evaluation 2: 10 seconds later (t + 10s)
      clock.advanceBy(10_000);
      const eval2 = await engine.evaluateShadowCandidate({
        decisionEventId: "dec-multi-eval-1",
        evaluationTimestampMs: 1_792_000_010_100,
      });

      // Evaluation 3: 30 seconds later (t + 30s)
      clock.advanceBy(20_000);
      const eval3 = await engine.evaluateShadowCandidate({
        decisionEventId: "dec-multi-eval-1",
        evaluationTimestampMs: 1_792_000_030_100,
      });

      expect(eval1.evaluationId).not.toBe(eval2.evaluationId);
      expect(eval2.evaluationId).not.toBe(eval3.evaluationId);

      // All 3 bind to identical composite foreign-key tuple
      for (const ev of [eval1, eval2, eval3]) {
        expect(ev.decisionEventId).toBe("dec-multi-eval-1");
        expect(ev.sessionId).toBe("session-shadow-cardinality-1");
        expect(ev.generationId).toBe("gen-1");
        expect(ev.mintAddress).toBe(decision.mintAddress);
        expect(ev.poolId).toBe(decision.poolId);
      }

      // Conflict rejection: Attempting duplicate evaluation at identical evaluationTimestampMs throws fail-closed
      await expect(
        engine.evaluateShadowCandidate({
          decisionEventId: "dec-multi-eval-1",
          evaluationTimestampMs: 1_792_000_010_100, // Same as eval2
        }),
      ).rejects.toThrow("DUPLICATE_EVALUATION_ID");

      await engine.drain();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
  });

  describe("D22-A03 & D22-ACC-03: Causal Event Chronology & Multi-Track Isolation", () => {
    it("D22-TEST-06: rejects evaluation timestamp preceding decision timestamp fail-closed", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-chrono-test-"));
      const clock = new DeterministicVirtualClock(1_792_000_000_000);
      const provider = new MockMarketDataProvider({ clock });

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-chrono-1",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          outputRootDir: fixtureRoot,
        },
        provider,
        clock,
      });

      await engine.start();

      const decision = createMockDecisionFixture({
        sessionId: "session-shadow-chrono-1",
        eventId: "dec-chrono-1",
        decisionTimestampMs: 1_792_000_005_000,
      });
      engine.ingestCandidateDecision(decision);

      // Attempt evaluation at 1_792_000_001_000 (< 1_792_000_005_000)
      await expect(
        engine.evaluateShadowCandidate({
          decisionEventId: "dec-chrono-1",
          evaluationTimestampMs: 1_792_000_001_000,
        }),
      ).rejects.toThrow("EVALUATION_PRECEDES_DECISION");

      await engine.drain();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it("D22-TEST-07: records post-decision observations separately without retroactive lookahead", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-forward-obs-"));
      const clock = new DeterministicVirtualClock(1_792_000_000_000);
      const provider = new MockMarketDataProvider({ clock });

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-fwd-1",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          outputRootDir: fixtureRoot,
        },
        provider,
        clock,
      });

      await engine.start();

      const decision = createMockDecisionFixture({
        sessionId: "session-shadow-fwd-1",
        eventId: "dec-fwd-1",
        decisionTimestampMs: 1_792_000_000_000,
      });
      engine.ingestCandidateDecision(decision);

      // Forward outcome observation 60 seconds later
      clock.advanceBy(60_000);
      const forwardObs: MarketObservationRecord = {
        observationId: "obs-forward-1",
        sessionId: "session-shadow-fwd-1",
        generationId: "gen-1",
        mintAddress: decision.mintAddress,
        poolId: decision.poolId,
        sourceTimestampMs: 1_792_000_060_000,
        ingestionTimestampMs: 1_792_000_060_010,
        responseReceivedMs: 1_792_000_060_020,
        strategyRevision: "rev-1",
        dataFreshnessMs: 20,
        missingFields: [],
        measurementWindow: {
          windowStartMs: 1_792_000_000_000,
          windowEndMs: 1_792_000_060_000,
          durationSec: 60,
        },
        providerIdentity: "mock_offline_market_provider",
        priceMetrics: {
          spotPriceUsd: 0.0015,
          spotPriceSol: 0.00001,
          priceSource: "POOL_RESERVE",
        },
        liquidityMetrics: {
          baseReserve: 950_000,
          quoteReserve: 55,
          liquidityUsd: 55_000,
        },
        flowMetrics: {
          txCount: 60,
          buys: 40,
          sells: 20,
          volumeUsd: 15_000,
          netBuyerVolumeUsd: 5_000,
        },
      };

      engine.recordForwardObservation(forwardObs);
      const drainSummary = await engine.drain();

      expect(drainSummary.flushedObservationsCount).toBe(1);

      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
  });

  describe("D22-A04 & D22-ACC-04: Hypothesis Mapping & Provider Provenance Tagging", () => {
    it("D22-TEST-08: preserves accepted hypothesis mapping H1-H4", () => {
      expect(RESEARCH_HYPOTHESES.H1).toBe("Liquidity depth and AMM price impact");
      expect(RESEARCH_HYPOTHESES.H2).toBe("Order-flow momentum and buyer dominance");
      expect(RESEARCH_HYPOTHESES.H3).toBe("Structural safety and developer holdings");
      expect(RESEARCH_HYPOTHESES.H4).toBe("Capacity-aware position sizing");
    });

    it("D22-TEST-09: marks unverified developer authority and omitted fields as UNAVAILABLE", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-provenance-test-"));
      const clock = new DeterministicVirtualClock();
      const provider = new MockMarketDataProvider({ clock });

      // Simulate omitted reserves and unverified authority
      provider.setOmittedFields(["baseReserve"]);
      provider.setUnknownDevAuthorityOverride(true);

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-prov-1",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          outputRootDir: fixtureRoot,
        },
        provider,
        clock,
      });

      await engine.start();

      const decision = createMockDecisionFixture({
        sessionId: "session-shadow-prov-1",
        eventId: "dec-prov-1",
      });
      engine.ingestCandidateDecision(decision);

      clock.advanceBy(100);
      const evaluation = await engine.evaluateShadowCandidate({
        decisionEventId: "dec-prov-1",
      });

      // Because baseReserve was omitted (null), executionFeasible MUST be false
      expect(evaluation.qualificationResult.executionFeasible).toBe(false);
      expect(evaluation.qualificationResult.unavailabilityReason).toBe(
        "RESERVE_QUANTITY_ZERO_OR_NONFINITE",
      );
      expect(evaluation.observedReserveSnapshot).toBeUndefined();

      await engine.drain();
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
  });

  describe("D22-A05 & D22-ACC-05: Non-Networking & Static Import Verification", () => {
    it("D22-TEST-10: verifies zero prohibited network packages in shadow collector module sources", () => {
      const shadowDir = path.resolve("backend/src/research/shadow");
      const files = fs.readdirSync(shadowDir).filter((f) => f.endsWith(".ts"));

      const prohibitedImports = [
        "node:http",
        "node:https",
        "node:net",
        "node:dgram",
        "node:child_process",
        "http",
        "https",
        "node-fetch",
        "axios",
        "ws",
        "child_process",
      ];

      for (const file of files) {
        const fullPath = path.join(shadowDir, file);
        const content = fs.readFileSync(fullPath, "utf8");

        for (const prohibited of prohibitedImports) {
          const importPattern = new RegExp(`from\\s+['"]${prohibited}['"]`, "i");
          const requirePattern = new RegExp(`require\\(['"]${prohibited}['"]\\)`, "i");

          expect(importPattern.test(content)).toBe(false);
          expect(requirePattern.test(content)).toBe(false);
        }
      }
    });
  });

  describe("D22-A06 & D22-ACC-06: Virtual-Time Rate Limiter & Resource Quota Controls", () => {
    it("D22-TEST-11: enforces token bucket rate limiter and backoff in virtual time", () => {
      const clock = new DeterministicVirtualClock(1_792_000_000_000);
      const bucket = new VirtualTokenBucket({
        maxTokens: 5,
        refillRatePerSecond: 1, // 1 token per second
        clock,
      });

      // Consume initial 5 burst tokens
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);

      // 6th request fails (exhausted)
      expect(bucket.tryConsume(1)).toBe(false);

      // Advance virtual clock by 2.5 seconds -> refills 2 tokens
      clock.advanceBy(2500);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(true);
      expect(bucket.tryConsume(1)).toBe(false);

      // Deterministic backoff calculator
      const backoff = new DeterministicBackoffCalculator({
        baseMs: 500,
        maxMs: 5000,
        maxAttempts: 4,
      });
      expect(backoff.computeBackoffMs(0)).toBe(500);
      expect(backoff.computeBackoffMs(1)).toBeGreaterThanOrEqual(1000);
      expect(backoff.computeBackoffMs(2)).toBeGreaterThanOrEqual(2000);
      expect(backoff.computeBackoffMs(4)).toBe(-1); // Exhausted
    });

    it("D22-TEST-12: trips storage quota limit and aborts session with INTERRUPTED status", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-quota-test-"));
      const clock = new DeterministicVirtualClock();
      const provider = new MockMarketDataProvider({ clock });

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-quota-1",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          outputRootDir: fixtureRoot,
          maxSessionDiskBytes: 1500, // Quota allows initial decision but trips on evaluation write
        },
        provider,
        clock,
      });

      await engine.start();

      const decision = createMockDecisionFixture({
        sessionId: "session-shadow-quota-1",
        eventId: "dec-quota-1",
      });

      // Write decision (takes ~300 bytes)
      engine.ingestCandidateDecision(decision);

      // Evaluate shadow candidate: next write will exceed 500 bytes and trip quota
      clock.advanceBy(100);
      await expect(
        engine.evaluateShadowCandidate({ decisionEventId: "dec-quota-1" }),
      ).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");

      expect(engine.state).toBe("TERMINATED");

      const metaPath = path.join(fixtureRoot, "session-shadow-quota-1", "session-meta.json");
      const summaryPath = path.join(fixtureRoot, "session-shadow-quota-1", "session-summary.json");

      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));

      expect(meta.sessionStatus).toBe("INTERRUPTED");
      expect(meta.isInterruptedSession).toBe(true);
      expect(summary.isCompleteSession).toBe(false);
      expect(summary.isInterruptedSession).toBe(true);

      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it("D22-TEST-13: emergency kill switch aborts engine and recovers torn JSONL lines on restart", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-crash-test-"));
      const clock = new DeterministicVirtualClock();
      const provider = new MockMarketDataProvider({ clock });
      const killSwitchPath = path.join(fixtureRoot, "TRIGGER_KILL_SWITCH");

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-crash-1",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          outputRootDir: fixtureRoot,
          killSwitchPath,
        },
        provider,
        clock,
      });

      await engine.start();

      const decision = createMockDecisionFixture({
        sessionId: "session-shadow-crash-1",
        eventId: "dec-crash-1",
      });
      engine.ingestCandidateDecision(decision);

      // Trigger kill switch file
      fs.writeFileSync(killSwitchPath, "HALT");

      clock.advanceBy(100);
      await expect(
        engine.evaluateShadowCandidate({ decisionEventId: "dec-crash-1" }),
      ).rejects.toThrow("KILL_SWITCH_TRIGGERED");

      expect(engine.state).toBe("TERMINATED");

      // Simulate a torn JSON line caused by hard crash in candidate-decisions.jsonl
      const decisionsPath = path.join(
        fixtureRoot,
        "session-shadow-crash-1",
        "candidate-decisions.jsonl",
      );
      fs.appendFileSync(decisionsPath, '{"eventId":"dec-torn-incomplete', "utf8");

      // Execute crash recovery
      const sessionDir = path.join(fixtureRoot, "session-shadow-crash-1");
      const recovery = ShadowCollectorEngine.recoverSessionDirectory(sessionDir);

      expect(recovery.recoveredStatus).toBe("INTERRUPTED");
      expect(recovery.validDecisionsCount).toBe(1);
      expect(recovery.tornLinesQuarantinedCount).toBe(1);
      expect(recovery.diagnosticsFileWritten).toBe(true);

      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
  });

  describe("D22-A07 & D22-ACC-07: Execution Tiers & No-Alpha Mock Invariant", () => {
    it("D22-TEST-14: confirms mock shadow collector generates zero simulated fills or wallet mutations", async () => {
      const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-tier-test-"));
      const clock = new DeterministicVirtualClock();
      const provider = new MockMarketDataProvider({ clock });

      const engine = new ShadowCollectorEngine({
        config: {
          sessionId: "session-shadow-tier-1",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          outputRootDir: fixtureRoot,
        },
        provider,
        clock,
      });

      await engine.start();

      const decision = createMockDecisionFixture({
        sessionId: "session-shadow-tier-1",
        eventId: "dec-tier-1",
      });
      engine.ingestCandidateDecision(decision);

      clock.advanceBy(100);
      const evalRecord = await engine.evaluateShadowCandidate({ decisionEventId: "dec-tier-1" });

      // Verifies executionFeasible remains purely a model signal qualification, not a filled transaction
      expect(evalRecord.qualificationResult.executionFeasible).toBe(true);
      expect(evalRecord.qualificationResult.simulatedTargetSizeSol).toBe(0.1);

      await engine.drain();

      const sessionDir = path.join(fixtureRoot, "session-shadow-tier-1");

      // Invariant: Zero simulated fills or executable quote streams are created by shadow collector
      expect(fs.existsSync(path.join(sessionDir, "execution-quotes.jsonl"))).toBe(false);
      expect(fs.existsSync(path.join(sessionDir, "simulated-fills.jsonl"))).toBe(false);

      // Invariant: Generation 1 wallet unchanged
      const walletContent = fs.readFileSync(path.resolve(".tmp/virtual-wallet.json"), "utf8");
      expect(JSON.parse(walletContent).currentBalanceSol).toBe(7.9259);

      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    });
  });

  describe("Phase 12.94-D.2.2 Source Audit v1 Regression Suites (D22-S01 through D22-S05)", () => {
    describe("D22-S01: Output Confinement & Session ID Sanitization", () => {
      it("D22-TEST-15: enforces strict session ID sanitization, allowedRoot boundary, and symlink child rejection", () => {
        // Session ID validation matrix
        const invalidSessionIds = [
          "../outside-fixtures",
          "../../root-escape",
          "session/nested",
          "session\\windows",
          "session:colon",
          "session\0nullbyte",
          "",
          "   ",
          "a".repeat(101),
          "session*glob",
          "session?char",
          "session<pipe>",
        ];

        for (const badId of invalidSessionIds) {
          const res = validateSessionId(badId);
          expect(res.isValid).toBe(false);
          expect(res.rejectionReason).toBeDefined();

          // Constructor must throw when given invalid sessionId
          const clock = new DeterministicVirtualClock();
          const provider = new MockMarketDataProvider({ clock });
          expect(() => {
            new ShadowCollectorEngine({
              config: {
                sessionId: badId,
                generationId: "gen-1",
                strategyRevision: "rev-1",
                outputRootDir: os.tmpdir(),
              },
              provider,
              clock,
            });
          }).toThrow("[INVALID_SESSION_ID]");
        }

        const validSessionIds = [
          "session-shadow-test-1",
          "session_2026-10-15.run_01",
          "SHADOW-EXP-42",
          "abc-123_DEF",
        ];

        for (const goodId of validSessionIds) {
          const res = validateSessionId(goodId);
          expect(res.isValid).toBe(true);
          expect(res.sanitizedSessionId).toBe(goodId);
        }

        // allowedRoot confinement enforcement
        const disposableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-allowed-root-"));
        const targetInside = path.join(disposableRoot, "safe-session");
        const resInside = validatePathConfinement(targetInside, {
          repoRootDir: process.cwd(),
          allowedRoot: disposableRoot,
        });
        expect(resInside.isConfinementValid).toBe(true);

        const targetOutside = path.join(os.tmpdir(), "forbidden-escape-dir");
        const resOutside = validatePathConfinement(targetOutside, {
          repoRootDir: process.cwd(),
          allowedRoot: disposableRoot,
        });
        expect(resOutside.isConfinementValid).toBe(false);
        expect(resOutside.rejectionReason).toContain("PATH_CONFINEMENT_VIOLATION");

        // Uncreated child of symlink to forbidden path
        const linkParentDir = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-symlink-test-"));
        const linkPath = path.join(linkParentDir, "link-to-protected");
        const protectedDir = path.resolve(".tmp/telemetry/sessions");

        try {
          fs.symlinkSync(protectedDir, linkPath, "dir");
          // Target is an uncreated child of the symlink pointing to forbidden telemetry
          const uncreatedChild = path.join(linkPath, "uncreated-subsession");
          const resLink = validatePathConfinement(uncreatedChild, {
            repoRootDir: process.cwd(),
          });
          expect(resLink.isConfinementValid).toBe(false);
          expect(resLink.rejectionReason).toContain("PATH_CONFINEMENT_VIOLATION");
        } catch {
          // If Windows filesystem permissions restrict symlink creation without elevated privilege,
          // verify that validatePathConfinement resolves non-existent deep paths safely.
          const resDeep = validatePathConfinement(
            path.join(protectedDir, "uncreated-subsession-direct"),
            { repoRootDir: process.cwd() },
          );
          expect(resDeep.isConfinementValid).toBe(false);
        } finally {
          fs.rmSync(linkParentDir, { recursive: true, force: true });
          fs.rmSync(disposableRoot, { recursive: true, force: true });
        }
      });
    });

    describe("D22-S02: Mock-Only Provider Boundary", () => {
      it("D22-TEST-16: rejects unapproved or simulated live market data providers at runtime", () => {
        const clock = new DeterministicVirtualClock();
        const validMock = new MockMarketDataProvider({ clock });
        expect(isApprovedMockProvider(validMock)).toBe(true);

        // Attempt 1: Custom provider with arbitrary providerId and empirically verified status
        const customProvider = {
          providerId: "not-a-mock-provider",
          capabilityStatus: "EMPIRICALLY_VERIFIED",
          getPoolReserves: async () => ({
            poolId: "p1",
            baseReserve: 100,
            quoteReserve: 10,
            sourceTimestampMs: clock.now(),
            ingestionTimestampMs: clock.now(),
            responseReceivedMs: clock.now(),
          }),
          getMetrics: async () => ({
            mintAddress: "m1",
            volume5mUsd: 1000,
            buys5m: 10,
            sells5m: 5,
          }),
          getHoldings: async () => ({
            mintAddress: "m1",
            devHoldingPct: 2,
            hasUnverifiedDevAuthority: false,
          }),
        };

        expect(isApprovedMockProvider(customProvider)).toBe(false);

        expect(() => {
          new ShadowCollectorEngine({
            config: {
              sessionId: "session-unapproved-provider",
              generationId: "gen-1",
              strategyRevision: "rev-1",
              outputRootDir: os.tmpdir(),
            },
            provider: customProvider as unknown as IMarketDataProvider,
            clock,
          });
        }).toThrow("[PROHIBITED_LIVE_PROVIDER_ATTEMPT]");

        // Attempt 2: Object with forged brand
        const forgedBrandProvider = {
          ...customProvider,
          [MOCK_PROVIDER_BRAND]: "FORGED_BRAND_STRING",
        };
        expect(isApprovedMockProvider(forgedBrandProvider)).toBe(false);

        // Attempt 3: Valid mock provider is accepted
        const engine = new ShadowCollectorEngine({
          config: {
            sessionId: "session-approved-provider",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            outputRootDir: os.tmpdir(),
          },
          provider: validMock,
          clock,
        });
        expect(engine).toBeDefined();
      });
    });

    describe("D22-S03: Verified Pool & Causal Reserve Provenance", () => {
      it("D22-TEST-17: rejects mismatched pool, unverified pool, invalid vaults, and future reserves", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-s03-test-"));
        const clock = new DeterministicVirtualClock(1_792_000_000_000);
        const provider = new MockMarketDataProvider({ clock });

        const engine = new ShadowCollectorEngine({
          config: {
            sessionId: "session-shadow-s03",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            outputRootDir: fixtureRoot,
          },
          provider,
          clock,
        });

        await engine.start();

        const decision = createMockDecisionFixture({
          sessionId: "session-shadow-s03",
          eventId: "dec-s03-1",
          poolId: "pool-amm-correct",
          decisionTimestampMs: 1_792_000_000_000,
        });
        engine.ingestCandidateDecision(decision);

        // 1. Pool mismatch override
        provider.setPoolMismatchOverride("pool-amm-mismatched");
        const evalMismatch = await engine.evaluateShadowCandidate({
          decisionEventId: "dec-s03-1",
          evaluationTimestampMs: 1_792_000_000_000,
        });
        expect(evalMismatch.qualificationResult.executionFeasible).toBe(false);
        expect(evalMismatch.qualificationResult.unavailabilityReason).toBe(
          "POOL_IDENTITY_MISMATCH_DISCARDED",
        );
        expect(evalMismatch.observedReserveSnapshot).toBeUndefined();

        // 2. Unverified pool override
        provider.setPoolMismatchOverride(undefined);
        provider.setVerifiedPoolOverride(false);
        clock.advanceBy(1_000);
        const evalUnverified = await engine.evaluateShadowCandidate({
          decisionEventId: "dec-s03-1",
          evaluationTimestampMs: 1_792_000_001_000,
        });
        expect(evalUnverified.qualificationResult.executionFeasible).toBe(false);
        expect(evalUnverified.qualificationResult.unavailabilityReason).toBe(
          "POOL_IDENTITY_MISMATCH_DISCARDED",
        );
        expect(evalUnverified.observedReserveSnapshot).toBeUndefined();

        // 3. Invalid / missing vaults
        provider.setVerifiedPoolOverride(true);
        provider.setVaultOverride("", "vault-quote-only");
        clock.advanceBy(1_000);
        const evalBadVaults = await engine.evaluateShadowCandidate({
          decisionEventId: "dec-s03-1",
          evaluationTimestampMs: 1_792_000_002_000,
        });
        expect(evalBadVaults.qualificationResult.executionFeasible).toBe(false);
        expect(evalBadVaults.qualificationResult.unavailabilityReason).toBe(
          "POOL_IDENTITY_MISMATCH_DISCARDED",
        );
        expect(evalBadVaults.observedReserveSnapshot).toBeUndefined();

        // 4. Future reserves lookahead (sourceTimestampMs > decisionTimestampMs)
        provider.setVaultOverride(undefined, undefined);
        provider.setReservesResponse("pool-amm-correct", {
          poolId: "pool-amm-correct",
          baseReserve: 1_000_000,
          quoteReserve: 50,
          sourceTimestampMs: 1_792_000_060_000, // 60s in the future of decision
          ingestionTimestampMs: 1_792_000_060_010,
          responseReceivedMs: 1_792_000_060_020,
          isVerifiedPool: true,
          vaultA: "vault-base-valid",
          vaultB: "vault-quote-valid",
        });

        clock.advanceBy(60_000);
        const evalFuture = await engine.evaluateShadowCandidate({
          decisionEventId: "dec-s03-1",
          evaluationTimestampMs: 1_792_000_060_000,
        });
        expect(evalFuture.qualificationResult.executionFeasible).toBe(false);
        expect(evalFuture.qualificationResult.unavailabilityReason).toBe(
          "LATE_RECEIPT_LOOKAHEAD_PREVENTION",
        );
        expect(evalFuture.observedReserveSnapshot).toBeUndefined();

        // Parity with D.2.1 validateShadowEvaluationEligibility:
        // Even if an adversary manually constructed a record claiming executionFeasible with future reserves,
        // D.2.1 gate must reject it fail-closed
        const adversarialRecord = {
          ...evalFuture,
          qualificationResult: {
            ...evalFuture.qualificationResult,
            executionFeasible: true,
          },
          observedReserveSnapshot: {
            baseReserve: 1_000_000,
            quoteReserve: 50,
            sourceTimestampMs: 1_792_000_060_000,
          },
        };
        const d21Eligibility = validateShadowEvaluationEligibility(adversarialRecord, decision);
        expect(d21Eligibility.isEligible).toBe(false);
        expect(d21Eligibility.executionFeasible).toBe(false);
        expect(
          d21Eligibility.rejectionReasons.some((r) =>
            r.includes("FUTURE_RESERVE_SNAPSHOT_DECISION"),
          ),
        ).toBe(true);

        // 5. Valid contemporaneous reserves pass execution feasibility
        provider.setReservesResponse("pool-amm-correct", {
          poolId: "pool-amm-correct",
          baseReserve: 1_000_000,
          quoteReserve: 50,
          sourceTimestampMs: 1_791_999_999_950,
          ingestionTimestampMs: 1_791_999_999_980,
          responseReceivedMs: 1_792_000_000_000, // Exact decision time
          isVerifiedPool: true,
          vaultA: "vault-base-valid",
          vaultB: "vault-quote-valid",
        });

        clock.advanceBy(1_000);
        const evalValid = await engine.evaluateShadowCandidate({
          decisionEventId: "dec-s03-1",
          evaluationTimestampMs: clock.now(),
        });
        expect(evalValid.qualificationResult.executionFeasible).toBe(true);
        expect(evalValid.observedReserveSnapshot).toBeDefined();
        expect(evalValid.observedReserveSnapshot?.baseReserve).toBe(1_000_000);
        expect(evalValid.observedReserveSnapshot?.quoteReserve).toBe(50);

        await engine.drain();
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });
    });

    describe("D22-S04: Durable Session Finality & Attribution", () => {
      it("D22-TEST-18: rejects duplicate decisions before append, enforces observation attribution, blocks post-drain writes, and reconciles line counts", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-s04-test-"));
        const clock = new DeterministicVirtualClock(1_792_000_000_000);
        const provider = new MockMarketDataProvider({ clock });

        const engine = new ShadowCollectorEngine({
          config: {
            sessionId: "session-shadow-s04",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            outputRootDir: fixtureRoot,
          },
          provider,
          clock,
        });

        await engine.start();

        const decision = createMockDecisionFixture({
          sessionId: "session-shadow-s04",
          eventId: "dec-s04-unique",
          decisionTimestampMs: 1_792_000_000_000,
        });
        engine.ingestCandidateDecision(decision);

        // Subtest 1: Duplicate decision eventId must be rejected BEFORE write
        expect(() => {
          engine.ingestCandidateDecision(decision);
        }).toThrow("[DUPLICATE_DECISION_ID]");

        const decisionsFile = path.join(
          fixtureRoot,
          "session-shadow-s04",
          "candidate-decisions.jsonl",
        );
        const decisionLines = fs.readFileSync(decisionsFile, "utf8").trim().split("\n");
        expect(decisionLines.length).toBe(1);

        // Subtest 2: Foreign observation attribution checks
        const baseObs: MarketObservationRecord = {
          observationId: "obs-s04-1",
          sessionId: "session-shadow-s04",
          generationId: "gen-1",
          mintAddress: decision.mintAddress,
          poolId: decision.poolId,
          sourceTimestampMs: 1_792_000_005_000,
          ingestionTimestampMs: 1_792_000_005_010,
          responseReceivedMs: 1_792_000_005_020,
          strategyRevision: "rev-1",
          dataFreshnessMs: 20,
          missingFields: [],
          measurementWindow: {
            windowStartMs: 1_792_000_000_000,
            windowEndMs: 1_792_000_005_000,
            durationSec: 5,
          },
          providerIdentity: "mock_offline_market_provider",
          priceMetrics: {
            spotPriceUsd: 0.001,
            spotPriceSol: 0.00001,
            priceSource: "POOL_RESERVE",
          },
          liquidityMetrics: {
            baseReserve: 1_000_000,
            quoteReserve: 50,
            liquidityUsd: 50_000,
          },
          flowMetrics: {
            txCount: 10,
            buys: 6,
            sells: 4,
            volumeUsd: 2000,
            netBuyerVolumeUsd: 500,
          },
        };

        // Mismatched sessionId
        expect(() => {
          engine.recordForwardObservation({ ...baseObs, sessionId: "foreign-session-id" });
        }).toThrow("[FOREIGN_OBSERVATION_ATTRIBUTION]");

        // Mismatched generationId
        expect(() => {
          engine.recordForwardObservation({ ...baseObs, generationId: "gen-foreign" });
        }).toThrow("[FOREIGN_OBSERVATION_ATTRIBUTION]");

        // Mismatched mintAddress
        expect(() => {
          engine.recordForwardObservation({
            ...baseObs,
            mintAddress: "ForeignMint1111111111111111111111111111111",
          });
        }).toThrow("[FOREIGN_OBSERVATION_ATTRIBUTION]");

        // Mismatched poolId
        expect(() => {
          engine.recordForwardObservation({ ...baseObs, poolId: "foreign-pool-amm" });
        }).toThrow("[FOREIGN_OBSERVATION_ATTRIBUTION]");

        // Temporal violation: observation precedes decision
        expect(() => {
          engine.recordForwardObservation({ ...baseObs, sourceTimestampMs: 1_791_999_999_000 });
        }).toThrow("[OBSERVATION_PRECEDES_DECISION]");

        // Valid forward observation records cleanly
        engine.recordForwardObservation(baseObs);

        // Subtest 3: Evaluate candidate and drain
        clock.advanceBy(100);
        await engine.evaluateShadowCandidate({ decisionEventId: "dec-s04-unique" });

        const drainSummary = await engine.drain();
        expect(drainSummary.finalStatus).toBe("FINALIZED");
        expect(drainSummary.isCompleteSession).toBe(true);

        // Subtest 4: Post-drain write attempts fail closed
        expect(() => {
          engine.ingestCandidateDecision(createMockDecisionFixture({ eventId: "dec-late" }));
        }).toThrow("Operation invalid in current state 'STOPPED'");

        await expect(
          engine.evaluateShadowCandidate({ decisionEventId: "dec-s04-unique" }),
        ).rejects.toThrow("Operation invalid in current state 'STOPPED'");

        // Subtest 5: Interoperability with accepted D.1 research reader contract
        const sessionDir = path.join(fixtureRoot, "session-shadow-s04");
        const meta = JSON.parse(
          fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf8"),
        ) as SessionTelemetryMeta;
        const summary = JSON.parse(
          fs.readFileSync(path.join(sessionDir, "session-summary.json"), "utf8"),
        ) as SessionTelemetrySummary;

        const resolvedStatus = determineSessionStatus(meta, summary);
        expect(resolvedStatus).toBe("FINALIZED");
        expect(summary.totalDecisionsRecorded).toBe(1);
        expect(summary.totalMarketObservationsRecorded).toBe(1);

        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });
    });

    describe("D22-S05: Effective Recovery & Hard Quota Enforcement", () => {
      it("D22-TEST-19: enforces 1-byte quota admission preflight, repairs torn tails with quarantine, and handles 429 backoff", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-s05-test-"));
        const clock = new DeterministicVirtualClock(1_792_000_000_000);
        const provider = new MockMarketDataProvider({ clock });

        // Subtest 1: 1-byte hard quota trips on start() preflight
        const tinyEngine = new ShadowCollectorEngine({
          config: {
            sessionId: "session-tiny-quota",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            outputRootDir: fixtureRoot,
            maxSessionDiskBytes: 1, // 1 byte hard quota
          },
          provider,
          clock,
        });

        await expect(tinyEngine.start()).rejects.toThrow("STORAGE_QUOTA_EXCEEDED");
        expect(tinyEngine.state).toBe("TERMINATED");

        // Subtest 2: Virtual-time HTTP 429 retry and backoff
        const retryEngine = new ShadowCollectorEngine({
          config: {
            sessionId: "session-retry-test",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            outputRootDir: fixtureRoot,
          },
          provider,
          clock,
        });

        await retryEngine.start();
        const decision = createMockDecisionFixture({
          sessionId: "session-retry-test",
          eventId: "dec-retry-1",
          poolId: "pool-retry-amm",
          decisionTimestampMs: 1_792_000_000_000,
        });
        retryEngine.ingestCandidateDecision(decision);

        provider.setReservesResponse("pool-retry-amm", {
          poolId: "pool-retry-amm",
          baseReserve: 1_000_000,
          quoteReserve: 50,
          sourceTimestampMs: 1_791_999_999_900,
          ingestionTimestampMs: 1_791_999_999_950,
          responseReceivedMs: 1_792_000_000_000,
          isVerifiedPool: true,
          vaultA: "vault-a",
          vaultB: "vault-b",
        });

        // Inject 1 rate limit (429) on reserves endpoint
        provider.simulateRateLimit429("reserves", 1);
        const startVirtualMs = clock.now();
        const evalWithRetry = await retryEngine.evaluateShadowCandidate({
          decisionEventId: "dec-retry-1",
        });

        expect(evalWithRetry.qualificationResult.executionFeasible).toBe(true);
        expect(clock.now()).toBeGreaterThan(startVirtualMs); // Virtual clock advanced due to backoff
        await retryEngine.drain();

        // Subtest 3: Crash recovery repairs torn tail, stages corrupt copy, and updates metadata to INTERRUPTED
        const crashDir = path.join(fixtureRoot, "session-retry-test");
        const decisionsPath = path.join(crashDir, "candidate-decisions.jsonl");

        // Intentionally append a torn partial JSON line representing a mid-write crash
        fs.appendFileSync(decisionsPath, '{"eventId":"dec-torn-fragment', "utf8");

        const recovery = ShadowCollectorEngine.recoverSessionDirectory(crashDir);
        expect(recovery.recoveredStatus).toBe("INTERRUPTED");
        expect(recovery.tornLinesQuarantinedCount).toBe(1);
        expect(recovery.validDecisionsCount).toBe(1);
        expect(recovery.repairedFiles).toContain("candidate-decisions.jsonl");
        expect(recovery.quarantinedFiles.length).toBeGreaterThan(0);

        // Active file is clean
        const activeLines = fs.readFileSync(decisionsPath, "utf8").trim().split("\n");
        expect(activeLines.length).toBe(1);
        expect(() => JSON.parse(activeLines[0]!)).not.toThrow();

        // Quarantined file exists and contains the damaged fragment
        const quarantinedFile = path.join(crashDir, recovery.quarantinedFiles[0]!);
        expect(fs.existsSync(quarantinedFile)).toBe(true);
        const corruptContent = fs.readFileSync(quarantinedFile, "utf8");
        expect(corruptContent).toContain('{"eventId":"dec-torn-fragment');

        // On-disk session-meta.json and session-summary.json both updated to INTERRUPTED
        const metaAfterRecovery = JSON.parse(
          fs.readFileSync(path.join(crashDir, "session-meta.json"), "utf8"),
        ) as SessionTelemetryMeta;
        const summaryAfterRecovery = JSON.parse(
          fs.readFileSync(path.join(crashDir, "session-summary.json"), "utf8"),
        ) as SessionTelemetrySummary;

        expect(metaAfterRecovery.sessionStatus).toBe("INTERRUPTED");
        expect(metaAfterRecovery.isInterruptedSession).toBe(true);
        expect(summaryAfterRecovery.isCompleteSession).toBe(false);
        expect(summaryAfterRecovery.isInterruptedSession).toBe(true);
        expect(determineSessionStatus(metaAfterRecovery, summaryAfterRecovery)).toBe("INTERRUPTED");

        // Subtest 4: Recovery idempotence
        const secondRecovery = ShadowCollectorEngine.recoverSessionDirectory(crashDir);
        expect(secondRecovery.recoveredStatus).toBe("INTERRUPTED");
        expect(secondRecovery.tornLinesQuarantinedCount).toBe(0);
        expect(secondRecovery.validDecisionsCount).toBe(1);

        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });
    });

    describe("Phase 12.94-D.2.2 Closure Audit v2 Regression Suites (D22C-01 through D22C-04)", () => {
      // D22C-01: Close the mock-provider attestation bypass
      it("D22C-01: fails closed on forged symbol brands, plain objects with mock_ names, and tampered method prototypes", () => {
        // 1. Plain object with the correct exported MOCK_PROVIDER_BRAND symbol and boolean values
        const forgedSymbolProvider = {
          [MOCK_PROVIDER_BRAND]: true,
          isMockProvider: true,
          providerId: "mock_forged_symbol_provider",
          capabilityStatus: "UNVERIFIED_DESIGN_EXPECTATION",
          getPoolReserves: async () => ({
            poolId: "pool-1",
            baseReserve: 1000,
            quoteReserve: 10,
            sourceTimestampMs: 1_792_000_000_000,
            ingestionTimestampMs: 1_792_000_000_000,
            responseReceivedMs: 1_792_000_000_000,
            isVerifiedPool: true,
            vaultA: "vault-a",
            vaultB: "vault-b",
          }),
          getTokenMetrics: async () => ({
            mintAddress: "mint-1",
            volume5mUsd: 1000,
            buys5m: 5,
            sells5m: 5,
            sourceTimestampMs: 1_792_000_000_000,
            ingestionTimestampMs: 1_792_000_000_000,
            responseReceivedMs: 1_792_000_000_000,
          }),
          getDeveloperHoldings: async () => ({
            mintAddress: "mint-1",
            devHoldingPct: 1,
            lpBurnPct: 100,
            sourceTimestampMs: 1_792_000_000_000,
            ingestionTimestampMs: 1_792_000_000_000,
            responseReceivedMs: 1_792_000_000_000,
          }),
        };

        expect(isApprovedMockProvider(forgedSymbolProvider)).toBe(false);

        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-c01-test-"));
        expect(
          () =>
            new ShadowCollectorEngine({
              config: {
                sessionId: "session-c01-1",
                generationId: "gen-1",
                strategyRevision: "rev-1",
                outputRootDir: fixtureRoot,
              },
              provider: forgedSymbolProvider as unknown as IMarketDataProvider,
            }),
        ).toThrow("PROHIBITED_LIVE_PROVIDER_ATTEMPT");

        // 2. Object with mock_ name and compliant interface cannot execute callback
        let callbackExecuted = false;
        const mockNamedCompliant = {
          providerId: "mock_live_helius_adapter",
          capabilityStatus: "UNVERIFIED_DESIGN_EXPECTATION" as const,
          getPoolReserves: async () => {
            callbackExecuted = true;
            throw new Error("Live adapter must never be called");
          },
          getTokenMetrics: async () => {
            callbackExecuted = true;
            throw new Error("Live adapter must never be called");
          },
          getDeveloperHoldings: async () => {
            callbackExecuted = true;
            throw new Error("Live adapter must never be called");
          },
        };

        expect(isApprovedMockProvider(mockNamedCompliant)).toBe(false);
        expect(
          () =>
            new ShadowCollectorEngine({
              config: {
                sessionId: "session-c01-2",
                generationId: "gen-1",
                strategyRevision: "rev-1",
                outputRootDir: fixtureRoot,
              },
              provider: mockNamedCompliant as unknown as IMarketDataProvider,
            }),
        ).toThrow("PROHIBITED_LIVE_PROVIDER_ATTEMPT");
        expect(callbackExecuted).toBe(false);

        // 3. Genuine instance but method prototype tampered with
        const genuineProvider = new MockMarketDataProvider();
        expect(isApprovedMockProvider(genuineProvider)).toBe(true);
        // Tamper with method on instance
        (genuineProvider as unknown as { getPoolReserves: unknown }).getPoolReserves = async () => {
          callbackExecuted = true;
          return {} as unknown;
        };
        expect(isApprovedMockProvider(genuineProvider)).toBe(false);

        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });

      // D22C-02: Require source, ingestion, and receipt availability at or before decision time
      it("D22C-02: differentiates decision-time reserve eligibility from post-decision forward observation", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-c02-test-"));
        const clock = new DeterministicVirtualClock(1_792_000_000_000);
        const provider = new MockMarketDataProvider({ clock });

        const engine = new ShadowCollectorEngine({
          config: {
            sessionId: "session-c02-test",
            generationId: "gen-1",
            strategyRevision: "rev-12.94-d22",
            outputRootDir: fixtureRoot,
          },
          provider,
          clock,
        });

        await engine.start();

        const decisionTime = 1_792_000_000_000;
        const decision = createMockDecisionFixture({
          sessionId: "session-c02-test",
          eventId: "dec-c02-1",
          poolId: "pool-c02-amm",
          decisionTimestampMs: decisionTime,
        });
        engine.ingestCandidateDecision(decision);

        // Scenario A: Old source timestamp (1_791_999_999_000, 1s before decision), but queried at 1_792_000_060_000 (60s later)
        // Simulated response receipt is late relative to decision time
        provider.setReservesResponse("pool-c02-amm", {
          poolId: "pool-c02-amm",
          baseReserve: 1_000_000,
          quoteReserve: 50,
          sourceTimestampMs: decisionTime - 1000, // 1s before decision
          ingestionTimestampMs: decisionTime + 60_000, // 60s AFTER decision
          responseReceivedMs: decisionTime + 60_000, // 60s AFTER decision
          isVerifiedPool: true,
          vaultA: "vault-a",
          vaultB: "vault-b",
        });

        clock.advanceBy(60_000); // Clock at 1_792_000_060_000
        const lateEval = await engine.evaluateShadowCandidate({
          decisionEventId: "dec-c02-1",
          evaluationTimestampMs: decisionTime + 60_000,
        });

        // Must fail decision-time execution feasibility with LATE_RECEIPT_LOOKAHEAD_PREVENTION
        expect(lateEval.qualificationResult.executionFeasible).toBe(false);
        expect(lateEval.qualificationResult.unavailabilityReason).toBe(
          "LATE_RECEIPT_LOOKAHEAD_PREVENTION",
        );
        expect(lateEval.observedReserveSnapshot).toBeUndefined();

        // Scenario B: Fully pre-decision observed reserve (source <= decision, ingestion <= decision, receipt <= decision)
        provider.setReservesResponse("pool-c02-amm", {
          poolId: "pool-c02-amm",
          baseReserve: 1_000_000,
          quoteReserve: 50,
          sourceTimestampMs: decisionTime - 1000,
          ingestionTimestampMs: decisionTime - 500,
          responseReceivedMs: decisionTime - 200,
          isVerifiedPool: true,
          vaultA: "vault-a",
          vaultB: "vault-b",
        });

        const preDecisionEval = await engine.evaluateShadowCandidate({
          decisionEventId: "dec-c02-1",
          evaluationTimestampMs: decisionTime + 65_000,
        });

        expect(preDecisionEval.qualificationResult.executionFeasible).toBe(true);
        expect(preDecisionEval.qualificationResult.unavailabilityReason).toBeUndefined();
        expect(preDecisionEval.observedReserveSnapshot).toBeDefined();
        expect(preDecisionEval.observedReserveSnapshot?.baseReserve).toBe(1_000_000);
        expect(preDecisionEval.observedReserveSnapshot?.quoteReserve).toBe(50);
        expect(preDecisionEval.observedReserveSnapshot?.sourceTimestampMs).toBe(
          decisionTime - 1000,
        );

        // Scenario C: Forward observations preserved separately in market-observations.jsonl
        const forwardObs: MarketObservationRecord = {
          observationId: "obs-forward-1",
          sessionId: "session-c02-test",
          generationId: "gen-1",
          mintAddress: decision.mintAddress,
          poolId: decision.poolId,
          sourceTimestampMs: decisionTime + 60_000,
          ingestionTimestampMs: decisionTime + 60_050,
          responseReceivedMs: decisionTime + 60_100,
          dataFreshnessMs: 50,
          measurementWindow: {
            windowStartMs: decisionTime,
            windowEndMs: decisionTime + 60_000,
            durationSec: 60,
          },
          strategyRevision: "rev-12.94-d22",
          missingFields: [],
          providerIdentity: "mock_offline_market_provider",
          priceMetrics: {
            spotPriceUsd: 0.0012,
            spotPriceSol: 0.000008,
            priceSource: "POOL_RESERVE",
          },
          liquidityMetrics: {
            baseReserve: 950_000,
            quoteReserve: 55,
            liquidityUsd: 55_000,
          },
          flowMetrics: {
            txCount: 15,
            buys: 10,
            sells: 5,
            volumeUsd: 5000,
            netBuyerVolumeUsd: 2500,
          },
        };

        engine.recordForwardObservation(forwardObs);
        const drainSummary = await engine.drain();
        expect(drainSummary.finalStatus).toBe("FINALIZED");
        expect(drainSummary.flushedDecisionsCount).toBe(1);
        expect(drainSummary.flushedObservationsCount).toBe(1);
        expect(drainSummary.flushedEvaluationsCount).toBe(2);

        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });

      // D22C-03: Finality and recovery validate JSON syntax, schema, identity, and count consensus
      it("D22C-03: drain fails-closed on corrupt replacement and recoverSessionDirectory rejects schema-invalid/count-mismatched streams", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-c03-test-"));
        const clock = new DeterministicVirtualClock(1_792_000_000_000);
        const provider = new MockMarketDataProvider({ clock });

        // Reproduction 1: Start session, write 1 valid candidate, overwrite with 'definitely not json\n' -> drain() returns INTERRUPTED
        const engine1 = new ShadowCollectorEngine({
          config: {
            sessionId: "session-c03-reprod1",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            outputRootDir: fixtureRoot,
          },
          provider,
          clock,
        });

        await engine1.start();
        const decision1 = createMockDecisionFixture({
          sessionId: "session-c03-reprod1",
          eventId: "dec-rep-1",
          decisionTimestampMs: 1_792_000_000_000,
        });
        engine1.ingestCandidateDecision(decision1);

        const decisionsPath1 = path.join(
          fixtureRoot,
          "session-c03-reprod1",
          "candidate-decisions.jsonl",
        );
        // Overwrite sole line with non-JSON text of equal line count (1 line)
        fs.writeFileSync(decisionsPath1, "definitely not json\n", "utf8");

        const drain1 = await engine1.drain();
        expect(drain1.finalStatus).toBe("INTERRUPTED");
        expect(drain1.interruptionReason).toContain("RECONCILIATION_PARSE_ERROR");

        const metaAfterDrain1 = JSON.parse(
          fs.readFileSync(
            path.join(fixtureRoot, "session-c03-reprod1", "session-meta.json"),
            "utf8",
          ),
        ) as SessionTelemetryMeta;
        expect(metaAfterDrain1.sessionStatus).toBe("INTERRUPTED");
        expect(metaAfterDrain1.isInterruptedSession).toBe(true);

        // Reproduction 2: Construct session with '{}' in candidate-decisions.jsonl and declared totalDecisionsRecorded: 999
        // recoverSessionDirectory() must refuse FINALIZED, quarantine corrupt file, update meta to INTERRUPTED, and record diagnostics
        const sessionDir2 = path.join(fixtureRoot, "session-c03-reprod2");
        fs.mkdirSync(sessionDir2, { recursive: true });

        fs.writeFileSync(path.join(sessionDir2, "candidate-decisions.jsonl"), "{}\n", "utf8");

        const bogusMeta: SessionTelemetryMeta = {
          sessionId: "session-c03-reprod2",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          startedAtIso: new Date().toISOString(),
          closedAtIso: new Date().toISOString(),
          initialWalletBalanceSol: 7.9259,
          environment: { platform: "mock_offline_harness", nodeVersion: process.version },
          sessionStatus: "FINALIZED",
          isInterruptedSession: false,
        };
        const bogusSummary: SessionTelemetrySummary = {
          sessionId: "session-c03-reprod2",
          generationId: "gen-1",
          strategyRevision: "rev-1",
          startedAtIso: bogusMeta.startedAtIso,
          closedAtIso: bogusMeta.closedAtIso!,
          totalCandidatesScreened: 999,
          totalDecisionsRecorded: 999,
          decisionWriteFailures: 0,
          cohortBreakdown: {
            filteredRejected: 0,
            watchlistRadar: 999,
            triggerRejected: 0,
            executedBuy: 0,
          },
          topRejectionReasons: {},
          totalMarketObservationsRecorded: 0,
          totalStratifiedCandidatesTracked: 0,
          missedWinnersCount: 0,
          avoidedRugsCount: 0,
          isCompleteSession: true,
          isInterruptedSession: false,
        };

        fs.writeFileSync(
          path.join(sessionDir2, "session-meta.json"),
          JSON.stringify(bogusMeta, null, 2),
          "utf8",
        );
        fs.writeFileSync(
          path.join(sessionDir2, "session-summary.json"),
          JSON.stringify(bogusSummary, null, 2),
          "utf8",
        );

        const recovery2 = ShadowCollectorEngine.recoverSessionDirectory(sessionDir2);
        expect(recovery2.recoveredStatus).toBe("INTERRUPTED");
        expect(recovery2.validDecisionsCount).toBe(0); // '{}' is rejected as schema-invalid
        expect(recovery2.schemaInvalidLinesQuarantinedCount).toBe(1);
        expect(recovery2.quarantinedFiles.length).toBeGreaterThan(0);
        expect(recovery2.failureReasons).toContain(
          "DECISIONS_COUNT_MISMATCH: summary=999, validOnDisk=0",
        );

        const metaAfterRecovery2 = JSON.parse(
          fs.readFileSync(path.join(sessionDir2, "session-meta.json"), "utf8"),
        ) as SessionTelemetryMeta;
        const summaryAfterRecovery2 = JSON.parse(
          fs.readFileSync(path.join(sessionDir2, "session-summary.json"), "utf8"),
        ) as SessionTelemetrySummary;
        expect(metaAfterRecovery2.sessionStatus).toBe("INTERRUPTED");
        expect(metaAfterRecovery2.isInterruptedSession).toBe(true);
        expect(summaryAfterRecovery2.isCompleteSession).toBe(false);
        expect(summaryAfterRecovery2.isInterruptedSession).toBe(true);
        expect(summaryAfterRecovery2.totalDecisionsRecorded).toBe(0);

        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });

      // D22C-04: Dual-bounded quota policy: operational payload quota + emergency metadata budget
      it("D22C-04: enforces dual-bounded storage quota with explicit emergency metadata allowance and hard ceilings", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-c04-test-"));
        const clock = new DeterministicVirtualClock(1_792_000_000_000);
        const provider = new MockMarketDataProvider({ clock });

        // Session with 500 bytes operational quota and 2048 bytes emergency metadata budget
        const engine = new ShadowCollectorEngine({
          config: {
            sessionId: "session-c04-quota",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            outputRootDir: fixtureRoot,
            maxSessionDiskBytes: 500, // 500 bytes operational payload quota
            maxEmergencyMetadataBytes: 2048, // 2,048 bytes emergency metadata allowance
          },
          provider,
          clock,
        });

        // start() writes initial session-meta.json (~360 bytes), fits in 500 bytes
        await engine.start();

        const sessionDir = path.join(fixtureRoot, "session-c04-quota");
        expect(fs.existsSync(sessionDir)).toBe(true);

        // Appending a candidate decision (~400 bytes) trips the 500-byte operational quota (360 + 400 = 760 > 500)
        const decision = createMockDecisionFixture({
          sessionId: "session-c04-quota",
          eventId: "dec-quota-1",
        });

        expect(() => engine.ingestCandidateDecision(decision)).toThrow("STORAGE_QUOTA_EXCEEDED");
        expect(engine.state).toBe("TERMINATED");

        // Measure actual disk usage of all files in session directory
        const files = fs.readdirSync(sessionDir);
        let totalDiskBytes = 0;
        let operationalBytes = 0;
        let emergencyBytes = 0;

        for (const file of files) {
          const filePath = path.join(sessionDir, file);
          const stat = fs.statSync(filePath);
          totalDiskBytes += stat.size;
          if (file.endsWith(".jsonl")) {
            operationalBytes += stat.size;
          } else {
            emergencyBytes += stat.size;
          }
        }

        // 1. Operational data files never exceeded maxSessionDiskBytes (500)
        expect(operationalBytes).toBeLessThanOrEqual(500);

        // 2. Emergency metadata files never exceeded maxEmergencyMetadataBytes (2048)
        expect(emergencyBytes).toBeLessThanOrEqual(2048);

        // 3. Total directory disk usage strictly bounded by maxSessionDiskBytes + maxEmergencyMetadataBytes (2548)
        expect(totalDiskBytes).toBeLessThanOrEqual(500 + 2048);

        // 4. Emergency files exist and correctly reflect INTERRUPTED
        const meta = JSON.parse(
          fs.readFileSync(path.join(sessionDir, "session-meta.json"), "utf8"),
        ) as SessionTelemetryMeta;
        const summary = JSON.parse(
          fs.readFileSync(path.join(sessionDir, "session-summary.json"), "utf8"),
        ) as SessionTelemetrySummary;
        const diagnostics = JSON.parse(
          fs.readFileSync(path.join(sessionDir, "session-diagnostics.json"), "utf8"),
        ) as Record<string, unknown>;

        expect(meta.sessionStatus).toBe("INTERRUPTED");
        expect(summary.isCompleteSession).toBe(false);
        expect(diagnostics.interruptionReason).toBe("STORAGE_QUOTA_EXCEEDED");

        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });

      // D22R-01: Continuous call-time mock-only boundary enforcement and subclass lockdown
      it("D22R-01: enforces mock-only behavior throughout collector operation, rejecting post-construction method tampering and subclass overrides", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-r01-test-"));
        const clock = new DeterministicVirtualClock(1_792_000_000_000);
        const provider = new MockMarketDataProvider({ clock });

        const engine = new ShadowCollectorEngine({
          config: {
            sessionId: "session-r01-tamper",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            outputRootDir: fixtureRoot,
          },
          provider,
          clock,
        });

        await engine.start();
        const decision = createMockDecisionFixture({
          sessionId: "session-r01-tamper",
          eventId: "dec-r01-1",
        });
        engine.ingestCandidateDecision(decision);

        // Reproduction A: Genuine provider modified AFTER engine construction
        let callbackExecuted = false;
        (provider as unknown as Record<string, unknown>).getPoolReserves = async (
          poolId: string,
        ) => {
          callbackExecuted = true;
          return MockMarketDataProvider.prototype.getPoolReserves.call(provider, poolId);
        };

        // isApprovedMockProvider detects the method replacement
        expect(isApprovedMockProvider(provider)).toBe(false);

        // evaluateShadowCandidate must fail closed at call time and NOT execute the substituted callback
        await expect(
          engine.evaluateShadowCandidate({ decisionEventId: decision.eventId }),
        ).rejects.toThrow("[PROHIBITED_LIVE_PROVIDER_ATTEMPT]");

        expect(callbackExecuted).toBe(false);

        // Reproduction B: Subclass attempting to override methods or internal helpers
        class TamperedProviderSubclass extends MockMarketDataProvider {
          public override async getPoolReserves(poolId: string) {
            return MockMarketDataProvider.prototype.getPoolReserves.call(this, poolId);
          }
        }
        expect(() => new TamperedProviderSubclass()).toThrow("[PROHIBITED_SUBCLASS_ATTEMPT]");

        // Internal helper override check on genuine instance fails attestation
        const genuineProvider = new MockMarketDataProvider({ clock });
        (genuineProvider as unknown as Record<string, unknown>).checkFailureInjection = () => {};
        expect(isApprovedMockProvider(genuineProvider)).toBe(false);

        // Forged prototype without instantiation fails closed
        const forged = Object.create(MockMarketDataProvider.prototype);
        expect(isApprovedMockProvider(forged)).toBe(false);
        expect(
          () =>
            new ShadowCollectorEngine({
              config: {
                sessionId: "session-r01-forged",
                generationId: "gen-1",
                strategyRevision: "rev-1",
                outputRootDir: fixtureRoot,
              },
              provider: forged,
            }),
        ).toThrow("[PROHIBITED_LIVE_PROVIDER_ATTEMPT]");

        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });

      // D22R-02: Persisted evidence integrity, canonical schemas, composite foreign keys, and dual-file consensus
      it("D22R-02: drain and recovery enforce exact identity sets, complete schemas, foreign keys, and dual-file consensus", async () => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shadow-r02-test-"));
        const clock = new DeterministicVirtualClock(1_792_000_000_000);

        // --- Reproduction A: Equal-count identity swap ---
        {
          const providerA = new MockMarketDataProvider({ clock });
          const engineA = new ShadowCollectorEngine({
            config: {
              sessionId: "session-r02-swap",
              generationId: "gen-1",
              strategyRevision: "rev-1",
              outputRootDir: fixtureRoot,
            },
            provider: providerA,
            clock,
          });
          await engineA.start();
          const decisionA = createMockDecisionFixture({
            sessionId: "session-r02-swap",
            eventId: "dec-original-1",
          });
          engineA.ingestCandidateDecision(decisionA);

          // Tamper on disk: swap eventId to dec-FAKE-SWAPPED while preserving count (1 record)
          const decisionsPathA = path.join(
            fixtureRoot,
            "session-r02-swap",
            "candidate-decisions.jsonl",
          );
          const swappedDecision = { ...decisionA, eventId: "dec-FAKE-SWAPPED" };
          fs.writeFileSync(decisionsPathA, JSON.stringify(swappedDecision) + "\n", "utf8");

          const drainSummaryA = await engineA.drain();
          expect(drainSummaryA.finalStatus).toBe("INTERRUPTED");
          expect(drainSummaryA.isCompleteSession).toBe(false);
          expect(drainSummaryA.interruptionReason).toContain("RECONCILIATION_IDENTITY_MISMATCH");

          const metaA = JSON.parse(
            fs.readFileSync(
              path.join(fixtureRoot, "session-r02-swap", "session-meta.json"),
              "utf8",
            ),
          ) as SessionTelemetryMeta;
          expect(metaA.sessionStatus).toBe("INTERRUPTED");
          expect(metaA.isInterruptedSession).toBe(true);
        }

        // --- Reproduction B: Incomplete canonical schema ---
        {
          const providerB = new MockMarketDataProvider({ clock });
          const engineB = new ShadowCollectorEngine({
            config: {
              sessionId: "session-r02-schema",
              generationId: "gen-1",
              strategyRevision: "rev-1",
              outputRootDir: fixtureRoot,
            },
            provider: providerB,
            clock,
          });
          await engineB.start();
          const decisionB = createMockDecisionFixture({
            sessionId: "session-r02-schema",
            eventId: "dec-schema-1",
          });
          engineB.ingestCandidateDecision(decisionB);

          // Overwrite with minimal 7-field record missing canonical fields
          const decisionsPathB = path.join(
            fixtureRoot,
            "session-r02-schema",
            "candidate-decisions.jsonl",
          );
          const minimalRecord = {
            eventId: "dec-schema-1",
            sessionId: "session-r02-schema",
            generationId: "gen-1",
            mintAddress: "TokenMint111111111111111111111111111111111111",
            poolId: "pool-amm-1",
            decisionTimestampMs: 1_792_000_000_100,
            decisionCohort: "WATCHLIST_RADAR",
          };
          fs.writeFileSync(decisionsPathB, JSON.stringify(minimalRecord) + "\n", "utf8");

          const drainSummaryB = await engineB.drain();
          expect(drainSummaryB.finalStatus).toBe("INTERRUPTED");
          expect(drainSummaryB.isCompleteSession).toBe(false);
          expect(drainSummaryB.interruptionReason).toContain("RECONCILIATION_SCHEMA_INVALID");

          // Also test that recoverSessionDirectory rejects the incomplete record
          const recoveryB = ShadowCollectorEngine.recoverSessionDirectory(
            path.join(fixtureRoot, "session-r02-schema"),
          );
          expect(recoveryB.recoveredStatus).toBe("INTERRUPTED");
          expect(recoveryB.validDecisionsCount).toBe(0);
          expect(recoveryB.schemaInvalidLinesQuarantinedCount).toBe(1);
        }

        // --- Reproduction C: Orphan evaluation after tampering ---
        {
          const providerC = new MockMarketDataProvider({ clock });
          const engineC = new ShadowCollectorEngine({
            config: {
              sessionId: "session-r02-orphan",
              generationId: "gen-1",
              strategyRevision: "rev-1",
              outputRootDir: fixtureRoot,
            },
            provider: providerC,
            clock,
          });
          await engineC.start();
          const decisionC = createMockDecisionFixture({
            sessionId: "session-r02-orphan",
            eventId: "dec-orphan-parent",
            decisionTimestampMs: clock.now(),
          });
          engineC.ingestCandidateDecision(decisionC);
          await engineC.evaluateShadowCandidate({ decisionEventId: decisionC.eventId });

          // Tamper with on-disk evaluation: change decisionEventId to "phantom"
          const evalsPathC = path.join(
            fixtureRoot,
            "session-r02-orphan",
            "shadow-evaluations.jsonl",
          );
          const originalEval = JSON.parse(fs.readFileSync(evalsPathC, "utf8").trim());
          const tamperedEval = { ...originalEval, decisionEventId: "phantom-decision-id" };
          fs.writeFileSync(evalsPathC, JSON.stringify(tamperedEval) + "\n", "utf8");

          const drainSummaryC = await engineC.drain();
          expect(drainSummaryC.finalStatus).toBe("INTERRUPTED");
          expect(drainSummaryC.isCompleteSession).toBe(false);
          expect(drainSummaryC.interruptionReason).toContain("RECONCILIATION_ORPHAN_EVALUATION");

          // Recovery also detects and quarantines the orphan evaluation
          const recoveryC = ShadowCollectorEngine.recoverSessionDirectory(
            path.join(fixtureRoot, "session-r02-orphan"),
          );
          expect(recoveryC.recoveredStatus).toBe("INTERRUPTED");
          expect(recoveryC.validEvaluationsCount).toBe(0);
          expect(recoveryC.schemaInvalidLinesQuarantinedCount).toBeGreaterThanOrEqual(1);
        }

        // --- Reproduction D: Contradictory dual-file identity ---
        {
          const sessionDirD = path.join(fixtureRoot, "session-r02-contradiction");
          fs.mkdirSync(sessionDirD, { recursive: true });

          const contradictoryMeta: SessionTelemetryMeta = {
            sessionId: "session-r02-contradiction",
            generationId: "gen-1",
            strategyRevision: "rev-1",
            startedAtIso: "2026-10-16T00:00:00.000Z",
            closedAtIso: "2026-10-16T00:05:00.000Z",
            initialWalletBalanceSol: 7.9259,
            environment: { platform: "mock_offline_harness", nodeVersion: process.version },
            sessionStatus: "FINALIZED",
            isInterruptedSession: false,
          };

          const contradictorySummary: SessionTelemetrySummary = {
            sessionId: "session-r02-contradiction",
            generationId: "different-gen", // Contradicts meta.generationId ("gen-1")
            strategyRevision: "rev-1",
            startedAtIso: "2026-10-16T00:00:00.000Z",
            closedAtIso: "2026-10-16T00:05:00.000Z",
            totalCandidatesScreened: 0,
            totalDecisionsRecorded: 0,
            decisionWriteFailures: 0,
            cohortBreakdown: {
              filteredRejected: 0,
              watchlistRadar: 0,
              triggerRejected: 0,
              executedBuy: 0,
            },
            topRejectionReasons: {},
            totalMarketObservationsRecorded: 0,
            totalStratifiedCandidatesTracked: 0,
            missedWinnersCount: 0,
            avoidedRugsCount: 0,
            isCompleteSession: true,
            isInterruptedSession: false,
          };

          fs.writeFileSync(
            path.join(sessionDirD, "session-meta.json"),
            JSON.stringify(contradictoryMeta, null, 2),
            "utf8",
          );
          fs.writeFileSync(
            path.join(sessionDirD, "session-summary.json"),
            JSON.stringify(contradictorySummary, null, 2),
            "utf8",
          );

          const recoveryD = ShadowCollectorEngine.recoverSessionDirectory(sessionDirD);
          expect(recoveryD.recoveredStatus).toBe("INTERRUPTED");
          expect(
            recoveryD.failureReasons?.some((r) =>
              r.includes("METADATA_SUMMARY_GENERATION_ID_MISMATCH"),
            ),
          ).toBe(true);
          expect(recoveryD.diagnosticsFileWritten).toBe(true);

          const metaDAfter = JSON.parse(
            fs.readFileSync(path.join(sessionDirD, "session-meta.json"), "utf8"),
          ) as SessionTelemetryMeta;
          const summaryDAfter = JSON.parse(
            fs.readFileSync(path.join(sessionDirD, "session-summary.json"), "utf8"),
          ) as SessionTelemetrySummary;

          expect(metaDAfter.sessionStatus).toBe("INTERRUPTED");
          expect(metaDAfter.isInterruptedSession).toBe(true);
          expect(summaryDAfter.isCompleteSession).toBe(false);
          expect(summaryDAfter.isInterruptedSession).toBe(true);
        }

        fs.rmSync(fixtureRoot, { recursive: true, force: true });
      });
    });
  });
});
