import { createHash } from "node:crypto";

import {
  type AnalysisUnit,
  ExploratoryCohortArchiveLoader,
  type LoadedExploratoryCohortArchive,
} from "./ExploratoryCohortArchiveLoader.js";
import {
  catalogFields,
  catalogRuleId,
  EMPTY_ANALYSIS_SAFETY,
  EXPLORATORY_COHORT_ANALYSIS_CONTRACT_VERSION,
  exploratoryCohortAnalysisSchema,
  type CatalogDirection,
  type CatalogFieldId,
  type CatalogRuleId,
  type ExploratoryCohortAnalysisV1,
} from "./ExploratoryCohortAnalysisTypes.js";

type Partition = "DISCOVERY" | "VALIDATION";
type PrimaryLabel = "POSITIVE_60M" | "NON_POSITIVE_60M" | "UNUSABLE_60M";

interface RuleAssessment {
  readonly catalogRuleId: CatalogRuleId;
  readonly field: CatalogFieldId;
  readonly path: string;
  readonly direction: CatalogDirection;
  readonly threshold: number | null;
  readonly unitIds: readonly string[];
  readonly comparisonUnitIds: readonly string[];
  readonly evidence: {
    readonly eligible: boolean;
    readonly support: number;
    readonly comparisonSupport: number;
    readonly utcDateCount: number;
    readonly maximumUtcDateSharePct: number;
    readonly positiveRate: number | null;
    readonly comparisonPositiveRate: number | null;
    readonly positiveRateDifference: number | null;
    readonly failureCodes: readonly (
      | "FIELD_COVERAGE"
      | "RULE_SUPPORT"
      | "COMPARISON_SUPPORT"
      | "DATE_SUPPORT"
      | "DATE_CONCENTRATION"
      | "EFFECT_SIZE"
      | "NOT_EVALUATED_QUALITY"
    )[];
  };
}

export class ExploratoryCohortAnalysisService {
  constructor(
    private readonly options: {
      readonly loader?: ExploratoryCohortArchiveLoader;
      readonly now?: () => Date;
    } = {},
  ) {}

  build(archiveRoot: string, repoRoot: string): ExploratoryCohortAnalysisV1 {
    const archive = (this.options.loader ?? new ExploratoryCohortArchiveLoader()).load(
      archiveRoot,
      repoRoot,
    );
    return this.buildFromLoadedArchive(archive);
  }

