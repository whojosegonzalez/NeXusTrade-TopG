import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXPLORATORY_ANALYSIS_ARCHIVE_ROOT,
  parseExploratoryCohortAnalysisArgs,
} from "./ExploratoryCohortAnalysisConfig.js";
import { ExploratoryCohortArchiveLoader } from "./ExploratoryCohortArchiveLoader.js";
import { ExploratoryCohortAnalysisError } from "./ExploratoryCohortAnalysisErrors.js";
import {
  formatExploratoryCohortAnalysisJson,
  formatExploratoryCohortAnalysisMarkdown,
} from "./ExploratoryCohortAnalysisFormatter.js";
import {
  exploratoryCohortAnalysisArtifactNames,
  type ExploratoryCohortAnalysisArchiveIdentity,
} from "./ExploratoryCohortAnalysisIdentity.js";
import { runExploratoryCohortAnalysisCli } from "./ExploratoryCohortAnalysisCli.js";
import { ExploratoryCohortAnalysisService } from "./ExploratoryCohortAnalysisService.js";

const roots: string[] = [];
const protocolSource = path.resolve(
  "..",
  "docs",
  "research-protocols",
  "phase10.6a-exploratory-cohort.v2.json",
);
const protocolSha256 = "2662a4cbc1d3458d55b64f9c4cc826561aad1cb6f6b5faf11079194377f5a0ed";

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("ExploratoryCohortAnalysis", () => {
  it("accepts only the named archive and one compatibility --once", () => {
    expect(
      parseExploratoryCohortAnalysisArgs([
        `--archive-root=${EXPLORATORY_ANALYSIS_ARCHIVE_ROOT}`,
        "--format=json",
        "--once",
      ]),
    ).toEqual({ archiveRoot: EXPLORATORY_ANALYSIS_ARCHIVE_ROOT, format: "json", once: true });
    expect(() =>
      parseExploratoryCohortAnalysisArgs([
        `--archive-root=${EXPLORATORY_ANALYSIS_ARCHIVE_ROOT}`,
        "--once",
        "--once",
      ]),
    ).toThrow(/at most once/);
    expectAnalysisError(
      () =>
        parseExploratoryCohortAnalysisArgs([
          `--archive-root=${EXPLORATORY_ANALYSIS_ARCHIVE_ROOT}`,
          "--paper=true",
        ]),
      "EXPLORATORY_ANALYSIS_INVALID_SCOPE",
    );
    expectAnalysisError(
      () =>
        parseExploratoryCohortAnalysisArgs([
          `--archive-root=${EXPLORATORY_ANALYSIS_ARCHIVE_ROOT}`,
          `--archive-identity=${"0".repeat(64)}`,
        ]),
      "EXPLORATORY_ANALYSIS_INVALID_SCOPE",
    );
    let stdoutWrites = 0;
    expectAnalysisError(
      () =>
        runExploratoryCohortAnalysisCli(
          [`--archive-root=${EXPLORATORY_ANALYSIS_ARCHIVE_ROOT}`, "--provider=DEXSCREENER"],
          () => {
            stdoutWrites += 1;
          },
        ),
      "EXPLORATORY_ANALYSIS_INVALID_SCOPE",
    );
    expect(stdoutWrites).toBe(0);
  });

  it("returns the sole non-authorizing ready result only from the frozen held-validation rule", () => {
    const fixture = createFixture({ mode: "READY" });
    const analysis = buildFixtureAnalysis(fixture);
    expect(analysis.outcome.status).toBe("PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL");
    expect(analysis.archiveIdentity.status).toBe("MATCHED");
    expect(analysis.selectedDiscoveryRule).toBe("AGE__HIGH_V1");
    expect(analysis.catalogLedger).toHaveLength(14);
    expect(analysis.catalogLedger.map((entry) => entry.catalogRuleId)).toEqual([
      "AGE__LOW_V1",
      "AGE__HIGH_V1",
      "LIQUIDITY__LOW_V1",
      "LIQUIDITY__HIGH_V1",
      "VOLUME_5M__LOW_V1",
      "VOLUME_5M__HIGH_V1",
      "VOLUME_1H__LOW_V1",
      "VOLUME_1H__HIGH_V1",
      "MOMENTUM_5M__LOW_V1",
      "MOMENTUM_5M__HIGH_V1",
      "MOMENTUM_15M__LOW_V1",
      "MOMENTUM_15M__HIGH_V1",
      "QUOTE_IMPACT__LOW_V1",
      "QUOTE_IMPACT__HIGH_V1",
    ]);
    expect(
      analysis.catalogLedger.find((entry) => entry.catalogRuleId === "AGE__HIGH_V1")
        ?.discoveryThreshold,
    ).toBe(36);
    expect(analysis.validationLedger).toMatchObject({
      catalogRuleId: "AGE__HIGH_V1",
      passed: true,
      leaveOneDateOutStable: true,
    });
    expect(analysis.validationLedger?.catalogRuleId).toBe(analysis.selectedDiscoveryRule);
    expect(analysis.candidateDescriptor).toMatchObject({
      catalogRuleId: "AGE__HIGH_V1",
      materialDifference: "ONE_DECISION_TIME_FEATURE_NOT_F65E_V1",
      nextPermittedAction: "SEPARATE_HUMAN_APPROVAL_ONLY",
    });
    expect(JSON.stringify(analysis.candidateDescriptor)).not.toMatch(/later|returnPct|60m/i);
    expect(new Set(analysis.catalogLedger.map((entry) => entry.decisionTimeField))).toEqual(
      new Set([
        "market.assetAgeSeconds",
        "market.liquidityUsd",
        "market.volume5mUsd",
        "market.volume1hUsd",
        "market.momentum5mPct",
        "market.momentum15mPct",
        "quote.priceImpactBps",
      ]),
    );
    expect(analysis.safety).toMatchObject({
      providerCalls: 0,
      databaseReads: 0,
      filesystemWrites: 0,
      walletLoaded: false,
    });
  });

  it("reports no defensible hypothesis when all fixed catalog rules lack a discovery effect", () => {
    const fixture = createFixture({ mode: "NO_DISCOVERY_SIGNAL" });
    const analysis = buildFixtureAnalysis(fixture);
    expect(analysis.outcome).toEqual({
      status: "NO_DEFENSIBLE_HYPOTHESIS",
      reasons: ["NO_DISCOVERY_RULE_PASSED"],
    });
    expect(analysis.selectedDiscoveryRule).toBeNull();
    expect(analysis.validationLedger).toBeNull();
  });

  it("rejects a discovery-selected rule that does not hold in validation", () => {
    const fixture = createFixture({ mode: "VALIDATION_REJECTED" });
    const analysis = buildFixtureAnalysis(fixture);
    expect(analysis.outcome.status).toBe("PRE_REGISTRATION_CANDIDATE_REJECTED");
    expect(analysis.selectedDiscoveryRule).toBe("AGE__HIGH_V1");
    expect(analysis.validationLedger?.passed).toBe(false);
    expect(analysis.candidateDescriptor).toBeNull();
  });

  it("returns data insufficient for a fixed label-coverage failure without changing the catalog", () => {
    const fixture = createFixture({ mode: "INSUFFICIENT_LABEL_COVERAGE" });
    const analysis = buildFixtureAnalysis(fixture);
    expect(analysis.outcome.status).toBe("DATA_INSUFFICIENT");
    expect(
      analysis.cohortQuality.gates.find((gate) => gate.id === "PRIMARY_LABEL_COVERAGE")?.passed,
    ).toBe(false);
    expect(analysis.catalogLedger).toHaveLength(14);
    expect(analysis.catalogLedger.every((entry) => entry.discoveryThreshold === null)).toBe(true);
  });

  it("preserves every other fixed quality-gate failure without adding units or changing a threshold", () => {
    const expectedFailures: ReadonlyArray<readonly [FixtureMode, string]> = [
      ["INSUFFICIENT_COMPLETION", "COHORT_COMPLETION"],
      ["SPLIT_MISMATCH", "SPLIT_RECONSTRUCTION"],
      ["INSUFFICIENT_LABEL_SUPPORT", "PRIMARY_LABEL_SUPPORT"],
      ["LABEL_DATE_CONCENTRATION", "LABEL_DATE_CONCENTRATION"],
    ];
    for (const [mode, gateId] of expectedFailures) {
      const analysis = buildFixtureAnalysis(createFixture({ mode }));
      expect(analysis.outcome.status).toBe("DATA_INSUFFICIENT");
      expect(analysis.cohortQuality.gates.find((gate) => gate.id === gateId)?.passed).toBe(false);
      expect(analysis.selectedDiscoveryRule).toBeNull();
      expect(analysis.catalogLedger.every((entry) => entry.discoveryThreshold === null)).toBe(true);
    }

    const incomplete = createFixture({ mode: "READY" });
    rewriteFixture(incomplete, ({ manifest, summary }) => {
      manifest.outcome = "COHORT_INCOMPLETE";
      summary.outcome = "COHORT_INCOMPLETE";
    });
    const incompleteAnalysis = buildFixtureAnalysis(
      incomplete,
      fixtureIdentity(incomplete.archiveRoot),
    );
    expect(incompleteAnalysis.outcome.status).toBe("DATA_INSUFFICIENT");
    expect(incompleteAnalysis.archiveIntegrity.finalOutcome).toBe("COHORT_INCOMPLETE");
  });

  it("records unavailable fields, Fisher failure, and leave-one-date-out failure without alternative search", () => {
    const unavailable = buildFixtureAnalysis(
      createFixture({ mode: "READY", unavailableQuote: true }),
    );
    expect(
      unavailable.catalogLedger.filter((entry) => entry.catalogRuleId.startsWith("QUOTE_IMPACT")),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ discoveryThreshold: null, fieldAvailable: false }),
      ]),
    );
    expect(unavailable.selectedDiscoveryRule).toBe("AGE__HIGH_V1");

    const fisher = buildFixtureAnalysis(createFixture({ mode: "FISHER_REJECTED" }));
    expect(fisher.outcome.status).toBe("PRE_REGISTRATION_CANDIDATE_REJECTED");
    expect(fisher.selectedDiscoveryRule).toBe("AGE__HIGH_V1");
    expect(fisher.validationLedger?.failureCodes).toContain("FISHER_EXACT");

    const leaveOneDateOut = buildFixtureAnalysis(
      createFixture({ mode: "LEAVE_ONE_DATE_OUT_REJECTED" }),
    );
    expect(leaveOneDateOut.outcome.status).toBe("PRE_REGISTRATION_CANDIDATE_REJECTED");
    expect(leaveOneDateOut.selectedDiscoveryRule).toBe("AGE__HIGH_V1");
    expect(leaveOneDateOut.validationLedger?.failureCodes).toContain("LEAVE_ONE_DATE_OUT");
    expect(leaveOneDateOut.validationLedger?.catalogRuleId).toBe("AGE__HIGH_V1");
  });

  it("fails closed for synthetic source provenance mismatch and active archive state", () => {
    const inconsistent = createFixture({ mode: "READY", corruptSourceHash: true });
    expectAnalysisError(
      () =>
        new ExploratoryCohortArchiveLoader().load(inconsistent.archiveRoot, inconsistent.repoRoot),
      "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
    );

    const active = createFixture({ mode: "READY" });
    writeFileSync(path.join(active.archiveRoot, "collection.lock"), "synthetic\n", "utf8");
    expectAnalysisError(
      () => new ExploratoryCohortArchiveLoader().load(active.archiveRoot, active.repoRoot),
      "EXPLORATORY_ANALYSIS_ARCHIVE_NOT_FINAL",
    );
  });

  it("fails closed for hash, unsafe-text, stale evidence, summary, duplicate-mint, and unexpected-artifact inconsistency", () => {
    const hashMismatch = createFixture({ mode: "READY" });
    const originalUnits = readFileSync(
      path.join(hashMismatch.archiveRoot, "units.v1.ndjson"),
      "utf8",
    );
    const changedUnits = originalUnits.replace('"value":0', '"value":99');
    expect(changedUnits).not.toBe(originalUnits);
    writeFileSync(path.join(hashMismatch.archiveRoot, "units.v1.ndjson"), changedUnits, "utf8");
    expectAnalysisError(
      () =>
        new ExploratoryCohortArchiveLoader().load(hashMismatch.archiveRoot, hashMismatch.repoRoot),
      "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
    );

    const unsafe = createFixture({ mode: "READY" });
    rewriteFixture(unsafe, ({ summary }) => {
      summary.nextPermittedAction = "https://unsafe.example";
    });
    expectAnalysisError(
      () => new ExploratoryCohortArchiveLoader().load(unsafe.archiveRoot, unsafe.repoRoot),
      "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
    );

    const stale = createFixture({ mode: "READY" });
    rewriteFixture(stale, ({ units }) => {
      const first = units[0];
      if (!first) throw new Error("Synthetic fixture requires one unit.");
      const decisionTime = first.decisionTime as { market: { priceUsd: Record<string, unknown> } };
      decisionTime.market.priceUsd.sourceTimestamp = "2026-08-20T00:00:00.000Z";
    });
    expectAnalysisError(
      () => new ExploratoryCohortArchiveLoader().load(stale.archiveRoot, stale.repoRoot),
      "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
    );

    const inconsistentSummary = createFixture({ mode: "READY" });
    rewriteFixture(inconsistentSummary, ({ summary }) => {
      summary.validUnitCount = 95;
    });
    expectAnalysisError(
      () =>
        new ExploratoryCohortArchiveLoader().load(
          inconsistentSummary.archiveRoot,
          inconsistentSummary.repoRoot,
        ),
      "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
    );

    const duplicateMint = createFixture({ mode: "READY" });
    rewriteFixture(duplicateMint, ({ units }) => {
      const first = units[0];
      const second = units[1];
      if (!first || !second) throw new Error("Synthetic fixture requires two units.");
      units[1] = {
        ...second,
        canonicalMint: first.canonicalMint,
        unitId: `${second.slotId}:${first.canonicalMint}`,
      };
    });
    expectAnalysisError(
      () =>
        new ExploratoryCohortArchiveLoader().load(
          duplicateMint.archiveRoot,
          duplicateMint.repoRoot,
        ),
      "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
    );

    const unexpectedArtifact = createFixture({ mode: "READY" });
    writeFileSync(
      path.join(unexpectedArtifact.archiveRoot, "unexpected.tmp"),
      "synthetic\n",
      "utf8",
    );
    expectAnalysisError(
      () =>
        new ExploratoryCohortArchiveLoader().load(
          unexpectedArtifact.archiveRoot,
          unexpectedArtifact.repoRoot,
        ),
      "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
    );
  });

  it("requires every approved artifact hash after normal archive consistency checks", () => {
    const matching = createFixture({ mode: "READY" });
    expect(
      new ExploratoryCohortArchiveLoader({ expectedIdentity: matching.identity }).load(
        matching.archiveRoot,
        matching.repoRoot,
      ).inventory,
    ).toEqual(matching.identity);

    for (const name of exploratoryCohortAnalysisArtifactNames) {
      const mismatch = {
        ...matching.identity,
        [name]: "0".repeat(64),
      } as ExploratoryCohortAnalysisArchiveIdentity;
      expectAnalysisError(
        () =>
          new ExploratoryCohortArchiveLoader({ expectedIdentity: mismatch }).load(
            matching.archiveRoot,
            matching.repoRoot,
          ),
        "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
      );
    }

    const coherentlyRewritten = createFixture({ mode: "READY" });
    rewriteFixture(coherentlyRewritten, ({ summary }) => {
      summary.nonAuthorizingOutcome = "OBSERVATIONAL_ONLY_REWRITTEN";
    });
    expectAnalysisError(
      () =>
        new ExploratoryCohortArchiveLoader({
          expectedIdentity: coherentlyRewritten.identity,
        }).load(coherentlyRewritten.archiveRoot, coherentlyRewritten.repoRoot),
      "EXPLORATORY_ANALYSIS_SOURCE_INCONSISTENCY",
    );
  });

  it("is deterministic when generatedAt is fixed and imports no collector, gateway, provider, database, or runtime module", () => {
    const fixture = createFixture({ mode: "READY" });
    const first = buildFixtureAnalysis(fixture);
    const second = buildFixtureAnalysis(fixture);
    expect(first.contentFingerprint).toBe(second.contentFingerprint);
    expect(first).toEqual(second);

    const laterAuditTime = new ExploratoryCohortAnalysisService({
      loader: new ExploratoryCohortArchiveLoader({ expectedIdentity: fixture.identity }),
      now: () => new Date("2026-09-04T01:02:04.000Z"),
    }).build(fixture.archiveRoot, fixture.repoRoot);
    expect(laterAuditTime.contentFingerprint).toBe(first.contentFingerprint);
    expect({ ...laterAuditTime, generatedAt: first.generatedAt }).toEqual(first);
    expect(JSON.parse(formatExploratoryCohortAnalysisJson(first))).toEqual(first);
    expect(formatExploratoryCohortAnalysisMarkdown(first)).toContain(
      "This archive-only result does not authorize a strategy change, collection, Phase 10.6C validation, PAPER execution, promotion, order, fill, position, wallet action, signing, or submission.",
    );
    expect(formatExploratoryCohortAnalysisMarkdown(first)).toContain("Archive identity: MATCHED");

    const analysisDirectory = path.dirname(fileURLToPath(import.meta.url));
    for (const name of [
      "ExploratoryCohortAnalysisConfig.ts",
      "ExploratoryCohortArchiveLoader.ts",
      "ExploratoryCohortAnalysisService.ts",
      "ExploratoryCohortAnalysisCli.ts",
    ]) {
      const source = readFileSync(path.join(analysisDirectory, name), "utf8");
      expect(source).not.toMatch(
        /from\s+["'][^"']*(research-exploratory-cohort|gateway|provider|db\/|runtime)[^"']*["']/,
      );
      expect(source).not.toMatch(/writeFile|appendFile|mkdir|rename|unlink|rmSync/);
    }
  });
});

