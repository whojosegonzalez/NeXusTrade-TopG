import { evaluateAllGates } from "./FormulationBAnalysisGates.js";
import {
  FORMULATION_B_ANALYSIS_CONTRACT_VERSION,
  FORMULATION_B_PROTOCOL_ID,
  type FormulationBAnalysisReport,
  type FormulationBOutcome,
  type LoadedFormulationBArchive,
} from "./FormulationBAnalysisTypes.js";

export function analyzeFormulationBArchive(
  archive: LoadedFormulationBArchive,
): FormulationBAnalysisReport {
  const gateEval = evaluateAllGates(archive.units);

  const discoveryUnits = archive.units.filter((u) => u.partition === "DISCOVERY");
  const validationUnits = archive.units.filter((u) => u.partition === "VALIDATION");

  // Determine decision outcome
  let decisionOutcome: FormulationBOutcome;

  const qualityFailed = gateEval.qualityGates.some((g) => !g.passed);

  if (qualityFailed) {
    decisionOutcome = "DATA_INSUFFICIENT";
  } else if (!gateEval.discoveryGates.find((g) => g.gateId === "DISC_FEATURE_COVERAGE")?.passed) {
    decisionOutcome = "DATA_INSUFFICIENT";
  } else if (gateEval.discoveryGates.some((g) => !g.passed)) {
    decisionOutcome = "NO_DEFENSIBLE_HYPOTHESIS";
  } else if (gateEval.validationGates.some((g) => !g.passed)) {
    decisionOutcome = "PRE_REGISTRATION_CANDIDATE_REJECTED";
  } else {
    decisionOutcome = "PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL";
  }

  // Momentum availability calculation
  const validMomCount = archive.units.filter(
    (u) =>
      u.decisionTimeEvidence.momentum5mPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentum5mPct) &&
      u.decisionTimeEvidence.momentum15mPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentum15mPct),
  ).length;
  const momentumAvailabilityPct =
    archive.units.length > 0 ? (validMomCount / archive.units.length) * 100 : 0;

  // Usable label count
  const usableLabels = archive.units.filter(
    (u) => u.forwardOutcomeLabels.primaryLabel !== "UNUSABLE_60M",
  ).length;
  const labelCoveragePct =
    archive.units.length > 0 ? (usableLabels / archive.units.length) * 100 : 0;

  // Dates
  const totalDateCounts = new Map<string, number>();
  for (const unit of archive.units) {
    totalDateCounts.set(unit.anchorDate, (totalDateCounts.get(unit.anchorDate) ?? 0) + 1);
  }
  let maxDateCount = 0;
  for (const count of totalDateCounts.values()) {
    if (count > maxDateCount) maxDateCount = count;
  }
  const maxDateSharePct =
    archive.units.length > 0 ? (maxDateCount / archive.units.length) * 100 : 0;

  return {
    contractVersion: FORMULATION_B_ANALYSIS_CONTRACT_VERSION,
    protocolId: FORMULATION_B_PROTOCOL_ID,
    protocolSha256: archive.protocolSha256,
    archiveRoot: archive.archiveRoot,
    archiveOutcome: archive.finalOutcome,
    decisionOutcome,
    candidatePredicateId: "ACCELERATION__HIGH_V1",
    quantileIndex0Based: gateEval.quantileIndex0Based,
    discoveryQ3Threshold: gateEval.discoveryQ3Threshold,
    qualityGates: gateEval.qualityGates,
    discoveryGates: gateEval.discoveryGates,
    validationGates: gateEval.validationGates,
    discoveryEvaluation: gateEval.discoveryEval,
    validationEvaluation: gateEval.validationEval,
    summary: {
      totalUnits: archive.units.length,
      discoveryUnits: discoveryUnits.length,
      validationUnits: validationUnits.length,
      totalUtcDates: totalDateCounts.size,
      maxDateSharePct,
      momentumAvailabilityPct,
      labelCoveragePct,
    },
  };
}
