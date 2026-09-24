import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { getResearchBriefRepoRoot } from "../research-brief/ResearchBriefPaths.js";
import { ResearchBriefService } from "../research-brief/ResearchBriefService.js";
import {
  INITIAL_REVIEW_COHORT,
  INITIAL_REVIEW_RECORD_PATH,
  parseResearchReviewGateArgs,
} from "./ResearchReviewGateConfig.js";
import { ResearchReviewGateError } from "./ResearchReviewGateErrors.js";
import { formatResearchReviewGateMarkdown } from "./ResearchReviewGateFormatter.js";
import {
  ResearchReviewGateService,
  assertInitialReviewRecordSha256,
  assertInitialEvidence,
  canonicalResearchReviewGateJson,
  parseResearchReviewRecord,
} from "./ResearchReviewGateService.js";
import type { ResearchReviewRecordV1 } from "./ResearchReviewGateTypes.js";

const config = parseResearchReviewGateArgs([
  "--archive-root=data/archive",
  "--include-phase=phase9.28",
  "--include-phase=phase9.29",
  `--include-cohort=${INITIAL_REVIEW_COHORT}`,
  `--review-record=${INITIAL_REVIEW_RECORD_PATH}`,
]);

describe("ResearchReviewGateService", () => {
  it("builds the fixed default-deny gate deterministically without side effects", () => {
    const repoRoot = getResearchBriefRepoRoot();
    const sourcePaths = [
      ...new ResearchReviewGateService({ config, now: fixedClock })
        .build()
        .inputInventory.map((source) =>
          path.join(
            repoRoot,
            source.path.startsWith("docs/")
              ? source.path
              : path.join("data", "archive", source.path),
          ),
        ),
    ];
    const before = new Map(
      sourcePaths.map((sourcePath) => [
        sourcePath,
        { sha256: hashFile(sourcePath), mtimeMs: fs.statSync(sourcePath).mtimeMs },
      ]),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const moduleSource = fs.readFileSync(
      new URL("./ResearchReviewGateService.ts", import.meta.url),
      "utf8",
    );

    try {
      const first = new ResearchReviewGateService({
        config,
        now: () => new Date("2026-08-19T08:30:00.000Z"),
      }).build();
      const second = new ResearchReviewGateService({
        config,
        now: () => new Date("2026-08-19T08:45:00.000Z"),
      }).build();

      expect(first.generatedAt).not.toBe(second.generatedAt);
      expect(first.contentFingerprint).toBe(second.contentFingerprint);
      expect(canonicalResearchReviewGateJson(first)).toBe(canonicalResearchReviewGateJson(second));
      expect(first.evidenceSummary).toMatchObject({
        sourceCount: 6,
        runnerSummaryCount: 5,
        attributionReportCount: 1,
        candidateCount: 7,
        exactCoverageCount: 7,
        labelCounts: { TARGET_FIRST: 3, STOP_FIRST: 3, MAX_HOLD: 1 },
        selectedRunSharesPct: { Test3: 85.71428571428571 },
        nonTargetRunSharesPct: { Test3: 100 },
        recordedConclusion: { status: "NO_DEFENSIBLE_HYPOTHESIS" },
      });
      expect(first.outcome.status).toBe("NO_STUDY_AUTHORIZED");
      expect(first.outcome.blockingReasons).toHaveLength(7);
      expect(first.reviewAssertions).toHaveLength(7);
      expect(Object.hasOwn(first, "candidatePreRegistration")).toBe(false);
      expect(first.safety).toMatchObject({
        providerCalls: 0,
        httpCalls: 0,
        databaseReads: 0,
        databaseWrites: 0,
        filesystemWrites: 0,
        runtimeCommands: 0,
        orders: 0,
        fills: 0,
        positions: 0,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(moduleSource).not.toMatch(/writeFileSync|mkdirSync|appendFileSync|rmSync/);
      for (const [sourcePath, snapshot] of before) {
        expect(hashFile(sourcePath)).toBe(snapshot.sha256);
        expect(fs.statSync(sourcePath).mtimeMs).toBe(snapshot.mtimeMs);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("renders decision-time boundary before the default-deny outcome", () => {
    const gate = new ResearchReviewGateService({ config, now: fixedClock }).build();
    const markdown = formatResearchReviewGateMarkdown(gate);
    const decisionBoundary = (markdown.split("## Decision-time evidence boundary")[1] ?? "").split(
      "## Human review assertions",
    )[0];

    expect(markdown.indexOf("## Decision-time evidence boundary")).toBeLessThan(
      markdown.indexOf("## Outcome"),
    );
    expect(decisionBoundary).not.toContain("TARGET_FIRST");
    expect(markdown).toContain("NO_STUDY_AUTHORIZED");
    expect(markdown).toContain("ABSENT. Generic candidate validation is deferred");
    expect(markdown).toContain(gate.contentFingerprint);
  });

  it("rejects unknown fields, candidate data, non-default outcomes, and unsafe notes", () => {
    const raw = readInitialRecord();
    const invalidRecords: unknown[] = [
      { ...raw, candidatePreRegistration: {} },
      { ...raw, unexpected: true },
      { ...raw, outcome: { ...raw.outcome, status: "HUMAN_REVIEW_REQUIRED" } },
      {
        ...raw,
        reviewAssertions: [
          { ...raw.reviewAssertions[0], note: "Bearer should-not-appear" },
          ...raw.reviewAssertions.slice(1),
        ],
      },
      {
        ...raw,
        reviewAssertions: [
          { ...raw.reviewAssertions[0], assertionCode: "CONFIRMS_PROHIBITION" },
          ...raw.reviewAssertions.slice(1),
        ],
      },
      {
        ...raw,
        reviewAssertions: [
          { ...raw.reviewAssertions[0], note: "unsafe\nmarkdown" },
          ...raw.reviewAssertions.slice(1),
        ],
      },
    ];
    for (const invalid of invalidRecords) {
      expectInvalidRecord(() => parseResearchReviewRecord(invalid));
    }
  });

  it("fails closed when the reviewed scope or completed-brief fingerprint changes", () => {
    const brief = new ResearchBriefService({ config: config.briefConfig, now: fixedClock }).build();
    const record = parseResearchReviewRecord(readInitialRecord());

    expectSourceInconsistency(() =>
      assertInitialEvidence({ ...brief, contentFingerprint: "0".repeat(64) }, record),
    );
    expectSourceInconsistency(() =>
      assertInitialEvidence(brief, {
        ...record,
        scope: { ...record.scope, includeCohorts: ["phase9.29/other"] },
      }),
    );
    expectSourceInconsistency(() => assertInitialReviewRecordSha256("0".repeat(64)));
  });
});

function fixedClock(): Date {
  return new Date("2026-08-19T08:00:00.000Z");
}

function readInitialRecord(): ResearchReviewRecordV1 {
  return JSON.parse(
    fs.readFileSync(path.join(getResearchBriefRepoRoot(), INITIAL_REVIEW_RECORD_PATH), "utf8"),
  ) as ResearchReviewRecordV1;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function expectInvalidRecord(action: () => unknown): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResearchReviewGateError);
    expect((error as ResearchReviewGateError).code).toBe("RESEARCH_REVIEW_INVALID_RECORD");
    return;
  }
  throw new Error("Expected RESEARCH_REVIEW_INVALID_RECORD.");
}

function expectSourceInconsistency(action: () => unknown): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResearchReviewGateError);
    expect((error as ResearchReviewGateError).code).toBe("RESEARCH_REVIEW_SOURCE_INCONSISTENCY");
    return;
  }
  throw new Error("Expected RESEARCH_REVIEW_SOURCE_INCONSISTENCY.");
}
