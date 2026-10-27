import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLpScreeningBridge,
  evaluateLpScreeningBridgeSync,
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
  validateSyntheticRaydiumAmmV4Snapshot,
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

  describe("1. Validated Evidence Path & Self-Contained Raw Accounts Fixture", () => {
    it("validates authentic raw RPC accounts through accepted validator and evaluates below-threshold", async () => {
      // Validate raw account batch RPC response through the accepted validator
      const validatedSnapshot = await validateCapturedRayWsolRawAccounts();
      expect(validatedSnapshot.ok).toBe(true);

      const result = await evaluateLpScreeningBridge(
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

    it("evaluates pre-validated snapshot evidence consistently", async () => {
      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBe(0.135682);
    });

    it("evaluates complete full acquisition evidence consistently", async () => {
      const result = await evaluateLpScreeningBridge(
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

    it("evaluates correctly from the actual sealed JSON file on disk", async () => {
      const filePath = path.join(
        rootDir,
        "data/research/snapshots/raydium-amm-v4-snapshot-AVs9TA4n-2026-10-27T06-35-11-779Z.json",
      );
      expect(fs.existsSync(filePath)).toBe(true);
      const rawJson = JSON.parse(fs.readFileSync(filePath, "utf8"));

      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        rawJson,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBe(0.135682);
      expect(result.contextSlot).toBe(461970878);
    });

    it("rejects an unvalidated flat dictionary containing quantities without validator assertions", async () => {
      // Flat dictionary with only quantities, poolId, and timestamp
      const flatUnvalidatedObject = {
        poolId: baseCandidate.poolId,
        tokenMint: baseCandidate.mintAddress,
        protocolLp: 1_000_000_000_000n,
        circulatingSupply: 10_000_000_000n,
        retrievedAtIso: "2026-10-27T06:35:11.779Z",
      };

      const result = await evaluateLpScreeningBridge(
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

    it("rejects an accounting summary marked as summary-only", async () => {
      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_ACCOUNTING_SUMMARY as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects an acquisition object with omitted outcomes, validationResult, or accounting assertions", async () => {
      // 1. Omitted outcomes
      const missingOutcomes = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        outcomes: undefined,
      };
      expect(
        (
          await evaluateLpScreeningBridge(
            baseCandidate,
            missingOutcomes as unknown as ValidatedLpEvidenceInput,
            defaultFreshnessPolicy,
          )
        ).status,
      ).toBe("INVALID_EVIDENCE");

      // 2. validationResult set to null
      const nullValidationResult = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        validationResult: null,
      };
      expect(
        (
          await evaluateLpScreeningBridge(
            baseCandidate,
            nullValidationResult as unknown as ValidatedLpEvidenceInput,
            defaultFreshnessPolicy,
          )
        ).status,
      ).toBe("INVALID_EVIDENCE");

      // 3. accounting assertion set to null or ok: false
      const failedAccounting = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        accounting: null,
      };
      expect(
        (
          await evaluateLpScreeningBridge(
            baseCandidate,
            failedAccounting as unknown as ValidatedLpEvidenceInput,
            defaultFreshnessPolicy,
          )
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
        (
          await evaluateLpScreeningBridge(
            baseCandidate,
            failedStructuralOutcome as unknown as ValidatedLpEvidenceInput,
            defaultFreshnessPolicy,
          )
        ).status,
      ).toBe("INVALID_EVIDENCE");
    });

    it("rejects contradictory provenance metadata", async () => {
      const contradictoryEvidence = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        evidenceOrigin: "CAPTURED_RPC" as const,
        isSyntheticFixture: true, // Contradiction!
      };

      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        contradictoryEvidence as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects non-positive or invalid context slot in evidence", async () => {
      const zeroSlotEvidence = {
        ...CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        diagnostics: {
          ...CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics,
          slot: 0,
        },
      };

      const result = await evaluateLpScreeningBridge(
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
    it("fails closed when candidate mintAddress is missing or empty", async () => {
      const candidateWithoutMint = createSyntheticRayCandidatePool({
        mintAddress: "",
      });

      const result = await evaluateLpScreeningBridge(
        candidateWithoutMint,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });

    it("fails closed when evidence is missing token mint identity", async () => {
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

      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        evidenceWithoutMint as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("rejects candidate when poolId does not match evidence", async () => {
      const mismatchedCandidate = createSyntheticRayCandidatePool({
        poolId: "DifferentPool111111111111111111111111111111",
      });

      const result = await evaluateLpScreeningBridge(
        mismatchedCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("IDENTITY_MISMATCH");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.filterEvaluation.reason).toBe("REJECTED_INVALID_POOL_METADATA");
    });

    it("rejects candidate when mintAddress does not match evidence", async () => {
      const mismatchedCandidate = createSyntheticRayCandidatePool({
        mintAddress: "DifferentMint111111111111111111111111111111",
      });

      const result = await evaluateLpScreeningBridge(
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
    it("fails closed with pool: null when qualified result for Pool A is projected to Pool B (cross-pool projection)", async () => {
      // 1. Evaluate Pool A with qualified evidence (98.5%)
      const poolA = baseCandidate;
      const resultA = await evaluateLpScreeningBridge(
        poolA,
        SYNTHETIC_QUALIFIED_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );
      expect(resultA.status).toBe("AVAILABLE_QUALIFIED");
      expect(resultA.lpBurnPct).toBe(98.5);

      // 2. Attacker attempts to project resultA onto Pool B
      const poolB = createSyntheticRayCandidatePool({
        poolId: "PoolB222222222222222222222222222222222222222",
        mintAddress: "MintB222222222222222222222222222222222222222",
      });

      // Projection helper must return pool: null
      const projectionResult = projectBridgedLpPool(poolB, resultA);
      expect(projectionResult.ok).toBe(false);
      expect(projectionResult.pool).toBeNull();
      expect(projectionResult.status).toBe("IDENTITY_MISMATCH");
      expect(projectionResult.lpBurnPct).toBeNull();
      expect(projectionResult.metricProvenance).toBe("UNAVAILABLE");

      // Alternate bridge helper must also return null to prevent boundary bypass
      const bridgedPoolB = bridgeLpEvidenceToScannedPool(poolB, resultA);
      expect(bridgedPoolB).toBeNull();
      expect(isLpEvidenceAvailable(bridgedPoolB)).toBe(false);
    });

    it("fails closed with pool: null when qualified result is projected to candidate with different token mint (cross-mint projection)", async () => {
      const poolA = baseCandidate;
      const resultA = await evaluateLpScreeningBridge(
        poolA,
        SYNTHETIC_QUALIFIED_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );
      expect(resultA.status).toBe("AVAILABLE_QUALIFIED");

      // Same poolId, different mintAddress
      const poolAWithDifferentMint = createSyntheticRayCandidatePool({
        poolId: poolA.poolId,
        mintAddress: "DifferentMint333333333333333333333333333333",
      });

      const projection = projectBridgedLpPool(poolAWithDifferentMint, resultA);
      expect(projection.ok).toBe(false);
      expect(projection.pool).toBeNull();
      expect(projection.status).toBe("IDENTITY_MISMATCH");

      const bridged = bridgeLpEvidenceToScannedPool(poolAWithDifferentMint, resultA);
      expect(bridged).toBeNull();
    });
  });

  describe("4. Comprehensive Freshness Policy Validation", () => {
    it("rejects currentTimestampMs when NaN, non-positive, or non-finite", () => {
      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: Number.NaN,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer");

      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: Number.POSITIVE_INFINITY,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer");

      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: -1,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer");

      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          currentTimestampMs: 0,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: currentTimestampMs must be a positive safe integer");
    });

    it("rejects clockSkewToleranceMs when NaN, non-finite, or negative", () => {
      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          clockSkewToleranceMs: Number.NaN,
        }),
      ).toThrow(
        "Invalid LpFreshnessPolicy: clockSkewToleranceMs must be a non-negative finite number",
      );

      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          clockSkewToleranceMs: Number.POSITIVE_INFINITY,
        }),
      ).toThrow(
        "Invalid LpFreshnessPolicy: clockSkewToleranceMs must be a non-negative finite number",
      );

      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 60_000,
          clockSkewToleranceMs: -100,
        }),
      ).toThrow(
        "Invalid LpFreshnessPolicy: clockSkewToleranceMs must be a non-negative finite number",
      );
    });

    it("rejects maxEvidenceAgeMs when NaN, non-positive, or non-finite", () => {
      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: 0,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");

      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: Number.NaN,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");

      expect(() =>
        evaluateLpScreeningBridgeSync(baseCandidate, CAPTURED_RAY_WSOL_VALIDATION_RESULT, {
          maxEvidenceAgeMs: -5000,
        }),
      ).toThrow("Invalid LpFreshnessPolicy: maxEvidenceAgeMs must be a positive finite number");
    });

    it("supports clockSkewToleranceMs: 0 as valid non-negative tolerance and rejects future timestamps", async () => {
      const zeroSkewPolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: referenceRetrievalMs - 1, // Evidence is 1ms in the future
        clockSkewToleranceMs: 0, // Strict zero skew
      };

      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        zeroSkewPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
    });

    it("evaluates evidence at the exact boundary of maxEvidenceAgeMs", async () => {
      // Exactly at 60_000 ms boundary
      const exactBoundaryPolicy: LpFreshnessPolicy = {
        maxEvidenceAgeMs: 60_000,
        currentTimestampMs: referenceRetrievalMs + 60_000,
      };

      const result = await evaluateLpScreeningBridge(
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

      const overResult = await evaluateLpScreeningBridge(
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
    it("distinguishes unavailable evidence (lpBurnPct: null, available: false, pool: null) from observed 0%", async () => {
      // Case A: Unavailable Evidence
      const unavailableResult = await evaluateLpScreeningBridge(
        baseCandidate,
        null,
        defaultFreshnessPolicy,
      );
      expect(unavailableResult.status).toBe("UNAVAILABLE");
      expect(unavailableResult.available).toBe(false);
      expect(unavailableResult.lpBurnPct).toBeNull();
      expect(unavailableResult.metricProvenance).toBe("UNAVAILABLE");

      // Projection returns pool: null
      const unavailableProjection = projectBridgedLpPool(baseCandidate, unavailableResult);
      expect(unavailableProjection.ok).toBe(false);
      expect(unavailableProjection.pool).toBeNull();
      expect(unavailableProjection.lpBurnPct).toBeNull();

      const unavailablePool = bridgeLpEvidenceToScannedPool(baseCandidate, unavailableResult);
      expect(unavailablePool).toBeNull();
      expect(isLpEvidenceAvailable(unavailablePool)).toBe(false);

      // Case B: Observed 0% (Protocol LP: 1_000_000_000n, Circulating Supply: 1_000_000_000n -> 0% locked)
      // Rebuilt from coherent synthetic raw accounts passed through validator
      const observedZeroEvidence = await validateSyntheticRaydiumAmmV4Snapshot(
        1_000_000_000n,
        1_000_000_000n,
      );

      const observedZeroResult = await evaluateLpScreeningBridge(
        baseCandidate,
        observedZeroEvidence,
        defaultFreshnessPolicy,
      );

      expect(observedZeroResult.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(observedZeroResult.available).toBe(true);
      expect(observedZeroResult.lpBurnPct).toBe(0.0); // Numeric 0.0, not null!
      expect(observedZeroResult.metricProvenance).toBe("DERIVED");

      const observedZeroProjection = projectBridgedLpPool(baseCandidate, observedZeroResult);
      expect(observedZeroProjection.ok).toBe(false);
      expect(observedZeroProjection.pool).not.toBeNull();
      expect(observedZeroProjection.pool?.lpBurnPct).toBe(0.0);
      expect(observedZeroProjection.lpBurnPct).toBe(0.0);

      const observedZeroPool = bridgeLpEvidenceToScannedPool(baseCandidate, observedZeroResult);
      expect(observedZeroPool).not.toBeNull();
      expect(observedZeroPool!.lpBurnPct).toBe(0.0);
      expect(observedZeroPool!.metricProvenance?.lpBurnPct).toBe("DERIVED");
      expect(isLpEvidenceAvailable(observedZeroPool)).toBe(true); // Distinct from unavailable!

      // Evaluates through AntiRugEvaluator as an observed percentage and rejects
      const antiRug = antiRugEvaluator.evaluate(observedZeroPool!, CANDIDATE_SCANNER_DEFAULTS);
      expect(antiRug.passed).toBe(false);
      expect(antiRug.reason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(antiRug.details?.lpBurnPct).toBe(0.0);
    });
  });

  describe("6. Synthetic Qualified Fixture & Exact Arithmetic Comparison", () => {
    it("admits synthetic qualified fixture (98.5%) rebuilt from raw accounts and qualifies anti-rug LP check", async () => {
      const result = await evaluateLpScreeningBridge(
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
      expect(bridgedPool).not.toBeNull();
      expect(bridgedPool!.lpBurnPct).toBe(98.5);
      expect(bridgedPool!.metricProvenance?.lpBurnPct).toBe("DERIVED");

      const antiRugResult = antiRugEvaluator.evaluate(bridgedPool!, CANDIDATE_SCANNER_DEFAULTS);
      expect(antiRugResult.passed).toBe(true);
      expect(antiRugResult.filterName).toBe("ANTI_RUG_AUTHORITY_AND_LP");
    });

    it("evaluates synthetic qualified acquisition evidence wrapper consistently", async () => {
      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        SYNTHETIC_QUALIFIED_ACQUISITION_EVIDENCE,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("AVAILABLE_QUALIFIED");
      expect(result.available).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.lpBurnPct).toBe(98.5);
    });

    it("qualifies exactly at the 90.000000% mathematical boundary using coherent raw accounts", async () => {
      // 1_000_000_000n total LP, 100_000_000n circulating supply -> 900_000_000n inaccessible (exactly 90.0%)
      const boundaryEvidence = await validateSyntheticRaydiumAmmV4Snapshot(
        1_000_000_000n,
        100_000_000n,
      );

      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        boundaryEvidence,
        defaultFreshnessPolicy,
      );
      expect(result.status).toBe("AVAILABLE_QUALIFIED");
      expect(result.passed).toBe(true);
      expect(result.lpBurnPct).toBe(90.0);
    });

    it("rejects just below the 90.000000% mathematical boundary (89.999999%) using coherent raw accounts", async () => {
      // 100_000_000n total LP, 10_000_001n circulating -> 89_999_999n inaccessible (89.999999%)
      const belowBoundaryEvidence = await validateSyntheticRaydiumAmmV4Snapshot(
        100_000_000n,
        10_000_001n,
      );

      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        belowBoundaryEvidence,
        defaultFreshnessPolicy,
      );
      expect(result.status).toBe("AVAILABLE_BELOW_THRESHOLD");
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBe(89.999999);
    });
  });

  describe("7. Auditor Reproduction Regressions (Consistency & Projection Gaps)", () => {
    it("REGRESSION 1: rejects tampered accounting summary in validationResult when decoded accounts remain below-threshold", async () => {
      // Auditor case: changing accounting summary to 98.5% while leaving diagnostics.poolState.lpReserve and
      // diagnostics.lpMintState.supply unchanged (0.135682%) MUST NOT produce AVAILABLE_QUALIFIED.
      const tamperedSnapshot: ValidatedLpEvidenceInput = {
        ...CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        accounting: {
          ok: true,
          protocolLp: 1_000_000_000_000n, // Tampered!
          circulatingSupply: 15_000_000_000n, // Tampered!
          rawInaccessibleLp: 985_000_000_000n,
          rawDenominator: 1_000_000_000_000n,
          meetsNinetyPercentThreshold: true,
          displayInaccessiblePct: 98.5,
        },
      };

      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        tamperedSnapshot,
        defaultFreshnessPolicy,
      );

      // Must be rejected as INVALID_EVIDENCE due to inconsistency with decoded account states
      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBeNull();
      expect(result.diagnosticMessage).toContain("Inconsistency detected");
    });

    it("REGRESSION 2: rejects tampered acquisition.accounting wrapper when validationResult remains 0.135682%", async () => {
      // Auditor case: changing acquisition.accounting to 98.5% while nested validationResult.accounting remains 0.135682%
      // MUST NOT qualify.
      const tamperedAcquisition: ValidatedLpEvidenceInput = {
        ...CAPTURED_RAY_WSOL_FULL_ACQUISITION_EVIDENCE,
        accounting: {
          ok: true,
          protocolLp: 1_000_000_000_000n, // Tampered in acquisition wrapper!
          circulatingSupply: 15_000_000_000n, // Tampered in acquisition wrapper!
          rawInaccessibleLp: 985_000_000_000n,
          rawDenominator: 1_000_000_000_000n,
          meetsNinetyPercentThreshold: true,
          displayInaccessiblePct: 98.5,
        },
        outcomes: {
          retrievalOk: true,
          structuralValidationOk: true,
          meetsNinetyPercentThreshold: true,
        },
      };

      const result = await evaluateLpScreeningBridge(
        baseCandidate,
        tamperedAcquisition,
        defaultFreshnessPolicy,
      );

      expect(result.status).toBe("INVALID_EVIDENCE");
      expect(result.available).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.lpBurnPct).toBeNull();
      expect(result.diagnosticMessage).toContain("Inconsistency detected");
    });

    it("REGRESSION 3: rejects tampered requestedIdentities.expectedTokenMint when decoded pool still contains RAY", async () => {
      // Auditor case: changing requestedIdentities.expectedTokenMint and candidate mint together
      // to a foreign mint passes if bridge does not check decoded pool state mints.
      const fakeMint = "ForeignMint9999999999999999999999999999999";
      const candidateWithFakeMint = createSyntheticRayCandidatePool({
        mintAddress: fakeMint,
      });

      const tamperedIdentitiesSnapshot: ValidatedLpEvidenceInput = {
        ...CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        diagnostics: {
          ...CAPTURED_RAY_WSOL_VALIDATION_RESULT.diagnostics,
          requestedIdentities: {
            ...CAPTURED_RAY_WSOL_IDENTITIES,
            expectedTokenMint: fakeMint, // Tampered to match fake candidate mint!
          },
        },
      };

      const result = await evaluateLpScreeningBridge(
        candidateWithFakeMint,
        tamperedIdentitiesSnapshot,
        defaultFreshnessPolicy,
      );

      // Decoded poolState contains baseMint: RAY and quoteMint: WSOL.
      // fakeMint is not in decoded pool -> must fail closed (INVALID_EVIDENCE / IDENTITY_MISMATCH)!
      expect(result.passed).toBe(false);
      expect(result.available).toBe(false);
      expect(["INVALID_EVIDENCE", "IDENTITY_MISMATCH"]).toContain(result.status);
    });

    it("REGRESSION 4: proves unavailable/mismatched data never reaches AntiRugEvaluator as an observed percentage", async () => {
      // 1. UNAVAILABLE
      const unavailableResult = await evaluateLpScreeningBridge(
        baseCandidate,
        null,
        defaultFreshnessPolicy,
      );
      const unavailableProj = projectBridgedLpPool(baseCandidate, unavailableResult);
      expect(unavailableProj.pool).toBeNull();
      expect(bridgeLpEvidenceToScannedPool(baseCandidate, unavailableResult)).toBeNull();

      // 2. STALE_EVIDENCE
      const staleResult = await evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        {
          maxEvidenceAgeMs: 1_000,
          currentTimestampMs: referenceRetrievalMs + 10_000,
        },
      );
      expect(staleResult.status).toBe("STALE_EVIDENCE");
      const staleProj = projectBridgedLpPool(baseCandidate, staleResult);
      expect(staleProj.pool).toBeNull();
      expect(bridgeLpEvidenceToScannedPool(baseCandidate, staleResult)).toBeNull();

      // 3. IDENTITY_MISMATCH
      const wrongPoolCandidate = createSyntheticRayCandidatePool({
        poolId: "WrongPoolAddress11111111111111111111111111",
      });
      const mismatchResult = await evaluateLpScreeningBridge(
        wrongPoolCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );
      expect(mismatchResult.status).toBe("IDENTITY_MISMATCH");
      const mismatchProj = projectBridgedLpPool(wrongPoolCandidate, mismatchResult);
      expect(mismatchProj.pool).toBeNull();
      expect(bridgeLpEvidenceToScannedPool(wrongPoolCandidate, mismatchResult)).toBeNull();

      // 4. INVALID_EVIDENCE
      const invalidResult = await evaluateLpScreeningBridge(
        baseCandidate,
        { corrupt: true } as unknown as ValidatedLpEvidenceInput,
        defaultFreshnessPolicy,
      );
      expect(invalidResult.status).toBe("INVALID_EVIDENCE");
      const invalidProj = projectBridgedLpPool(baseCandidate, invalidResult);
      expect(invalidProj.pool).toBeNull();
      expect(bridgeLpEvidenceToScannedPool(baseCandidate, invalidResult)).toBeNull();

      // Contrast: AVAILABLE_BELOW_THRESHOLD (RAY/WSOL reference snapshot)
      const belowThreshResult = await evaluateLpScreeningBridge(
        baseCandidate,
        CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        defaultFreshnessPolicy,
      );
      const belowThreshProj = projectBridgedLpPool(baseCandidate, belowThreshResult);
      expect(belowThreshProj.pool).not.toBeNull();
      expect(belowThreshProj.pool?.lpBurnPct).toBe(0.135682);

      const belowThreshPool = bridgeLpEvidenceToScannedPool(baseCandidate, belowThreshResult);
      expect(belowThreshPool).not.toBeNull();
      expect(belowThreshPool!.lpBurnPct).toBe(0.135682);

      // Passes to AntiRugEvaluator and fails with genuine observed risk
      const evaluation = antiRugEvaluator.evaluate(belowThreshPool!, CANDIDATE_SCANNER_DEFAULTS);
      expect(evaluation.passed).toBe(false);
      expect(evaluation.reason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(evaluation.details?.lpBurnPct).toBe(0.135682);
    });
  });
});
