import type { RiskResult, TokenRadarRecord, TokenRadarStatus } from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { nowMs } from "../db/utils/timestamps.js";
import type { Repositories } from "../db/repositories/index.js";
import type { RiskScoreEvaluation } from "./RiskScoringService.js";
import type { RiskQuoteBudgetEvidence } from "./RiskEvidenceRefreshService.js";
import type { TokenEnrichmentSnapshot } from "@nexustrade/shared";

export interface RiskAssessmentWriteInput {
  readonly sessionId: string;
  readonly candidate: TokenRadarRecord;
  readonly checkedAtMs: number;
  readonly scoring: RiskScoreEvaluation;
  readonly enrichment: TokenEnrichmentSnapshot;
  readonly refreshWarnings: readonly string[];
  readonly quoteBudget?: RiskQuoteBudgetEvidence | undefined;
  readonly dryRun: boolean;
}

export interface RiskAssessmentWriteResult {
  readonly wroteAssessment: boolean;
  readonly updatedRadarStatus: boolean;
  readonly nextStatus?: TokenRadarStatus;
}

export class RiskAssessmentWriter {
  constructor(
    private readonly repositories: Pick<Repositories, "riskAssessments" | "tokenRadar">,
  ) {}

  write(input: RiskAssessmentWriteInput): RiskAssessmentWriteResult {
    const nextStatus = riskResultToRadarStatus(input.scoring.result);

    if (input.dryRun) {
      return {
        wroteAssessment: false,
        updatedRadarStatus: false,
        ...(nextStatus ? { nextStatus } : {}),
      };
    }

    this.repositories.riskAssessments.createRiskAssessment({
      sessionId: input.sessionId,
      tokenRadarId: input.candidate.id,
      mintAddress: input.candidate.mintAddress,
      checkedAtMs: input.checkedAtMs,
      score: input.scoring.score,
      result: input.scoring.result,
      passed: input.scoring.passed,
      ...(input.scoring.facts.mintAuthorityDisabled !== undefined
        ? { mintAuthorityDisabled: input.scoring.facts.mintAuthorityDisabled }
        : {}),
      ...(input.scoring.facts.freezeAuthorityDisabled !== undefined
        ? { freezeAuthorityDisabled: input.scoring.facts.freezeAuthorityDisabled }
        : {}),
      ...(input.scoring.facts.tokenProgram
        ? { tokenProgram: input.scoring.facts.tokenProgram }
        : {}),
      ...(input.scoring.facts.liquidityUsd !== undefined
        ? { liquidityUsd: String(input.scoring.facts.liquidityUsd) }
        : {}),
      riskFlagsJson: stringifyJson(input.scoring.flags),
      rawProviderDataJson: stringifyJson(summarizeRiskEvidence(input)),
    });

    if (nextStatus && input.candidate.status !== nextStatus) {
      this.repositories.tokenRadar.updateRadarStatus(
        input.candidate.id,
        nextStatus,
        appendRiskNote(input.candidate.notes, buildRiskNote(input.scoring)),
      );

      return {
        wroteAssessment: true,
        updatedRadarStatus: true,
        nextStatus,
      };
    }

    if (nextStatus && input.scoring.result === "WARN") {
      this.repositories.tokenRadar.updateRadarStatus(
        input.candidate.id,
        nextStatus,
        appendRiskNote(input.candidate.notes, buildRiskNote(input.scoring)),
      );

      return {
        wroteAssessment: true,
        updatedRadarStatus: true,
        nextStatus,
      };
    }

    return {
      wroteAssessment: true,
      updatedRadarStatus: false,
      ...(nextStatus ? { nextStatus } : {}),
    };
  }
}

function riskResultToRadarStatus(result: RiskResult): TokenRadarStatus | undefined {
  switch (result) {
    case "FAIL":
      return "REJECTED";
    case "PASS":
    case "WARN":
      return "WATCHING";
    case "UNKNOWN":
      return undefined;
  }
}

function appendRiskNote(existingNotes: string | null, riskNote: string): string {
  if (!existingNotes || existingNotes.trim() === "") {
    return riskNote;
  }

  if (existingNotes.includes(riskNote)) {
    return existingNotes;
  }

  return `${existingNotes}\n${riskNote}`;
}

