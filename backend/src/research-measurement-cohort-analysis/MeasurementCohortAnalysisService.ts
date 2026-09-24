import { createHash } from "node:crypto";

import { MeasurementCohortAnalysisLoader } from "./MeasurementCohortAnalysisLoader.js";
import {
  EMPTY_MEASUREMENT_COHORT_ANALYSIS_SAFETY,
  MEASUREMENT_COHORT_ANALYSIS_CONTRACT_VERSION,
  measurementCohortAnalysisArtifactNames,
  measurementAvailabilityCodes,
  measurementObjectives,
  measurementPartitions,
  type LoadedMeasurementCohortAnalysisArchive,
  type MeasurementAvailability,
  type MeasurementCohortAnalysisStatus,
  type MeasurementCohortAnalysisV1,
  type MeasurementCohortFinalGateRow,
  type MeasurementCohortMissingnessLedgerRow,
  type MeasurementCohortObjectiveLedgerRow,
  type MeasurementCohortPartitionSummary,
  type MeasurementCohortSourceLedgerRow,
  type MeasurementCohortSufficiencyGate,
} from "./MeasurementCohortAnalysisTypes.js";

const plannedValidUnitCount = 96;
const minimumValidUnitCount = 72;
const minimumDistinctMintCount = 72;
const minimumUtcDateCount = 8;
const maximumUtcDateSharePct = 20;
const minimumPartitionUnitCount = 32;
const minimumPartitionUtcDateCount = 4;
const minimumObjectiveUtcDateCount = 4;
const minimumAvailabilityPct = 90;

export class MeasurementCohortAnalysisService {
  constructor(
    private readonly options: {
      readonly loader?: MeasurementCohortAnalysisLoader;
      readonly now?: () => Date;
    } = {},
  ) {}

  build(archiveRoot: string, repoRoot: string): MeasurementCohortAnalysisV1 {
    return this.buildFromLoadedArchive(
      (
        this.options.loader ??
        new MeasurementCohortAnalysisLoader({ identity: impossibleIdentity() })
      ).load(archiveRoot, repoRoot),
    );
  }

