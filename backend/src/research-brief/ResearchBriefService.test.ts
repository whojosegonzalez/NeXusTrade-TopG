import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { parseResearchBriefArgs, resolveResearchBriefArchiveRoot } from "./ResearchBriefConfig.js";
import { ResearchBriefCatalog } from "./ResearchBriefCatalog.js";
import { ResearchBriefError } from "./ResearchBriefErrors.js";
import { formatResearchBriefJson, formatResearchBriefMarkdown } from "./ResearchBriefFormatter.js";
import {
  ResearchBriefService,
  assertNoCredentialLikeValue,
  assertResearchBriefOutcomeLabels,
  canonicalResearchBriefJson,
  parseResearchBriefAttributionReport,
} from "./ResearchBriefService.js";

const config = parseResearchBriefArgs([
  "--archive-root=data/archive",
  "--include-phase=phase9.28",
  "--include-phase=phase9.29",
  "--include-cohort=phase9.29/combined-valid-three-20260818-1539",
]);

describe("ResearchBriefService", () => {
  it("builds the approved fixture deterministically without side effects", () => {
    const catalog = new ResearchBriefCatalog({
      archiveRoot: resolveResearchBriefArchiveRoot(config),
      config,
    });
    const sourcePaths = [
      ...catalog.discover().phase928RunnerSources,
      ...catalog.discover().phase929AttributionSources,
    ].map((source) => source.absolutePath);
    const before = new Map(
      sourcePaths.map((sourcePath) => [
        sourcePath,
        { sha256: hashFile(sourcePath), mtimeMs: fs.statSync(sourcePath).mtimeMs },
      ]),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const briefModuleSource = fs.readFileSync(
      new URL("./ResearchBriefService.ts", import.meta.url),
      "utf8",
    );
    const catalogModuleSource = fs.readFileSync(
      new URL("./ResearchBriefCatalog.ts", import.meta.url),
      "utf8",
    );

    try {
      const first = new ResearchBriefService({
        config,
        now: () => new Date("2026-08-19T08:00:00.000Z"),
      }).build();
      const second = new ResearchBriefService({
        config,
        now: () => new Date("2026-08-19T08:15:00.000Z"),
      }).build();

      expect(first.generatedAt).not.toBe(second.generatedAt);
      expect(first.contentFingerprint).toBe(second.contentFingerprint);
      expect(canonicalResearchBriefJson(first)).toBe(canonicalResearchBriefJson(second));
      expect(removeGeneratedAt(JSON.parse(formatResearchBriefJson(first)))).toEqual(
        removeGeneratedAt(JSON.parse(formatResearchBriefJson(second))),
      );
      expect(removeMarkdownAuditLine(formatResearchBriefMarkdown(first))).toBe(
        removeMarkdownAuditLine(formatResearchBriefMarkdown(second)),
      );
      expect(first.runInventory).toHaveLength(5);
      expect(first.inputInventory).toHaveLength(6);
      expect(first.candidateEvidence).toHaveLength(7);
      expect(first.outcomeAnalysis).toMatchObject({
        exactCoverageCount: 7,
        labelCounts: { TARGET_FIRST: 3, STOP_FIRST: 3, MAX_HOLD: 1 },
      });
      expect(first.concentrationAndGates.selectedRunSharesPct.Test3).toBeCloseTo(85.71428571428571);
      expect(first.concentrationAndGates.nonTargetRunSharesPct).toEqual({ Test3: 100 });
      expect(first.recordedConclusion.status).toBe("NO_DEFENSIBLE_HYPOTHESIS");
      expect(
        first.candidateEvidence.every(
          (candidate) =>
            !Object.hasOwn(candidate, "outcomeLabel") &&
            candidate.decisionTimeFacts.every(
              (feature) =>
                feature.availability === "AVAILABLE_AT_DECISION_TIME" ||
                feature.value === undefined,
            ),
        ),
      ).toBe(true);
      expect(JSON.stringify(first.candidateEvidence)).not.toContain("providerPressure");
      expect(
        first.providerPressureContext.some((provider) => provider.provider === "JUPITER"),
      ).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(briefModuleSource).not.toMatch(/writeFileSync|mkdirSync|appendFileSync|rmSync/);
      expect(catalogModuleSource).not.toMatch(/writeFileSync|mkdirSync|appendFileSync|rmSync/);
      for (const [sourcePath, snapshot] of before) {
        expect(hashFile(sourcePath)).toBe(snapshot.sha256);
        expect(fs.statSync(sourcePath).mtimeMs).toBe(snapshot.mtimeMs);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps decision-time evidence before separate later labels in Markdown", () => {
    const brief = new ResearchBriefService({
      config,
      now: () => new Date("2026-08-19T08:00:00.000Z"),
    }).build();
    const markdown = formatResearchBriefMarkdown(brief);
    const decisionTimeSection = markdown.split("## Outcome analysis (labels only)")[0] ?? "";

    expect(markdown.indexOf("## Decision-time evidence")).toBeLessThan(
      markdown.indexOf("## Outcome analysis (labels only)"),
    );
    expect(decisionTimeSection).not.toContain("TARGET_FIRST");
    expect(markdown).toContain("Later observations; not entry inputs.");
    expect(markdown).toContain("## Next permitted action");
    expect(JSON.parse(formatResearchBriefJson(brief)).contentFingerprint).toBe(
      brief.contentFingerprint,
    );
    expect(markdown).toContain(brief.contentFingerprint);
  });

  it("returns data-insufficient only for a valid scope that omits attribution evidence", () => {
    const phase928Only = parseResearchBriefArgs([
      "--archive-root=data/archive",
      "--include-phase=phase9.28",
    ]);
    const brief = new ResearchBriefService({
      config: phase928Only,
      now: () => new Date("2026-08-19T08:00:00.000Z"),
    }).build();

    expect(brief.recordedConclusion.status).toBe("DATA_INSUFFICIENT");
    expect(brief.candidateEvidence).toEqual([]);
    expect(brief.outcomeAnalysis.labels).toEqual([]);
  });

  it("fails closed before formatting credential-like normalized content", () => {
    expect(() => assertNoCredentialLikeValue({ value: "Bearer should-not-export" })).toThrow(
      ResearchBriefError,
    );
    try {
      assertNoCredentialLikeValue({ value: "Bearer should-not-export" });
    } catch (error: unknown) {
      expect((error as ResearchBriefError).code).toBe("RESEARCH_BRIEF_UNSUPPORTED_REPORT");
    }
  });

  it("uses bounded unsupported-report and source-inconsistency errors", () => {
    expectErrorCode(
      () => parseResearchBriefAttributionReport({ profile: {} }, "phase9.29/not-supported.json"),
      "RESEARCH_BRIEF_UNSUPPORTED_REPORT",
    );
    expectErrorCode(
      () =>
        assertResearchBriefOutcomeLabels(
          {
            TARGET_FIRST: 3,
            STOP_FIRST: 3,
            MAX_HOLD: 1,
            NO_OBSERVATION: 0,
            AMBIGUOUS: 0,
          },
          ["TARGET_FIRST"],
        ),
      "RESEARCH_BRIEF_SOURCE_INCONSISTENCY",
    );
  });
});

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function expectErrorCode(action: () => unknown, code: ResearchBriefError["code"]): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResearchBriefError);
    expect((error as ResearchBriefError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}

function removeGeneratedAt(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "generatedAt"));
}

function removeMarkdownAuditLine(value: string): string {
  return value
    .split("\n")
    .filter((line) => !line.startsWith("- Generated at (audit only):"))
    .join("\n");
}
