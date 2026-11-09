/**
 * Opt-in PAPER active-window flow qualification (offline, synthetic).
 *
 * All candidate, price, security, and transaction inputs here are SYNTHETIC and labelled as such.
 * Time is a synthetic clock; no network, sockets, or captures are used.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateExactPoolWindowReconciliation,
  toCandidateFlowResult,
  DEFAULT_PROVIDER_INDEX_ASSUMPTIONS,
  DEFAULT_UNRESOLVED_UNCERTAINTIES,
  type ExactPoolWindowReconciliationOptions,
  type SourceCutoffEvidence,
  type WindowReconciliationResult,
} from "./ExactPoolWindowReconciliationEvaluator.js";
import { PaperReconciledCandidateFlowAdapter } from "./PaperReconciledCandidateFlowAdapter.js";
import {
  decodeRaydiumTransactionSwaps,
  type TrackedRaydiumPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import type {
  HistoryEnumerationResult,
  HistorySignatureRecord,
} from "./ExactPoolHistoryEnumerator.js";
import type { ResolvedSignatureRecord } from "./ExactPoolTransactionResolutionBridge.js";
import { RollingTradeFlowTracker, type TradeEvent } from "./RollingTradeFlowTracker.js";
import {
  evaluateCandidateDecisionPoints,
  validateAndSnapshotCandidateFlowResult,
  type CandidateFlowProvider,
} from "./CandidateFlowProvider.js";
import type { ArmedPullbackState } from "./BuyGateTriggerService.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import { CAPTURED_RAY_WSOL_IDENTITIES } from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import {
  buildSyntheticFailedTransactionResult,
  buildSyntheticSwapTransactionResult,
  SYNTHETIC_FAILED_TRANSACTION_ERROR,
} from "./fixtures/SyntheticRaydiumSwapTransactionFixture.js";
import { validateFailedTransactionEvidence } from "./ValidatedFailedTransactionEvidence.js";
import type { WatchlistCandidateItem } from "@nexustrade/shared";

const WSOL = "So11111111111111111111111111111111111111112";
const POOL: TrackedRaydiumPoolContext = Object.freeze({
  poolId: CAPTURED_RAY_WSOL_IDENTITIES.poolId,
  candidateTokenMint: CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!,
  quoteTokenMint: WSOL,
  baseVault: CAPTURED_RAY_WSOL_IDENTITIES.baseVault,
  quoteVault: CAPTURED_RAY_WSOL_IDENTITIES.quoteVault,
  baseMint: CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!,
  quoteMint: WSOL,
  orientation: "TOKEN_BASE_SOL_QUOTE",
});

// SYNTHETIC signatures (valid Base58, 64 bytes)
const SIG_ANCHOR =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const SIG_1 =
  "QHREMqhWG7eahNuQ2EzQqSYKLy8WH9jVerfLRJTttyPorHxQJDzMMcB1142poqJHzYyVSsijoS1U9222QBV6AbM";
const SIG_2 =
  "3aFt8NNc96JF5yMrpTToPy22vaANB9pc41ih3jc93jGonfarwpokoEu9BnF6nWKytqgDWCyBB92fqBMsGWSyvDmu";
const SIG_3 =
  "MNSAJVBNSy9HuwnmMFjG3xpVnBc47Hm4UuVUdLnvmm4P8BZ1yFaDqcekkoaAYMFMXjHsaGqRareXmjhKiLYEtMy";

// SYNTHETIC clock: cutoff T, window [T - 60 s, T]
const T = 1_791_931_000_000;
const CUTOFF_SLOT = 461_970_880;
const EPOCH = 1;

interface SyntheticTx {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly side: "BUY" | "SELL";
}

const ACTIVE_TXS: readonly SyntheticTx[] = [
  { signature: SIG_1, slot: 461_970_850, blockTime: T / 1000 - 50, side: "BUY" },
  { signature: SIG_2, slot: 461_970_860, blockTime: T / 1000 - 30, side: "BUY" },
  { signature: SIG_3, slot: 461_970_870, blockTime: T / 1000 - 10, side: "SELL" },
];

const ANCHOR: HistorySignatureRecord = {
  signature: SIG_ANCHOR,
  slot: 461_970_800,
  err: null,
  memo: null,
  blockTime: T / 1000 - 75,
  confirmationStatus: "finalized",
} as HistorySignatureRecord;

function cutoff(): SourceCutoffEvidence {
  return {
    sourceMethod: "getBlockTime",
    responseField: "result",
    commitment: "confirmed",
    provenance: "ON_CHAIN_BLOCK_TIME",
    slot: CUTOFF_SLOT,
    cutoffTimestampMs: T,
    retrievedAtMs: T + 400,
    responsePayload: { result: T / 1000 },
    requestContext: { slot: CUTOFF_SLOT },
  };
}

function history(txs: readonly SyntheticTx[], overrides: Partial<HistoryEnumerationResult> = {}) {
  return {
    outcome: "ANCHOR_WITNESSED",
    candidatePoolId: POOL.poolId,
    connectionEpoch: EPOCH,
    anchorWitnessed: true,
    knownAnchorSignature: SIG_ANCHOR,
    anchorRecord: ANCHOR,
    frozenTargetSignature: null,
    discoveredSignatures: txs.map(
      (t) =>
        ({
          signature: t.signature,
          slot: t.slot,
          err: null,
          memo: null,
          blockTime: t.blockTime,
          confirmationStatus: "confirmed",
        }) as HistorySignatureRecord,
    ),
    pagesQueried: 1,
    requestCount: 1,
    isProductionCompletenessEstablished: false,
    ...overrides,
  } as HistoryEnumerationResult;
}

/** Decodes each SYNTHETIC transaction with the existing decoder (JSON round-trip as if sealed). */
function decodeAll(txs: readonly SyntheticTx[]) {
  const resolutions: ResolvedSignatureRecord[] = [];
  const trades: TradeEvent[] = [];
  for (const t of txs) {
    const payload = JSON.parse(
      JSON.stringify(buildSyntheticSwapTransactionResult({ poolContext: POOL, ...t })),
    );
    const decoded = decodeRaydiumTransactionSwaps(payload, POOL, {
      receiptTimestampMs: t.blockTime * 1000 + 500,
    });
    if (!decoded.ok) throw new Error(`fixture decode failed: ${decoded.message}`);
    resolutions.push({
      signature: t.signature,
      slot: t.slot,
      blockTime: t.blockTime,
      status: "RESOLVED",
      adapterOutcome: "SUCCESS",
      decodedEventsCount: decoded.events.length,
      ingestedEventsCount: decoded.events.length,
    });
    trades.push(...decoded.events);
  }
  return { resolutions, trades };
}