function buildFixtureAnalysis(
  fixture: Fixture,
  expectedIdentity: ExploratoryCohortAnalysisArchiveIdentity = fixture.identity,
): ReturnType<ExploratoryCohortAnalysisService["build"]> {
  return new ExploratoryCohortAnalysisService({
    loader: new ExploratoryCohortArchiveLoader({ expectedIdentity }),
    now: () => new Date("2026-09-04T01:02:03.000Z"),
  }).build(fixture.archiveRoot, fixture.repoRoot);
}

function expectAnalysisError(
  action: () => unknown,
  code: ExploratoryCohortAnalysisError["code"],
): void {
  try {
    action();
    throw new Error("Expected the action to fail closed.");
  } catch (error) {
    expect(error).toBeInstanceOf(ExploratoryCohortAnalysisError);
    expect(error).toMatchObject({ code } satisfies Partial<ExploratoryCohortAnalysisError>);
  }
}

interface Fixture {
  readonly repoRoot: string;
  readonly archiveRoot: string;
  readonly identity: ExploratoryCohortAnalysisArchiveIdentity;
}

type FixtureMode =
  | "READY"
  | "NO_DISCOVERY_SIGNAL"
  | "VALIDATION_REJECTED"
  | "FISHER_REJECTED"
  | "LEAVE_ONE_DATE_OUT_REJECTED"
  | "INSUFFICIENT_COMPLETION"
  | "SPLIT_MISMATCH"
  | "INSUFFICIENT_LABEL_COVERAGE"
  | "INSUFFICIENT_LABEL_SUPPORT"
  | "LABEL_DATE_CONCENTRATION";

