import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ExploratoryMeasurementAuditError } from "./ExploratoryMeasurementAuditErrors.js";
import {
  EXPLORATORY_MEASUREMENT_AUDIT_APPROVED_IDENTITY,
  EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT,
  EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_PATH,
  EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_SHA256,
  measurementAuditArtifactNames,
  type ExploratoryMeasurementAuditIdentity,
} from "./ExploratoryMeasurementAuditIdentity.js";
import {
  auditFieldDefinitions,
  availabilitySchema,
  type LoadedMeasurementAuditArchive,
  type MeasurementAuditArtifactName,
  type MeasurementAuditFact,
  type MeasurementAuditField,
  type MeasurementAuditSource,
  type MeasurementAuditUnit,
  type MeasurementPartition,
} from "./ExploratoryMeasurementAuditTypes.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoSchema = z.string().datetime();
const finalOutcomeSchema = z.enum([
  "COHORT_COMPLETE",
  "COHORT_INCOMPLETE",
  "COHORT_STOPPED_DATA_QUALITY",
  "HUMAN_REVIEW_REQUIRED",
]);
const providerCategorySchema = z.enum([
  "DISCOVERY",
  "MARKET_CONTEXT",
  "QUOTE_IMPACT",
  "LATER_OBSERVATION",
]);
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
    QUOTE_IMPACT: z.number().int().nonnegative(),
    LATER_OBSERVATION: z.number().int().nonnegative(),
  })
  .strict();
const factBaseSchema = z
  .object({
    availability: availabilitySchema,
    sourceCategory: z.union([
      z.literal("MARKET_CONTEXT"),
      z.literal("QUOTE_IMPACT"),
      z.literal("DISCOVERY"),
      z.literal("LOCAL"),
    ]),
    sourceIdentifier: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Z0-9_:-]+$/),
    sourceTimestamp: isoSchema.optional(),
  })
  .strict();
const numericFactSchema = factBaseSchema.extend({ value: z.number().finite().optional() }).strict();
const booleanFactSchema = factBaseSchema.extend({ value: z.boolean().optional() }).strict();
const stringFactSchema = factBaseSchema
  .extend({ value: z.string().min(1).max(80).optional() })
  .strict();
const stringArrayFactSchema = factBaseSchema
  .extend({ value: z.array(z.string().min(1).max(80)).optional() })
  .strict();
const projectedUnitSchema = z
  .object({
    unitId: z.string().min(1).max(128),
    canonicalMint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    anchorAt: isoSchema,
    slotId: z.string().regex(/^SLOT_\d{3}$/),
    partition: z.enum(["DISCOVERY", "VALIDATION"]),
    decisionTime: z
      .object({
        discovery: stringFactSchema,
        market: z
          .object({
            assetAgeSeconds: numericFactSchema,
            priceUsd: numericFactSchema,
            liquidityUsd: numericFactSchema,
            volume5mUsd: numericFactSchema,
            volume1hUsd: numericFactSchema,
            momentum5mPct: numericFactSchema,
            momentum15mPct: numericFactSchema,
          })
          .strict(),
        quote: z
          .object({ available: booleanFactSchema, priceImpactBps: numericFactSchema })
          .strict(),
        risk: z.object({ blockerCodes: stringArrayFactSchema }).strict(),
        attention: z.object({ repeatedAttentionCount: numericFactSchema }).strict(),
      })
      .strict(),
  })
  .strict();
const sourceSchema = z
  .object({
    category: providerCategorySchema,
    provider: z.enum(["DEXSCREENER", "JUPITER"]),
    capability: z.string().regex(/^[A-Z0-9_]{1,80}$/),
    requestCount: z.literal(1),
    attemptCount: z.literal(1),
    outcomeCode: z.string().regex(/^[A-Z0-9_]{1,80}$/),
    observedAt: isoSchema,
    latencyBucket: z.enum(["LT_100MS", "LT_1S", "GE_1S"]),
    sourceHash: sha256Schema,
  })
  .strict();
const launchSchema = z
  .object({
    contractVersion: z.literal("1"),
    archiveRoot: z.literal(EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT),
    cohortStartAt: z.literal("2026-08-21T00:00:00.000Z"),
    protocolPath: z.literal(EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_PATH),
    protocolSha256: z.literal(EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_SHA256),
    protocolValidationFingerprint: sha256Schema,
    authorization: z.literal("USER_AUTHORIZED_FOR_ONE_OBSERVATIONAL_COLLECTION"),
    authorizationReference: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  })
  .strict();
