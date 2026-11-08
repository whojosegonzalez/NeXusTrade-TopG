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
        targetMint: DIFFERENT_CANONICAL_MINT,
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

      expect(adapted.initialPct).toBeCloseTo(0.6, 4);
      expect(adapted.currentHoldingPct).toBeCloseTo(0.02, 4);
      expect(adapted.bundlerPct).toBeCloseTo(0.6, 4);

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
        bundlerPct: adapted.currentHoldingPct,
        requireVerifiedHolders: true,
      });
      const gate11Check = counterfactualResult.gates.find(
        (g) => g.name === "BUNDLER_CONCENTRATION_GATE",
      );
      expect(gate11Check?.passed).toBe(true);
    });
  });

  describe("Metric Agreement & Integrity Regressions", () => {
    it("regression 1: rejects contradictory raw and normalized initial percentages (e.g. raw 95% with normalized 0.01)", () => {
      const contradictoryInitialSnapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 95, // 95%
        initialPct: 0.01, // 1% (contradicts raw 95%!)
      };

      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: contradictoryInitialSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("CONTRADICTORY_METRIC_VALUES");
      expect(result.bundlerPct).toBeUndefined();
      expect(result.marketContextPatch.bundlerPct).toBeUndefined();
    });

    it("regression 1b: rejects contradictory raw and normalized current holding percentages", () => {
      const contradictoryCurrentSnapshot = {
        ...capturedSnapshot,
        reportedRawCurrentPct: 50, // 50%
        currentHoldingPct: 0.05, // 5% (contradicts raw 50%!)
      };

      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: contradictoryCurrentSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("CONTRADICTORY_METRIC_VALUES");
      expect(result.bundlerPct).toBeUndefined();
    });

    it("regression 2: rejects currentHoldingPct: NaN without replacing with zero or returning success", () => {
      const nanCurrentSnapshot = {
        ...capturedSnapshot,
        currentHoldingPct: NaN,
      };

      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: nanCurrentSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("MALFORMED_REQUIRED_METRICS");
      expect(result.bundlerPct).toBeUndefined();
      expect(result.currentHoldingPct).toBeUndefined(); // Never replaced with zero!
    });

    it("regression 3: rejects missing reportedRawInitialPct without reconstructing from initialPct", () => {
      const missingRawInitialSnapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: undefined as unknown as number,
      };

      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: missingRawInitialSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("MALFORMED_REQUIRED_METRICS");
      expect(result.bundlerPct).toBeUndefined();
      expect(result.provenance).toBeUndefined(); // No manufactured provenance!
    });

    it("regression 4: rejects reportedRawInitialPct: Infinity and does not accept into provenance", () => {
      for (const nonFiniteVal of [Infinity, -Infinity, NaN]) {
        const nonFiniteSnapshot = {
          ...capturedSnapshot,
          reportedRawInitialPct: nonFiniteVal,
        };

        const result = adaptPaperBundlerSnapshot({
          targetMint: CANONICAL_MINT,
          snapshot: nonFiniteSnapshot,
          evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 5_000,
          executionContext: "PAPER_SIMULATION",
          maxAllowedRetrievalAgeMs: 15_000,
        });

        expect(result.success).toBe(false);
        expect(result.status).toBe("MALFORMED_REQUIRED_METRICS");
        expect(result.bundlerPct).toBeUndefined();
        expect(result.provenance).toBeUndefined();
      }
    });

    it("preserves genuine reported zero boundaries across raw and normalized values", () => {
      const genuineZeroSnapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 0,
        initialPct: 0,
        reportedRawCurrentPct: 0,
        currentHoldingPct: 0,
      };

      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: genuineZeroSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 2_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.bundlerPct).toBe(0);
      expect(result.initialPct).toBe(0);
      expect(result.currentHoldingPct).toBe(0);
      expect(result.provenance.reportedRawInitialPct).toBe(0);
      expect(result.provenance.reportedRawCurrentPct).toBe(0);

      // In Gate 11, genuine zero passes concentration check
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
      const bundlerGate = evalResult.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.passed).toBe(true);
    });

    it("verifies consistent 95% initial allocation is accepted by adapter and rejected by Gate 11 threshold", () => {
      const consistent95Snapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 95.0,
        initialPct: 0.95,
        reportedRawCurrentPct: 5.0,
        currentHoldingPct: 0.05,
      };

      const adapted = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: consistent95Snapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 2_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(adapted.success).toBe(true);
      if (!adapted.success) return;
      expect(adapted.bundlerPct).toBe(0.95);
      expect(adapted.provenance.reportedRawInitialPct).toBe(95.0);
      expect(adapted.provenance.initialPct).toBe(0.95);

      const service = new BuyGateTriggerService();

      // Case A: Micro-cap candidate (50% ceiling) -> 0.95 > 0.50 fails
      const microCandidate = createSyntheticCandidate({
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        assetAgeSeconds: 450,
      });
      const microEval = service.evaluateCandidate(microCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adapted.bundlerPct,
        requireVerifiedHolders: true,
      });
      expect(microEval.triggered).toBe(false);
      expect(microEval.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");

      // Case B: Established runner candidate (85% ceiling) -> 0.95 > 0.85 fails
      const estCandidate = createSyntheticCandidate({
        liquidityUsd: 60_000,
        marketCapUsd: 250_000,
        lmcRatio: 60_000 / 250_000,
        assetAgeSeconds: 2400, // Qualifying Established age (1800s <= Age <= 7200s)
        volume5mUsd: 20_000,
        buys5m: 50,
        sells5m: 20,
        buyToSellRatio: 2.5,
      });
      const estEval = service.evaluateCandidate(estCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300, // >= 250 minEstablishedHolders
        top10HolderPct: 0.15,
        bundlerPct: adapted.bundlerPct,
        requireVerifiedHolders: true,
      });
      expect(estEval.triggered).toBe(false);
      expect(estEval.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");
      const bundlerGate = estEval.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.requirement).toContain("Bundler <= 85%");
    });
  });

  describe("Exact Boundary & Epsilon Rejection Controls", () => {
    const service = new BuyGateTriggerService();

    it("accepts exact 50% boundary for Micro-Cap and passes Gate 11 with 50% ceiling", () => {
      const boundary50Snapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 50.0,
        initialPct: 0.5,
        reportedRawCurrentPct: 2.0,
        currentHoldingPct: 0.02,
      };

      const adapted = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: boundary50Snapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(adapted.success).toBe(true);
      if (!adapted.success) return;
      expect(adapted.bundlerPct).toBe(0.5);

      const microCandidate = createSyntheticCandidate({
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        assetAgeSeconds: 450,
      });

      const evalResult = service.evaluateCandidate(microCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adapted.bundlerPct,
        requireVerifiedHolders: true,
      });

      const bundlerGate = evalResult.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.passed).toBe(true);
      expect(bundlerGate?.requirement).toContain("Bundler <= 50%");
    });

    it("accepts exact 85% boundary for Established and passes Gate 11 with 85% ceiling", () => {
      const boundary85Snapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 85.0,
        initialPct: 0.85,
        reportedRawCurrentPct: 5.0,
        currentHoldingPct: 0.05,
      };

      const adapted = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: boundary85Snapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(adapted.success).toBe(true);
      if (!adapted.success) return;
      expect(adapted.bundlerPct).toBe(0.85);

      const estCandidate = createSyntheticCandidate({
        liquidityUsd: 60_000,
        marketCapUsd: 250_000,
        lmcRatio: 60_000 / 250_000,
        assetAgeSeconds: 2400, // Qualifying Established age
        volume5mUsd: 20_000,
        buys5m: 50,
        sells5m: 20,
        buyToSellRatio: 2.5,
      });

      const evalResult = service.evaluateCandidate(estCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adapted.bundlerPct,
        requireVerifiedHolders: true,
      });

      const bundlerGate = evalResult.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate?.passed).toBe(true);
      expect(bundlerGate?.requirement).toContain("Bundler <= 85%");
    });

    it("rejects values immediately above each boundary in Gate 11 (50.00000005% and 85.00000005%)", () => {
      // Micro-Cap: immediately above 50%
      const above50InitialPct = 50.00000005 / 100;
      const above50Snapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 50.00000005,
        initialPct: above50InitialPct,
        reportedRawCurrentPct: 2.0,
        currentHoldingPct: 0.02,
      };

      const adaptedAbove50 = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: above50Snapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(adaptedAbove50.success).toBe(true);
      if (!adaptedAbove50.success) return;
      expect(adaptedAbove50.bundlerPct).toBe(above50InitialPct);

      const microCandidate = createSyntheticCandidate({
        liquidityUsd: 25_000,
        marketCapUsd: 100_000,
        assetAgeSeconds: 450,
      });

      const evalAbove50 = service.evaluateCandidate(microCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adaptedAbove50.bundlerPct,
        requireVerifiedHolders: true,
      });

      expect(evalAbove50.triggered).toBe(false);
      expect(evalAbove50.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");
      const bundlerGate50 = evalAbove50.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate50?.passed).toBe(false);
      expect(bundlerGate50?.requirement).toContain("Bundler <= 50%");

      // Established: immediately above 85%
      const above85InitialPct = 85.00000005 / 100;
      const above85Snapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 85.00000005,
        initialPct: above85InitialPct,
        reportedRawCurrentPct: 5.0,
        currentHoldingPct: 0.05,
      };

      const adaptedAbove85 = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: above85Snapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(adaptedAbove85.success).toBe(true);
      if (!adaptedAbove85.success) return;
      expect(adaptedAbove85.bundlerPct).toBe(above85InitialPct);

      const estCandidate = createSyntheticCandidate({
        liquidityUsd: 60_000,
        marketCapUsd: 250_000,
        lmcRatio: 60_000 / 250_000,
        assetAgeSeconds: 2400,
        volume5mUsd: 20_000,
        buys5m: 50,
        sells5m: 20,
        buyToSellRatio: 2.5,
      });

      const evalAbove85 = service.evaluateCandidate(estCandidate, {
        rugScore: 50,
        hasDangerRisk: false,
        holdersCount: 300,
        top10HolderPct: 0.15,
        bundlerPct: adaptedAbove85.bundlerPct,
        requireVerifiedHolders: true,
      });

      expect(evalAbove85.triggered).toBe(false);
      expect(evalAbove85.rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");
      const bundlerGate85 = evalAbove85.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");
      expect(bundlerGate85?.passed).toBe(false);
      expect(bundlerGate85?.requirement).toContain("Bundler <= 85%");
    });

    it("rejects contradictory normalized values rounded down to the boundary (zero-epsilon exact division check)", () => {
      // Counterexample 1: Raw 50.00000005 rounded down to 0.5 (Micro-Cap boundary)
      const roundedDown50Snapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 50.00000005,
        initialPct: 0.5, // Fraudulently rounded down to 0.5 to pass 50% check!
        reportedRawCurrentPct: 2.0,
        currentHoldingPct: 0.02,
      };

      const result50 = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: roundedDown50Snapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result50.success).toBe(false);
      expect(result50.status).toBe("CONTRADICTORY_METRIC_VALUES");
      expect(result50.bundlerPct).toBeUndefined();

      // Counterexample 2: Raw 85.00000005 rounded down to 0.85 (Established boundary)
      const roundedDown85Snapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 85.00000005,
        initialPct: 0.85, // Fraudulently rounded down to 0.85 to pass 85% check!
        reportedRawCurrentPct: 5.0,
        currentHoldingPct: 0.05,
      };

      const result85 = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: roundedDown85Snapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(result85.success).toBe(false);
      expect(result85.status).toBe("CONTRADICTORY_METRIC_VALUES");
      expect(result85.bundlerPct).toBeUndefined();

      // Counterexample 3: Current holdings raw 10.00000005 rounded down to 0.1
      const roundedDownCurrentSnapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 5.0,
        initialPct: 0.05,
        reportedRawCurrentPct: 10.00000005,
        currentHoldingPct: 0.1, // Fraudulently rounded down
      };

      const resultCurrent = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: roundedDownCurrentSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });

      expect(resultCurrent.success).toBe(false);
      expect(resultCurrent.status).toBe("CONTRADICTORY_METRIC_VALUES");
      expect(resultCurrent.bundlerPct).toBeUndefined();
    });

    it("accepts valid parser-produced fractions and genuine zeros via exact division equality", () => {
      // 1. Genuine zeros
      const zeroSnapshot = {
        ...capturedSnapshot,
        reportedRawInitialPct: 0,
        initialPct: 0,
        reportedRawCurrentPct: 0,
        currentHoldingPct: 0,
      };
      const zeroResult = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: zeroSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });
      expect(zeroResult.success).toBe(true);
      if (!zeroResult.success) return;
      expect(zeroResult.bundlerPct).toBe(0);
      expect(zeroResult.currentHoldingPct).toBe(0);

      // 2. Authentic parser-produced fixture fractions
      const fixtureResult = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: capturedSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });
      expect(fixtureResult.success).toBe(true);
      if (!fixtureResult.success) return;
      expect(fixtureResult.bundlerPct).toBe(0.00756 / 100);
      expect(fixtureResult.currentHoldingPct).toBe(0.05904 / 100);
    });
  });

  describe("Provenance Contract Validation", () => {
    it("rejects snapshots violating the parsed-snapshot contract", () => {
      // Contaminated source classification
      const invalidSourceSnapshot = {
        ...capturedSnapshot,
        dataSource: "SYNTHETIC_OVERRIDE" as unknown as "PROVIDER_REPORTED_UNVERIFIED",
      };
      const resSource = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: invalidSourceSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });
      expect(resSource.success).toBe(false);
      expect(resSource.status).toBe("INVALID_PROVENANCE_CONTRACT");

      // Negative or non-safe-integer totalBundlersCount
      for (const invalidCount of [-1, NaN, 1.5, "10"]) {
        const invalidCountSnapshot = {
          ...capturedSnapshot,
          totalBundlersCount: invalidCount as unknown as number,
        };
        const resCount = adaptPaperBundlerSnapshot({
          targetMint: CANONICAL_MINT,
          snapshot: invalidCountSnapshot,
          evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
          executionContext: "PAPER_SIMULATION",
          maxAllowedRetrievalAgeMs: 15_000,
        });
        expect(resCount.success).toBe(false);
        expect(resCount.status).toBe("INVALID_PROVENANCE_CONTRACT");
      }

      // Non-null upstream snapshot timestamp
      const nonNullUpstreamSnapshot = {
        ...capturedSnapshot,
        upstreamSnapshotTimeMs: 1700000000000 as unknown as null,
      };
      const resUpstream = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: nonNullUpstreamSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + 1_000,
        executionContext: "PAPER_SIMULATION",
        maxAllowedRetrievalAgeMs: 15_000,
      });
      expect(resUpstream.success).toBe(false);
      expect(resUpstream.status).toBe("INVALID_PROVENANCE_CONTRACT");
    });

    it("preserves full verified provenance, unverified flags, and null upstream snapshot timestamp on valid adaptation", () => {
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
      expect(p.dataSource).toBe("PROVIDER_REPORTED_UNVERIFIED");
      expect(p.requestedMint).toBe(CANONICAL_MINT);
      expect(p.totalBundlersCount).toBe(1349);
      expect(p.localRetrievedAtMs).toBe(capturedSnapshot.localRetrievedAtMs);
      expect(p.evaluationTimeMs).toBe(evalTime);
      expect(p.retrievalAgeMs).toBe(4_500);
      expect(p.upstreamSnapshotTimeMs).toBeNull();
      expect(p.reportedRawInitialPct).toBe(0.00756);
      expect(p.reportedRawCurrentPct).toBe(0.05904);
      expect(p.initialPct).toBeCloseTo(0.0000756, 7);
      expect(p.currentHoldingPct).toBeCloseTo(0.0005904, 7);
      expect(p.policyClassification).toBe("PAPER_PROXY_UNVERIFIED_LAUNCH_ALLOCATION");

      // Critical unverified assertions preserved
      expect(p.isProviderAccuracyVerified).toBe(false);
      expect(p.isDeployerAttributionVerified).toBe(false);
      expect(p.isJitoEquivalenceVerified).toBe(false);
      expect(p.isLaunchHistoryComplete).toBe(false);
      expect(p.isProductionCompletenessEstablished).toBe(false);
    });
  });

  describe("Retrieval Freshness & Causality Validation", () => {
    it("rejects future-dated evidence fail-closed", () => {
      const result = adaptPaperBundlerSnapshot({
        targetMint: CANONICAL_MINT,
        snapshot: capturedSnapshot,
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs - 1_000,
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
        evaluationTimeMs: capturedSnapshot.localRetrievedAtMs + maxAgeMs + 1,
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
      expect(bundlerGate?.passed).toBe(true);
      expect(evalVol.triggered).toBe(false);
      expect(evalVol.rejectionReason).toBe("VOLUME_SURGE_GATE_FAILED");

      // Case B: Failing RugCheck Score Gate (score 750 > 700)
      const passingCandidate = createSyntheticCandidate();
      const evalRugScore = service.evaluateCandidate(passingCandidate, {
        rugScore: 750,
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
