import type { ProviderResult, TokenEnrichmentSnapshot } from "@nexustrade/shared";

import type { MarketDataService } from "../providers/MarketDataService.js";
import type { DiscoveredTokenCandidate } from "./ScannerDiscoveryService.js";

export interface EnrichedCandidate {
  readonly candidate: DiscoveredTokenCandidate;
  readonly result: ProviderResult<TokenEnrichmentSnapshot>;
}

export interface CandidateEnrichmentSummary {
  readonly candidates: readonly EnrichedCandidate[];
  readonly attemptedCount: number;
  readonly enrichedCount: number;
  readonly failedCount: number;
  readonly warnings: readonly string[];
}

export interface CandidateEnrichmentServiceOptions {
  readonly marketDataService: Pick<MarketDataService, "enrichToken">;
  readonly concurrency: number;
}

export class CandidateEnrichmentService {
  constructor(private readonly options: CandidateEnrichmentServiceOptions) {}

  async enrichCandidates(
    candidates: readonly DiscoveredTokenCandidate[],
  ): Promise<CandidateEnrichmentSummary> {
    const enriched = await runWithConcurrency(
      candidates,
      this.options.concurrency,
      async (candidate) => ({
        candidate,
        result: await this.options.marketDataService.enrichToken({
          mintAddress: candidate.identity.mintAddress,
        }),
      }),
    );
    const warnings = enriched.flatMap((item) => item.result.warnings);

    return {
      candidates: enriched,
      attemptedCount: candidates.length,
      enrichedCount: enriched.filter((item) => item.result.ok).length,
      failedCount: enriched.filter((item) => !item.result.ok).length,
      warnings,
    };
  }
}

async function runWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  worker: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const outputs = new Array<TOutput>(inputs.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < inputs.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const input = inputs[currentIndex];

      if (input !== undefined) {
        outputs[currentIndex] = await worker(input);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, () => runWorker()),
  );

  return outputs;
}