const slotSchema = z
  .object({
    slotId: z.string().regex(/^SLOT_\d{3}$/),
    slotIndex: z.number().int().min(0).max(167),
    anchorAt: isoSchema,
    state: z.enum(["NO_SELECTION", "SKIP_UNIT_WITH_REASON", "VALID_UNIT", "PAUSE_WINDOW"]),
    reason: z.string().regex(/^[A-Z0-9_]{1,100}$/),
    discoveryCounts: z
      .object({
        returned: z.number().int().nonnegative(),
        canonical: z.number().int().nonnegative(),
        technicallyValid: z.number().int().nonnegative(),
      })
      .strict(),
    selectedMint: z
      .string()
      .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      .optional(),
  })
  .strict();
const manifestSchema = z
  .object({
    contractVersion: z.literal("1"),
    archiveRoot: z.literal(EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT),
    launch: launchSchema,
    executionDisabled: z.literal(true),
    safety: safetySchema,
    outcome: z.union([finalOutcomeSchema, z.literal("COLLECTING")]),
    slots: z.array(slotSchema),
    providerCounts: providerCountsSchema,
    finalFileHashes: z
      .object({
        "units.v1.ndjson": sha256Schema,
        "source-inventory.v1.json": sha256Schema,
        "collection-summary.v1.json": sha256Schema,
      })
      .strict(),
    interruptionReason: z
      .string()
      .regex(/^[A-Z0-9_]{1,100}$/)
      .optional(),
  })
  .strict();
const summarySchema = z
  .object({
    contractVersion: z.literal("1"),
    outcome: finalOutcomeSchema,
    validUnitCount: z.number().int().nonnegative(),
    attemptedSlotCount: z.number().int().nonnegative(),
    partitionCounts: z
      .object({
        DISCOVERY: z.number().int().nonnegative(),
        VALIDATION: z.number().int().nonnegative(),
      })
      .strict(),
    utcDateCounts: z.record(
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      z.number().int().nonnegative(),
    ),
    concentration: z
      .object({
        distinctMintCount: z.number().int().nonnegative(),
        maximumUtcDateSharePct: z.number().finite().nonnegative(),
      })
      .strict(),
    providerCounts: providerCountsSchema,
    providerBudgetUse: z.record(
      providerCategorySchema,
      z
        .object({ cap: z.number().int().nonnegative(), used: z.number().int().nonnegative() })
        .strict(),
    ),
    safetyCounters: safetySchema,
    executionDisabled: z.literal(true),
    nextPermittedAction: z.string().min(1).max(240),
    nonAuthorizingOutcome: z.string().min(1).max(240),
  })
  .strict();

type ParsedManifest = z.infer<typeof manifestSchema>;
type ParsedSummary = z.infer<typeof summarySchema>;
type ParsedUnit = z.infer<typeof projectedUnitSchema>;
type ParsedSource = z.infer<typeof sourceSchema>;

export class ExploratoryMeasurementAuditLoader {
  constructor(
    private readonly options: {
      readonly expectedIdentity?: ExploratoryMeasurementAuditIdentity;
    } = {},
  ) {}

  load(archiveRoot: string, repoRoot: string): LoadedMeasurementAuditArchive {
    assertDirectArchiveRoot(archiveRoot, repoRoot);
    if (existsSync(path.join(archiveRoot, "collection.lock"))) {
      throw inconsistency("The archive contains an active collection lock.");
    }
    assertOnlyFinalArtifacts(archiveRoot);
    const raw = Object.fromEntries(
      measurementAuditArtifactNames.map((name) => [name, readSafeFile(archiveRoot, name)]),
    ) as Record<MeasurementAuditArtifactName, string>;
    const manifest = parseJson(
      raw["cohort-manifest.v1.json"],
      manifestSchema,
      "cohort-manifest.v1.json",
    );
    const summaryProjection = discardOpaqueTopLevelProperty(raw["collection-summary.v1.json"]);
    const summary = parseJson(summaryProjection, summarySchema, "collection-summary.v1.json");
    const sources = parseJson(
      raw["source-inventory.v1.json"],
      z.array(sourceSchema),
      "source-inventory.v1.json",
    );
    const units = parseUnits(raw["units.v1.ndjson"]);

    assertSafeArchiveText(manifest, summary, sources, units);
    assertFinalityAndHashes(manifest, raw);
    assertProtocol(
      manifest,
      repoRoot,
      this.options.expectedIdentity ?? EXPLORATORY_MEASUREMENT_AUDIT_APPROVED_IDENTITY,
    );
    assertSourceInventory(sources, manifest.providerCounts);
    assertManifestSlots(manifest, units);
    const projectedUnits = units.map(projectUnit);
    assertSummaryConsistency(manifest, summary, units, sources);
    const inventory = archiveIdentity(raw);
    assertExpectedIdentity(
      inventory,
      this.options.expectedIdentity ?? EXPLORATORY_MEASUREMENT_AUDIT_APPROVED_IDENTITY,
    );

    return {
      finalOutcome: summary.outcome,
      units: projectedUnits,
      sources: sources
        .filter((source) => source.category !== "LATER_OBSERVATION")
        .map((source) => ({
          utcDate: source.observedAt.slice(0, 10),
          category: source.category,
          provider: source.provider,
          capability: source.capability,
          outcomeCode: source.outcomeCode,
          latencyBucket: source.latencyBucket,
        })) as MeasurementAuditSource[],
      inventory,
    };
  }
}

