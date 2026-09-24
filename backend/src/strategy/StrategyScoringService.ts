import type {
  RiskAssessmentRecord,
  StrategyDecision,
  TokenRadarRecord,
} from "../db/schema/index.js";
import { parseJson } from "../db/utils/json.js";
import type { RiskFlag } from "../risk/RiskFlags.js";
import { RISK_FLAGS } from "../risk/RiskFlags.js";
import type { StrategyRuntimeConfig } from "./StrategyConfig.js";
import type { StrategyCandidate } from "./StrategyCandidateSelector.js";
import { evaluateDuplicateBuyRule } from "./rules/DuplicateBuyRule.js";
import { evaluateLiquidityAttractivenessRule } from "./rules/LiquidityAttractivenessRule.js";
import { evaluatePairAgeAttractivenessRule } from "./rules/PairAgeAttractivenessRule.js";
import { evaluatePriceImpactAttractivenessRule } from "./rules/PriceImpactAttractivenessRule.js";
import { evaluateRiskEligibilityRule } from "./rules/RiskEligibilityRule.js";
import type { StrategyRuleResult } from "./rules/StrategyRuleResult.js";
import { evaluateVolumeRule } from "./rules/VolumeRule.js";

export interface StrategyScoringInput {
  readonly candidate: StrategyCandidate;
  readonly config: StrategyRuntimeConfig;
  readonly duplicateBuyInCurrentRun: boolean;
  readonly maxBuyCapReached: boolean;
}

export interface StrategyEvaluationFacts {
  readonly riskFlags: readonly RiskFlag[];
  readonly liquidityUsd?: number;
  readonly volume1hUsd?: number;
  readonly pairAgeSeconds?: number;
  readonly buyPriceImpactPct?: number;
  readonly sellPriceImpactPct?: number;
  readonly maxPriceImpactPct?: number;
}

export interface StrategyScoreResult {
  readonly score: number;
  readonly decision: StrategyDecision;
  readonly rawDecision: StrategyDecision;
  readonly buyEligible: boolean;
  readonly duplicateBuyBlocked: boolean;
  readonly maxBuyCapBlocked: boolean;
  readonly factors: readonly StrategyRuleResult[];
  readonly reason: string;
  readonly facts: StrategyEvaluationFacts;
}

export class StrategyScoringService {
  evaluate(input: StrategyScoringInput): StrategyScoreResult {
    const facts = extractStrategyFacts(
      input.candidate.tokenRadar,
      input.candidate.latestRiskAssessment,
    );
    const riskEligibility = evaluateRiskEligibilityRule(
      input.candidate.latestRiskAssessment,
      facts.riskFlags,
    );
    const liquidity = evaluateLiquidityAttractivenessRule(facts.liquidityUsd, input.config);
    const volume = evaluateVolumeRule(facts.volume1hUsd, input.config);
    const pairAge = evaluatePairAgeAttractivenessRule(facts.pairAgeSeconds, input.config);
    const priceImpact = evaluatePriceImpactAttractivenessRule(
      facts.maxPriceImpactPct,
      input.config,
    );
    const duplicateBuy = evaluateDuplicateBuyRule(
      input.candidate.existingDecisions,
      input.duplicateBuyInCurrentRun,
    );
    const factors = [riskEligibility, liquidity, volume, pairAge, priceImpact, duplicateBuy];
    const score = clampScore(factors.reduce((total, factor) => total + factor.points, 0));
    const rawDecision = scoreToDecision(score, input.config);
    const buyEligible =
      riskEligibility.buyEligible &&
      liquidity.passed &&
      volume.passed &&
      pairAge.passed &&
      priceImpact.passed;
    const duplicateBuyBlocked = rawDecision === "BUY" && duplicateBuy.duplicateBuy;
    const maxBuyCapBlocked =
      rawDecision === "BUY" && buyEligible && !duplicateBuy.duplicateBuy && input.maxBuyCapReached;
    const decision = applyDecisionOverrides({
      rawDecision,
      buyEligible,
      duplicateBuyBlocked,
      maxBuyCapBlocked,
    });

    return {
      score,
      decision,
      rawDecision,
      buyEligible,
      duplicateBuyBlocked,
      maxBuyCapBlocked,
      factors,
      reason: buildReason({
        decision,
        rawDecision,
        score,
        buyEligible,
        duplicateBuyBlocked,
        maxBuyCapBlocked,
        facts,
        riskResult: input.candidate.latestRiskAssessment.result,
      }),
      facts,
    };
  }
}

interface DecisionOverrideInput {
  readonly rawDecision: StrategyDecision;
  readonly buyEligible: boolean;
  readonly duplicateBuyBlocked: boolean;
  readonly maxBuyCapBlocked: boolean;
}

function applyDecisionOverrides(input: DecisionOverrideInput): StrategyDecision {
  if (input.rawDecision !== "BUY") {
    return input.rawDecision;
  }

  if (!input.buyEligible) {
    return "SKIP";
  }

  if (input.duplicateBuyBlocked || input.maxBuyCapBlocked) {
    return "WATCH";
  }

  return "BUY";
}

function scoreToDecision(score: number, config: StrategyRuntimeConfig): StrategyDecision {
  if (score >= config.buyScoreThreshold) {
    return "BUY";
  }

  if (score >= config.watchScoreThreshold) {
    return "WATCH";
  }

  return "SKIP";
}