  buildFromLoadedArchive(
    archive: LoadedMeasurementCohortAnalysisArchive,
  ): MeasurementCohortAnalysisV1 {
    const partitions = buildPartitionSummaries(archive);
    const dateCounts = countDates(archive.units);
    const sufficiencyGates = buildSufficiencyGates(archive, partitions, dateCounts);
    const objectiveAvailabilityLedger = buildObjectiveAvailabilityLedger(archive);
    const missingnessLedger = buildMissingnessLedger(archive);
    const sourceInventoryLedger = buildSourceInventoryLedger(archive);
    const finalGateLedger = buildFinalGateLedger(
      sufficiencyGates,
      partitions,
      objectiveAvailabilityLedger,
    );
    const outcome = determineOutcome(sufficiencyGates, objectiveAvailabilityLedger);
    const draft = {
      contractVersion: MEASUREMENT_COHORT_ANALYSIS_CONTRACT_VERSION,
      generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      contentFingerprint: "",
      archiveIdentity: {
        status: "MATCHED" as const,
        archiveRoot: "data/archive/phase10.6a/measurement-v3-20260904-2100Z",
        protocolSha256: "dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458",
        artifacts: measurementCohortAnalysisArtifactNames
          .map((path) => ({ path, sha256: archive.inventory[path] }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      },
      archiveFinality: "MATCHED" as const,
      safety: EMPTY_MEASUREMENT_COHORT_ANALYSIS_SAFETY,
      finalArchiveOutcome: archive.finalOutcome,
      cohortSufficiency: {
        attemptedSlotCount: archive.attemptedSlotCount,
        validUnitCount: archive.validUnitCount,
        plannedValidUnitCount,
        distinctMintCount: archive.distinctMintCount,
        utcDateCount: Object.keys(dateCounts).length,
        maximumUtcDateSharePct: maximumShare(dateCounts, archive.validUnitCount),
        partitions,
        gates: sufficiencyGates,
      },
      objectiveAvailabilityLedger,
      missingnessLedger,
      sourceInventoryLedger,
      finalGateLedger,
      outcome,
      nextPermittedAction: nextPermittedAction(outcome.status),
      warnings: [
        "This report evaluates only frozen V3 measurement-capability gates.",
        "Aggregate source inventory contextualizes collection health and does not establish a per-unit causal join.",
        "This result authorizes no protocol, collection, strategy change, Phase 10.6C study, PAPER action, execution action, wallet action, signing, or submission.",
      ],
    } satisfies Omit<MeasurementCohortAnalysisV1, "contentFingerprint"> & {
      readonly contentFingerprint: "";
    };
    return {
      ...draft,
      contentFingerprint: fingerprint(draft),
    };
  }
}

function buildPartitionSummaries(
  archive: LoadedMeasurementCohortAnalysisArchive,
): readonly MeasurementCohortPartitionSummary[] {
  return measurementPartitions.map((partition) => {
    const units = archive.units.filter((unit) => unit.partition === partition);
    return {
      partition,
      validUnitCount: units.length,
      utcDateCount: Object.keys(countDates(units)).length,
    };
  });
}

function buildSufficiencyGates(
  archive: LoadedMeasurementCohortAnalysisArchive,
  partitions: readonly MeasurementCohortPartitionSummary[],
  dateCounts: Readonly<Record<string, number>>,
): readonly MeasurementCohortSufficiencyGate[] {
  return [
    { gate: "MINIMUM_VALID_UNITS", passed: archive.validUnitCount >= minimumValidUnitCount },
    { gate: "PLANNED_VALID_UNITS", passed: archive.validUnitCount >= plannedValidUnitCount },
    {
      gate: "MINIMUM_DISTINCT_MINTS",
      passed: archive.distinctMintCount >= minimumDistinctMintCount,
    },
    { gate: "MINIMUM_UTC_DATES", passed: Object.keys(dateCounts).length >= minimumUtcDateCount },
    {
      gate: "MAXIMUM_UTC_DATE_SHARE",
      passed: maximumShare(dateCounts, archive.validUnitCount) <= maximumUtcDateSharePct,
    },
    {
      gate: "MINIMUM_PARTITION_UNITS",
      passed: partitions.every(
        (partition) => partition.validUnitCount >= minimumPartitionUnitCount,
      ),
    },
    {
      gate: "MINIMUM_PARTITION_DATES",
      passed: partitions.every(
        (partition) => partition.utcDateCount >= minimumPartitionUtcDateCount,
      ),
    },
  ];
}

function buildObjectiveAvailabilityLedger(
  archive: LoadedMeasurementCohortAnalysisArchive,
): readonly MeasurementCohortObjectiveLedgerRow[] {
  return measurementObjectives.flatMap((objective) =>
    measurementPartitions.map((partition) => {
      const units = archive.units.filter((unit) => unit.partition === partition);
      const facts = units.map((unit) => unit.facts[objective]);
      const availabilityCounts = Object.fromEntries(
        measurementAvailabilityCodes.map((availability) => [
          availability,
          facts.filter((fact) => fact.availability === availability).length,
        ]),
      ) as Readonly<Record<MeasurementAvailability, number>>;
      const availableAtAnchorCount = availabilityCounts.AVAILABLE_AT_ANCHOR;
      const availableUtcDateCount = new Set(
        units
          .filter((unit) => unit.facts[objective].availability === "AVAILABLE_AT_ANCHOR")
          .map((unit) => unit.anchorDate),
      ).size;
      const availabilityPct = percentage(availableAtAnchorCount, units.length);
      return {
        objective,
        partition,
        validUnitCount: units.length,
        availableAtAnchorCount,
        availabilityCounts,
        availabilityPct,
        availableUtcDateCount,
        availabilityGatePassed: availabilityPct >= minimumAvailabilityPct,
        dateSupportGatePassed: availableUtcDateCount >= minimumObjectiveUtcDateCount,
        provenanceGatePassed: true,
        freshnessGatePassed: true,
      };
    }),
  );
}

function buildMissingnessLedger(
  archive: LoadedMeasurementCohortAnalysisArchive,
): readonly MeasurementCohortMissingnessLedgerRow[] {
  const rows = new Map<string, MeasurementCohortMissingnessLedgerRow>();
  for (const unit of archive.units) {
    for (const objective of measurementObjectives) {
      const fact = unit.facts[objective];
      const key = [
        objective,
        unit.partition,
        unit.anchorDate,
        fact.availability,
        fact.sourceCategory,
        fact.sourceIdentifier,
      ].join("|");
      const existing = rows.get(key);
      if (existing) {
        rows.set(key, {
          ...existing,
          count: existing.count + 1,
        });
        continue;
      }
      rows.set(key, {
        objective,
        partition: unit.partition,
        utcDate: unit.anchorDate,
        availability: fact.availability,
        sourceCategory: fact.sourceCategory,
        sourceIdentifier: fact.sourceIdentifier,
        count: 1,
      });
    }
  }
  return [...rows.values()].sort(compareMissingness);
}

function buildSourceInventoryLedger(
  archive: LoadedMeasurementCohortAnalysisArchive,
): readonly MeasurementCohortSourceLedgerRow[] {
  const counts = new Map<string, MeasurementCohortSourceLedgerRow>();
  for (const source of archive.sources) {
    const key = [
      source.utcDate,
      source.category,
      source.capability,
      source.outcomeCode,
      source.latencyBucket,
    ].join("|");
    const existing = counts.get(key);
    counts.set(key, {
      utcDate: source.utcDate,
      category: source.category,
      capability: source.capability,
      outcomeCode: source.outcomeCode,
      latencyBucket: source.latencyBucket,
      count: (existing?.count ?? 0) + 1,
    });
  }
  return [...counts.values()].sort(
    (left, right) =>
      left.utcDate.localeCompare(right.utcDate) ||
      left.category.localeCompare(right.category) ||
      left.capability.localeCompare(right.capability) ||
      left.outcomeCode.localeCompare(right.outcomeCode) ||
      left.latencyBucket.localeCompare(right.latencyBucket),
  );
}

function buildFinalGateLedger(
  sufficiency: readonly MeasurementCohortSufficiencyGate[],
  partitions: readonly MeasurementCohortPartitionSummary[],
  objectives: readonly MeasurementCohortObjectiveLedgerRow[],
): readonly MeasurementCohortFinalGateRow[] {
  const result: MeasurementCohortFinalGateRow[] = [];
  for (const gate of sufficiency) {
    if (gate.gate === "MINIMUM_PARTITION_UNITS") {
      for (const partition of partitions) {
        result.push({
          gate: gate.gate,
          partition: partition.partition,
          passed: partition.validUnitCount >= minimumPartitionUnitCount,
        });
      }
    } else if (gate.gate === "MINIMUM_PARTITION_DATES") {
      for (const partition of partitions) {
        result.push({
          gate: gate.gate,
          partition: partition.partition,
          passed: partition.utcDateCount >= minimumPartitionUtcDateCount,
        });
      }
    } else {
      result.push({ gate: gate.gate, partition: "COHORT", passed: gate.passed });
    }
  }
  for (const row of objectives) {
    result.push({
      gate: `${row.objective}_AVAILABILITY`,
      partition: row.partition,
      passed: row.availabilityGatePassed,
    });
    result.push({
      gate: `${row.objective}_DATE_SUPPORT`,
      partition: row.partition,
      passed: row.dateSupportGatePassed,
    });
  }
  return result;
}

function determineOutcome(
  sufficiency: readonly MeasurementCohortSufficiencyGate[],
  objectives: readonly MeasurementCohortObjectiveLedgerRow[],
): MeasurementCohortAnalysisV1["outcome"] {
  const insufficient = sufficiency.filter(
    (gate) => gate.gate !== "PLANNED_VALID_UNITS" && !gate.passed,
  );
  if (insufficient.length > 0) {
    return {
      status: "MEASUREMENT_EVIDENCE_INSUFFICIENT",
      failedGateIds: insufficient.map((gate) => gate.gate),
    };
  }
  const capabilityFailures = objectives.flatMap((row) => [
    ...(row.availabilityGatePassed ? [] : [`${row.objective}_AVAILABILITY:${row.partition}`]),
    ...(row.dateSupportGatePassed ? [] : [`${row.objective}_DATE_SUPPORT:${row.partition}`]),
  ]);
  return {
    status:
      capabilityFailures.length === 0
        ? "MEASUREMENT_CAPABILITY_CONFIRMED"
        : "MEASUREMENT_CAPABILITY_NOT_CONFIRMED",
    failedGateIds: capabilityFailures,
  };
}

function nextPermittedAction(status: MeasurementCohortAnalysisStatus): string {
  if (status === "MEASUREMENT_CAPABILITY_CONFIRMED") {
    return "PRESERVE_ARCHIVE_AND_REQUIRE_SEPARATE_RESEARCH_GOVERNANCE_DECISION";
  }
  if (status === "MEASUREMENT_CAPABILITY_NOT_CONFIRMED") {
    return "PRESERVE_FINAL_DEFICIENCY_LEDGER_FOR_SEPARATE_HUMAN_MEASUREMENT_PROTOCOL_DECISION";
  }
  return "PRESERVE_ARCHIVE_NO_REPLACEMENT_EXTENSION_PROTOCOL_OR_COLLECTION_AUTHORIZED";
}

function countDates(
  units: readonly Pick<LoadedMeasurementCohortAnalysisArchive["units"][number], "anchorDate">[],
): Readonly<Record<string, number>> {
  return units.reduce<Record<string, number>>((counts, unit) => {
    counts[unit.anchorDate] = (counts[unit.anchorDate] ?? 0) + 1;
    return counts;
  }, {});
}

function maximumShare(counts: Readonly<Record<string, number>>, denominator: number): number {
  return percentage(Math.max(0, ...Object.values(counts)), denominator);
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(6));
}

function compareMissingness(
  left: MeasurementCohortMissingnessLedgerRow,
  right: MeasurementCohortMissingnessLedgerRow,
): number {
  return (
    measurementObjectives.indexOf(left.objective) -
      measurementObjectives.indexOf(right.objective) ||
    measurementPartitions.indexOf(left.partition) -
      measurementPartitions.indexOf(right.partition) ||
    left.utcDate.localeCompare(right.utcDate) ||
    measurementAvailabilityCodes.indexOf(left.availability) -
      measurementAvailabilityCodes.indexOf(right.availability) ||
    left.sourceCategory.localeCompare(right.sourceCategory) ||
    left.sourceIdentifier.localeCompare(right.sourceIdentifier)
  );
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
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
  );
}

function impossibleIdentity() {
  const never = "0".repeat(64);
  return {
    protocolSha256: "dd57285927474e3e646bd4a52c5d37fbb550d5cb73f836db69b02827c5360458" as const,
    artifacts: {
      "cohort-manifest.v1.json": never,
      "units.v1.ndjson": never,
      "source-inventory.v1.json": never,
      "collection-summary.v1.json": never,
    },
  };
}
