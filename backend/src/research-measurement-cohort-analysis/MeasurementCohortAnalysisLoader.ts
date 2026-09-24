import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { MeasurementCohortAnalysisError } from "./MeasurementCohortAnalysisErrors.js";
import { isSafeMeasurementCohortAnalysisPath } from "./MeasurementCohortAnalysisPaths.js";
import {
  MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT,
  MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH,
  MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256,
  measurementCohortAnalysisArtifactNames,
  type MeasurementCohortAnalysisIdentity,
} from "./MeasurementCohortAnalysisIdentity.js";
import {
  measurementAvailabilitySchema,
  type LoadedMeasurementCohortAnalysisArchive,
  type MeasurementCohortAnalysisFact,
  type MeasurementCohortAnalysisSource,
  type MeasurementCohortAnalysisUnit,
  type MeasurementObjective,
} from "./MeasurementCohortAnalysisTypes.js";

const isoSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const mintSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const sourceTimestampSchema = isoSchema.optional();
const factSchema = z
  .object({
    availability: measurementAvailabilitySchema,
    sourceCategory: z.enum(["MARKET_CONTEXT", "LOCAL"]),
    sourceIdentifier: z.enum(["BEST_PAIR", "FORMULA"]),
    sourceTimestamp: sourceTimestampSchema,
    value: z.number().finite().optional(),
  })
  .strict();
const snapshotSchema = z
  .object({
    offsetMinutes: z.union([z.literal(-15), z.literal(-10), z.literal(-5), z.literal(0)]),
    scheduledAt: isoSchema,
    priceUsd: factSchema,
    liquidityUsd: factSchema.optional(),
  })
  .strict();
const unitSchema = z
  .object({
    unitId: z.string().regex(/^[a-f0-9]{24}$/),
    slotId: z.string().regex(/^SLOT_\d{3}$/),
    anchorAt: isoSchema,
    canonicalMint: mintSchema,
    partition: z.enum(["DISCOVERY", "VALIDATION"]),
    selection: z
      .object({
        sourceKind: z.literal("DEXSCREENER_TOKEN_PROFILE"),
        firstObservedAt: isoSchema,
        selectionHash: sha256Schema,
      })
      .strict(),
    decisionTime: z
      .object({
        snapshots: z.array(snapshotSchema).length(4),
        market: z
          .object({
            liquidityUsd: factSchema,
            momentum5mPct: factSchema,
            momentum15mPct: factSchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const slotSchema = z
  .object({
    slotId: z.string().regex(/^SLOT_\d{3}$/),
    slotIndex: z.number().int().min(0).max(167),
    anchorAt: isoSchema,
    state: z.enum(["NO_SELECTION", "SKIP_UNIT_WITH_REASON", "VALID_UNIT"]),
    reason: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Z0-9_]+$/),
    discoveryCounts: z
      .object({
        returned: z.number().int().nonnegative().max(100),
        canonical: z.number().int().nonnegative().max(100),
        technicallyValid: z.number().int().nonnegative().max(100),
      })
      .strict(),
    selectedMint: mintSchema.optional(),
  })
  .strict();
const safetySchema = z
  .object({
    databaseReads: z.literal(0),
    databaseWrites: z.literal(0),
    sessions: z.literal(0),
    orders: z.literal(0),
    fills: z.literal(0),
    positions: z.literal(0),
    walletLoaded: z.literal(false),
    transactionSigning: z.literal(false),
    transactionSubmission: z.literal(false),
  })
  .strict();
const providerCountsSchema = z
  .object({
    DISCOVERY: z.number().int().nonnegative(),
    MARKET_CONTEXT: z.number().int().nonnegative(),
  })
  .strict();
const launchSchema = z
  .object({
    contractVersion: z.literal("1"),
    archiveRoot: z.literal(`${MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT}/`),
    cohortStartAt: z.literal("2026-09-04T21:00:00.000Z"),
    protocolPath: z.literal(MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH),
    protocolSha256: z.literal(MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256),
    protocolValidationFingerprint: z.literal(
      "b992982000ac2e0fb51cd7944a979adc0114f77a6845b3d36a3d88b9eab3e4e6",
    ),
    authorization: z.literal("USER_AUTHORIZED_FOR_ONE_MEASUREMENT_ONLY_COLLECTION"),
    authorizationReference: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._ -]+$/),
    operator: z
      .object({
        kind: z.literal("EXTERNAL_OPERATOR"),
        label: z
          .string()
          .min(1)
          .max(80)
          .regex(/^[A-Za-z0-9._ -]+$/),
      })
      .strict(),
  })
  .strict();
const manifestSchema = z
  .object({
    contractVersion: z.literal("1"),
    archiveRoot: z.literal(`${MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT}/`),
    launch: launchSchema,
    executionDisabled: z.literal(true),
    outcome: z.enum(["COHORT_COMPLETE", "MEASUREMENT_COHORT_DATA_INSUFFICIENT"]),
    slots: z.array(slotSchema).max(168),
    providerCounts: providerCountsSchema,
    finalFileHashes: z
      .object({
        "units.v1.ndjson": sha256Schema,
        "source-inventory.v1.json": sha256Schema,
        "collection-summary.v1.json": sha256Schema,
      })
      .strict(),
    safety: safetySchema,
  })
  .strict();
const summarySchema = z
  .object({
    contractVersion: z.literal("1"),
    outcome: z.enum(["COHORT_COMPLETE", "MEASUREMENT_COHORT_DATA_INSUFFICIENT"]),
    validUnitCount: z.number().int().nonnegative().max(168),
    slotCount: z.number().int().nonnegative().max(168),
    providerCounts: providerCountsSchema,
    safety: safetySchema,
    dateCounts: z.record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.number().int().positive()),
  })
  .strict();
const sourceSchema = z
  .object({
    category: z.enum(["DISCOVERY", "MARKET_CONTEXT"]),
    provider: z.literal("DEXSCREENER"),
    capability: z.enum(["DISCOVER_TOKENS", "BEST_PAIR"]),
    requestCount: z.literal(1),
    attemptCount: z.literal(1),
    outcomeCode: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Z0-9_]+$/),
    observedAt: isoSchema,
    latencyBucket: z.enum(["LT_100MS", "LT_1S", "GE_1S"]),
    sourceHash: sha256Schema,
  })
  .strict();

