import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import type { ResearchInterpretationCandidate } from "../research-interpretation/ResearchInterpretationTypes.js";
import type {
  ResearchTruthingQuoteExplanationConfidence,
  ResearchTruthingMissingQuoteCategory,
  ResearchTruthingQuoteEvidenceRow,
  ResearchTruthingQuoteEvidenceSummary,
} from "./ResearchTruthingTypes.js";

const QUOTE_CATEGORIES: readonly ResearchTruthingMissingQuoteCategory[] = [
  "QUOTE_AVAILABLE",
  "NO_BUY_QUOTE",
  "NO_SELL_QUOTE",
  "NO_ROUND_TRIP_QUOTE",
  "PRICE_IMPACT_MISSING",
  "PROVIDER_RATE_LIMITED",
  "ROUTER_COOLDOWN",
  "PROVIDER_UNAVAILABLE",
  "ROUTE_UNSUPPORTED",
  "POLICY_SKIPPED",
  "BIRDEYE_MARKET_DATA_ONLY",
  "INSUFFICIENT_ARCHIVE_EVIDENCE",
  "UNEXPLAINED",
];

export class QuoteEvidenceTruthService {
  summarize(input: {
    readonly archives: readonly ResearchArchiveMetadata[];
    readonly candidates: readonly ResearchInterpretationCandidate[];
    readonly limit: number;
  }): ResearchTruthingQuoteEvidenceSummary {
    const pressureByRun = new Map(
      input.archives.map((archive) => [archive.label, archive.terminalSummary.providerPressure]),
    );
    const rows = input.candidates.map((candidate) =>
      this.buildRow(candidate, pressureByRun.get(candidate.runLabel)),
    );
    const missingRows = rows.filter((row) => row.missingQuote);
    const categoryCounts = createCategoryCounts();
    const explanationConfidenceCounts = createConfidenceCounts();
    const providerCounts: Record<string, number> = {};
    const sourceTypeCounts: Record<string, number> = {};
    const failureReasonCounts: Record<string, number> = {};

    for (const row of rows) {
      categoryCounts[row.missingQuoteCategory] += 1;
      if (row.missingQuote) {
        explanationConfidenceCounts[row.missingQuoteExplanationConfidence] += 1;
      }
      increment(providerCounts, row.buyQuoteProvider);
      increment(providerCounts, row.sellQuoteProvider);
      increment(sourceTypeCounts, row.buyQuoteSourceType);
      increment(sourceTypeCounts, row.sellQuoteSourceType);
      increment(failureReasonCounts, row.buyQuoteFailureReason);
      increment(failureReasonCounts, row.sellQuoteFailureReason);
    }

    mergePressureCounts({
      archives: input.archives,
      providerCounts,
      sourceTypeCounts,
      failureReasonCounts,
    });

    return {
      totalCandidates: rows.length,
      missingQuoteCount: missingRows.length,
      directMissingQuoteCount: explanationConfidenceCounts.DIRECT,
      correlatedMissingQuoteCount: explanationConfidenceCounts.CORRELATED,
      insufficientArchiveEvidenceMissingQuoteCount:
        explanationConfidenceCounts.INSUFFICIENT_ARCHIVE_EVIDENCE,
      unclassifiedMissingQuoteCount: explanationConfidenceCounts.UNCLASSIFIED,
      quotePresentButImpactMissingCount: rows.filter((row) => row.quotePresentButImpactMissing)
        .length,
      buyQuoteAvailableCount: rows.filter((row) => row.buyQuoteAvailable).length,
      sellQuoteAvailableCount: rows.filter((row) => row.sellQuoteAvailable).length,
      roundTripQuoteAvailableCount: rows.filter((row) => row.roundTripQuoteAvailable).length,
      buyPriceImpactAvailableCount: rows.filter((row) => row.buyPriceImpactAvailable).length,
      sellPriceImpactAvailableCount: rows.filter((row) => row.sellPriceImpactAvailable).length,
      roundTripImpactAvailableCount: rows.filter((row) => row.roundTripImpactAvailable).length,
      categoryCounts,
      explanationConfidenceCounts,
      providerCounts,
      sourceTypeCounts,
      failureReasonCounts,
      exampleRows: [...rows]
        .filter((row) => row.missingQuote || row.quotePresentButImpactMissing)
        .sort((left, right) => (right.score ?? -1) - (left.score ?? -1))
        .slice(0, input.limit),
      notes: buildNotes(rows),
    };
  }

