import { createHash } from "node:crypto";

import {
  EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT,
  EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_SHA256,
  measurementAuditArtifactNames,
} from "./ExploratoryMeasurementAuditIdentity.js";
import { ExploratoryMeasurementAuditLoader } from "./ExploratoryMeasurementAuditLoader.js";
import {
  auditFieldDefinitions,
  EMPTY_MEASUREMENT_AUDIT_SAFETY,
  measurementAvailabilityCodes,
  measurementCatalogFields,
  measurementPartitions,
  type DecisionTimeMeasurementAuditV1,
  type LoadedMeasurementAuditArchive,
  type MeasurementAuditField,
  type MeasurementAuditUnit,
  type MeasurementAvailability,
  type MeasurementAvailabilityLedgerRow,
  type MeasurementDateLedgerRow,
  type MeasurementPartition,
  type MeasurementPartitionQualification,
  type MeasurementProvenanceLedgerRow,
  type MeasurementSignature,
  type MeasurementSourceInventoryLedgerRow,
  type MeasurementSystemicLedgerRow,
} from "./ExploratoryMeasurementAuditTypes.js";

const qualifyingAvailability = new Set<MeasurementAvailability>([
  "UNSUPPORTED",
  "UNAVAILABLE_AT_ANCHOR",
]);

export class ExploratoryMeasurementAuditService {
  constructor(
    private readonly options: {
      readonly loader?: ExploratoryMeasurementAuditLoader;
      readonly now?: () => Date;
    } = {},
  ) {}

  build(archiveRoot: string, repoRoot: string): DecisionTimeMeasurementAuditV1 {
    const archive = (this.options.loader ?? new ExploratoryMeasurementAuditLoader()).load(
      archiveRoot,
      repoRoot,
    );
    const fieldAvailabilityLedger = buildAvailabilityLedger(archive.units);
    const missingnessProvenanceLedger = buildProvenanceLedger(archive.units);
    const dateDistributionLedger = buildDateLedger(archive.units);
    const decisionTimeSourceInventoryLedger = buildSourceLedger(archive);
    const systemicDeficiencyLedger = buildSystemicLedger(archive.units, fieldAvailabilityLedger);
    const result = selectOutcome(archive.units, systemicDeficiencyLedger);
    const report: DecisionTimeMeasurementAuditV1 = {
      contractVersion: "1",
      generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      contentFingerprint: "",
      archiveIdentity: {
        status: "MATCHED",
        archiveRoot: EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT,
        protocolSha256: EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_SHA256,
        artifacts: measurementAuditArtifactNames.map((name) => ({
          path: name,
          sha256: archive.inventory[name],
        })),
      },
      safety: EMPTY_MEASUREMENT_AUDIT_SAFETY,
      archiveIntegrity: { finalOutcome: archive.finalOutcome },
      fieldAvailabilityLedger,
      missingnessProvenanceLedger,
      dateDistributionLedger,
      decisionTimeSourceInventoryLedger,
      systemicDeficiencyLedger,
      outcome: result.outcome,
      nextPermittedAction: result.nextPermittedAction,
      warnings: [
        "SOURCE_INVENTORY_AGGREGATES_ARE_NOT_PER_UNIT_CAUSAL_JOINS",
        "MEASUREMENT_RESULT_IS_NOT_A_CANDIDATE_OR_COLLECTION_AUTHORIZATION",
      ],
    };
    return { ...report, contentFingerprint: fingerprint(report) };
  }
}

function buildAvailabilityLedger(
  units: readonly MeasurementAuditUnit[],
): readonly MeasurementAvailabilityLedgerRow[] {
  return auditFieldDefinitions.flatMap((definition) =>
    measurementPartitions.map((partition) => {
      const partitionUnits = units.filter((unit) => unit.partition === partition);
      const availabilityCounts = emptyAvailabilityCounts();
      for (const unit of partitionUnits)
        availabilityCounts[unit.facts[definition.id].availability] += 1;
      const availableAtAnchorCount = availabilityCounts.AVAILABLE_AT_ANCHOR;
      return {
        field: definition.id,
        partition,
        totalDecisionTimeUnits: partitionUnits.length,
        availableAtAnchorCount,
        availabilityCounts,
        availabilityPct: percentage(availableAtAnchorCount, partitionUnits.length),
      };
    }),
  );
}