type RawFact = z.infer<typeof factSchema>;
type RawUnit = z.infer<typeof unitSchema>;
type RawManifest = z.infer<typeof manifestSchema>;
type RawSource = z.infer<typeof sourceSchema>;
type RawSummary = z.infer<typeof summarySchema>;

const labelShapedKeys = new Set([
  "laterObservations",
  "returnPct",
  "minutesAfterAnchor",
  "targetFirst",
  "stopFirst",
  "targetHit",
  "stopHit",
  "pnl",
  "pL",
  "mfe",
  "mae",
  "strategyDecision",
  "strategyScore",
  "riskScore",
]);

export class MeasurementCohortAnalysisLoader {
  constructor(
    private readonly options: {
      readonly identity: MeasurementCohortAnalysisIdentity;
      readonly protocolPath?: string;
    },
  ) {}

  load(archiveRoot: string, repoRoot: string): LoadedMeasurementCohortAnalysisArchive {
    assertSafeArchiveRoot(archiveRoot, repoRoot);
    const files = readExactArtifacts(archiveRoot, repoRoot);
    const inventory = Object.fromEntries(
      measurementCohortAnalysisArtifactNames.map((name) => [name, sha256(files[name])]),
    ) as LoadedMeasurementCohortAnalysisArchive["inventory"];
    assertExternalIdentity(inventory, this.options.identity);
    assertProtocolIdentity(repoRoot, this.options.protocolPath);

    const manifestRaw = parseJson(files["cohort-manifest.v1.json"]);
    const unitsRaw = parseNdjson(files["units.v1.ndjson"]);
    const sourcesRaw = parseJson(files["source-inventory.v1.json"]);
    const summaryRaw = parseJson(files["collection-summary.v1.json"]);
    for (const raw of [manifestRaw, unitsRaw, sourcesRaw, summaryRaw]) {
      if (containsUnsafeOrLabelShapedContent(raw)) {
        throw labelViolation("The V3 archive contains prohibited label-shaped content.");
      }
    }
    const manifest = parseWith(manifestSchema, manifestRaw);
    const units = parseArrayWith(unitSchema, unitsRaw);
    const sources = parseArrayWith(sourceSchema, sourcesRaw);
    const summary = parseWith(summarySchema, summaryRaw);

    assertManifestHashes(manifest, inventory);
    assertFinalSummary(manifest, summary, units, sources);
    const projectedUnits = projectUnits(manifest, units);
    const projectedSources = projectSources(sources);
    if (manifest.outcome === "COHORT_COMPLETE" && !completionGatesPass(projectedUnits)) {
      throw sourceInconsistency("The V3 completion state contradicts its frozen completion gates.");
    }
    return {
      finalOutcome: manifest.outcome,
      attemptedSlotCount: manifest.slots.length,
      validUnitCount: projectedUnits.length,
      distinctMintCount: projectedUnits.length,
      inventory,
      units: projectedUnits,
      sources: projectedSources,
    };
  }
}

