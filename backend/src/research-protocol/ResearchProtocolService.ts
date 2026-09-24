import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  EXPLORATORY_PROTOCOL_V2_PATH,
  EXPLORATORY_PROTOCOL_V2_SHA256,
  INITIAL_EXPLORATORY_PROTOCOL_V1_PATH,
  INITIAL_EXPLORATORY_PROTOCOL_V1_SHA256,
  INITIAL_EXPLORATORY_PROTOCOL_SHA256,
  PHASE10_4_BRIEF_FINGERPRINT,
  PHASE10_5_REVIEW_GATE_FINGERPRINT,
  PHASE9_29_CONCLUSION,
} from "./ResearchProtocolConstants.js";
import { resolveResearchProtocol, type ResearchProtocolConfig } from "./ResearchProtocolConfig.js";
import type { ApprovedExploratoryProtocolPath } from "./ResearchProtocolConstants.js";
import { ResearchProtocolError } from "./ResearchProtocolErrors.js";
import {
  exploratoryCohortProtocolSchema,
  researchProtocolValidationSchema,
  type ExploratoryCohortProtocolV1,
  type ResearchProtocolValidationV1,
} from "./ResearchProtocolTypes.js";

const nextPermittedAction =
  "Submit the fixed protocol for a separate Phase 10.6A checklist and explicit user approval. Do not collect data, configure a market runtime, change strategy defaults, or enable PAPER execution." as const;

export class ResearchProtocolService {
  constructor(
    private readonly options: {
      readonly config: ResearchProtocolConfig;
      readonly now?: () => Date;
    },
  ) {}

  build(): ResearchProtocolValidationV1 {
    const { protocol, sha256 } = loadProtocol(this.options.config);
    const draft = researchProtocolValidationSchema.parse({
      contractVersion: "1",
      generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      contentFingerprint: "0".repeat(64),
      protocol: {
        path: this.options.config.protocol,
        sha256,
        protocolId: protocol.protocolId,
        authorityStatus: protocol.authorityStatus,
      },
      sourceEvidence: protocol.sourceEvidence,
      safety: {
        providerCalls: 0,
        httpCalls: 0,
        databaseReads: 0,
        databaseWrites: 0,
        filesystemWrites: 0,
        runtimeCommands: 0,
        sessionCreation: 0,
        orders: 0,
        fills: 0,
        positions: 0,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      },
      outcome: {
        status: "PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL",
        authority: "NON_AUTHORIZING",
      },
      nextPermittedAction,
      warnings: [
        "The protocol is a static design record, not a collection authorization.",
        "Later observations remain labels only and are not population or sampling inputs.",
        "Phase 10.6C and every execution surface remain unavailable.",
      ],
    });
    const validation = researchProtocolValidationSchema.parse({
      ...draft,
      contentFingerprint: fingerprintResearchProtocolValidation(draft),
    });
    assertNoCredentialLikeValue(validation);
    return validation;
  }
}

export function parseExploratoryCohortProtocol(value: unknown): ExploratoryCohortProtocolV1 {
  const parsed = exploratoryCohortProtocolSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidRecord(
      "The protocol does not match the strict ExploratoryCohortProtocolV1 schema.",
    );
  }
  assertNoCredentialLikeValue(parsed.data);
  assertNoPlaceholderOrRuntimeValue(parsed.data);
  return parsed.data;
}

export function assertInitialProtocolSha256(value: string): void {
  if (value !== INITIAL_EXPLORATORY_PROTOCOL_SHA256) {
    throw sourceInconsistency("The approved initial exploratory protocol hash does not match.");
  }
}

export function assertApprovedProtocolSha256(
  protocolPath: ApprovedExploratoryProtocolPath,
  value: string,
): void {
  const expected = approvedProtocolIdentity[protocolPath].sha256;
  if (value !== expected) {
    throw sourceInconsistency("The approved exploratory protocol hash does not match.");
  }
}

export function canonicalResearchProtocolValidationJson(
  validation: ResearchProtocolValidationV1,
): string {
  return stableJson(withoutGeneratedAt(validation));
}

