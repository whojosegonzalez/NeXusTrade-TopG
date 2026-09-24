import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ResearchBriefError } from "../research-brief/ResearchBriefErrors.js";
import { ResearchBriefService } from "../research-brief/ResearchBriefService.js";
import type { ResearchBriefV1 } from "../research-brief/ResearchBriefTypes.js";
import {
  resolveResearchReviewRecord,
  type ResearchReviewGateConfig,
} from "./ResearchReviewGateConfig.js";
import { ResearchReviewGateError } from "./ResearchReviewGateErrors.js";
import {
  failedGateNames,
  researchReviewGateSchema,
  researchReviewRecordSchema,
  type ResearchReviewGateV1,
  type ResearchReviewRecordV1,
} from "./ResearchReviewGateTypes.js";

const expectedBriefFingerprint = "5fb59e2bf4472ea4da2a516d1298398491b812d1a3ae811d745aa46d5ee308c7";
const expectedInitialReviewRecordSha256 =
  "07b9d4311747452ca3f539d2e26ba68ce90b9fc8db9f9e4cd5585678e8f2193f";
const nextPermittedAction =
  "No new study is authorized. Do not collect unchanged F65E@v1 data, alter defaults or thresholds, enable PAPER execution, call providers, or begin Phase 10.6. A later distinct study requires a separate explicitly approved Phase 10.6 implementation plan." as const;

export class ResearchReviewGateService {
  constructor(
    private readonly options: {
      readonly config: ResearchReviewGateConfig;
      readonly now?: () => Date;
      readonly buildBrief?: () => ResearchBriefV1;
    },
  ) {}

  build(): ResearchReviewGateV1 {
    const brief = this.options.buildBrief?.() ?? buildBrief(this.options.config);
    const { record, sha256 } = loadReviewRecord(this.options.config);
    assertInitialEvidence(brief, record);
    const sourceReport = brief.recordedConclusion.sourceReport;
    if (!sourceReport) {
      throw sourceInconsistency("The approved brief has no attribution-conclusion source.");
    }

    const draft = researchReviewGateSchema.parse({
      contractVersion: "1",
      generatedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      contentFingerprint: "0".repeat(64),
      briefFingerprint: brief.contentFingerprint,
      scope: brief.scope,
      inputInventory: [
        ...brief.inputInventory.map((source) => ({
          path: source.path,
          sourceType: source.reportKind,
          sha256: source.sha256,
        })),
        {
          path: this.options.config.reviewRecord,
          sourceType: "RESEARCH_REVIEW_RECORD" as const,
          sha256,
        },
      ].sort(compareByPath),
      safety: {
        mode: "PAPER",
        shadowOnly: true,
        executionDisabled: true,
        buyScoreThreshold: 90,
        watchScoreThreshold: 70,
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
      evidenceSummary: {
        sourceCount: brief.inputInventory.length,
        runnerSummaryCount: brief.inputInventory.filter(
          (source) => source.reportKind === "TERMINAL_RUNNER_SUMMARY",
        ).length,
        attributionReportCount: brief.inputInventory.filter(
          (source) => source.reportKind === "FAST_ENTRY_ATTRIBUTION_REPORT",
        ).length,
        candidateCount: brief.candidateEvidence.length,
        exactCoverageCount: brief.outcomeAnalysis.exactCoverageCount,
        labelCounts: brief.outcomeAnalysis.labelCounts,
        selectedRunSharesPct: sortRecord(brief.concentrationAndGates.selectedRunSharesPct),
        nonTargetRunSharesPct: sortRecord(brief.concentrationAndGates.nonTargetRunSharesPct),
        gates: [...brief.concentrationAndGates.gates].sort(compareByName),
        recordedConclusion: {
          status: brief.recordedConclusion.status,
          reason: brief.recordedConclusion.reason,
          sourceReport,
        },
      },
      reviewAssertions: [...record.reviewAssertions]
        .sort(compareByFactKey)
        .map((assertion) => ({ ...assertion, sourceReport })),
      outcome: {
        status: record.outcome.status,
        blockingReasons: [...record.outcome.blockingReasons].sort(),
      },
      nextPermittedAction,
      warnings: [
        "Later 3/5/15-minute outcomes are labels only and were not used as study-selection inputs.",
        "Generic candidate pre-registration validation is deferred; no candidate is present.",
      ],
    });
    const gate = researchReviewGateSchema.parse({
      ...draft,
      contentFingerprint: fingerprintResearchReviewGate(draft),
    });
    assertNoCredentialLikeValue(gate);
    return gate;
  }
}

export function parseResearchReviewRecord(value: unknown): ResearchReviewRecordV1 {
  const parsed = researchReviewRecordSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidRecord("The review record does not match the approved default-deny contract.");
  }
  assertNoCredentialLikeValue(parsed.data);
  return parsed.data;
}

export function canonicalResearchReviewGateJson(gate: ResearchReviewGateV1): string {
  return stableJson(withoutGeneratedAt(gate));
}

