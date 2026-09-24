import type { StrategyDecision, StrategyDecisionRecord } from "../db/schema/index.js";
import { parseJson } from "../db/utils/json.js";
import type { ScoreAttribution, ScoreFactorAttribution } from "./CalibrationTypes.js";

export class ScoreAttributionService {
  explain(decision: StrategyDecisionRecord): ScoreAttribution {
    const snapshot = parseSnapshot(decision.inputSnapshotJson);
    const strategyScore = getRecord(snapshot?.strategyScore);
    const tokenRadar = getRecord(snapshot?.tokenRadar);
    const riskAssessment = getRecord(snapshot?.riskAssessment);
    const factors = readFactors(strategyScore?.factors);
    const riskFlags = readStringArray(riskAssessment?.riskFlags);
    const blockingFactors = factors
      .filter((factor) => !factor.passed)
      .map((factor) => factor.ruleName);
    const rawDecision = readDecision(strategyScore, "rawDecision");
    const buyScoreThreshold = readNumberLike(strategyScore, "buyScoreThreshold");
    const watchScoreThreshold = readNumberLike(strategyScore, "watchScoreThreshold");
    const riskResult = readString(riskAssessment, "result");
    const symbol = readString(tokenRadar, "symbol");
    const name = readString(tokenRadar, "name");
    const pairAddress = readString(tokenRadar, "pairAddress");
    const liquidityUsd = readNumberLike(tokenRadar, "liquidityUsd");
    const volume5mUsd = readNumberLike(tokenRadar, "volume5mUsd");
    const volume1hUsd = readNumberLike(tokenRadar, "volume1hUsd");
    const ageSeconds = readNumberLike(tokenRadar, "ageSeconds");
    const maxPriceImpactPct = readNumberLike(getRecord(strategyScore?.facts), "maxPriceImpactPct");
    const missingPriceImpact = factors.some(
      (factor) =>
        factor.ruleName === "price_impact_attractiveness" &&
        factor.warnings.some((warning) => warning.toLowerCase().includes("missing")),
    );

    return {
      storedScore: decision.score,
      factorTotal: factors.reduce((total, factor) => total + factor.points, 0),
      factors,
      ...(rawDecision ? { rawDecision } : {}),
      ...(buyScoreThreshold !== undefined ? { buyScoreThreshold } : {}),
      ...(watchScoreThreshold !== undefined ? { watchScoreThreshold } : {}),
      buyEligible: readBoolean(strategyScore, "buyEligible") ?? false,
      duplicateBuyBlocked: readBoolean(strategyScore, "duplicateBuyBlocked") ?? false,
      maxBuyCapBlocked: readBoolean(strategyScore, "maxBuyCapBlocked") ?? false,
      ...(riskResult ? { riskResult } : {}),
      riskFlags,
      ...(symbol ? { symbol } : {}),
      ...(name ? { name } : {}),
      ...(pairAddress ? { pairAddress } : {}),
      ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
      ...(volume5mUsd !== undefined ? { volume5mUsd } : {}),
      ...(volume1hUsd !== undefined ? { volume1hUsd } : {}),
      ...(ageSeconds !== undefined ? { ageSeconds } : {}),
      ...(maxPriceImpactPct !== undefined ? { maxPriceImpactPct } : {}),
      missingQuote: riskFlags.includes("MISSING_QUOTE"),
      missingAuthorityEvidence: riskFlags.includes("MISSING_AUTHORITY_EVIDENCE"),
      missingPriceImpact,
      blockingFactors,
    };
  }
}

function parseSnapshot(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return getRecord(parseJson<unknown>(value));
  } catch {
    return undefined;
  }
}

function readFactors(value: unknown): readonly ScoreFactorAttribution[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => getRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => {
      const reason = readString(item, "reason");

      return {
        ruleName: readString(item, "ruleName") ?? "unknown_rule",
        points: readNumberLike(item, "points") ?? 0,
        passed: readBoolean(item, "passed") ?? false,
        ...(reason ? { reason } : {}),
        warnings: readStringArray(item.warnings),
      };
    });
}

function readDecision(
  record: Record<string, unknown> | undefined,
  key: string,
): StrategyDecision | undefined {
  const value = readString(record, key);

  return isStrategyDecision(value) ? value : undefined;
}

function isStrategyDecision(value: string | undefined): value is StrategyDecision {
  return (
    value === "BUY" || value === "WATCH" || value === "SKIP" || value === "HOLD" || value === "SELL"
  );
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readBoolean(
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = record?.[key];

  return typeof value === "boolean" ? value : undefined;
}

function readNumberLike(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;

  return Number.isFinite(parsed) ? parsed : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