function buildReason(input: {
  readonly decision: StrategyDecision;
  readonly rawDecision: StrategyDecision;
  readonly score: number;
  readonly buyEligible: boolean;
  readonly duplicateBuyBlocked: boolean;
  readonly maxBuyCapBlocked: boolean;
  readonly facts: StrategyEvaluationFacts;
  readonly riskResult: string;
}): string {
  const parts = [
    `${input.decision}: score=${input.score}`,
    `risk=${input.riskResult}`,
    input.facts.liquidityUsd !== undefined ? `liquidity=${input.facts.liquidityUsd}` : undefined,
    input.facts.volume1hUsd !== undefined ? `volume1h=${input.facts.volume1hUsd}` : undefined,
    input.facts.pairAgeSeconds !== undefined
      ? `ageSeconds=${input.facts.pairAgeSeconds}`
      : undefined,
    input.facts.maxPriceImpactPct !== undefined
      ? `impact=${input.facts.maxPriceImpactPct}`
      : undefined,
  ].filter((part): part is string => part !== undefined);

  if (input.rawDecision === "BUY" && !input.buyEligible) {
    parts.push("BUY_INELIGIBLE");
  }

  if (input.duplicateBuyBlocked) {
    parts.push("DUPLICATE_BUY_PREVENTED");
  }

  if (input.maxBuyCapBlocked) {
    parts.push("MAX_BUY_DECISIONS_REACHED");
  }

  return parts.join(" ");
}

function extractStrategyFacts(
  tokenRadar: TokenRadarRecord,
  riskAssessment: RiskAssessmentRecord,
): StrategyEvaluationFacts {
  const riskFlags = parseRiskFlags(riskAssessment.riskFlagsJson);
  const rawFacts = parseRiskRawFacts(riskAssessment.rawProviderDataJson);
  const liquidityUsd =
    parseOptionalNumber(riskAssessment.liquidityUsd) ??
    parseOptionalNumber(tokenRadar.liquidityUsd);
  const volume1hUsd = parseOptionalNumber(tokenRadar.volume1hUsd);
  const pairAgeSeconds = tokenRadar.ageSeconds ?? rawFacts.pairAgeSeconds;
  const buyPriceImpactPct = rawFacts.buyPriceImpactPct;
  const sellPriceImpactPct = rawFacts.sellPriceImpactPct;
  const maxPriceImpactPct =
    rawFacts.maxPriceImpactPct ??
    maxOptionalNumber([rawFacts.buyPriceImpactPct, rawFacts.sellPriceImpactPct]);

  return {
    riskFlags,
    ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
    ...(volume1hUsd !== undefined ? { volume1hUsd } : {}),
    ...(pairAgeSeconds !== undefined ? { pairAgeSeconds } : {}),
    ...(buyPriceImpactPct !== undefined ? { buyPriceImpactPct } : {}),
    ...(sellPriceImpactPct !== undefined ? { sellPriceImpactPct } : {}),
    ...(maxPriceImpactPct !== undefined ? { maxPriceImpactPct } : {}),
  };
}

function parseRiskFlags(value: string): readonly RiskFlag[] {
  const parsed = parseJson<unknown>(value);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((flag): flag is RiskFlag => isRiskFlag(flag));
}

function isRiskFlag(value: unknown): value is RiskFlag {
  return typeof value === "string" && RISK_FLAGS.includes(value as RiskFlag);
}

interface RiskRawFacts {
  readonly pairAgeSeconds?: number;
  readonly buyPriceImpactPct?: number;
  readonly sellPriceImpactPct?: number;
  readonly maxPriceImpactPct?: number;
}

function parseRiskRawFacts(value: string | null): RiskRawFacts {
  if (!value) {
    return {};
  }

  const parsed = parseJson<unknown>(value);

  if (!isRecord(parsed)) {
    return {};
  }

  const scoringFacts = getRecord(getRecord(parsed.scoring)?.facts);
  const enrichment = getRecord(parsed.enrichment);
  const buyQuote = getRecord(enrichment?.buyQuote);
  const sellQuote = getRecord(enrichment?.sellQuote);
  const pairAgeSeconds = readNumber(scoringFacts, "pairAgeSeconds");
  const buyPriceImpactPct =
    readNumber(scoringFacts, "buyPriceImpactPct") ??
    readNumber(buyQuote, "estimatedPriceImpactPct");
  const sellPriceImpactPct =
    readNumber(scoringFacts, "sellPriceImpactPct") ??
    readNumber(sellQuote, "estimatedPriceImpactPct");
  const maxPriceImpactPct = readNumber(scoringFacts, "maxPriceImpactPct");

  return {
    ...(pairAgeSeconds !== undefined ? { pairAgeSeconds } : {}),
    ...(buyPriceImpactPct !== undefined ? { buyPriceImpactPct } : {}),
    ...(sellPriceImpactPct !== undefined ? { sellPriceImpactPct } : {}),
    ...(maxPriceImpactPct !== undefined ? { maxPriceImpactPct } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOptionalNumber(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function maxOptionalNumber(values: readonly (number | undefined)[]): number | undefined {
  const numbers = values.filter((value): value is number => value !== undefined);

  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}
