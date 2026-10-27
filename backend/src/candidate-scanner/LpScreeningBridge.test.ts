import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLpScreeningBridge,
  bridgeLpEvidenceToScannedPool,
  LP_DERIVATION_METHOD,
  type LpFreshnessPolicy,
} from "./LpScreeningBridge.js";
import {
  CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
  SYNTHETIC_QUALIFIED_LP_EVIDENCE,
  createSyntheticRayCandidatePool,
} from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import { AntiRugEvaluator } from "./evaluators/AntiRugEvaluator.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "./CandidateScannerConfig.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("LpScreeningBridge", () => {
  const antiRugEvaluator = new AntiRugEvaluator();
  const baseCandidate = createSyntheticRayCandidatePool();

  // Reference retrieval time: 2026-10-27T06:35:11.779Z
  const referenceRetrievalMs = Date.parse("2026-10-27T06:35:11.779Z");
  const defaultFreshnessPolicy: LpFreshnessPolicy = {
    maxEvidenceAgeMs: 60_000, // 60s max age
    currentTimestampMs: referenceRetrievalMs + 5_000, // Evaluated 5s after retrieval
    clockSkewToleranceMs: 5_000,
  };

  describe("1. Observed Below-Threshold Result (Authentic Operator Snapshot)", () => {
    it("evaluates the reference RAY/WSOL snapshot as AVAILABLE_BELOW_THRESHOLD", () => {
      const result = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.admitted).toBe(false);
      expect(result.meetsNinetyPercentThreshold).toBe(false);
      expect(result.lpBurnPct).toBe(0.135682);
      expect(result.derivationMethod).toBe(LP_DERIVATION_METHOD);
      expect(result.metricProvenance).toBe("DERIVED");

      // Verify raw BigInt quantities preserved exactly
      expect(result.rawAccounting).not.toBeNull();
      expect(result.rawAccounting?.protocolLp).toBe(362937054696n);
      expect(result.rawAccounting?.circulatingSupply).toBe(362444613518n);
      expect(result.rawAccounting?.rawInaccessibleLp).toBe(492441178n);
      expect(result.rawAccounting?.rawDenominator).toBe(362937054696n);

      // Verify context slot and provenance
      expect(result.contextSlot).toBe(461970878);
      expect(result.retrievedAtIso).toBe("2026-10-27T06:35:11.779Z");
      expect(result.evidenceOrigin).toBe("CAPTURED_RPC");
      expect(result.isSyntheticFixture).toBe(false);

      // Verify filter evaluation
      expect(result.filterEvaluation.filterName).toBe("ANTI_RUG_LP_SECURITY");
      expect(result.filterEvaluation.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(result.filterEvaluation.details?.status).toBe("AVAILABLE_BELOW_THRESHOLD");
    });

    it("bridges below-threshold evidence into ScannedPoolRecord and fails AntiRugEvaluator", () => {
      const bridgeResult = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        defaultFreshnessPolicy,
      );

      const updatedPool = bridgeLpEvidenceToScannedPool(baseCandidate, bridgeResult);

      expect(updatedPool.lpBurnPct).toBe(0.135682);
      expect(updatedPool.metricProvenance?.lpBurnPct).toBe("DERIVED");

      // Evaluate through existing AntiRugEvaluator
      const antiRugResult = antiRugEvaluator.evaluate(updatedPool, CANDIDATE_SCANNER_DEFAULTS);
      expect(antiRugResult.passed).toBe(false);
      expect(antiRugResult.reason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(antiRugResult.details?.lpBurnPct).toBe(0.135682);
      expect(antiRugResult.details?.minLpBurnPct).toBe(90.0);
    });

    it("evaluates correctly from the actual sealed JSON file on disk", () => {
      const filePath = path.join(
        rootDir,
        "data/research/snapshots/raydium-amm-v4-snapshot-AVs9TA4n-2026-10-27T06-35-11-779Z.json",
      );
      expect(fs.existsSync(filePath)).toBe(true);
      const rawJson = JSON.parse(fs.readFileSync(filePath, "utf8"));

      const result = evaluateLpScreeningBridge(baseCandidate, rawJson, defaultFreshnessPolicy);

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBe(0.135682);
      expect(result.rawAccounting?.protocolLp).toBe(362937054696n);
      expect(result.rawAccounting?.circulatingSupply).toBe(362444613518n);
      expect(result.rawAccounting?.rawInaccessibleLp).toBe(492441178n);
      expect(result.contextSlot).toBe(461970878);
    });
  });

  describe("2. Identity Binding & Mismatch Handling", () => {
    it("rejects candidate when poolId does not match evidence (fail-closed)", () => {
      const mismatchedCandidate = createSyntheticRayCandidatePool({
        poolId: "MismatchedPool1111111111111111111111111111111",
      });

      const result = evaluateLpScreeningBridge(
        mismatchedCandidate,
        CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.admitted).toBe(false);
      expect(result.lpBurnPct).toBeNull();
      expect(result.metricProvenance).toBe("UNAVAILABLE");
      expect(result.filterEvaluation.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");

      // Verify bridged pool receives fail-closed zero value
      const updatedPool = bridgeLpEvidenceToScannedPool(mismatchedCandidate, result);
      expect(updatedPool.lpBurnPct).toBe(0);
      expect(updatedPool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
    });

    it("rejects candidate when mintAddress does not match evidence (fail-closed)", () => {
      const mismatchedCandidate = createSyntheticRayCandidatePool({
        mintAddress: "MismatchedMint1111111111111111111111111111111",
      });

      const result = evaluateLpScreeningBridge(
        mismatchedCandidate,
        CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });
  });

  describe("3. Freshness Policy Enforcement", () => {
    it("rejects evidence whose age exceeds maxEvidenceAgeMs with STALE_EVIDENCE", () => {
      const staleFreshnessPolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000, // 60s max
        currentTimestampMs: referenceRetrievalMs + 60_001, // 60.001s old (1ms over limit)
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        staleFreshnessPolicy,
      );

      expect(result.status).toBe("STALE_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBeNull();
      expect(result.metricProvenance).toBe("UNAVAILABLE");
      expect(result.filterEvaluation.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(result.filterEvaluation.details?.status).toBe("STALE_EVIDENCE");

      const updatedPool = bridgeLpEvidenceToScannedPool(baseCandidate, result);
      expect(updatedPool.lpBurnPct).toBe(0);
      expect(updatedPool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
    });

    it("rejects evidence missing retrieval timestamp with STALE_EVIDENCE", () => {
      const noTimestampEvidence = {
        ...CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        retrievedAtIso: null,
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        noTimestampEvidence,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("STALE_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects impossible calendar date timestamps with STALE_EVIDENCE", () => {
      const impossibleDateEvidence = {
        ...CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        retrievedAtIso: "2026-02-30T12:00:00.000Z", // Feb 30 does not exist
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        impossibleDateEvidence,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("STALE_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects future-dated evidence beyond clock skew tolerance with INVALID_EVIDENCE", () => {
      const futurePolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: referenceRetrievalMs - 10_000, // Evidence is 10s in the future
        clockSkewToleranceMs: 5_000, // Only 5s tolerance
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        futurePolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });

    it("throws an error when maxEvidenceAgeMs is non-positive or invalid", () => {
      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE, {
          maxEvidenceAgeMs: 0,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE, {
          maxEvidenceAgeMs: -100,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE, {
          maxEvidenceAgeMs: Number.NaN,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");
    });
  });

  describe("4. Unavailable Evidence Handling (Fail-Closed, Zero Substitution)", () => {
    it("evaluates null evidence as UNAVAILABLE and never substitutes 100%", () => {
      const result = evaluateLpScreeningBridge(baseCandidate, null, defaultFreshnessPolicy);

      expect(result.status).toBe("UNAVAILABLE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.admitted).toBe(false);
      expect(result.lpBurnPct).toBeNull();
      expect(result.meetsNinetyPercentThreshold).toBe(false);
      expect(result.rawAccounting).toBeNull();
      expect(result.metricProvenance).toBe("UNAVAILABLE");
      expect(result.filterEvaluation.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_UNLOCKED_LP_RISK");

      const updatedPool = bridgeLpEvidenceToScannedPool(baseCandidate, result);
      expect(updatedPool.lpBurnPct).toBe(0);
      expect(updatedPool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");

      // Verify failure in AntiRugEvaluator
      const antiRugResult = antiRugEvaluator.evaluate(updatedPool, CANDIDATE_SCANNER_DEFAULTS);
      expect(antiRugResult.passed).toBe(false);
      expect(antiRugResult.reason).toBe("REJECTED_UNLOCKED_LP_RISK");
    });

    it("evaluates undefined evidence as UNAVAILABLE", () => {
      const result = evaluateLpScreeningBridge(baseCandidate, undefined, defaultFreshnessPolicy);

      expect(result.status).toBe("UNAVAILABLE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });
  });

  describe("5. Invalid Evidence Handling", () => {
    it("rejects evidence when circulatingSupply exceeds protocolLp (S > L)", () => {
      const invalidSupplyEvidence = {
        ...CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        accounting: {
          ok: true as const,
          protocolLp: 1000n,
          circulatingSupply: 1001n, // S > L is invalid
          rawInaccessibleLp: 0n,
          rawDenominator: 1000n,
          meetsNinetyPercentThreshold: false,
          displayInaccessiblePct: 0,
        },
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        invalidSupplyEvidence,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });

    it("rejects evidence when protocolLp is zero (L = 0)", () => {
      const zeroLpEvidence = {
        ...CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        accounting: {
          ok: true as const,
          protocolLp: 0n,
          circulatingSupply: 0n,
          rawInaccessibleLp: 0n,
          rawDenominator: 0n,
          meetsNinetyPercentThreshold: false,
          displayInaccessiblePct: 0,
        },
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        zeroLpEvidence,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects evidence with structural validation failure outcome", () => {
      const structuralFailureEvidence = {
        ...CAPTURED_RAY_WSOL_SNAPSHOT_EVIDENCE,
        outcomes: {
          retrievalOk: true,
          structuralValidationOk: false, // Explicit failure
          meetsNinetyPercentThreshold: false,
        },
        failureReason: "Account layout mismatch",
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        structuralFailureEvidence,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });
  });

  describe("6. Synthetic Qualified Fixture (>= 90%)", () => {
    it("evaluates qualified synthetic fixture as AVAILABLE_QUALIFIED and admits candidate", () => {
      const result = evaluateLpScreeningBridge(
        baseCandidate,
        SYNTHETIC_QUALIFIED_LP_EVIDENCE,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_QUALIFIED");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.admitted).toBe(true);
      expect(result.meetsNinetyPercentThreshold).toBe(true);
      expect(result.lpBurnPct).toBe(98.5);
      expect(result.metricProvenance).toBe("DERIVED");
      expect(result.isSyntheticFixture).toBe(true);
      expect(result.evidenceOrigin).toBe("SYNTHETIC_FIXTURE");

      expect(result.filterEvaluation.passed).toBe(true);
      expect(result.filterEvaluation.reason).toBeUndefined();

      // Bridge to ScannedPoolRecord
      const updatedPool = bridgeLpEvidenceToScannedPool(baseCandidate, result);
      expect(updatedPool.lpBurnPct).toBe(98.5);
      expect(updatedPool.metricProvenance?.lpBurnPct).toBe("DERIVED");

      // Verify passing in AntiRugEvaluator
      const antiRugResult = antiRugEvaluator.evaluate(updatedPool, CANDIDATE_SCANNER_DEFAULTS);
      expect(antiRugResult.passed).toBe(true);
      expect(antiRugResult.filterName).toBe("ANTI_RUG_AUTHORITY_AND_LP");
      expect(antiRugResult.details?.lpBurnPct).toBe(98.5);
    });
  });

  describe("7. Exact BigInt Arithmetic & Boundary Testing", () => {
    it("qualifies exactly at the 90.000000% mathematical boundary", () => {
      // 1000 total LP, 100 circulating supply -> 900 inaccessible (exactly 90.0%)
      const boundaryEvidence = {
        poolId: baseCandidate.poolId,
        mintAddress: baseCandidate.mintAddress,
        protocolLp: 1000n,
        circulatingSupply: 100n,
        retrievedAtIso: "2026-10-27T06:35:11.779Z",
        evidenceOrigin: "CAPTURED_RPC" as const,
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        boundaryEvidence,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_QUALIFIED");
      expect(result.meetsNinetyPercentThreshold).toBe(true);
      expect(result.lpBurnPct).toBe(90.0);
    });

    it("rejects just below the 90.000000% mathematical boundary (89.999999%)", () => {
      // 100_000_000 total LP, 10_000_001 circulating -> 89_999_999 inaccessible (89.999999%)
      const belowBoundaryEvidence = {
        poolId: baseCandidate.poolId,
        mintAddress: baseCandidate.mintAddress,
        protocolLp: 100_000_000n,
        circulatingSupply: 10_000_001n,
        retrievedAtIso: "2026-10-27T06:35:11.779Z",
        evidenceOrigin: "CAPTURED_RPC" as const,
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        belowBoundaryEvidence,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.meetsNinetyPercentThreshold).toBe(false);
      expect(result.lpBurnPct).toBe(89.999999);
      expect(result.passed).toBe(false);
    });
  });
});
