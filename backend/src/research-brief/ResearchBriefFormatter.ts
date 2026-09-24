import type { ResearchBriefV1 } from "./ResearchBriefTypes.js";

export function formatResearchBriefJson(brief: ResearchBriefV1): string {
  return `${JSON.stringify(sortValue(brief), null, 2)}\n`;
}

export function formatResearchBriefMarkdown(brief: ResearchBriefV1): string {
  const lines = [
    "# NeXusTrade Local Research Brief",
    "",
    "> Archive-only and read-only. This command made zero provider/RPC/HTTP calls, database reads or writes, filesystem writes, runtime actions, sessions, orders, fills, positions, wallet actions, signing, or submission.",
    "",
    "## Safety and scope",
    "",
    `- Contract: ResearchBriefV${brief.contractVersion}`,
    `- Generated at (audit only): ${brief.generatedAt}`,
    `- Content fingerprint: \`${brief.contentFingerprint}\``,
    `- Archive root: \`${brief.scope.archiveRoot}\``,
    `- Included phases: ${brief.scope.includePhases.map((phase) => `\`${phase}\``).join(", ")}`,
    `- Included cohort: ${brief.scope.includeCohorts.map((cohort) => `\`${cohort}\``).join(", ") || "none"}`,
    `- Fixed state: ${brief.safety.mode}, shadow-only=${brief.safety.shadowOnly}, execution-disabled=${brief.safety.executionDisabled}, BUY=${brief.safety.buyScoreThreshold}, WATCH=${brief.safety.watchScoreThreshold}`,
    "",
    "## Evidence inventory",
    "",
    ...brief.inputInventory.map(
      (input) => `- \`${input.path}\` — ${input.reportKind}; SHA-256 \`${input.sha256}\``,
    ),
    "",
    "## Data-quality findings",
    "",
    `- Missing decision-time facts: ${brief.dataQuality.missingDecisionTimeFactCount}`,
    `- Report ambiguity: ${brief.dataQuality.reportAmbiguity ? "present" : "none"}`,
    `- Skipped inputs: ${formatSkippedInputs(brief)}`,
    `- Unsupported reports: ${formatUnsupportedReports(brief)}`,
    ...brief.dataQuality.warnings.map((warning) => `- Warning: ${warning}`),
    "",
    "## Decision-time evidence",
    "",
    "> The following section contains only original decision-time evidence. It contains no later outcome label or return.",
    "",
    ...formatCandidates(brief),
    "",
    "## Outcome analysis (labels only)",
    "",
    "> Later observations; not entry inputs.",
    "",
    `- Exact 3/5/15-minute coverage: ${brief.outcomeAnalysis.exactCoverageCount}`,
    ...Object.entries(brief.outcomeAnalysis.labelCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, count]) => `- ${label}: ${count}`),
    ...brief.outcomeAnalysis.labels.map(
      (entry) =>
        `- \`${entry.candidateId}\`: ${entry.label}; coverage ${entry.exactCoverage.map((value) => `${value.horizonMinutes}m=${value.onTime ? "on-time" : "not-on-time"}`).join(", ")}; source \`${entry.sourceReport}\``,
    ),
    "",
    "## Provider-pressure context",
    "",
    ...formatProviderPressure(brief),
    "",
    "## Concentration and gate ledger",
    "",
    `- Selected-run shares: ${formatShares(brief.concentrationAndGates.selectedRunSharesPct)}`,
    `- Target-run shares: ${formatShares(brief.concentrationAndGates.targetRunSharesPct)}`,
    `- Non-target-run shares: ${formatShares(brief.concentrationAndGates.nonTargetRunSharesPct)}`,
    ...brief.concentrationAndGates.gates.map(
      (gate) => `- ${gate.passed ? "PASS" : "FAIL"} — ${gate.name}: ${gate.detail}`,
    ),
    "",
    "## Recorded conclusion",
    "",
    `- Status: ${brief.recordedConclusion.status}`,
    `- Reason: ${brief.recordedConclusion.reason}`,
    `- Source: ${brief.recordedConclusion.sourceReport ? `\`${brief.recordedConclusion.sourceReport}\`` : "none"}`,
    "",
    "## Review protocol",
    "",
    ...brief.reviewProtocol.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Next permitted action",
    "",
    `Archive review only. ${permittedNextAction(brief.recordedConclusion.status)}`,
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function formatCandidates(brief: ResearchBriefV1): string[] {
  if (brief.candidateEvidence.length === 0) return ["No decision-time candidates are in scope."];
  return brief.candidateEvidence.flatMap((candidate) => [
    `### \`${candidate.id}\``,
    "",
    `- Identity: mint \`${candidate.mintAddress}\`; decision \`${candidate.decisionId}\`; run \`${candidate.runId}\`; cohort \`${candidate.cohortId}\`${candidate.symbol ? `; symbol ${candidate.symbol}` : ""}`,
    `- Original decision: ${candidate.classification} — ${candidate.classificationReason}`,
    `- Decided at: ${candidate.decidedAt}`,
    ...candidate.decisionTimeFacts.map(
      (feature) =>
        `- \`${feature.family}.${feature.key}\`: ${formatFeatureValue(feature.value)}; ${feature.availability}; ${feature.sourceKind}; source \`${feature.sourceReport}\`${feature.sourceTimestampMs === undefined ? "" : `; timestamp ${feature.sourceTimestampMs}`}${feature.unavailableReason ? `; unavailable reason ${feature.unavailableReason}` : ""}`,
    ),
    "",
  ]);
}