function assertSafeArchiveRoot(archiveRoot: string, repoRoot: string): void {
  const expected = path.resolve(repoRoot, MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT);
  if (
    path.relative(expected, path.resolve(archiveRoot)) !== "" ||
    !isSafeMeasurementCohortAnalysisPath(repoRoot, archiveRoot, "directory")
  ) {
    throw archiveNotFinal("The approved V3 archive root is unavailable or unsafe.");
  }
  if (existsSync(path.join(archiveRoot, "collection.lock"))) {
    throw archiveNotFinal("The V3 archive has an active collection lock.");
  }
}

function readExactArtifacts(
  archiveRoot: string,
  repoRoot: string,
): Readonly<Record<(typeof measurementCohortAnalysisArtifactNames)[number], Buffer>> {
  const entries = readdirSync(archiveRoot).sort();
  const expected = [...measurementCohortAnalysisArtifactNames].sort();
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== expected[index])
  ) {
    throw sourceInconsistency("The V3 final archive contains an unexpected artifact set.");
  }
  return Object.fromEntries(
    measurementCohortAnalysisArtifactNames.map((name) => {
      const file = path.join(archiveRoot, name);
      if (!isSafeMeasurementCohortAnalysisPath(repoRoot, file, "file")) {
        throw sourceInconsistency("A V3 final archive artifact is unsafe.");
      }
      return [name, readFileSync(file)];
    }),
  ) as Readonly<Record<(typeof measurementCohortAnalysisArtifactNames)[number], Buffer>>;
}

function assertExternalIdentity(
  inventory: LoadedMeasurementCohortAnalysisArchive["inventory"],
  identity: MeasurementCohortAnalysisIdentity,
): void {
  if (identity.protocolSha256 !== MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256) {
    throw sourceInconsistency("The V3 protocol identity binding is inconsistent.");
  }
  for (const name of measurementCohortAnalysisArtifactNames) {
    if (identity.artifacts[name] !== inventory[name]) {
      throw sourceInconsistency("The V3 final archive does not match its registered identity.");
    }
  }
}

function assertProtocolIdentity(repoRoot: string, protocolPath?: string): void {
  const expected = path.resolve(repoRoot, MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH);
  const resolved = protocolPath ? path.resolve(protocolPath) : expected;
  if (resolved !== expected || !isSafeMeasurementCohortAnalysisPath(repoRoot, resolved, "file")) {
    throw sourceInconsistency("The fixed V3 protocol source is unavailable or unsafe.");
  }
  if (sha256(readFileSync(resolved)) !== MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256) {
    throw sourceInconsistency("The fixed V3 protocol source does not match its SHA-256 identity.");
  }
}

