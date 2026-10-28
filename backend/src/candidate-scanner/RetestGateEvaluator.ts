import type { ArmedPullbackState } from "./BuyGateTriggerService.js";

export type FlowCoverageStatus =
  | "SUFFICIENT"
  | "WARM_UP"
  | "COLLECTION_GAP"
  | "STALE_DATA"
  | "CAPACITY_LOSS"
  | "PROCESSING_BACKLOG"
  | "UNINITIALIZED";

export interface RetestSpotInfo {
  readonly spotPriceSol: number;
  readonly spotPriceUsd?: number | null | undefined;
  readonly recentBuys60s: number | null;
  readonly recentSells60s: number | null;
  readonly flowCoverage?: FlowCoverageStatus | string | undefined;
  readonly liquidityUsd?: number | null | undefined;
}

export function isFlowValidAndSufficient(spotInfo: RetestSpotInfo): boolean {
  if (spotInfo.flowCoverage !== "SUFFICIENT") {
    return false;
  }
  if (spotInfo.recentBuys60s === null || spotInfo.recentSells60s === null) {
    return false;
  }
  if (
    !Number.isFinite(spotInfo.recentBuys60s) ||
    !Number.isInteger(spotInfo.recentBuys60s) ||
    spotInfo.recentBuys60s < 0
  ) {
    return false;
  }
  if (
    !Number.isFinite(spotInfo.recentSells60s) ||
    !Number.isInteger(spotInfo.recentSells60s) ||
    spotInfo.recentSells60s < 0
  ) {
    return false;
  }
  return true;
}

export interface EvaluateRetestGateParams {
  readonly mintAddress: string;
  readonly isEstablished: boolean;
  readonly currentNowMs: number;
  readonly spotInfo: RetestSpotInfo;
  readonly existingArmedState?: ArmedPullbackState | undefined;
}

export type RetestGateResult =
  | {
      readonly status: "ARMED_FIRST_TICK";
      readonly updatedArmedState: ArmedPullbackState;
      readonly cohortLabel: "ESTABLISHED" | "MICRO_CAP";
      readonly targetWait: string;
    }
  | {
      readonly status: "REJECTED";
      readonly updatedArmedState: ArmedPullbackState;
      readonly rejectReason:
        | "REJECTED_EXCESSIVE_PULLBACK"
        | "REJECTED_PULLBACK_CRATERED"
        | "REJECTED_IN_FLIGHT_SELLER_SURGE"
        | "REJECTED_PULLBACK_EXPIRED";
      readonly rejectionGateName: "RetestCraterDrop" | "RetestSellerSurge" | "RetestTimeout";
      readonly maxCraterDropPct?: number | undefined;
      readonly maxExpiryMs?: number | undefined;
    }
  | {
      readonly status: "WAITING";
      readonly updatedArmedState: ArmedPullbackState;
      readonly pullbackPct: number;
    }
  | {
      readonly status: "CONFIRMED";
      readonly updatedArmedState: ArmedPullbackState;
      readonly confirmReason: "RETEST_PULLBACK_DISCOUNT" | "CONSOLIDATION_BREAKOUT";
    };

/**
 * Pure evaluation function for the Retest Gate.
 * Evaluates arming, peak tracking, crater protection, seller surge protection,
 * timeout expiry, pullback discount confirmation, and consolidation breakout confirmation.
 * Side effects (map mutations, logging, telemetry) remain in the caller.
 */
