/**
 * Phase 12.94-D Milestone D.3.3: Candidate Flow Provider & Evaluation Seam
 *
 * Side-effect-free module defining the injectable flow provider interface and reusable
 * coordinator bridge connecting candidate trade flow observation to daemon evaluation.
 *
 * Operational and Safety Invariants:
 * 1. Strict Candidate Identity Binding:
 *    - Validates exact, case-sensitive candidate pool address and candidate token mint.
 *    - Rejects identity mismatches fail-closed with explicit diagnostic reasons.
 * 2. Fail-Closed on Missing/Invalid/Incomplete Flow:
 *    - Missing providers, lookup exceptions, coordinator exceptions, invalid numeric counts,
 *      or non-SUFFICIENT coverage strictly return unavailable (null) counts and non-SUFFICIENT status.
 *    - Never falls back to five-minute division estimates or substitutes zero for missing flow.
 * 3. Legitimate Zero Count Preservation:
 *    - When flow coverage is genuinely SUFFICIENT and zero swaps are observed in the lookback window,
 *      the legitimate numeric 0 is preserved as distinct from unavailable (null) counts.
 * 4. Unified Decision Point Binding:
 *    - Candidate Buy Gate and Retest Gate consume the identical candidate-bound flow result.
 * 5. Production Source Completeness Separation:
 *    - Production-default coordinators strictly retain unavailable (null) flow counts unless
 *      explicitly configured in isolated synthetic test fixtures (allowSyntheticCompletenessProofs: true).
 *    - No environment variable or CLI flag is permitted to bypass production completeness protections.
 */

import type { WatchlistCandidateItem } from "@nexustrade/shared";
import type {
  FlowCoverageStatus,
  RetestSpotInfo,
  RetestGateResult,
} from "./RetestGateEvaluator.js";
import { evaluateRetestGate } from "./RetestGateEvaluator.js";
import {
  BuyGateTriggerService,
  type ArmedPullbackState,
  type AdvancedMarketContext,
  type BuyGateEvaluationResult,
} from "./BuyGateTriggerService.js";
import type {
  RaydiumCandidateSubscriptionCoordinator,
  CoordinatorCoverageDiagnostic,
} from "./RaydiumCandidateSubscriptionCoordinator.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";

/**
 * Candidate pool and token mint coordinates.
 */
export interface CandidateFlowTarget {
  readonly poolAddress: string;
  readonly tokenMint: string;
}

/**
 * Candidate flow resolution result.
 */
export interface CandidateFlowResult {
  readonly poolAddress: string;
  readonly tokenMint: string;
  readonly recentBuys60s: number | null;
  readonly recentSells60s: number | null;
  readonly flowCoverage: FlowCoverageStatus | "UNAVAILABLE";
  readonly isCoverageSufficient: boolean;
  readonly diagnosticReason: string;
  readonly evaluationTimestampMs: number;
}

/**
 * Injectable flow provider interface for candidate flow observation.
 */
export interface CandidateFlowProvider {
  getCandidateFlow(target: CandidateFlowTarget, evaluationTimestampMs: number): CandidateFlowResult;
}

/**
 * Default fail-closed flow provider when no active coordinator or provider is configured.
 */
export class UnavailableCandidateFlowProvider implements CandidateFlowProvider {
  public getCandidateFlow(
    target: CandidateFlowTarget,
    evaluationTimestampMs: number,
  ): CandidateFlowResult {
    return {
      poolAddress: target?.poolAddress ?? "",
      tokenMint: target?.tokenMint ?? "",
      recentBuys60s: null,
      recentSells60s: null,
      flowCoverage: "COLLECTION_GAP",
      isCoverageSufficient: false,
      diagnosticReason: "NO_FLOW_PROVIDER_CONFIGURED",
      evaluationTimestampMs,
    };
  }
}

/**
 * Lookup source for coordinator instances.
 */
export type CoordinatorLookup =
  | RaydiumCandidateSubscriptionCoordinator
  | ((poolAddress: string) => RaydiumCandidateSubscriptionCoordinator | undefined)
  | ReadonlyMap<string, RaydiumCandidateSubscriptionCoordinator>;

/**
 * Reusable implementation bridging RaydiumCandidateSubscriptionCoordinator.
 */
export class CoordinatorCandidateFlowProvider implements CandidateFlowProvider {
  private readonly lookup: (
    poolAddress: string,
  ) => RaydiumCandidateSubscriptionCoordinator | undefined;

  constructor(resolver?: CoordinatorLookup | undefined) {
    if (!resolver) {
      this.lookup = () => undefined;
    } else if (typeof resolver === "function") {
      this.lookup = resolver;
    } else if (typeof (resolver as { get?: unknown }).get === "function") {
      const map = resolver as ReadonlyMap<string, RaydiumCandidateSubscriptionCoordinator>;
      this.lookup = (addr: string) => map.get(addr);
    } else {
      const single = resolver as RaydiumCandidateSubscriptionCoordinator;
      this.lookup = (addr: string) => {
        try {
          return single.getPoolContext().poolId === addr ? single : undefined;
        } catch {
          return undefined;
        }
      };
    }
  }