function assertManifestHashes(
  manifest: RawManifest,
  inventory: LoadedMeasurementCohortAnalysisArchive["inventory"],
): void {
  for (const name of [
    "units.v1.ndjson",
    "source-inventory.v1.json",
    "collection-summary.v1.json",
  ] as const) {
    if (manifest.finalFileHashes[name] !== inventory[name]) {
      throw sourceInconsistency("The V3 manifest final-file hashes are inconsistent.");
    }
  }
}

function assertFinalSummary(
  manifest: RawManifest,
  summary: RawSummary,
  units: readonly RawUnit[],
  sources: readonly RawSource[],
): void {
  const dateCounts = Object.fromEntries(
    [...new Set(units.map((unit) => unit.anchorAt.slice(0, 10)))]
      .sort()
      .map((date) => [date, units.filter((unit) => unit.anchorAt.startsWith(date)).length]),
  );
  const sourceCounts = {
    DISCOVERY: sources.filter((source) => source.category === "DISCOVERY").length,
    MARKET_CONTEXT: sources.filter((source) => source.category === "MARKET_CONTEXT").length,
  };
  if (
    summary.outcome !== manifest.outcome ||
    summary.validUnitCount !== units.length ||
    summary.slotCount !== manifest.slots.length ||
    stableJson(summary.providerCounts) !== stableJson(manifest.providerCounts) ||
    stableJson(summary.providerCounts) !== stableJson(sourceCounts) ||
    stableJson(summary.safety) !== stableJson(manifest.safety) ||
    stableJson(summary.dateCounts) !== stableJson(dateCounts)
  ) {
    throw sourceInconsistency("The V3 final summary is inconsistent with its archive evidence.");
  }
  if (
    units.length > 96 ||
    manifest.providerCounts.DISCOVERY !== manifest.slots.length ||
    manifest.providerCounts.MARKET_CONTEXT > units.length * 4 ||
    manifest.providerCounts.DISCOVERY > 168 ||
    manifest.providerCounts.MARKET_CONTEXT > 672 ||
    (manifest.outcome === "COHORT_COMPLETE" && units.length !== 96)
  ) {
    throw sourceInconsistency(
      "The V3 final archive violates a frozen collection cap or completion rule.",
    );
  }
}

function projectUnits(
  manifest: RawManifest,
  units: readonly RawUnit[],
): readonly MeasurementCohortAnalysisUnit[] {
  const seenMints = new Set<string>();
  const seenLedgerSlotIds = new Set<string>();
  const seenSlotIndexes = new Set<number>();
  const launchStart = new Date(manifest.launch.cohortStartAt);
  let previousSlotIndex = -1;
  for (const slot of manifest.slots) {
    const expectedAnchor = new Date(
      launchStart.valueOf() + slot.slotIndex * 120 * 60 * 1000,
    ).toISOString();
    if (
      seenLedgerSlotIds.has(slot.slotId) ||
      seenSlotIndexes.has(slot.slotIndex) ||
      slot.slotIndex <= previousSlotIndex ||
      slot.slotId !== `SLOT_${String(slot.slotIndex + 1).padStart(3, "0")}` ||
      slot.anchorAt !== expectedAnchor ||
      slot.discoveryCounts.canonical > slot.discoveryCounts.returned ||
      slot.discoveryCounts.technicallyValid > slot.discoveryCounts.canonical ||
      (slot.state !== "NO_SELECTION") !== (slot.selectedMint !== undefined) ||
      (slot.state !== "NO_SELECTION" && slot.discoveryCounts.technicallyValid === 0) ||
      (slot.state === "VALID_UNIT" && slot.reason !== "VALID_TECHNICAL_UNIT") ||
      (slot.state === "SKIP_UNIT_WITH_REASON" &&
        (slot.reason !== "DUPLICATE_MINT" ||
          !units.some(
            (unit) =>
              unit.canonicalMint === slot.selectedMint &&
              Number(unit.slotId.slice(5)) < Number(slot.slotId.slice(5)),
          )))
    ) {
      throw sourceInconsistency(
        "The V3 slot ledger is not strictly ordered or structurally consistent.",
      );
    }
    seenLedgerSlotIds.add(slot.slotId);
    seenSlotIndexes.add(slot.slotIndex);
    previousSlotIndex = slot.slotIndex;
  }
  const slotById = new Map(manifest.slots.map((slot) => [slot.slotId, slot]));
  const seenUnitSlots = new Set<string>();
  const validSlots = manifest.slots.filter((slot) => slot.state === "VALID_UNIT");
  if (validSlots.length !== units.length) {
    throw sourceInconsistency("The V3 valid-unit and slot ledgers disagree.");
  }
  return units.map((unit) => {
    const slot = slotById.get(unit.slotId);
    if (
      !slot ||
      slot.state !== "VALID_UNIT" ||
      slot.selectedMint !== unit.canonicalMint ||
      seenMints.has(unit.canonicalMint) ||
      seenUnitSlots.has(unit.slotId) ||
      !isCanonicalMint(unit.canonicalMint) ||
      unit.unitId !== sha256(`${unit.slotId}|${unit.canonicalMint}`).slice(0, 24) ||
      unit.selection.selectionHash !==
        sha256(`phase10.6a-exploratory-cohort.v3|${unit.canonicalMint}|${unit.slotId}`) ||
      unit.partition !== partitionFor(unit.canonicalMint, unit.slotId) ||
      unit.anchorAt !== slot.anchorAt
    ) {
      throw sourceInconsistency(
        "The V3 unit identity, partition, or slot evidence is inconsistent.",
      );
    }
    seenMints.add(unit.canonicalMint);
    seenUnitSlots.add(unit.slotId);
    const facts = validateUnitFacts(unit);
    return { partition: unit.partition, anchorDate: unit.anchorAt.slice(0, 10), facts };
  });
}