function assertDirectArchiveRoot(archiveRoot: string, repoRoot: string): void {
  const requestedRoot = path.resolve(archiveRoot);
  let resolvedRepo: string;
  try {
    resolvedRepo = realpathSync(repoRoot);
  } catch {
    throw unsupported("The repository root is unavailable.");
  }
  if (
    !existsSync(requestedRoot) ||
    !lstatSync(requestedRoot).isDirectory() ||
    lstatSync(requestedRoot).isSymbolicLink()
  ) {
    throw unsupported("The archive root is not a direct repository-contained directory.");
  }
  const relative = path.relative(resolvedRepo, realpathSync(requestedRoot));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unsupported("The archive root is not repository-contained.");
  }
}

function assertOnlyFinalArtifacts(archiveRoot: string): void {
  let names: readonly string[];
  try {
    names = readdirSync(archiveRoot);
  } catch {
    throw unsupported("The archive root cannot be listed safely.");
  }
  if (
    JSON.stringify([...names].sort()) !== JSON.stringify([...measurementAuditArtifactNames].sort())
  ) {
    throw inconsistency("The final archive contains an unexpected or missing artifact.");
  }
}

function readSafeFile(archiveRoot: string, name: MeasurementAuditArtifactName): string {
  const target = path.join(archiveRoot, name);
  if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
    throw unsupported("A required archive artifact is unavailable.");
  }
  try {
    return readFileSync(target, "utf8");
  } catch {
    throw unsupported("A required archive artifact cannot be read.");
  }
}

function parseJson<T>(raw: string, schema: z.ZodType<T>, artifact: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw inconsistency(`${artifact} is not valid structured JSON.`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw inconsistency(`${artifact} does not match the fixed V2 contract.`);
  return parsed.data;
}

function parseUnits(raw: string): ParsedUnit[] {
  if (!raw.endsWith("\n")) throw inconsistency("The unit artifact is not newline-delimited JSON.");
  const lines = raw.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw inconsistency("The unit artifact contains an empty record.");
  }
  return lines.map((line) =>
    parseJson(discardOpaqueTopLevelProperty(line), projectedUnitSchema, "units.v1.ndjson"),
  );
}

/**
 * This deliberately removes the one prohibited top-level container by lexical scanning. Its value is
 * never decoded, schema-validated, iterated, counted, or retained; only its top-level presence is
 * established before the remaining decision-time object is parsed.
 */
function discardOpaqueTopLevelProperty(raw: string): string {
  let index = skipWhitespace(raw, 0);
  if (raw[index] !== "{") throw inconsistency("A protected archive object is not an object.");
  index += 1;
  const retained: string[] = [];
  let found = false;
  for (;;) {
    index = skipWhitespace(raw, index);
    if (raw[index] === "}") {
      index += 1;
      break;
    }
    const keyStart = index;
    const keyEnd = skipJsonString(raw, keyStart);
    const keyRaw = raw.slice(keyStart, keyEnd);
    let key: unknown;
    try {
      key = JSON.parse(keyRaw) as unknown;
    } catch {
      throw inconsistency("A protected archive object has an invalid property name.");
    }
    if (typeof key !== "string")
      throw inconsistency("A protected archive object has an unsafe property name.");
    index = skipWhitespace(raw, keyEnd);
    if (raw[index] !== ":")
      throw inconsistency("A protected archive object is structurally invalid.");
    index = skipWhitespace(raw, index + 1);
    const valueStart = index;
    const valueEnd = skipJsonValue(raw, valueStart);
    if (key === "laterObservations") {
      if (found)
        throw inconsistency("A protected archive object repeats the opaque label container.");
      found = true;
    } else {
      retained.push(raw.slice(keyStart, valueEnd));
    }
    index = skipWhitespace(raw, valueEnd);
    if (raw[index] === ",") {
      index += 1;
      continue;
    }
    if (raw[index] === "}") {
      index += 1;
      break;
    }
    throw inconsistency("A protected archive object is structurally invalid.");
  }
  if (skipWhitespace(raw, index) !== raw.length)
    throw inconsistency("A protected archive object has trailing content.");
  if (!found) throw inconsistency("A protected archive object lacks its opaque label container.");
  return `{${retained.join(",")}}`;
}