  public getCandidateFlow(
    target: CandidateFlowTarget,
    evaluationTimestampMs: number,
  ): CandidateFlowResult {
    // 1. Target validation
    if (
      !target ||
      typeof target.poolAddress !== "string" ||
      typeof target.tokenMint !== "string" ||
      !target.poolAddress.trim() ||
      !target.tokenMint.trim()
    ) {
      return {
        poolAddress: target?.poolAddress ?? "",
        tokenMint: target?.tokenMint ?? "",
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: "INVALID_TARGET_COORDINATES",
        evaluationTimestampMs,
      };
    }

    // 2. Timestamp validation
    if (
      !Number.isFinite(evaluationTimestampMs) ||
      !Number.isInteger(evaluationTimestampMs) ||
      evaluationTimestampMs < 0
    ) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: "INVALID_EVALUATION_TIMESTAMP",
        evaluationTimestampMs,
      };
    }

    // 3. Resolve coordinator
    let coordinator: RaydiumCandidateSubscriptionCoordinator | undefined;
    try {
      coordinator = this.lookup(target.poolAddress);
    } catch (lookupErr) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `PROVIDER_LOOKUP_EXCEPTION: ${lookupErr instanceof Error ? lookupErr.message : String(lookupErr)}`,
        evaluationTimestampMs,
      };
    }

    if (!coordinator) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `NO_COORDINATOR_FOR_POOL: ${target.poolAddress}`,
        evaluationTimestampMs,
      };
    }

    // 4. Validate exact, case-sensitive identity
    let poolContext: TrackedRaydiumPoolContext;
    try {
      poolContext = coordinator.getPoolContext();
    } catch (contextErr) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `FAILED_TO_GET_POOL_CONTEXT: ${contextErr instanceof Error ? contextErr.message : String(contextErr)}`,
        evaluationTimestampMs,
      };
    }

    if (
      poolContext.poolId !== target.poolAddress ||
      poolContext.candidateTokenMint !== target.tokenMint
    ) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `IDENTITY_MISMATCH: requested pool=${target.poolAddress}, mint=${target.tokenMint} but coordinator is bound to pool=${poolContext.poolId}, mint=${poolContext.candidateTokenMint}`,
        evaluationTimestampMs,
      };
    }

    // 5. Query coordinator safely
    try {
      let diag: CoordinatorCoverageDiagnostic | undefined;
      try {
        diag = coordinator.getCoverageDiagnostic(evaluationTimestampMs);
      } catch {
        // If coverage diagnostic throws, proceed with fallback diagnostic
      }

      const dummySpot = { spotPriceSol: 1 };
      const spotWithFlow = coordinator.createRetestSpotInfo(dummySpot, evaluationTimestampMs);

      const isSufficient = spotWithFlow.flowCoverage === "SUFFICIENT";
      const buys = spotWithFlow.recentBuys60s;
      const sells = spotWithFlow.recentSells60s;

      const validCounts =
        buys !== null &&
        sells !== null &&
        Number.isInteger(buys) &&
        buys >= 0 &&
        Number.isInteger(sells) &&
        sells >= 0;

      if (isSufficient && validCounts) {
        return {
          poolAddress: target.poolAddress,
          tokenMint: target.tokenMint,
          recentBuys60s: buys,
          recentSells60s: sells,
          flowCoverage: "SUFFICIENT",
          isCoverageSufficient: true,
          diagnosticReason: diag?.limitationReason || "Coverage is sufficient",
          evaluationTimestampMs,
        };
      }

      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: (spotWithFlow.flowCoverage as FlowCoverageStatus) ?? "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: diag?.limitationReason || "INSUFFICIENT_FLOW_COVERAGE",
        evaluationTimestampMs,
      };
    } catch (evalErr) {
      return {
        poolAddress: target.poolAddress,
        tokenMint: target.tokenMint,
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: `COORDINATOR_EVALUATION_EXCEPTION: ${evalErr instanceof Error ? evalErr.message : String(evalErr)}`,
        evaluationTimestampMs,
      };
    }
  }
}

/**
 * Builds a RetestSpotInfo structure using base spot metrics overlaid with verified flow.
 */
export function buildRetestSpotInfo(
  baseSpot: {
    readonly spotPriceSol: number;
    readonly spotPriceUsd?: number | null | undefined;
    readonly liquidityUsd?: number | null | undefined;
  },
  flowResult: CandidateFlowResult,
): RetestSpotInfo {
  return {
    spotPriceSol: baseSpot.spotPriceSol,
    spotPriceUsd: baseSpot.spotPriceUsd,
    liquidityUsd: baseSpot.liquidityUsd,
    recentBuys60s: flowResult.recentBuys60s,
    recentSells60s: flowResult.recentSells60s,
    flowCoverage: flowResult.flowCoverage,
  };
}

