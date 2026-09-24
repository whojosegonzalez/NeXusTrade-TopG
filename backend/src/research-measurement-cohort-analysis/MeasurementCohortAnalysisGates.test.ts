import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MeasurementCohortAnalysisService } from "./MeasurementCohortAnalysisService.js";
import {
  formatMeasurementCohortAnalysisJson,
  formatMeasurementCohortAnalysisMarkdown,
} from "./MeasurementCohortAnalysisFormatter.js";
import {
  measurementObjectives,
  type LoadedMeasurementCohortAnalysisArchive,
  type MeasurementObjective,
} from "./MeasurementCohortAnalysisTypes.js";
import {
  cleanupFixtures,
  syntheticArchive,
  makeFinalFixture,
  loadFixture,
  rewriteInternalHashes,
  repoRoot,
} from "./MeasurementCohortAnalysis.test-support.js";
afterEach(cleanupFixtures);
const now = () => new Date("2026-10-01T00:00:00.000Z");
const build = (archive: LoadedMeasurementCohortAnalysisArchive) =>
  new MeasurementCohortAnalysisService({ now }).buildFromLoadedArchive(archive);
function population(
  count = 96,
  discovery = Math.floor(count / 2),
  dates = 8,
): LoadedMeasurementCohortAnalysisArchive {
  const archive = syntheticArchive({ validUnitCount: count });
  return {
    ...archive,
    units: archive.units.map((unit, index) => ({
      ...unit,
      partition: index < discovery ? "DISCOVERY" : "VALIDATION",
      anchorDate: `2026-09-${String(5 + (index % dates)).padStart(2, "0")}`,
    })),
  };
}
function missing(
  unit: LoadedMeasurementCohortAnalysisArchive["units"][number],
  objective: MeasurementObjective,
) {
  return {
    ...unit,
    facts: {
      ...unit.facts,
      [objective]: {
        availability: "UNAVAILABLE_AT_ANCHOR" as const,
        sourceCategory: "MARKET_CONTEXT" as const,
        sourceIdentifier: "BEST_PAIR" as const,
      },
    },
  };
}
function gate(archive: LoadedMeasurementCohortAnalysisArchive, name: string): boolean | undefined {
  return build(archive).cohortSufficiency.gates.find((g) => g.gate === name)?.passed;
}

