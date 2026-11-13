import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import {
  PAPER_SECURITY_CONTEXT_POLICY,
  evaluatePaperCandidateSecurityContext,
  type PaperCandidateSecurityContextResult,
  type PaperCandidateSecurityEvidence,
  type PaperProviderResponseEvidence,
} from "./PaperCandidateSecurityContext.js";
import { BuyGateTriggerService } from "./BuyGateTriggerService.js";
import { projectBridgedLpPool, type ValidatedLpEvidenceInput } from "./LpScreeningBridge.js";
import { AntiRugEvaluator } from "./evaluators/AntiRugEvaluator.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "./CandidateScannerConfig.js";
import {
  UnavailableCandidateFlowProvider,
  type CandidateFlowProvider,
  type CandidateFlowResult,
} from "./CandidateFlowProvider.js";
import {
  CAPTURED_RAY_WSOL_VALIDATION_RESULT,
  buildSyntheticAcquisitionEvidence,
  createSyntheticRayCandidatePool,
  createSyntheticRaydiumAmmV4RawBatchPayload,
  validateSyntheticRaydiumAmmV4Snapshot,
} from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import {
  CAPTURED_SOLANA_TRACKER_METADATA,
  CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD,
} from "./fixtures/CapturedSolanaTrackerBundlerFixture.js";
import {
  SYNTHETIC_ACTIVE_AUTHORITY,
  SYNTHETIC_OTHER_MINT,
  SYNTHETIC_SECURITY_MINT as MINT,
  SYNTHETIC_SECURITY_POOL as POOL,
  syntheticMintAccountResponse,
  syntheticRugCheckReport,
} from "./fixtures/SyntheticPaperSecurityEvidenceFixture.js";
import { evaluatePaperDaemonEntryDecision } from "../scripts/paper-trading-daemon.js";

/*
 * Timeline. The bundler payload is the sanitized 2026-11-06 Solana Tracker capture, so every test
 * that uses it is an explicitly DATED REPLAY at its original retrieval time. All other evidence
 * (LP, mint account, RugCheck) is SYNTHETIC and dated relative to that capture.
 */
const T_BUNDLER = CAPTURED_SOLANA_TRACKER_METADATA.localRetrievedAtMs; // historical, dated replay
const T_LP = T_BUNDLER - 2_000; // SYNTHETIC
const T_MINT = T_BUNDLER + 1_000; // SYNTHETIC
const T_RUGCHECK = T_BUNDLER + 2_000; // SYNTHETIC
const DECISION = T_BUNDLER + 4_000; // SYNTHETIC decision time
const OTHER_POOL = "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX"; // canonical, not the candidate pool

const iso = (ms: number) => new Date(ms).toISOString();
const lpAt = (retrievedAtMs: number, lpReserve = 1_000_000_000_000n, lpSupply = 15_000_000_000n) =>
  validateSyntheticRaydiumAmmV4Snapshot(lpReserve, lpSupply, {
    retrievedAtIso: iso(retrievedAtMs),
  });

let VALID_LP: ValidatedLpEvidenceInput;
beforeAll(async () => {
  VALID_LP = await lpAt(T_LP); // SYNTHETIC 98.5% inaccessible
});
afterEach(() => {
  vi.restoreAllMocks();
});

const providerResponse = (
  retrievedAtMs: number,
  payload: unknown,
  overrides: Partial<PaperProviderResponseEvidence> = {},
): PaperProviderResponseEvidence => ({
  requestedMint: MINT,
  retrievedAtMs,
  httpStatus: 200,
  bodyComplete: true,
  payload,
  ...overrides,
});

const validEvidence = (
  overrides: Partial<PaperCandidateSecurityEvidence> = {},
): PaperCandidateSecurityEvidence => ({
  lp: VALID_LP,
  mintAccount: {
    requestedMint: MINT,
    retrievedAtMs: T_MINT,
    response: syntheticMintAccountResponse(),
  },
  rugCheck: providerResponse(T_RUGCHECK, syntheticRugCheckReport()),
  bundler: providerResponse(T_BUNDLER, CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD),
  ...overrides,
});

const evaluate = (
  evidence: PaperCandidateSecurityEvidence,
  options: { decisionTimeMs?: number; poolId?: string; mintAddress?: string } = {},
) =>
  evaluatePaperCandidateSecurityContext({
    executionContext: "PAPER_SIMULATION",
    target: { poolId: options.poolId ?? POOL, mintAddress: options.mintAddress ?? MINT },
    decisionTimeMs: options.decisionTimeMs ?? DECISION,
    evidence,
  });