function skipWhitespace(value: string, index: number): number {
  while (index < value.length && /\s/.test(value[index] ?? "")) index += 1;
  return index;
}

function skipJsonString(value: string, start: number): number {
  if (value[start] !== '"')
    throw inconsistency("A protected archive object has an invalid string token.");
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') return index + 1;
  }
  throw inconsistency("A protected archive object has an unterminated string token.");
}

function skipJsonValue(value: string, start: number): number {
  const first = value[start];
  if (first === '"') return skipJsonString(value, start);
  if (first !== "{" && first !== "[") {
    let index = start;
    while (index < value.length && !",}]".includes(value[index] ?? "")) index += 1;
    if (index === start)
      throw inconsistency("A protected archive object has an invalid scalar token.");
    return index;
  }
  const stack: string[] = [first === "{" ? "}" : "]"];
  let index = start + 1;
  while (index < value.length && stack.length > 0) {
    const char = value[index];
    if (char === '"') {
      index = skipJsonString(value, index);
      continue;
    }
    if (char === "{") stack.push("}");
    if (char === "[") stack.push("]");
    if (char === "}" || char === "]") {
      const expected = stack.pop();
      if (char !== expected)
        throw inconsistency("A protected archive object has mismatched brackets.");
    }
    index += 1;
  }
  if (stack.length !== 0)
    throw inconsistency("A protected archive object has an unclosed opaque container.");
  return index;
}

function assertFinalityAndHashes(
  manifest: ParsedManifest,
  raw: Record<MeasurementAuditArtifactName, string>,
): void {
  if (!finalOutcomeSchema.safeParse(manifest.outcome).success) {
    throw inconsistency("The archive has not reached a final V2 outcome.");
  }
  for (const name of [
    "units.v1.ndjson",
    "source-inventory.v1.json",
    "collection-summary.v1.json",
  ] as const) {
    if (manifest.finalFileHashes[name] !== sha256(raw[name])) {
      throw inconsistency("A final archive hash does not match its manifest.");
    }
  }
}

