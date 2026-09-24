import type { ResearchProtocolValidationV1 } from "./ResearchProtocolTypes.js";

export function formatResearchProtocolValidationJson(
  validation: ResearchProtocolValidationV1,
): string {
  return `${JSON.stringify(sortValue(validation), null, 2)}\n`;
}

export function formatResearchProtocolValidationMarkdown(
  validation: ResearchProtocolValidationV1,
): string {
  const lines = [
    "# NeXusTrade Exploratory Cohort Protocol Validation",
    "",
    "> Local, read-only validation only. This command made zero provider/RPC/HTTP calls, database reads or writes, filesystem writes, runtime actions, sessions, orders, fills, positions, wallet actions, signing, or submission.",
    "",
    "## Protocol identity",
    "",
    `- Contract: ResearchProtocolValidationV${validation.contractVersion}`,
    `- Generated at (audit only): ${validation.generatedAt}`,
    `- Content fingerprint: \`${validation.contentFingerprint}\``,
    `- Protocol: \`${validation.protocol.path}\``,
    `- Protocol SHA-256: \`${validation.protocol.sha256}\``,
    `- Authority state: ${validation.protocol.authorityStatus}`,
    "",
    "## Fixed evidence identity",
    "",
    `- Research Brief: \`${validation.sourceEvidence.researchBrief.fingerprint}\`; \`${validation.sourceEvidence.researchBrief.citation}\``,
    `- Research Review Gate: \`${validation.sourceEvidence.researchReviewGate.fingerprint}\`; \`${validation.sourceEvidence.researchReviewGate.citation}\``,
    `- Phase 9.29 conclusion: ${validation.sourceEvidence.phase929Conclusion.status}; \`${validation.sourceEvidence.phase929Conclusion.citation}\``,
    "",
    "## Safety",
    "",
    "- Provider/RPC/HTTP calls: 0",
    "- Database reads/writes: 0 / 0",
    "- Filesystem writes and runtime commands: 0 / 0",
    "- Orders/fills/positions/wallet/signing/submission: 0 / 0 / 0 / false / false / false",
    "",
    "## Outcome",
    "",
    `- Status: ${validation.outcome.status}`,
    `- Authority: ${validation.outcome.authority}`,
    "- This status permits neither collection nor Phase 10.6B, Phase 10.6C, strategy changes, PAPER execution, or promotion.",
    "",
    "## Next permitted action",
    "",
    validation.nextPermittedAction,
    "",
    "## Warnings",
    "",
    ...validation.warnings.map((warning) => `- ${warning}`),
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
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