/** Tracker with no heartbeats (as in the diagnostic): the local inactivity heuristic fires at evaluation. */
function silentTracker() {
  return new RollingTradeFlowTracker({
    poolId: POOL.poolId,
    tokenMint: POOL.candidateTokenMint,
    clock: () => T - 65_000,
  });
}

function evaluate(
  overrides: Partial<ExactPoolWindowReconciliationOptions> = {},
  txs: readonly SyntheticTx[] = ACTIVE_TXS,
): WindowReconciliationResult {
  const { resolutions, trades } = decodeAll(txs);
  return evaluateExactPoolWindowReconciliation({
    poolContext: POOL,
    sourceCutoff: cutoff(),
    knownAnchorSignature: SIG_ANCHOR,
    historyResult: history(txs),
    tracker: silentTracker(),
    expectedConnectionEpoch: EPOCH,
    observationStartMs: T - 65_000,
    observationEndMs: T + 500,
    decisionTimestampMs: T + 3_000,
    maxAllowedEvidenceAgeMs: 15_000,
    budgetManager: new GlobalResourceBudgetManager({
      maxTotalRequests: 14,
      maxEnrichmentAttempts: 14,
      minReservedForwardRequests: 0,
      minProviderSpacingMs: 2500,
    }),
    resolvedSignatures: resolutions,
    trades,
    paperQuietStreamPolicy: { enabled: true, executionContext: "PAPER_SIMULATION" },
    paperActiveWindowPolicy: { enabled: true, executionContext: "PAPER_SIMULATION" },
    ...overrides,
  });
}

