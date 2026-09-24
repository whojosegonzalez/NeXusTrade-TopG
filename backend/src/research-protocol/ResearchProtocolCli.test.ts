import { describe, expect, it } from "vitest";

import { INITIAL_EXPLORATORY_PROTOCOL_PATH } from "./ResearchProtocolConstants.js";
import { formatResearchProtocolError } from "./ResearchProtocolErrors.js";
import { runResearchProtocolCli } from "./ResearchProtocolCli.js";

const validArgs = [`--protocol=${INITIAL_EXPLORATORY_PROTOCOL_PATH}`, "--format=json"] as const;

describe("runResearchProtocolCli", () => {
  it("writes one non-authorizing JSON validation to the supplied stdout writer only", () => {
    const output: string[] = [];
    const validation = runResearchProtocolCli(validArgs, (value) => output.push(value));

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] as string)).toMatchObject({
      contentFingerprint: validation.contentFingerprint,
      outcome: { status: "PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL" },
      safety: { providerCalls: 0, filesystemWrites: 0, orders: 0 },
    });
  });

  it("formats unsafe scope as exactly one bounded public error code", () => {
    const output: string[] = [];
    try {
      runResearchProtocolCli([...validArgs, "--output=validation.md"], (value) =>
        output.push(value),
      );
    } catch (error: unknown) {
      expect(formatResearchProtocolError(error).match(/RESEARCH_PROTOCOL_[A-Z_]+/g)).toEqual([
        "RESEARCH_PROTOCOL_INVALID_SCOPE",
      ]);
      expect(output).toEqual([]);
      return;
    }
    throw new Error("Expected an invalid-scope error.");
  });
});
