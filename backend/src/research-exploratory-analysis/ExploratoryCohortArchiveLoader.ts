import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import {
  EXPLORATORY_PROTOCOL_V2_PATH,
  EXPLORATORY_PROTOCOL_V2_SHA256,
} from "../research-protocol/ResearchProtocolConstants.js";
import {
  assertApprovedProtocolSha256,
  parseExploratoryCohortProtocol,
} from "../research-protocol/ResearchProtocolService.js";
import { ExploratoryCohortAnalysisError } from "./ExploratoryCohortAnalysisErrors.js";
import {
  EXPLORATORY_COHORT_ANALYSIS_APPROVED_ARCHIVE_IDENTITY,
  exploratoryCohortAnalysisArtifactNames,
  type ExploratoryCohortAnalysisArchiveIdentity,
} from "./ExploratoryCohortAnalysisIdentity.js";

const finalArtifactNames = exploratoryCohortAnalysisArtifactNames;

const providerCategorySchema = z.enum([
  "DISCOVERY",
  "MARKET_CONTEXT",
  "QUOTE_IMPACT",
  "LATER_OBSERVATION",
]);
const availabilitySchema = z.enum([
  "AVAILABLE_AT_ANCHOR",
  "NOT_REQUESTED",
  "UNAVAILABLE_AT_ANCHOR",
  "STALE_AT_ANCHOR",
  "BUDGET_EXHAUSTED",
  "PROVIDER_ERROR",
  "UNSUPPORTED",
  "INVALID_VALUE",
]);
const laterAvailabilitySchema = z.enum(["OBSERVED_ON_TIME", "OBSERVED_LATE", "MISSING", "INVALID"]);
const finalOutcomeSchema = z.enum([
  "COHORT_COMPLETE",
  "COHORT_INCOMPLETE",
  "COHORT_STOPPED_DATA_QUALITY",
  "HUMAN_REVIEW_REQUIRED",
]);
const manifestOutcomeSchema = z.enum([
  "COHORT_COMPLETE",
  "COHORT_INCOMPLETE",
  "COHORT_STOPPED_DATA_QUALITY",
  "HUMAN_REVIEW_REQUIRED",
  "COLLECTING",
]);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoSchema = z.string().datetime();

const numericFactSchema = z
  .object({
    value: z.number().finite().optional(),
    availability: availabilitySchema,
    sourceCategory: z.union([providerCategorySchema, z.literal("LOCAL")]),
    sourceIdentifier: z.string().min(1).max(80),
    sourceTimestamp: isoSchema.optional(),
  })
  .strict();
const stringFactSchema = z
  .object({
    value: z.string().min(1).max(80).optional(),
    availability: availabilitySchema,
    sourceCategory: z.union([providerCategorySchema, z.literal("LOCAL")]),
    sourceIdentifier: z.string().min(1).max(80),
    sourceTimestamp: isoSchema.optional(),
  })
  .strict();
const booleanFactSchema = z
  .object({
    value: z.boolean().optional(),
    availability: availabilitySchema,
    sourceCategory: z.union([providerCategorySchema, z.literal("LOCAL")]),
    sourceIdentifier: z.string().min(1).max(80),
    sourceTimestamp: isoSchema.optional(),
  })
  .strict();
const stringArrayFactSchema = z
  .object({
    value: z.array(z.string().min(1).max(80)).optional(),
    availability: availabilitySchema,
    sourceCategory: z.union([providerCategorySchema, z.literal("LOCAL")]),
    sourceIdentifier: z.string().min(1).max(80),
    sourceTimestamp: isoSchema.optional(),
  })
  .strict();

const unitSchema = z
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
    laterObservations: z
      .array(
        z
          .object({
            minutesAfterAnchor: z.union([z.literal(3), z.literal(5), z.literal(15), z.literal(60)]),
            availability: laterAvailabilitySchema,
            observedAt: isoSchema.optional(),
            returnPct: z.number().finite().optional(),
            reason: z.string().min(1).max(80),
          })
          .strict(),
      )
      .length(4),
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

