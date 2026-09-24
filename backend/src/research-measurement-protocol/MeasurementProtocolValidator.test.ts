import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { MEASUREMENT_PROTOCOL_V3_PATH } from "./MeasurementProtocolConstants.js";
import { parseMeasurementProtocolArgs } from "./MeasurementProtocolConfig.js";
import { MeasurementProtocolError } from "./MeasurementProtocolErrors.js";
import { formatMeasurementProtocolValidationMarkdown } from "./MeasurementProtocolFormatter.js";
import {
  buildMeasurementProtocolValidation,
  canonicalMeasurementProtocolValidationJson,
  parseMeasurementProtocolDraft,
} from "./MeasurementProtocolService.js";
import type { MeasurementProtocolDraftV3 } from "./MeasurementProtocolTypes.js";

describe("MeasurementProtocolValidator", () => {
  it("accepts only the fixed path and bounded static options before any source read", () => {
    expect(
      parseMeasurementProtocolArgs([
        `--protocol=${MEASUREMENT_PROTOCOL_V3_PATH}`,
        "--format=json",
        "--once",
      ]),
    ).toEqual({ protocol: MEASUREMENT_PROTOCOL_V3_PATH, format: "json", once: true });

    for (const args of [
      [],
      ["--protocol"],
      [`--protocol=${MEASUREMENT_PROTOCOL_V3_PATH}`, "--once", "--once"],
      [`--protocol=${MEASUREMENT_PROTOCOL_V3_PATH}`, "--format=json", "--format=markdown"],
      [`--protocol=${MEASUREMENT_PROTOCOL_V3_PATH}`, "--archive-root=data/archive"],
      [`--protocol=${MEASUREMENT_PROTOCOL_V3_PATH}`, "--provider=DEXSCREENER"],
      [`--protocol=${MEASUREMENT_PROTOCOL_V3_PATH}`, "--paper"],
      ["--protocol=docs/research-protocols/other.json"],
    ]) {
      expectInvalidScope(() => parseMeasurementProtocolArgs(args));
    }
  });

  it("validates a fully concrete synthetic draft deterministically with literal zero side effects", () => {
    const protocol = validDraft();
    const bytes = encode(protocol);
    const expectedSha256 = hash(bytes);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      const first = buildMeasurementProtocolValidation({
        bytes,
        protocolPath: MEASUREMENT_PROTOCOL_V3_PATH,
        expectedSha256,
        now: () => new Date("2026-09-04T10:00:00.000Z"),
      });
      const second = buildMeasurementProtocolValidation({
        bytes,
        protocolPath: MEASUREMENT_PROTOCOL_V3_PATH,
        expectedSha256,
        now: () => new Date("2026-09-04T10:15:00.000Z"),
      });

      expect(first.generatedAt).not.toBe(second.generatedAt);
      expect(first.contentFingerprint).toBe(second.contentFingerprint);
      expect(canonicalMeasurementProtocolValidationJson(first)).toBe(
        canonicalMeasurementProtocolValidationJson(second),
      );
      expect(first.outcome).toEqual({
        status: "MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW",
        authority: "NON_AUTHORIZING",
      });
      expect(first.safety).toEqual({
        providerCalls: 0,
        httpCalls: 0,
        databaseReads: 0,
        databaseWrites: 0,
        archiveReads: 0,
        archiveWrites: 0,
        filesystemWrites: 0,
        runtimeCommands: 0,
        schedulerChanges: 0,
        sessionCreation: 0,
        orders: 0,
        fills: 0,
        positions: 0,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();

      const markdown = formatMeasurementProtocolValidationMarkdown(first);
      expect(markdown.indexOf("## Safety")).toBeLessThan(markdown.indexOf("## Outcome"));
      expect(markdown).toContain(
        "MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW",
      );
      expect(markdown).toContain("NOT_AUTHORIZED_FOR_COLLECTION");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("fails closed for a mismatched source identity before accepting a self-consistent rewrite", () => {
    const bytes = encode(validDraft());
    expectSourceInconsistency(() =>
      buildMeasurementProtocolValidation({
        bytes,
        protocolPath: MEASUREMENT_PROTOCOL_V3_PATH,
        expectedSha256: "0".repeat(64),
      }),
    );

    const rewritten = validDraft();
    rewritten.collectionPlan.plannedUnits = 95 as never;
    const rewrittenBytes = encode(rewritten);
    expectUnsupportedDraft(() =>
      buildMeasurementProtocolValidation({
        bytes: rewrittenBytes,
        protocolPath: MEASUREMENT_PROTOCOL_V3_PATH,
        expectedSha256: hash(rewrittenBytes),
      }),
    );
  });

  it("rejects unknown, incomplete, unsafe, expanded, and authority-changing synthetic content", () => {
    const invalidRecords: unknown[] = [
      { ...validDraft(), unknown: true },
      { ...validDraft(), providerPlan: { ...validDraft().providerPlan, retryCount: 1 } },
      {
        ...validDraft(),
        providerPlan: { ...validDraft().providerPlan, directProvider: "OTHER" },
      },
      {
        ...validDraft(),
        purpose: { ...validDraft().purpose, designQuestion: "https://not-allowed.invalid" },
      },
      {
        ...validDraft(),
        outcomeBoundary: { ...validDraft().outcomeBoundary, labels: "PRESENT" },
      },
      {
        ...validDraft(),
        measurementObjectives: validDraft().measurementObjectives.slice(0, 2),
      },
    ];
    for (const record of invalidRecords) {
      expectUnsupportedDraft(() => parseMeasurementProtocolDraft(record));
    }

    const alteredEvidence = validDraft();
    const liquiditySignature = alteredEvidence.sourceEvidence.aggregateMeasurementSignatures[0];
    if (!liquiditySignature) throw new Error("Synthetic liquidity signature is unavailable.");
    liquiditySignature.discoveryAvailable = 25;
    const alteredEvidenceBytes = encode(alteredEvidence);
    expectSourceInconsistency(() =>
      buildMeasurementProtocolValidation({
        bytes: alteredEvidenceBytes,
        protocolPath: MEASUREMENT_PROTOCOL_V3_PATH,
        expectedSha256: hash(alteredEvidenceBytes),
      }),
    );
  });

  it("keeps the isolated implementation free of prohibited imports and write APIs", () => {
    const directory = new URL(".", import.meta.url);
    const sources = fs
      .readdirSync(directory)
      .filter((fileName) => fileName.endsWith(".ts") && !fileName.endsWith(".test.ts"))
      .map((fileName) => fs.readFileSync(new URL(fileName, directory), "utf8"));
    const source = sources.join("\n");

    expect(source).not.toMatch(
      /from\s+["'][^"']*(?:research-exploratory-cohort|providers|\/db\/|runtime|strategy|paper|wallet|execution)[^"']*["']/i,
    );
    expect(source).not.toMatch(
      /writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|unlinkSync/,
    );
  });
});

function validDraft(): MeasurementProtocolDraftV3 {
  return {
    contractVersion: "3",
    protocolId: "EXPLORATORY_COHORT_MEASUREMENT@v3",
    authorityStatus: "NOT_AUTHORIZED_FOR_COLLECTION",
    supersedes: {
      protocolPath: "docs/research-protocols/phase10.6a-exploratory-cohort.v2.json",
      protocolSha256: "2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed",
      reason: "MEASUREMENT_AVAILABILITY_REPAIR_ONLY",
    },
    sourceEvidence: {
      measurementAudit: {
        contentFingerprint: "843d1d27aee452f7fcccb000128fec10a38d0fbe80652fc9eb50511a9447b486",
        v2ArchiveRoot: "data/archive/phase10.6a/exploratory-cohort-v2-20260821-0000Z",
        v2ProtocolSha256: "2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed",
      },
      aggregateMeasurementSignatures: [
        signature("LIQUIDITY", 26, 21, "UNAVAILABLE_AT_ANCHOR"),
        signature("MOMENTUM_5M", 0, 0, "UNSUPPORTED"),
        signature("MOMENTUM_15M", 0, 0, "UNSUPPORTED"),
      ],
    },
    purpose: {
      kind: "OUTCOME_BLIND_MEASUREMENT_AVAILABILITY",
      designQuestion:
        "Can fixed direct decision-time observations provide complete, fresh measurement availability for the three pre-registered fields?",
      strategyValidation: false,
      profitabilityClaim: false,
      literalLimit:
        "V3 measurement availability can validate only a data-collection capability. It cannot validate a strategy, reproduce a return effect, create a candidate, or promote trading.",
    },
    populationAndAnchor: {
      discoveryUniverse: "ALL_CANONICAL_SOLANA_MINTS_FROM_UNMODIFIED_DISCOVERY_UNIVERSE",
      discoveryRequestLimit: 100,
      canonicalIdentity: {
        mintEncoding: "BASE58_32_BYTE_CANONICAL_MINT",
        sourceKindRequired: true,
        firstReceivedAtUtcRequired: true,
      },
      selectionAt: "SLOT_ANCHOR_MINUS_16_MINUTES",
      anchorAt: "SLOT_ANCHOR",
      technicalValidityAnchor: "CANONICAL_IDENTITY_AND_SELECTION_TIME_SOURCE_METADATA_ONLY",
      sampling: {
        seed: "phase10.6a-exploratory-cohort.v3",
        selectionHash: "SHA256(seed|canonicalMint|slotId)",
        selectionRule: "LEXICOGRAPHICALLY_LOWEST_HASH",
        maximumUnitsPerSlot: 1,
        deduplication: "ONE_CANONICAL_MINT_PER_COHORT",
      },
      permittedExclusions: ["MALFORMED_OR_NON_CANONICAL_IDENTIFIER"],
      forbiddenSelectionInputs: ["MEASUREMENT_FIELD_VALUE"],
    },
    measurementObjectives: [
      {
        fieldId: "LIQUIDITY",
        decisionTimePath: "market.liquidityUsd",
        valueType: "FINITE_NON_NEGATIVE_USD",
        unit: "USD",
        missingnessCodes: availabilityCodes(),
        provenance: { category: "MARKET_CONTEXT", sourceIdentifier: "BEST_PAIR" },
        method: {
          kind: "DIRECT_OBSERVATION",
          snapshotOffsetMinutes: 0,
          maximumSourceToAnchorSeconds: 60,
          valuePath: "BEST_PAIR.liquidityUsd",
        },
        selectionInput: false,
      },
      momentumObjective(
        "MOMENTUM_5M",
        "market.momentum5mPct",
        "((PRICE_AT_0 / PRICE_AT_NEGATIVE_5) - 1) * 100",
      ),
      momentumObjective(
        "MOMENTUM_15M",
        "market.momentum15mPct",
        "((PRICE_AT_0 / PRICE_AT_NEGATIVE_15) - 1) * 100",
      ),
    ],
    providerPlan: {
      directProvider: "DEXSCREENER",
      categories: [
        {
          category: "DISCOVERY",
          capability: "DISCOVER_TOKENS",
          requestShape: "discoverTokens(100)",
          cohortRequestCap: 168,
        },
        {
          category: "MARKET_CONTEXT",
          capability: "BEST_PAIR",
          requestShape: "getBestPairForToken(canonicalMint)",
          cohortRequestCap: 672,
        },
      ],
      maximumRequestsPerMinutePerCategory: 1,
      maximumConcurrencyPerCategory: 1,
      timeoutSeconds: 10,
      retryCount: 0,
      fallback: "PROHIBITED",
      rawPayloadRetention: "PROHIBITED",
      providerExpansion: "PROHIBITED",
    },
    collectionPlan: {
      slotDurationMinutes: 120,
      maximumAttemptedSlots: 168,
      consecutiveUtcDates: 14,
      plannedUnits: 96,
      minimumValidUnits: 72,
      maximumUnitsPerSlot: 1,
      externalInvocation: {
        startsAt: "SLOT_ANCHOR_MINUS_16_MINUTES",
        finishesAt: "SLOT_ANCHOR",
        overlappingInvocation: "PROHIBITED",
      },
      scheduledSnapshots: [-15, -10, -5, 0],
      partitionAssignment: {
        assignmentHash: "SHA256(phase10.6a-exploratory-cohort.v3|canonicalMint|slotId)",
        discoveryAssignment: "EVEN_FINAL_HEXADECIMAL_DIGIT",
        validationAssignment: "ODD_FINAL_HEXADECIMAL_DIGIT",
        minimumValidUnitsPerPartition: 32,
        minimumUtcDatesPerPartition: 4,
      },
      independence: {
        minimumUtcDates: 8,
        maximumValidUnitSharePerUtcDatePct: 20,
        minimumDistinctMints: 72,
      },
      catchUp: "PROHIBITED",
      replacement: "PROHIBITED",
      sourceInventory: "SAFE_AGGREGATES_ONLY",
    },
    dataQualityAndMeasurementGates: {
      availabilityPercentFormula: "(AVAILABLE_AT_ANCHOR / VALID_UNITS_IN_PARTITION) * 100",
      minimumAvailabilityPctPerObjectivePerPartition: 90,
      minimumUtcDateSupportPerObjectivePerPartition: 4,
      provenanceConsistency: "EXACT_CATEGORY_AND_SOURCE_IDENTIFIER",
      freshness: "DECLARED_OBJECTIVE_RULE_REQUIRED",
      missingness: "EIGHT_CODE_ENUM_REQUIRED",
      dataQualityStopConditions: ["CLOCK_ORDER_VIOLATION"],
      insufficiencyOutcome: "MEASUREMENT_COHORT_DATA_INSUFFICIENT",
      stopOutcome: "MEASUREMENT_COHORT_DATA_QUALITY_STOP",
    },
    archiveContract: {
      rootPattern: "data/archive/phase10.6a/measurement-v3-YYYYMMDD-HHmmZ/",
      files: [
        "cohort-manifest.v1.json",
        "units.v1.ndjson",
        "source-inventory.v1.json",
        "collection-summary.v1.json",
      ],
      retention: "IMMUTABLE_INDEFINITE",
      forbiddenContent: ["CREDENTIAL"],
    },
    outcomeBoundary: {
      laterObservations: "ABSENT",
      labels: "ABSENT",
      prohibitedInputs: ["LATER_LABEL"],
      protocolMutationWhileRunning: "PROHIBITED",
    },
    safety: {
      buyScoreThreshold: 90,
      watchScoreThreshold: 70,
      paperExecution: "DISABLED",
      unchangedF65E: "PROHIBITED",
      oneOrTwoMinuteMonitoringChange: "PROHIBITED",
      strategyDefaultChange: "PROHIBITED",
      wallet: "PROHIBITED",
      signing: "PROHIBITED",
      submission: "PROHIBITED",
      orders: "PROHIBITED",
      fills: "PROHIBITED",
      positions: "PROHIBITED",
    },
    downstreamAuthority: {
      staticValidation: "REQUIRES_SEPARATE_EXPLICIT_APPROVAL",
      collectionChecklist: "REQUIRES_SEPARATE_APPROVED_CHECKLIST",
      collectorImplementation: "REQUIRES_SEPARATE_EXPLICIT_APPROVAL",
      namedArchiveRoot: "REQUIRES_SEPARATE_EXPLICIT_APPROVAL",
      scheduler: "REQUIRES_SEPARATE_EXPLICIT_APPROVAL",
      analysis: "REQUIRES_SEPARATE_ARCHIVE_ONLY_APPROVAL",
      phase10_6C: "NOT_AUTHORIZED",
      execution: "NOT_AUTHORIZED",
    },
  };
}

function availabilityCodes(): MeasurementProtocolDraftV3["measurementObjectives"][number]["missingnessCodes"] {
  return [
    "AVAILABLE_AT_ANCHOR",
    "NOT_REQUESTED",
    "UNAVAILABLE_AT_ANCHOR",
    "STALE_AT_ANCHOR",
    "BUDGET_EXHAUSTED",
    "PROVIDER_ERROR",
    "UNSUPPORTED",
    "INVALID_VALUE",
  ];
}

function signature(
  fieldId: "LIQUIDITY" | "MOMENTUM_5M" | "MOMENTUM_15M",
  discoveryAvailable: number,
  validationAvailable: number,
  availability: "UNAVAILABLE_AT_ANCHOR" | "UNSUPPORTED",
): MeasurementProtocolDraftV3["sourceEvidence"]["aggregateMeasurementSignatures"][number] {
  return {
    fieldId,
    discoveryAvailable,
    discoveryTotal: 46,
    validationAvailable,
    validationTotal: 50,
    availability,
    provenanceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    utcDateSupport: 9,
  };
}

function momentumObjective(
  fieldId: "MOMENTUM_5M" | "MOMENTUM_15M",
  decisionTimePath: "market.momentum5mPct" | "market.momentum15mPct",
  formula: string,
): MeasurementProtocolDraftV3["measurementObjectives"][number] {
  return {
    fieldId,
    decisionTimePath,
    valueType: "FINITE_SIGNED_PERCENT",
    unit: "PCT",
    missingnessCodes: availabilityCodes(),
    provenance: { category: "MARKET_CONTEXT", sourceIdentifier: "BEST_PAIR" },
    method: {
      kind: "FIXED_PRE_ANCHOR_CALCULATION",
      requiredSnapshotOffsetsMinutes: [-15, -10, -5, 0],
      maximumSourceToScheduledSnapshotSeconds: 60,
      inputValuePath: "BEST_PAIR.priceUsd",
      formula,
      absentComponentAction: "RECORD_DECLARED_MISSINGNESS",
    },
    selectionInput: false,
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function expectInvalidScope(action: () => unknown): void {
  expectError(action, "MEASUREMENT_PROTOCOL_INVALID_SCOPE");
}

function expectUnsupportedDraft(action: () => unknown): void {
  expectError(action, "MEASUREMENT_PROTOCOL_UNSUPPORTED_DRAFT");
}

function expectSourceInconsistency(action: () => unknown): void {
  expectError(action, "MEASUREMENT_PROTOCOL_SOURCE_INCONSISTENCY");
}

function expectError(
  action: () => unknown,
  code:
    | "MEASUREMENT_PROTOCOL_INVALID_SCOPE"
    | "MEASUREMENT_PROTOCOL_UNSUPPORTED_DRAFT"
    | "MEASUREMENT_PROTOCOL_SOURCE_INCONSISTENCY",
): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(MeasurementProtocolError);
    expect((error as MeasurementProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}
