import type { MeasurementProtocolValidationV1 } from "./MeasurementProtocolTypes.js";

export function formatMeasurementProtocolValidationJson(
  validation: MeasurementProtocolValidationV1,
): string {
  return `${JSON.stringify(sortValue(validation), null, 2)}\n`;
}

export function formatMeasurementProtocolValidationMarkdown(
  validation: MeasurementProtocolValidationV1,
): string {
  const lines = [
    "# NeXusTrade Measurement-Only Protocol Static Validation",
    "",
    "> Local, read-only source validation only. This command made zero provider/RPC/HTTP calls, archive reads or writes, database reads or writes, filesystem writes, runtime actions, scheduler changes, sessions, orders, fills, positions, wallet actions, signing, or submission.",
    "",
    "## Protocol identity",
    "",
    `- Contract: MeasurementProtocolValidationV${validation.contractVersion}`,
    `- Generated at (audit only): ${validation.generatedAt}`,
    `- Content fingerprint: \`${validation.contentFingerprint}\``,
    `- Protocol: \`${validation.protocol.path}\``,
    `- Protocol SHA-256: \`${validation.protocol.sha256}\``,
    `- Authority state: ${validation.protocol.authorityStatus}`,
    "",
    "## Fixed evidence identity",
    "",
    `- Measurement audit fingerprint: \`${validation.sourceEvidence.measurementAuditFingerprint}\``,
    `- Superseded V2 protocol SHA-256: \`${validation.sourceEvidence.v2ProtocolSha256}\``,
    `- Measurement objectives: ${validation.sourceEvidence.objectiveFields.join(", ")}`,
    "",
    "## Safety",
    "",
    "- Provider/RPC/HTTP calls: 0",
    "- Archive reads/writes: 0 / 0",
    "- Database reads/writes: 0 / 0",
    "- Filesystem writes, runtime commands, and scheduler changes: 0 / 0 / 0",
    "- Orders/fills/positions/wallet/signing/submission: 0 / 0 / 0 / false / false / false",
    "",
    "## Outcome",
    "",
    `- Status: ${validation.outcome.status}`,
    `- Authority: ${validation.outcome.authority}`,
    "- This status permits neither collection, a collector, a scheduler, Phase 10.6C, strategy changes, PAPER execution, nor promotion.",
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
