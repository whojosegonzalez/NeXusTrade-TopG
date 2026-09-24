import type {
  DecisionTimeMeasurementAuditV1,
  MeasurementSignature,
} from "./ExploratoryMeasurementAuditTypes.js";

export function formatExploratoryMeasurementAuditJson(
  audit: DecisionTimeMeasurementAuditV1,
): string {
  return `${JSON.stringify(sortValue(audit), null, 2)}\n`;
}

export function formatExploratoryMeasurementAuditMarkdown(
  audit: DecisionTimeMeasurementAuditV1,
): string {
  const lines = [
    "# NeXusTrade Decision-Time Measurement Audit",
    "",
    "> Archive-only and stdout-only. This audit is not a strategy analysis, candidate, collection authorization, or execution surface.",
    "",
    "## Archive identity and safety",
    "",
    `- Contract: DecisionTimeMeasurementAuditV${audit.contractVersion}`,
    `- Generated at (audit only): ${audit.generatedAt}`,
    `- Content fingerprint: \`${audit.contentFingerprint}\``,
    `- archiveIdentity: ${audit.archiveIdentity.status}`,
    `- Archive: \`${audit.archiveIdentity.archiveRoot}\``,
    `- Protocol SHA-256: \`${audit.archiveIdentity.protocolSha256}\``,
    `- Final archive state: ${audit.archiveIntegrity.finalOutcome}`,
    `- provider/RPC/HTTP calls: ${audit.safety.providerCalls}`,
    `- database reads/writes: ${audit.safety.databaseReads}/${audit.safety.databaseWrites}`,
    `- filesystem writes: ${audit.safety.filesystemWrites}`,
    `- runtime/session/order/fill/position actions: ${audit.safety.runtimeActions}/${audit.safety.sessionActions}/${audit.safety.orders}/${audit.safety.fills}/${audit.safety.positions}`,
    `- wallet loaded / signing / submission: ${audit.safety.walletLoaded} / ${audit.safety.transactionSigning} / ${audit.safety.transactionSubmission}`,
    `- later-label members interpreted: ${audit.safety.laterLabelMembersInterpreted}`,
    "",
    "## Immutable input inventory",
    "",
    ...audit.archiveIdentity.artifacts.map(
      (artifact) => `- \`${artifact.path}\`: \`${artifact.sha256}\``,
    ),
    "",
    "## Field availability ledger",
    "",
    "| Field | Partition | Available | Total | Availability |",
    "| --- | --- | ---: | ---: | ---: |",
    ...audit.fieldAvailabilityLedger.map(
      (row) =>
        `| ${row.field} | ${row.partition} | ${row.availableAtAnchorCount} | ${row.totalDecisionTimeUnits} | ${formatPercent(row.availabilityPct)} |`,
    ),
    "",
    "## Missingness provenance ledger",
    "",
    "| Field | Partition | Availability | Source | Count | UTC dates |",
    "| --- | --- | --- | --- | ---: | ---: |",
    ...audit.missingnessProvenanceLedger.map(
      (row) =>
        `| ${row.field} | ${row.partition} | ${row.availability} | ${row.sourceCategory}/${row.sourceIdentifier} | ${row.count} | ${row.utcDateCount} |`,
    ),
    "",
    "## Date-distribution ledger",
    "",
    "| Field | UTC date | Available | Total | Unavailable | Availability |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...audit.dateDistributionLedger.map(
      (row) =>
        `| ${row.field} | ${row.utcDate} | ${row.availableAtAnchorCount} | ${row.totalDecisionTimeUnits} | ${row.unavailableCount} | ${formatPercent(row.availabilityPct)} |`,
    ),
    "",
    "## Decision-time source-inventory ledger",
    "",
    "> Source-inventory aggregate co-occurrence is not a per-unit causal join. It cannot establish why a particular unit was unavailable without that field's own bounded availability/provenance signature.",
    "",
    "| UTC date | Category | Provider | Capability | Outcome | Latency | Count |",
    "| --- | --- | --- | --- | --- | --- | ---: |",
    ...audit.decisionTimeSourceInventoryLedger.map(
      (row) =>
        `| ${row.utcDate} | ${row.category} | ${row.provider} | ${row.capability} | ${row.outcomeCode} | ${row.latencyBucket} | ${row.count} |`,
    ),
    "",
    "## Systemic-deficiency ledger",
    "",
    ...audit.systemicDeficiencyLedger.flatMap((row) => [
      `- ${row.field} (${row.auditField}): ${row.qualification}`,
      ...row.partitions.map(
        (partition) =>
          `  - ${partition.partition}: coverage=${partition.coveragePassed ? "PASS" : "FAIL"} (${partition.availableAtAnchorCount}/${partition.totalDecisionTimeUnits}); unavailable=${partition.unavailableCount}; ${formatSignature(partition.dominantSignature, partition.tiedSignatures)}`,
      ),
    ]),
    "",
    "## Outcome",
    "",
    `- Status: ${audit.outcome.status}`,
    `- Reasons: ${audit.outcome.reasons.join(", ")}`,
    `- Next permitted action: ${audit.nextPermittedAction}`,
    "",
    "## Authority boundary",
    "",
    "This result can never authorize a protocol change, collection, candidate, Phase 10.6C work, strategy/default/threshold change, PAPER action, wallet action, signing, submission, order, fill, position, promotion, or live trading. A measurement-revision-ready result permits only a separate human-reviewed measurement-protocol draft.",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function formatSignature(
  dominant: MeasurementSignature | null,
  tied: readonly MeasurementSignature[],
): string {
  if (dominant) {
    return `dominant=${dominant.availability}/${dominant.sourceCategory}/${dominant.sourceIdentifier} (${dominant.count}; ${formatPercent(dominant.unavailableSharePct)}; ${dominant.utcDateCount} dates)`;
  }
  if (tied.length > 0) {
    return `tie=${tied
      .map(
        (signature) =>
          `${signature.availability}/${signature.sourceCategory}/${signature.sourceIdentifier} (${signature.count})`,
      )
      .join(",")}`;
  }
  return "dominant=none";
}

function formatPercent(value: number): string {
  return `${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
  );
}