function assertProtocol(
  manifest: ParsedManifest,
  repoRoot: string,
  identity: ExploratoryMeasurementAuditIdentity,
): void {
  const protocolPath = path.join(
    repoRoot,
    ...EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_PATH.split("/"),
  );
  let protocol: Buffer;
  try {
    protocol = readFileSync(protocolPath);
  } catch {
    throw inconsistency("The pinned V2 protocol source is unavailable.");
  }
  if (
    sha256(protocol) !== identity.protocolSha256 ||
    identity.protocolSha256 !== EXPLORATORY_MEASUREMENT_AUDIT_PROTOCOL_SHA256
  ) {
    throw inconsistency("The pinned V2 protocol source hash is inconsistent.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(protocol.toString("utf8")) as unknown;
  } catch {
    throw inconsistency("The pinned V2 protocol source is not structured JSON.");
  }
  if (!isV2Protocol(parsed) || manifest.launch.protocolSha256 !== identity.protocolSha256) {
    throw inconsistency("The archive launch record does not pin the approved V2 protocol.");
  }
}

function isV2Protocol(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.contractVersion === "2" && candidate.protocolId === "EXPLORATORY_COHORT@v2";
}

function assertSourceInventory(
  sources: readonly ParsedSource[],
  providerCounts: z.infer<typeof providerCountsSchema>,
): void {
  const allowed = {
    DISCOVERY: { provider: "DEXSCREENER", capability: "TOKEN_DISCOVERY" },
    MARKET_CONTEXT: { provider: "DEXSCREENER", capability: "BEST_PAIR" },
    QUOTE_IMPACT: { provider: "JUPITER", capability: "QUOTE_IMPACT" },
    LATER_OBSERVATION: { provider: "DEXSCREENER", capability: "BEST_PAIR_LATER_LABEL" },
  } as const;
  const observed = { DISCOVERY: 0, MARKET_CONTEXT: 0, QUOTE_IMPACT: 0, LATER_OBSERVATION: 0 };
  for (const source of sources) {
    const expected = allowed[source.category];
    if (source.provider !== expected.provider || source.capability !== expected.capability) {
      throw inconsistency("The source inventory contains an unsupported provider capability.");
    }
    const { sourceHash, ...sanitized } = source;
    const preimage = {
      attemptCount: sanitized.attemptCount,
      capability: sanitized.capability,
      category: sanitized.category,
      latencyBucket: sanitized.latencyBucket,
      observedAt: sanitized.observedAt,
      outcomeCode: sanitized.outcomeCode,
      provider: sanitized.provider,
      requestCount: sanitized.requestCount,
    };
    if (sourceHash !== sha256(JSON.stringify(preimage))) {
      throw inconsistency("A source inventory provenance hash is inconsistent.");
    }
    observed[source.category] += 1;
  }
  for (const category of providerCategorySchema.options) {
    if (observed[category] !== providerCounts[category]) {
      throw inconsistency("Source inventory request counts do not match the manifest.");
    }
  }
}

function assertManifestSlots(manifest: ParsedManifest, units: readonly ParsedUnit[]): void {
  const slots = new Map<string, ParsedManifest["slots"][number]>();
  const indexes = new Set<number>();
  for (const slot of manifest.slots) {
    if (slots.has(slot.slotId) || indexes.has(slot.slotIndex)) {
      throw inconsistency("The manifest contains duplicate slots.");
    }
    slots.set(slot.slotId, slot);
    indexes.add(slot.slotIndex);
  }
  const unitIds = new Set<string>();
  const mints = new Set<string>();
  for (const unit of units) {
    if (
      unitIds.has(unit.unitId) ||
      mints.has(unit.canonicalMint) ||
      unit.unitId !== `${unit.slotId}:${unit.canonicalMint}`
    ) {
      throw inconsistency("The unit identity is inconsistent.");
    }
    unitIds.add(unit.unitId);
    mints.add(unit.canonicalMint);
    const slot = slots.get(unit.slotId);
    if (
      !slot ||
      slot.state !== "VALID_UNIT" ||
      slot.anchorAt !== unit.anchorAt ||
      slot.selectedMint !== unit.canonicalMint
    ) {
      throw inconsistency("A unit does not match its declared valid slot.");
    }
    if (partitionFor(unit.canonicalMint, unit.slotId) !== unit.partition) {
      throw inconsistency("A unit partition does not match the frozen V2 assignment.");
    }
  }
}

function projectUnit(unit: ParsedUnit): MeasurementAuditUnit {
  const sourceFacts: Record<
    MeasurementAuditField,
    z.infer<typeof numericFactSchema> | z.infer<typeof booleanFactSchema>
  > = {
    ASSET_AGE: unit.decisionTime.market.assetAgeSeconds,
    ANCHOR_PRICE: unit.decisionTime.market.priceUsd,
    LIQUIDITY: unit.decisionTime.market.liquidityUsd,
    VOLUME_5M: unit.decisionTime.market.volume5mUsd,
    VOLUME_1H: unit.decisionTime.market.volume1hUsd,
    MOMENTUM_5M: unit.decisionTime.market.momentum5mPct,
    MOMENTUM_15M: unit.decisionTime.market.momentum15mPct,
    QUOTE_AVAILABLE: unit.decisionTime.quote.available,
    QUOTE_IMPACT: unit.decisionTime.quote.priceImpactBps,
  };
  const facts = Object.fromEntries(
    auditFieldDefinitions.map((definition) => [
      definition.id,
      projectFact(sourceFacts[definition.id], definition, unit.anchorAt),
    ]),
  ) as Record<MeasurementAuditField, MeasurementAuditFact>;
  return { partition: unit.partition, anchorDate: unit.anchorAt.slice(0, 10), facts };
}

function projectFact(
  fact: z.infer<typeof numericFactSchema> | z.infer<typeof booleanFactSchema>,
  definition: (typeof auditFieldDefinitions)[number],
  anchorAt: string,
): MeasurementAuditFact {
  if (
    fact.sourceCategory !== definition.sourceCategory ||
    fact.sourceIdentifier !== definition.sourceIdentifier
  ) {
    throw inconsistency("A decision-time fact has unsupported provenance.");
  }
  if (fact.availability === "AVAILABLE_AT_ANCHOR") {
    if (typeof fact.value !== "number" && typeof fact.value !== "boolean") {
      throw inconsistency("An available decision-time fact lacks a finite value.");
    }
    if (
      !fact.sourceTimestamp ||
      !isFresh(fact.sourceTimestamp, anchorAt, definition.freshnessSeconds)
    ) {
      throw inconsistency("An available decision-time fact is stale.");
    }
  } else if (fact.value !== undefined) {
    throw inconsistency("An unavailable decision-time fact retains a value.");
  }
  return {
    availability: fact.availability,
    sourceCategory: definition.sourceCategory,
    sourceIdentifier: definition.sourceIdentifier,
  };
}

function isFresh(sourceTimestamp: string, anchorAt: string, maximumSeconds: number): boolean {
  const difference = Math.abs(Date.parse(sourceTimestamp) - Date.parse(anchorAt));
  return Number.isFinite(difference) && difference <= maximumSeconds * 1_000;
}

function assertSummaryConsistency(
  manifest: ParsedManifest,
  summary: ParsedSummary,
  units: readonly ParsedUnit[],
  sources: readonly ParsedSource[],
): void {
  if (
    manifest.outcome !== summary.outcome ||
    summary.validUnitCount !== units.length ||
    summary.attemptedSlotCount !== manifest.slots.length
  ) {
    throw inconsistency("The summary is inconsistent with the final archive.");
  }
  const partitions = countBy(units.map((unit) => unit.partition));
  if (
    summary.partitionCounts.DISCOVERY !== (partitions.DISCOVERY ?? 0) ||
    summary.partitionCounts.VALIDATION !== (partitions.VALIDATION ?? 0)
  ) {
    throw inconsistency("The summary partition counts are inconsistent.");
  }
  const dates = countBy(units.map((unit) => unit.anchorAt.slice(0, 10)));
  if (JSON.stringify(sortValue(summary.utcDateCounts)) !== JSON.stringify(sortValue(dates))) {
    throw inconsistency("The summary date counts are inconsistent.");
  }
  const sourceCounts = countBy(sources.map((source) => source.category));
  for (const category of providerCategorySchema.options) {
    if (
      manifest.providerCounts[category] !== summary.providerCounts[category] ||
      summary.providerCounts[category] !== (sourceCounts[category] ?? 0)
    ) {
      throw inconsistency("The provider counts are inconsistent.");
    }
    if (summary.providerBudgetUse[category]?.used !== summary.providerCounts[category]) {
      throw inconsistency("The provider budget use is inconsistent.");
    }
  }
}

function assertSafeArchiveText(
  manifest: ParsedManifest,
  summary: ParsedSummary,
  sources: readonly ParsedSource[],
  units: readonly ParsedUnit[],
): void {
  const safeText = JSON.stringify({ manifest, summary, sources, units });
  if (
    /(?:api[_-]?key|authorization|bearer|private[_-]?key|password|secret)\s*[:=]/i.test(safeText) ||
    /https?:\/\//i.test(safeText)
  ) {
    throw inconsistency("The decision-time archive projection contains unsafe text.");
  }
}

function archiveIdentity(
  raw: Record<MeasurementAuditArtifactName, string>,
): Record<MeasurementAuditArtifactName, string> {
  return Object.fromEntries(
    measurementAuditArtifactNames.map((name) => [name, sha256(raw[name])]),
  ) as Record<MeasurementAuditArtifactName, string>;
}

function assertExpectedIdentity(
  actual: Record<MeasurementAuditArtifactName, string>,
  expected: ExploratoryMeasurementAuditIdentity,
): void {
  for (const name of measurementAuditArtifactNames) {
    if (actual[name] !== expected.artifacts[name]) {
      throw inconsistency("The approved archive identity does not match.");
    }
  }
}

function partitionFor(mint: string, slotId: string): MeasurementPartition {
  const hash = sha256(`phase10.6a-exploratory-cohort.v2|${mint}|${slotId}`);
  return Number.parseInt(hash.at(-1) ?? "0", 16) % 2 === 0 ? "DISCOVERY" : "VALIDATION";
}

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function inconsistency(message: string): ExploratoryMeasurementAuditError {
  return new ExploratoryMeasurementAuditError(
    "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY",
    message,
  );
}

function unsupported(message: string): ExploratoryMeasurementAuditError {
  return new ExploratoryMeasurementAuditError(
    "EXPLORATORY_MEASUREMENT_AUDIT_UNSUPPORTED_ARCHIVE",
    message,
  );
}