function buildRiskNote(scoring: RiskScoreEvaluation): string {
  return `Risk ${scoring.result} score=${scoring.score} flags=${scoring.flags.join(",") || "none"}`;
}

function summarizeRiskEvidence(input: RiskAssessmentWriteInput): unknown {
  return {
    phase: "PHASE_5_FIRST_RISK_ENGINE",
    checkedAt: new Date(input.checkedAtMs).toISOString(),
    candidate: {
      id: input.candidate.id,
      mintAddress: input.candidate.mintAddress,
      source: input.candidate.source,
      status: input.candidate.status,
    },
    enrichment: {
      fetchedAt: input.enrichment.fetchedAt.toISOString(),
      sourcesUsed: input.enrichment.sourcesUsed,
      warningCount: input.enrichment.warnings.length,
      refreshWarnings: input.refreshWarnings,
      price: input.enrichment.price
        ? {
            source: input.enrichment.price.source,
            ...(input.enrichment.price.priceUsd !== undefined
              ? { priceUsd: input.enrichment.price.priceUsd }
              : {}),
            ...(input.enrichment.price.priceSol !== undefined
              ? { priceSol: input.enrichment.price.priceSol }
              : {}),
          }
        : undefined,
      bestPair: input.enrichment.bestPair
        ? {
            source: input.enrichment.bestPair.source,
            dexId: input.enrichment.bestPair.dexId,
            pairAddress: input.enrichment.bestPair.pairAddress,
            ...(input.enrichment.bestPair.liquidityUsd !== undefined
              ? { liquidityUsd: input.enrichment.bestPair.liquidityUsd }
              : {}),
            ...(input.enrichment.bestPair.pairCreatedAt
              ? { pairCreatedAt: input.enrichment.bestPair.pairCreatedAt.toISOString() }
              : {}),
          }
        : undefined,
      metadata: input.enrichment.metadata
        ? {
            source: input.enrichment.metadata.source,
            ...(input.enrichment.metadata.symbol
              ? { symbol: input.enrichment.metadata.symbol }
              : {}),
            ...(input.enrichment.metadata.name ? { name: input.enrichment.metadata.name } : {}),
            ...(input.enrichment.metadata.tokenProgram
              ? { tokenProgram: input.enrichment.metadata.tokenProgram }
              : {}),
          }
        : undefined,
      riskEvidence: input.enrichment.riskEvidence
        ? {
            source: input.enrichment.riskEvidence.source,
            flags: input.enrichment.riskEvidence.flags,
            ...(input.enrichment.riskEvidence.mintAuthorityRisk
              ? { mintAuthorityRisk: input.enrichment.riskEvidence.mintAuthorityRisk }
              : {}),
            ...(input.enrichment.riskEvidence.freezeAuthorityRisk
              ? { freezeAuthorityRisk: input.enrichment.riskEvidence.freezeAuthorityRisk }
              : {}),
          }
        : undefined,
      buyQuote: input.enrichment.buyQuote
        ? {
            source: input.enrichment.buyQuote.source,
            ...(input.enrichment.buyQuote.provenance
              ? { provenance: input.enrichment.buyQuote.provenance }
              : {}),
            ...(input.enrichment.buyQuote.estimatedPriceImpactPct !== undefined
              ? { estimatedPriceImpactPct: input.enrichment.buyQuote.estimatedPriceImpactPct }
              : {}),
          }
        : undefined,
      sellQuote: input.enrichment.sellQuote
        ? {
            source: input.enrichment.sellQuote.source,
            ...(input.enrichment.sellQuote.provenance
              ? { provenance: input.enrichment.sellQuote.provenance }
              : {}),
            ...(input.enrichment.sellQuote.estimatedPriceImpactPct !== undefined
              ? { estimatedPriceImpactPct: input.enrichment.sellQuote.estimatedPriceImpactPct }
              : {}),
          }
        : undefined,
    },
    scoring: {
      score: input.scoring.score,
      result: input.scoring.result,
      passed: input.scoring.passed,
      flags: input.scoring.flags,
      deductions: input.scoring.deductions,
      facts: input.scoring.facts,
    },
    ...(input.quoteBudget ? { quoteBudget: input.quoteBudget } : {}),
    recordedAtMs: nowMs(),
  };
}
