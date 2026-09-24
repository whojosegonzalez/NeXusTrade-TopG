import { describe, expect, it } from "vitest";

import {
  INITIAL_REVIEW_COHORT,
  INITIAL_REVIEW_RECORD_PATH,
  parseResearchReviewGateArgs,
  resolveResearchReviewRecord,
} from "./ResearchReviewGateConfig.js";
import { ResearchReviewGateError } from "./ResearchReviewGateErrors.js";

const validArgs = [
  "--archive-root=data/archive",
  "--include-phase=phase9.28",
  "--include-phase=phase9.29",
  `--include-cohort=${INITIAL_REVIEW_COHORT}`,
  `--review-record=${INITIAL_REVIEW_RECORD_PATH}`,
] as const;

describe("parseResearchReviewGateArgs", () => {
  it("accepts only the explicit initial archive scope and review record", () => {
    const config = parseResearchReviewGateArgs(validArgs);

    expect(config).toMatchObject({
      reviewRecord: INITIAL_REVIEW_RECORD_PATH,
      format: "markdown",
      briefConfig: {
        archiveRoot: "data/archive",
        includePhases: ["phase9.28", "phase9.29"],
        includeCohorts: [INITIAL_REVIEW_COHORT],
      },
    });
    expect(resolveResearchReviewRecord(config)).toMatch(
      /docs[\\/]research-reviews[\\/]phase10\.5-initial\.v1\.json$/,
    );
    expect(parseResearchReviewGateArgs([...validArgs, "--once"])).toMatchObject({
      briefConfig: { once: true },
    });
  });

  it("rejects scope changes, traversal, duplicate records, and absent records", () => {
    expectCode(() => parseResearchReviewGateArgs([]), "RESEARCH_REVIEW_INVALID_SCOPE");
    expectCode(
      () =>
        parseResearchReviewGateArgs(validArgs.filter((arg) => !arg.startsWith("--review-record="))),
      "RESEARCH_REVIEW_INVALID_SCOPE",
    );
    for (const rejected of [
      "--include-phase=phase9.28",
      "--include-cohort=phase9.29/other",
      "--review-record=docs/research-reviews/../phase10.5-initial.v1.json",
      "--review-record=https://example.test/review.json",
      `--review-record=${INITIAL_REVIEW_RECORD_PATH}`,
    ]) {
      expectCode(
        () => parseResearchReviewGateArgs([...validArgs, rejected]),
        "RESEARCH_REVIEW_INVALID_SCOPE",
      );
    }
    expectCode(
      () => parseResearchReviewGateArgs([...validArgs, "--once", "--once"]),
      "RESEARCH_REVIEW_INVALID_SCOPE",
    );
  });

  it("rejects write, database, provider, runtime, and execution option families", () => {
    for (const rejected of [
      "--output=gate.md",
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
      expectCode(
        () => parseResearchReviewGateArgs([...validArgs, rejected]),
        "RESEARCH_REVIEW_INVALID_SCOPE",
      );
    }
  });
});

function expectCode(action: () => unknown, code: ResearchReviewGateError["code"]): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResearchReviewGateError);
    expect((error as ResearchReviewGateError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}