  buildFromLoadedArchive(archive: LoadedExploratoryCohortArchive): ExploratoryCohortAnalysisV1 {
    const quality = buildQuality(archive);
    const coverage = buildCoverage(archive.units);
    const secondary = buildSecondaryLabelDescription(archive.units);
    const primary = buildPrimaryLabelAnalysis(archive.units);
    const qualityPasses = quality.gates.every((gate) => gate.passed);
    const archiveComplete = archive.manifest.outcome === "COHORT_COMPLETE";
    const catalog =
      qualityPasses && archiveComplete
        ? buildCatalog(archive.units, coverage)
        : buildUnevaluatedCatalog(coverage);
    const selected = qualityPasses && archiveComplete ? selectDiscoveryRule(catalog) : undefined;
    const validation = selected ? validateRule(archive.units, selected, coverage) : undefined;
    const decision = determineOutcome({ archiveComplete, qualityPasses, selected, validation });
    const draft = {
      contractVersion: EXPLORATORY_COHORT_ANALYSIS_CONTRACT_VERSION,
      generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      contentFingerprint: "",
      archiveIdentity: {
        status: "MATCHED",
        archiveRoot: archive.manifest.archiveRoot,
        protocolSha256: archive.manifest.launch.protocolSha256,
        manifestSha256: archive.manifestSha256,
        launchIdentityHash: archive.launchIdentityHash,
      },
      inputInventory: [
        { path: "cohort-manifest.v1.json", sha256: archive.inventory["cohort-manifest.v1.json"] },
        { path: "units.v1.ndjson", sha256: archive.inventory["units.v1.ndjson"] },
        { path: "source-inventory.v1.json", sha256: archive.inventory["source-inventory.v1.json"] },
        {
          path: "collection-summary.v1.json",
          sha256: archive.inventory["collection-summary.v1.json"],
        },
      ],
      safety: EMPTY_ANALYSIS_SAFETY,
      archiveIntegrity: {
        finalOutcome: archive.manifest.outcome,
        finalFileHashesValid: true,
        sourceInventoryValid: true,
        summaryConsistent: true,
        protocolValid: true,
      },
      cohortQuality: quality,
      decisionTimeCoverage: coverage.map((entry) => ({
        field: entry.field,
        discoveryAvailable: entry.discoveryAvailable,
        discoveryTotal: entry.discoveryTotal,
        validationAvailable: entry.validationAvailable,
        validationTotal: entry.validationTotal,
        eligibleForCatalog: entry.eligible,
      })),
      secondaryLabelDescription: secondary,
      primaryLabelAnalysis: primary,
      catalogLedger: catalog.map((entry) => ({
        catalogRuleId: entry.catalogRuleId,
        decisionTimeField: entry.path,
        comparator: entry.direction === "LOW_V1" ? "LTE" : "GTE",
        fieldAvailable: entry.evidence.failureCodes.includes("FIELD_COVERAGE") === false,
        discoveryThreshold: entry.threshold,
        discoveryEvidence: entry.evidence,
      })),
      selectedDiscoveryRule: selected?.catalogRuleId ?? null,
      validationLedger: validation
        ? {
            catalogRuleId: validation.catalogRuleId,
            support: validation.support,
            comparisonSupport: validation.comparisonSupport,
            utcDateCount: validation.utcDateCount,
            maximumUtcDateSharePct: validation.maximumUtcDateSharePct,
            positiveRate: validation.positiveRate,
            comparisonPositiveRate: validation.comparisonPositiveRate,
            positiveRateDifference: validation.positiveRateDifference,
            fisherGreaterPValue: validation.fisherGreaterPValue,
            leaveOneDateOutStable: validation.leaveOneDateOutStable,
            passed: validation.passed,
            failureCodes: validation.failureCodes,
          }
        : null,
      outcome: decision.outcome,
      candidateDescriptor:
        decision.ready && selected && validation
          ? {
              catalogRuleId: selected.catalogRuleId,
              decisionTimeField: selected.path,
              comparator: selected.direction === "LOW_V1" ? "LTE" : "GTE",
              discoveryThreshold: selected.threshold,
              discoveryEvidence: nonNullEvidence(selected.evidence),
              validationEvidence: nonNullValidationEvidence(validation),
              archiveCitations: {
                files: ["cohort-manifest.v1.json", "units.v1.ndjson"],
                unitIds: [...selected.unitIds, ...validation.unitIds].sort(),
                fieldPath: selected.path,
              },
              materialDifference: "ONE_DECISION_TIME_FEATURE_NOT_F65E_V1",
              requiredNextRecord: "ShadowStudyPreRegistrationV1",
              nextPermittedAction: "SEPARATE_HUMAN_APPROVAL_ONLY",
            }
          : null,
      nextPermittedAction: decision.nextPermittedAction,
      warnings: [
        "Later observations are labels only and are not predicate inputs.",
        "This archive-only result does not authorize a strategy change, collection, Phase 10.6C validation, PAPER execution, promotion, order, fill, position, wallet action, signing, or submission.",
      ],
    } as const;
    return exploratoryCohortAnalysisSchema.parse({
      ...draft,
      contentFingerprint: fingerprint(draft),
    });
  }
}

