import type { ResearchReviewGateV1 } from "./ResearchReviewGateTypes.js";

export function formatResearchReviewGateJson(gate: ResearchReviewGateV1): string {
  return `${JSON.stringify(sortValue(gate), null, 2)}\n`;
}

export function formatResearchReviewGateMarkdown(gate: ResearchReviewGateV1): string {
  const lines = [
    "# NeXusTrade Research Review Gate",
    "",
    "> Archive-only and read-only. This command made zero provider/RPC/HTTP calls, database reads or writes, filesystem writes, runtime actions, sessions, orders, fills, positions, wallet actions, signing, or submission.",
    "",
    "## Safety and scope",
    "",
    `- Contract: ResearchReviewGateV${gate.contractVersion}`,
    `- Generated at (audit only): ${gate.generatedAt}`,
    `- Content fingerprint: \`${gate.contentFingerprint}\``,
    `- Research brief fingerprint: \`${gate.briefFingerprint}\``,
    `- Archive root: \`${gate.scope.archiveRoot}\``,
    `- Included phases: ${gate.scope.includePhases.map((phase) => `\`${phase}\``).join(", ")}`,
    `- Included cohort: ${gate.scope.includeCohorts.map((cohort) => `\`${cohort}\``).join(", ")}`,
    `- Fixed state: ${gate.safety.mode}, shadow-only=${gate.safety.shadowOnly}, execution-disabled=${gate.safety.executionDisabled}, BUY=${gate.safety.buyScoreThreshold}, WATCH=${gate.safety.watchScoreThreshold}`,
    "",
    "## Evidence identity",
    "",
    ...gate.inputInventory.map(
      (source) => `- \`${source.path}\` — ${source.sourceType}; SHA-256 \`${source.sha256}\``,
    ),
    "",
    "## Data-quality and gate ledger",
    "",
    `- Sources: ${gate.evidenceSummary.sourceCount} (${gate.evidenceSummary.runnerSummaryCount} runner summaries, ${gate.evidenceSummary.attributionReportCount} attribution report)`,
    `- Candidates with exact 3/5/15-minute coverage: ${gate.evidenceSummary.exactCoverageCount}`,
    `- Later-label counts: TARGET_FIRST=${gate.evidenceSummary.labelCounts.TARGET_FIRST}, STOP_FIRST=${gate.evidenceSummary.labelCounts.STOP_FIRST}, MAX_HOLD=${gate.evidenceSummary.labelCounts.MAX_HOLD}`,
    `- Selected-run shares: ${formatShares(gate.evidenceSummary.selectedRunSharesPct)}`,
    `- Non-target-run shares: ${formatShares(gate.evidenceSummary.nonTargetRunSharesPct)}`,
    ...gate.evidenceSummary.gates.map(
      (gateResult) =>
        `- ${gateResult.passed ? "PASS" : "FAIL"} — ${gateResult.name}: ${gateResult.detail}`,
    ),
    "",
    "## Decision-time evidence boundary",
    "",
    "> Decision-time facts were reviewed separately from later 3/5/15-minute labels. Later labels were not used as study-selection inputs.",
    "",
    "## Human review assertions",
    "",
    ...gate.reviewAssertions.map(
      (assertion) =>
        `- ${assertion.factKey} — ${assertion.assertionCode}${assertion.note ? `; ${assertion.note}` : ""}; source \`${assertion.sourceReport}\``,
    ),
    "",
    "## Outcome",
    "",
    `- Status: ${gate.outcome.status}`,
    `- Blocking gates: ${gate.outcome.blockingReasons.join(", ")}`,
    `- Recorded conclusion: ${gate.evidenceSummary.recordedConclusion.status}`,
    `- Recorded conclusion source: \`${gate.evidenceSummary.recordedConclusion.sourceReport}\``,
    "",
    "## Candidate pre-registration",
    "",
    "ABSENT. Generic candidate validation is deferred and no study is authorized.",
    "",
    "## Next permitted action",
    "",
    gate.nextPermittedAction,
    "",
    "## Warnings",
    "",
    ...gate.warnings.map((warning) => `- ${warning}`),
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function formatShares(value: Record<string, number>): string {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, share]) => `${label}=${share.toFixed(2)}%`)
    .join(", ");
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
