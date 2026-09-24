import type { MeasurementCohortAnalysisV1 } from "./MeasurementCohortAnalysisTypes.js";

export function formatMeasurementCohortAnalysisJson(analysis: MeasurementCohortAnalysisV1): string {
  return `${JSON.stringify(sortValue(analysis), null, 2)}\n`;
}

export function formatMeasurementCohortAnalysisMarkdown(
  analysis: MeasurementCohortAnalysisV1,
): string {
  const lines = [
    "# NeXusTrade V3 Measurement Capability Analysis",
    "",
    "> Archive-only and stdout-only. This command made zero provider/RPC/HTTP calls, database reads or writes, filesystem writes, runtime/session actions, orders, fills, positions, wallet actions, signing, or submission.",
    "",
    "## Identity and safety",
    "",
    `- Archive identity: ${analysis.archiveIdentity.status}`,
    `- Archive finality: ${analysis.archiveFinality}`,
    `- Archive root: ${analysis.archiveIdentity.archiveRoot}`,
    `- Protocol SHA-256: ${analysis.archiveIdentity.protocolSha256}`,
    ...analysis.archiveIdentity.artifacts.map(
      (artifact) => `- Artifact ${artifact.path}: ${artifact.sha256}`,
    ),
    `- Final archive outcome: ${analysis.finalArchiveOutcome}`,
    `- Analysis status: ${analysis.outcome.status}`,
    `- Generated at (audit only): ${analysis.generatedAt}`,
    `- Content fingerprint: \`${analysis.contentFingerprint}\``,
    `- Provider/RPC/HTTP calls: ${analysis.safety.providerCalls}`,
    `- Database reads/writes: ${analysis.safety.databaseReads}/${analysis.safety.databaseWrites}`,
    `- Filesystem writes: ${analysis.safety.filesystemWrites}`,
    `- Runtime/session/order/fill/position actions: ${analysis.safety.runtimeActions}/${analysis.safety.sessionActions}/${analysis.safety.orders}/${analysis.safety.fills}/${analysis.safety.positions}`,
    `- Wallet loaded / signing / submission: ${analysis.safety.walletLoaded} / ${analysis.safety.transactionSigning} / ${analysis.safety.transactionSubmission}`,
    `- Later-label members interpreted: ${analysis.safety.laterLabelMembersInterpreted}`,
    "",
    "## Cohort sufficiency",
    "",
    `- Attempted slots: ${analysis.cohortSufficiency.attemptedSlotCount}`,
    `- Valid units: ${analysis.cohortSufficiency.validUnitCount}/${analysis.cohortSufficiency.plannedValidUnitCount}`,
    `- Distinct mints: ${analysis.cohortSufficiency.distinctMintCount}`,
    `- UTC dates: ${analysis.cohortSufficiency.utcDateCount}; maximum date share: ${formatNumber(analysis.cohortSufficiency.maximumUtcDateSharePct)}%`,
    ...analysis.cohortSufficiency.partitions.map(
      (partition) =>
        `- ${partition.partition}: units=${partition.validUnitCount}; UTC dates=${partition.utcDateCount}`,
    ),
    ...analysis.cohortSufficiency.gates.map(
      (gate) => `- ${gate.passed ? "PASS" : "FAIL"} — ${gate.gate}`,
    ),
    "",
    "## Objective availability ledger",
    "",
    ...analysis.objectiveAvailabilityLedger.flatMap((row) => [
      `- ${row.objective}/${row.partition}: available=${row.availableAtAnchorCount}/${row.validUnitCount} (${formatNumber(row.availabilityPct)}%); dates=${row.availableUtcDateCount}; availability=${row.availabilityGatePassed ? "PASS" : "FAIL"}; date support=${row.dateSupportGatePassed ? "PASS" : "FAIL"}; provenance=${row.provenanceGatePassed ? "PASS" : "FAIL"}; freshness=${row.freshnessGatePassed ? "PASS" : "FAIL"}`,
      ...Object.entries(row.availabilityCounts).map(
        ([code, count]) => `- ${row.objective}/${row.partition}/${code}: count=${count}`,
      ),
    ]),
    "",
    "## Missingness and source evidence",
    "",
    ...analysis.missingnessLedger.map(
      (row) =>
        `- ${row.objective}/${row.partition}/${row.utcDate}/${row.availability}/${row.sourceCategory}/${row.sourceIdentifier}: count=${row.count}`,
    ),
    ...analysis.sourceInventoryLedger.map(
      (row) =>
        `- source ${row.utcDate}/${row.category}/${row.capability}/${row.outcomeCode}/${row.latencyBucket}: count=${row.count}`,
    ),
    "",
    "## Final gate ledger",
    "",
    ...analysis.finalGateLedger.map(
      (gate) => `- ${gate.passed ? "PASS" : "FAIL"} — ${gate.gate}/${gate.partition}`,
    ),
    "",
    `- Status: ${analysis.outcome.status}`,
    `- Failed frozen gate IDs: ${analysis.outcome.failedGateIds.length === 0 ? "none" : analysis.outcome.failedGateIds.join(", ")}`,
    `- Next permitted action: ${analysis.nextPermittedAction}`,
    "",
    ...analysis.warnings.map((warning) => `- ${warning}`),
  ];
  return `${lines.join("\n")}\n`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
  );
}