const providerCountsSchema = z
  .object({
    DISCOVERY: z.number().int().nonnegative(),
    MARKET_CONTEXT: z.number().int().nonnegative(),
    QUOTE_IMPACT: z.number().int().nonnegative(),
    LATER_OBSERVATION: z.number().int().nonnegative(),
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
const launchSchema = z
  .object({
    contractVersion: z.literal("1"),
    archiveRoot: z.literal("data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z"),
    cohortStartAt: z.literal("2026-08-21T00:00:00.000Z"),
    protocolPath: z.literal(EXPLORATORY_PROTOCOL_V2_PATH),
    protocolSha256: z.literal(EXPLORATORY_PROTOCOL_V2_SHA256),
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
    archiveRoot: z.literal("data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z"),
    launch: launchSchema,
    executionDisabled: z.literal(true),
    safety: safetySchema,
    outcome: manifestOutcomeSchema,
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
    laterObservations: z
      .object({
        totalCount: z.number().int().nonnegative(),
        availabilityCounts: z.record(laterAvailabilitySchema, z.number().int().nonnegative()),
        missingOrInvalidCount: z.number().int().nonnegative(),
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

export type AnalysisUnit = z.infer<typeof unitSchema>;
export type AnalysisSource = z.infer<typeof sourceSchema>;
export type AnalysisManifest = z.infer<typeof manifestSchema>;
export type AnalysisSummary = z.infer<typeof summarySchema>;

export interface LoadedExploratoryCohortArchive {
  readonly manifest: AnalysisManifest;
  readonly units: readonly AnalysisUnit[];
  readonly sources: readonly AnalysisSource[];
  readonly summary: AnalysisSummary;
  readonly inventory: Readonly<Record<(typeof finalArtifactNames)[number], string>>;
  readonly manifestSha256: string;
  readonly launchIdentityHash: string;
}

export class ExploratoryCohortArchiveLoader {
  constructor(
    private readonly options: {
      readonly expectedIdentity?: ExploratoryCohortAnalysisArchiveIdentity;
    } = {},
  ) {}

  load(archiveRoot: string, repoRoot: string): LoadedExploratoryCohortArchive {
    assertDirectArchiveRoot(archiveRoot, repoRoot);
    if (existsSync(path.join(archiveRoot, "collection.lock"))) {
      throw notFinal("The archive contains an active collection lock.");
    }
    assertOnlyFinalArtifacts(archiveRoot);
    const raw = Object.fromEntries(
      finalArtifactNames.map((name) => [name, readSafeFile(archiveRoot, name)]),
    ) as Record<(typeof finalArtifactNames)[number], string>;
    const manifest = parseJson(
      raw["cohort-manifest.v1.json"],
      manifestSchema,
      "cohort-manifest.v1.json",
    );
    const summary = parseJson(
      raw["collection-summary.v1.json"],
      summarySchema,
      "collection-summary.v1.json",
    );
    const sources = parseJson(
      raw["source-inventory.v1.json"],
      z.array(sourceSchema),
      "source-inventory.v1.json",
    );
    const units = parseUnits(raw["units.v1.ndjson"]);
    assertSafeArchiveValue({ manifest, summary, sources, units });
    assertFinalityAndHashes(manifest, raw);
    assertCanonicalOrdering(raw, units, sources, summary, manifest);
    assertProtocol(manifest, repoRoot);
    assertSourceInventory(sources, manifest.providerCounts);
    assertManifestSlots(manifest, units);
    assertDecisionTimeFacts(units);
    assertSummaryConsistency({ manifest, units, sources, summary });
    const inventory = archiveIdentity(raw);
    assertApprovedArchiveIdentity(
      inventory,
      this.options.expectedIdentity ?? EXPLORATORY_COHORT_ANALYSIS_APPROVED_ARCHIVE_IDENTITY,
    );
    return {
      manifest,
      units,
      sources,
      summary,
      inventory,
      manifestSha256: sha256(raw["cohort-manifest.v1.json"]),
      launchIdentityHash: sha256(stableJson(manifest.launch)),
    };
  }
}

function archiveIdentity(
  raw: Record<(typeof finalArtifactNames)[number], string>,
): LoadedExploratoryCohortArchive["inventory"] {
  return Object.fromEntries(
    finalArtifactNames.map((name) => [name, sha256(raw[name])]),
  ) as LoadedExploratoryCohortArchive["inventory"];
}

function assertApprovedArchiveIdentity(
  actual: ExploratoryCohortAnalysisArchiveIdentity,
  expected: ExploratoryCohortAnalysisArchiveIdentity,
): void {
  for (const name of finalArtifactNames) {
    if (actual[name] !== expected[name]) {
      throw inconsistency(`The approved archive identity does not match ${name}.`);
    }
  }
}

function assertDirectArchiveRoot(archiveRoot: string, repoRoot: string): void {
  const requestedRoot = path.resolve(archiveRoot);
  const resolvedRepo = realpathSync(repoRoot);
  if (
    !existsSync(requestedRoot) ||
    !lstatSync(requestedRoot).isDirectory() ||
    lstatSync(requestedRoot).isSymbolicLink()
  ) {
    throw unsupported("The archive root is not a direct repository-contained directory.");
  }
  const resolvedRoot = realpathSync(requestedRoot);
  const relative = path.relative(resolvedRepo, resolvedRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unsupported("The archive root is not a direct repository-contained directory.");
  }
}

function assertOnlyFinalArtifacts(archiveRoot: string): void {
  let names: readonly string[];
  try {
    names = readdirSync(archiveRoot);
  } catch {
    throw unsupported("The archive root cannot be listed safely.");
  }
  const expected = [...finalArtifactNames].sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) {
    throw inconsistency("The final archive contains an unexpected or missing artifact.");
  }
}

function readSafeFile(archiveRoot: string, name: (typeof finalArtifactNames)[number]): string {
  const target = path.join(archiveRoot, name);
  if (!existsSync(target) || !lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) {
    throw unsupported(`Required archive artifact ${name} is unavailable.`);
  }
  try {
    return readFileSync(target, "utf8");
  } catch {
    throw unsupported(`Required archive artifact ${name} cannot be read.`);
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
  if (!parsed.success) throw inconsistency(`${artifact} does not match the V2 analysis contract.`);
  return parsed.data;
}

function parseUnits(raw: string): AnalysisUnit[] {
  if (!raw.endsWith("\n"))
    throw inconsistency("units.v1.ndjson is not canonical newline-delimited JSON.");
  const lines = raw.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => !line)) {
    throw inconsistency("units.v1.ndjson contains an invalid empty record.");
  }
  return lines.map((line) => parseJson(line, unitSchema, "units.v1.ndjson"));
}

function assertFinalityAndHashes(
  manifest: AnalysisManifest,
  raw: Record<(typeof finalArtifactNames)[number], string>,
): void {
  if (!finalOutcomeSchema.safeParse(manifest.outcome).success) {
    throw notFinal("The archive has not reached a final V2 outcome.");
  }
  for (const name of [
    "units.v1.ndjson",
    "source-inventory.v1.json",
    "collection-summary.v1.json",
  ] as const) {
    if (manifest.finalFileHashes[name] !== sha256(raw[name])) {
      throw inconsistency(`The final hash for ${name} does not match.`);
    }
  }
}

function assertCanonicalOrdering(
  raw: Record<(typeof finalArtifactNames)[number], string>,
  units: readonly AnalysisUnit[],
  sources: readonly AnalysisSource[],
  summary: AnalysisSummary,
  manifest: AnalysisManifest,
): void {
  const canonicalUnits = `${[...units]
    .sort((left, right) => left.unitId.localeCompare(right.unitId))
    .map((unit) => JSON.stringify(sortValue(unit)))
    .join("\n")}\n`;
  if (raw["units.v1.ndjson"] !== canonicalUnits) {
    throw inconsistency("units.v1.ndjson is not in canonical unit order.");
  }
  const canonicalSources = stableJson(
    [...sources].sort((left, right) =>
      `${left.category}|${left.observedAt}|${left.capability}`.localeCompare(
        `${right.category}|${right.observedAt}|${right.capability}`,
      ),
    ),
  );
  if (raw["source-inventory.v1.json"] !== canonicalSources) {
    throw inconsistency("source-inventory.v1.json is not in canonical source order.");
  }
  if (
    raw["collection-summary.v1.json"] !== stableJson(summary) ||
    raw["cohort-manifest.v1.json"] !== stableJson(manifest)
  ) {
    throw inconsistency("A final archive JSON artifact is not canonical.");
  }
}

function assertProtocol(manifest: AnalysisManifest, repoRoot: string): void {
  const protocolPath = path.join(repoRoot, ...EXPLORATORY_PROTOCOL_V2_PATH.split("/"));
  let bytes: Buffer;
  try {
    bytes = readFileSync(protocolPath);
  } catch {
    throw inconsistency("The pinned V2 protocol source is unavailable.");
  }
  if (sha256(bytes) !== EXPLORATORY_PROTOCOL_V2_SHA256) {
    throw inconsistency("The pinned V2 protocol source hash is inconsistent.");
  }
  try {
    parseExploratoryCohortProtocol(JSON.parse(bytes.toString("utf8")) as unknown);
    assertApprovedProtocolSha256(EXPLORATORY_PROTOCOL_V2_PATH, sha256(bytes));
  } catch {
    throw inconsistency("The pinned V2 protocol source is structurally inconsistent.");
  }
  if (
    manifest.launch.protocolPath !== EXPLORATORY_PROTOCOL_V2_PATH ||
    manifest.launch.protocolSha256 !== EXPLORATORY_PROTOCOL_V2_SHA256
  ) {
    throw inconsistency("The archive launch record does not pin the approved V2 protocol.");
  }
}

function assertSourceInventory(
  sources: readonly AnalysisSource[],
  providerCounts: AnalysisManifest["providerCounts"],
): void {
  const allowed: Record<
    string,
    { readonly provider: "DEXSCREENER" | "JUPITER"; readonly capability: string }
  > = {
    DISCOVERY: { provider: "DEXSCREENER", capability: "TOKEN_DISCOVERY" },
    MARKET_CONTEXT: { provider: "DEXSCREENER", capability: "BEST_PAIR" },
    QUOTE_IMPACT: { provider: "JUPITER", capability: "QUOTE_IMPACT" },
    LATER_OBSERVATION: { provider: "DEXSCREENER", capability: "BEST_PAIR_LATER_LABEL" },
  };
  const observedCounts = { DISCOVERY: 0, MARKET_CONTEXT: 0, QUOTE_IMPACT: 0, LATER_OBSERVATION: 0 };
  for (const source of sources) {
    const expected = allowed[source.category];
    if (
      !expected ||
      source.provider !== expected.provider ||
      source.capability !== expected.capability
    ) {
      throw inconsistency("The source inventory contains an unsupported provider capability.");
    }
    const { sourceHash, ...sanitized } = source;
    const canonicalPreimage = {
      attemptCount: sanitized.attemptCount,
      capability: sanitized.capability,
      category: sanitized.category,
      latencyBucket: sanitized.latencyBucket,
      observedAt: sanitized.observedAt,
      outcomeCode: sanitized.outcomeCode,
      provider: sanitized.provider,
      requestCount: sanitized.requestCount,
    };
    if (sourceHash !== sha256(JSON.stringify(canonicalPreimage))) {
      throw inconsistency("A source inventory provenance hash is inconsistent.");
    }
    observedCounts[source.category] += 1;
  }
  for (const category of providerCategorySchema.options) {
    if (observedCounts[category] !== providerCounts[category]) {
      throw inconsistency("Source inventory request counts do not match the manifest.");
    }
  }
}

function assertManifestSlots(manifest: AnalysisManifest, units: readonly AnalysisUnit[]): void {
  const slots = new Map<string, (typeof manifest.slots)[number]>();
  const slotIndexes = new Set<number>();
  for (const slot of manifest.slots) {
    if (slots.has(slot.slotId) || slotIndexes.has(slot.slotIndex)) {
      throw inconsistency("The final manifest contains a duplicate slot identity.");
    }
    slots.set(slot.slotId, slot);
    slotIndexes.add(slot.slotIndex);
  }
  const unitsBySlot = new Map<string, AnalysisUnit>();
  for (const unit of units) {
    if (unitsBySlot.has(unit.slotId)) {
      throw inconsistency("The final archive contains more than one unit for a slot.");
    }
    unitsBySlot.set(unit.slotId, unit);
    const slot = slots.get(unit.slotId);
    if (
      !slot ||
      slot.state !== "VALID_UNIT" ||
      slot.selectedMint !== unit.canonicalMint ||
      slot.anchorAt !== unit.anchorAt
    ) {
      throw inconsistency("A unit does not agree with its immutable manifest slot.");
    }
  }
  for (const slot of manifest.slots) {
    const unit = unitsBySlot.get(slot.slotId);
    if (slot.state === "VALID_UNIT") {
      if (!slot.selectedMint || !unit) {
        throw inconsistency("A valid manifest slot is missing its required unit evidence.");
      }
    } else if (unit) {
      throw inconsistency("A non-valid manifest slot contains unit evidence.");
    }
  }
}

function assertDecisionTimeFacts(units: readonly AnalysisUnit[]): void {
  for (const unit of units) {
    const decisionTime = unit.decisionTime;
    assertFact(decisionTime.discovery, "DISCOVERY", "TOKEN_PROFILE", true);
    assertNumericFact(decisionTime.market.assetAgeSeconds, "MARKET_CONTEXT", "BEST_PAIR", {
      nonNegativeInteger: true,
    });
    for (const fact of [
      decisionTime.market.priceUsd,
      decisionTime.market.liquidityUsd,
      decisionTime.market.volume5mUsd,
      decisionTime.market.volume1hUsd,
      decisionTime.market.momentum5mPct,
      decisionTime.market.momentum15mPct,
      decisionTime.quote.priceImpactBps,
    ]) {
      assertNumericFact(
        fact,
        fact === decisionTime.quote.priceImpactBps ? "QUOTE_IMPACT" : "MARKET_CONTEXT",
        fact === decisionTime.quote.priceImpactBps ? "QUOTE" : "BEST_PAIR",
      );
    }
    assertFact(decisionTime.quote.available, "QUOTE_IMPACT", "QUOTE", true);
    assertFreshness(decisionTime.market.priceUsd, unit.anchorAt, 60);
    for (const fact of [
      decisionTime.market.liquidityUsd,
      decisionTime.market.volume5mUsd,
      decisionTime.market.volume1hUsd,
      decisionTime.market.momentum5mPct,
      decisionTime.market.momentum15mPct,
    ]) {
      assertFreshness(fact, unit.anchorAt, 300);
    }
    assertFreshness(decisionTime.quote.available, unit.anchorAt, 60);
    assertFreshness(decisionTime.quote.priceImpactBps, unit.anchorAt, 60);
    if (
      decisionTime.risk.blockerCodes.availability !== "NOT_REQUESTED" ||
      decisionTime.risk.blockerCodes.sourceCategory !== "LOCAL" ||
      decisionTime.risk.blockerCodes.sourceIdentifier !== "NOT_REQUESTED" ||
      decisionTime.risk.blockerCodes.value !== undefined
    ) {
      throw inconsistency("Risk blocker evidence is not the fixed V2 descriptive record.");
    }
    assertFact(decisionTime.attention.repeatedAttentionCount, "LOCAL", "SLOT_DEDUPLICATION", false);
    if (
      decisionTime.attention.repeatedAttentionCount.availability !== "AVAILABLE_AT_ANCHOR" ||
      !Number.isInteger(decisionTime.attention.repeatedAttentionCount.value) ||
      (decisionTime.attention.repeatedAttentionCount.value ?? -1) < 0
    ) {
      throw inconsistency("Repeated-attention evidence is not the fixed V2 descriptive record.");
    }
  }
}

type AnalysisFact =
  | AnalysisUnit["decisionTime"]["discovery"]
  | AnalysisUnit["decisionTime"]["market"]["priceUsd"]
  | AnalysisUnit["decisionTime"]["quote"]["available"];

function assertFact(
  fact: AnalysisFact,
  sourceCategory: AnalysisFact["sourceCategory"],
  sourceIdentifier: string,
  requireValue: boolean,
): void {
  if (fact.sourceCategory !== sourceCategory || fact.sourceIdentifier !== sourceIdentifier) {
    throw inconsistency("A decision-time fact has unsupported V2 provenance.");
  }
  if (fact.availability === "AVAILABLE_AT_ANCHOR") {
    if (requireValue && fact.value === undefined) {
      throw inconsistency("An available decision-time fact is missing its value.");
    }
    if (sourceCategory !== "LOCAL" && !fact.sourceTimestamp) {
      throw inconsistency(
        "An available provider decision-time fact is missing its source timestamp.",
      );
    }
  } else if (fact.value !== undefined) {
    throw inconsistency("An unavailable decision-time fact contains a value.");
  }
}

function assertNumericFact(
  fact: AnalysisUnit["decisionTime"]["market"]["priceUsd"],
  sourceCategory: "MARKET_CONTEXT" | "QUOTE_IMPACT",
  sourceIdentifier: "BEST_PAIR" | "QUOTE",
  options: { readonly nonNegativeInteger?: boolean } = {},
): void {
  assertFact(fact, sourceCategory, sourceIdentifier, true);
  if (fact.availability !== "AVAILABLE_AT_ANCHOR") return;
  if (typeof fact.value !== "number" || !Number.isFinite(fact.value)) {
    throw inconsistency("An available numeric decision-time fact is not finite.");
  }
  if (options.nonNegativeInteger && (!Number.isInteger(fact.value) || fact.value < 0)) {
    throw inconsistency("Asset age is not a non-negative integer.");
  }
}

function assertFreshness(fact: AnalysisFact, anchorAt: string, maximumAgeSeconds: number): void {
  if (fact.availability !== "AVAILABLE_AT_ANCHOR" || fact.sourceCategory === "LOCAL") return;
  if (!fact.sourceTimestamp) {
    throw inconsistency(
      "An available provider decision-time fact is missing its source timestamp.",
    );
  }
  if (
    Math.abs(Date.parse(fact.sourceTimestamp) - Date.parse(anchorAt)) >
    maximumAgeSeconds * 1_000
  ) {
    throw inconsistency("A decision-time fact exceeds its fixed V2 freshness limit.");
  }
}

function assertSummaryConsistency(input: {
  readonly manifest: AnalysisManifest;
  readonly units: readonly AnalysisUnit[];
  readonly sources: readonly AnalysisSource[];
  readonly summary: AnalysisSummary;
}): void {
  const { manifest, units, summary } = input;
  const partitionCounts = countBy(units.map((unit) => unit.partition));
  const utcDateCounts = countBy(units.map((unit) => unit.anchorAt.slice(0, 10)));
  const later = units.flatMap((unit) => unit.laterObservations);
  const availabilityCounts = countBy(later.map((observation) => observation.availability));
  const maxDateCount = Math.max(0, ...Object.values(utcDateCounts));
  const maximumUtcDateSharePct =
    units.length === 0 ? 0 : Number(((maxDateCount / units.length) * 100).toFixed(6));
  if (
    summary.outcome !== manifest.outcome ||
    summary.validUnitCount !== units.length ||
    summary.attemptedSlotCount !== manifest.slots.length ||
    summary.partitionCounts.DISCOVERY !== (partitionCounts.DISCOVERY ?? 0) ||
    summary.partitionCounts.VALIDATION !== (partitionCounts.VALIDATION ?? 0) ||
    JSON.stringify(summary.utcDateCounts) !== JSON.stringify(sortValue(utcDateCounts)) ||
    summary.concentration.distinctMintCount !==
      new Set(units.map((unit) => unit.canonicalMint)).size ||
    summary.concentration.maximumUtcDateSharePct !== maximumUtcDateSharePct ||
    summary.laterObservations.totalCount !== later.length ||
    summary.laterObservations.missingOrInvalidCount !==
      (availabilityCounts.MISSING ?? 0) + (availabilityCounts.INVALID ?? 0) ||
    summary.executionDisabled !== true ||
    JSON.stringify(summary.providerCounts) !== JSON.stringify(manifest.providerCounts) ||
    JSON.stringify(summary.safetyCounters) !== JSON.stringify(manifest.safety)
  ) {
    throw inconsistency("The final collection summary is inconsistent with archive evidence.");
  }
  for (const availability of laterAvailabilitySchema.options) {
    if (
      (summary.laterObservations.availabilityCounts[availability] ?? 0) !==
      (availabilityCounts[availability] ?? 0)
    ) {
      throw inconsistency("The final collection summary label counts are inconsistent.");
    }
  }
  const caps = { DISCOVERY: 168, MARKET_CONTEXT: 168, QUOTE_IMPACT: 168, LATER_OBSERVATION: 672 };
  for (const category of providerCategorySchema.options) {
    if (
      summary.providerBudgetUse[category]?.cap !== caps[category] ||
      summary.providerBudgetUse[category]?.used !== manifest.providerCounts[category] ||
      manifest.providerCounts[category] > caps[category]
    ) {
      throw inconsistency("The final collection summary provider budget ledger is inconsistent.");
    }
  }
  const unitIds = new Set(units.map((unit) => unit.unitId));
  const mints = new Set(units.map((unit) => unit.canonicalMint));
  if (unitIds.size !== units.length || mints.size !== units.length) {
    throw inconsistency("The final archive contains duplicate unit or mint evidence.");
  }
  const expectedObservations = new Set([3, 5, 15, 60]);
  for (const unit of units) {
    if (unit.unitId !== `${unit.slotId}:${unit.canonicalMint}`) {
      throw inconsistency("A unit identity does not match its immutable slot and mint.");
    }
    if (
      new Set(unit.laterObservations.map((observation) => observation.minutesAfterAnchor)).size !==
        4 ||
      !unit.laterObservations.every((observation) =>
        expectedObservations.has(observation.minutesAfterAnchor),
      )
    ) {
      throw inconsistency("A unit does not contain the fixed four label horizons exactly once.");
    }
  }
}

function assertSafeArchiveValue(value: unknown): void {
  if (typeof value === "string") {
    if (
      /https?:\/\/|authorization|bearer\s+|api[ _-]?key|private[ _-]?key|password|secret|raw.*payload|^[A-Za-z]:[\\/]|^\//i.test(
        value,
      )
    ) {
      throw inconsistency("Archive content contains forbidden unsafe text.");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertSafeArchiveValue);
    return;
  }
  if (value && typeof value === "object") Object.values(value).forEach(assertSafeArchiveValue);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
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

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  return values.reduce<Record<T, number>>(
    (counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }),
    {} as Record<T, number>,
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function unsupported(message: string): ExploratoryCohortAnalysisError {
  return new ExploratoryCohortAnalysisError("EXPLORATORY_ANALYSIS_UNSUPPORTED_ARCHIVE", message);
}

function notFinal(message: string): ExploratoryCohortAnalysisError {
  return new ExploratoryCohortAnalysisError("EXPLORATORY_ANALYSIS_ARCHIVE_NOT_FINAL", message);
}

function inconsistency(message: string): ExploratoryCohortAnalysisError {
  return new ExploratoryCohortAnalysisError("EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY", message);
}