  private buildRow(
    candidate: ResearchInterpretationCandidate,
    pressure: ResearchArchiveMetadata["terminalSummary"]["providerPressure"] | undefined,
  ): ResearchTruthingQuoteEvidenceRow {
    const buyQuoteAvailable = !candidate.missingQuote;
    const buyPriceImpactAvailable = buyQuoteAvailable && !candidate.missingPriceImpact;
    const quotePresentButImpactMissing = buyQuoteAvailable && candidate.missingPriceImpact;
    const category = classifyMissingQuote(candidate, pressure);
    const explanationConfidence = classifyExplanationConfidence({
      candidate,
      category,
      pressure,
    });
    const failureReason = candidate.missingQuote
      ? explainFailureReason(category, pressure)
      : undefined;

    return {
      runLabel: candidate.runLabel,
      decisionId: candidate.decisionId,
      mintAddress: candidate.mintAddress,
      ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
      decision: candidate.decision,
      score: candidate.score,
      missingQuote: candidate.missingQuote,
      missingPriceImpact: candidate.missingPriceImpact,
      buyQuoteAvailable,
      sellQuoteAvailable: false,
      roundTripQuoteAvailable: false,
      buyPriceImpactAvailable,
      sellPriceImpactAvailable: false,
      roundTripImpactAvailable: false,
      ...(buyQuoteAvailable ? { buyQuoteProvider: "ARCHIVED_QUOTE_EVIDENCE" } : {}),
      ...(buyQuoteAvailable ? { buyQuoteSourceType: "ARCHIVED" } : {}),
      ...(failureReason ? { buyQuoteFailureReason: failureReason } : {}),
      quotePresentButImpactMissing,
      missingQuoteCategory: category,
      missingQuoteExplanationConfidence: explanationConfidence,
      missingQuoteExplanation: explainCategory(category, candidate),
    };
  }
}

function classifyExplanationConfidence(input: {
  readonly candidate: ResearchInterpretationCandidate;
  readonly category: ResearchTruthingMissingQuoteCategory;
  readonly pressure: ResearchArchiveMetadata["terminalSummary"]["providerPressure"] | undefined;
}): ResearchTruthingQuoteExplanationConfidence {
  if (!input.candidate.missingQuote) {
    return "DIRECT";
  }

  if (hasDirectQuoteAttemptEvidence(input.candidate)) {
    return "DIRECT";
  }

  if (
    input.category === "ROUTER_COOLDOWN" ||
    input.category === "PROVIDER_RATE_LIMITED" ||
    input.category === "PROVIDER_UNAVAILABLE" ||
    input.category === "ROUTE_UNSUPPORTED" ||
    input.category === "POLICY_SKIPPED"
  ) {
    return input.pressure ? "CORRELATED" : "UNCLASSIFIED";
  }

  if (input.category === "INSUFFICIENT_ARCHIVE_EVIDENCE") {
    return "INSUFFICIENT_ARCHIVE_EVIDENCE";
  }

  return "UNCLASSIFIED";
}

function hasDirectQuoteAttemptEvidence(candidate: ResearchInterpretationCandidate): boolean {
  return [...candidate.blockingFactors, ...candidate.riskFlags].some((factor) =>
    /(?:jupiter|raydium|router).*(?:rate.limit|cooldown|unavailable|no.route)|(?:rate.limit|cooldown|unavailable|no.route).*(?:jupiter|raydium|router)/i.test(
      factor,
    ),
  );
}

