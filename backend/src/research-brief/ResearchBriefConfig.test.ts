import { describe, expect, it } from "vitest";

import { parseResearchBriefArgs, resolveResearchBriefArchiveRoot } from "./ResearchBriefConfig.js";
import { ResearchBriefError } from "./ResearchBriefErrors.js";

const validArgs = [
  "--archive-root=data/archive",
  "--include-phase=phase9.28",
  "--include-phase=phase9.29",
  "--include-cohort=phase9.29/combined-valid-three-20260818-1539",
] as const;

describe("parseResearchBriefArgs", () => {
  it("requires the explicit canonical archive scope and defaults to Markdown", () => {
    expect(parseResearchBriefArgs(validArgs)).toEqual({
      archiveRoot: "data/archive",
      includePhases: ["phase9.28", "phase9.29"],
      includeCohorts: ["phase9.29/combined-valid-three-20260818-1539"],
      format: "markdown",
      once: false,
    });
    expect(resolveResearchBriefArchiveRoot(parseResearchBriefArgs(validArgs))).toMatch(
      /data[\\/]archive$/,
    );
  });

  it("returns stable bounded error codes for invalid and ambiguous scope", () => {
    expectErrorCode(() => parseResearchBriefArgs([]), "RESEARCH_BRIEF_INVALID_SCOPE");
    expectErrorCode(
      () => parseResearchBriefArgs([...validArgs, "--include-phase=phase9.28"]),
      "RESEARCH_BRIEF_INVALID_SCOPE",
    );
    expectErrorCode(
      () => parseResearchBriefArgs(validArgs.filter((arg) => !arg.startsWith("--include-cohort="))),
      "RESEARCH_BRIEF_AMBIGUOUS_REPORT",
    );
    expectErrorCode(
      () => parseResearchBriefArgs([...validArgs, "--archive-root=data/../data/archive"]),
      "RESEARCH_BRIEF_INVALID_SCOPE",
    );
    expectErrorCode(
      () => parseResearchBriefArgs([...validArgs, "--include-phase=phase9.30"]),
      "RESEARCH_BRIEF_INVALID_SCOPE",
    );
  });

  it("rejects every write, database, network, runtime, and execution input family", () => {
    for (const rejected of [
      "--output=brief.md",
      "--database=data/nexus_paper.db",
      "--provider=JUPITER",
      "--runtime=terminal",
      "--strategy=F65E",
      "--threshold=1",
      "--monitor=1",
      "--wallet=loaded",
      "--sign=true",
      "--submit=true",
      "--paper=buy",
      "--url=https://example.test",
    ]) {
      expectErrorCode(
        () => parseResearchBriefArgs([...validArgs, rejected]),
        "RESEARCH_BRIEF_INVALID_SCOPE",
      );
    }
  });

  it("accepts JSON and the compatibility one-shot no-op without adding a loop", () => {
    expect(parseResearchBriefArgs([...validArgs, "--format=json", "--once"])).toMatchObject({
      format: "json",
      once: true,
    });
  });
});

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