function buildProvenanceLedger(
  units: readonly MeasurementAuditUnit[],
): readonly MeasurementProvenanceLedgerRow[] {
  const groups = new Map<
    string,
    Omit<MeasurementProvenanceLedgerRow, "count" | "utcDateCount"> & {
      count: number;
      dates: Set<string>;
    }
  >();
  for (const unit of units) {
    for (const definition of auditFieldDefinitions) {
      const fact = unit.facts[definition.id];
      const key = [
        definition.id,
        unit.partition,
        fact.availability,
        fact.sourceCategory,
        fact.sourceIdentifier,
      ].join("|");
      const group = groups.get(key) ?? {
        field: definition.id,
        partition: unit.partition,
        availability: fact.availability,
        sourceCategory: fact.sourceCategory,
        sourceIdentifier: fact.sourceIdentifier,
        count: 0,
        dates: new Set<string>(),
      };
      group.count += 1;
      group.dates.add(unit.anchorDate);
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .map(({ dates, ...entry }) => ({ ...entry, utcDateCount: dates.size }))
    .sort(compareProvenance);
}

function buildDateLedger(
  units: readonly MeasurementAuditUnit[],
): readonly MeasurementDateLedgerRow[] {
  const dates = [...new Set(units.map((unit) => unit.anchorDate))].sort();
  return auditFieldDefinitions.flatMap((definition) =>
    dates.map((utcDate) => {
      const dateUnits = units.filter((unit) => unit.anchorDate === utcDate);
      const availableAtAnchorCount = dateUnits.filter(
        (unit) => unit.facts[definition.id].availability === "AVAILABLE_AT_ANCHOR",
      ).length;
      return {
        field: definition.id,
        utcDate,
        totalDecisionTimeUnits: dateUnits.length,
        availableAtAnchorCount,
        unavailableCount: dateUnits.length - availableAtAnchorCount,
        availabilityPct: percentage(availableAtAnchorCount, dateUnits.length),
      };
    }),
  );
}

function buildSourceLedger(
  archive: LoadedMeasurementAuditArchive,
): readonly MeasurementSourceInventoryLedgerRow[] {
  const groups = new Map<string, MeasurementSourceInventoryLedgerRow>();
  for (const source of archive.sources) {
    const key = [
      source.utcDate,
      source.category,
      source.provider,
      source.capability,
      source.outcomeCode,
      source.latencyBucket,
    ].join("|");
    const current = groups.get(key);
    groups.set(
      key,
      current
        ? { ...current, count: current.count + 1 }
        : {
            utcDate: source.utcDate,
            category: source.category,
            provider: source.provider,
            capability: source.capability,
            outcomeCode: source.outcomeCode,
            latencyBucket: source.latencyBucket,
            count: 1,
          },
    );
  }
  return [...groups.values()].sort(compareSource);
}

function buildSystemicLedger(
  units: readonly MeasurementAuditUnit[],
  coverage: readonly MeasurementAvailabilityLedgerRow[],
): readonly MeasurementSystemicLedgerRow[] {
  return measurementCatalogFields.map((definition) => {
    const partitions = measurementPartitions.map((partition) =>
      assessPartition(definition.id, partition, units, coverage),
    );
    const failures = partitions.filter((entry) => !entry.coveragePassed);
    const qualification = classifyField(definition.id, failures, units);
    return {
      field: definition.catalogField,
      auditField: definition.id,
      partitions,
      qualification,
    };
  });
}

function assessPartition(
  field: MeasurementAuditField,
  partition: MeasurementPartition,
  units: readonly MeasurementAuditUnit[],
  coverage: readonly MeasurementAvailabilityLedgerRow[],
): MeasurementPartitionQualification {
  const row = coverage.find(
    (candidate) => candidate.field === field && candidate.partition === partition,
  );
  if (!row) throw new Error("Every fixed field and partition must have coverage evidence.");
  const unavailable = units.filter(
    (unit) =>
      unit.partition === partition && unit.facts[field].availability !== "AVAILABLE_AT_ANCHOR",
  );
  const groups = new Map<
    string,
    {
      readonly availability: MeasurementAvailability;
      readonly sourceCategory: "MARKET_CONTEXT" | "QUOTE_IMPACT";
      readonly sourceIdentifier: "BEST_PAIR" | "QUOTE";
      count: number;
      dates: Set<string>;
    }
  >();
  for (const unit of unavailable) {
    const fact = unit.facts[field];
    const key = [fact.availability, fact.sourceCategory, fact.sourceIdentifier].join("|");
    const group = groups.get(key) ?? {
      availability: fact.availability,
      sourceCategory: fact.sourceCategory,
      sourceIdentifier: fact.sourceIdentifier,
      count: 0,
      dates: new Set<string>(),
    };
    group.count += 1;
    group.dates.add(unit.anchorDate);
    groups.set(key, group);
  }
  const ranked = [...groups.values()]
    .map((group) => ({
      availability: group.availability,
      sourceCategory: group.sourceCategory,
      sourceIdentifier: group.sourceIdentifier,
      count: group.count,
      unavailableSharePct: percentage(group.count, unavailable.length),
      utcDateCount: group.dates.size,
    }))
    .sort(compareSignature);
  const maximum = ranked[0]?.count ?? 0;
  const top = maximum === 0 ? [] : ranked.filter((signature) => signature.count === maximum);
  return {
    partition,
    totalDecisionTimeUnits: row.totalDecisionTimeUnits,
    availableAtAnchorCount: row.availableAtAnchorCount,
    coveragePassed: row.availableAtAnchorCount >= Math.ceil(row.totalDecisionTimeUnits * 0.9),
    unavailableCount: unavailable.length,
    dominantSignature: top.length === 1 ? (top[0] ?? null) : null,
    tiedSignatures: top.length > 1 ? top : [],
  };
}

function classifyField(
  field: MeasurementAuditField,
  failures: readonly MeasurementPartitionQualification[],
  units: readonly MeasurementAuditUnit[],
): MeasurementSystemicLedgerRow["qualification"] {
  if (failures.length === 0) return "NO_COVERAGE_GAP";
  if (failures.some((failure) => failure.totalDecisionTimeUnits === 0)) {
    return "INSUFFICIENT_PARTITION_OR_DATE_EVIDENCE";
  }
  const tieHasQualifyingSignature = failures.some((failure) =>
    failure.tiedSignatures.some((signature) => qualifyingAvailability.has(signature.availability)),
  );
  if (tieHasQualifyingSignature) return "QUALIFYING_SIGNATURE_TIE";
  const dominant = failures.map((failure) => failure.dominantSignature);
  if (dominant.some((signature) => signature === null)) return "TRANSIENT_OR_NONQUALIFYING_GAP";
  const resolved = dominant as MeasurementSignature[];
  const sameSignature = resolved.every(
    (signature) => signatureKey(signature) === signatureKey(resolved[0] as MeasurementSignature),
  );
  if (
    !sameSignature &&
    resolved.every((signature) => qualifyingAvailability.has(signature.availability))
  ) {
    return "QUALIFYING_SIGNATURE_TIE";
  }
  const allDominant = resolved.every(
    (signature) =>
      qualifyingAvailability.has(signature.availability) && signature.unavailableSharePct >= 80,
  );
  if (!sameSignature || !allDominant) return "TRANSIENT_OR_NONQUALIFYING_GAP";
  const signature = resolved[0] as MeasurementSignature;
  const supportingDates = new Set(
    units
      .filter((unit) => {
        const fact = unit.facts[field];
        return signatureKey(fact) === signatureKey(signature);
      })
      .map((unit) => unit.anchorDate),
  );
  return supportingDates.size >= 8
    ? "SYSTEMIC_ATTRIBUTABLE_MEASUREMENT_DEFICIENCY"
    : "TRANSIENT_OR_NONQUALIFYING_GAP";
}

function selectOutcome(
  units: readonly MeasurementAuditUnit[],
  ledger: readonly MeasurementSystemicLedgerRow[],
): Pick<DecisionTimeMeasurementAuditV1, "outcome" | "nextPermittedAction"> {
  const dateCount = new Set(units.map((unit) => unit.anchorDate)).size;
  const partitionTotals = measurementPartitions.map(
    (partition) => units.filter((unit) => unit.partition === partition).length,
  );
  if (partitionTotals.some((total) => total === 0) || dateCount < 8) {
    return {
      outcome: {
        status: "MEASUREMENT_EVIDENCE_INSUFFICIENT",
        reasons: ["PARTITION_OR_DATE_EVIDENCE_UNAVAILABLE"],
      },
      nextPermittedAction: "PRESERVE_ARCHIVE_MEASUREMENT_CONCLUSION_DEFERRED",
    };
  }
  if (ledger.some((entry) => entry.qualification === "QUALIFYING_SIGNATURE_TIE")) {
    return {
      outcome: {
        status: "HUMAN_REVIEW_REQUIRED",
        reasons: ["QUALIFYING_MISSINGNESS_SIGNATURE_TIE"],
      },
      nextPermittedAction: "PRESERVE_ARCHIVE_HUMAN_REVIEW_REQUIRED",
    };
  }
  if (
    ledger.some((entry) => entry.qualification === "SYSTEMIC_ATTRIBUTABLE_MEASUREMENT_DEFICIENCY")
  ) {
    return {
      outcome: {
        status: "MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW",
        reasons: ["SYSTEMIC_ATTRIBUTABLE_MEASUREMENT_DEFICIENCY"],
      },
      nextPermittedAction: "DRAFT_MEASUREMENT_ONLY_PROTOCOL_FOR_SEPARATE_REVIEW",
    };
  }
  return {
    outcome: {
      status: "NO_ACTIONABLE_MEASUREMENT_CHANGE",
      reasons: ["NO_SYSTEMIC_ATTRIBUTABLE_MEASUREMENT_DEFICIENCY"],
    },
    nextPermittedAction: "PRESERVE_ARCHIVE_NO_NEW_PROTOCOL_AUTHORIZED",
  };
}

function emptyAvailabilityCounts(): Record<MeasurementAvailability, number> {
  return Object.fromEntries(
    measurementAvailabilityCodes.map((availability) => [availability, 0]),
  ) as Record<MeasurementAvailability, number>;
}

function percentage(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(6));
}

function signatureKey(
  signature: Pick<MeasurementSignature, "availability" | "sourceCategory" | "sourceIdentifier">,
): string {
  return [signature.availability, signature.sourceCategory, signature.sourceIdentifier].join("|");
}

function compareProvenance(
  left: MeasurementProvenanceLedgerRow,
  right: MeasurementProvenanceLedgerRow,
): number {
  return [left.field, left.partition, left.availability, left.sourceCategory, left.sourceIdentifier]
    .join("|")
    .localeCompare(
      [
        right.field,
        right.partition,
        right.availability,
        right.sourceCategory,
        right.sourceIdentifier,
      ].join("|"),
    );
}

function compareSignature(left: MeasurementSignature, right: MeasurementSignature): number {
  if (right.count !== left.count) return right.count - left.count;
  return signatureKey(left).localeCompare(signatureKey(right));
}

function compareSource(
  left: MeasurementSourceInventoryLedgerRow,
  right: MeasurementSourceInventoryLedgerRow,
): number {
  return [
    left.utcDate,
    left.category,
    left.provider,
    left.capability,
    left.outcomeCode,
    left.latencyBucket,
  ]
    .join("|")
    .localeCompare(
      [
        right.utcDate,
        right.category,
        right.provider,
        right.capability,
        right.outcomeCode,
        right.latencyBucket,
      ].join("|"),
    );
}

function fingerprint(value: DecisionTimeMeasurementAuditV1): string {
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