function classifyMissingQuote(
  candidate: ResearchInterpretationCandidate,
  pressure: ResearchArchiveMetadata["terminalSummary"]["providerPressure"] | undefined,
): ResearchTruthingMissingQuoteCategory {
  if (!candidate.missingQuote) {
    return candidate.missingPriceImpact ? "PRICE_IMPACT_MISSING" : "QUOTE_AVAILABLE";
  }

  if (hasPositiveCount(pressure?.quoteSourceTypeCounts, "SKIPPED_COOLDOWN")) {
    return "ROUTER_COOLDOWN";
  }

  const jupiter = pressure?.providers.find((provider) => provider.provider === "JUPITER");

  if ((jupiter?.liveRateLimitedCount ?? 0) > 0) {
    return "PROVIDER_RATE_LIMITED";
  }

  const raydium = pressure?.providers.find((provider) => provider.provider === "RAYDIUM");

  if (
    (raydium?.routerUnavailable ?? 0) > 0 ||
    hasPositiveCount(raydium?.raydiumFailureCategoryCounts, "RAYDIUM_UNAVAILABLE")
  ) {
    return "PROVIDER_UNAVAILABLE";
  }

  if (hasPositiveCount(raydium?.raydiumPreflightStatusCounts, "NO_POOL")) {
    return "ROUTE_UNSUPPORTED";
  }

  const birdeye = pressure?.providers.find((provider) => provider.provider === "BIRDEYE");

  if (hasPositiveCount(birdeye?.birdeyeFailureCategoryCounts, "BIRDEYE_CU_BUDGET_EXHAUSTED")) {
    return "POLICY_SKIPPED";
  }

  if (candidate.missingPriceImpact) {
    return "PRICE_IMPACT_MISSING";
  }

  if (pressure) {
    return "INSUFFICIENT_ARCHIVE_EVIDENCE";
  }

  return "UNEXPLAINED";
}

function explainCategory(
  category: ResearchTruthingMissingQuoteCategory,
  candidate: ResearchInterpretationCandidate,
): string {
  switch (category) {
    case "QUOTE_AVAILABLE":
      return "Archived strategy attribution did not flag MISSING_QUOTE.";
    case "PRICE_IMPACT_MISSING":
      return "Quote-like evidence existed, but price-impact evidence was missing or unavailable.";
    case "ROUTER_COOLDOWN":
      return "Run-level quote router evidence shows cooldown skips during this archive; this is correlated, not candidate-linked, evidence.";
    case "PROVIDER_RATE_LIMITED":
      return "Run-level live provider evidence shows quote-provider rate limiting; this is correlated, not candidate-linked, evidence.";
    case "PROVIDER_UNAVAILABLE":
      return "Run-level quote fallback evidence shows provider unavailable behavior; this is correlated, not candidate-linked, evidence.";
    case "ROUTE_UNSUPPORTED":
      return "Run-level preflight evidence suggests no supported route or pool; this is correlated, not candidate-linked, evidence.";
    case "POLICY_SKIPPED":
      return "Run-level policy evidence shows budget/cap based provider skips; this is correlated, not candidate-linked, evidence.";
    case "INSUFFICIENT_ARCHIVE_EVIDENCE":
      return "Archived Phase 9.4 data cannot attribute this candidate to a specific buy/sell quote attempt.";
    case "UNEXPLAINED":
      return "No archived provider or strategy evidence explains the missing quote.";
    case "BIRDEYE_MARKET_DATA_ONLY":
      return "Birdeye evidence is market data and does not count as executable quote evidence.";
    case "NO_BUY_QUOTE":
    case "NO_SELL_QUOTE":
    case "NO_ROUND_TRIP_QUOTE":
      return `Archived evidence does not contain ${category.toLowerCase()} detail for ${candidate.mintAddress}.`;
  }
}