function completionGatesPass(units: readonly MeasurementCohortAnalysisUnit[]): boolean {
  const dates = new Set(units.map((unit) => unit.anchorDate));
  if (
    units.length !== 96 ||
    dates.size < 8 ||
    [...dates].some(
      (date) => units.filter((unit) => unit.anchorDate === date).length * 100 > units.length * 20,
    )
  )
    return false;
  return (["DISCOVERY", "VALIDATION"] as const).every((partition) => {
    const rows = units.filter((unit) => unit.partition === partition);
    return (
      rows.length >= 32 &&
      new Set(rows.map((unit) => unit.anchorDate)).size >= 4 &&
      (["LIQUIDITY", "MOMENTUM_5M", "MOMENTUM_15M"] as const).every((objective) => {
        const available = rows.filter(
          (unit) => unit.facts[objective].availability === "AVAILABLE_AT_ANCHOR",
        );
        return (
          available.length * 100 >= rows.length * 90 &&
          new Set(available.map((unit) => unit.anchorDate)).size >= 4
        );
      })
    );
  });
}

function validateUnitFacts(
  unit: RawUnit,
): Readonly<Record<MeasurementObjective, MeasurementCohortAnalysisFact>> {
  const snapshots = [...unit.decisionTime.snapshots].sort(
    (left, right) => left.offsetMinutes - right.offsetMinutes,
  );
  const offsets = snapshots.map((snapshot) => snapshot.offsetMinutes).join(",");
  if (offsets !== "-15,-10,-5,0") {
    throw sourceInconsistency("The V3 price snapshot offsets are inconsistent.");
  }
  const anchor = snapshots.find((snapshot) => snapshot.offsetMinutes === 0);
  const negative5 = snapshots.find((snapshot) => snapshot.offsetMinutes === -5);
  const negative15 = snapshots.find((snapshot) => snapshot.offsetMinutes === -15);
  if (!anchor || !negative5 || !negative15 || !anchor.liquidityUsd) {
    throw sourceInconsistency("The V3 snapshot sequence is incomplete.");
  }
  for (const snapshot of snapshots) {
    const scheduled = new Date(snapshot.scheduledAt);
    if (
      scheduled.valueOf() !==
      new Date(unit.anchorAt).valueOf() + snapshot.offsetMinutes * 60 * 1000
    ) {
      throw sourceInconsistency("A V3 snapshot has an inconsistent scheduled time.");
    }
    assertMarketFact(snapshot.priceUsd, scheduled, "positive");
    if (snapshot.offsetMinutes !== 0 && snapshot.liquidityUsd !== undefined) {
      throw sourceInconsistency("A V3 non-anchor snapshot contains an unexpected liquidity fact.");
    }
  }
  assertMarketFact(anchor.liquidityUsd, new Date(anchor.scheduledAt), "nonnegative");
  if (stableJson(anchor.liquidityUsd) !== stableJson(unit.decisionTime.market.liquidityUsd)) {
    throw sourceInconsistency("The V3 anchor liquidity fact is inconsistent with the snapshot.");
  }
  assertMomentumFact(unit.decisionTime.market.momentum5mPct, anchor.priceUsd, negative5.priceUsd);
  assertMomentumFact(unit.decisionTime.market.momentum15mPct, anchor.priceUsd, negative15.priceUsd);
  return {
    LIQUIDITY: projectFact(unit.decisionTime.market.liquidityUsd),
    MOMENTUM_5M: projectFact(unit.decisionTime.market.momentum5mPct),
    MOMENTUM_15M: projectFact(unit.decisionTime.market.momentum15mPct),
  };
}