const adapter = new PaperReconciledCandidateFlowAdapter();
const target = { poolAddress: POOL.poolId, tokenMint: POOL.candidateTokenMint };
const convertActive = (r: WindowReconciliationResult, atMs = T + 4_000) =>
  adapter.convertCandidateFlow(r, target, atMs, {
    executionContext: "PAPER_SIMULATION",
    maxAllowedEvidenceAgeMs: 15_000,
    allowActiveWindowQualification: true,
  });

// SYNTHETIC micro-cap candidate, price, and security context that passes every Buy Gate with verified flow.
const SYNTHETIC_CANDIDATE: WatchlistCandidateItem = {
  poolId: POOL.poolId,
  mintAddress: POOL.candidateTokenMint,
  symbol: "SYNTH",
  liquidityUsd: 65_000,
  marketCapUsd: 250_000,
  lmcRatio: 0.26,
  lpBurnPct: 99.9,
  assetAgeSeconds: 600,
  volume5mUsd: 15_000,
  buys5m: 40,
  sells5m: 15,
  buyToSellRatio: 40 / 15,
  status: "WATCHING",
  discoveredAt: new Date(T - 120_000).toISOString(),
  lastEvaluatedAt: new Date(T).toISOString(),
} as WatchlistCandidateItem;
const SYNTHETIC_RUG_METRICS = {
  rugScore: 150,
  hasDangerRisk: false,
  top10HolderPct: 0.09,
  holdersCount: 450,
  bundlerPct: 0.05,
};
const PEAK_SOL = 0.0001;
// SYNTHETIC: armed 30 s earlier at the peak; current price is a 12% pullback (micro-cap 10–15% band).
const ARMED_STATE: ArmedPullbackState = {
  mintAddress: POOL.candidateTokenMint,
  armedAtMs: T - 26_000,
  peakPriceSol: PEAK_SOL,
  peakPriceUsd: 0.015,
  ticksObserved: 1,
};
const PULLBACK_SPOT = {
  spotPriceSol: PEAK_SOL * 0.88,
  spotPriceUsd: 0.0132,
  liquidityUsd: 65_000,
  momentum5mBps: 0,
  priceChange1hPct: 4.2,
};

function decide(
  recon: WindowReconciliationResult,
  opts: { armed?: ArmedPullbackState; rugMetrics?: typeof SYNTHETIC_RUG_METRICS } = {},
) {
  const flowProvider: CandidateFlowProvider = {
    getCandidateFlow: (t, evalMs) =>
      adapter.convertCandidateFlow(recon, t, evalMs, {
        executionContext: "PAPER_SIMULATION",
        maxAllowedEvidenceAgeMs: 15_000,
        allowActiveWindowQualification: true,
      }),
  };
  return evaluateCandidateDecisionPoints({
    candidate: SYNTHETIC_CANDIDATE,
    baseSpotInfo: PULLBACK_SPOT,
    rugMetrics: opts.rugMetrics ?? SYNTHETIC_RUG_METRICS,
    flowProvider,
    existingArmedState: opts.armed,
    currentNowMs: T + 4_000,
    requireVerifiedHolders: true,
    executionContext: "PAPER_SIMULATION",
  });
}

