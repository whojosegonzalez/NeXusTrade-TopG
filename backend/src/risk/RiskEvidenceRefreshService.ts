import {
  mergeTokenEnrichmentSources,
  parseTokenMintAddress,
  type ProviderResult,
  type QuoteRequest,
  type TokenEnrichmentSnapshot,
  type TokenMintAddress,
} from "@nexustrade/shared";

import type { TokenRadarRecord } from "../db/schema/index.js";
import type { MarketDataService } from "../providers/MarketDataService.js";
import type { QuoteBudgetPlan, QuoteBudgetPlanEntry } from "../providers/quotes/index.js";
import type { RiskRuntimeConfig } from "./RiskConfig.js";

export const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");

export interface RiskEvidenceRefreshResult {
  readonly enrichment: TokenEnrichmentSnapshot;
  readonly warnings: readonly string[];
  readonly quoteBudget?: RiskQuoteBudgetEvidence | undefined;
}

export interface RiskQuoteBudgetEvidence extends QuoteBudgetPlanEntry {
  readonly enabled: boolean;
  readonly candidateCount: number;
  readonly selectedCount: number;
  readonly notSelectedCount: number;
  readonly limit: number;
}

export class RiskEvidenceRefreshService {
  constructor(private readonly marketDataService: Pick<MarketDataService, "enrichToken">) {}

  async refreshCandidate(
    candidate: TokenRadarRecord,
    config: RiskRuntimeConfig,
    quoteBudget?: RiskQuoteBudgetEvidence,
  ): Promise<RiskEvidenceRefreshResult> {
    const mintAddress = parseTokenMintAddress(candidate.mintAddress);

    if (quoteBudget && !quoteBudget.selected) {
      const enrichment = await this.requireEnrichment(
        this.marketDataService.enrichToken({
          mintAddress,
        }),
      );

      return {
        enrichment,
        warnings: [
          ...enrichment.warnings,
          `QUOTE_BUDGET_NOT_SELECTED: rank=${quoteBudget.rank ?? "n/a"} limit=${quoteBudget.limit} batch=${quoteBudget.candidateCount}.`,
        ],
        quoteBudget,
      };
    }

    const buyQuoteRequest = createBuyQuoteRequest(mintAddress, config.probeAmountLamports);
    const buyEnrichment = await this.requireEnrichment(
      this.marketDataService.enrichToken({
        mintAddress,
        buyQuoteRequest,
      }),
    );
    const warnings = [...buyEnrichment.warnings];

    if (!buyEnrichment.buyQuote) {
      warnings.push("Buy quote unavailable; sell quote probe skipped.");

      return {
        enrichment: buyEnrichment,
        warnings,
        ...(quoteBudget ? { quoteBudget } : {}),
      };
    }

    const sellQuoteRequest = createSellQuoteRequest(
      mintAddress,
      buyEnrichment.buyQuote.outputAmountRaw,
    );
    const sellEnrichment = await this.requireEnrichment(
      this.marketDataService.enrichToken({
        mintAddress,
        sellQuoteRequest,
      }),
    );
    const enrichment = mergeSellQuote(buyEnrichment, sellEnrichment);

    if (!enrichment.sellQuote) {
      warnings.push("Sell quote unavailable.");
    }

    return {
      enrichment,
      warnings: [...warnings, ...sellEnrichment.warnings],
      ...(quoteBudget ? { quoteBudget } : {}),
    };
  }

  private async requireEnrichment(
    resultPromise: Promise<ProviderResult<TokenEnrichmentSnapshot>>,
  ): Promise<TokenEnrichmentSnapshot> {
    const result = await resultPromise;

    if (!result.ok) {
      throw new Error(`${result.provider}: ${result.error.code} - ${result.error.message}`);
    }

    return result.data;
  }
}

export function createRiskQuoteBudgetEvidence(
  plan: QuoteBudgetPlan,
  entry: QuoteBudgetPlanEntry,
): RiskQuoteBudgetEvidence {
  return {
    ...entry,
    enabled: plan.enabled,
    candidateCount: plan.candidateCount,
    selectedCount: plan.selectedCount,
    notSelectedCount: plan.notSelectedCount,
    limit: plan.limit,
  };
}

function createBuyQuoteRequest(
  mintAddress: TokenMintAddress,
  probeAmountLamports: number,
): QuoteRequest {
  return {
    inputMint: SOL_MINT,
    outputMint: mintAddress,
    amountRaw: String(probeAmountLamports),
    side: "BUY",
    slippageBps: 100,
  };
}

function createSellQuoteRequest(
  mintAddress: TokenMintAddress,
  tokenAmountRaw: string,
): QuoteRequest {
  return {
    inputMint: mintAddress,
    outputMint: SOL_MINT,
    amountRaw: tokenAmountRaw,
    side: "SELL",
    slippageBps: 100,
  };
}

function mergeSellQuote(
  buyEnrichment: TokenEnrichmentSnapshot,
  sellEnrichment: TokenEnrichmentSnapshot,
): TokenEnrichmentSnapshot {
  let sourcesUsed = buyEnrichment.sourcesUsed;

  for (const source of sellEnrichment.sourcesUsed) {
    sourcesUsed = mergeTokenEnrichmentSources(sourcesUsed, source);
  }

  return {
    ...buyEnrichment,
    ...(sellEnrichment.sellQuote ? { sellQuote: sellEnrichment.sellQuote } : {}),
    sourcesUsed,
    warnings: [...buyEnrichment.warnings, ...sellEnrichment.warnings],
    fetchedAt:
      sellEnrichment.fetchedAt.getTime() > buyEnrichment.fetchedAt.getTime()
        ? sellEnrichment.fetchedAt
        : buyEnrichment.fetchedAt,
  };
}