export function fingerprintResearchProtocolValidation(
  validation: ResearchProtocolValidationV1,
): string {
  return sha256(stableJson({ ...withoutGeneratedAt(validation), contentFingerprint: "" }));
}

function loadProtocol(config: ResearchProtocolConfig): {
  readonly protocol: ExploratoryCohortProtocolV1;
  readonly sha256: string;
} {
  const absolutePath = resolveResearchProtocol(config);
  const bytes = readFileSync(absolutePath);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw invalidRecord("The approved protocol is not valid JSON.");
  }
  const protocolSha256 = sha256(bytes);
  const protocol = parseExploratoryCohortProtocol(raw);
  assertApprovedProtocolSha256(config.protocol, protocolSha256);
  assertProtocolIdentity(config.protocol, protocol);
  assertSourceEvidence(protocol);
  return { protocol, sha256: protocolSha256 };
}

const approvedProtocolIdentity = {
  [INITIAL_EXPLORATORY_PROTOCOL_V1_PATH]: {
    sha256: INITIAL_EXPLORATORY_PROTOCOL_V1_SHA256,
    contractVersion: "1",
    protocolId: "EXPLORATORY_COHORT@v1",
  },
  [EXPLORATORY_PROTOCOL_V2_PATH]: {
    sha256: EXPLORATORY_PROTOCOL_V2_SHA256,
    contractVersion: "2",
    protocolId: "EXPLORATORY_COHORT@v2",
  },
} as const;

function assertProtocolIdentity(
  protocolPath: ApprovedExploratoryProtocolPath,
  protocol: ExploratoryCohortProtocolV1,
): void {
  const expected = approvedProtocolIdentity[protocolPath];
  if (
    protocol.contractVersion !== expected.contractVersion ||
    protocol.protocolId !== expected.protocolId
  ) {
    throw sourceInconsistency("The approved protocol identity does not match its catalog path.");
  }
}

function assertSourceEvidence(protocol: ExploratoryCohortProtocolV1): void {
  if (
    protocol.sourceEvidence.researchBrief.fingerprint !== PHASE10_4_BRIEF_FINGERPRINT ||
    protocol.sourceEvidence.researchReviewGate.fingerprint !== PHASE10_5_REVIEW_GATE_FINGERPRINT ||
    protocol.sourceEvidence.phase929Conclusion.status !== PHASE9_29_CONCLUSION
  ) {
    throw sourceInconsistency(
      "The protocol source evidence does not match the fixed evidence identity.",
    );
  }
}

function assertNoCredentialLikeValue(value: unknown, location = "research protocol"): void {
  if (typeof value === "string") {
    if (
      /\b(?:api[ _-]?key|private[ _-]?key)\b|\bauthorization\s*[:=]|\bbearer\s+\S+|\bpassword\s*[:=]|process\.env|https?:\/\//i.test(
        value,
      )
    ) {
      throw invalidRecord(
        `Credential-like or network-shaped content is not allowed at ${location}.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialLikeValue(item, `${location}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) =>
      assertNoCredentialLikeValue(item, `${location}.${key}`),
    );
  }
}

function assertNoPlaceholderOrRuntimeValue(value: unknown, location = "research protocol"): void {
  if (typeof value === "string") {
    if (
      /\b(?:TBD|TODO|PLACEHOLDER)\b|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|(?:^|\s)--[A-Za-z]|^[A-Za-z]:[\\/]|^[/\\]/i.test(
        value,
      )
    ) {
      throw invalidRecord(
        `Placeholder, environment, runtime option, or absolute path is not allowed at ${location}.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoPlaceholderOrRuntimeValue(item, `${location}[${index}]`),
    );
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) =>
      assertNoPlaceholderOrRuntimeValue(item, `${location}.${key}`),
    );
  }
}

function withoutGeneratedAt(validation: ResearchProtocolValidationV1): Record<string, unknown> {
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalidRecord(message: string): ResearchProtocolError {
  return new ResearchProtocolError("RESEARCH_PROTOCOL_INVALID_RECORD", message);
}

function sourceInconsistency(message: string): ResearchProtocolError {
  return new ResearchProtocolError("RESEARCH_PROTOCOL_SOURCE_INCONSISTENCY", message);
}