export function evaluateRetestGate(params: EvaluateRetestGateParams): RetestGateResult {
  const { mintAddress, isEstablished, currentNowMs, spotInfo, existingArmedState } = params;

  if (!existingArmedState) {
    const initialState: ArmedPullbackState = {
      mintAddress,
      armedAtMs: currentNowMs,
      peakPriceSol: spotInfo.spotPriceSol,
      peakPriceUsd: spotInfo.spotPriceUsd ?? 0,
      ticksObserved: 1,
    };
    const cohortLabel = isEstablished ? "ESTABLISHED" : "MICRO_CAP";
    const targetWait = isEstablished
      ? "4-8% pullback or consolidation"
      : "10-18% pullback or consolidation";
    return {
      status: "ARMED_FIRST_TICK",
      updatedArmedState: initialState,
      cohortLabel,
      targetWait,
    };
  }

  // Candidate already armed: update ticks & peak price
  const newPeakSol = Math.max(existingArmedState.peakPriceSol, spotInfo.spotPriceSol);
  const newPeakUsd =
    spotInfo.spotPriceSol >= existingArmedState.peakPriceSol
      ? (spotInfo.spotPriceUsd ?? existingArmedState.peakPriceUsd)
      : existingArmedState.peakPriceUsd;
  const updatedArmed: ArmedPullbackState = {
    ...existingArmedState,
    peakPriceSol: newPeakSol,
    peakPriceUsd: newPeakUsd,
    ticksObserved: existingArmedState.ticksObserved + 1,
  };

  // Cohort parameters for Retest Gate (Phase 12.92 Flow-Aware Retest Gate):
  // Established: Flow-aware crater drop ceiling: 12% if buyers absorbing (>= 1.15x), 8% if unabsorbed.
  // Micro-Cap: max 15% crater drop ceiling, 90s expiry.
  const flowVerified = isFlowValidAndSufficient(spotInfo);
  const isFlowAbsorbing =
    flowVerified &&
    spotInfo.recentBuys60s! > 0 &&
    spotInfo.recentBuys60s! >= 1.15 * Math.max(1, spotInfo.recentSells60s!);
  const maxCraterDropPct = isEstablished ? (isFlowAbsorbing ? 0.12 : 0.08) : 0.15;
  const maxExpiryMs = isEstablished ? 120_000 : 90_000;

  // Rule C: Plunged below crater threshold (anti-falling knife)
  if (spotInfo.spotPriceSol < updatedArmed.peakPriceSol * (1 - maxCraterDropPct)) {
    const rejectReason = isEstablished
      ? "REJECTED_EXCESSIVE_PULLBACK"
      : "REJECTED_PULLBACK_CRATERED";
    return {
      status: "REJECTED",
      updatedArmedState: updatedArmed,
      rejectReason,
      rejectionGateName: "RetestCraterDrop",
      maxCraterDropPct,
    };
  }

  // Rule E: In-Flight Seller Surge (Anti-Cabal exit wave while awaiting pullback)
  if (
    flowVerified &&
    spotInfo.recentSells60s! >= 25 &&
    spotInfo.recentSells60s! >= 2.5 * Math.max(1, spotInfo.recentBuys60s!)
  ) {
    return {
      status: "REJECTED",
      updatedArmedState: updatedArmed,
      rejectReason: "REJECTED_IN_FLIGHT_SELLER_SURGE",
      rejectionGateName: "RetestSellerSurge",
    };
  }

  // Rule D: Expiry after timeout
  if (currentNowMs - updatedArmed.armedAtMs > maxExpiryMs) {
    return {
      status: "REJECTED",
      updatedArmedState: updatedArmed,
      rejectReason: "REJECTED_PULLBACK_EXPIRED",
      rejectionGateName: "RetestTimeout",
      maxExpiryMs,
    };
  }

  // Rule A: Retest Pullback Discount with flow absorption
  // Established: 4% to 10% pullback discount with recentBuys60s >= 1.15 * recentSells60s
  // Micro-Cap: 10% to 15% pullback discount with recentBuys60s >= 1.25 * recentSells60s
  const minPullbackRatio = isEstablished ? 0.9 : 0.85;
  const maxPullbackRatio = isEstablished ? 0.96 : 0.9;
  const minPullbackFlowRatio = isEstablished ? 1.15 : 1.25;

  const isPullbackDiscount =
    spotInfo.spotPriceSol <= updatedArmed.peakPriceSol * maxPullbackRatio &&
    spotInfo.spotPriceSol >= updatedArmed.peakPriceSol * minPullbackRatio;
  const hasPullbackFlow =
    flowVerified &&
    spotInfo.recentBuys60s! > 0 &&
    spotInfo.recentBuys60s! >= minPullbackFlowRatio * spotInfo.recentSells60s!;
  const ruleAConfirmed = isPullbackDiscount && hasPullbackFlow;

  // Rule B: Consolidation Breakout
  // Established: within 4% of peak for >= 30s with buyer dominance (>= 1.25 * sells)
  // Micro-Cap: within 5% of peak for >= 30s or >= 3 ticks with strong flow (>= 1.5 * sells)
  const maxConsolidationDropPct = isEstablished ? 0.04 : 0.05;
  const minConsolidationFlowRatio = isEstablished ? 1.25 : 1.5;

  const isConsolidatingNearPeak =
    spotInfo.spotPriceSol >= updatedArmed.peakPriceSol * (1 - maxConsolidationDropPct);
  const hasConsolidationDuration =
    currentNowMs - updatedArmed.armedAtMs >= 30_000 || updatedArmed.ticksObserved >= 3;
  const hasConsolidationFlow =
    flowVerified &&
    spotInfo.recentBuys60s! > 0 &&
    spotInfo.recentBuys60s! >= minConsolidationFlowRatio * spotInfo.recentSells60s!;
  const ruleBConfirmed =
    isConsolidatingNearPeak && hasConsolidationDuration && hasConsolidationFlow;

  if (!ruleAConfirmed && !ruleBConfirmed) {
    const pullbackPct =
      ((spotInfo.spotPriceSol - updatedArmed.peakPriceSol) / updatedArmed.peakPriceSol) * 100;
    return {
      status: "WAITING",
      updatedArmedState: updatedArmed,
      pullbackPct,
    };
  }

  const confirmReason = ruleAConfirmed ? "RETEST_PULLBACK_DISCOUNT" : "CONSOLIDATION_BREAKOUT";
  return {
    status: "CONFIRMED",
    updatedArmedState: updatedArmed,
    confirmReason,
  };
}
