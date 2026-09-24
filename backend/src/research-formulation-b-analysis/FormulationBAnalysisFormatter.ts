import type {
  FormulationBAnalysisFormat,
  FormulationBAnalysisReport,
} from "./FormulationBAnalysisTypes.js";

export function formatFormulationBAnalysisReport(
  report: FormulationBAnalysisReport,
  format: FormulationBAnalysisFormat = "markdown",
): string {
  if (format === "json") {
    return JSON.stringify(report, null, 2);
  }

  const lines: string[] = [];
  lines.push("# Formulation B: Liquidity-Independent Momentum Acceleration Analysis Report");
  lines.push("");
  lines.push(`**Final Decision Outcome**: \`${report.decisionOutcome}\``);
  lines.push(`**Archive Outcome**: \`${report.archiveOutcome}\``);
  lines.push(`**Protocol**: \`${report.protocolId}\` (\`${report.protocolSha256}\`)`);
  lines.push(`**Archive Root**: \`${report.archiveRoot}\``);
  lines.push("");
  lines.push("## 1. Executive Summary");
  lines.push("");
  lines.push(
    `- **Total Valid Units**: ${report.summary.totalUnits} (${report.summary.discoveryUnits} Discovery, ${report.summary.validationUnits} Validation)`,
  );
  lines.push(
    `- **Total UTC Dates**: ${report.summary.totalUtcDates} (Max date share: ${report.summary.maxDateSharePct.toFixed(2)}%)`,
  );
  lines.push(
    `- **Momentum Availability**: ${report.summary.momentumAvailabilityPct.toFixed(2)}% (Floor: 90.00%)`,
  );
  lines.push(
    `- **Primary Label Coverage**: ${report.summary.labelCoveragePct.toFixed(2)}% (Floor: 90.00%)`,
  );
  lines.push(
    `- **Discovery Q3 Threshold**: ${report.discoveryQ3Threshold !== null ? report.discoveryQ3Threshold.toFixed(4) + "%" : "N/A"} (0-based index: ${report.quantileIndex0Based ?? "N/A"})`,
  );
  lines.push("");
  lines.push("## 2. Pre-Registered Quality & Sufficiency Gates");
  lines.push("");
  lines.push("| Gate ID | Requirement | Actual Value | Status |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (const gate of report.qualityGates) {
    lines.push(
      `| \`${gate.gateId}\` | ${gate.requiredValue} | ${gate.actualValue} | ${gate.passed ? "PASSED" : "FAILED"} |`,
    );
  }
  lines.push("");
  lines.push("## 3. Discovery Selection Evaluation (`ACCELERATION__HIGH_V1`)");
  lines.push("");
  lines.push(
    `- **Rule Support**: ${report.discoveryEvaluation.ruleStats.usableUnits} usable units across ${report.discoveryEvaluation.ruleStats.distinctUtcDates} dates`,
  );
  lines.push(
    `- **Comparison Support**: ${report.discoveryEvaluation.compStats.usableUnits} usable units across ${report.discoveryEvaluation.compStats.distinctUtcDates} dates`,
  );
  lines.push(
    `- **Rule Positive Rate**: ${report.discoveryEvaluation.ruleStats.positiveRate !== null ? (report.discoveryEvaluation.ruleStats.positiveRate * 100).toFixed(2) + "%" : "N/A"}`,
  );
  lines.push(
    `- **Comparison Positive Rate**: ${report.discoveryEvaluation.compStats.positiveRate !== null ? (report.discoveryEvaluation.compStats.positiveRate * 100).toFixed(2) + "%" : "N/A"}`,
  );
  lines.push(
    `- **Discovery Rate Difference (\\Delta)**: ${report.discoveryEvaluation.rateDifference !== null ? (report.discoveryEvaluation.rateDifference * 100).toFixed(2) + "%" : "N/A"} (Required: >= +20.00%)`,
  );
  lines.push("");
  lines.push("| Discovery Gate | Requirement | Actual Value | Status |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (const gate of report.discoveryGates) {
    lines.push(
      `| \`${gate.gateId}\` | ${gate.requiredValue} | ${gate.actualValue} | ${gate.passed ? "PASSED" : "FAILED"} |`,
    );
  }
  lines.push("");
  lines.push("## 4. Validation Replication Evaluation (`ACCELERATION__HIGH_V1`)");
  lines.push("");
  lines.push(
    `- **Rule Support**: ${report.validationEvaluation.ruleStats.usableUnits} usable units across ${report.validationEvaluation.ruleStats.distinctUtcDates} dates`,
  );
  lines.push(
    `- **Comparison Support**: ${report.validationEvaluation.compStats.usableUnits} usable units across ${report.validationEvaluation.compStats.distinctUtcDates} dates`,
  );
  lines.push(
    `- **Rule Positive Rate**: ${report.validationEvaluation.ruleStats.positiveRate !== null ? (report.validationEvaluation.ruleStats.positiveRate * 100).toFixed(2) + "%" : "N/A"}`,
  );
  lines.push(
    `- **Comparison Positive Rate**: ${report.validationEvaluation.compStats.positiveRate !== null ? (report.validationEvaluation.compStats.positiveRate * 100).toFixed(2) + "%" : "N/A"}`,
  );
  lines.push(
    `- **Validation Rate Difference (\\Delta)**: ${report.validationEvaluation.rateDifference !== null ? (report.validationEvaluation.rateDifference * 100).toFixed(2) + "%" : "N/A"} (Required: > +0.00%)`,
  );
  lines.push("");
  lines.push("| Validation Gate | Requirement | Actual Value | Status |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (const gate of report.validationGates) {
    lines.push(
      `| \`${gate.gateId}\` | ${gate.requiredValue} | ${gate.actualValue} | ${gate.passed ? "PASSED" : "FAILED"} |`,
    );
  }
  lines.push("");
  lines.push("## 5. Governance Decision Mapping");
  lines.push("");
  lines.push(`The analysis returned **\`${report.decisionOutcome}\`**.`);
  if (report.decisionOutcome === "PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL") {
    lines.push(
      "The candidate predicate demonstrated replicated positive price continuation in held Validation, clearing all pre-registered gates.",
    );
    lines.push(
      "Permitted next step: drafting a formal Phase 10.6C Shadow Study Pre-Registration for separate human approval.",
    );
  } else if (report.decisionOutcome === "PRE_REGISTRATION_CANDIDATE_REJECTED") {
    lines.push(
      "The candidate predicate passed Discovery selection but failed to replicate a positive return effect in held Validation.",
    );
  } else if (report.decisionOutcome === "NO_DEFENSIBLE_HYPOTHESIS") {
    lines.push(
      "The candidate predicate failed to achieve the pre-registered effect threshold (>= +20.00%) or date/support gates in Discovery.",
    );
  } else {
    lines.push(
      "The exploratory cohort failed data quality, momentum availability (>= 90.00%), or cohort sufficiency gates.",
    );
  }
  lines.push("");
  return lines.join("\n");
}