describe("PAPER active-window qualification (opt-in, synthetic)", () => {
  it("A1. Fully resolved active window qualifies with distinct provenance and exact decoded counts", () => {
    const r = evaluate();
    expect(r.status).toBe("RECONCILED");
    expect(r.paperActiveWindowQualified).toBe(true);
    expect(r.paperQualificationKind).toBe("ACTIVE_WINDOW");
    expect(r.paperQuietStreamQualified).toBe(false);
    expect(r.paperValidatedEpoch).toBe(EPOCH);
    expect(r.flowCounts.recentBuys60s).toBe(2);
    expect(r.flowCounts.recentSells60s).toBe(1);
    expect(r.underlyingOutcomes.windowSignaturesCount).toBe(3);
    expect(r.isProductionCompletenessEstablished).toBe(false);
    expect(r.isCryptographicCompletenessEstablished).toBe(false);
    expect(r.providerAssumptions).toEqual(DEFAULT_PROVIDER_INDEX_ASSUMPTIONS);
    expect(r.unresolvedUncertainties).toEqual(DEFAULT_UNRESOLVED_UNCERTAINTIES);

    const flow = convertActive(r);
    expect(flow.isCoverageSufficient).toBe(true);
    expect(flow.recentBuys60s).toBe(2);
    expect(flow.recentSells60s).toBe(1);
    expect(flow.paperQualificationContext?.qualificationKind).toBe("ACTIVE_WINDOW");
    expect(flow.paperQualificationContext?.providerAssumptions).toEqual(
      DEFAULT_PROVIDER_INDEX_ASSUMPTIONS,
    );

    // Production conversion guard unchanged.
    const production = toCandidateFlowResult(r);
    expect(production.flowCoverage).toBe("COLLECTION_GAP");
    expect(production.recentBuys60s).toBeNull();
  });

  it("A2. Active flow reaches RETEST_CONFIRMED through the existing decision/retest path; a quiet window cannot", () => {
    const active = evaluate();
    expect(decide(active).outcome).toBe("ARMED_FIRST_TICK");
    const confirmed = decide(active, { armed: ARMED_STATE });
    expect(confirmed.outcome).toBe("RETEST_CONFIRMED");
    expect(confirmed.retestResult?.status).toBe("CONFIRMED");
    if (confirmed.outcome === "RETEST_CONFIRMED") {
      expect(confirmed.retestResult.confirmReason).toBe("RETEST_PULLBACK_DISCOUNT");
    }
    expect(confirmed.flowResult.recentBuys60s).toBe(2);
    expect(confirmed.flowResult.recentSells60s).toBe(1);

    // Quiet window (0/0, quiet policy) cannot confirm: retest rules require verified buys > 0.
    const quiet = evaluate({ historyResult: history([]), resolvedSignatures: [], trades: [] }, []);
    expect(quiet.paperQuietStreamQualified).toBe(true);
    expect(quiet.paperQualificationKind).toBe("QUIET_WINDOW");
    const quietDecision = decide(quiet, { armed: ARMED_STATE });
    expect(quietDecision.flowResult.recentBuys60s).toBe(0);
    expect(quietDecision.outcome).toBe("RETEST_WAITING");
  });

  it("A3. Qualified active flow does not override another failed admission gate", () => {
    const blocked = decide(evaluate(), {
      armed: ARMED_STATE,
      rugMetrics: { ...SYNTHETIC_RUG_METRICS, rugScore: 900 },
    });
    expect(blocked.outcome).toBe("BUY_GATE_REJECTED");
    expect(blocked.retestResult).toBeUndefined();
    expect(blocked.flowResult.recentBuys60s).toBe(2);
  });

  it("A4. Missing, failed, budget-denied, or contradictory resolution evidence stays unavailable (never zero)", () => {
    const { resolutions, trades } = decodeAll(ACTIVE_TXS);
    const cases: Array<[string, Partial<ExactPoolWindowReconciliationOptions>, string]> = [
      ["missing", { resolvedSignatures: resolutions.slice(1), trades }, "UNRESOLVED_TRANSACTIONS"],
      [
        "failed decode",
        {
          resolvedSignatures: [
            { ...resolutions[0]!, status: "FAILED_DECODE", decodedEventsCount: 0 },
            ...resolutions.slice(1),
          ],
          trades: trades.slice(1),
        },
        "UNRESOLVED_TRANSACTIONS",
      ],
      [
        "budget denied",
        {
          resolvedSignatures: [
            { ...resolutions[0]!, status: "BUDGET_DENIED", decodedEventsCount: 0 },
            ...resolutions.slice(1),
          ],
          trades: trades.slice(1),
        },
        "UNRESOLVED_TRANSACTIONS",
      ],
      [
        "missing decoded event",
        { resolvedSignatures: resolutions, trades: trades.slice(1) },
        "INSUFFICIENT_DIRECTIONAL_EVIDENCE",
      ],
    ];
    for (const [label, overrides, status] of cases) {
      const r = evaluate(overrides);
      expect(r.status, label).toBe(status);
      expect(r.flowCounts.recentBuys60s, label).toBeNull();
      expect(r.paperActiveWindowQualified, label).toBeUndefined();
      const flow = convertActive(r);
      expect(flow.isCoverageSufficient, label).toBe(false);
      expect(flow.recentBuys60s, label).toBeNull();
    }
  });

  it("A5. Duplicate decoded events count once; foreign identity, slot, or epoch mismatches fail closed", () => {
    const { resolutions, trades } = decodeAll(ACTIVE_TXS);
    const duplicated = evaluate({
      resolvedSignatures: resolutions,
      trades: [...trades, trades[0]!],
    });
    expect(duplicated.paperActiveWindowQualified).toBe(true);
    expect(duplicated.flowCounts.recentBuys60s).toBe(2);
    expect(duplicated.flowCounts.recentSells60s).toBe(1);

    const foreign = evaluate({
      resolvedSignatures: resolutions,
      trades: [{ ...trades[0]!, tokenMint: WSOL }, ...trades.slice(1)],
    });
    expect(foreign.status).toBe("INSUFFICIENT_DIRECTIONAL_EVIDENCE");

    const slotMismatch = evaluate({
      resolvedSignatures: [{ ...resolutions[0]!, slot: 1 }, ...resolutions.slice(1)],
      trades,
    });
    expect(slotMismatch.status).toBe("IDENTITY_MISMATCH");

    const wrongEpoch = evaluate({ expectedConnectionEpoch: 2 });
    expect(wrongEpoch.status).toBe("IDENTITY_MISMATCH");
    const noEpoch = evaluate({ expectedConnectionEpoch: undefined });
    expect(noEpoch.status).toBe("IDENTITY_MISMATCH");
    for (const r of [foreign, slotMismatch, wrongEpoch, noEpoch]) {
      expect(r.flowCounts.recentBuys60s).toBeNull();
      expect(r.paperActiveWindowQualified).toBeUndefined();
    }
  });

  it("A6. Recorded gaps, backlog, stale/future evidence, and exhausted enumeration fail closed", () => {
    const gap = evaluate({
      recordedGaps: [
        { gapStartMs: T - 40_000, gapEndMs: T - 35_000, reason: "SYNTHETIC_DISCONNECT" },
      ],
    });
    expect(gap.status).toBe("STREAM_GAP"); // full resolution (backfill) does not erase a recorded gap

    expect(evaluate({ hasActiveBacklog: true }).status).toBe("PROCESSING_BACKLOG");
    expect(evaluate({ decisionTimestampMs: T + 15_001 }).status).toBe("STALE_DATA");
    expect(evaluate({ decisionTimestampMs: T - 1, observationEndMs: T - 2 }).status).toBe(
      "FUTURE_DATED_EVIDENCE",
    );
    expect(
      evaluate({ historyResult: history(ACTIVE_TXS, { outcome: "BUDGET_EXHAUSTED" }) }).status,
    ).toBe("BUDGET_EXHAUSTED");
    expect(
      evaluate({
        historyResult: undefined,
        historyRecords: history(ACTIVE_TXS).discoveredSignatures,
      }).paperActiveWindowQualified,
    ).toBeUndefined();

    // Conversion-time freshness is rechecked against the unchanged 15,000 ms ceiling.
    const staleConversion = convertActive(evaluate(), T + 15_001);
    expect(staleConversion.flowCoverage).toBe("STALE_DATA");
    expect(staleConversion.recentBuys60s).toBeNull();
  });

  it("A7. Default and production behavior stay protected", () => {
    // No active opt-in: the existing inactivity heuristic still rejects active windows.
    const noOptIn = evaluate({ paperActiveWindowPolicy: undefined });
    expect(noOptIn.status).toBe("STREAM_GAP");
    expect(noOptIn.paperActiveWindowQualified).toBeUndefined();

    // Active policy under PRODUCTION context is not an opt-in.
    const production = evaluate({
      paperQuietStreamPolicy: undefined,
      paperActiveWindowPolicy: { enabled: true, executionContext: "PRODUCTION" },
    });
    expect(production.status).toBe("STREAM_GAP");

    // Active opt-in alone does not grant quiet-window qualification.
    const quietWithoutQuietPolicy = evaluate(
      {
        historyResult: history([]),
        resolvedSignatures: [],
        trades: [],
        paperQuietStreamPolicy: undefined,
      },
      [],
    );
    expect(quietWithoutQuietPolicy.status).toBe("STREAM_GAP");
    expect(quietWithoutQuietPolicy.paperQuietStreamQualified).toBe(false);

    // Adapter default (no allowActiveWindowQualification) remains quiet-only.
    const active = evaluate();
    const defaultConversion = adapter.convertCandidateFlow(active, target, T + 4_000, {
      executionContext: "PAPER_SIMULATION",
    });
    expect(defaultConversion.isCoverageSufficient).toBe(false);
    expect(defaultConversion.diagnosticReason).toContain("ACTIVE_WINDOW_NOT_OPTED_IN");

    // Adapter rejects non-PAPER contexts; consumption rejects PAPER evidence in default/production mode.
    const prodConversion = adapter.convertCandidateFlow(active, target, T + 4_000, {
      executionContext: "PRODUCTION" as "PAPER_SIMULATION",
      allowActiveWindowQualification: true,
    });
    expect(prodConversion.isCoverageSufficient).toBe(false);
    const snapshot = validateAndSnapshotCandidateFlowResult(
      convertActive(active),
      target,
      T + 4_000,
    );
    expect(snapshot.isCoverageSufficient).toBe(false);
    expect(snapshot.diagnosticReason).toContain("PAPER_QUALIFIED_EVIDENCE_REJECTED_IN_PRODUCTION");

    // Consumption: a quiet-kind context with non-zero counts is rejected.
    const forged = { ...convertActive(active) };
    const forgedCtx = {
      ...forged.paperQualificationContext!,
      qualificationKind: "QUIET_WINDOW" as const,
    };
    const forgedSnapshot = validateAndSnapshotCandidateFlowResult(
      { ...forged, paperQualificationContext: forgedCtx },
      target,
      T + 4_000,
      { executionContext: "PAPER_SIMULATION" },
    );
    expect(forgedSnapshot.isCoverageSufficient).toBe(false);
  });
});

