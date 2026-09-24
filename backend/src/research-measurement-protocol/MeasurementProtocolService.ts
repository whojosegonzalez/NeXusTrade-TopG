import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  EXPLORATORY_COHORT_V2_ARCHIVE_ROOT,
  EXPLORATORY_COHORT_V2_PROTOCOL_SHA256,
  MEASUREMENT_PROTOCOL_V3_SHA256,
  PHASE10_6B_1_MEASUREMENT_AUDIT_FINGERPRINT,
} from "./MeasurementProtocolConstants.js";
import type { MEASUREMENT_PROTOCOL_V3_PATH } from "./MeasurementProtocolConstants.js";
import {
  resolveMeasurementProtocol,
  type MeasurementProtocolConfig,
} from "./MeasurementProtocolConfig.js";
import { MeasurementProtocolError } from "./MeasurementProtocolErrors.js";
import {
  measurementProtocolDraftSchema,
  measurementProtocolValidationSchema,
  type MeasurementProtocolDraftV3,
  type MeasurementProtocolValidationV1,
} from "./MeasurementProtocolTypes.js";

const nextPermittedAction =
  "Present the pinned V3 draft and this static result for a separate collection-checklist decision. Do not implement a collector, create an archive root, configure a scheduler, or make a provider call." as const;

const requiredAvailabilityCodes = [
  "AVAILABLE_AT_ANCHOR",
  "NOT_REQUESTED",
  "UNAVAILABLE_AT_ANCHOR",
  "STALE_AT_ANCHOR",
  "BUDGET_EXHAUSTED",
  "PROVIDER_ERROR",
  "UNSUPPORTED",
  "INVALID_VALUE",
] as const;

export class MeasurementProtocolService {
  constructor(
    private readonly options: {
      readonly config: MeasurementProtocolConfig;
      readonly now?: () => Date;
    },
  ) {}

  build(): MeasurementProtocolValidationV1 {
    const protocolPath = resolveMeasurementProtocol(this.options.config);
    const bytes = readFileSync(protocolPath);
    return buildMeasurementProtocolValidation({
      bytes,
      protocolPath: this.options.config.protocol,
      expectedSha256: MEASUREMENT_PROTOCOL_V3_SHA256,
      ...(this.options.now ? { now: this.options.now } : {}),
    });
  }
}

export function buildMeasurementProtocolValidation(input: {
  readonly bytes: Uint8Array;
  readonly protocolPath: typeof MEASUREMENT_PROTOCOL_V3_PATH;
  readonly expectedSha256: string;
  readonly now?: () => Date;
}): MeasurementProtocolValidationV1 {
  const protocolSha256 = sha256(input.bytes);
  if (protocolSha256 !== input.expectedSha256) {
    throw sourceInconsistency(
      "The fixed measurement protocol hash does not match its approved bytes.",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(input.bytes)) as unknown;
  } catch {
    throw unsupportedDraft("The fixed measurement protocol is not valid JSON.");
  }

  const protocol = parseMeasurementProtocolDraft(raw);
  assertDraftEvidence(protocol);
  assertConcreteContract(protocol);

  const draft = measurementProtocolValidationSchema.parse({
    contractVersion: "1",
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    contentFingerprint: "0".repeat(64),
    protocol: {
      path: input.protocolPath,
      sha256: protocolSha256,
      protocolId: protocol.protocolId,
      authorityStatus: protocol.authorityStatus,
    },
    sourceEvidence: {
      measurementAuditFingerprint: protocol.sourceEvidence.measurementAudit.contentFingerprint,
      v2ProtocolSha256: protocol.sourceEvidence.measurementAudit.v2ProtocolSha256,
      objectiveFields: protocol.measurementObjectives.map((objective) => objective.fieldId),
    },
    safety: zeroSafety,
    outcome: {
      status: "MEASUREMENT_PROTOCOL_DRAFT_READY_FOR_SEPARATE_COLLECTION_CHECKLIST_REVIEW",
      authority: "NON_AUTHORIZING",
    },
    nextPermittedAction,
    warnings: [
      "The V3 record is a measurement-only static design and is not collection authorization.",
      "No archive was read and no live, later, or performance information was interpreted.",
      "A successful static validation cannot authorize a provider call, collector, scheduler, PAPER behavior, or execution.",
    ],
  });

  const validation = measurementProtocolValidationSchema.parse({
    ...draft,
    contentFingerprint: fingerprintMeasurementProtocolValidation(draft),
  });
  assertNoUnsafeContent(validation);
  return validation;
}