/**
 * Parameters for evaluating both candidate decision points (Buy Gate and Retest Gate).
 */
export interface EvaluateCandidateDecisionParams {
  readonly candidate: WatchlistCandidateItem;
  readonly baseSpotInfo: {
    readonly spotPriceSol: number;
    readonly spotPriceUsd?: number | null | undefined;
    readonly liquidityUsd?: number | null | undefined;
    readonly momentum5mBps?: number | undefined;
    readonly priceChange1hPct?: number | undefined;
  };
  readonly rugMetrics?:
    | {
        readonly rugScore?: number | undefined;
        readonly hasDangerRisk?: boolean | undefined;
        readonly bundlerPct?: number | undefined;
        readonly top10HolderPct?: number | undefined;
        readonly holdersCount?: number | undefined;
      }
    | null
    | undefined;
  readonly flowProvider?: CandidateFlowProvider | undefined;
  readonly existingArmedState?: ArmedPullbackState | undefined;
  readonly currentNowMs: number;
  readonly buyGateService?: BuyGateTriggerService | undefined;
  readonly requireVerifiedHolders?: boolean | undefined;
}

/**
 * Structured outcome of the candidate evaluation helper.
 */
export type CandidateDecisionResult =
  | {
      readonly outcome: "INSUFFICIENT_LIVE_LIQUIDITY";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: false;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult?: undefined;
      readonly rejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY";
    }
  | {
      readonly outcome: "BUY_GATE_REJECTED";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult?: undefined;
      readonly rejectionReason: string;
    }
  | {
      readonly outcome: "ARMED_FIRST_TICK";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult: Extract<RetestGateResult, { status: "ARMED_FIRST_TICK" }>;
      readonly rejectionReason?: undefined;
    }
  | {
      readonly outcome: "RETEST_WAITING";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult: Extract<RetestGateResult, { status: "WAITING" }>;
      readonly rejectionReason?: undefined;
    }
  | {
      readonly outcome: "RETEST_REJECTED";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult: Extract<RetestGateResult, { status: "REJECTED" }>;
      readonly rejectionReason: string;
    }
  | {
      readonly outcome: "RETEST_CONFIRMED";
      readonly flowResult: CandidateFlowResult;
      readonly retestSpotInfo: RetestSpotInfo;
      readonly isLiveLiquiditySufficient: true;
      readonly isEstablished: boolean;
      readonly isViral: boolean;
      readonly requiredLiveLiq: number;
      readonly liveLiqUsd: number;
      readonly buyGateResult: BuyGateEvaluationResult;
      readonly retestResult: Extract<RetestGateResult, { status: "CONFIRMED" }>;
      readonly rejectionReason?: undefined;
    };

/**
 * Evaluates candidate decision points (Buy Gate and Retest Gate) using a candidate-bound flow provider.
 * Pure function: side-effects (state mutations, logging, alerts) remain in the caller.
 */
