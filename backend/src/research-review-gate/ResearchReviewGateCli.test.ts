import { describe, expect, it } from "vitest";

import { INITIAL_REVIEW_COHORT, INITIAL_REVIEW_RECORD_PATH } from "./ResearchReviewGateConfig.js";
import { formatResearchReviewGateError } from "./ResearchReviewGateErrors.js";
import { runResearchReviewGateCli } from "./ResearchReviewGateCli.js";

const validArgs = [
  "--archive-root=data/archive",
  "--include-phase=phase9.28",
  "--include-phase=phase9.29",
  `--include-cohort=${INITIAL_REVIEW_COHORT}`,
  `--review-record=${INITIAL_REVIEW_RECORD_PATH}`,
  "--format=json",
];

describe("runResearchReviewGateCli", () => {
  it("writes one JSON default-deny gate to the supplied stdout writer only", () => {
    const output: string[] = [];
    const gate = runResearchReviewGateCli(validArgs, (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      contentFingerprint: gate.contentFingerprint,
      outcome: { status: "NO_STUDY_AUTHORIZED" },
    });
  });

  it("formats unsafe scope as exactly one bounded public error code", () => {
    const output: string[] = [];
    try {
      runResearchReviewGateCli([...validArgs, "--output=gate.md"], (value) => output.push(value));
    } catch (error: unknown) {
      expect(formatResearchReviewGateError(error).match(/RESEARCH_REVIEW_[A-Z_]+/g)).toEqual([
        "RESEARCH_REVIEW_INVALID_SCOPE",
      ]);
      expect(output).toEqual([]);
      return;
    }
    throw new Error("Expected an invalid-scope error.");
  });
});