// ---------------------------------------------------------------------------------------------
// SYNTHETIC strategy context for the daemon's actual entry boundary (Gate 11 included).
// ---------------------------------------------------------------------------------------------
const synthCandidate = (lpBurnPct: number | null): WatchlistCandidateItem =>
  ({
    poolId: POOL,
    mintAddress: MINT,
    symbol: "SYNTH",
    liquidityUsd: 65_000,
    marketCapUsd: 250_000,
    lmcRatio: 0.26,
    lpBurnPct,
    assetAgeSeconds: 600,
    volume5mUsd: 15_000,
    buys5m: 40,
    sells5m: 15,
    buyToSellRatio: 40 / 15,
    status: "WATCHING",
    discoveredAt: iso(DECISION - 120_000),
    lastEvaluatedAt: iso(DECISION),
  }) as WatchlistCandidateItem;
const SYNTH_SPOT = {
  spotPriceSol: 0.000088,
  spotPriceUsd: 0.0132,
  liquidityUsd: 65_000,
  momentum5mBps: 0,
  priceChange1hPct: 4.2,
};
/** SYNTHETIC fresh PAPER-qualified active window (cutoff 4 s before the decision). */
const paperFlow: CandidateFlowProvider = {
  getCandidateFlow(target, evalMs) {
    const windowEndMs = DECISION - 4_000;
    return {
      poolAddress: target.poolAddress,
      tokenMint: target.tokenMint,
      recentBuys60s: 2,
      recentSells60s: 1,
      flowCoverage: "SUFFICIENT",
      isCoverageSufficient: true,
      diagnosticReason: "SYNTHETIC PAPER active window",
      evaluationTimestampMs: evalMs,
      isPaperQualified: true,
      paperQualificationContext: {
        executionContext: "PAPER_SIMULATION",
        qualificationKind: "ACTIVE_WINDOW",
        validatedEpoch: 1,
        originalEvaluationTimestampMs: windowEndMs + 1_000,
        researchWindowSpan: {
          windowStartMs: windowEndMs - 60_000,
          windowEndMs,
          cutoffAgeMs: evalMs - windowEndMs,
        },
        cutoffAgeMs: evalMs - windowEndMs,
        qualificationReason: "SYNTHETIC fully reconciled active window",
        providerAssumptions: ["SYNTHETIC"],
        unresolvedUncertainties: ["SYNTHETIC"],
      },
    } as CandidateFlowResult;
  },
};
const entry = (
  ctx: PaperCandidateSecurityContextResult,
  options: { flowProvider?: CandidateFlowProvider; liquidityUsd?: number } = {},
) =>
  evaluatePaperDaemonEntryDecision({
    candidate: synthCandidate(ctx.gateInputs.lpBurnPct),
    baseSpotInfo: { ...SYNTH_SPOT, liquidityUsd: options.liquidityUsd ?? SYNTH_SPOT.liquidityUsd },
    rugMetrics: ctx.gateInputs.rugMetrics,
    flowProvider: options.flowProvider ?? paperFlow,
    currentNowMs: DECISION,
    requireVerifiedHolders: true,
  });
const gate11 = (decision: ReturnType<typeof entry>) =>
  decision.buyGateResult.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE");

/** The existing scanner LP screening, applied to the composed LP result. */
const scannerLpScreening = (ctx: PaperCandidateSecurityContextResult) => {
  // Authorities on the SYNTHETIC pool record are set only from DISABLED evidence (null), never assumed.
  const pool = createSyntheticRayCandidatePool({
    mintAuthority:
      ctx.authorities.mintAuthority?.status === "DISABLED" ? null : SYNTHETIC_ACTIVE_AUTHORITY,
    freezeAuthority:
      ctx.authorities.freezeAuthority?.status === "DISABLED" ? null : SYNTHETIC_ACTIVE_AUTHORITY,
  });
  const projection = projectBridgedLpPool(pool, ctx.lp.screening!);
  return {
    projection,
    antiRug: projection.pool
      ? new AntiRugEvaluator().evaluate(projection.pool, CANDIDATE_SCANNER_DEFAULTS)
      : null,
  };
};