function explainFailureReason(
  category: ResearchTruthingMissingQuoteCategory,
  pressure: ResearchArchiveMetadata["terminalSummary"]["providerPressure"] | undefined,
): string | undefined {
  if (!pressure) {
    return undefined;
  }

  switch (category) {
    case "ROUTER_COOLDOWN":
      return "ROUTER_COOLDOWN";
    case "PROVIDER_RATE_LIMITED":
      return "PROVIDER_RATE_LIMITED";
    case "PROVIDER_UNAVAILABLE":
      return "PROVIDER_UNAVAILABLE";
    case "ROUTE_UNSUPPORTED":
      return "ROUTE_UNSUPPORTED";
    case "POLICY_SKIPPED":
      return "POLICY_SKIPPED";
    case "INSUFFICIENT_ARCHIVE_EVIDENCE":
      return "INSUFFICIENT_ARCHIVE_EVIDENCE";
    case "UNEXPLAINED":
      return "UNEXPLAINED";
    default:
      return undefined;
  }
}

function mergePressureCounts(input: {
  readonly archives: readonly ResearchArchiveMetadata[];
  readonly providerCounts: Record<string, number>;
  readonly sourceTypeCounts: Record<string, number>;
  readonly failureReasonCounts: Record<string, number>;
}): void {
  for (const archive of input.archives) {
    for (const provider of archive.terminalSummary.providerPressure.providers) {
      input.providerCounts[provider.provider] =
        (input.providerCounts[provider.provider] ?? 0) + provider.total;
      mergeCounts(input.sourceTypeCounts, provider.quoteSourceTypeCounts);
      mergeCounts(input.failureReasonCounts, provider.quoteFallbackReasonCounts);
      mergeCounts(input.failureReasonCounts, provider.raydiumFailureCategoryCounts);
      mergeCounts(input.failureReasonCounts, provider.birdeyeFailureCategoryCounts);
    }
  }
}

function buildNotes(rows: readonly ResearchTruthingQuoteEvidenceRow[]): readonly string[] {
  const notes: string[] = [];
  const missingRows = rows.filter((row) => row.missingQuote);
  const insufficientRows = missingRows.filter(
    (row) => row.missingQuoteCategory === "INSUFFICIENT_ARCHIVE_EVIDENCE",
  );

  notes.push(
    "Birdeye price/overview evidence is market-data evidence and is not counted as executable quote evidence.",
  );
  notes.push(
    "Phase 9.4 archives do not preserve complete per-candidate buy-versus-sell quote attempts. Run-level provider pressure is correlated evidence, not proof of an individual candidate failure.",
  );

  if (insufficientRows.length > 0) {
    notes.push(
      `${insufficientRows.length} missing-quote rows need Phase 9.4A.2 quote-attempt telemetry for candidate-level attribution.`,
    );
  }

  return notes;
}

function createCategoryCounts(): Record<ResearchTruthingMissingQuoteCategory, number> {
  return Object.fromEntries(QUOTE_CATEGORIES.map((category) => [category, 0])) as Record<
    ResearchTruthingMissingQuoteCategory,
    number
  >;
}

function createConfidenceCounts(): Record<ResearchTruthingQuoteExplanationConfidence, number> {
  return {
    DIRECT: 0,
    CORRELATED: 0,
    INSUFFICIENT_ARCHIVE_EVIDENCE: 0,
    UNCLASSIFIED: 0,
  };
}

function hasPositiveCount(
  counts: Readonly<Record<string, number>> | undefined,
  key: string,
): boolean {
  return (counts?.[key] ?? 0) > 0;
}

function mergeCounts(
  target: Record<string, number>,
  source: Readonly<Record<string, number>>,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function increment(counts: Record<string, number>, key: string | undefined): void {
  if (!key) {
    return;
  }

  counts[key] = (counts[key] ?? 0) + 1;
}