function assertMarketFact(
  fact: RawFact,
  scheduledAt: Date,
  valueRequirement: "positive" | "nonnegative",
): void {
  if (fact.sourceCategory !== "MARKET_CONTEXT" || fact.sourceIdentifier !== "BEST_PAIR") {
    throw sourceInconsistency("A V3 market fact has unexpected provenance.");
  }
  assertValueShape(fact, valueRequirement);
  if (
    fact.availability === "AVAILABLE_AT_ANCHOR" &&
    (!fact.sourceTimestamp ||
      Math.abs(new Date(fact.sourceTimestamp).valueOf() - scheduledAt.valueOf()) > 60_000)
  ) {
    throw sourceInconsistency("A V3 available market fact is stale or lacks a source timestamp.");
  }
}

function assertMomentumFact(anchor: RawFact, current: RawFact, prior: RawFact): void {
  const expectedValue = ((current.value as number) / (prior.value as number) - 1) * 100;
  const expectedAvailability =
    current.availability !== "AVAILABLE_AT_ANCHOR"
      ? current.availability
      : prior.availability !== "AVAILABLE_AT_ANCHOR"
        ? prior.availability
        : Number.isFinite(expectedValue)
          ? "AVAILABLE_AT_ANCHOR"
          : "INVALID_VALUE";
  if (anchor.availability !== expectedAvailability) {
    throw sourceInconsistency("A V3 momentum fact does not match its fixed snapshot inputs.");
  }
  if (anchor.availability !== "AVAILABLE_AT_ANCHOR") {
    if (
      anchor.sourceCategory !== "MARKET_CONTEXT" ||
      anchor.sourceIdentifier !== "BEST_PAIR" ||
      anchor.value !== undefined ||
      anchor.sourceTimestamp !==
        (current.availability !== "AVAILABLE_AT_ANCHOR"
          ? current.sourceTimestamp
          : prior.availability !== "AVAILABLE_AT_ANCHOR"
            ? prior.sourceTimestamp
            : undefined)
    ) {
      throw sourceInconsistency(
        "A V3 unavailable momentum fact has inconsistent provenance or value.",
      );
    }
    return;
  }
  if (
    anchor.sourceCategory !== "LOCAL" ||
    anchor.sourceIdentifier !== "FORMULA" ||
    anchor.sourceTimestamp !== undefined ||
    !finite(anchor.value)
  ) {
    throw sourceInconsistency("A V3 available momentum fact has inconsistent formula evidence.");
  }
  if (Math.abs((anchor.value as number) - expectedValue) > 1e-12) {
    throw sourceInconsistency("A V3 momentum formula result is inconsistent with snapshots.");
  }
}

