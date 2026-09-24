import { createHash } from "node:crypto";

import type { MeasurementCollectionResult } from "./MeasurementCohortTypes.js";

export function formatMeasurementCollection(
  result: MeasurementCollectionResult,
  format: "markdown" | "json",
): string {
  const body = {
    contractVersion: "1",
    contentFingerprint: "",
    result,
    safety: {
      databaseReads: 0,
      databaseWrites: 0,
      runtimeCalls: 0,
      sessions: 0,
      orders: 0,
      fills: 0,
      positions: 0,
      walletLoaded: false,
      transactionSigning: false,
      transactionSubmission: false,
      laterObservations: 0,
    },
  } as const;
  const report = { ...body, contentFingerprint: fingerprint(body) };
  return format === "json" ? `${JSON.stringify(sort(report), null, 2)}\n` : markdown(report);
}

function markdown(report: {
  readonly contentFingerprint: string;
  readonly result: MeasurementCollectionResult;
}): string {
  return [
    "# Phase 10.6A V3 Measurement-Only Collection",
    "",
    `- Outcome: ${report.result.outcome}`,
    `- Archive root: ${report.result.archiveRoot}`,
    `- Slot: ${report.result.slotId ?? "none"}`,
    `- Valid units: ${report.result.validUnitCount}`,
    `- Provider calls: ${report.result.providerCalls}`,
    "- Database/runtime/session/execution: 0 / 0 / 0",
    `- Content fingerprint: ${report.contentFingerprint}`,
    "",
    `Next permitted action: ${report.result.nextPermittedAction}`,
    "",
  ].join("\n");
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sort(value)))
    .digest("hex");
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
  );
}
