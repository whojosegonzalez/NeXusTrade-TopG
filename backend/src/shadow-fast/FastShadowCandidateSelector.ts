import { ScoreAttributionService } from "../calibration/ScoreAttributionService.js";
import type { StrategyDecisionRecord } from "../db/schema/index.js";
import { parseJson } from "../db/utils/json.js";
import {
  FAST_SHADOW_SESSION_CAP,
  type FastShadowCandidate,
  type FastShadowClassification,
  type FastShadowSelection,
} from "./FastShadowTypes.js";

const hardFactorNames = [
  "risk_eligibility",
  "liquidity_attractiveness",
  "volume_1h_attractiveness",
  "pair_age_attractiveness",
] as const;

export class FastShadowCandidateSelector {
  private readonly attributionService = new ScoreAttributionService();

  select(
    decisions: readonly StrategyDecisionRecord[],
    cap = FAST_SHADOW_SESSION_CAP,
  ): FastShadowSelection {
    const candidates = decisions
      .slice()
      .sort(
        (left, right) => left.decidedAtMs - right.decidedAtMs || left.id.localeCompare(right.id),
      )
      .map((decision) => this.classify(decision));
    const selected: FastShadowCandidate[] = [];
    const seenMints = new Set<string>();
    const classified = candidates.map((candidate) => {
      if (candidate.classification !== "SELECTED") return candidate;
      if (seenMints.has(candidate.decision.mintAddress)) {
        return {
          ...candidate,
          classification: "DUPLICATE_MINT_SUPPRESSED" as const,
          reason: "an earlier eligible decision for this mint was already considered",
        };
      }
      seenMints.add(candidate.decision.mintAddress);
      if (selected.length >= cap) {
        return {
          ...candidate,
          classification: "SESSION_CAP_SUPPRESSED" as const,
          reason: `the immutable F65E@v1 session cap of ${cap} selected mints was reached`,
        };
      }
      selected.push(candidate);
      return candidate;
    });

    return {
      candidates: classified,
      selected,
      selectedDecisionIds: selected.map((candidate) => candidate.decision.id),
      classificationCounts: countClassifications(classified),
    };
  }

  private classify(decision: StrategyDecisionRecord): FastShadowCandidate {
    const attribution = this.attributionService.explain(decision);
    const base = { decision, attribution };
    if (decision.decision !== "SKIP") {
      return {
        ...base,
        classification: "NOT_BASELINE_SKIP",
        reason: "stored decision is not SKIP",
      };
    }
    if (
      decision.score === null ||
      !Number.isInteger(decision.score) ||
      attribution.factors.length === 0
    ) {
      return {
        ...base,
        classification: "INVALID_SNAPSHOT",
        reason: "stored score or factor snapshot is missing or invalid",
      };
    }
    if (decision.score < 65 || decision.score > 69) {
      return { ...base, classification: "SCORE_BAND_MISMATCH", reason: "score is outside 65-69" };
    }
    if (
      attribution.buyScoreThreshold !== 90 ||
      attribution.watchScoreThreshold !== 70 ||
      attribution.rawDecision !== "SKIP"
    ) {
      return {
        ...base,
        classification: "THRESHOLD_SNAPSHOT_MISMATCH",
        reason: "stored snapshot is not the immutable 90/70 SKIP baseline",
      };
    }
    const factors = new Map(attribution.factors.map((factor) => [factor.ruleName, factor]));
    if (
      attribution.missingQuote ||
      attribution.missingPriceImpact ||
      !factors.get("price_impact_attractiveness")?.passed
    ) {
      return {
        ...base,
        classification: "MISSING_PRICE_OR_QUOTE_EVIDENCE",
        reason: "quote or price-impact evidence is missing or did not pass",
      };
    }
    const failedHardFactor = hardFactorNames.find((name) => !factors.get(name)?.passed);
    if (!attribution.buyEligible || attribution.riskResult !== "PASS" || failedHardFactor) {
      return {
        ...base,
        classification: "HARD_GATE_BLOCKED",
        reason: failedHardFactor
          ? `hard factor did not pass: ${failedHardFactor}`
          : attribution.riskResult !== "PASS"
            ? "stored risk result is not PASS"
            : "stored snapshot does not mark the candidate buy-eligible",
      };
    }
    if (!hasStoredBaselinePrice(decision.inputSnapshotJson)) {
      return {
        ...base,
        classification: "MISSING_BASELINE_PRICE",
        reason: "stored decision snapshot has no usable baseline price",
      };
    }
    return {
      ...base,
      classification: "SELECTED",
      reason: "meets the immutable F65E@v1 stored-fact contract",
    };
  }
}

function hasStoredBaselinePrice(inputSnapshotJson: string | null): boolean {
  if (!inputSnapshotJson) return false;
  try {
    const snapshot = parseJson<unknown>(inputSnapshotJson);
    const tokenRadar =
      isRecord(snapshot) && isRecord(snapshot.tokenRadar) ? snapshot.tokenRadar : undefined;
    return isPositiveDecimal(tokenRadar?.priceSol) || isPositiveDecimal(tokenRadar?.priceUsd);
  } catch {
    return false;
  }
}

function isPositiveDecimal(value: unknown): boolean {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countClassifications(
  candidates: readonly FastShadowCandidate[],
): Readonly<Record<FastShadowClassification, number>> {
  const counts: Record<FastShadowClassification, number> = {
    SELECTED: 0,
    NOT_BASELINE_SKIP: 0,
    SCORE_BAND_MISMATCH: 0,
    THRESHOLD_SNAPSHOT_MISMATCH: 0,
    INVALID_SNAPSHOT: 0,
    HARD_GATE_BLOCKED: 0,
    MISSING_PRICE_OR_QUOTE_EVIDENCE: 0,
    MISSING_BASELINE_PRICE: 0,
    DUPLICATE_MINT_SUPPRESSED: 0,
    SESSION_CAP_SUPPRESSED: 0,
  };
  for (const candidate of candidates) counts[candidate.classification] += 1;
  return counts;
}
