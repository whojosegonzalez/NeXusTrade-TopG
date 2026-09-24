import type { ProviderResult, TokenMintAddress, TokenPriceSnapshot } from "@nexustrade/shared";

import type { Repositories } from "../../db/repositories/index.js";
import type { StrategyDecisionRecord } from "../../db/schema/index.js";
import { parseJson } from "../../db/utils/json.js";
import { stringifyJson } from "../../db/utils/json.js";
import type { ProviderConfig } from "../config/providerConfig.js";
import type { ProviderRegistry } from "../ProviderRegistry.js";
import type { BirdeyeAdapter } from "./BirdeyeAdapter.js";
import type { BirdeyeOverviewContext } from "./birdeye.mappers.js";

export interface BirdeyeSelectiveEnrichmentSummary {
  readonly sessionId: string;
  readonly selectedCount: number;
  readonly priceOkCount: number;
  readonly overviewOkCount: number;
  readonly skippedCount: number;
  readonly errorCount: number;
}

export interface BirdeyeSelectiveEnrichmentServiceOptions {
  readonly sessionId: string;
  readonly repositories: Repositories;
  readonly registry: ProviderRegistry;
  readonly config: ProviderConfig["birdeye"];
  readonly decisionLimit?: number;
}

interface BirdeyeCandidate {
  readonly decision: StrategyDecisionRecord;
  readonly selectionReason: string;
}

export class BirdeyeSelectiveEnrichmentService {
  constructor(private readonly options: BirdeyeSelectiveEnrichmentServiceOptions) {}

  async enrich(): Promise<BirdeyeSelectiveEnrichmentSummary> {
    const adapter = findBirdeyeAdapter(this.options.registry);

    if (!adapter) {
      this.writeLog("Birdeye selective enrichment skipped.", {
        reason: "BIRDEYE provider is not enabled.",
      });

      return {
        sessionId: this.options.sessionId,
        selectedCount: 0,
        priceOkCount: 0,
        overviewOkCount: 0,
        skippedCount: 0,
        errorCount: 0,
      };
    }

    const selected = this.selectCandidates().slice(0, this.options.config.maxCandidatesPerCycle);
    let priceOkCount = 0;
    let overviewOkCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const candidate of selected) {
      const mintAddress = candidate.decision.mintAddress as TokenMintAddress;

      try {
        const price = await adapter.getPrice(mintAddress);
        const overview = await adapter.getTokenOverview(mintAddress, {
          selectionReason: candidate.selectionReason,
        });

        priceOkCount += price.ok ? 1 : 0;
        overviewOkCount += overview.ok ? 1 : 0;
        skippedCount += isBudgetSkip(price) || isBudgetSkip(overview) ? 1 : 0;
        errorCount += !price.ok && !isBudgetSkip(price) ? 1 : 0;
        errorCount += !overview.ok && !isBudgetSkip(overview) ? 1 : 0;

        this.writeLog("Birdeye selective candidate enriched.", {
          strategyDecisionId: candidate.decision.id,
          mintAddress,
          decision: candidate.decision.decision,
          score: candidate.decision.score,
          selectionReason: candidate.selectionReason,
          priceOk: price.ok,
          overviewOk: overview.ok,
          marketDataAvailable: price.ok || overview.ok,
          ...(price.ok ? { birdeyePriceUsd: price.data.priceUsd } : {}),
          ...(overview.ok ? { birdeyeOverview: compactOverview(overview.data) } : {}),
        });
      } catch (error) {
        errorCount += 1;
        this.writeLog(
          "Birdeye selective candidate enrichment failed.",
          {
            strategyDecisionId: candidate.decision.id,
            mintAddress,
            error: error instanceof Error ? error.message : "Unknown Birdeye enrichment error.",
          },
          "ERROR",
        );
      }
    }

    const summary = {
      sessionId: this.options.sessionId,
      selectedCount: selected.length,
      priceOkCount,
      overviewOkCount,
      skippedCount,
      errorCount,
    };

    this.writeLog("Birdeye selective enrichment summary.", summary);