export function fingerprintResearchReviewGate(gate: ResearchReviewGateV1): string {
  return sha256(stableJson({ ...withoutGeneratedAt(gate), contentFingerprint: "" }));
}

function buildBrief(config: ResearchReviewGateConfig): ResearchBriefV1 {
  try {
    return new ResearchBriefService({ config: config.briefConfig }).build();
  } catch (error: unknown) {
    if (error instanceof ResearchBriefError) {
      const code =
        error.code === "RESEARCH_BRIEF_SOURCE_INCONSISTENCY"
          ? "RESEARCH_REVIEW_SOURCE_INCONSISTENCY"
          : error.code === "RESEARCH_BRIEF_UNSUPPORTED_REPORT" ||
              error.code === "RESEARCH_BRIEF_AMBIGUOUS_REPORT"
            ? "RESEARCH_REVIEW_UNSUPPORTED_EVIDENCE"
            : "RESEARCH_REVIEW_INVALID_SCOPE";
      throw new ResearchReviewGateError(code, "The selected archive evidence failed closed.");
    }
    throw error;
  }
}

function loadReviewRecord(config: ResearchReviewGateConfig): {
  readonly record: ResearchReviewRecordV1;
  readonly sha256: string;
} {
  const absolutePath = resolveResearchReviewRecord(config);
  const bytes = readFileSync(absolutePath);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw invalidRecord("The approved review record is not valid JSON.");
  }
  const recordSha256 = sha256(bytes);
  assertInitialReviewRecordSha256(recordSha256);
  return { record: parseResearchReviewRecord(raw), sha256: recordSha256 };
}

export function assertInitialReviewRecordSha256(value: string): void {
  if (value !== expectedInitialReviewRecordSha256) {
    throw sourceInconsistency("The approved initial review record hash does not match.");
  }
}

export function assertInitialEvidence(
  brief: ResearchBriefV1,
  record: ResearchReviewRecordV1,
): void {
  if (
    record.briefFingerprint !== expectedBriefFingerprint ||
    brief.contentFingerprint !== expectedBriefFingerprint
  ) {
    throw sourceInconsistency("The review record does not match the approved completed brief.");
  }
  if (!sameValue(record.scope, brief.scope)) {
    throw sourceInconsistency(
      "The review record scope does not match the approved completed brief.",
    );
  }
  if (
    brief.inputInventory.length !== 6 ||
    brief.inputInventory.filter((source) => source.reportKind === "TERMINAL_RUNNER_SUMMARY")
      .length !== 5 ||
    brief.inputInventory.filter((source) => source.reportKind === "FAST_ENTRY_ATTRIBUTION_REPORT")
      .length !== 1 ||
    brief.candidateEvidence.length !== 7 ||
    brief.outcomeAnalysis.exactCoverageCount !== 7 ||
    !sameValue(brief.outcomeAnalysis.labelCounts, {
      TARGET_FIRST: 3,
      STOP_FIRST: 3,
      MAX_HOLD: 1,
      NO_OBSERVATION: 0,
      AMBIGUOUS: 0,
    }) ||
    brief.concentrationAndGates.selectedRunSharesPct.Test3 !== 85.71428571428571 ||
    !sameValue(brief.concentrationAndGates.nonTargetRunSharesPct, { Test3: 100 }) ||
    brief.recordedConclusion.status !== "NO_DEFENSIBLE_HYPOTHESIS"
  ) {
    throw sourceInconsistency(
      "The approved brief no longer matches the fixed Phase 10.5 evidence.",
    );
  }
  const failedGates = brief.concentrationAndGates.gates
    .filter((gate) => !gate.passed)
    .map((gate) => gate.name)
    .sort();
  if (
    !sameValue(failedGates, [...failedGateNames]) ||
    !sameValue([...record.outcome.blockingReasons].sort(), [...failedGateNames])
  ) {
    throw sourceInconsistency("The review record does not preserve every failed attribution gate.");
  }
}

function assertNoCredentialLikeValue(value: unknown, location = "research review record"): void {
  if (typeof value === "string") {
    if (/\b(?:api[ _-]?key|authorization|bearer|private[ _-]?key|secret|password)\b/i.test(value)) {
      throw invalidRecord(`Credential-like content is not allowed at ${location}.`);
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

function withoutGeneratedAt(gate: ResearchReviewGateV1): Record<string, unknown> {
  return Object.fromEntries(Object.entries(gate).filter(([key]) => key !== "generatedAt"));
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

function sortRecord(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key] as number]),
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareByPath(left: { readonly path: string }, right: { readonly path: string }): number {
  return left.path.localeCompare(right.path);
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

function compareByFactKey(
  left: { readonly factKey: string },
  right: { readonly factKey: string },
): number {
  return left.factKey.localeCompare(right.factKey);
}

function invalidRecord(message: string): ResearchReviewGateError {
  return new ResearchReviewGateError("RESEARCH_REVIEW_INVALID_RECORD", message);
}

function sourceInconsistency(message: string): ResearchReviewGateError {
  return new ResearchReviewGateError("RESEARCH_REVIEW_SOURCE_INCONSISTENCY", message);
}
