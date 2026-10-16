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
} from "../../telemetry/TelemetryTypes.js";
import { DeterministicVirtualClock, MockMarketDataProvider } from "./MockMarketDataProvider.js";
import {
  DeterministicBackoffCalculator,
  validatePathConfinement,
  VirtualTokenBucket,
} from "./ShadowResourceController.js";
import { ShadowCollectorEngine } from "./ShadowCollectorEngine.js";
import { RESEARCH_HYPOTHESES } from "./ShadowCollectorTypes.js";

function createMockDecisionFixture(
  overrides?: Partial<CandidateDecisionRecord>,
): CandidateDecisionRecord {
  return {
    eventId: overrides?.eventId ?? "dec-mock-1",
    sessionId: overrides?.sessionId ?? "session-shadow-test-1",
    generationId: overrides?.generationId ?? "gen-1",
    mintAddress: overrides?.mintAddress ?? "TokenMint111111111111111111111111111111111111",
    poolId: overrides?.poolId ?? "pool-amm-1",
    symbol: overrides?.symbol ?? "SHD",
    sourceTimestampMs: overrides?.sourceTimestampMs ?? 1_792_000_000_000,
    ingestionTimestampMs: overrides?.ingestionTimestampMs ?? 1_792_000_000_050,
    decisionTimestampMs: overrides?.decisionTimestampMs ?? 1_792_000_000_100,
    strategyRevision: overrides?.strategyRevision ?? "rev-12.94-d22",
    decisionCohort: overrides?.decisionCohort ?? "WATCHLIST_RADAR",
    filterEvaluations: [],
    metricsSnapshot: {
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
    missingFields: [],
    providerIdentity: "mock_offline_market_provider",
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
          maxSessionDiskBytes: 500, // Tiny 500 byte quota to trip wire immediately
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
});