export function parseMeasurementProtocolDraft(value: unknown): MeasurementProtocolDraftV3 {
  const parsed = measurementProtocolDraftSchema.safeParse(value);
  if (!parsed.success) {
    throw unsupportedDraft(
      "The protocol does not match the strict MeasurementProtocolDraftV3 schema.",
    );
  }
  assertNoUnsafeContent(parsed.data);
  return parsed.data;
}

export function canonicalMeasurementProtocolValidationJson(
  validation: MeasurementProtocolValidationV1,
): string {
  return stableJson(withoutGeneratedAt(validation));
}

export function fingerprintMeasurementProtocolValidation(
  validation: MeasurementProtocolValidationV1,
): string {
  return sha256(stableJson({ ...withoutGeneratedAt(validation), contentFingerprint: "" }));
}

const zeroSafety = {
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
} as const;

function assertDraftEvidence(protocol: MeasurementProtocolDraftV3): void {
  const evidence = protocol.sourceEvidence.measurementAudit;
  if (
    evidence.contentFingerprint !== PHASE10_6B_1_MEASUREMENT_AUDIT_FINGERPRINT ||
    evidence.v2ArchiveRoot !== EXPLORATORY_COHORT_V2_ARCHIVE_ROOT ||
    evidence.v2ProtocolSha256 !== EXPLORATORY_COHORT_V2_PROTOCOL_SHA256
  ) {
    throw sourceInconsistency(
      "The V3 source evidence does not match the fixed Phase 10.6B.1 identity.",
    );
  }

  const expectedSignatures = [
    {
      fieldId: "LIQUIDITY",
      discoveryAvailable: 26,
      discoveryTotal: 46,
      validationAvailable: 21,
      validationTotal: 50,
      availability: "UNAVAILABLE_AT_ANCHOR",
      provenanceCategory: "MARKET_CONTEXT",
      sourceIdentifier: "BEST_PAIR",
      utcDateSupport: 9,
    },
    {
      fieldId: "MOMENTUM_5M",
      discoveryAvailable: 0,
      discoveryTotal: 46,
      validationAvailable: 0,
      validationTotal: 50,
      availability: "UNSUPPORTED",
      provenanceCategory: "MARKET_CONTEXT",
      sourceIdentifier: "BEST_PAIR",
      utcDateSupport: 9,
    },
    {
      fieldId: "MOMENTUM_15M",
      discoveryAvailable: 0,
      discoveryTotal: 46,
      validationAvailable: 0,
      validationTotal: 50,
      availability: "UNSUPPORTED",
      provenanceCategory: "MARKET_CONTEXT",
      sourceIdentifier: "BEST_PAIR",
      utcDateSupport: 9,
    },
  ] as const;
  if (!sameObject(protocol.sourceEvidence.aggregateMeasurementSignatures, expectedSignatures)) {
    throw sourceInconsistency(
      "The V3 aggregate measurement signatures do not match the fixed Phase 10.6B.1 record.",
    );
  }
}

