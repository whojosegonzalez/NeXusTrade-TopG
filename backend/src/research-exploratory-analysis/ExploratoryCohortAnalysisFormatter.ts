import type { ExploratoryCohortAnalysisV1 } from "./ExploratoryCohortAnalysisTypes.js";

export function formatExploratoryCohortAnalysisJson(analysis: ExploratoryCohortAnalysisV1): string {
  return `${JSON.stringify(sortValue(analysis), null, 2)}\n`;
}

export function formatExploratoryCohortAnalysisMarkdown(
  analysis: ExploratoryCohortAnalysisV1,
): string {
  const lines = [
    "# NeXusTrade Exploratory Cohort Analysis",
    "",
    "> Archive-only and stdout-only. This command made zero provider/RPC/HTTP calls, database reads or writes, filesystem writes, runtime actions, sessions, orders, fills, positions, wallet actions, signing, or submission.",
    "",
    "## Scope and safety",
    "",
    `- Contract: ExploratoryCohortAnalysisV${analysis.contractVersion}`,
    `- Generated at (audit only): ${analysis.generatedAt}`,
    `- Content fingerprint: \`${analysis.contentFingerprint}\``,
    `- Archive identity: ${analysis.archiveIdentity.status}`,
    `- Archive: \`${analysis.archiveIdentity.archiveRoot}\``,
    `- Protocol SHA-256: \`${analysis.archiveIdentity.protocolSha256}\``,
    `- Final archive state: ${analysis.archiveIntegrity.finalOutcome}`,
    "",
    "## Immutable input inventory",
    "",
    ...analysis.inputInventory.map((entry) => `- \`${entry.path}\`: \`${entry.sha256}\``),
    "",
    "## Quality and independence gates",
    "",
    `- Valid units: ${analysis.cohortQuality.validUnitCount}`,
    `- Partitions: discovery=${analysis.cohortQuality.partitionCounts.DISCOVERY}, validation=${analysis.cohortQuality.partitionCounts.VALIDATION}`,
    ...analysis.cohortQuality.gates.map(
      (gate) =>
        `- ${gate.passed ? "PASS" : "FAIL"} — ${gate.id}: ${formatNumber(gate.numerator)}/${formatNumber(gate.denominator)}`,
    ),
    "",
    "## Decision-time coverage",
    "",
    ...analysis.decisionTimeCoverage.map(
      (entry) =>
        `- ${entry.field}: discovery ${entry.discoveryAvailable}/${entry.discoveryTotal}; validation ${entry.validationAvailable}/${entry.validationTotal}; catalog=${entry.eligibleForCatalog ? "eligible" : "unavailable"}`,
    ),
    "",
    "## Later-label boundary",
    "",
    "> Only the pre-registered 60-minute label is used for fixed effect and validation calculations. The 3/5/15-minute rows below describe availability only; no later label is a predicate input.",
    "",
    ...analysis.secondaryLabelDescription.map(
      (entry) =>
        `- ${entry.minutesAfterAnchor}m availability: on-time=${entry.observedOnTimeCount}; other=${entry.otherAvailabilityCount}`,
    ),
    ...(["DISCOVERY", "VALIDATION"] as const).map((partition) => {
      const labels = analysis.primaryLabelAnalysis[partition];
      return `- 60m ${partition.toLowerCase()}: usable=${labels.usable60mCount}; positive=${labels.positive60mCount}; non-positive=${labels.nonPositive60mCount}; unusable=${labels.unusable60mCount}`;
    }),
    "",
    "## Fixed catalog ledger",
    "",
    ...analysis.catalogLedger.map((entry) => {
      const evidence = entry.discoveryEvidence;
      return `- ${entry.catalogRuleId}: threshold=${entry.discoveryThreshold === null ? "unavailable" : formatNumber(entry.discoveryThreshold)}; support=${evidence.support}; comparison=${evidence.comparisonSupport}; difference=${evidence.positiveRateDifference === null ? "unavailable" : formatNumber(evidence.positiveRateDifference)}; discovery=${evidence.eligible ? "eligible" : evidence.failureCodes.join(",")}`;
    }),
    "",
    "## Held validation",
    "",
    ...formatValidation(analysis),
    "",
    "## Outcome",
    "",
    `- Status: ${analysis.outcome.status}`,
    `- Reasons: ${analysis.outcome.reasons.join(", ")}`,
    `- Next permitted action: ${analysis.nextPermittedAction}`,
    ...formatDescriptor(analysis),
    "",
    "## Authority boundary",
    "",
    "This archive-only result does not authorize a strategy change, collection, Phase 10.6C validation, PAPER execution, promotion, order, fill, position, wallet action, signing, or submission.",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function formatValidation(analysis: ExploratoryCohortAnalysisV1): string[] {
  const validation = analysis.validationLedger;
  if (!validation) return ["No discovery rule advanced to held validation."];
  return [
    `- Rule: ${validation.catalogRuleId}`,
    `- Support: ${validation.support}; comparison: ${validation.comparisonSupport}; effect=${validation.positiveRateDifference === null ? "unavailable" : formatNumber(validation.positiveRateDifference)}; Fisher greater p=${validation.fisherGreaterPValue === null ? "unavailable" : formatNumber(validation.fisherGreaterPValue)}`,
    `- Date stability: ${validation.leaveOneDateOutStable ? "pass" : "fail"}; overall=${validation.passed ? "pass" : `fail (${validation.failureCodes.join(",")})`}`,
  ];
}

function formatDescriptor(analysis: ExploratoryCohortAnalysisV1): string[] {
  const descriptor = analysis.candidateDescriptor;
  if (!descriptor) return [];
  return [
    "",
    "### Non-authorizing candidate descriptor",
    "",
    `- Rule: ${descriptor.catalogRuleId}; field: ${descriptor.decisionTimeField}; comparator: ${descriptor.comparator}; threshold=${formatNumber(descriptor.discoveryThreshold)}`,
    `- Required next record: ${descriptor.requiredNextRecord}; action: ${descriptor.nextPermittedAction}`,
  ];
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
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
  );
}