export function evaluateCandidateDecisionPoints(
  params: EvaluateCandidateDecisionParams,
): CandidateDecisionResult {
  const { candidate, baseSpotInfo, rugMetrics, existingArmedState, currentNowMs } = params;

  // 1. Resolve candidate-bound flow
  const target: CandidateFlowTarget = {
    poolAddress: candidate.poolId,
    tokenMint: candidate.mintAddress,
  };
  const provider = params.flowProvider ?? new UnavailableCandidateFlowProvider();
  let flowResult: CandidateFlowResult;
  try {
    flowResult = provider.getCandidateFlow(target, currentNowMs);
  } catch (providerErr) {
    flowResult = {
      poolAddress: candidate.poolId,
      tokenMint: candidate.mintAddress,
      recentBuys60s: null,
      recentSells60s: null,
      flowCoverage: "COLLECTION_GAP",
      isCoverageSufficient: false,
      diagnosticReason: `PROVIDER_CALL_EXCEPTION: ${providerErr instanceof Error ? providerErr.message : String(providerErr)}`,
      evaluationTimestampMs: currentNowMs,
    };
  }

  // 2. Construct RetestSpotInfo with candidate-bound flow overlay
  const retestSpotInfo = buildRetestSpotInfo(baseSpotInfo, flowResult);

  // 3. Established Runner & Viral Runner classification
  const isViral =
    candidate.liquidityUsd >= 30000 &&
    candidate.marketCapUsd >= 150000 &&
    candidate.assetAgeSeconds >= 900 &&
    candidate.assetAgeSeconds <= 7200;
  const isCandidateEstablished =
    ((candidate.liquidityUsd >= 50000 &&
      (baseSpotInfo.liquidityUsd ?? 0) >= 50000 &&
      candidate.assetAgeSeconds >= 1800) ||
      (isViral && (baseSpotInfo.liquidityUsd ?? 0) >= 30000)) &&
    candidate.assetAgeSeconds <= 7200 &&
    rugMetrics?.holdersCount !== undefined &&
    rugMetrics.holdersCount >= (isViral ? 1000 : 250);

  // 4. Live Spot Liquidity Floor Check
  const requiredLiveLiq = isCandidateEstablished ? (isViral ? 30000 : 50000) : 20000;
  const liveLiqUsd = baseSpotInfo.liquidityUsd ?? 0;
  if (liveLiqUsd < requiredLiveLiq) {
    return {
      flowResult,
      retestSpotInfo,
      isLiveLiquiditySufficient: false,
      isEstablished: isCandidateEstablished,
      isViral,
      requiredLiveLiq,
      liveLiqUsd,
      buyGateResult: {
        triggered: false,
        poolId: candidate.poolId,
        mintAddress: candidate.mintAddress,
        symbol: candidate.symbol,
        gates: [],
        rejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY",
      },
      outcome: "INSUFFICIENT_LIVE_LIQUIDITY",
      rejectionReason: "REJECTED_INSUFFICIENT_LIVE_LIQUIDITY",
    };
  }

  // 5. Evaluate Candidate Buy Gate (Decision Point 1)
  const buyGate = params.buyGateService ?? new BuyGateTriggerService();
  const marketContext: AdvancedMarketContext = {
    recentBuysCount60s: flowResult.recentBuys60s,
    recentSellsCount60s: flowResult.recentSells60s,
    flowCoverage: flowResult.flowCoverage,
    requireValidFlowCoverage: true,
    momentum1mBps:
      baseSpotInfo.momentum5mBps !== undefined ? Math.round(baseSpotInfo.momentum5mBps / 5) : 0,
    bundlerPct: rugMetrics?.bundlerPct,
    top10HolderPct: rugMetrics?.top10HolderPct,
    holdersCount: rugMetrics?.holdersCount,
    rugScore: rugMetrics?.rugScore,
    hasDangerRisk: rugMetrics?.hasDangerRisk,
    priceChange1hPct: baseSpotInfo.priceChange1hPct ?? 0,
    requireVerifiedHolders: params.requireVerifiedHolders ?? true,
  };

  const buyGateResult = buyGate.evaluateCandidate(candidate, marketContext);
  if (!buyGateResult.triggered) {
    return {
      flowResult,
      retestSpotInfo,
      isLiveLiquiditySufficient: true,
      isEstablished: isCandidateEstablished,
      isViral,
      requiredLiveLiq,
      liveLiqUsd,
      buyGateResult,
      outcome: "BUY_GATE_REJECTED",
      rejectionReason: buyGateResult.rejectionReason ?? "REJECTED_BUY_GATE_UNTRIGGERED",
    };
  }

  // 6. Evaluate Retest Gate (Decision Point 2)
  const retestResult = evaluateRetestGate({
    mintAddress: candidate.mintAddress,
    isEstablished: isCandidateEstablished,
    currentNowMs,
    spotInfo: retestSpotInfo,
    existingArmedState,
  });

  switch (retestResult.status) {
    case "ARMED_FIRST_TICK":
      return {
        flowResult,
        retestSpotInfo,
        isLiveLiquiditySufficient: true,
        isEstablished: isCandidateEstablished,
        isViral,
        requiredLiveLiq,
        liveLiqUsd,
        buyGateResult,
        retestResult,
        outcome: "ARMED_FIRST_TICK",
      };
    case "WAITING":
      return {
        flowResult,
        retestSpotInfo,
        isLiveLiquiditySufficient: true,
        isEstablished: isCandidateEstablished,
        isViral,
        requiredLiveLiq,
        liveLiqUsd,
        buyGateResult,
        retestResult,
        outcome: "RETEST_WAITING",
      };
    case "REJECTED":
      return {
        flowResult,
        retestSpotInfo,
        isLiveLiquiditySufficient: true,
        isEstablished: isCandidateEstablished,
        isViral,
        requiredLiveLiq,
        liveLiqUsd,
        buyGateResult,
        retestResult,
        outcome: "RETEST_REJECTED",
        rejectionReason: retestResult.rejectReason,
      };
    case "CONFIRMED":
      return {
        flowResult,
        retestSpotInfo,
        isLiveLiquiditySufficient: true,
        isEstablished: isCandidateEstablished,
        isViral,
        requiredLiveLiq,
        liveLiqUsd,
        buyGateResult,
        retestResult,
        outcome: "RETEST_CONFIRMED",
      };
  }
}
