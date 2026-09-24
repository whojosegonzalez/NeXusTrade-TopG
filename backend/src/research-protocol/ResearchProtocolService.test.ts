import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  EXPLORATORY_PROTOCOL_V2_PATH,
  EXPLORATORY_PROTOCOL_V2_SHA256,
  INITIAL_EXPLORATORY_PROTOCOL_PATH,
  INITIAL_EXPLORATORY_PROTOCOL_SHA256,
} from "./ResearchProtocolConstants.js";
import { parseResearchProtocolArgs } from "./ResearchProtocolConfig.js";
import { ResearchProtocolError } from "./ResearchProtocolErrors.js";
import { formatResearchProtocolValidationMarkdown } from "./ResearchProtocolFormatter.js";
import { getResearchProtocolRepoRoot } from "./ResearchProtocolPaths.js";
import {
  ResearchProtocolService,
  assertInitialProtocolSha256,
  canonicalResearchProtocolValidationJson,
  parseExploratoryCohortProtocol,
} from "./ResearchProtocolService.js";
import type { ExploratoryCohortProtocolV1 } from "./ResearchProtocolTypes.js";

const config = parseResearchProtocolArgs([`--protocol=${INITIAL_EXPLORATORY_PROTOCOL_PATH}`]);
const v2Config = parseResearchProtocolArgs([`--protocol=${EXPLORATORY_PROTOCOL_V2_PATH}`]);

describe("ResearchProtocolService", () => {
  it("validates the frozen protocol deterministically without side effects", () => {
    const protocolPath = path.join(
      getResearchProtocolRepoRoot(),
      INITIAL_EXPLORATORY_PROTOCOL_PATH,
    );
    const before = {
      sha256: hashFile(protocolPath),
      mtimeMs: fs.statSync(protocolPath).mtimeMs,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const moduleSource = fs.readFileSync(
      new URL("./ResearchProtocolService.ts", import.meta.url),
      "utf8",
    );

    try {
      const first = new ResearchProtocolService({
        config,
        now: () => new Date("2026-08-19T09:00:00.000Z"),
      }).build();
      const second = new ResearchProtocolService({
        config,
        now: () => new Date("2026-08-19T09:15:00.000Z"),
      }).build();

      expect(first.generatedAt).not.toBe(second.generatedAt);
      expect(first.contentFingerprint).toBe(second.contentFingerprint);
      expect(canonicalResearchProtocolValidationJson(first)).toBe(
        canonicalResearchProtocolValidationJson(second),
      );
      expect(first.protocol).toMatchObject({
        path: INITIAL_EXPLORATORY_PROTOCOL_PATH,
        sha256: INITIAL_EXPLORATORY_PROTOCOL_SHA256,
        protocolId: "EXPLORATORY_COHORT@v1",
        authorityStatus: "NOT_AUTHORIZED_FOR_COLLECTION",
      });
      expect(first.outcome).toEqual({
        status: "PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL",
        authority: "NON_AUTHORIZING",
      });
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
      expect(hashFile(protocolPath)).toBe(before.sha256);
      expect(fs.statSync(protocolPath).mtimeMs).toBe(before.mtimeMs);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("renders the non-authorizing outcome after safety and before the next permitted action", () => {
    const validation = new ResearchProtocolService({ config, now: fixedClock }).build();
    const markdown = formatResearchProtocolValidationMarkdown(validation);

    expect(markdown.indexOf("## Safety")).toBeLessThan(markdown.indexOf("## Outcome"));
    expect(markdown.indexOf("## Outcome")).toBeLessThan(
      markdown.indexOf("## Next permitted action"),
    );
    expect(markdown).toContain("PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL");
    expect(markdown).toContain("NOT_AUTHORIZED_FOR_COLLECTION");
    expect(markdown).not.toContain("TARGET_FIRST");
  });

  it("validates the superseding V2 protocol with its distinct immutable identity and full attempted-slot caps", () => {
    const validation = new ResearchProtocolService({ config: v2Config, now: fixedClock }).build();
    const raw = readProtocol(EXPLORATORY_PROTOCOL_V2_PATH);

    expect(validation.protocol).toMatchObject({
      path: EXPLORATORY_PROTOCOL_V2_PATH,
      sha256: EXPLORATORY_PROTOCOL_V2_SHA256,
      protocolId: "EXPLORATORY_COHORT@v2",
      authorityStatus: "NOT_AUTHORIZED_FOR_COLLECTION",
    });
    expect(raw.supersedes).toEqual({
      protocolPath: INITIAL_EXPLORATORY_PROTOCOL_PATH,
      protocolSha256: INITIAL_EXPLORATORY_PROTOCOL_SHA256,
      reason: "REQUEST_CAPS_COVER_ALL_168_ATTEMPTED_SLOTS_WITHOUT_RETRY_OR_FALLBACK",
    });
    expect(raw.providerBudgetPlan.cohortRequestCaps).toEqual({
      DISCOVERY: 168,
      MARKET_CONTEXT: 168,
      QUOTE_IMPACT: 168,
      LATER_OBSERVATION: 672,
    });
  });

  it("rejects unknown fields, candidate data, placeholders, unsafe text, and altered initial hashes", () => {
    const raw = readInitialProtocol();
    const invalidRecords: unknown[] = [
      { ...raw, candidatePreRegistration: {} },
      { ...raw, unknown: true },
      {
        ...raw,
        purpose: { ...raw.purpose, designQuestion: "Bearer should-not-appear" },
      },
      {
        ...raw,
        purpose: { ...raw.purpose, designQuestion: "TBD" },
      },
      {
        ...raw,
        population: {
          ...raw.population,
          forbiddenInputs: [...raw.population.forbiddenInputs, "--output=unsafe"],
        },
      },
      {
        ...raw,
        decisionTimeSchema: {
          ...raw.decisionTimeSchema,
          fieldValueTypes: {
            ...raw.decisionTimeSchema.fieldValueTypes,
            "quote.available": "FINITE_NUMBER",
          },
        },
      },
      {
        ...raw,
        authorityStatus: "PROTOCOL_READY_FOR_SEPARATE_COLLECTION_APPROVAL",
      },
    ];
    for (const invalid of invalidRecords) {
      expectInvalidRecord(() => parseExploratoryCohortProtocol(invalid));
    }
    expectSourceInconsistency(() => assertInitialProtocolSha256("0".repeat(64)));
  });
});

function fixedClock(): Date {
  return new Date("2026-08-19T09:00:00.000Z");
}

function readInitialProtocol(): ExploratoryCohortProtocolV1 {
  return readProtocol(INITIAL_EXPLORATORY_PROTOCOL_PATH);
}

function readProtocol(protocolPath: string): ExploratoryCohortProtocolV1 {
  return JSON.parse(
    fs.readFileSync(path.join(getResearchProtocolRepoRoot(), protocolPath), "utf8"),
  ) as ExploratoryCohortProtocolV1;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function expectInvalidRecord(action: () => unknown): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResearchProtocolError);
    expect((error as ResearchProtocolError).code).toBe("RESEARCH_PROTOCOL_INVALID_RECORD");
    return;
  }
  throw new Error("Expected RESEARCH_PROTOCOL_INVALID_RECORD.");
}

function expectSourceInconsistency(action: () => unknown): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResearchProtocolError);
    expect((error as ResearchProtocolError).code).toBe("RESEARCH_PROTOCOL_SOURCE_INCONSISTENCY");
    return;
  }
  throw new Error("Expected RESEARCH_PROTOCOL_SOURCE_INCONSISTENCY.");
}