describe("H1 frozen gate boundaries", () => {
  it.each([71, 72, 95, 96])("distinguishes minimum and planned units at %i", (count) => {
    const report = build(population(count));
    expect(
      report.cohortSufficiency.gates.find((g) => g.gate === "MINIMUM_VALID_UNITS")?.passed,
    ).toBe(count >= 72);
    expect(
      report.cohortSufficiency.gates.find((g) => g.gate === "PLANNED_VALID_UNITS")?.passed,
    ).toBe(count >= 96);
    expect(report.outcome.status).toBe(
      count < 72 ? "MEASUREMENT_EVIDENCE_INSUFFICIENT" : "MEASUREMENT_CAPABILITY_CONFIRMED",
    );
    expect(report.outcome.failedGateIds).not.toContain("PLANNED_VALID_UNITS");
  });
  it.each([71, 72])("requires %i distinct mints independently", (distinctMintCount) => {
    const report = build({ ...population(), distinctMintCount });
    expect(report.outcome.status).toBe(
      distinctMintCount < 72
        ? "MEASUREMENT_EVIDENCE_INSUFFICIENT"
        : "MEASUREMENT_CAPABILITY_CONFIRMED",
    );
  });
  it.each([7, 8])("requires the frozen UTC date count at %i", (dates) => {
    const archive = population(96, 48, dates);
    expect(gate(archive, "MINIMUM_UTC_DATES")).toBe(dates >= 8);
    expect(build(archive).outcome.status).toBe(
      dates < 8 ? "MEASUREMENT_EVIDENCE_INSUFFICIENT" : "MEASUREMENT_CAPABILITY_CONFIRMED",
    );
  });
  it.each([31, 32])("requires partition units at %i in both partitions", (count) => {
    for (const discovery of [count, 96 - count]) {
      const archive = population(96, discovery);
      expect(gate(archive, "MINIMUM_PARTITION_UNITS")).toBe(count >= 32);
      expect(build(archive).outcome.status).toBe(
        count < 32 ? "MEASUREMENT_EVIDENCE_INSUFFICIENT" : "MEASUREMENT_CAPABILITY_CONFIRMED",
      );
    }
  });
  it.each([3, 4])("requires partition dates at %i", (dates) => {
    const archive = population(96, 32);
    const adjusted = {
      ...archive,
      units: archive.units.map((unit, index) =>
        unit.partition === "DISCOVERY"
          ? { ...unit, anchorDate: `2026-09-${String(5 + (index % dates)).padStart(2, "0")}` }
          : unit,
      ),
    };
    expect(gate(adjusted, "MINIMUM_PARTITION_DATES")).toBe(dates >= 4);
    expect(build(adjusted).outcome.status).toBe(
      dates < 4 ? "MEASUREMENT_EVIDENCE_INSUFFICIENT" : "MEASUREMENT_CAPABILITY_CONFIRMED",
    );
  });
  it.each([16, 17])("enforces 20 percent concentration with %i of 80 units on one date", (peak) => {
    const archive = population(80);
    const adjusted = {
      ...archive,
      units: archive.units.map((unit, index) => ({
        ...unit,
        anchorDate: `2026-09-${String(index < peak ? 5 : 6 + ((index - peak) % 7)).padStart(2, "0")}`,
      })),
    };
    const report = build(adjusted);
    expect(report.cohortSufficiency.maximumUtcDateSharePct).toBe((peak / 80) * 100);
    expect(gate(adjusted, "MAXIMUM_UTC_DATE_SHARE")).toBe(peak === 16);
    expect(report.outcome.status).toBe(
      peak === 16 ? "MEASUREMENT_CAPABILITY_CONFIRMED" : "MEASUREMENT_EVIDENCE_INSUFFICIENT",
    );
  });
  it.each(measurementObjectives)(
    "enforces availability edges for %s in each partition",
    (objective) => {
      for (const partition of ["DISCOVERY", "VALIDATION"] as const)
        for (const unavailable of [3, 4, 5]) {
          const archive = population(80);
          let seen = 0;
          const report = build({
            ...archive,
            units: archive.units.map((unit) =>
              unit.partition === partition && seen++ < unavailable
                ? missing(unit, objective)
                : unit,
            ),
          });
          const row = report.objectiveAvailabilityLedger.find(
            (r) => r.objective === objective && r.partition === partition,
          )!;
          expect(row.availabilityPct).toBe(((40 - unavailable) / 40) * 100);
          expect(row.availabilityGatePassed).toBe(unavailable <= 4);
          expect(report.outcome.status).toBe(
            unavailable <= 4
              ? "MEASUREMENT_CAPABILITY_CONFIRMED"
              : "MEASUREMENT_CAPABILITY_NOT_CONFIRMED",
          );
        }
    },
  );
  it.each(measurementObjectives)(
    "enforces four available dates for %s even above 90 percent",
    (objective) => {
      const archive = population(80);
      const units = archive.units.map((unit, index) => ({
        ...unit,
        anchorDate: `2026-09-${String(index < 40 ? 5 + Math.min(3, Math.floor(index / 13)) : 10 + ((index - 40) % 8)).padStart(2, "0")}`,
      }));
      const pass = build({ ...archive, units });
      const fail = build({
        ...archive,
        units: units.map((unit, index) => (index === 39 ? missing(unit, objective) : unit)),
      });
      expect(pass.outcome.status).toBe("MEASUREMENT_CAPABILITY_CONFIRMED");
      const row = fail.objectiveAvailabilityLedger.find(
        (r) => r.objective === objective && r.partition === "DISCOVERY",
      )!;
      expect(row.availabilityPct).toBe(97.5);
      expect(row.availableUtcDateCount).toBe(3);
      expect(fail.outcome).toEqual({
        status: "MEASUREMENT_CAPABILITY_NOT_CONFIRMED",
        failedGateIds: [`${objective}_DATE_SUPPORT:DISCOVERY`],
      });
    },
  );
  it("gives insufficiency priority over capability failure and handles zero denominators", () => {
    const empty = build(population(0));
    expect(empty.outcome.status).toBe("MEASUREMENT_EVIDENCE_INSUFFICIENT");
    expect(empty.objectiveAvailabilityLedger.every((row) => row.availabilityPct === 0)).toBe(true);
    expect(JSON.stringify(empty)).not.toMatch(/NaN|Infinity/);
  });
  it("matches every numeric gate to the frozen source-controlled protocol", () => {
    const protocol = JSON.parse(
      readFileSync(
        path.join(repoRoot, "docs/research-protocols/phase10.6a-exploratory-cohort.v3.json"),
        "utf8",
      ),
    );
    expect(protocol.collectionPlan).toMatchObject({
      plannedUnits: 96,
      minimumValidUnits: 72,
      maximumAttemptedSlots: 168,
      partitionAssignment: { minimumValidUnitsPerPartition: 32, minimumUtcDatesPerPartition: 4 },
      independence: {
        minimumUtcDates: 8,
        maximumValidUnitSharePerUtcDatePct: 20,
        minimumDistinctMints: 72,
      },
    });
    expect(protocol.dataQualityAndMeasurementGates).toMatchObject({
      minimumAvailabilityPctPerObjectivePerPartition: 90,
      minimumUtcDateSupportPerObjectivePerPartition: 4,
    });
    expect(
      protocol.measurementObjectives.map(
        (row: { method: Record<string, unknown> }) =>
          row.method.maximumSourceToAnchorSeconds ??
          row.method.maximumSourceToScheduledSnapshotSeconds,
      ),
    ).toEqual([60, 60, 60]);
  });
});