    return summary;
  }

  private selectCandidates(): readonly BirdeyeCandidate[] {
    const decisions = this.options.repositories.strategyDecisions.listStrategyDecisions(
      this.options.sessionId,
      {
        limit: this.options.decisionLimit ?? 200,
      },
    );
    const seenMints = new Set<string>();
    const selected: BirdeyeCandidate[] = [];

    for (const decision of decisions) {
      if (seenMints.has(decision.mintAddress)) {
        continue;
      }

      const reason = selectReason(decision, this.options.config.minScore);

      if (!reason) {
        continue;
      }

      seenMints.add(decision.mintAddress);
      selected.push({
        decision,
        selectionReason: reason,
      });
    }

    return selected;
  }

  private writeLog(
    message: string,
    context: unknown,
    level: "ERROR" | "INFO" | "WARN" = "INFO",
  ): void {
    this.options.repositories.systemLogs.createLog({
      sessionId: this.options.sessionId,
      level,
      scope: "PROVIDER",
      message,
      contextJson: stringifyJson(context),
    });
  }
}

function findBirdeyeAdapter(registry: ProviderRegistry): BirdeyeAdapter | undefined {
  return registry
    .listAdapters()
    .find(
      (adapter): adapter is BirdeyeAdapter =>
        adapter.name === "BIRDEYE" && "getTokenOverview" in adapter,
    );
}

function selectReason(decision: StrategyDecisionRecord, minScore: number): string | undefined {
  const score = decision.score ?? -1;
  const snapshot = readSnapshot(decision);
  const riskResult = readNestedString(snapshot, "riskAssessment", "result");
  const missingQuote = readMissingQuote(snapshot);
  const blockers = readBlockingFactors(snapshot);

  if (decision.decision === "WATCH" && riskResult === "PASS") {
    return "WATCH_RISK_PASS";
  }

  if (
    decision.decision === "SKIP" &&
    score >= minScore &&
    (blockers.includes("score_threshold_only") ||
      blockers.includes("unresolved_strategy_gate") ||
      blockers.length === 0)
  ) {
    return "HIGH_SCORE_SKIP";
  }

  if (riskResult === "PASS" && missingQuote && score >= minScore) {
    return "PASS_MISSING_QUOTE";
  }

  if (score >= minScore && decision.decision !== "BUY") {
    return "SCORE_MIN";
  }

  return undefined;
}

function readSnapshot(decision: StrategyDecisionRecord): Readonly<Record<string, unknown>> {
  if (!decision.inputSnapshotJson) {
    return {};
  }

  try {
    const parsed = parseJson<unknown>(decision.inputSnapshotJson);

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readBlockingFactors(snapshot: Readonly<Record<string, unknown>>): readonly string[] {
  const factors = readRecord(snapshot.strategyScore)?.factors;

  if (!Array.isArray(factors)) {
    return [];
  }

  return factors
    .map((item) => (isRecord(item) ? item : undefined))
    .filter((item): item is Readonly<Record<string, unknown>> => item !== undefined)
    .filter((item) => item.passed === false)
    .map((item) => readString(item.name) ?? readString(item.rule) ?? "unresolved_strategy_gate");
}

function readMissingQuote(snapshot: Readonly<Record<string, unknown>>): boolean {
  const facts = readRecord(readRecord(snapshot.strategyScore)?.facts);

  return facts?.maxPriceImpactPct === undefined;
}

function readNestedString(
  snapshot: Readonly<Record<string, unknown>>,
  objectKey: string,
  valueKey: string,
): string | undefined {
  return readString(readRecord(snapshot[objectKey])?.[valueKey]);
}

function isBudgetSkip(
  result: ProviderResult<TokenPriceSnapshot | BirdeyeOverviewContext>,
): boolean {
  return (
    !result.ok &&
    result.error.code === "PROVIDER_UNAVAILABLE" &&
    /budget/i.test(result.error.message)
  );
}

function compactOverview(overview: BirdeyeOverviewContext): Readonly<Record<string, unknown>> {
  return {
    ...(overview.symbol ? { symbol: overview.symbol } : {}),
    ...(overview.name ? { name: overview.name } : {}),
    ...(overview.price !== undefined ? { price: overview.price } : {}),
    ...(overview.liquidity !== undefined ? { liquidity: overview.liquidity } : {}),
    ...(overview.marketCap !== undefined ? { marketCap: overview.marketCap } : {}),
    ...(overview.fdv !== undefined ? { fdv: overview.fdv } : {}),
    ...(overview.holderCount !== undefined ? { holderCount: overview.holderCount } : {}),
    frameCount: Object.keys(overview.frames).length,
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
