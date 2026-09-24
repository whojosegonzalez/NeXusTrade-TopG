import type { FastShadowObservationSummary } from "./FastShadowTypes.js";

export function formatFastShadowObservationSummary(summary: FastShadowObservationSummary): string {
  return [
    `Fast shadow observation summary: session=${summary.sessionId} profile=${summary.profileKey}`,
    `eligible=${summary.eligibleCount}`,
    `selected=${summary.selectedCount}`,
    `capSuppressed=${summary.capSuppressedCount}`,
    `duplicateMintSuppressed=${summary.duplicateMintSuppressedCount}`,
    `scheduled=${summary.scheduledCount}`,
    `alreadyScheduled=${summary.alreadyScheduledCount}`,
    `due=${summary.dueCount}`,
    `observed=${summary.observedCount}`,
    `missed=${summary.missedCount}`,
    `failed=${summary.failedCount}`,
    `dryRun=${summary.dryRun ? "yes" : "no"}`,
  ].join(" ");
}

export function formatFastShadowObservationJson(summary: FastShadowObservationSummary): string {
  return JSON.stringify(summary, null, 2);
}
