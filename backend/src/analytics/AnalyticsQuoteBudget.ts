import type { QuoteBudgetEvidence } from "./AnalyticsJsonReaders.js";
import type { QuoteBudgetReport } from "./AnalyticsReportTypes.js";
export function buildQuoteBudgetReport(
  rows: readonly (QuoteBudgetEvidence | undefined)[],
): QuoteBudgetReport {
  const selectionReasonCounts: Record<string, number> = {};
  const signalCounts: Record<string, number> = {};
  const rankBucketCounts: Record<string, number> = {};
  let assessmentsWithPlan = 0;
  let selectedCount = 0;
  let notSelectedCount = 0;
  let quoteSuccessCount = 0;

  for (const evidence of rows) {
    if (!evidence) {
      continue;
    }

    assessmentsWithPlan += 1;
    selectionReasonCounts[evidence.selectionReason] =
      (selectionReasonCounts[evidence.selectionReason] ?? 0) + 1;
    selectedCount += evidence.selected ? 1 : 0;
    notSelectedCount += evidence.selected ? 0 : 1;

    for (const signal of evidence.candidateSignals) {
      signalCounts[signal] = (signalCounts[signal] ?? 0) + 1;
    }

    if (evidence.rank !== undefined) {
      const bucket = rankBucket(evidence.rank);
      rankBucketCounts[bucket] = (rankBucketCounts[bucket] ?? 0) + 1;
    }

    if (evidence.selected && evidence.buyQuoteObserved) {
      quoteSuccessCount += 1;
    }
  }

  return {
    assessmentsWithPlan,
    selectedCount,
    notSelectedCount,
    skippedLiveCallsEstimate: notSelectedCount,
    selectionReasonCounts,
    signalCounts,
    rankBucketCounts,
    quoteSuccessCount,
  };
}

function rankBucket(rank: number): string {
  if (rank <= 5) {
    return "1-5";
  }

  if (rank <= 10) {
    return "6-10";
  }

  if (rank <= 20) {
    return "11-20";
  }

  return "21+";
}