function assertConcreteContract(protocol: MeasurementProtocolDraftV3): void {
  if (
    protocol.supersedes.protocolPath !==
      "docs/research-protocols/phase10.6a-exploratory-cohort.v2.json" ||
    protocol.supersedes.protocolSha256 !== EXPLORATORY_COHORT_V2_PROTOCOL_SHA256
  ) {
    throw sourceInconsistency("The V3 protocol must supersede the exact frozen V2 protocol.");
  }

  const objectives = protocol.measurementObjectives;
  if (
    objectives.map((objective) => objective.fieldId).join("|") !==
      "LIQUIDITY|MOMENTUM_5M|MOMENTUM_15M" ||
    objectives.some(
      (objective) =>
        !sameObject(objective.missingnessCodes, requiredAvailabilityCodes) ||
        objective.provenance.category !== "MARKET_CONTEXT" ||
        objective.provenance.sourceIdentifier !== "BEST_PAIR" ||
        objective.selectionInput,
    )
  ) {
    throw unsupportedDraft(
      "The V3 measurement objectives must retain exact declared facts and missingness.",
    );
  }

  const [liquidity, momentum5m, momentum15m] = objectives;
  if (
    !liquidity ||
    !momentum5m ||
    !momentum15m ||
    liquidity.decisionTimePath !== "market.liquidityUsd" ||
    liquidity.valueType !== "FINITE_NON_NEGATIVE_USD" ||
    liquidity.unit !== "USD" ||
    liquidity.method.kind !== "DIRECT_OBSERVATION" ||
    liquidity.method.maximumSourceToAnchorSeconds !== 60 ||
    momentum5m.decisionTimePath !== "market.momentum5mPct" ||
    momentum5m.valueType !== "FINITE_SIGNED_PERCENT" ||
    momentum5m.unit !== "PCT" ||
    momentum5m.method.kind !== "FIXED_PRE_ANCHOR_CALCULATION" ||
    !sameObject(momentum5m.method.requiredSnapshotOffsetsMinutes, [-15, -10, -5, 0]) ||
    momentum5m.method.maximumSourceToScheduledSnapshotSeconds !== 60 ||
    momentum5m.method.formula !== "((PRICE_AT_0 / PRICE_AT_NEGATIVE_5) - 1) * 100" ||
    momentum15m.decisionTimePath !== "market.momentum15mPct" ||
    momentum15m.valueType !== "FINITE_SIGNED_PERCENT" ||
    momentum15m.unit !== "PCT" ||
    momentum15m.method.kind !== "FIXED_PRE_ANCHOR_CALCULATION" ||
    !sameObject(momentum15m.method.requiredSnapshotOffsetsMinutes, [-15, -10, -5, 0]) ||
    momentum15m.method.maximumSourceToScheduledSnapshotSeconds !== 60 ||
    momentum15m.method.formula !== "((PRICE_AT_0 / PRICE_AT_NEGATIVE_15) - 1) * 100"
  ) {
    throw unsupportedDraft(
      "The V3 measurement method is incomplete or differs from its fixed semantics.",
    );
  }

  if (
    !sameObject(protocol.providerPlan.categories, [
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
    ]) ||
    !sameObject(protocol.collectionPlan.scheduledSnapshots, [-15, -10, -5, 0]) ||
    protocol.collectionPlan.externalInvocation.startsAt !== "SLOT_ANCHOR_MINUS_16_MINUTES" ||
    protocol.collectionPlan.externalInvocation.finishesAt !== "SLOT_ANCHOR" ||
    protocol.dataQualityAndMeasurementGates.minimumAvailabilityPctPerObjectivePerPartition !== 90 ||
    protocol.outcomeBoundary.laterObservations !== "ABSENT" ||
    protocol.outcomeBoundary.labels !== "ABSENT" ||
    protocol.safety.paperExecution !== "DISABLED" ||
    protocol.downstreamAuthority.staticValidation !== "REQUIRES_SEPARATE_EXPLICIT_APPROVAL" ||
    protocol.downstreamAuthority.execution !== "NOT_AUTHORIZED"
  ) {
    throw unsupportedDraft(
      "The V3 provider, timing, quality, outcome, or authority boundary is invalid.",
    );
  }
}

function assertNoUnsafeContent(value: unknown, location = "measurement protocol"): void {
  if (typeof value === "string") {
    if (
      /\b(?:api[ _-]?key|private[ _-]?key)\b|\bauthorization\s*[:=]|\bbearer\s+\S+|\bpassword\s*[:=]|process\.env|https?:\/\/|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|(?:^|\s)--[A-Za-z]/i.test(
        value,
      )
    ) {
      throw unsupportedDraft(
        `Credential-like, network-shaped, placeholder, or runtime content is not allowed at ${location}.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeContent(item, `${location}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) =>
      assertNoUnsafeContent(item, `${location}.${key}`),
    );
  }
}

function withoutGeneratedAt(validation: MeasurementProtocolValidationV1): Record<string, unknown> {
  return Object.fromEntries(Object.entries(validation).filter(([key]) => key !== "generatedAt"));
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function sameObject(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unsupportedDraft(message: string): MeasurementProtocolError {
  return new MeasurementProtocolError("MEASUREMENT_PROTOCOL_UNSUPPORTED_DRAFT", message);
}

function sourceInconsistency(message: string): MeasurementProtocolError {
  return new MeasurementProtocolError("MEASUREMENT_PROTOCOL_SOURCE_INCONSISTENCY", message);
}
