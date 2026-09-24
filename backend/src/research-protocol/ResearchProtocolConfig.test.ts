import { describe, expect, it } from "vitest";

import {
  EXPLORATORY_PROTOCOL_V2_PATH,
  INITIAL_EXPLORATORY_PROTOCOL_PATH,
} from "./ResearchProtocolConstants.js";
import { parseResearchProtocolArgs, resolveResearchProtocol } from "./ResearchProtocolConfig.js";
import { ResearchProtocolError } from "./ResearchProtocolErrors.js";

const validArgs = [`--protocol=${INITIAL_EXPLORATORY_PROTOCOL_PATH}`] as const;

describe("parseResearchProtocolArgs", () => {
  it("accepts only the approved protocol, optional format, and one compatibility once", () => {
    const config = parseResearchProtocolArgs(validArgs);

    expect(config).toMatchObject({
      protocol: INITIAL_EXPLORATORY_PROTOCOL_PATH,
      format: "markdown",
      once: false,
    });
    expect(resolveResearchProtocol(config)).toMatch(
      /docs[\\/]research-protocols[\\/]phase10\.6a-exploratory-cohort\.v1\.json$/,
    );
    expect(parseResearchProtocolArgs([...validArgs, "--format=json", "--once"])).toMatchObject({
      format: "json",
      once: true,
    });
    const v2Config = parseResearchProtocolArgs([`--protocol=${EXPLORATORY_PROTOCOL_V2_PATH}`]);
    expect(v2Config.protocol).toBe(EXPLORATORY_PROTOCOL_V2_PATH);
    expect(resolveResearchProtocol(v2Config)).toMatch(
      /docs[\\/]research-protocols[\\/]phase10\.6a-exploratory-cohort\.v2\.json$/,
    );
  });

  it("rejects missing, duplicate, traversal-shaped, URL-shaped, and unsupported protocol scope", () => {
    expectCode(() => parseResearchProtocolArgs([]), "RESEARCH_PROTOCOL_INVALID_SCOPE");
    for (const rejected of [
      "--protocol=docs/research-protocols/../phase10.6a-exploratory-cohort.v1.json",
      "--protocol=https://example.test/protocol.json",
      "--protocol=docs/research-protocols/other.v1.json",
      `--protocol=${INITIAL_EXPLORATORY_PROTOCOL_PATH}`,
    ]) {
      expectCode(
        () => parseResearchProtocolArgs([...validArgs, rejected]),
        "RESEARCH_PROTOCOL_INVALID_SCOPE",
      );
    }
    expectCode(
      () => parseResearchProtocolArgs([...validArgs, "--once", "--once"]),
      "RESEARCH_PROTOCOL_INVALID_SCOPE",
    );
    expectCode(
      () => parseResearchProtocolArgs([...validArgs, "--format=json", "--format=markdown"]),
      "RESEARCH_PROTOCOL_INVALID_SCOPE",
    );
  });

  it("rejects write, database, provider, runtime, and execution option families", () => {
    for (const rejected of [
      "--output=validation.md",
      "--database=data/nexus_paper.db",
      "--provider=DISCOVERY",
      "--runtime=terminal",
      "--strategy=F65E",
      "--threshold=1",
      "--observation=3m",
      "--monitor=1",
      "--wallet=loaded",
      "--sign=true",
      "--submit=true",
      "--paper=buy",
      "--url=https://example.test",
      "--http=true",
    ]) {
      expectCode(
        () => parseResearchProtocolArgs([...validArgs, rejected]),
        "RESEARCH_PROTOCOL_INVALID_SCOPE",
      );
    }
  });
});

function expectCode(action: () => unknown, code: ResearchProtocolError["code"]): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResearchProtocolError);
    expect((error as ResearchProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}.`);
}
