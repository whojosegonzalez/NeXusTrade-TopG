import type {
  FormulationBGateResult,
  FormulationBGroupStats,
  FormulationBPartition,
  FormulationBPartitionEvaluation,
  FormulationBUnitRecord,
} from "./FormulationBAnalysisTypes.js";
import { deriveThirdQuartile0Based } from "./FormulationBQuantile.js";

export function computeGroupStats(
  units: readonly FormulationBUnitRecord[],
): FormulationBGroupStats {
  const totalUnits = units.length;
  let usableUnits = 0;
  let positiveUnits = 0;
  let nonPositiveUnits = 0;
  let unusableUnits = 0;
  const dateCounts = new Map<string, number>();

  for (const unit of units) {
    const label = unit.forwardOutcomeLabels.primaryLabel;
    if (label === "POSITIVE_60M") {
      usableUnits++;
      positiveUnits++;
      dateCounts.set(unit.anchorDate, (dateCounts.get(unit.anchorDate) ?? 0) + 1);
    } else if (label === "NON_POSITIVE_60M") {
      usableUnits++;
      nonPositiveUnits++;
      dateCounts.set(unit.anchorDate, (dateCounts.get(unit.anchorDate) ?? 0) + 1);
    } else {
      unusableUnits++;
    }
  }

  const positiveRate = usableUnits > 0 ? positiveUnits / usableUnits : null;
  const distinctUtcDates = dateCounts.size;
  let maxDateCount = 0;
  for (const count of dateCounts.values()) {
    if (count > maxDateCount) maxDateCount = count;
  }
  const maxDateSharePct = usableUnits > 0 ? (maxDateCount / usableUnits) * 100 : 0;

  return {
    totalUnits,
    usableUnits,
    positiveUnits,
    nonPositiveUnits,
    unusableUnits,
    positiveRate,
    distinctUtcDates,
    maxDateSharePct,
  };
}

export function evaluatePartition(
  partition: FormulationBPartition,
  units: readonly FormulationBUnitRecord[],
  q3Threshold: number,
): FormulationBPartitionEvaluation {
  const validUnitCount = units.length;
  const accelerationUnits = units.filter(
    (u) =>
      u.decisionTimeEvidence.momentumAccelerationPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentumAccelerationPct),
  );
  const availableAccelerationCount = accelerationUnits.length;
  const accelerationCoveragePct =
    validUnitCount > 0 ? (availableAccelerationCount / validUnitCount) * 100 : 0;

  const dateCounts = new Map<string, number>();
  for (const unit of units) {
    dateCounts.set(unit.anchorDate, (dateCounts.get(unit.anchorDate) ?? 0) + 1);
  }
  const distinctUtcDates = dateCounts.size;
  let maxDateCount = 0;
  for (const count of dateCounts.values()) {
    if (count > maxDateCount) maxDateCount = count;
  }
  const maxDateSharePct = validUnitCount > 0 ? (maxDateCount / validUnitCount) * 100 : 0;

  const ruleUnits = units.filter(
    (u) =>
      u.decisionTimeEvidence.momentumAccelerationPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentumAccelerationPct) &&
      u.decisionTimeEvidence.momentumAccelerationPct >= q3Threshold,
  );
  const compUnits = units.filter(
    (u) =>
      u.decisionTimeEvidence.momentumAccelerationPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentumAccelerationPct) &&
      u.decisionTimeEvidence.momentumAccelerationPct < q3Threshold,
  );

  const ruleStats = computeGroupStats(ruleUnits);
  const compStats = computeGroupStats(compUnits);

  let rateDifference: number | null = null;
  if (ruleStats.positiveRate !== null && compStats.positiveRate !== null) {
    rateDifference = ruleStats.positiveRate - compStats.positiveRate;
  }

  return {
    partition,
    validUnitCount,
    availableAccelerationCount,
    accelerationCoveragePct,
    distinctUtcDates,
    maxDateSharePct,
    ruleStats,
    compStats,
    rateDifference,
  };
}

export interface GateEvaluationResult {
  readonly qualityGates: readonly FormulationBGateResult[];
  readonly discoveryGates: readonly FormulationBGateResult[];
  readonly validationGates: readonly FormulationBGateResult[];
  readonly discoveryQ3Threshold: number | null;
  readonly quantileIndex0Based: number | null;
  readonly discoveryEval: FormulationBPartitionEvaluation;
  readonly validationEval: FormulationBPartitionEvaluation;
}