function assertValueShape(fact: RawFact, requirement: "positive" | "nonnegative"): void {
  if (fact.availability === "AVAILABLE_AT_ANCHOR") {
    if (
      !finite(fact.value) ||
      (requirement === "positive" && (fact.value as number) <= 0) ||
      (requirement === "nonnegative" && (fact.value as number) < 0)
    ) {
      throw sourceInconsistency("A V3 available fact has an invalid value.");
    }
    return;
  }
  if (fact.value !== undefined) {
    throw sourceInconsistency("A V3 unavailable fact retains a prohibited value.");
  }
}

function projectFact(fact: RawFact): MeasurementCohortAnalysisFact {
  return {
    availability: fact.availability,
    sourceCategory: fact.sourceCategory,
    sourceIdentifier: fact.sourceIdentifier,
  };
}

function projectSources(sources: readonly RawSource[]): readonly MeasurementCohortAnalysisSource[] {
  return sources.map((source) => {
    const sanitized = {
      category: source.category,
      capability: source.capability,
      outcomeCode: source.outcomeCode,
      observedAt: source.observedAt,
      latencyBucket: source.latencyBucket,
    };
    if (sha256(JSON.stringify(sanitized)) !== source.sourceHash) {
      throw sourceInconsistency("A V3 source inventory hash is inconsistent.");
    }
    if (
      (source.category === "DISCOVERY") !== (source.capability === "DISCOVER_TOKENS") ||
      (source.category === "MARKET_CONTEXT") !== (source.capability === "BEST_PAIR")
    ) {
      throw sourceInconsistency("A V3 source inventory category/capability pair is inconsistent.");
    }
    return {
      utcDate: new Date(source.observedAt).toISOString().slice(0, 10),
      category: source.category,
      capability: source.capability,
      outcomeCode: source.outcomeCode,
      latencyBucket: source.latencyBucket,
    };
  });
}

function containsUnsafeOrLabelShapedContent(value: unknown): boolean {
  if (typeof value === "string") {
    return /\b(?:api[ _-]?key|private[ _-]?key|bearer|password)\b|https?:\/\//i.test(value);
  }
  if (Array.isArray(value)) return value.some(containsUnsafeOrLabelShapedContent);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => labelShapedKeys.has(key) || containsUnsafeOrLabelShapedContent(entry),
  );
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw sourceInconsistency("A V3 final archive JSON artifact cannot be parsed.");
  }
}

function parseNdjson(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  if (text.trim() === "") return [];
  try {
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    throw sourceInconsistency("The V3 final unit ledger cannot be parsed.");
  }
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw sourceInconsistency("A V3 final archive artifact violates its schema.");
  return parsed.data;
}

function parseArrayWith<T>(schema: z.ZodType<T>, value: unknown): readonly T[] {
  if (!Array.isArray(value))
    throw sourceInconsistency("A V3 final archive ledger is not an array.");
  return value.map((entry) => parseWith(schema, entry));
}

function partitionFor(mint: string, slotId: string): "DISCOVERY" | "VALIDATION" {
  return Number.parseInt(
    sha256(`phase10.6a-exploratory-cohort.v3|${mint}|${slotId}`).at(-1) ?? "0",
    16,
  ) %
    2 ===
    0
    ? "DISCOVERY"
    : "VALIDATION";
}

function isCanonicalMint(mint: string): boolean {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const character of mint) value = value * 58n + BigInt(alphabet.indexOf(character));
  const leadingZeroBytes = mint.length - mint.replace(/^1+/, "").length;
  const bytes = value === 0n ? 0 : Math.ceil(value.toString(16).length / 2);
  return leadingZeroBytes + bytes === 32;
}

function finite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

function archiveNotFinal(message: string): MeasurementCohortAnalysisError {
  return new MeasurementCohortAnalysisError(
    "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL",
    message,
  );
}

function sourceInconsistency(message: string): MeasurementCohortAnalysisError {
  return new MeasurementCohortAnalysisError(
    "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
    message,
  );
}

function labelViolation(message: string): MeasurementCohortAnalysisError {
  return new MeasurementCohortAnalysisError(
    "MEASUREMENT_COHORT_ANALYSIS_LABEL_QUARANTINE_VIOLATION",
    message,
  );
}