function buildQuality(archive: LoadedExploratoryCohortArchive) {
  const units = archive.units;
  const partitions = partitionUnits(units);
  const dateCounts = countDates(units);
  const completionPassed =
    archive.manifest.outcome === "COHORT_COMPLETE" &&
    units.length === 96 &&
    new Set(units.map((unit) => unit.canonicalMint)).size === units.length &&
    Object.keys(dateCounts).length >= 8 &&
    maxSharePct(dateCounts, units.length) <= 20 &&
    partitions.DISCOVERY.length >= 32 &&
    partitions.VALIDATION.length >= 32 &&
    Object.keys(countDates(partitions.DISCOVERY)).length >= 4 &&
    Object.keys(countDates(partitions.VALIDATION)).length >= 4;
  const splitPassed = units.every(
    (unit) => partitionFor(unit.canonicalMint, unit.slotId) === unit.partition,
  );
  const primary = buildPrimaryLabelAnalysis(units);
  const coveragePassed = (["DISCOVERY", "VALIDATION"] as const).every(
    (partition) =>
      primary[partition].usable60mCount >= Math.ceil(0.9 * primary[partition].validUnitCount),
  );
  const supportPassed = (["DISCOVERY", "VALIDATION"] as const).every(
    (partition) =>
      primary[partition].positive60mCount >= 8 && primary[partition].nonPositive60mCount >= 8,
  );
  const concentrationPassed = (["DISCOVERY", "VALIDATION"] as const).every(
    (partition) => primary[partition].maximumUtcDateSharePct <= 35,
  );
  return {
    validUnitCount: units.length,
    partitionCounts: {
      DISCOVERY: partitions.DISCOVERY.length,
      VALIDATION: partitions.VALIDATION.length,
    },
    utcDateCounts: dateCounts,
    gates: [
      {
        id: "COHORT_COMPLETION" as const,
        passed: completionPassed,
        numerator: units.length,
        denominator: 96,
      },
      {
        id: "SPLIT_RECONSTRUCTION" as const,
        passed: splitPassed,
        numerator: units.filter(
          (unit) => partitionFor(unit.canonicalMint, unit.slotId) === unit.partition,
        ).length,
        denominator: units.length || 1,
      },
      {
        id: "PRIMARY_LABEL_COVERAGE" as const,
        passed: coveragePassed,
        numerator: primary.DISCOVERY.usable60mCount + primary.VALIDATION.usable60mCount,
        denominator: units.length || 1,
      },
      {
        id: "PRIMARY_LABEL_SUPPORT" as const,
        passed: supportPassed,
        numerator: Math.min(
          primary.DISCOVERY.positive60mCount,
          primary.DISCOVERY.nonPositive60mCount,
          primary.VALIDATION.positive60mCount,
          primary.VALIDATION.nonPositive60mCount,
        ),
        denominator: 8,
      },
      {
        id: "LABEL_DATE_CONCENTRATION" as const,
        passed: concentrationPassed,
        numerator: Math.max(
          primary.DISCOVERY.maximumUtcDateSharePct,
          primary.VALIDATION.maximumUtcDateSharePct,
        ),
        denominator: 35,
      },
    ],
  };
}

function buildCoverage(units: readonly AnalysisUnit[]) {
  const partitions = partitionUnits(units);
  return catalogFields.map((field) => {
    const discoveryAvailable = partitions.DISCOVERY.filter(
      (unit) => finiteFieldValue(unit, field.id) !== undefined,
    ).length;
    const validationAvailable = partitions.VALIDATION.filter(
      (unit) => finiteFieldValue(unit, field.id) !== undefined,
    ).length;
    return {
      field: field.id,
      path: field.path,
      discoveryAvailable,
      discoveryTotal: partitions.DISCOVERY.length,
      validationAvailable,
      validationTotal: partitions.VALIDATION.length,
      eligible:
        discoveryAvailable >= Math.ceil(0.9 * partitions.DISCOVERY.length) &&
        validationAvailable >= Math.ceil(0.9 * partitions.VALIDATION.length),
    };
  });
}

function buildSecondaryLabelDescription(units: readonly AnalysisUnit[]) {
  return ([3, 5, 15] as const).map((minutesAfterAnchor) => {
    const observations = units.flatMap((unit) =>
      unit.laterObservations.filter(
        (observation) => observation.minutesAfterAnchor === minutesAfterAnchor,
      ),
    );
    return {
      minutesAfterAnchor,
      observedOnTimeCount: observations.filter(
        (observation) => observation.availability === "OBSERVED_ON_TIME",
      ).length,
      otherAvailabilityCount: observations.filter(
        (observation) => observation.availability !== "OBSERVED_ON_TIME",
      ).length,
    };
  });
}

function buildPrimaryLabelAnalysis(units: readonly AnalysisUnit[]) {
  const partitions = partitionUnits(units);
  return {
    DISCOVERY: primaryLabelCounts(partitions.DISCOVERY),
    VALIDATION: primaryLabelCounts(partitions.VALIDATION),
  };
}

