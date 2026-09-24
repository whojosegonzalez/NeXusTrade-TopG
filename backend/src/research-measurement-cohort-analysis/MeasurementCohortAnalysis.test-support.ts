import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { MeasurementCohortAnalysisError } from "./MeasurementCohortAnalysisErrors.js";
import {
  MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT,
  MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH,
  MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256,
  type MeasurementCohortAnalysisIdentity,
} from "./MeasurementCohortAnalysisIdentity.js";
import { MeasurementCohortAnalysisLoader } from "./MeasurementCohortAnalysisLoader.js";
import type { LoadedMeasurementCohortAnalysisArchive } from "./MeasurementCohortAnalysisTypes.js";
export const temporaryRoots: string[] = [];
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const artifactNames = [
  "cohort-manifest.v1.json",
  "units.v1.ndjson",
  "source-inventory.v1.json",
  "collection-summary.v1.json",
] as const;
export function cleanupFixtures(): void {
  for (const root of temporaryRoots.splice(0)) {
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("nexustrade-measurement-analysis-")
    )
      throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
}
export function makeFinalFixture(
  options: {
    readonly unavailableLiquidity?: number;
    readonly unitCount?: number;
    readonly unrecordedSlotIndex?: number;
  } = {},
) {
  const fixtureRepoRoot = mkdtempSync(path.join(os.tmpdir(), "nexustrade-measurement-analysis-"));
  temporaryRoots.push(fixtureRepoRoot);
  const root = path.join(fixtureRepoRoot, MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT);
  const protocol = path.join(fixtureRepoRoot, MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH);
  mkdirSync(root, { recursive: true });
  mkdirSync(path.dirname(protocol), { recursive: true });
  writeFileSync(
    protocol,
    readFileSync(path.join(repoRoot, MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH)),
  );
  const units = buildRawUnits(
    (options.unitCount ?? 96) + (options.unrecordedSlotIndex === undefined ? 0 : 1),
    options.unavailableLiquidity ?? 0,
  ).filter((_, index) => index !== options.unrecordedSlotIndex);
  const slots = units.map((unit) => ({
    slotId: unit.slotId,
    slotIndex: Number(String(unit.slotId).slice(5)) - 1,
    anchorAt: unit.anchorAt,
    state: "VALID_UNIT",
    reason: "VALID_TECHNICAL_UNIT",
    discoveryCounts: { returned: 1, canonical: 1, technicallyValid: 1 },
    selectedMint: unit.canonicalMint,
  }));
  const sources = units.flatMap((unit) => {
    const observedAt = new Date(new Date(unit.anchorAt as string).valueOf() - 60_000).toISOString();
    return [
      source("DISCOVERY", "DISCOVER_TOKENS", observedAt),
      source("MARKET_CONTEXT", "BEST_PAIR", observedAt),
      source("MARKET_CONTEXT", "BEST_PAIR", observedAt),
      source("MARKET_CONTEXT", "BEST_PAIR", observedAt),
      source("MARKET_CONTEXT", "BEST_PAIR", observedAt),
    ];
  });
  const providerCounts = {
    DISCOVERY: sources.filter((row) => row.category === "DISCOVERY").length,
    MARKET_CONTEXT: sources.filter((row) => row.category === "MARKET_CONTEXT").length,
  };
  const safety = {
    databaseReads: 0,
    databaseWrites: 0,
    sessions: 0,
    orders: 0,
    fills: 0,
    positions: 0,
    walletLoaded: false,
    transactionSigning: false,
    transactionSubmission: false,
  } as const;
  const summary = {
    contractVersion: "1",
    outcome:
      units.length === 96 && !(options.unavailableLiquidity && options.unavailableLiquidity > 4)
        ? "COHORT_COMPLETE"
        : "MEASUREMENT_COHORT_DATA_INSUFFICIENT",
    validUnitCount: units.length,
    slotCount: slots.length,
    providerCounts,
    safety,
    dateCounts: countRawDates(units),
  };
  writeFileSync(
    path.join(root, "units.v1.ndjson"),
    `${units.map((unit) => JSON.stringify(unit)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(path.join(root, "source-inventory.v1.json"), JSON.stringify(sources), "utf8");
  writeFileSync(path.join(root, "collection-summary.v1.json"), JSON.stringify(summary), "utf8");
  const manifest = {
    contractVersion: "1",
    archiveRoot: "data/archive/phase10.6a/measurement-v3-20260904-2100Z/",
    launch: launch(),
    executionDisabled: true,
    outcome:
      units.length === 96 && !(options.unavailableLiquidity && options.unavailableLiquidity > 4)
        ? "COHORT_COMPLETE"
        : "MEASUREMENT_COHORT_DATA_INSUFFICIENT",
    slots,
    providerCounts,
    finalFileHashes: {
      "units.v1.ndjson": hashFile(path.join(root, "units.v1.ndjson")),
      "source-inventory.v1.json": hashFile(path.join(root, "source-inventory.v1.json")),
      "collection-summary.v1.json": hashFile(path.join(root, "collection-summary.v1.json")),
    },
    safety,
  };
  writeFileSync(path.join(root, "cohort-manifest.v1.json"), JSON.stringify(manifest), "utf8");
  return { root, repoRoot: fixtureRepoRoot, identity: fixtureIdentity(root) };
}

export function loadFixture(fixture: {
  readonly root: string;
  readonly repoRoot: string;
  readonly identity: MeasurementCohortAnalysisIdentity;
}) {
  return new MeasurementCohortAnalysisLoader({ identity: fixture.identity }).load(
    fixture.root,
    fixture.repoRoot,
  );
}

export function expectLoaderError(
  root: string,
  identity: MeasurementCohortAnalysisIdentity,
  code: string,
): void {
  try {
    // Fixtures use the same four-component archive layout as the fixed production root.
    new MeasurementCohortAnalysisLoader({ identity }).load(root, path.resolve(root, "../../../.."));
    throw new Error("Expected the fixture to fail closed.");
  } catch (error) {
    expect(error).toBeInstanceOf(MeasurementCohortAnalysisError);
    expect((error as MeasurementCohortAnalysisError).code).toBe(code);
  }
}

export function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected the action to fail closed.");
  } catch (error) {
    expect(error).toBeInstanceOf(MeasurementCohortAnalysisError);
    expect((error as MeasurementCohortAnalysisError).code).toBe(code);
  }
}

export function rewriteInternalHashes(root: string): MeasurementCohortAnalysisIdentity {
  const manifestPath = path.join(root, "cohort-manifest.v1.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.finalFileHashes = {
    "units.v1.ndjson": hashFile(path.join(root, "units.v1.ndjson")),
    "source-inventory.v1.json": hashFile(path.join(root, "source-inventory.v1.json")),
    "collection-summary.v1.json": hashFile(path.join(root, "collection-summary.v1.json")),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
  return fixtureIdentity(root);
}

export function fixtureIdentity(root: string): MeasurementCohortAnalysisIdentity {
  return {
    protocolSha256: MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256,
    artifacts: Object.fromEntries(
      artifactNames.map((name) => [name, hashFile(path.join(root, name))]),
    ) as MeasurementCohortAnalysisIdentity["artifacts"],
  };
}

export function buildRawUnits(
  count: number,
  unavailableLiquidity: number,
): Record<string, unknown>[] {
  const units: Record<string, unknown>[] = [];
  let discoveryCount = 0;
  let validationCount = 0;
  for (let index = 0; index < count; index += 1) {
    const slotId = `SLOT_${String(index + 1).padStart(3, "0")}`;
    const target = discoveryCount < Math.ceil(count / 2) ? "DISCOVERY" : "VALIDATION";
    const canonicalMint = mintFor(slotId, target, index);
    const partition = partitionFor(canonicalMint, slotId);
    if (partition === "DISCOVERY") discoveryCount += 1;
    else validationCount += 1;
    const anchorAt = new Date(
      Date.parse("2026-09-04T21:00:00.000Z") + index * 120 * 60 * 1000,
    ).toISOString();
    const prices = [12340.6789 + index, 12342.6789 + index, 12344.6789 + index, 12345.6789 + index];
    const snapshot = (offsetMinutes: -15 | -10 | -5 | 0, price: number) => ({
      offsetMinutes,
      scheduledAt: new Date(new Date(anchorAt).valueOf() + offsetMinutes * 60_000).toISOString(),
      priceUsd: marketFact(
        price,
        new Date(new Date(anchorAt).valueOf() + offsetMinutes * 60_000).toISOString(),
      ),
      ...(offsetMinutes === 0
        ? {
            liquidityUsd:
              index < unavailableLiquidity ? unavailableFact() : marketFact(5000 + index, anchorAt),
          }
        : {}),
    });
    const [price15m, price10m, price5m, current] = prices;
    if (
      price15m === undefined ||
      price10m === undefined ||
      price5m === undefined ||
      current === undefined
    ) {
      throw new Error("Synthetic price sequence is unexpectedly incomplete.");
    }
    const momentum5m = (current / price5m - 1) * 100;
    const momentum15m = (current / price15m - 1) * 100;
    const liquidity =
      index < unavailableLiquidity ? unavailableFact() : marketFact(5000 + index, anchorAt);
    units.push({
      unitId: hash(`${slotId}|${canonicalMint}`).slice(0, 24),
      slotId,
      anchorAt,
      canonicalMint,
      partition,
      selection: {
        sourceKind: "DEXSCREENER_TOKEN_PROFILE",
        firstObservedAt: new Date(new Date(anchorAt).valueOf() - 60_000).toISOString(),
        selectionHash: hash(`phase10.6a-exploratory-cohort.v3|${canonicalMint}|${slotId}`),
      },
      decisionTime: {
        snapshots: [
          snapshot(-15, price15m),
          snapshot(-10, price10m),
          snapshot(-5, price5m),
          snapshot(0, current),
        ],
        market: {
          liquidityUsd: liquidity,
          momentum5mPct: {
            availability: "AVAILABLE_AT_ANCHOR",
            sourceCategory: "LOCAL",
            sourceIdentifier: "FORMULA",
            value: momentum5m,
          },
          momentum15mPct: {
            availability: "AVAILABLE_AT_ANCHOR",
            sourceCategory: "LOCAL",
            sourceIdentifier: "FORMULA",
            value: momentum15m,
          },
        },
      },
    });
  }
  void validationCount;
  return units;
}

export function syntheticArchive(input: {
  readonly validUnitCount: number;
}): LoadedMeasurementCohortAnalysisArchive {
  const units = buildRawUnits(input.validUnitCount, 0).map((unit) => {
    const raw = unit.decisionTime as Record<string, unknown>;
    const market = raw.market as Record<string, Record<string, string>>;
    const liquidity = market.liquidityUsd;
    const momentum5m = market.momentum5mPct;
    const momentum15m = market.momentum15mPct;
    if (!liquidity || !momentum5m || !momentum15m) {
      throw new Error("Synthetic market fixture is unexpectedly incomplete.");
    }
    return {
      partition: unit.partition as "DISCOVERY" | "VALIDATION",
      anchorDate: (unit.anchorAt as string).slice(0, 10),
      facts: {
        LIQUIDITY: {
          availability: liquidity.availability as "AVAILABLE_AT_ANCHOR",
          sourceCategory: "MARKET_CONTEXT" as const,
          sourceIdentifier: "BEST_PAIR" as const,
        },
        MOMENTUM_5M: {
          availability: momentum5m.availability as "AVAILABLE_AT_ANCHOR",
          sourceCategory: "LOCAL" as const,
          sourceIdentifier: "FORMULA" as const,
        },
        MOMENTUM_15M: {
          availability: momentum15m.availability as "AVAILABLE_AT_ANCHOR",
          sourceCategory: "LOCAL" as const,
          sourceIdentifier: "FORMULA" as const,
        },
      },
    };
  });
  return {
    finalOutcome:
      input.validUnitCount === 96 ? "COHORT_COMPLETE" : "MEASUREMENT_COHORT_DATA_INSUFFICIENT",
    attemptedSlotCount: input.validUnitCount,
    validUnitCount: input.validUnitCount,
    distinctMintCount: input.validUnitCount,
    inventory: {
      "cohort-manifest.v1.json": "a".repeat(64),
      "units.v1.ndjson": "b".repeat(64),
      "source-inventory.v1.json": "c".repeat(64),
      "collection-summary.v1.json": "d".repeat(64),
    },
    units,
    sources: [],
  };
}

export function launch() {
  return {
    contractVersion: "1",
    archiveRoot: "data/archive/phase10.6a/measurement-v3-20260904-2100Z/",
    cohortStartAt: "2026-09-04T21:00:00.000Z",
    protocolPath: "docs/research-protocols/phase10.6a-exploratory-cohort.v3.json",
    protocolSha256: MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256,
    protocolValidationFingerprint:
      "b992982000ac2e0fb51cd7944a979adc0114f77a6845b3d36a3d88b9eab3e4e6",
    authorization: "USER_AUTHORIZED_FOR_ONE_MEASUREMENT_ONLY_COLLECTION",
    authorizationReference: "synthetic-test",
    operator: { kind: "EXTERNAL_OPERATOR", label: "synthetic-test" },
  };
}

export function source(
  category: "DISCOVERY" | "MARKET_CONTEXT",
  capability: "DISCOVER_TOKENS" | "BEST_PAIR",
  observedAt: string,
) {
  const sanitized = {
    category,
    capability,
    outcomeCode: "OK",
    observedAt,
    latencyBucket: "LT_100MS",
  };
  return {
    ...sanitized,
    provider: "DEXSCREENER",
    requestCount: 1,
    attemptCount: 1,
    sourceHash: hash(JSON.stringify(sanitized)),
  };
}

export function marketFact(value: number, sourceTimestamp: string) {
  return {
    availability: "AVAILABLE_AT_ANCHOR",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
    sourceTimestamp,
    value,
  };
}

export function unavailableFact() {
  return {
    availability: "UNAVAILABLE_AT_ANCHOR",
    sourceCategory: "MARKET_CONTEXT",
    sourceIdentifier: "BEST_PAIR",
  };
}

export function countRawDates(units: readonly Record<string, unknown>[]): Record<string, number> {
  return units.reduce<Record<string, number>>((counts, unit) => {
    const date = (unit.anchorAt as string).slice(0, 10);
    counts[date] = (counts[date] ?? 0) + 1;
    return counts;
  }, {});
}

function mintFor(slotId: string, target: "DISCOVERY" | "VALIDATION", offset: number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let seed = offset; seed < 10_000; seed += 1) {
    const mint = `${"A".repeat(37)}${encodeBase24(offset, alphabet)}${encodeBase24(seed, alphabet)}`;
    if (partitionFor(mint, slotId) === target) return mint;
  }
  throw new Error("Unable to construct a synthetic partitioned mint.");
}

function encodeBase24(value: number, alphabet: string): string {
  return [2, 1, 0]
    .map((shift) => alphabet[Math.floor(value / alphabet.length ** shift) % alphabet.length])
    .join("");
}

function partitionFor(mint: string, slotId: string): "DISCOVERY" | "VALIDATION" {
  return Number.parseInt(
    hash(`phase10.6a-exploratory-cohort.v3|${mint}|${slotId}`).at(-1) ?? "0",
    16,
  ) %
    2 ===
    0
    ? "DISCOVERY"
    : "VALIDATION";
}

export function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashFile(file: string): string {
  return hash(readFileSync(file));
}
