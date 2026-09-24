import type { RiskResult } from "../../db/schema/index.js";
import type { QuoteBudgetPlannerConfig } from "../config/providerConfig.js";

export type QuoteBudgetSelectionReason =
  | "SELECTED"
  | "QUOTE_BUDGET_NOT_SELECTED"
  | "QUOTE_BUDGET_DISABLED";

export interface QuoteBudgetCandidate {
  /** Stable per-radar-row key; a mint can legitimately have multiple observed pairs. */
  readonly candidateKey: string;
  readonly mintAddress: string;
  readonly discoveredAtMs: number;
  readonly liquidityUsd: string | null;
  readonly volume1hUsd: string | null;
  readonly ageSeconds: number | null;
  readonly priceSol: string | null;
  readonly priceUsd: string | null;
  readonly pairAddress: string | null;
  readonly status: string;
  readonly priorRiskResult?: RiskResult | undefined;
}

export interface QuoteBudgetPlanEntry {
  readonly mintAddress: string;
  readonly selected: boolean;
  readonly selectionReason: QuoteBudgetSelectionReason;
  readonly rank?: number | undefined;
  readonly candidateScore: number;
  readonly candidateSignals: readonly string[];
}

export interface QuoteBudgetPlan {
  readonly enabled: boolean;
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly notSelectedCount: number;
  readonly limit: number;
  readonly entriesByCandidateKey: ReadonlyMap<string, QuoteBudgetPlanEntry>;
}

const THIRTY_MINUTES_MS = 30 * 60 * 1_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const MIN_LIQUIDITY_USD = 10_000;
const MIN_VOLUME_1H_USD = 1_000;
const MIN_PAIR_AGE_SECONDS = 30 * 60;

/**
 * Deterministically allocates scarce quote capacity using evidence already
 * stored by the scanner and earlier risk assessments. It performs no I/O.
 */
export class QuoteBudgetPlanner {
  constructor(private readonly config: QuoteBudgetPlannerConfig) {}

  plan(candidates: readonly QuoteBudgetCandidate[], nowMs: number): QuoteBudgetPlan {
    if (!this.config.enabled) {
      return createDisabledPlan(candidates);
    }

    const ranked = candidates
      .map((candidate) => scoreCandidate(candidate, this.config, nowMs))
      .sort(compareCandidates);
    const selectedCount = Math.min(this.config.maxCandidatesPerCycle, ranked.length);
    const entries = new Map<string, QuoteBudgetPlanEntry>();

    for (const [index, scored] of ranked.entries()) {
      const selected = index < selectedCount;
      entries.set(scored.candidate.candidateKey, {
        mintAddress: scored.candidate.mintAddress,
        selected,
        selectionReason: selected ? "SELECTED" : "QUOTE_BUDGET_NOT_SELECTED",
        rank: index + 1,
        candidateScore: scored.score,
        candidateSignals: scored.signals,
      });
    }

    return {
      enabled: true,
      candidateCount: candidates.length,
      selectedCount,
      notSelectedCount: candidates.length - selectedCount,
      limit: this.config.maxCandidatesPerCycle,
      entriesByCandidateKey: entries,
    };
  }
}

interface ScoredCandidate {
  readonly candidate: QuoteBudgetCandidate;
  readonly score: number;
  readonly signals: readonly string[];
  readonly liquidityUsd: number;
  readonly volume1hUsd: number;
}

function createDisabledPlan(candidates: readonly QuoteBudgetCandidate[]): QuoteBudgetPlan {
  return {
    enabled: false,
    candidateCount: candidates.length,
    selectedCount: candidates.length,
    notSelectedCount: 0,
    limit: candidates.length,
    entriesByCandidateKey: new Map(
      candidates.map((candidate, index) => [
        candidate.candidateKey,
        {
          mintAddress: candidate.mintAddress,
          selected: true,
          selectionReason: "QUOTE_BUDGET_DISABLED" as const,
          rank: index + 1,
          candidateScore: 0,
          candidateSignals: ["planner_disabled"],
        },
      ]),
    ),
  };
}

function scoreCandidate(
  candidate: QuoteBudgetCandidate,
  config: QuoteBudgetPlannerConfig,
  nowMs: number,
): ScoredCandidate {
  const signals: string[] = [];
  let score = 0;
  const discoveredAgeMs = Math.max(0, nowMs - candidate.discoveredAtMs);
  const liquidityUsd = parseNonNegativeNumber(candidate.liquidityUsd);
  const volume1hUsd = parseNonNegativeNumber(candidate.volume1hUsd);

  if (discoveredAgeMs <= THIRTY_MINUTES_MS) {
    score += config.recencyWeight;
    signals.push("recent_discovery");
  } else if (discoveredAgeMs <= TWO_HOURS_MS && config.recencyWeight > 0) {
    score += Math.ceil(config.recencyWeight / 2);
    signals.push("recentish_discovery");
  }

  if (liquidityUsd >= MIN_LIQUIDITY_USD) {
    score += config.liquidityWeight;
    signals.push("liquidity_at_or_above_risk_floor");
  } else if (liquidityUsd > 0 && config.liquidityWeight > 0) {
    score += Math.ceil(config.liquidityWeight / 2);
    signals.push("liquidity_present_below_risk_floor");
  }

  if (volume1hUsd >= MIN_VOLUME_1H_USD) {
    score += config.volumeWeight;
    signals.push("volume_1h_present");
  } else if (volume1hUsd > 0 && config.volumeWeight > 0) {
    score += Math.ceil(config.volumeWeight / 2);
    signals.push("volume_1h_low_but_present");
  }

  if ((candidate.ageSeconds ?? -1) >= MIN_PAIR_AGE_SECONDS) {
    score += config.ageWeight;
    signals.push("pair_age_at_or_above_risk_floor");
  }

  if (candidate.priorRiskResult === "PASS") {
    score += config.priorEvidenceWeight;
    signals.push("prior_risk_pass");
  } else if (candidate.priorRiskResult === "WARN" && config.priorEvidenceWeight > 0) {
    score += Math.ceil(config.priorEvidenceWeight / 2);
    signals.push("prior_risk_warn");
  }

  if (!candidate.pairAddress) {
    score -= 1;
    signals.push("missing_local_pair");
  }

  if (!candidate.priceSol && !candidate.priceUsd) {
    score -= 1;
    signals.push("missing_local_price");
  }

  if (signals.length === 0) {
    signals.push("limited_local_evidence");
  }

  return {
    candidate,
    score,
    signals,
    liquidityUsd,
    volume1hUsd,
  };
}

function compareCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  return (
    right.score - left.score ||
    right.candidate.discoveredAtMs - left.candidate.discoveredAtMs ||
    right.liquidityUsd - left.liquidityUsd ||
    right.volume1hUsd - left.volume1hUsd ||
    left.candidate.mintAddress.localeCompare(right.candidate.mintAddress)
  );
}

function parseNonNegativeNumber(value: string | null): number {
  if (value === null) {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