function primaryLabelCounts(units: readonly AnalysisUnit[]) {
  const labels = units.map(primaryLabel);
  const dates = countDates(units.filter((_, index) => labels[index] !== "UNUSABLE_60M"));
  return {
    validUnitCount: units.length,
    usable60mCount: labels.filter((label) => label !== "UNUSABLE_60M").length,
    positive60mCount: labels.filter((label) => label === "POSITIVE_60M").length,
    nonPositive60mCount: labels.filter((label) => label === "NON_POSITIVE_60M").length,
    unusable60mCount: labels.filter((label) => label === "UNUSABLE_60M").length,
    utcDateCount: Object.keys(dates).length,
    maximumUtcDateSharePct: maxSharePct(
      dates,
      labels.filter((label) => label !== "UNUSABLE_60M").length,
    ),
  };
}

function buildCatalog(
  units: readonly AnalysisUnit[],
  coverage: ReturnType<typeof buildCoverage>,
): RuleAssessment[] {
  const discovery = partitionUnits(units).DISCOVERY;
  return catalogFields.flatMap((field) => {
    const coverageEntry = coverage.find((entry) => entry.field === field.id);
    if (!coverageEntry?.eligible) return unavailableRules(field.id, field.path, "FIELD_COVERAGE");
    const values = discovery
      .map((unit) => finiteFieldValue(unit, field.id))
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right);
    const lower = values[Math.floor(0.25 * (values.length - 1))];
    const upper = values[Math.ceil(0.75 * (values.length - 1))];
    if (lower === undefined || upper === undefined)
      return unavailableRules(field.id, field.path, "FIELD_COVERAGE");
    return [
      assessRule(discovery, field.id, field.path, "LOW_V1", lower),
      assessRule(discovery, field.id, field.path, "HIGH_V1", upper),
    ];
  });
}

function buildUnevaluatedCatalog(coverage: ReturnType<typeof buildCoverage>): RuleAssessment[] {
  return catalogFields.flatMap((field) => {
    const coverageEntry = coverage.find((entry) => entry.field === field.id);
    return unavailableRules(
      field.id,
      field.path,
      coverageEntry?.eligible ? "NOT_EVALUATED_QUALITY" : "FIELD_COVERAGE",
    );
  });
}

function unavailableRules(
  field: CatalogFieldId,
  path: string,
  failure: "FIELD_COVERAGE" | "NOT_EVALUATED_QUALITY",
): RuleAssessment[] {
  return (["LOW_V1", "HIGH_V1"] as const).map((direction) => ({
    catalogRuleId: catalogRuleId(field, direction),
    field,
    path,
    direction,
    threshold: null,
    unitIds: [],
    comparisonUnitIds: [],
    evidence: {
      eligible: false,
      support: 0,
      comparisonSupport: 0,
      utcDateCount: 0,
      maximumUtcDateSharePct: 0,
      positiveRate: null,
      comparisonPositiveRate: null,
      positiveRateDifference: null,
      failureCodes: [failure],
    },
  }));
}

function assessRule(
  units: readonly AnalysisUnit[],
  field: CatalogFieldId,
  path: string,
  direction: CatalogDirection,
  threshold: number,
): RuleAssessment {
  const labelled = units.filter(
    (unit) => finiteFieldValue(unit, field) !== undefined && primaryLabel(unit) !== "UNUSABLE_60M",
  );
  const matching = labelled.filter((unit) => matchesRule(unit, field, direction, threshold));
  const comparison = labelled.filter((unit) => !matchesRule(unit, field, direction, threshold));
  const support = matching.length;
  const comparisonSupport = comparison.length;
  const dates = countDates(matching);
  const positiveRate = rate(matching);
  const comparisonPositiveRate = rate(comparison);
  const difference =
    positiveRate === null || comparisonPositiveRate === null
      ? null
      : positiveRate - comparisonPositiveRate;
  const failureCodes: RuleAssessment["evidence"]["failureCodes"][number][] = [];
  if (support < 8) failureCodes.push("RULE_SUPPORT");
  if (comparisonSupport < 24) failureCodes.push("COMPARISON_SUPPORT");
  if (Object.keys(dates).length < 4) failureCodes.push("DATE_SUPPORT");
  if (maxSharePct(dates, support) > 35) failureCodes.push("DATE_CONCENTRATION");
  if (difference === null || difference < 0.2) failureCodes.push("EFFECT_SIZE");
  return {
    catalogRuleId: catalogRuleId(field, direction),
    field,
    path,
    direction,
    threshold,
    unitIds: matching.map((unit) => unit.unitId).sort(),
    comparisonUnitIds: comparison.map((unit) => unit.unitId).sort(),
    evidence: {
      eligible: failureCodes.length === 0,
      support,
      comparisonSupport,
      utcDateCount: Object.keys(dates).length,
      maximumUtcDateSharePct: maxSharePct(dates, support),
      positiveRate,
      comparisonPositiveRate,
      positiveRateDifference: difference,
      failureCodes,
    },
  };
}