export function evaluateAllGates(units: readonly FormulationBUnitRecord[]): GateEvaluationResult {
  const discoveryUnits = units.filter((u) => u.partition === "DISCOVERY");
  const validationUnits = units.filter((u) => u.partition === "VALIDATION");

  // Global cohort dates
  const totalDateCounts = new Map<string, number>();
  for (const unit of units) {
    totalDateCounts.set(unit.anchorDate, (totalDateCounts.get(unit.anchorDate) ?? 0) + 1);
  }
  let maxDateCount = 0;
  for (const count of totalDateCounts.values()) {
    if (count > maxDateCount) maxDateCount = count;
  }
  const maxDateSharePct = units.length > 0 ? (maxDateCount / units.length) * 100 : 0;

  // Momentum availability
  const discoveryMomentumAvail = discoveryUnits.filter(
    (u) =>
      u.decisionTimeEvidence.momentum5mPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentum5mPct) &&
      u.decisionTimeEvidence.momentum15mPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentum15mPct),
  ).length;
  const validationMomentumAvail = validationUnits.filter(
    (u) =>
      u.decisionTimeEvidence.momentum5mPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentum5mPct) &&
      u.decisionTimeEvidence.momentum15mPct !== null &&
      Number.isFinite(u.decisionTimeEvidence.momentum15mPct),
  ).length;
  const discMomAvailPct =
    discoveryUnits.length > 0 ? (discoveryMomentumAvail / discoveryUnits.length) * 100 : 0;
  const valMomAvailPct =
    validationUnits.length > 0 ? (validationMomentumAvail / validationUnits.length) * 100 : 0;

  // Label coverage
  const discoveryUsableLabels = discoveryUnits.filter(
    (u) => u.forwardOutcomeLabels.primaryLabel !== "UNUSABLE_60M",
  ).length;
  const validationUsableLabels = validationUnits.filter(
    (u) => u.forwardOutcomeLabels.primaryLabel !== "UNUSABLE_60M",
  ).length;
  const discLabelCoveragePct =
    discoveryUnits.length > 0 ? (discoveryUsableLabels / discoveryUnits.length) * 100 : 0;
  const valLabelCoveragePct =
    validationUnits.length > 0 ? (validationUsableLabels / validationUnits.length) * 100 : 0;

  // Dates per partition
  const discDates = new Set(discoveryUnits.map((u) => u.anchorDate)).size;
  const valDates = new Set(validationUnits.map((u) => u.anchorDate)).size;

  // 1. Data Quality & Sufficiency Gates
  const qualityGates: FormulationBGateResult[] = [
    {
      gateId: "MINIMUM_VALID_UNITS",
      passed: units.length >= 72,
      actualValue: units.length,
      requiredValue: 72,
    },
    {
      gateId: "MINIMUM_PARTITION_UNITS",
      passed: discoveryUnits.length >= 32 && validationUnits.length >= 32,
      actualValue: `Discovery: ${discoveryUnits.length}, Validation: ${validationUnits.length}`,
      requiredValue: ">= 32 per partition",
    },
    {
      gateId: "MINIMUM_TOTAL_DATES",
      passed: totalDateCounts.size >= 8,
      actualValue: totalDateCounts.size,
      requiredValue: 8,
    },
    {
      gateId: "MINIMUM_PARTITION_DATES",
      passed: discDates >= 4 && valDates >= 4,
      actualValue: `Discovery: ${discDates}, Validation: ${valDates}`,
      requiredValue: ">= 4 per partition",
    },
    {
      gateId: "MAXIMUM_DATE_SHARE",
      passed: maxDateSharePct <= 20.0,
      actualValue: `${maxDateSharePct.toFixed(2)}%`,
      requiredValue: "<= 20.00%",
    },
    {
      gateId: "MOMENTUM_AVAILABILITY_FLOOR",
      passed: discMomAvailPct >= 90.0 && valMomAvailPct >= 90.0,
      actualValue: `Discovery: ${discMomAvailPct.toFixed(2)}%, Validation: ${valMomAvailPct.toFixed(2)}%`,
      requiredValue: ">= 90.00% per partition",
    },
    {
      gateId: "LABEL_COVERAGE_FLOOR",
      passed: discLabelCoveragePct >= 90.0 && valLabelCoveragePct >= 90.0,
      actualValue: `Discovery: ${discLabelCoveragePct.toFixed(2)}%, Validation: ${valLabelCoveragePct.toFixed(2)}%`,
      requiredValue: ">= 90.00% per partition",
    },
  ];

  // Derive Discovery Q3
  const discAccelerationValues = discoveryUnits
    .map((u) => u.decisionTimeEvidence.momentumAccelerationPct)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  let discoveryQ3Threshold: number | null = null;
  let quantileIndex0Based: number | null = null;

  if (discAccelerationValues.length >= 8) {
    const qResult = deriveThirdQuartile0Based(discAccelerationValues);
    discoveryQ3Threshold = qResult.q3;
    quantileIndex0Based = qResult.index0Based;
  }

  const effectiveThreshold = discoveryQ3Threshold ?? Number.POSITIVE_INFINITY;
  const discoveryEval = evaluatePartition("DISCOVERY", discoveryUnits, effectiveThreshold);
  const validationEval = evaluatePartition("VALIDATION", validationUnits, effectiveThreshold);

  // 2. Discovery Selection Gates
  const discoveryGates: FormulationBGateResult[] = [
    {
      gateId: "DISC_FEATURE_COVERAGE",
      passed: discoveryEval.accelerationCoveragePct >= 90.0,
      actualValue: `${discoveryEval.accelerationCoveragePct.toFixed(2)}%`,
      requiredValue: ">= 90.00%",
    },
    {
      gateId: "DISC_RULE_SUPPORT",
      passed: discoveryEval.ruleStats.usableUnits >= 8,
      actualValue: discoveryEval.ruleStats.usableUnits,
      requiredValue: 8,
    },
    {
      gateId: "DISC_COMP_SUPPORT",
      passed: discoveryEval.compStats.usableUnits >= 24,
      actualValue: discoveryEval.compStats.usableUnits,
      requiredValue: 24,
    },
    {
      gateId: "DISC_DATE_DIVERSITY",
      passed: discoveryEval.ruleStats.distinctUtcDates >= 4,
      actualValue: discoveryEval.ruleStats.distinctUtcDates,
      requiredValue: 4,
    },
    {
      gateId: "DISC_DATE_CONCENTRATION",
      passed: discoveryEval.ruleStats.maxDateSharePct <= 35.0,
      actualValue: `${discoveryEval.ruleStats.maxDateSharePct.toFixed(2)}%`,
      requiredValue: "<= 35.00%",
    },
    {
      gateId: "DISC_EFFECT_GATE",
      passed: discoveryEval.rateDifference !== null && discoveryEval.rateDifference >= 0.2,
      actualValue:
        discoveryEval.rateDifference !== null
          ? `${(discoveryEval.rateDifference * 100).toFixed(2)}%`
          : "NULL",
      requiredValue: ">= +20.00%",
    },
  ];

  // 3. Validation Replication Gates
  const validationGates: FormulationBGateResult[] = [
    {
      gateId: "VAL_RULE_SUPPORT",
      passed: validationEval.ruleStats.usableUnits >= 8,
      actualValue: validationEval.ruleStats.usableUnits,
      requiredValue: 8,
    },
    {
      gateId: "VAL_DATE_DIVERSITY",
      passed: validationEval.ruleStats.distinctUtcDates >= 4,
      actualValue: validationEval.ruleStats.distinctUtcDates,
      requiredValue: 4,
    },
    {
      gateId: "VAL_DATE_CONCENTRATION",
      passed: validationEval.ruleStats.maxDateSharePct <= 35.0,
      actualValue: `${validationEval.ruleStats.maxDateSharePct.toFixed(2)}%`,
      requiredValue: "<= 35.00%",
    },
    {
      gateId: "VAL_REPLICATION_GATE",
      passed: validationEval.rateDifference !== null && validationEval.rateDifference > 0.0,
      actualValue:
        validationEval.rateDifference !== null
          ? `${(validationEval.rateDifference * 100).toFixed(2)}%`
          : "NULL",
      requiredValue: "> +0.00%",
    },
  ];

  return {
    qualityGates,
    discoveryGates,
    validationGates,
    discoveryQ3Threshold,
    quantileIndex0Based,
    discoveryEval,
    validationEval,
  };
}