function createFixture(input: {
  readonly mode: FixtureMode;
  readonly corruptSourceHash?: boolean;
  readonly unavailableQuote?: boolean;
}): Fixture {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "nexustrade-phase106b-"));
  roots.push(repoRoot);
  const protocolDirectory = path.join(repoRoot, "docs", "research-protocols");
  const archiveRoot = path.join(repoRoot, ...EXPLORATORY_ANALYSIS_ARCHIVE_ROOT.split("/"));
  mkdirSync(protocolDirectory, { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  cpSync(protocolSource, path.join(protocolDirectory, "phase10.6a-exploratory-cohort.v2.json"));

  const units = makeUnits(input.mode, input.unavailableQuote ?? false);
  const manifestSlots = units.map((unit, index) => ({
    slotId: unit.slotId,
    slotIndex: index,
    anchorAt: unit.anchorAt,
    state: "VALID_UNIT",
    reason: "VALID_REQUIRED_ANCHOR",
    discoveryCounts: { returned: 24, canonical: 24, technicallyValid: 24 },
    selectedMint: unit.canonicalMint,
  }));
  const sources = makeSources(units, input.corruptSourceHash ?? false);
  const providerCounts = {
    DISCOVERY: units.length,
    MARKET_CONTEXT: units.length,
    QUOTE_IMPACT: units.length,
    LATER_OBSERVATION: units.length * 4,
  };
  const summary = makeSummary(units, manifestSlots.length, providerCounts);
  const unitsRaw = `${[...units]
    .sort((left, right) => String(left.unitId).localeCompare(String(right.unitId)))
    .map((unit) => JSON.stringify(sortValue(unit)))
    .join("\n")}\n`;
  const sourcesRaw = stableJson(
    [...sources].sort((left, right) =>
      `${left.category}|${left.observedAt}|${left.capability}`.localeCompare(
        `${right.category}|${right.observedAt}|${right.capability}`,
      ),
    ),
  );
  const summaryRaw = stableJson(summary);
  const manifest = {
    contractVersion: "1",
    archiveRoot: EXPLORATORY_ANALYSIS_ARCHIVE_ROOT,
    launch: {
      contractVersion: "1",
      archiveRoot: EXPLORATORY_ANALYSIS_ARCHIVE_ROOT,
      cohortStartAt: "2026-08-21T00:00:00.000Z",
      protocolPath: "docs/research-protocols/phase10.6a-exploratory-cohort.v2.json",
      protocolSha256,
      protocolValidationFingerprint:
        "1fbe8a70792d872c7199d7182d095f13cce7c9908939526b44ecc7e2f872c283",
      authorization: "USER_AUTHORIZED_FOR_ONE_OBSERVATIONAL_COLLECTION",
      authorizationReference: "synthetic-phase106b-fixture",
    },
    executionDisabled: true,
    safety: zeroSafety(),
    outcome: "COHORT_COMPLETE",
    slots: manifestSlots,
    providerCounts,
    finalFileHashes: {
      "units.v1.ndjson": sha256(unitsRaw),
      "source-inventory.v1.json": sha256(sourcesRaw),
      "collection-summary.v1.json": sha256(summaryRaw),
    },
  };
  writeFileSync(path.join(archiveRoot, "units.v1.ndjson"), unitsRaw, "utf8");
  writeFileSync(path.join(archiveRoot, "source-inventory.v1.json"), sourcesRaw, "utf8");
  writeFileSync(path.join(archiveRoot, "collection-summary.v1.json"), summaryRaw, "utf8");
  writeFileSync(path.join(archiveRoot, "cohort-manifest.v1.json"), stableJson(manifest), "utf8");
  return { repoRoot, archiveRoot, identity: fixtureIdentity(archiveRoot) };
}

function fixtureIdentity(archiveRoot: string): ExploratoryCohortAnalysisArchiveIdentity {
  return Object.fromEntries(
    exploratoryCohortAnalysisArtifactNames.map((name) => [
      name,
      sha256(readFileSync(path.join(archiveRoot, name), "utf8")),
    ]),
  ) as ExploratoryCohortAnalysisArchiveIdentity;
}

function rewriteFixture(
  fixture: Fixture,
  mutate: (artifacts: {
    units: Array<Record<string, unknown>>;
    sources: Array<Record<string, unknown>>;
    summary: Record<string, unknown>;
    manifest: Record<string, unknown>;
  }) => void,
): void {
  const units = readFileSync(path.join(fixture.archiveRoot, "units.v1.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const sources = JSON.parse(
    readFileSync(path.join(fixture.archiveRoot, "source-inventory.v1.json"), "utf8"),
  ) as Array<Record<string, unknown>>;
  const summary = JSON.parse(
    readFileSync(path.join(fixture.archiveRoot, "collection-summary.v1.json"), "utf8"),
  ) as Record<string, unknown>;
  const manifest = JSON.parse(
    readFileSync(path.join(fixture.archiveRoot, "cohort-manifest.v1.json"), "utf8"),
  ) as Record<string, unknown>;
  mutate({ units, sources, summary, manifest });
  const unitsRaw = `${[...units]
    .sort((left, right) => String(left.unitId).localeCompare(String(right.unitId)))
    .map((unit) => JSON.stringify(sortValue(unit)))
    .join("\n")}\n`;
  const sourcesRaw = stableJson(
    [...sources].sort((left, right) =>
      `${left.category}|${left.observedAt}|${left.capability}`.localeCompare(
        `${right.category}|${right.observedAt}|${right.capability}`,
      ),
    ),
  );
  const summaryRaw = stableJson(summary);
  const finalFileHashes = manifest.finalFileHashes as Record<string, string>;
  finalFileHashes["units.v1.ndjson"] = sha256(unitsRaw);
  finalFileHashes["source-inventory.v1.json"] = sha256(sourcesRaw);
  finalFileHashes["collection-summary.v1.json"] = sha256(summaryRaw);
  writeFileSync(path.join(fixture.archiveRoot, "units.v1.ndjson"), unitsRaw, "utf8");
  writeFileSync(path.join(fixture.archiveRoot, "source-inventory.v1.json"), sourcesRaw, "utf8");
  writeFileSync(path.join(fixture.archiveRoot, "collection-summary.v1.json"), summaryRaw, "utf8");
  writeFileSync(
    path.join(fixture.archiveRoot, "cohort-manifest.v1.json"),
    stableJson(manifest),
    "utf8",
  );
}

function makeUnits(mode: FixtureMode, unavailableQuote: boolean): Array<Record<string, unknown>> {
  const units: Array<Record<string, unknown>> = [];
  const partitionRanks = { DISCOVERY: 0, VALIDATION: 0 };
  let candidate = 0;
  const unitLimit = mode === "INSUFFICIENT_COMPLETION" ? 95 : 96;
  while (units.length < unitLimit) {
    const mint = syntheticMint(candidate);
    const slotId = `SLOT_${String(units.length + 1).padStart(3, "0")}`;
    const partition = partitionFor(mint, slotId);
    if (partitionRanks[partition] >= 48) {
      candidate += 1;
      continue;
    }
    const rank = partitionRanks[partition];
    partitionRanks[partition] += 1;
    const featureRank = (rank * 13) % 48;
    const ageHigh =
      mode === "LEAVE_ONE_DATE_OUT_REJECTED" && (rank < 5 || (rank >= 6 && rank < 25));
    const dateIndex =
      mode === "LABEL_DATE_CONCENTRATION" && rank < 17 ? 0 : Math.floor(units.length / 12);
    const hour = (units.length % 12) * 2;
    const anchorAt = `2026-08-${String(21 + dateIndex).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
    const returnPct = labelReturn(mode, partition, featureRank, ageHigh, rank);
    const labelAvailability =
      mode === "INSUFFICIENT_LABEL_COVERAGE" && partition === "DISCOVERY" && rank < 10
        ? "MISSING"
        : "OBSERVED_ON_TIME";
    units.push({
      unitId: `${slotId}:${mint}`,
      canonicalMint: mint,
      anchorAt,
      slotId,
      partition,
      decisionTime: {
        discovery: fact("DEXSCREENER_TOKEN_PROFILE", "DISCOVERY", "TOKEN_PROFILE", anchorAt),
        market: {
          assetAgeSeconds: numericFact(
            mode === "LEAVE_ONE_DATE_OUT_REJECTED" ? (ageHigh ? 100 : 0) : featureRank,
            "MARKET_CONTEXT",
            "BEST_PAIR",
            anchorAt,
          ),
          priceUsd: numericFact(featureRank + 1, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
          liquidityUsd: numericFact(featureRank, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
          volume5mUsd: numericFact(featureRank, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
          volume1hUsd: numericFact(featureRank, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
          momentum5mPct: numericFact(featureRank, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
          momentum15mPct: numericFact(featureRank, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
        },
        quote: {
          available: unavailableQuote
            ? unavailableFact("UNAVAILABLE_AT_ANCHOR", "QUOTE_IMPACT", "QUOTE", anchorAt)
            : booleanFact(true, "QUOTE_IMPACT", "QUOTE", anchorAt),
          priceImpactBps: unavailableQuote
            ? unavailableFact("UNAVAILABLE_AT_ANCHOR", "QUOTE_IMPACT", "QUOTE", anchorAt)
            : numericFact(featureRank, "QUOTE_IMPACT", "QUOTE", anchorAt),
        },
        risk: {
          blockerCodes: {
            availability: "NOT_REQUESTED",
            sourceCategory: "LOCAL",
            sourceIdentifier: "NOT_REQUESTED",
          },
        },
        attention: { repeatedAttentionCount: numericFact(0, "LOCAL", "SLOT_DEDUPLICATION") },
      },
      laterObservations: [
        observation(3, 0),
        observation(5, 0),
        observation(15, 0),
        labelAvailability === "OBSERVED_ON_TIME"
          ? observation(60, returnPct)
          : { minutesAfterAnchor: 60, availability: "MISSING", reason: "NOT_FOUND" },
      ],
    });
    candidate += 1;
  }
  if (mode === "SPLIT_MISMATCH") {
    const first = units[0];
    if (!first) throw new Error("Synthetic fixture requires one unit.");
    units[0] = {
      ...first,
      partition: first.partition === "DISCOVERY" ? "VALIDATION" : "DISCOVERY",
    };
  }
  return units;
}

function labelReturn(
  mode: FixtureMode,
  partition: "DISCOVERY" | "VALIDATION",
  featureRank: number,
  ageHigh: boolean,
  ordinalRank: number,
): number {
  if (mode === "NO_DISCOVERY_SIGNAL") return featureRank % 6 === 0 ? 1 : -1;
  if (mode === "VALIDATION_REJECTED" && partition === "VALIDATION")
    return featureRank % 6 === 0 ? 1 : -1;
  if (mode === "FISHER_REJECTED" && partition === "VALIDATION") {
    return featureRank >= 42 || featureRank < 12 ? 1 : -1;
  }
  if (mode === "LEAVE_ONE_DATE_OUT_REJECTED") {
    if (partition === "DISCOVERY") return ageHigh ? 1 : -1;
    return (ageHigh && (ordinalRank === 0 || (ordinalRank >= 9 && ordinalRank < 16))) ||
      (!ageHigh && ordinalRank >= 25 && ordinalRank < 29)
      ? 1
      : -1;
  }
  if (mode === "INSUFFICIENT_LABEL_SUPPORT") return featureRank % 7 === 0 ? 1 : -1;
  return featureRank >= 36 || featureRank < 8 ? 1 : -1;
}

function makeSources(units: readonly Record<string, unknown>[], corruptSourceHash: boolean) {
  const sourceRows: Array<Record<string, unknown>> = [];
  for (const unit of units) {
    const anchorAt = unit.anchorAt as string;
    sourceRows.push(
      source("DISCOVERY", "DEXSCREENER", "TOKEN_DISCOVERY", anchorAt),
      source("MARKET_CONTEXT", "DEXSCREENER", "BEST_PAIR", anchorAt),
      source("QUOTE_IMPACT", "JUPITER", "QUOTE_IMPACT", anchorAt),
    );
    sourceRows.push(
      ...[3, 5, 15, 60].map(() =>
        source("LATER_OBSERVATION", "DEXSCREENER", "BEST_PAIR_LATER_LABEL", anchorAt),
      ),
    );
  }
  if (corruptSourceHash) sourceRows[0] = { ...sourceRows[0], sourceHash: "0".repeat(64) };
  return sourceRows;
}

function source(category: string, provider: string, capability: string, observedAt: string) {
  const sanitized = {
    attemptCount: 1,
    capability,
    category,
    latencyBucket: "LT_100MS",
    observedAt,
    outcomeCode: "OK",
    provider,
    requestCount: 1,
  };
  return { ...sanitized, sourceHash: sha256(JSON.stringify(sanitized)) };
}

function makeSummary(
  units: readonly Record<string, unknown>[],
  attemptedSlotCount: number,
  providerCounts: Record<string, number>,
) {
  const dates = countBy(units.map((unit) => (unit.anchorAt as string).slice(0, 10)));
  const partitions = countBy(units.map((unit) => unit.partition as string));
  const observations = units.flatMap(
    (unit) => unit.laterObservations as Array<Record<string, unknown>>,
  );
  const availabilityCounts = countBy(
    observations.map((observation) => observation.availability as string),
  );
  return {
    contractVersion: "1",
    outcome: "COHORT_COMPLETE",
    validUnitCount: units.length,
    attemptedSlotCount,
    partitionCounts: {
      DISCOVERY: partitions.DISCOVERY ?? 0,
      VALIDATION: partitions.VALIDATION ?? 0,
    },
    utcDateCounts: dates,
    concentration: {
      distinctMintCount: new Set(units.map((unit) => unit.canonicalMint)).size,
      maximumUtcDateSharePct: Number(
        ((Math.max(0, ...Object.values(dates)) / Math.max(1, units.length)) * 100).toFixed(6),
      ),
    },
    laterObservations: {
      totalCount: observations.length,
      availabilityCounts,
      missingOrInvalidCount: (availabilityCounts.MISSING ?? 0) + (availabilityCounts.INVALID ?? 0),
    },
    providerCounts,
    providerBudgetUse: {
      DISCOVERY: { cap: 168, used: providerCounts.DISCOVERY },
      MARKET_CONTEXT: { cap: 168, used: providerCounts.MARKET_CONTEXT },
      QUOTE_IMPACT: { cap: 168, used: providerCounts.QUOTE_IMPACT },
      LATER_OBSERVATION: { cap: 672, used: providerCounts.LATER_OBSERVATION },
    },
    safetyCounters: zeroSafety(),
    executionDisabled: true,
    nextPermittedAction: "PRESERVE_ARCHIVE",
    nonAuthorizingOutcome: "OBSERVATIONAL_ONLY",
  };
}

function fact(
  value: string,
  sourceCategory: string,
  sourceIdentifier: string,
  sourceTimestamp?: string,
) {
  return {
    value,
    availability: "AVAILABLE_AT_ANCHOR",
    sourceCategory,
    sourceIdentifier,
    ...(sourceTimestamp ? { sourceTimestamp } : {}),
  };
}

function numericFact(
  value: number,
  sourceCategory: string,
  sourceIdentifier: string,
  sourceTimestamp?: string,
) {
  return {
    value,
    availability: "AVAILABLE_AT_ANCHOR",
    sourceCategory,
    sourceIdentifier,
    ...(sourceTimestamp ? { sourceTimestamp } : {}),
  };
}

function booleanFact(
  value: boolean,
  sourceCategory: string,
  sourceIdentifier: string,
  sourceTimestamp?: string,
) {
  return {
    value,
    availability: "AVAILABLE_AT_ANCHOR",
    sourceCategory,
    sourceIdentifier,
    ...(sourceTimestamp ? { sourceTimestamp } : {}),
  };
}

function unavailableFact(
  availability: "UNAVAILABLE_AT_ANCHOR",
  sourceCategory: string,
  sourceIdentifier: string,
  sourceTimestamp: string,
) {
  return { availability, sourceCategory, sourceIdentifier, sourceTimestamp };
}

function observation(minutesAfterAnchor: number, returnPct: number) {
  return {
    minutesAfterAnchor,
    availability: "OBSERVED_ON_TIME",
    observedAt: "2026-08-21T00:00:00.000Z",
    returnPct,
    reason: "NUMERIC_RETURN",
  };
}

function syntheticMint(index: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const first = alphabet[Math.floor(index / alphabet.length) % alphabet.length] as string;
  const second = alphabet[index % alphabet.length] as string;
  return `${"1".repeat(30)}${first}${second}`;
}

function partitionFor(mint: string, slotId: string): "DISCOVERY" | "VALIDATION" {
  const hash = sha256(`phase10.6a-exploratory-cohort.v2|${mint}|${slotId}`);
  return Number.parseInt(hash.at(-1) ?? "0", 16) % 2 === 0 ? "DISCOVERY" : "VALIDATION";
}

function zeroSafety() {
  return {
    databaseReads: 0,
    databaseWrites: 0,
    sessions: 0,
    orders: 0,
    fills: 0,
    positions: 0,
    walletLoaded: false,
    transactionSigning: false,
    transactionSubmission: false,
  };
}

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue((value as Record<string, unknown>)[key])]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