function selectDiscoveryRule(catalog: readonly RuleAssessment[]): RuleAssessment | undefined {
  return [...catalog]
    .filter((entry) => entry.evidence.eligible)
    .sort((left, right) => {
      const difference =
        (right.evidence.positiveRateDifference ?? -Infinity) -
        (left.evidence.positiveRateDifference ?? -Infinity);
      if (difference !== 0) return difference;
      const support = right.evidence.support - left.evidence.support;
      if (support !== 0) return support;
      return left.catalogRuleId.localeCompare(right.catalogRuleId);
    })[0];
}

function validateRule(
  units: readonly AnalysisUnit[],
  selected: RuleAssessment,
  coverage: ReturnType<typeof buildCoverage>,
) {
  const validation = partitionUnits(units).VALIDATION;
  const coverageEntry = coverage.find((entry) => entry.field === selected.field);
  if (selected.threshold === null)
    throw new Error("A selected discovery rule must have a finite threshold.");
  const threshold = selected.threshold;
  const labelled = validation.filter(
    (unit) =>
      finiteFieldValue(unit, selected.field) !== undefined && primaryLabel(unit) !== "UNUSABLE_60M",
  );
  const matching = labelled.filter((unit) =>
    matchesRule(unit, selected.field, selected.direction, threshold),
  );
  const comparison = labelled.filter(
    (unit) => !matchesRule(unit, selected.field, selected.direction, threshold),
  );
  const dates = countDates(matching);
  const positiveRate = rate(matching);
  const comparisonPositiveRate = rate(comparison);
  const difference =
    positiveRate === null || comparisonPositiveRate === null
      ? null
      : positiveRate - comparisonPositiveRate;
  const positives = matching.filter((unit) => primaryLabel(unit) === "POSITIVE_60M").length;
  const comparisonPositives = comparison.filter(
    (unit) => primaryLabel(unit) === "POSITIVE_60M",
  ).length;
  const pValue =
    positiveRate === null || comparisonPositiveRate === null
      ? null
      : fisherGreater(
          positives,
          matching.length - positives,
          comparisonPositives,
          comparison.length - comparisonPositives,
        );
  const leaveOneDateOutStable = leaveOneDateOut(validation, selected);
  const failureCodes: Array<
    | "FEATURE_COVERAGE"
    | "RULE_SUPPORT"
    | "COMPARISON_SUPPORT"
    | "DATE_SUPPORT"
    | "DATE_CONCENTRATION"
    | "EFFECT_SIZE"
    | "FISHER_EXACT"
    | "LEAVE_ONE_DATE_OUT"
  > = [];
  if (!coverageEntry?.eligible) failureCodes.push("FEATURE_COVERAGE");
  if (matching.length < 8) failureCodes.push("RULE_SUPPORT");
  if (comparison.length < 24) failureCodes.push("COMPARISON_SUPPORT");
  if (Object.keys(dates).length < 4) failureCodes.push("DATE_SUPPORT");
  if (maxSharePct(dates, matching.length) > 35) failureCodes.push("DATE_CONCENTRATION");
  if (difference === null || difference < 0.15) failureCodes.push("EFFECT_SIZE");
  if (pValue === null || pValue > 0.05) failureCodes.push("FISHER_EXACT");
  if (!leaveOneDateOutStable) failureCodes.push("LEAVE_ONE_DATE_OUT");
  return {
    catalogRuleId: selected.catalogRuleId,
    unitIds: matching.map((unit) => unit.unitId).sort(),
    support: matching.length,
    comparisonSupport: comparison.length,
    utcDateCount: Object.keys(dates).length,
    maximumUtcDateSharePct: maxSharePct(dates, matching.length),
    positiveRate,
    comparisonPositiveRate,
    positiveRateDifference: difference,
    fisherGreaterPValue: pValue,
    leaveOneDateOutStable,
    passed: failureCodes.length === 0,
    failureCodes,
  };
}