describe("PAPER active-window: validated failed on-chain transactions (opt-in, synthetic)", () => {
  interface FailedTx {
    readonly signature: string;
    readonly slot: number;
    readonly blockTime: number;
  }
  const FAILED_2: FailedTx = { signature: SIG_2, slot: 461_970_860, blockTime: T / 1000 - 30 };
  const SWAPS_1_3 = ACTIVE_TXS.filter((t) => t.signature !== SIG_2);

  /** Validates the SYNTHETIC failed payload with the shared validator (JSON round-trip as if sealed). */
  function knownFailedRecord(t: FailedTx): ResolvedSignatureRecord {
    const payload: unknown = JSON.parse(
      JSON.stringify(buildSyntheticFailedTransactionResult({ poolContext: POOL, ...t })),
    );
    const v = validateFailedTransactionEvidence({
      payload,
      expectedSignature: t.signature,
      poolContext: POOL,
    });
    if (!v.ok) throw new Error(`fixture validation failed: ${v.reason}`);
    return {
      signature: t.signature,
      slot: t.slot,
      blockTime: t.blockTime,
      status: "RESOLVED_FAILED_TRANSACTION",
      adapterOutcome: "KNOWN_FAILED_TRANSACTION",
      decodedEventsCount: 0,
      ingestedEventsCount: 0,
      knownFailedTransaction: v.value,
    };
  }

  /** History in which failed signatures carry their transaction error, as getSignaturesForAddress reports. */
  function historyWithFailures(
    swaps: readonly SyntheticTx[],
    failed: readonly FailedTx[],
    mutate: (r: HistorySignatureRecord) => HistorySignatureRecord = (r) => r,
  ): HistoryEnumerationResult {
    const h = history([...swaps, ...failed.map((f) => ({ ...f, side: "BUY" as const }))]);
    const failedSigs = new Set(failed.map((f) => f.signature));
    return {
      ...h,
      discoveredSignatures: h.discoveredSignatures.map((r) =>
        failedSigs.has(r.signature)
          ? mutate({ ...r, err: JSON.parse(JSON.stringify(SYNTHETIC_FAILED_TRANSACTION_ERROR)) })
          : r,
      ),
    } as HistoryEnumerationResult;
  }

  function evalFailed(
    swaps: readonly SyntheticTx[],
    failed: readonly FailedTx[],
    overrides: Partial<ExactPoolWindowReconciliationOptions> = {},
  ): WindowReconciliationResult {
    const { resolutions, trades } = decodeAll(swaps);
    return evaluate(
      {
        historyResult: historyWithFailures(swaps, failed),
        resolvedSignatures: [...resolutions, ...failed.map(knownFailedRecord)],
        trades,
        ...overrides,
      },
      swaps,
    );
  }

  const expectUnavailable = (r: WindowReconciliationResult, label: string) => {
    expect(r.flowCounts.recentBuys60s, label).toBeNull();
    expect(r.flowCounts.recentSells60s, label).toBeNull();
    expect(r.paperActiveWindowQualified, label).toBeUndefined();
    expect(convertActive(r).isCoverageSufficient, label).toBe(false);
  };

  it("F1. A failed-only window is non-quiet activity with 0 buys / 0 sells and cannot confirm a retest", () => {
    const r = evalFailed([], [FAILED_2]);
    expect(r.status).toBe("RECONCILED");
    expect(r.paperActiveWindowQualified).toBe(true);
    expect(r.paperQualificationKind).toBe("ACTIVE_WINDOW");
    expect(r.paperQuietStreamQualified).toBe(false);
    expect(r.underlyingOutcomes.windowSignaturesCount).toBe(1);
    expect(r.flowCounts.recentBuys60s).toBe(0);
    expect(r.flowCounts.recentSells60s).toBe(0);
    expect(r.flowCounts.flowRatio).toBe(1.0); // existing 0/0 convention, unchanged
    expect(r.paperQualificationReason).toContain(
      "1 validated failed on-chain transaction(s) contributed zero committed swaps",
    );
    expect(r.isProductionCompletenessEstablished).toBe(false);

    const flow = convertActive(r);
    expect(flow.isCoverageSufficient).toBe(true);
    expect(flow.recentBuys60s).toBe(0);
    expect(flow.recentSells60s).toBe(0);
    expect(flow.paperQualificationContext?.qualificationKind).toBe("ACTIVE_WINDOW");

    // Existing retest rules require verified buys > 0: no confirmation from a failed-only window.
    const decision = decide(r, { armed: ARMED_STATE });
    expect(decision.outcome).toBe("RETEST_WAITING");
    expect(decision.retestResult?.status).not.toBe("CONFIRMED");

    // Production conversion guard unchanged.
    expect(toCandidateFlowResult(r).recentBuys60s).toBeNull();
  });

  it("F2. Mixed failed/successful windows count only decoded swaps; trades attributed to a failed signature fail closed", () => {
    const r = evalFailed(SWAPS_1_3, [FAILED_2]);
    expect(r.status).toBe("RECONCILED");
    expect(r.paperActiveWindowQualified).toBe(true);
    expect(r.underlyingOutcomes.windowSignaturesCount).toBe(3);
    expect(r.flowCounts.recentBuys60s).toBe(1);
    expect(r.flowCounts.recentSells60s).toBe(1);
    expect(convertActive(r).recentBuys60s).toBe(1);

    // A manufactured trade event for the failed signature contradicts its zero committed swaps.
    const { trades } = decodeAll(SWAPS_1_3);
    const forged = { ...trades[0]!, signature: SIG_2, slot: FAILED_2.slot };
    const forgedResult = evalFailed(SWAPS_1_3, [FAILED_2], { trades: [...trades, forged] });
    expect(forgedResult.status).toBe("INSUFFICIENT_DIRECTIONAL_EVIDENCE");
    expectUnavailable(forgedResult, "forged trade");
  });

  it("F3. Without the explicit PAPER opt-in, or with incomplete/unsupported evidence, the window stays unavailable", () => {
    const base = knownFailedRecord(FAILED_2);
    const { resolutions, trades } = decodeAll(SWAPS_1_3);
    const withRecord = (rec: ResolvedSignatureRecord) => ({
      resolvedSignatures: [...resolutions, rec],
      trades,
    });
    const kft = base.knownFailedTransaction!;
    const cases: Array<[string, Partial<ExactPoolWindowReconciliationOptions>]> = [
      ["no active opt-in", { paperActiveWindowPolicy: undefined }],
      [
        "production context",
        {
          paperQuietStreamPolicy: undefined,
          paperActiveWindowPolicy: { enabled: true, executionContext: "PRODUCTION" },
        },
      ],
      [
        "default decode failure",
        withRecord({ ...base, status: "FAILED_DECODE", adapterOutcome: "DECODE_FAILED" }),
      ],
      ["label without evidence", withRecord({ ...base, knownFailedTransaction: undefined })],
      ["wrong adapter outcome", withRecord({ ...base, adapterOutcome: "DECODE_FAILED" })],
      ["nonzero decoded count", withRecord({ ...base, decodedEventsCount: 1 })],
      [
        "unsupported policy",
        withRecord({ ...base, knownFailedTransaction: { ...kft, policy: "OTHER" as never } }),
      ],
      [
        "empty-object error",
        withRecord({
          ...base,
          knownFailedTransaction: { ...kft, onChainError: {}, onChainErrorCanonical: "{}" },
        }),
      ],
      [
        "error inconsistent with its canonical form",
        withRecord({
          ...base,
          knownFailedTransaction: {
            ...kft,
            onChainError: { InstructionError: [0, { Custom: 31 }] },
          },
        }),
      ],
      [
        "evidence for another signature",
        withRecord({ ...base, knownFailedTransaction: { ...kft, signature: SIG_1 } }),
      ],
      ["missing blockTime", withRecord({ ...base, blockTime: null })],
    ];
    for (const [label, overrides] of cases) {
      const r = evalFailed(SWAPS_1_3, [FAILED_2], overrides);
      expect(r.status, label).not.toBe("RECONCILED");
      expectUnavailable(r, label);
    }
  });

  it("F4. Frozen history, slot/time, and connection-epoch contradictions fail closed as identity mismatches", () => {
    const withHistory = (mutate: (r: HistorySignatureRecord) => HistorySignatureRecord) =>
      evalFailed(SWAPS_1_3, [FAILED_2], {
        historyResult: historyWithFailures(SWAPS_1_3, [FAILED_2], mutate),
      });
    const cases: Array<[string, WindowReconciliationResult]> = [
      ["history reports success", withHistory((r) => ({ ...r, err: null }))],
      [
        "history reports a different error",
        withHistory((r) => ({ ...r, err: { InstructionError: [0, { Custom: 31 }] } })),
      ],
      ["history slot differs", withHistory((r) => ({ ...r, slot: r.slot + 1 }))],
      [
        "history blockTime differs",
        withHistory((r) => ({ ...r, blockTime: (r.blockTime as number) - 1 })),
      ],
      ["epoch mismatch", evalFailed(SWAPS_1_3, [FAILED_2], { expectedConnectionEpoch: 2 })],
    ];
    for (const [label, r] of cases) {
      expect(r.status, label).toBe("IDENTITY_MISMATCH");
      expectUnavailable(r, label);
    }
  });

  it("F5. Recorded gaps, backlog, stale evidence, and exhausted enumeration remain blocking", () => {
    const cases: Array<[string, Partial<ExactPoolWindowReconciliationOptions>, string]> = [
      [
        "recorded gap",
        {
          recordedGaps: [
            { gapStartMs: T - 40_000, gapEndMs: T - 35_000, reason: "SYNTHETIC_DISCONNECT" },
          ],
        },
        "STREAM_GAP",
      ],
      ["backlog", { hasActiveBacklog: true }, "PROCESSING_BACKLOG"],
      ["stale", { decisionTimestampMs: T + 15_001 }, "STALE_DATA"],
      [
        "exhausted enumeration",
        {
          historyResult: {
            ...historyWithFailures(SWAPS_1_3, [FAILED_2]),
            outcome: "BUDGET_EXHAUSTED",
          } as HistoryEnumerationResult,
        },
        "BUDGET_EXHAUSTED",
      ],
    ];
    for (const [label, overrides, status] of cases) {
      const r = evalFailed(SWAPS_1_3, [FAILED_2], overrides);
      expect(r.status, label).toBe(status);
      expectUnavailable(r, label);
    }
    // Conversion-time freshness is rechecked against the unchanged 15,000 ms ceiling.
    const stale = convertActive(evalFailed([], [FAILED_2]), T + 15_001);
    expect(stale.flowCoverage).toBe("STALE_DATA");
    expect(stale.recentBuys60s).toBeNull();
  });
});
