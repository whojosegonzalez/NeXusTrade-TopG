import type { WatchlistReturnSummary } from "./WatchlistReturnRunner.js";

export function formatWatchlistReturnSummary(summary: WatchlistReturnSummary): string {
  return [
    `Watchlist returns summary: session=${summary.sessionId}`,
    `selectedStrategyDecisions=${summary.selectedStrategyDecisions}`,
    `scheduled=${summary.scheduledCount}`,
    `alreadyScheduled=${summary.alreadyScheduledCount}`,
    `due=${summary.dueCount}`,
    `observed=${summary.observedCount}`,
    `missed=${summary.missedCount}`,
    `failed=${summary.failedCount}`,
    `dryRun=${summary.dryRun ? "yes" : "no"}`,
  ].join(" ");
}

export function formatWatchlistReturnJson(summary: WatchlistReturnSummary): string {
  return JSON.stringify(summary, null, 2);
}