function determineOutcome(input: {
  readonly archiveComplete: boolean;
  readonly qualityPasses: boolean;
  readonly selected: RuleAssessment | undefined;
  readonly validation: ReturnType<typeof validateRule> | undefined;
}) {
  if (!input.archiveComplete || !input.qualityPasses) {
    return {
      ready: false,
      outcome: {
        status: "DATA_INSUFFICIENT" as const,
        reasons: ["PRE_REGISTERED_QUALITY_GATE_FAILED"],
      },
      nextPermittedAction: "PRESERVE_ARCHIVE_AND_REVIEW_DATA_QUALITY_ONLY",
    };
  }
  if (!input.selected) {
    return {
      ready: false,
      outcome: {
        status: "NO_DEFENSIBLE_HYPOTHESIS" as const,
        reasons: ["NO_DISCOVERY_RULE_PASSED"],
      },
      nextPermittedAction: "PRESERVE_ARCHIVE_NO_SUCCESSOR_STUDY_AUTHORIZED",
    };
  }
  if (!input.validation?.passed) {
    return {
      ready: false,
      outcome: {
        status: "PRE_REGISTRATION_CANDIDATE_REJECTED" as const,
        reasons: ["HELD_VALIDATION_GATE_FAILED"],
      },
      nextPermittedAction: "PRESERVE_ARCHIVE_NO_ALTERNATIVE_RULE_SEARCH",
    };
  }
  return {
    ready: true,
    outcome: {
      status: "PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL" as const,
      reasons: ["HELD_VALIDATION_GATES_PASSED"],
    },
    nextPermittedAction: "HUMAN_MAY_REQUEST_SEPARATE_PRE_REGISTRATION_APPROVAL_ONLY",
  };
}

function nonNullEvidence(evidence: RuleAssessment["evidence"]) {
  if (
    evidence.positiveRate === null ||
    evidence.comparisonPositiveRate === null ||
    evidence.positiveRateDifference === null
  ) {
    throw new Error("Ready discovery evidence must be finite.");
  }
  return {
    support: evidence.support,
    comparisonSupport: evidence.comparisonSupport,
    positiveRate: evidence.positiveRate,
    comparisonPositiveRate: evidence.comparisonPositiveRate,
    positiveRateDifference: evidence.positiveRateDifference,
  };
}

function nonNullValidationEvidence(validation: NonNullable<ReturnType<typeof validateRule>>) {
  if (
    validation.positiveRate === null ||
    validation.comparisonPositiveRate === null ||
    validation.positiveRateDifference === null ||
    validation.fisherGreaterPValue === null
  ) {
    throw new Error("Ready validation evidence must be finite.");
  }
  return {
    support: validation.support,
    comparisonSupport: validation.comparisonSupport,
    positiveRate: validation.positiveRate,
    comparisonPositiveRate: validation.comparisonPositiveRate,
    positiveRateDifference: validation.positiveRateDifference,
    fisherGreaterPValue: validation.fisherGreaterPValue,
  };
}

function finiteFieldValue(unit: AnalysisUnit, field: CatalogFieldId): number | undefined {
  const fact = {
    AGE: unit.decisionTime.market.assetAgeSeconds,
    LIQUIDITY: unit.decisionTime.market.liquidityUsd,
    VOLUME_5M: unit.decisionTime.market.volume5mUsd,
    VOLUME_1H: unit.decisionTime.market.volume1hUsd,
    MOMENTUM_5M: unit.decisionTime.market.momentum5mPct,
    MOMENTUM_15M: unit.decisionTime.market.momentum15mPct,
    QUOTE_IMPACT: unit.decisionTime.quote.priceImpactBps,
  }[field];
  return fact.availability === "AVAILABLE_AT_ANCHOR" &&
    typeof fact.value === "number" &&
    Number.isFinite(fact.value)
    ? fact.value
    : undefined;
}