function formatProviderPressure(brief: ResearchBriefV1): string[] {
  if (brief.providerPressureContext.length === 0) {
    return ["No Phase 9.28 provider-pressure context is in scope."];
  }
  return brief.providerPressureContext.flatMap((provider) => [
    `### ${provider.provider}`,
    "",
    `- Sources: ${provider.sourceReports.map((source) => `\`${source}\``).join(", ")}`,
    `- Total: ${formatCountContext(provider.total)}; upstream rows: ${formatCountContext(provider.liveUpstreamRows)}; router rows: ${formatCountContext(provider.routerRows)}`,
    `- Upstream rate-limited: ${formatCountContext(provider.upstreamRateLimited)}; upstream errors: ${formatCountContext(provider.upstreamErrors)}; cache hits: ${formatCountContext(provider.cacheHits)}; cooldown skips: ${formatCountContext(provider.cooldownSkips)}; unavailable: ${formatCountContext(provider.unavailable)}`,
    `- Quote-budget deferrals: ${formatCountContext(provider.quoteBudgetDeferrals)}; controller deferrals: ${formatCountContext(provider.controllerDeferrals)}; venue-guard skips: ${formatCountContext(provider.venueGuardSkips)}; venue-guard allows: ${formatCountContext(provider.venueGuardAllows)}`,
    "",
  ]);
}

function formatFeatureValue(value: unknown): string {
  return value === undefined ? "MISSING" : `\`${JSON.stringify(value)}\``;
}

function formatCountContext(value: {
  readonly availability: string;
  readonly value?: number | undefined;
}): string {
  return value.availability === "AVAILABLE" ? String(value.value) : "MISSING";
}

function formatShares(value: Record<string, number>): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0
    ? "MISSING"
    : entries.map(([label, share]) => `${label}=${share.toFixed(2)}%`).join(", ");
}

function formatSkippedInputs(brief: ResearchBriefV1): string {
  return brief.dataQuality.skippedInputs.length === 0
    ? "none"
    : brief.dataQuality.skippedInputs
        .map((entry) => `\`${entry.path}\` (${entry.reason})`)
        .join(", ");
}

function formatUnsupportedReports(brief: ResearchBriefV1): string {
  return brief.dataQuality.unsupportedReports.length === 0
    ? "none"
    : brief.dataQuality.unsupportedReports
        .map((entry) => `\`${entry.path}\` (${entry.reason})`)
        .join(", ");
}

function permittedNextAction(status: ResearchBriefV1["recordedConclusion"]["status"]): string {
  if (status === "NO_DEFENSIBLE_HYPOTHESIS") {
    return "The recorded NO_DEFENSIBLE_HYPOTHESIS conclusion remains in force; no successor study, collection, strategy change, or execution action is authorized.";
  }
  if (status === "DATA_INSUFFICIENT") {
    return "Human review may identify missing archived evidence, but no collection, strategy change, or execution action is authorized.";
  }
  return "Human review of the source inconsistency is required; no collection, strategy change, or execution action is authorized.";
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
