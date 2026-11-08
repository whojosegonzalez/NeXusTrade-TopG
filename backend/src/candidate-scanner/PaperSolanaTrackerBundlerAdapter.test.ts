import { describe, expect, it } from "vitest";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import { BuyGateTriggerService } from "./BuyGateTriggerService.js";
import { parseSolanaTrackerBundlersResponse } from "./SolanaTrackerBundlerParser.js";
import {
  adaptPaperBundlerSnapshot,
  type PaperBundlerExecutionContext,
} from "./PaperSolanaTrackerBundlerAdapter.js";
import {
  CAPTURED_SOLANA_TRACKER_METADATA,
  CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD,
} from "./fixtures/CapturedSolanaTrackerBundlerFixture.js";

const CANONICAL_MINT = CAPTURED_SOLANA_TRACKER_METADATA.requestedMint;
const DIFFERENT_CANONICAL_MINT = "So11111111111111111111111111111111111111112";

function createSyntheticCandidate(
  overrides?: Partial<WatchlistCandidateItem>,
): WatchlistCandidateItem {
  return {
    poolId: "PoolAddress111111111111111111111111111111111",
    mintAddress: CANONICAL_MINT,
    symbol: "SYNTH",
    liquidityUsd: 25_000,
    marketCapUsd: 100_000,
    lmcRatio: 0.25,
    lpBurnPct: 99.0,
    assetAgeSeconds: 450,
    volume5mUsd: 6_000,
    buys5m: 40,
    sells5m: 15,
    buyToSellRatio: 2.67,
    status: "WATCHING",
    discoveredAt: new Date().toISOString(),
    lastEvaluatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("PaperSolanaTrackerBundlerAdapter", () => {
  const parseResult = parseSolanaTrackerBundlersResponse(
    CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD,
    CAPTURED_SOLANA_TRACKER_METADATA,
  );
  if (!parseResult.success) {
    throw new Error("Failed to parse authentic historical fixture");
  }
  const capturedSnapshot = parseResult.data;

  describe("Execution Boundary Enforcement", () => {
    it("accepts explicit PAPER_SIMULATION context", () => {
      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: capturedSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.status).toBe("QUALIFIED_PAPER_PROXY");
      expect(result.bundlerPct).toBeCloseTo(0.0000756, 7);
    });

    it("accepts explicit BACKTEST context", () => {
      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: capturedSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 10_000,
        executionContext: "BACKTEST",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.status).toBe("QUALIFIED_PAPER_PROXY");
    });

    it("rejects PRODUCTION or unapproved execution context fail-closed with bundlerPct undefined", () => {
      for (const prohibitedContext of ["PRODUCTION", "LIVE", "STAGING", "", undefined]) {
        const result = adaptPaperBundlerSnapshot({
          targetMint: CANONICAL_MINT,
          snapshot: capturedSnapshot,
          evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
          executionContext: prohibitedContext as unknown as PaperBundlerExecutionContext,
          maxAllowedRetrievalAgeMs: 15_000,
        });

        expect(result.success).toBe(false);
        expect(result.status).toBe("EXECUTION_CONTEXT_PROHIBITED");
        expect(result.bundlerPct).toBeUndefined();
        expect(result.marketContextPatch.bundlerPct).toBeUndefined();

        // When fed to Gate 11 under verified holders, candidate fails closed
        const service = new BuyGateTriggerService();
        const candidate = createSyntheticCandidate();
        const evalResult = service.evaluateCandidate(candidate, {
          rugScore: 50,
          hasDangerRisk: false,
          holdersCount: 300,
          top10HolderPct: 0.15,
          bundlerPct: result.bundlerPct,
          requireVerifiedHolders: true,
        });
        expect(evalResult.triggered).toBe(false);
        expect(evalResult.rejectionReason).toBe("BUNDLER_CONCENTRATION_UNKNOWN");
      }
    });
  });

  describe("Identity & Metric Integrity", () => {
    it("rejects token mint mismatch fail-closed without inventing pool provenance", () => {
      const result = adaptPaperBundlerSnapshot({
        targetMint: DIFFERENT_CANONICAL_MINT, // Different mint
        snapshot: capturedSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.bundlerPct).toBeUndefined();
      expect(result.marketContextPatch.bundlerPct).toBeUndefined();
    });

    it("preserves initialPct and currentHoldingPct separately and never substitutes current holdings", () => {
      // Synthetic scenario: cabal bought 60% of launch supply (violating 50% micro ceiling),
      // then dumped 58% on retail, leaving current holdings at only 2%.
      const dumpedPayload = {
        total: 5,
        balance: 20_000,
        percentage: 2.0, // Low current holdings
        initialBalance: 600_000,
        initialPercentage: 60.0, // High launch bundling
        wallets: [],
      };
      const parsedDump = parseSolanaTrackerBundlersResponse(
        dumpedPayload,
        CAPTURED_SOLANA_TRACKER_METADATA,
      );
      expect(parsedDump.success).toBe(true);
      if (!parsedDump.success) return;

      const adapted = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: parsedDump.data,
        evaluationTimeMs: CAPTURED_SOLANA_TRACKER_METADATA.localRetrievedAtMs + 2_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      // Both metrics preserved separately
      expect(adapted.initialPct).toBeCloseTo(0.6, 4);
      expect(adapted.currentHoldingPct).toBeCloseTo(0.02, 4);
      expect(adapted.bundlerPct).toBeCloseTo(0.6, 4); // Mapped exclusively from initialPct

      // Evaluated in Gate 11: 0.60 > 0.50 (micro ceiling) -> fails closed
      const service = new BuyGateTriggerService();
      const candidate = createSyntheticCandidate();
      const evalResult = service.evaluateCandidate(candidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adapted.bundlerPct,
        requireVerifiedHolders: true,
      });

      expect(evalResult.triggered).toBe(false);
      expect(evalResult.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");

      // Counterfactual check: substituting currentHoldingPct (0.02) would have erroneously passed
      const counterfactualResult = service.evaluateCandidate(candidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adapted.currentHoldingPct, // Invalid substitution
        requireVerifiedHolders: true,
      });
      const gate11Check = counterfactualResult.gates.find(
        (g) => g.name === "BUNDLER_CONCENTRATION_GATE",
      );
      expect(gate11Check?.passed).toBe(true); // Demonstrates why substitution is prohibited
    });

    it("leaves bundlerPct unavailable if initialPct is missing or invalid; current holdings cannot substitute", () => {
      const invalidInitialSnapshot = {
        ...capturedSnapshot,
        initialPct: NaN as unknown as number,
        currentHoldingPct: 0.05,
      };

      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: invalidInitialSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("INITIAL_ALLOCATION_UNAVAILABLE");
      expect(result.bundlerPct).toBeUndefined();
      expect(result.currentHoldingPct).toBe(0.05);

      const service = new BuyGateTriggerService();
      const candidate = createSyntheticCandidate();
      const evalResult = service.evaluateCandidate(candidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: result.bundlerPct,
        requireVerifiedHolders: true,
      });
      expect(evalResult.triggered).toBe(false);
      expect(evalResult.rejectionReason).toBe("BUNDLER_CONCENTRATION_UNKNOWN");
    });
  });

  describe("Retrieval Freshness & Causality Validation", () => {
    it("rejects future-dated evidence fail-closed", () => {
      // Evaluation timestamp is EARLIER than local retrieval time
      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: capturedSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs - 1_000, // 1s before retrieval
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("FUTURE_DATED_EVIDENCE");
      expect(result.bundlerPct).toBeUndefined();
    });

    it("rejects stale evidence exceeding maxAllowedRetrievalAgeMs fail-closed", () => {
      const maxAgeMs = 15_000;
      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: capturedSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + maxAgeMs + 1, // 1ms over limit
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: maxAgeMs,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("STALE_RETRIEVAL_EVIDENCE");
      expect(result.bundlerPct).toBeUndefined();
    });

    it("rejects invalid retrieval age limits", () => {
      for (const invalidAge of [0, -1, NaN, Infinity, 15.5]) {
        const result = adaptPaperBundlerSnapshot({
          targetMint: CANONICAL_MINT,
          snapshot: capturedSnapshot,
          evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
          executionContext: "PAPER_SIMULATION",
          maxAllowedRetrievalAgeMs: invalidAge,
        });

        expect(result.success).toBe(false);
        expect(result.status).toBe("INVALID_MAX_AGE_LIMIT");
        expect(result.bundlerPct).toBeUndefined();
      }
    });
  });

  describe("Provenance Preservation", () => {
    it("preserves full provenance, unverified flags, and null upstream snapshot timestamp", () => {
      const evalTime = capturedSnapshot.localRetrievedAtMs + 4_500;
      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: capturedSnapshot,
        evaluationTimeMs: evalTime,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const p = result.provenance;
      expect(p.provider).toBe("SOLANA_TRACKER");
      expect(p.requestedMint).toBe(CANONICAL_MINT);
      expect(p.localRetrievedAtMs).toBe(capturedSnapshot.localRetrievedAtMs);
      expect(p.evaluationTimeMs).toBe(evalTime);
      expect(p.retrievalAgeMs).toBe(4_500);
      expect(p.upstreamSnapshotTimeMs).toBeNull();
      expect(p.policyClassification).toBe("PAPER_PROXY_UNVERIFIED_LAUNCH_ALLOCATION");

      // Critical unverified assertions preserved
      expect(p.isProviderAccuracyVerified).toBe(false);
      expect(p.isDeployerAttributionVerified).toBe(false);
      expect(p.isJitoEquivalenceVerified).toBe(false);
      expect(p.isLaunchHistoryComplete).toBe(false);
      expect(p.isProductionCompletenessEstablished).toBe(false);
    });
  });

  describe("Gate Independence & Non-Admission", () => {
    it("verifies that a favorable bundler result does NOT admit a candidate if another gate fails", () => {
      const adapted = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: capturedSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 3_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });
      expect(adapted.success).toBe(true);
      if (!adapted.success) return;

      const service = new BuyGateTriggerService();

      // Case A: Failing Volume Surge Gate (volume $1,000 < $2,500)
      const failingVolCandidate = createSyntheticCandidate({ volume5mUsd: 1_000 });
      const evalVol = service.evaluateCandidate(failingVolCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adapted.bundlerPct,
        requireVerifiedHolders: true,
      });
      const bundlerGate = evalVol.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.passed).toBe(true); // Bundler gate passed
      expect(evalVol.triggered).toBe(false); // Candidate was NOT admitted
      expect(evalVol.rejectionReason).toBe("VOLUME_SURGE_GATE_FAILED");

      // Case B: Failing RugCheck Score Gate (score 750 > 700)
      const passingCandidate = createSyntheticCandidate();
      const evalRugScore = service.evaluateCandidate(passingCandidate, {
        rugScore: 750, // Failing score
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adapted.bundlerPct,
        requireVerifiedHolders: true,
      });
      expect(evalRugScore.triggered).toBe(false);
      expect(evalRugScore.rejectionReason).toBe("RUGCHECK_HIGH_RISK_SCORE_FAILED");

      // Case C: Passing all 11 gates admits candidate in PAPER
      const passingEval = service.evaluateCandidate(passingCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adapted.bundlerPct,
        requireVerifiedHolders: true,
      });
      expect(passingEval.triggered).toBe(true);
      expect(passingEval.rejectionReason).toBeUndefined();
    });
  });
});