describe("H1 report contract", () => {
  it.each([0, 6])(
    "discards changed numbers while preserving aggregate decisions with %i missing liquidity facts",
    (unavailableLiquidity) => {
      const fixture = makeFinalFixture({ unavailableLiquidity });
      const before = build(loadFixture(fixture));
      const file = path.join(fixture.root, "units.v1.ndjson");
      const units = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const unit of units) {
        const snapshots = unit.decisionTime.snapshots;
        for (const snapshot of snapshots) snapshot.priceUsd.value *= 7;
        if (unit.decisionTime.market.liquidityUsd.value !== undefined) {
          unit.decisionTime.market.liquidityUsd.value = 987654321.125;
          snapshots[3].liquidityUsd.value = 987654321.125;
        }
        unit.decisionTime.market.momentum5mPct.value =
          (snapshots[3].priceUsd.value / snapshots[2].priceUsd.value - 1) * 100;
        unit.decisionTime.market.momentum15mPct.value =
          (snapshots[3].priceUsd.value / snapshots[0].priceUsd.value - 1) * 100;
      }
      writeFileSync(file, units.map((unit) => JSON.stringify(unit)).join("\n") + "\n");
      const after = build(
        loadFixture({ ...fixture, identity: rewriteInternalHashes(fixture.root) }),
      );
      const {
        archiveIdentity: beforeIdentity,
        contentFingerprint: beforeFingerprint,
        ...beforeFacts
      } = before;
      const {
        archiveIdentity: afterIdentity,
        contentFingerprint: afterFingerprint,
        ...afterFacts
      } = after;
      expect(afterFacts).toEqual(beforeFacts);
      // Raw artifact bytes changed, so their identity and the report fingerprint must change.
      expect(afterIdentity).not.toEqual(beforeIdentity);
      expect(afterFingerprint).not.toBe(beforeFingerprint);
      expect(
        formatMeasurementCohortAnalysisJson(after) + formatMeasurementCohortAnalysisMarkdown(after),
      ).not.toContain("987654321.125");
      expect(after.outcome.status).toBe(
        unavailableLiquidity
          ? "MEASUREMENT_CAPABILITY_NOT_CONFIRMED"
          : "MEASUREMENT_CAPABILITY_CONFIRMED",
      );
    },
  );
  it("independently reconstructs the fingerprint and canonical JSON regardless of time or input order", () => {
    const archive = loadFixture(makeFinalFixture());
    const report = build(archive);
    const json = JSON.parse(formatMeasurementCohortAnalysisJson(report)) as Record<string, unknown>;
    delete json.generatedAt;
    json.contentFingerprint = "";
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object")
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          visit(child);
        }
    };
    visit(json);
    const preimage = JSON.stringify(json, [...keys].sort());
    expect(preimage).toContain('"contentFingerprint":""');
    expect(createHash("sha256").update(preimage).digest("hex")).toBe(report.contentFingerprint);
    const later = new MeasurementCohortAnalysisService({
      now: () => new Date("2026-10-02T00:00:00.000Z"),
    }).buildFromLoadedArchive({
      ...archive,
      units: [...archive.units].reverse(),
      sources: [...archive.sources].reverse(),
    });
    expect(later.contentFingerprint).toBe(report.contentFingerprint);
    const stable = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(stable);
      else if (value && typeof value === "object") {
        expect(Object.keys(value)).toEqual(Object.keys(value).sort());
        Object.values(value).forEach(stable);
      }
    };
    stable(JSON.parse(formatMeasurementCohortAnalysisJson(report)));
  });
  it("emits the same bounded identity, counters, ledgers and outcome in exactly five Markdown sections", () => {
    const fixture = makeFinalFixture();
    const report = build(loadFixture(fixture));
    const json = JSON.parse(formatMeasurementCohortAnalysisJson(report));
    const md = formatMeasurementCohortAnalysisMarkdown(report);
    expect(md.match(/^## .+$/gm)).toEqual([
      "## Identity and safety",
      "## Cohort sufficiency",
      "## Objective availability ledger",
      "## Missingness and source evidence",
      "## Final gate ledger",
    ]);
    expect(json.safety).toEqual({
      providerCalls: 0,
      databaseReads: 0,
      databaseWrites: 0,
      filesystemWrites: 0,
      runtimeActions: 0,
      sessionActions: 0,
      orders: 0,
      fills: 0,
      positions: 0,
      walletLoaded: false,
      transactionSigning: false,
      transactionSubmission: false,
      laterLabelMembersInterpreted: 0,
    });
    expect(md).toContain(`- Protocol SHA-256: ${json.archiveIdentity.protocolSha256}`);
    expect(md).toContain(`- Archive root: ${json.archiveIdentity.archiveRoot}`);
    for (const line of [
      "- Provider/RPC/HTTP calls: 0",
      "- Database reads/writes: 0/0",
      "- Filesystem writes: 0",
      "- Runtime/session/order/fill/position actions: 0/0/0/0/0",
      "- Wallet loaded / signing / submission: false / false / false",
      "- Later-label members interpreted: 0",
    ])
      expect(md).toContain(line);
    expect(md).toContain(`- Attempted slots: ${json.cohortSufficiency.attemptedSlotCount}`);
    expect(md).toContain(`- Valid units: ${json.cohortSufficiency.validUnitCount}/96`);
    expect(md).toContain(`- Distinct mints: ${json.cohortSufficiency.distinctMintCount}`);
    expect(md).toContain(`- UTC dates: ${json.cohortSufficiency.utcDateCount};`);
    for (const partition of report.cohortSufficiency.partitions)
      expect(md).toContain(
        `${partition.partition}: units=${partition.validUnitCount}; UTC dates=${partition.utcDateCount}`,
      );
    for (const warning of report.warnings) expect(md).toContain(warning);
    for (const artifact of report.archiveIdentity.artifacts)
      expect(md).toContain(`- Artifact ${artifact.path}: ${artifact.sha256}`);
    for (const row of report.objectiveAvailabilityLedger) {
      expect(md).toContain(
        `${row.objective}/${row.partition}: available=${row.availableAtAnchorCount}/${row.validUnitCount}`,
      );
      for (const [code, count] of Object.entries(row.availabilityCounts))
        expect(md).toContain(`${row.objective}/${row.partition}/${code}: count=${count}`);
      expect(Object.values(row.availabilityCounts).reduce((a, b) => a + b, 0)).toBe(
        row.validUnitCount,
      );
    }
    for (const row of report.missingnessLedger)
      expect(md).toContain(
        `${row.objective}/${row.partition}/${row.utcDate}/${row.availability}/${row.sourceCategory}/${row.sourceIdentifier}: count=${row.count}`,
      );
    for (const row of report.sourceInventoryLedger)
      expect(md).toContain(
        `source ${row.utcDate}/${row.category}/${row.capability}/${row.outcomeCode}/${row.latencyBucket}: count=${row.count}`,
      );
    for (const row of report.finalGateLedger)
      expect(md).toContain(`${row.passed ? "PASS" : "FAIL"} — ${row.gate}/${row.partition}`);
    expect(md).toContain(report.outcome.status);
    expect(md).toContain(report.nextPermittedAction);
    expect(report.objectiveAvailabilityLedger.map((r) => `${r.objective}/${r.partition}`)).toEqual([
      "LIQUIDITY/DISCOVERY",
      "LIQUIDITY/VALIDATION",
      "MOMENTUM_5M/DISCOVERY",
      "MOMENTUM_5M/VALIDATION",
      "MOMENTUM_15M/DISCOVERY",
      "MOMENTUM_15M/VALIDATION",
    ]);
    const raw = JSON.parse(
      readFileSync(path.join(fixture.root, "units.v1.ndjson"), "utf8").split("\n")[0]!,
    );
    const sourceRows = JSON.parse(
      readFileSync(path.join(fixture.root, "source-inventory.v1.json"), "utf8"),
    );
    const output = md + JSON.stringify(json);
    for (const forbidden of [
      raw.canonicalMint,
      raw.unitId,
      raw.slotId,
      raw.selection.selectionHash,
      raw.selection.firstObservedAt,
      sourceRows[0].sourceHash,
      String(raw.decisionTime.market.liquidityUsd.value),
      "https://",
    ])
      expect(output).not.toContain(forbidden);
    expect(Object.keys(json).sort()).toEqual(
      [
        "archiveFinality",
        "archiveIdentity",
        "cohortSufficiency",
        "contentFingerprint",
        "contractVersion",
        "finalArchiveOutcome",
        "finalGateLedger",
        "generatedAt",
        "missingnessLedger",
        "nextPermittedAction",
        "objectiveAvailabilityLedger",
        "outcome",
        "safety",
        "sourceInventoryLedger",
        "warnings",
      ].sort(),
    );
    expect(md.length).toBeLessThan(100_000);
  });
});
