import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT,
  measurementAuditArtifactNames,
  type ExploratoryMeasurementAuditIdentity,
} from "./ExploratoryMeasurementAuditIdentity.js";
import { ExploratoryMeasurementAuditLoader } from "./ExploratoryMeasurementAuditLoader.js";
import { ExploratoryMeasurementAuditError } from "./ExploratoryMeasurementAuditErrors.js";
import {
  formatExploratoryMeasurementAuditJson,
  formatExploratoryMeasurementAuditMarkdown,
} from "./ExploratoryMeasurementAuditFormatter.js";
import { parseExploratoryMeasurementAuditArgs } from "./ExploratoryMeasurementAuditConfig.js";
import { ExploratoryMeasurementAuditService } from "./ExploratoryMeasurementAuditService.js";
import { runExploratoryMeasurementAuditCli } from "./ExploratoryMeasurementAuditCli.js";

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

describe("ExploratoryMeasurementAudit", () => {
  it("accepts only the named root, one format, and one compatibility --once", () => {
    expect(
      parseExploratoryMeasurementAuditArgs([
        `--archive-root=${EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT}`,
        "--format=json",
        "--once",
      ]),
    ).toEqual({
      archiveRoot: EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT,
      format: "json",
      once: true,
    });
    for (const argument of [
      "--once",
      "--output=file.json",
      "--provider=DEXSCREENER",
      "--db=paper",
      "--wallet=true",
      "--archive-identity=override",
    ]) {
      expectAuditError(
        () =>
          parseExploratoryMeasurementAuditArgs([
            `--archive-root=${EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT}`,
            argument,
            ...(argument === "--once" ? ["--once"] : []),
          ]),
        "EXPLORATORY_MEASUREMENT_AUDIT_INVALID_SCOPE",
      );
    }
    let writes = 0;
    expectAuditError(
      () =>
        runExploratoryMeasurementAuditCli(
          [`--archive-root=${EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT}`, "--live=true"],
          () => {
            writes += 1;
          },
        ),
      "EXPLORATORY_MEASUREMENT_AUDIT_INVALID_SCOPE",
    );
    expect(writes).toBe(0);
  });

  it("builds every bounded ledger from decision-time facts only with literal zero side effects", () => {
    const fixture = createFixture("NORMAL");
    const audit = buildFixtureAudit(fixture);
    expect(audit.outcome.status).toBe("NO_ACTIONABLE_MEASUREMENT_CHANGE");
    expect(audit.archiveIdentity.status).toBe("MATCHED");
    expect(audit.fieldAvailabilityLedger).toHaveLength(18);
    for (const row of audit.fieldAvailabilityLedger) {
      expect(Object.keys(row.availabilityCounts)).toEqual(
        expect.arrayContaining([
          "AVAILABLE_AT_ANCHOR",
          "NOT_REQUESTED",
          "UNAVAILABLE_AT_ANCHOR",
          "STALE_AT_ANCHOR",
          "BUDGET_EXHAUSTED",
          "PROVIDER_ERROR",
          "UNSUPPORTED",
          "INVALID_VALUE",
        ]),
      );
    }
    expect(audit.safety).toEqual({
      providerCalls: 0,
      databaseReads: 0,
      databaseWrites: 0,
      filesystemWrites: 0,
      runtimeActions: 0,
      sessionActions: 0,
      orders: 0,
      fills: 0,
      positions: 0,
      walletLoaded: false,
      transactionSigning: false,
      transactionSubmission: false,
      laterLabelMembersInterpreted: 0,
    });
    const output = `${formatExploratoryMeasurementAuditJson(audit)}${formatExploratoryMeasurementAuditMarkdown(audit)}`;
    expect(output).not.toContain(fixture.mints[0] as string);
    expect(output).not.toMatch(/unitId|slotId|returnPct|minutesAfterAnchor|OBSERVED_ON_TIME/i);
  });

  it("uses only fixed coverage, signature, and date gates for the four bounded outcomes", () => {
    const ready = buildFixtureAudit(createFixture("SYSTEMIC"));
    expect(ready.outcome.status).toBe("MEASUREMENT_REVISION_READY_FOR_SEPARATE_PROTOCOL_REVIEW");
    expect(ready.nextPermittedAction).toBe("DRAFT_MEASUREMENT_ONLY_PROTOCOL_FOR_SEPARATE_REVIEW");
    expect(
      ready.systemicDeficiencyLedger.find((entry) => entry.field === "MOMENTUM_5M")?.qualification,
    ).toBe("SYSTEMIC_ATTRIBUTABLE_MEASUREMENT_DEFICIENCY");

    const transient = buildFixtureAudit(createFixture("TRANSIENT"));
    expect(transient.outcome.status).toBe("NO_ACTIONABLE_MEASUREMENT_CHANGE");
    expect(
      transient.systemicDeficiencyLedger.find((entry) => entry.field === "QUOTE_IMPACT")
        ?.qualification,
    ).toBe("TRANSIENT_OR_NONQUALIFYING_GAP");

    const tie = buildFixtureAudit(createFixture("TIE"));
    expect(tie.outcome.status).toBe("HUMAN_REVIEW_REQUIRED");
    expect(
      tie.systemicDeficiencyLedger.find((entry) => entry.field === "VOLUME_5M")?.qualification,
    ).toBe("QUALIFYING_SIGNATURE_TIE");

    const insufficient = buildFixtureAudit(createFixture("INSUFFICIENT"));
    expect(insufficient.outcome.status).toBe("MEASUREMENT_EVIDENCE_INSUFFICIENT");
  });

  it("hard-verifies every raw artifact after normal consistency checks and has no production override", () => {
    const fixture = createFixture("NORMAL");
    expect(
      new ExploratoryMeasurementAuditLoader({ expectedIdentity: fixture.identity }).load(
        fixture.archiveRoot,
        fixture.repoRoot,
      ).inventory,
    ).toEqual(fixture.identity.artifacts);
    for (const name of measurementAuditArtifactNames) {
      expectAuditError(
        () =>
          new ExploratoryMeasurementAuditLoader({
            expectedIdentity: {
              ...fixture.identity,
              artifacts: { ...fixture.identity.artifacts, [name]: "0".repeat(64) },
            },
          }).load(fixture.archiveRoot, fixture.repoRoot),
        "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY",
      );
    }
    const rewritten = createFixture("NORMAL");
    rewriteFixture(rewritten, (artifacts) => {
      artifacts.summary.nonAuthorizingOutcome = "OBSERVATIONAL_ONLY_REWRITTEN";
    });
    const rewrittenIdentity = fixtureIdentity(rewritten.archiveRoot);
    expect(
      new ExploratoryMeasurementAuditLoader({ expectedIdentity: rewrittenIdentity }).load(
        rewritten.archiveRoot,
        rewritten.repoRoot,
      ).inventory,
    ).toEqual(rewrittenIdentity.artifacts);
    expectAuditError(
      () =>
        new ExploratoryMeasurementAuditLoader({ expectedIdentity: fixture.identity }).load(
          rewritten.archiveRoot,
          rewritten.repoRoot,
        ),
      "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY",
    );
  });

  it("fails closed for unsafe roots, active archives, invalid source provenance, stale facts, and unexpected artifacts", () => {
    const active = createFixture("NORMAL");
    writeFileSync(path.join(active.archiveRoot, "collection.lock"), "synthetic\n", "utf8");
    expectAuditError(
      () =>
        new ExploratoryMeasurementAuditLoader({ expectedIdentity: active.identity }).load(
          active.archiveRoot,
          active.repoRoot,
        ),
      "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY",
    );

    const unexpected = createFixture("NORMAL");
    writeFileSync(path.join(unexpected.archiveRoot, "unexpected.tmp"), "synthetic\n", "utf8");
    expectAuditError(
      () =>
        new ExploratoryMeasurementAuditLoader({ expectedIdentity: unexpected.identity }).load(
          unexpected.archiveRoot,
          unexpected.repoRoot,
        ),
      "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY",
    );

    const corruptSource = createFixture("NORMAL");
    rewriteFixture(corruptSource, (artifacts) => {
      const first = artifacts.sources[0] as Record<string, unknown>;
      first.sourceHash = "0".repeat(64);
    });
    expectAuditError(
      () =>
        new ExploratoryMeasurementAuditLoader({ expectedIdentity: corruptSource.identity }).load(
          corruptSource.archiveRoot,
          corruptSource.repoRoot,
        ),
      "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY",
    );

    const stale = createFixture("NORMAL");
    rewriteFixture(stale, (artifacts) => {
      const first = artifacts.units[0] as Record<string, unknown>;
      const decisionTime = first.decisionTime as { market: { priceUsd: Record<string, unknown> } };
      decisionTime.market.priceUsd.sourceTimestamp = "2026-08-01T00:00:00.000Z";
    });
    expectAuditError(
      () =>
        new ExploratoryMeasurementAuditLoader({ expectedIdentity: stale.identity }).load(
          stale.archiveRoot,
          stale.repoRoot,
        ),
      "EXPLORATORY_MEASUREMENT_AUDIT_SOURCE_INCONSISTENCY",
    );
  });

  it("hash-validates source records while excluding later-observation rows and proving label divergence cannot change the audit", () => {
    const left = createFixture("SYSTEMIC", "LOW_LABELS");
    const right = createFixture("SYSTEMIC", "HIGH_LABELS");
    const leftAudit = buildFixtureAudit(left);
    const rightAudit = buildFixtureAudit(right);
    expect(JSON.stringify(leftAudit.decisionTimeSourceInventoryLedger)).not.toContain(
      "LATER_OBSERVATION",
    );
    expect(leftAudit.fieldAvailabilityLedger).toEqual(rightAudit.fieldAvailabilityLedger);
    expect(leftAudit.missingnessProvenanceLedger).toEqual(rightAudit.missingnessProvenanceLedger);
    expect(leftAudit.dateDistributionLedger).toEqual(rightAudit.dateDistributionLedger);
    expect(leftAudit.systemicDeficiencyLedger).toEqual(rightAudit.systemicDeficiencyLedger);
    expect(leftAudit.outcome).toEqual(rightAudit.outcome);
    expect(leftAudit.archiveIdentity.artifacts).not.toEqual(rightAudit.archiveIdentity.artifacts);
  });

  it("is deterministic apart from generatedAt and imports no forbidden runtime surface", () => {
    const fixture = createFixture("SYSTEMIC");
    const first = buildFixtureAudit(fixture, "2026-09-04T01:02:03.000Z");
    const second = buildFixtureAudit(fixture, "2026-09-04T02:02:03.000Z");
    expect(first.contentFingerprint).toBe(second.contentFingerprint);
    expect(canonicalWithoutAuditTime(first)).toEqual(canonicalWithoutAuditTime(second));
    expect(JSON.parse(formatExploratoryMeasurementAuditJson(first))).toEqual(first);
    expect(formatExploratoryMeasurementAuditMarkdown(first)).toContain(
      "later-label members interpreted: 0",
    );

    const directory = path.dirname(fileURLToPath(import.meta.url));
    for (const name of [
      "ExploratoryMeasurementAuditConfig.ts",
      "ExploratoryMeasurementAuditLoader.ts",
      "ExploratoryMeasurementAuditService.ts",
      "ExploratoryMeasurementAuditCli.ts",
    ]) {
      const source = readFileSync(path.join(directory, name), "utf8");
      expect(source).not.toMatch(
        /from\s+["'][^"']*(research-exploratory-cohort|provider|db\/|runtime|strategy|paper|wallet|execution)[^"']*["']/i,
      );
      expect(source).not.toMatch(/writeFile|appendFile|mkdir|rename|unlink|rmSync/);
    }
    for (const name of [
      "ExploratoryMeasurementAuditConfig.ts",
      "ExploratoryMeasurementAuditService.ts",
      "ExploratoryMeasurementAuditFormatter.ts",
      "ExploratoryMeasurementAuditCli.ts",
    ]) {
      expect(readFileSync(path.join(directory, name), "utf8")).not.toContain("laterObservations");
    }
  });
});

function buildFixtureAudit(fixture: Fixture, generatedAt = "2026-09-04T01:02:03.000Z") {
  return new ExploratoryMeasurementAuditService({
    loader: new ExploratoryMeasurementAuditLoader({ expectedIdentity: fixture.identity }),
    now: () => new Date(generatedAt),
  }).build(fixture.archiveRoot, fixture.repoRoot);
}

function expectAuditError(
  action: () => unknown,
  code: ExploratoryMeasurementAuditError["code"],
): void {
  try {
    action();
    throw new Error("Expected the audit to fail closed.");
  } catch (error) {
    expect(error).toBeInstanceOf(ExploratoryMeasurementAuditError);
    expect(error).toMatchObject({ code } satisfies Partial<ExploratoryMeasurementAuditError>);
  }
}

interface Fixture {
  readonly repoRoot: string;
  readonly archiveRoot: string;
  readonly identity: ExploratoryMeasurementAuditIdentity;
  readonly mints: readonly string[];
}

type FixtureMode = "NORMAL" | "SYSTEMIC" | "TRANSIENT" | "TIE" | "INSUFFICIENT";
type LabelMode = "LOW_LABELS" | "HIGH_LABELS";

function createFixture(mode: FixtureMode, labelMode: LabelMode = "LOW_LABELS"): Fixture {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "nexustrade-phase106b1-"));
  roots.push(repoRoot);
  const protocolDirectory = path.join(repoRoot, "docs", "research-protocols");
  const archiveRoot = path.join(repoRoot, ...EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT.split("/"));
  mkdirSync(protocolDirectory, { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  cpSync(protocolSource, path.join(protocolDirectory, "phase10.6a-exploratory-cohort.v2.json"));

  const units = makeUnits(mode, labelMode);
  const sources = makeSources(units);
  const providerCounts = {
    DISCOVERY: units.length,
    MARKET_CONTEXT: units.length,
    QUOTE_IMPACT: units.length,
    LATER_OBSERVATION: units.length * 4,
  };
  const sourceRaw = stableJson(sources);
  const unitsRaw = `${units.map((unit) => JSON.stringify(sortValue(unit))).join("\n")}\n`;
  const summary = {
    contractVersion: "1",
    outcome: "COHORT_COMPLETE",
    validUnitCount: units.length,
    attemptedSlotCount: units.length,
    partitionCounts: countPartitions(units),
    utcDateCounts: countBy(units.map((unit) => String(unit.anchorAt).slice(0, 10))),
    concentration: { distinctMintCount: units.length, maximumUtcDateSharePct: 12.5 },
    laterObservations: { syntheticContainer: true },
    providerCounts,
    providerBudgetUse: Object.fromEntries(
      Object.entries(providerCounts).map(([category, used]) => [category, { cap: 672, used }]),
    ),
    safetyCounters: zeroSafety(),
    executionDisabled: true,
    nextPermittedAction: "PRESERVE_ARCHIVE",
    nonAuthorizingOutcome: "OBSERVATIONAL_ONLY",
  };
  const summaryRaw = stableJson(summary);
  const manifest = {
    contractVersion: "1",
    archiveRoot: EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT,
    launch: {
      contractVersion: "1",
      archiveRoot: EXPLORATORY_MEASUREMENT_AUDIT_ARCHIVE_ROOT,
      cohortStartAt: "2026-08-21T00:00:00.000Z",
      protocolPath: "docs/research-protocols/phase10.6a-exploratory-cohort.v2.json",
      protocolSha256,
      protocolValidationFingerprint:
        "1fbe8a70792d872c7199d7182d095f13cce7c9908939526b44ecc7e2f872c283",
      authorization: "USER_AUTHORIZED_FOR_ONE_OBSERVATIONAL_COLLECTION",
      authorizationReference: "synthetic-phase106b1-fixture",
    },
    executionDisabled: true,
    safety: zeroSafety(),
    outcome: "COHORT_COMPLETE",
    slots: units.map((unit, index) => ({
      slotId: unit.slotId,
      slotIndex: index,
      anchorAt: unit.anchorAt,
      state: "VALID_UNIT",
      reason: "VALID_REQUIRED_ANCHOR",
      discoveryCounts: { returned: 20, canonical: 20, technicallyValid: 20 },
      selectedMint: unit.canonicalMint,
    })),
    providerCounts,
    finalFileHashes: {
      "units.v1.ndjson": sha256(unitsRaw),
      "source-inventory.v1.json": sha256(sourceRaw),
      "collection-summary.v1.json": sha256(summaryRaw),
    },
  };
  writeFileSync(path.join(archiveRoot, "units.v1.ndjson"), unitsRaw, "utf8");
  writeFileSync(path.join(archiveRoot, "source-inventory.v1.json"), sourceRaw, "utf8");
  writeFileSync(path.join(archiveRoot, "collection-summary.v1.json"), summaryRaw, "utf8");
  writeFileSync(path.join(archiveRoot, "cohort-manifest.v1.json"), stableJson(manifest), "utf8");
  return {
    repoRoot,
    archiveRoot,
    identity: fixtureIdentity(archiveRoot),
    mints: units.map((unit) => String(unit.canonicalMint)),
  };
}

function makeUnits(mode: FixtureMode, labelMode: LabelMode): Array<Record<string, unknown>> {
  const units: Array<Record<string, unknown>> = [];
  const ranks = { DISCOVERY: 0, VALIDATION: 0 };
  let candidate = 0;
  while (units.length < 16) {
    const canonicalMint = syntheticMint(candidate);
    const slotId = `SLOT_${String(units.length + 1).padStart(3, "0")}`;
    const partition = partitionFor(canonicalMint, slotId);
    if (ranks[partition] >= 8) {
      candidate += 1;
      continue;
    }
    const rank = ranks[partition]++;
    const dateIndex = mode === "INSUFFICIENT" ? rank % 7 : rank;
    const anchorAt = `2026-08-${String(21 + dateIndex).padStart(2, "0")}T00:00:00.000Z`;
    const facts: Record<string, Record<string, unknown>> = {
      assetAgeSeconds: numericFact(60, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
      priceUsd: numericFact(1, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
      liquidityUsd: numericFact(2, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
      volume5mUsd: numericFact(3, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
      volume1hUsd: numericFact(4, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
      momentum5mPct: numericFact(5, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
      momentum15mPct: numericFact(6, "MARKET_CONTEXT", "BEST_PAIR", anchorAt),
    };
    if (mode === "SYSTEMIC")
      facts.momentum5mPct = unavailableFact("UNSUPPORTED", "MARKET_CONTEXT", "BEST_PAIR");
    if (mode === "TIE")
      facts.volume5mUsd = unavailableFact(
        rank % 2 === 0 ? "UNSUPPORTED" : "UNAVAILABLE_AT_ANCHOR",
        "MARKET_CONTEXT",
        "BEST_PAIR",
      );
    const quoteImpact =
      mode === "TRANSIENT"
        ? unavailableFact("PROVIDER_ERROR", "QUOTE_IMPACT", "QUOTE")
        : numericFact(7, "QUOTE_IMPACT", "QUOTE", anchorAt);
    units.push({
      unitId: `${slotId}:${canonicalMint}`,
      canonicalMint,
      anchorAt,
      slotId,
      partition,
      decisionTime: {
        discovery: {
          value: "DEXSCREENER_TOKEN_PROFILE",
          availability: "AVAILABLE_AT_ANCHOR",
          sourceCategory: "DISCOVERY",
          sourceIdentifier: "TOKEN_PROFILE",
          sourceTimestamp: anchorAt,
        },
        market: facts,
        quote: {
          available: booleanFact(true, "QUOTE_IMPACT", "QUOTE", anchorAt),
          priceImpactBps: quoteImpact,
        },
        risk: {
          blockerCodes: {
            availability: "NOT_REQUESTED",
            sourceCategory: "LOCAL",
            sourceIdentifier: "NOT_REQUESTED",
          },
        },
        attention: {
          repeatedAttentionCount: {
            value: 0,
            availability: "AVAILABLE_AT_ANCHOR",
            sourceCategory: "LOCAL",
            sourceIdentifier: "SLOT_DEDUPLICATION",
          },
        },
      },
      laterObservations: [
        { synthetic: labelMode === "HIGH_LABELS" ? "A" : "B" },
        { synthetic: labelMode === "HIGH_LABELS" ? "C" : "D" },
      ],
    });
    candidate += 1;
  }
  return units;
}

function makeSources(units: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const unit of units) {
    const observedAt = String(unit.anchorAt);
    rows.push(
      source("DISCOVERY", "DEXSCREENER", "TOKEN_DISCOVERY", observedAt),
      source("MARKET_CONTEXT", "DEXSCREENER", "BEST_PAIR", observedAt),
      source("QUOTE_IMPACT", "JUPITER", "QUOTE_IMPACT", observedAt),
      source("LATER_OBSERVATION", "DEXSCREENER", "BEST_PAIR_LATER_LABEL", observedAt),
      source("LATER_OBSERVATION", "DEXSCREENER", "BEST_PAIR_LATER_LABEL", observedAt),
      source("LATER_OBSERVATION", "DEXSCREENER", "BEST_PAIR_LATER_LABEL", observedAt),
      source("LATER_OBSERVATION", "DEXSCREENER", "BEST_PAIR_LATER_LABEL", observedAt),
    );
  }
  return rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function source(
  category: string,
  provider: string,
  capability: string,
  observedAt: string,
): Record<string, unknown> {
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
  const unitsRaw = `${units.map((unit) => JSON.stringify(sortValue(unit))).join("\n")}\n`;
  const sourcesRaw = stableJson(sources);
  const summaryRaw = stableJson(summary);
  const hashes = manifest.finalFileHashes as Record<string, string>;
  hashes["units.v1.ndjson"] = sha256(unitsRaw);
  hashes["source-inventory.v1.json"] = sha256(sourcesRaw);
  hashes["collection-summary.v1.json"] = sha256(summaryRaw);
  writeFileSync(path.join(fixture.archiveRoot, "units.v1.ndjson"), unitsRaw, "utf8");
  writeFileSync(path.join(fixture.archiveRoot, "source-inventory.v1.json"), sourcesRaw, "utf8");
  writeFileSync(path.join(fixture.archiveRoot, "collection-summary.v1.json"), summaryRaw, "utf8");
  writeFileSync(
    path.join(fixture.archiveRoot, "cohort-manifest.v1.json"),
    stableJson(manifest),
    "utf8",
  );
}

function fixtureIdentity(archiveRoot: string): ExploratoryMeasurementAuditIdentity {
  return {
    protocolSha256,
    artifacts: Object.fromEntries(
      measurementAuditArtifactNames.map((name) => [
        name,
        sha256(readFileSync(path.join(archiveRoot, name), "utf8")),
      ]),
    ) as ExploratoryMeasurementAuditIdentity["artifacts"],
  };
}

function numericFact(
  value: number,
  sourceCategory: string,
  sourceIdentifier: string,
  sourceTimestamp: string,
) {
  return {
    value,
    availability: "AVAILABLE_AT_ANCHOR",
    sourceCategory,
    sourceIdentifier,
    sourceTimestamp,
  };
}

function booleanFact(
  value: boolean,
  sourceCategory: string,
  sourceIdentifier: string,
  sourceTimestamp: string,
) {
  return {
    value,
    availability: "AVAILABLE_AT_ANCHOR",
    sourceCategory,
    sourceIdentifier,
    sourceTimestamp,
  };
}

function unavailableFact(availability: string, sourceCategory: string, sourceIdentifier: string) {
  return { availability, sourceCategory, sourceIdentifier };
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

function syntheticMint(index: number): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const first = alphabet[Math.floor(index / alphabet.length) % alphabet.length] as string;
  const second = alphabet[index % alphabet.length] as string;
  return `${"1".repeat(30)}${first}${second}`;
}

function partitionFor(mint: string, slotId: string): "DISCOVERY" | "VALIDATION" {
  return Number.parseInt(
    sha256(`phase10.6a-exploratory-cohort.v2|${mint}|${slotId}`).at(-1) ?? "0",
    16,
  ) %
    2 ===
    0
    ? "DISCOVERY"
    : "VALIDATION";
}

function countPartitions(units: readonly Record<string, unknown>[]) {
  const counts = countBy(units.map((unit) => String(unit.partition)));
  return { DISCOVERY: counts.DISCOVERY ?? 0, VALIDATION: counts.VALIDATION ?? 0 };
}

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function canonicalWithoutAuditTime(
  value: { readonly generatedAt: string; readonly contentFingerprint: string } & object,
) {
  const clone = { ...value, generatedAt: "", contentFingerprint: "" };
  return JSON.stringify(sortValue(clone));
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

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