function primaryLabel(unit: AnalysisUnit): PrimaryLabel {
  const observation = unit.laterObservations.find((entry) => entry.minutesAfterAnchor === 60);
  if (
    !observation ||
    observation.availability !== "OBSERVED_ON_TIME" ||
    typeof observation.returnPct !== "number" ||
    !Number.isFinite(observation.returnPct)
  ) {
    return "UNUSABLE_60M";
  }
  return observation.returnPct > 0 ? "POSITIVE_60M" : "NON_POSITIVE_60M";
}

function matchesRule(
  unit: AnalysisUnit,
  field: CatalogFieldId,
  direction: CatalogDirection,
  threshold: number,
): boolean {
  const value = finiteFieldValue(unit, field);
  return value !== undefined && (direction === "LOW_V1" ? value <= threshold : value >= threshold);
}

function rate(units: readonly AnalysisUnit[]): number | null {
  if (units.length === 0) return null;
  return units.filter((unit) => primaryLabel(unit) === "POSITIVE_60M").length / units.length;
}

function partitionUnits(units: readonly AnalysisUnit[]): Record<Partition, AnalysisUnit[]> {
  return {
    DISCOVERY: units.filter((unit) => unit.partition === "DISCOVERY"),
    VALIDATION: units.filter((unit) => unit.partition === "VALIDATION"),
  };
}

function countDates(units: readonly AnalysisUnit[]): Record<string, number> {
  return units.reduce<Record<string, number>>((counts, unit) => {
    const date = unit.anchorAt.slice(0, 10);
    counts[date] = (counts[date] ?? 0) + 1;
    return counts;
  }, {});
}

function maxSharePct(dateCounts: Record<string, number>, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(((Math.max(0, ...Object.values(dateCounts)) / denominator) * 100).toFixed(6));
}

function partitionFor(mint: string, slotId: string): Partition {
  const hash = createHash("sha256")
    .update(`phase10.6a-exploratory-cohort.v2|${mint}|${slotId}`)
    .digest("hex");
  return Number.parseInt(hash.at(-1) ?? "0", 16) % 2 === 0 ? "DISCOVERY" : "VALIDATION";
}

function leaveOneDateOut(units: readonly AnalysisUnit[], selected: RuleAssessment): boolean {
  if (selected.threshold === null) return false;
  const threshold = selected.threshold;
  const dates = [...new Set(units.map((unit) => unit.anchorAt.slice(0, 10)))];
  return dates.every((removedDate) => {
    const retained = units.filter((unit) => unit.anchorAt.slice(0, 10) !== removedDate);
    const labelled = retained.filter(
      (unit) =>
        finiteFieldValue(unit, selected.field) !== undefined &&
        primaryLabel(unit) !== "UNUSABLE_60M",
    );
    const matching = labelled.filter((unit) =>
      matchesRule(unit, selected.field, selected.direction, threshold),
    );
    const comparison = labelled.filter(
      (unit) => !matchesRule(unit, selected.field, selected.direction, threshold),
    );
    const matchingRate = rate(matching);
    const comparisonRate = rate(comparison);
    return matchingRate !== null && comparisonRate !== null && matchingRate - comparisonRate > 0;
  });
}

function fisherGreater(a: number, b: number, c: number, d: number): number {
  const rowOne = a + b;
  const totalPositive = a + c;
  const total = a + b + c + d;
  const maximum = Math.min(rowOne, totalPositive);
  let probability = 0;
  for (let value = a; value <= maximum; value += 1) {
    probability += Math.exp(
      logChoose(totalPositive, value) +
        logChoose(total - totalPositive, rowOne - value) -
        logChoose(total, rowOne),
    );
  }
  return Math.min(1, probability);
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

function logFactorial(value: number): number {
  let total = 0;
  for (let index = 2; index <= value; index += 1) total += Math.log(index);
  return total;
}

function fingerprint(value: object): string {
  const preimage = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "generatedAt")
      .map(([key, entry]) => [key, key === "contentFingerprint" ? "" : entry]),
  );
  return createHash("sha256").update(stableJson(preimage)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
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