describe("PaperCandidateSecurityContext (offline composition; not installed)", () => {
  it("S-01: valid composition preserves provenance and supplies the existing gate inputs (dated replay)", async () => {
    const evidence = validEvidence();
    const before = structuredClone(evidence);
    const ctx = await evaluate(evidence);

    expect(ctx.status).toBe("EVALUATED");
    expect(ctx.executionContext).toBe("PAPER_SIMULATION");
    expect(ctx.decisionTimeMs).toBe(DECISION);
    expect(ctx.policy).toEqual({
      executionContext: "PAPER_SIMULATION",
      maxEvidenceAgeMs: 15_000,
      lpClockSkewToleranceMs: 0,
    });

    // LP: accepted bridge result, exact pool and mint, raw accounting and retrieval time preserved.
    expect(ctx.lp.status).toBe("AVAILABLE_QUALIFIED");
    expect(ctx.lp.passed).toBe(true);
    expect(ctx.lp.lpBurnPct).toBe(98.5);
    expect(ctx.lp.screening?.evaluatedCandidate).toEqual({ poolId: POOL, mintAddress: MINT });
    expect(ctx.lp.screening?.rawAccounting).toEqual({
      protocolLp: 1_000_000_000_000n,
      circulatingSupply: 15_000_000_000n,
      rawInaccessibleLp: 985_000_000_000n,
      rawDenominator: 1_000_000_000_000n,
    });
    expect(ctx.lp.screening?.retrievedAtIso).toBe(iso(T_LP));
    expect(ctx.lp.screening?.contextSlot).toBe(461970878);
    expect(ctx.lp.screening?.evidenceOrigin).toBe("SYNTHETIC_FIXTURE");
    expect(ctx.lp.screening?.evidenceBoundary.strategyGateAdmitted).toBe(false);

    // Authorities: explicitly observed nulls only, with request identity, slot and original time.
    expect(ctx.authorities.status).toBe("AVAILABLE");
    expect(ctx.authorities.mintAuthority?.status).toBe("DISABLED");
    expect(ctx.authorities.freezeAuthority?.status).toBe("DISABLED");
    expect(ctx.authorities.provenance).toEqual({
      requestedMint: MINT,
      retrievedAtMs: T_MINT,
      decisionTimeMs: DECISION,
      retrievalAgeMs: 3_000,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      parser: "JSON_PARSED",
      slot: 462_100_000,
      authorityDerivation: "RAW_JSON_PARSED_INFO_VIA_EVALUATE_AUTHORITY_EVIDENCE",
    });

    // RugCheck: validated metrics only; RugCheck never supplies bundler concentration.
    expect(ctx.rugCheck.status).toBe("AVAILABLE");
    expect(ctx.rugCheck.metrics).toEqual({
      rugScore: 150,
      hasDangerRisk: false,
      top10HolderPct: 0.09,
      holdersCount: 450,
    });
    expect(ctx.rugCheck.provenance).toMatchObject({
      provider: "RUGCHECK",
      requestedMint: MINT,
      retrievedAtMs: T_RUGCHECK,
      retrievalAgeMs: 2_000,
      httpStatus: 200,
    });

    // Bundler: initialPercentage proxy, current holdings separate, unverified-proxy disclosures.
    expect(ctx.bundler.status).toBe("QUALIFIED_PAPER_PROXY");
    expect(ctx.bundler.bundlerPct).toBe(0.00756 / 100);
    expect(ctx.bundler.currentHoldingPct).toBe(0.05904 / 100);
    expect(ctx.bundler.provenance).toMatchObject({
      provider: "SOLANA_TRACKER",
      dataSource: "PROVIDER_REPORTED_UNVERIFIED",
      requestedMint: MINT,
      totalBundlersCount: 1349,
      localRetrievedAtMs: T_BUNDLER,
      evaluationTimeMs: DECISION,
      retrievalAgeMs: 4_000,
      upstreamSnapshotTimeMs: null,
      reportedRawInitialPct: 0.00756,
      reportedRawCurrentPct: 0.05904,
      policyClassification: "PAPER_PROXY_UNVERIFIED_LAUNCH_ALLOCATION",
      isProviderAccuracyVerified: false,
      isDeployerAttributionVerified: false,
      isJitoEquivalenceVerified: false,
      isLaunchHistoryComplete: false,
      isProductionCompletenessEstablished: false,
    });

    expect(ctx.preAdmission).toEqual({ passed: true, rejectionReason: null });
    expect(ctx.gateInputs).toEqual({
      lpBurnPct: 98.5,
      rugMetrics: {
        rugScore: 150,
        hasDangerRisk: false,
        top10HolderPct: 0.09,
        holdersCount: 450,
        bundlerPct: 0.00756 / 100,
      },
    });
    expect(ctx.evidenceBoundary).toEqual({ strategyGateAdmitted: false });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx.gateInputs.rugMetrics)).toBe(true);
    expect(evidence).toEqual(before); // supplied evidence is never re-stamped or mutated

    // Existing scanner LP screening accepts the projected pool.
    const screening = scannerLpScreening(ctx);
    expect(screening.projection.ok).toBe(true);
    expect(screening.antiRug?.passed).toBe(true);

    // The daemon's actual entry boundary: Gate 11 passes and the buy gate arms.
    const decision = entry(ctx);
    expect(gate11(decision)?.passed).toBe(true);
    expect(decision.outcome).toBe("ARMED_FIRST_TICK");

    // The acquisition-evidence form runs through the bridge's raw-response path with the same result.
    const lpSnapshot = await lpAt(T_LP);
    const acquisition = buildSyntheticAcquisitionEvidence(
      lpSnapshot,
      createSyntheticRaydiumAmmV4RawBatchPayload(1_000_000_000_000n, 15_000_000_000n),
    );
    const viaAcquisition = await evaluate(validEvidence({ lp: acquisition }));
    expect(viaAcquisition.lp.status).toBe("AVAILABLE_QUALIFIED");
    expect(viaAcquisition.lp.lpBurnPct).toBe(98.5);
    expect(viaAcquisition.lp.screening?.retrievedAtIso).toBe(iso(T_LP));
  });

  it("S-02: LP admission keeps the exact integer 90% comparison; below-threshold and missing LP fail", async () => {
    // Exactly 90% inaccessible (L = 10^12, S = 10^11) qualifies; one more circulating unit does not.
    const exact = await evaluate(
      validEvidence({ lp: await lpAt(T_LP, 1_000_000_000_000n, 100_000_000_000n) }),
    );
    expect(exact.lp.status).toBe("AVAILABLE_QUALIFIED");
    expect(exact.lp.screening?.meetsNinetyPercentThreshold).toBe(true);
    expect(exact.lp.lpBurnPct).toBe(90);
    expect(exact.preAdmission.passed).toBe(true);

    const below = await evaluate(
      validEvidence({ lp: await lpAt(T_LP, 1_000_000_000_000n, 100_000_000_001n) }),
    );
    expect(below.lp.status).toBe("AVAILABLE_BELOW_THRESHOLD");
    expect(below.lp.passed).toBe(false);
    expect(below.lp.screening?.meetsNinetyPercentThreshold).toBe(false);
    expect(below.lp.lpBurnPct).not.toBeNull(); // observed, not unavailable
    expect(below.lp.lpBurnPct!).toBeLessThan(90.000001);
    expect(below.preAdmission).toEqual({
      passed: false,
      rejectionReason: "REJECTED_UNLOCKED_LP_RISK",
    });
    expect(scannerLpScreening(below).antiRug?.reason).toBe("REJECTED_UNLOCKED_LP_RISK");

    // Dated replay of the captured RAY/WSOL LP snapshot (0.135682%), 5 s after its retrieval.
    const capturedAt = Date.parse("2026-10-27T06:35:11.779Z");
    const captured = await evaluate(
      validEvidence({
        lp: CAPTURED_RAY_WSOL_VALIDATION_RESULT,
        mintAccount: {
          requestedMint: MINT,
          retrievedAtMs: capturedAt,
          response: syntheticMintAccountResponse(),
        },
      }),
      { decisionTimeMs: capturedAt + 5_000 },
    );
    expect(captured.lp.status).toBe("AVAILABLE_BELOW_THRESHOLD");
    expect(captured.lp.lpBurnPct).toBe(0.135682);
    expect(captured.lp.screening?.rawAccounting?.rawInaccessibleLp).toBe(492441178n);
    expect(captured.lp.screening?.evidenceOrigin).toBe("CAPTURED_RPC");
    expect(captured.preAdmission.rejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
    // The later bundler and RugCheck evidence is future-dated at that time and stays unavailable.
    expect(captured.rugCheck.status).toBe("FUTURE_DATED_EVIDENCE");
    expect(captured.bundler.status).toBe("ADAPTER_REJECTED:FUTURE_DATED_EVIDENCE");

    for (const lp of [null, undefined]) {
      const missing = await evaluate(validEvidence({ lp }));
      expect(missing.lp.status).toBe("UNAVAILABLE");
      expect(missing.lp.lpBurnPct).toBeNull();
      expect(missing.gateInputs.lpBurnPct).toBeNull();
      expect(missing.preAdmission.rejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
      expect(scannerLpScreening(missing).projection.pool).toBeNull();
    }
  });

  it("S-03: missing authorities stay unknown; only explicitly observed nulls count as disabled", async () => {
    const mintEvidence = (response: unknown, requestedMint = MINT) => ({
      mintAccount: { requestedMint, retrievedAtMs: T_MINT, response },
    });
    const base64MintData = Buffer.alloc(82);
    base64MintData.writeUInt8(6, 44);
    base64MintData.writeUInt8(1, 45);
    const base64Response = syntheticMintAccountResponse();
    (base64Response.result as { value: { data: unknown } }).value.data = [
      base64MintData.toString("base64"),
      "base64",
    ];

    const cases: readonly (readonly [
      string,
      Partial<PaperCandidateSecurityEvidence>,
      string,
      string,
    ])[] = [
      [
        "mint authority omitted",
        mintEvidence(syntheticMintAccountResponse({ omit: ["mintAuthority"] })),
        "AVAILABLE",
        "REJECTED_UNKNOWN_MINT_AUTHORITY",
      ],
      [
        "freeze authority omitted",
        mintEvidence(syntheticMintAccountResponse({ omit: ["freezeAuthority"] })),
        "AVAILABLE",
        "REJECTED_UNKNOWN_FREEZE_AUTHORITY",
      ],
      [
        "mint authority active",
        mintEvidence(
          syntheticMintAccountResponse({ info: { mintAuthority: SYNTHETIC_ACTIVE_AUTHORITY } }),
        ),
        "AVAILABLE",
        "REJECTED_ACTIVE_MINT_AUTHORITY",
      ],
      [
        "freeze authority active",
        mintEvidence(
          syntheticMintAccountResponse({ info: { freezeAuthority: SYNTHETIC_ACTIVE_AUTHORITY } }),
        ),
        "AVAILABLE",
        "REJECTED_ACTIVE_FREEZE_AUTHORITY",
      ],
      [
        "textual placeholder",
        mintEvidence(syntheticMintAccountResponse({ info: { mintAuthority: "none" } })),
        "AVAILABLE",
        "REJECTED_MALFORMED_MINT_AUTHORITY",
      ],
      [
        "base64 layout (no raw parsed info)",
        mintEvidence(base64Response),
        "RAW_PARSED_INFO_UNAVAILABLE",
        "REJECTED_UNKNOWN_FREEZE_AUTHORITY",
      ],
      [
        "not a token mint owner",
        mintEvidence(syntheticMintAccountResponse({ owner: SYNTHETIC_ACTIVE_AUTHORITY })),
        "SOLANA_RPC_UNSUPPORTED_OWNER",
        "REJECTED_UNKNOWN_FREEZE_AUTHORITY",
      ],
      [
        "account not found",
        mintEvidence({ result: { context: { slot: 1 }, value: null } }),
        "SOLANA_RPC_NOT_FOUND",
        "REJECTED_UNKNOWN_FREEZE_AUTHORITY",
      ],
      [
        "other requested account",
        mintEvidence(syntheticMintAccountResponse(), SYNTHETIC_OTHER_MINT),
        "REQUEST_IDENTITY_MISMATCH",
        "REJECTED_UNKNOWN_FREEZE_AUTHORITY",
      ],
      [
        "no mint evidence",
        { mintAccount: null },
        "EVIDENCE_MISSING",
        "REJECTED_UNKNOWN_FREEZE_AUTHORITY",
      ],
    ];
    for (const [label, overrides, status, reason] of cases) {
      const ctx = await evaluate(validEvidence(overrides));
      expect(ctx.authorities.status, label).toBe(status);
      expect(ctx.preAdmission, label).toEqual({ passed: false, rejectionReason: reason });
      expect(ctx.lp.passed, label).toBe(true);
    }

    const omitted = await evaluate(
      validEvidence(
        mintEvidence(syntheticMintAccountResponse({ omit: ["mintAuthority", "freezeAuthority"] })),
      ),
    );
    expect(omitted.authorities.mintAuthority?.status).toBe("OMITTED");
    expect(omitted.authorities.mintAuthorityPassed).toBe(false);
    expect(omitted.authorities.freezeAuthority?.isExplicitlyObserved).toBe(false);
  });

  it("S-04: RugCheck metrics come only from complete, validated, mint-bound responses", async () => {
    const cases: readonly (readonly [string, PaperProviderResponseEvidence | null, string])[] = [
      ["missing", null, "EVIDENCE_MISSING"],
      [
        "HTTP 429",
        providerResponse(T_RUGCHECK, syntheticRugCheckReport(), { httpStatus: 429 }),
        "REQUEST_NOT_OK",
      ],
      [
        "truncated body",
        providerResponse(T_RUGCHECK, syntheticRugCheckReport(), { bodyComplete: false }),
        "RESPONSE_INCOMPLETE",
      ],
      ["not JSON", providerResponse(T_RUGCHECK, null), "RESPONSE_NOT_JSON"],
      [
        "payload mint missing",
        providerResponse(T_RUGCHECK, syntheticRugCheckReport({ mint: undefined })),
        "PAYLOAD_MINT_MISSING",
      ],
      [
        "payload for another mint",
        providerResponse(T_RUGCHECK, syntheticRugCheckReport({ mint: SYNTHETIC_OTHER_MINT })),
        "PAYLOAD_MINT_MISMATCH",
      ],
      [
        "requested for another mint",
        providerResponse(T_RUGCHECK, syntheticRugCheckReport(), {
          requestedMint: SYNTHETIC_OTHER_MINT,
        }),
        "REQUEST_IDENTITY_MISMATCH",
      ],
      [
        "risk list missing",
        providerResponse(T_RUGCHECK, syntheticRugCheckReport({ risks: undefined })),
        "VALIDATION_REJECTED",
      ],
      [
        "score missing",
        providerResponse(T_RUGCHECK, syntheticRugCheckReport({ score: undefined })),
        "VALIDATION_REJECTED",
      ],
    ];
    for (const [label, rugCheck, status] of cases) {
      const ctx = await evaluate(validEvidence({ rugCheck }));
      expect(ctx.rugCheck.status, label).toBe(status);
      expect(ctx.rugCheck.metrics, label).toBeNull();
      // Only the PAPER bundler proxy remains; no RugCheck field is defaulted.
      expect(ctx.gateInputs.rugMetrics, label).toEqual({ bundlerPct: 0.00756 / 100 });
      const decision = entry(ctx);
      expect(gate11(decision)?.passed, label).toBe(false);
      expect(decision.outcome, label).toBe("BUY_GATE_REJECTED");
      expect(decision.rejectionReason, label).toBe(
        "REJECTED_RUGCHECK_UNINDEXED_OR_HOLDERS_UNKNOWN",
      );
    }

    // A validated report without holders or top holders leaves those metrics absent, failing Gate 11.
    const noHolders = await evaluate(
      validEvidence({
        rugCheck: providerResponse(
          T_RUGCHECK,
          syntheticRugCheckReport({ totalHolders: undefined }),
        ),
      }),
    );
    expect(noHolders.rugCheck.status).toBe("AVAILABLE");
    expect(noHolders.gateInputs.rugMetrics).not.toHaveProperty("holdersCount");
    expect(entry(noHolders).rejectionReason).toBe("REJECTED_RUGCHECK_UNINDEXED_OR_HOLDERS_UNKNOWN");
    const noTopHolders = await evaluate(
      validEvidence({
        rugCheck: providerResponse(T_RUGCHECK, syntheticRugCheckReport({ topHolders: undefined })),
      }),
    );
    expect(noTopHolders.gateInputs.rugMetrics).not.toHaveProperty("top10HolderPct");
    expect(entry(noTopHolders).rejectionReason).toBe("TOP_10_CONCENTRATION_UNKNOWN");
  });

  it("S-05: the bundler proxy uses initialPercentage; current holdings are kept separately", async () => {
    const bundlerPayload = (overrides: Record<string, unknown>) =>
      providerResponse(T_BUNDLER, { ...CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD, ...overrides });

    // SYNTHETIC variants of the captured payload's top-level percentages (dated replay timing).
    const lowInitial = await evaluate(
      validEvidence({ bundler: bundlerPayload({ initialPercentage: 40, percentage: 60 }) }),
    );
    expect(lowInitial.bundler.bundlerPct).toBe(0.4);
    expect(lowInitial.bundler.currentHoldingPct).toBe(0.6);
    expect(lowInitial.gateInputs.rugMetrics?.bundlerPct).toBe(0.4);
    expect(gate11(entry(lowInitial))?.passed).toBe(true);

    const highInitial = await evaluate(
      validEvidence({ bundler: bundlerPayload({ initialPercentage: 60, percentage: 10 }) }),
    );
    expect(highInitial.bundler.bundlerPct).toBe(0.6);
    expect(highInitial.bundler.currentHoldingPct).toBe(0.1);
    expect(entry(highInitial).rejectionReason).toBe("BUNDLER_CONCENTRATION_GATE_FAILED");

    const missingInitial = await evaluate(
      validEvidence({ bundler: bundlerPayload({ initialPercentage: undefined, percentage: 1 }) }),
    );
    expect(missingInitial.bundler.status).toMatch(/^PARSE_FAILED:/);
    expect(missingInitial.bundler.bundlerPct).toBeUndefined();
    expect(missingInitial.bundler.currentHoldingPct).toBeUndefined();
    expect(missingInitial.gateInputs.rugMetrics).not.toHaveProperty("bundlerPct");
    expect(entry(missingInitial).rejectionReason).toBe("BUNDLER_CONCENTRATION_UNKNOWN");

    for (const [label, bundler, status] of [
      ["missing", null, "EVIDENCE_MISSING"],
      [
        "HTTP 500",
        providerResponse(T_BUNDLER, CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD, { httpStatus: 500 }),
        "REQUEST_NOT_OK",
      ],
      [
        "truncated",
        providerResponse(T_BUNDLER, CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD, {
          bodyComplete: false,
        }),
        "RESPONSE_INCOMPLETE",
      ],
      [
        "another mint",
        providerResponse(T_BUNDLER, CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD, {
          requestedMint: SYNTHETIC_OTHER_MINT,
        }),
        "REQUEST_IDENTITY_MISMATCH",
      ],
    ] as const) {
      const ctx = await evaluate(validEvidence({ bundler }));
      expect(ctx.bundler.status, label).toBe(status);
      expect(ctx.bundler.bundlerPct, label).toBeUndefined();
      expect(entry(ctx).rejectionReason, label).toBe("BUNDLER_CONCENTRATION_UNKNOWN");
    }
  });

  it("S-06: pool evidence binds to the exact pool and mint; token evidence binds to the mint only", async () => {
    // Same mint, other pool: LP is not this candidate's evidence; token-level evidence still applies.
    const otherPool = await evaluate(validEvidence(), { poolId: OTHER_POOL });
    expect(otherPool.lp.status).toBe("IDENTITY_MISMATCH");
    expect(otherPool.lp.lpBurnPct).toBeNull();
    expect(otherPool.preAdmission.rejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");
    expect(otherPool.authorities.status).toBe("AVAILABLE");
    expect(otherPool.rugCheck.status).toBe("AVAILABLE");
    expect(otherPool.bundler.status).toBe("QUALIFIED_PAPER_PROXY");
    expect(otherPool.bundler.provenance).not.toHaveProperty("poolId");
    expect(otherPool.rugCheck.provenance).not.toHaveProperty("poolId");
    expect(otherPool.authorities.provenance).not.toHaveProperty("poolId");

    // Other mint: nothing supplied for the requested mint is usable.
    const otherMint = await evaluate(validEvidence(), { mintAddress: SYNTHETIC_OTHER_MINT });
    expect(otherMint.lp.status).toBe("IDENTITY_MISMATCH");
    expect(otherMint.authorities.status).toBe("REQUEST_IDENTITY_MISMATCH");
    expect(otherMint.rugCheck.status).toBe("REQUEST_IDENTITY_MISMATCH");
    expect(otherMint.bundler.status).toBe("REQUEST_IDENTITY_MISMATCH");
    expect(otherMint.gateInputs).toEqual({ lpBurnPct: null, rugMetrics: null });

    const invalidTargets: readonly (readonly [string, string])[] = [
      ["not-base58", MINT],
      [POOL, ""],
      [POOL, MINT.toLowerCase()],
    ];
    for (const [poolId, mintAddress] of invalidTargets) {
      const invalid = await evaluate(validEvidence(), { poolId, mintAddress });
      expect(invalid.status).toBe("INVALID_TARGET");
      expect(invalid.lp.status).toBe("NOT_EVALUATED");
      expect(invalid.gateInputs).toEqual({ lpBurnPct: null, rugMetrics: null });
    }
  });

  it("S-07: freshness is revalidated at the decision time; nothing is extended or re-stamped", async () => {
    // All four retrieved at the same SYNTHETIC instant; the bundler payload is replayed at it.
    const T0 = T_BUNDLER;
    const sameInstant = async (): Promise<PaperCandidateSecurityEvidence> => ({
      lp: await lpAt(T0),
      mintAccount: {
        requestedMint: MINT,
        retrievedAtMs: T0,
        response: syntheticMintAccountResponse(),
      },
      rugCheck: providerResponse(T0, syntheticRugCheckReport()),
      bundler: providerResponse(T0, CAPTURED_SOLANA_TRACKER_SANITIZED_PAYLOAD),
    });

    const atLimit = await evaluate(await sameInstant(), { decisionTimeMs: T0 + 15_000 });
    expect(atLimit.lp.status).toBe("AVAILABLE_QUALIFIED");
    expect(atLimit.authorities.status).toBe("AVAILABLE");
    expect(atLimit.rugCheck.status).toBe("AVAILABLE");
    expect(atLimit.bundler.status).toBe("QUALIFIED_PAPER_PROXY");
    expect(atLimit.authorities.provenance?.retrievedAtMs).toBe(T0);
    expect(atLimit.authorities.provenance?.retrievalAgeMs).toBe(15_000);
    expect(atLimit.lp.screening?.retrievedAtIso).toBe(iso(T0));

    const stale = await evaluate(await sameInstant(), { decisionTimeMs: T0 + 15_001 });
    expect(stale.lp.status).toBe("STALE_EVIDENCE");
    expect(stale.authorities.status).toBe("STALE_RETRIEVAL_EVIDENCE");
    expect(stale.rugCheck.status).toBe("STALE_RETRIEVAL_EVIDENCE");
    expect(stale.bundler.status).toBe("ADAPTER_REJECTED:STALE_RETRIEVAL_EVIDENCE");
    expect(stale.gateInputs).toEqual({ lpBurnPct: null, rugMetrics: null });
    expect(stale.preAdmission.rejectionReason).toBe("REJECTED_UNLOCKED_LP_RISK");

    const future = await evaluate(await sameInstant(), { decisionTimeMs: T0 - 1 });
    expect(future.lp.status).toBe("INVALID_EVIDENCE");
    expect(future.lp.unavailableReason).toContain("future-dated");
    expect(future.authorities.status).toBe("FUTURE_DATED_EVIDENCE");
    expect(future.rugCheck.status).toBe("FUTURE_DATED_EVIDENCE");
    expect(future.bundler.status).toBe("ADAPTER_REJECTED:FUTURE_DATED_EVIDENCE");
    expect(future.gateInputs).toEqual({ lpBurnPct: null, rugMetrics: null });

    const badTime = await evaluate(
      validEvidence({ rugCheck: providerResponse(T_RUGCHECK + 0.5, syntheticRugCheckReport()) }),
    );
    expect(badTime.rugCheck.status).toBe("INVALID_RETRIEVAL_TIME");

    for (const decisionTimeMs of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "1" as unknown as number,
    ]) {
      const invalid = await evaluate(validEvidence(), { decisionTimeMs });
      expect(invalid.status).toBe("INVALID_DECISION_TIME");
      expect(invalid.decisionTimeMs).toBeNull();
      expect(invalid.preAdmission).toEqual({
        passed: false,
        rejectionReason: "INVALID_DECISION_TIME",
      });
      expect(invalid.gateInputs).toEqual({ lpBurnPct: null, rugMetrics: null });
    }
  });

  it("S-08: any context other than PAPER_SIMULATION evaluates nothing", async () => {
    const validator = vi.spyOn(BuyGateTriggerService, "validateRugCheckReportPayload");
    for (const executionContext of [
      "PRODUCTION",
      "BACKTEST",
      undefined,
      "paper_simulation",
      null,
      {},
    ]) {
      const ctx = await evaluatePaperCandidateSecurityContext({
        executionContext,
        target: { poolId: POOL, mintAddress: MINT },
        decisionTimeMs: DECISION,
        evidence: validEvidence(),
      } as unknown as Parameters<typeof evaluatePaperCandidateSecurityContext>[0]);
      expect(ctx.status).toBe("EXECUTION_CONTEXT_PROHIBITED");
      for (const part of [ctx.lp, ctx.authorities, ctx.rugCheck, ctx.bundler]) {
        expect(part.status).toBe("NOT_EVALUATED");
      }
      expect(ctx.preAdmission).toEqual({
        passed: false,
        rejectionReason: "EXECUTION_CONTEXT_PROHIBITED",
      });
      expect(ctx.gateInputs).toEqual({ lpBurnPct: null, rugMetrics: null });
      expect(ctx.evidenceBoundary.strategyGateAdmitted).toBe(false);
    }
    expect(validator).not.toHaveBeenCalled();
    expect(PAPER_SECURITY_CONTEXT_POLICY.executionContext).toBe("PAPER_SIMULATION");
  });

  it("S-09: another strategy gate still rejects otherwise favourable security inputs", async () => {
    const ctx = await evaluate(validEvidence());
    expect(ctx.preAdmission.passed).toBe(true);

    // No verified flow: Gate 11 passes, the flow gates reject.
    const noFlow = entry(ctx, { flowProvider: new UnavailableCandidateFlowProvider() });
    expect(gate11(noFlow)?.passed).toBe(true);
    expect(noFlow.outcome).toBe("BUY_GATE_REJECTED");
    expect(noFlow.rejectionReason).not.toMatch(/RUGCHECK|BUNDLER|TOP_10|HOLDERS/);

    // Live liquidity below the unchanged floor rejects before the buy gates.
    const thin = entry(ctx, { liquidityUsd: 19_999 });
    expect(thin.outcome).toBe("INSUFFICIENT_LIVE_LIQUIDITY");

    // The composition itself never claims admission.
    expect(ctx.evidenceBoundary.strategyGateAdmitted).toBe(false);
    expect(ctx.lp.screening?.evidenceBoundary.strategyGateAdmitted).toBe(false);
  });

  it("S-10: construction and evaluation perform no I/O, timers or environment reads", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers();
    try {
      const ctx = await evaluate(validEvidence());
      expect(ctx.status).toBe("EVALUATED");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(fetchSpy).not.toHaveBeenCalled();

    const source = readFileSync(
      fileURLToPath(new URL("./PaperCandidateSecurityContext.ts", import.meta.url)),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      /\bfetch\(/,
      /setTimeout|setInterval/,
      /process\.env/,
      /from "node:(fs|net|http|https)"/,
      /WebSocket/,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
