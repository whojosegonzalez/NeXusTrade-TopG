import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLpScreeningBridge,
  bridgeLpEvidenceToScannedPool,
  projectBridgedLpPool,
  isLpEvidenceAvailable,
  LP_DERIVATION_METHOD,
  type LpFreshnessPolicy,
  type ValidatedLpEvidenceInput,
} from "./LpScreeningBridge.js";
import {
  CAPTURED_RAY_WSOL_IDENTITIES,
  CAPTURED_RAY_WSOL_VALIDATION_RESULT,
  CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
  CAPTURED_RAY_WSOL_ACCOUNTING_SUMMARY,
  SYNTHETIC_QUALIFIED_VALIDATION_RESULT,
  SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
  createSyntheticRayCandidatePool,
  validateCapturedRayWsolRawAccounts,
} from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import { AntiRugEvaluator } from "./evaluators/AntiRugEvaluator.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "./CandidateScannerConfig.js";
import type { RaydiumAmmV4SnapshotValidationSuccess } from "../research/pilot/RaydiumAmmV4SnapshotValidator.js";

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

  describe("1. Validated Evidence Path & Self-Contained Raw Accounts Fixture", () => {
    it("validates authentic raw RPC accounts through accepted validator and evaluates below-threshold", async () => {
      // Validate raw account batch RPC response through the accepted validator
      const validatedSnapshot = await validateCapturedRayWsolRawAccounts();
      expect(validatedSnapshot.ok).toBe(true);

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        validatedSnapshot,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.lpFilterPassed).toBe(false);
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

      // Verify strategy admission is NOT claimed
      expect(result.evidenceBoundary.strategyGateAdmitted).toBe(false);
      expect("admitted" in result).toBe(false);

      // Verify filter evaluation
      expect(result.filterEvaluation.filterName).toBe("ANTI_RUG_LP_SECURITY");
      expect(result.filterEvaluation.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_UNLOCKED_LP_RISK");
    });

    it("evaluates pre-validated snapshot evidence consistently", () => {
      const result = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBe(0.135682);
    });

    it("evaluates complete full acquisition evidence consistently", () => {
      const result = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBe(0.135682);
      expect(result.contextSlot).toBe(461970878);
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
      expect(result.contextSlot).toBe(461970878);
    });

    it("rejects an unvalidated flat dictionary containing quantities without validator assertions", () => {
      // Auditor reproduction: flat dictionary with only quantities, poolId, and timestamp
      const flatUnvalidatedObject = {
        poolId: baseCandidate.poolId,
        tokenMint: baseCandidate.mintAddress,
        protocolLp: 1_000_000_000_000n,
        circulatingSupply: 10_000_000_000n,
        retrievedAtIso: "2026-10-27T06:35:11.779Z",
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        flatUnvalidatedObject as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBeNull();
      expect(result.metricProvenance).toBe("UNAVAILABLE");
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });

    it("rejects an accounting summary marked as summary-only", () => {
      const result = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_ACCOUNTING_SUMMARY as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects an acquisition object with omitted outcomes, validationResult, or accounting assertions", () => {
      // 1. Omitted outcomes
      const missingOutcomes = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        outcomes: undefined,
      };
      expect(
        evaluateLpScreeningBridge(
          baseCandidate,
          missingOutcomes as unknown as ValidatedLpEvidenceInput,
          defaultFreshnessPolicy,
        ).status,
      ).toBe("INVALID_EVIDENCE");

      // 2. validationResult set to null
      const nullValidationResult = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        validationResult: null,
      };
      expect(
        evaluateLpScreeningBridge(
          baseCandidate,
          nullValidationResult as unknown as ValidatedLpEvidenceInput,
          defaultFreshnessPolicy,
        ).status,
      ).toBe("INVALID_EVIDENCE");

      // 3. accounting assertion set to null or ok: false
      const failedAccounting = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        accounting: null,
      };
      expect(
        evaluateLpScreeningBridge(
          baseCandidate,
          failedAccounting as unknown as ValidatedLpEvidenceInput,
          defaultFreshnessPolicy,
        ).status,
      ).toBe("INVALID_EVIDENCE");

      // 4. outcomes.structuralValidationOk is false
      const failedStructuralOutcome = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        outcomes: {
          retrievalOk: true,
          structuralValidationOk: false,
          meetsNinetyPercentThreshold: false,
        },
      };
      expect(
        evaluateLpScreeningBridge(
          baseCandidate,
          failedStructuralOutcome as unknown as ValidatedLpEvidenceInput,
          defaultFreshnessPolicy,
        ).status,
      ).toBe("INVALID_EVIDENCE");
    });

    it("rejects contradictory provenance metadata", () => {
      const contradictoryEvidence = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        evidenceOrigin: "CAPTURED_RPC" as const,
        isSyntheticFixture: true, // Contradiction!
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        contradictoryEvidence as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects non-positive or invalid context slot in evidence", () => {
      const zeroSlotEvidence = {
        ...CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        diagnostics: {
          ...CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics,
          slot: 0,
        },
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        zeroSlotEvidence as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });
  });

  describe("2. Complete Exact Identity Binding & Fail-Closed Mismatches", () => {
    it("fails closed when candidate mintAddress is missing or empty", () => {
      const candidateWithoutMint = createSyntheticRayCandidatePool({
        mintAddress: "",
      });

      const result = evaluateLpScreeningBridge(
        candidateWithoutMint,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });

    it("fails closed when evidence is missing token mint identity", () => {
      const evidenceWithoutMint = {
        ...CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        diagnostics: {
          ...CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics,
          requestedIdentities: {
            ...CAPTURED_RAY_WSOL_IDENTITIES,
            expectedTokenMint: "",
          },
        },
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        evidenceWithoutMint as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects candidate when poolId does not match evidence", () => {
      const mismatchedCandidate = createSyntheticRayCandidatePool({
        poolId: "DifferentPool111111111111111111111111111111",
      });

      const result = evaluateLpScreeningBridge(
        mismatchedCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });

    it("rejects candidate when mintAddress does not match evidence", () => {
      const mismatchedCandidate = createSyntheticRayCandidatePool({
        mintAddress: "DifferentMint111111111111111111111111111111",
      });

      const result = evaluateLpScreeningBridge(
        mismatchedCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });
  });

  describe("3. Identity Binding Through Projection (Cross-Pool / Cross-Mint Defense)", () => {
    it("fails closed when qualified result for Pool A is projected to Pool B (cross-pool projection)", () => {
      // 1. Evaluate Pool A with qualified evidence (98.5%)
      const poolA = createSyntheticRayCandidatePool({
        poolId: "PoolA111111111111111111111111111111111111111",
        mintAddress: "MintA111111111111111111111111111111111111111",
      });

      const qualifiedEvidenceForA = {
        ...SYNTHETIC_QUALIFIED_VALIDATION_RESULT,
        diagnostics: {
          ...SYNTHETIC_QUALIFIED_VALIDATION_RESULT.diagnostics,
          requestedIdentities: {
            ...CAPTURED_RAY_WSOL_IDENTITIES,
            poolId: poolA.poolId,
            expectedTokenMint: poolA.mintAddress,
          },
        },
      };

      const resultA = evaluateLpScreeningBridge(
        poolA,
        qualifiedEvidenceForA,
        defaultFreshnessPolicy,
      );
      expect(resultA.status).toBe("AVAILABLE_QUALIFIED");
      expect(resultA.lpBurnPct).toBe(98.5);

      // 2. Attacker attempts to project resultA onto Pool B
      const poolB = createSyntheticRayCandidatePool({
        poolId: "PoolB222222222222222222222222222222222222222",
        mintAddress: "MintB222222222222222222222222222222222222222",
      });

      const bridgedPoolB = bridgeLpEvidenceToScannedPool(poolB, resultA);

      // Must fail closed to 0 and UNAVAILABLE
      expect(bridgedPoolB.lpBurnPct).toBe(0);
      expect(bridgedPoolB.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");

      // Verify AntiRugEvaluator fails Pool B
      const antiRugResult = antiRugEvaluator.evaluate(bridgedPoolB, CANDIDATE_SCANNER_DEFAULTS);
      expect(antiRugResult.passed).toBe(false);
      expect(antiRugResult.reason).toBe("REJECTED_UNLOCKED_LP_RISK");

      // Verify projectBridgedLpPool reports explicit error
      const projectionResult = projectBridgedLpPool(poolB, resultA);
      expect(projectionResult.ok).toBe(false);
      expect(projectionResult.status).toBe("IDENTITY_MISMATCH");
      expect(projectionResult.lpBurnPct).toBeNull();
      expect(projectionResult.metricProvenance).toBe("UNAVAILABLE");
    });

    it("fails closed when qualified result is projected to candidate with different token mint (cross-mint projection)", () => {
      const poolA = createSyntheticRayCandidatePool({
        poolId: "PoolA111111111111111111111111111111111111111",
        mintAddress: "MintA111111111111111111111111111111111111111",
      });

      const qualifiedEvidenceForA = {
        ...SYNTHETIC_QUALIFIED_VALIDATION_RESULT,
        diagnostics: {
          ...SYNTHETIC_QUALIFIED_VALIDATION_RESULT.diagnostics,
          requestedIdentities: {
            ...CAPTURED_RAY_WSOL_IDENTITIES,
            poolId: poolA.poolId,
            expectedTokenMint: poolA.mintAddress,
          },
        },
      };

      const resultA = evaluateLpScreeningBridge(
        poolA,
        qualifiedEvidenceForA,
        defaultFreshnessPolicy,
      );
      expect(resultA.status).toBe("AVAILABLE_QUALIFIED");

      // Same poolId, different mintAddress
      const poolAWithDifferentMint = createSyntheticRayCandidatePool({
        poolId: poolA.poolId,
        mintAddress: "DifferentMint333333333333333333333333333333",
      });

      const bridged = bridgeLpEvidenceToScannedPool(poolAWithDifferentMint, resultA);
      expect(bridged.lpBurnPct).toBe(0);
      expect(bridged.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");

      const projection = projectBridgedLpPool(poolAWithDifferentMint, resultA);
      expect(projection.ok).toBe(false);
      expect(projection.status).toBe("IDENTITY_MISMATCH");
    });
  });

  describe("4. Comprehensive Freshness Policy Validation", () => {
    it("rejects currentTimestampMs when NaN, non-positive, or non-finite", () => {
      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: Number.NaN,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer");

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: Number.POSITIVE_INFINITY,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer");

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: -1,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer");

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: 0,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer");
    });

    it("rejects clockSkewToleranceMs when NaN, non-finite, or negative", () => {
      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          clockSkewToleranceMs: Number.NaN,
        }),
      ).toThrow(
        "Invalid LpFreshnessPolicy: clockSkewToleranceMs must be a non-negative finite number",
      );

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          clockSkewToleranceMs: Number.POSITIVE_INFINITY,
        }),
      ).toThrow(
        "Invalid LpFreshnessPolicy: clockSkewToleranceMs must be a non-negative finite number",
      );

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          clockSkewToleranceMs: -100,
        }),
      ).toThrow(
        "Invalid LpFreshnessPolicy: clockSkewToleranceMs must be a non-negative finite number",
      );
    });

    it("rejects maxEvidenceAgeMs when NaN, non-positive, or non-finite", () => {
      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 0,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: Number.NaN,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");

      expect(() =>
        evaluateLpScreeningBridge(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: -5000,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");
    });

    it("supports clockSkewToleranceMs: 0 as valid non-negative tolerance and rejects future timestamps", () => {
      const zeroSkewPolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: referenceRetrievalMs - 1, // Evidence is 1ms in the future
        clockSkewToleranceMs: 0, // Strict zero skew
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        zeroSkewPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("evaluates evidence at the exact boundary of maxEvidenceAgeMs", () => {
      // Exactly at 60_000 ms boundary
      const exactBoundaryPolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: referenceRetrievalMs + 60_000,
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        exactBoundaryPolicy,
      );

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.available).toBe(true);

      // 1 ms over 60_000 ms boundary -> STALE
      const overBoundaryPolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: referenceRetrievalMs + 60_001,
      };

      const overResult = evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        overBoundaryPolicy,
      );

      expect(overResult.status).toBe("STALE_EVIDENCE");
      expect(overResult.available).toBe(false);
      expect(overResult.passed).toBe(false);
    });
  });

  describe("5. Distinct Unavailable Semantics vs Observed 0%", () => {
    it("distinguishes unavailable evidence (lpBurnPct: null, available: false) from observed 0%", () => {
      // Case A: Unavailable Evidence
      const unavailableResult = evaluateLpScreeningBridge(
        baseCandidate,
        null,
        defaultFreshnessPolicy,
      );
      expect(unavailableResult.status).toBe("UNAVAILABLE");
      expect(unavailableResult.available).toBe(false);
      expect(unavailableResult.lpBurnPct).toBeNull();
      expect(unavailableResult.metricProvenance).toBe("UNAVAILABLE");

      const unavailablePool = bridgeLpEvidenceToScannedPool(baseCandidate, unavailableResult);
      expect(unavailablePool.lpBurnPct).toBe(0);
      expect(unavailablePool.metricProvenance?.lpBurnPct).toBe("UNAVAILABLE");
      expect(isLpEvidenceAvailable(unavailablePool)).toBe(false);

      // Case B: Observed 0% (Protocol LP: 1000n, Circulating Supply: 1000n -> 0% locked)
      const observedZeroEvidence: RaydiumAmmV4SnapshotValidationSuccess = {
        ...CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        accounting: {
          ok: true,
          protocolLp: 1000n,
          circulatingSupply: 1000n,
          rawInaccessibleLp: 0n,
          rawDenominator: 1000n,
          meetsNinetyPercentThreshold: false,
          displayInaccessiblePct: 0.0,
        },
      };

      const observedZeroResult = evaluateLpScreeningBridge(
        baseCandidate,
        observedZeroEvidence,
        defaultFreshnessPolicy,
      );

      expect(observedZeroResult.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(observedZeroResult.available).toBe(true);
      expect(observedZeroResult.lpBurnPct).toBe(0.0); // Numeric 0.0, not null!
      expect(observedZeroResult.metricProvenance).toBe("DERIVED");

      const observedZeroPool = bridgeLpEvidenceToScannedPool(baseCandidate, observedZeroResult);
      expect(observedZeroPool.lpBurnPct).toBe(0.0);
      expect(observedZeroPool.metricProvenance?.lpBurnPct).toBe("DERIVED");
      expect(isLpEvidenceAvailable(observedZeroPool)).toBe(true); // Distinct from unavailable!
    });
  });

  describe("6. Synthetic Qualified Fixture & Exact Arithmetic Comparison", () => {
    it("admits synthetic qualified fixture (98.5%) and qualifies anti-rug LP check", () => {
      const result = evaluateLpScreeningBridge(
        baseCandidate,
        SYNTHETIC_QUALIFIED_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_QUALIFIED");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.lpFilterPassed).toBe(true);
      expect(result.lpBurnPct).toBe(98.5);
      expect(result.metricProvenance).toBe("DERIVED");
      expect(result.meetsNinetyPercentThreshold).toBe(true);

      const bridgedPool = bridgeLpEvidenceToScannedPool(baseCandidate, result);
      expect(bridgedPool.lpBurnPct).toBe(98.5);
      expect(bridgedPool.metricProvenance?.lpBurnPct).toBe("DERIVED");

      const antiRugResult = antiRugEvaluator.evaluate(bridgedPool, CANDIDATE_SCANNER_DEFAULTS);
      expect(antiRugResult.passed).toBe(true);
      expect(antiRugResult.filterName).toBe("ANTI_RUG_AUTHORITY_AND_LP");
    });

    it("evaluates synthetic qualified acquisition evidence wrapper consistently", () => {
      const result = evaluateLpScreeningBridge(
        baseCandidate,
        SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_QUALIFIED");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.lpBurnPct).toBe(98.5);
    });

    it("qualifies exactly at the 90.000000% mathematical boundary", () => {
      const boundaryEvidence: RaydiumAmmV4SnapshotValidationSuccess = {
        ...CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        accounting: {
          ok: true,
          protocolLp: 1000n,
          circulatingSupply: 100n,
          rawInaccessibleLp: 900n,
          rawDenominator: 1000n,
          meetsNinetyPercentThreshold: true,
          displayInaccessiblePct: 90.0,
        },
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        boundaryEvidence,
        defaultFreshnessPolicy,
      );
      expect(result.status).toBe("AVAILABLE_QUALIFIED");
      expect(result.passed).toBe(true);
      expect(result.lpBurnPct).toBe(90.0);
    });

    it("rejects just below the 90.000000% mathematical boundary (89.999999%)", () => {
      const belowBoundaryEvidence: RaydiumAmmV4SnapshotValidationSuccess = {
        ...CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        accounting: {
          ok: true,
          protocolLp: 100_000_000n,
          circulatingSupply: 10_000_001n,
          rawInaccessibleLp: 89_999_999n,
          rawDenominator: 100_000_000n,
          meetsNinetyPercentThreshold: false,
          displayInaccessiblePct: 89.999999,
        },
      };

      const result = evaluateLpScreeningBridge(
        baseCandidate,
        belowBoundaryEvidence,
        defaultFreshnessPolicy,
      );
      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBe(89.999999);
    });
  });
});
