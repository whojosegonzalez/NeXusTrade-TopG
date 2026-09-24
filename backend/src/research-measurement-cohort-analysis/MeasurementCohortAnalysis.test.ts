import type * as NodeFs from "node:fs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runMeasurementCohortAnalysisCli } from "./MeasurementCohortAnalysisCli.js";
import {
  parseMeasurementCohortAnalysisArgs,
  resolveMeasurementCohortAnalysisArchive,
} from "./MeasurementCohortAnalysisConfig.js";
import { formatMeasurementCohortAnalysisError } from "./MeasurementCohortAnalysisErrors.js";
import {
  MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT,
  MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH,
  MEASUREMENT_COHORT_ANALYSIS_APPROVED_IDENTITY,
  MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256,
} from "./MeasurementCohortAnalysisIdentity.js";
import { MeasurementCohortAnalysisLoader } from "./MeasurementCohortAnalysisLoader.js";
import {
  formatMeasurementCohortAnalysisJson,
  formatMeasurementCohortAnalysisMarkdown,
} from "./MeasurementCohortAnalysisFormatter.js";
import { MeasurementCohortAnalysisService } from "./MeasurementCohortAnalysisService.js";
import type { LoadedMeasurementCohortAnalysisArchive } from "./MeasurementCohortAnalysisTypes.js";

// Observe analyzer I/O without substituting filesystem behavior in path regression tests.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    existsSync: vi.fn(fs.existsSync),
    lstatSync: vi.fn(fs.lstatSync),
    readdirSync: vi.fn(fs.readdirSync),
    realpathSync: vi.fn(fs.realpathSync),
    readFileSync: vi.fn(fs.readFileSync),
  };
});

import {
  temporaryRoots,
  repoRoot,
  artifactNames,
  makeFinalFixture,
  loadFixture,
  expectLoaderError,
  expectErrorCode,
  rewriteInternalHashes,
  fixtureIdentity,
  syntheticArchive,
} from "./MeasurementCohortAnalysis.test-support.js";
const temporaryLinks: string[] = [];

afterEach(() => {
  for (const link of temporaryLinks.splice(0)) {
    assertOwnedFixturePath(link);
    unlinkSync(link);
  }
  for (const root of temporaryRoots.splice(0)) {
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("nexustrade-measurement-analysis-")
    ) {
      throw new Error("Refusing cleanup outside the synthetic fixture directory.");
    }
    rmSync(root, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe("MeasurementCohortAnalysis", () => {
  it("accepts only its small fixed CLI surface before any archive action", () => {
    expect(parseMeasurementCohortAnalysisArgs(["--once", "--format=json"])).toEqual({
      once: true,
      format: "json",
    });
    for (const args of [
      ["--once", "--once"],
      ["--format=json", "--format=markdown"],
      ["--archive-root=x"],
      ["--provider=anything"],
      ["--output=x"],
      ["--wallet=x"],
      ["--format", "json"],
    ]) {
      expectErrorCode(
        () => parseMeasurementCohortAnalysisArgs(args),
        "MEASUREMENT_COHORT_ANALYSIS_INVALID_SCOPE",
      );
    }
  });

  it("default-denies an injected unbound identity before resolving or opening an archive", () => {
    const output: string[] = [];
    vi.clearAllMocks();
    expectErrorCode(
      () =>
        runMeasurementCohortAnalysisCli(["--format=json"], (value) => output.push(value), {
          approvedIdentity: undefined,
        }),
      "MEASUREMENT_COHORT_ANALYSIS_IDENTITY_NOT_REGISTERED",
    );
    expect(output).toEqual([]);
    expectNoFilesystemAccess();
  });

  it.each([
    "archive",
    "root",
    "protocol",
    "identity",
    "output",
    "write",
    "save",
    "file",
    "db",
    "database",
    "runtime",
    "scanner",
    "watchlist",
    "risk",
    "strategy",
    "provider",
    "environment",
    "env",
    "session",
    "score",
    "threshold",
    "target",
    "stop",
    "monitor",
    "scheduler",
    "wallet",
    "sign",
    "submit",
    "paper",
    "live",
    "execution",
    "order",
    "fill",
    "position",
    "balance",
    "url",
    "http",
    "phase",
    "cohort",
    "include",
    "config",
    "unknown",
  ])("rejects the --%s option family before filesystem access", (family) => {
    for (const option of [`--${family}`, `--${family}=synthetic-sensitive-value`]) {
      const write = vi.fn();
      vi.clearAllMocks();
      expectErrorCode(
        () => runMeasurementCohortAnalysisCli([option], write),
        "MEASUREMENT_COHORT_ANALYSIS_INVALID_SCOPE",
      );
      expect(write).not.toHaveBeenCalled();
      expectNoFilesystemAccess();
    }
  });

  describe("filesystem containment", () => {
    it("resolves only the fixed archive below a regular synthetic repository", () => {
      const fixture = makeFinalFixture();
      expect(resolveMeasurementCohortAnalysisArchive(fixture.repoRoot)).toBe(fixture.root);
      expect(loadFixture(fixture).validUnitCount).toBe(96);
    });

    it("rejects a different archive root before reading its artifacts", () => {
      const fixture = makeFinalFixture();
      const other = makeFinalFixture();
      vi.clearAllMocks();
      expectErrorCode(
        () =>
          new MeasurementCohortAnalysisLoader({ identity: other.identity }).load(
            other.root,
            fixture.repoRoot,
          ),
        "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL",
      );
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it.each([
      "data",
      "data/archive",
      "data/archive/phase10.6a",
      MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_ROOT,
    ])("rejects an archive junction at %s before reading artifacts", (relative) => {
      const fixture = makeFinalFixture();
      const other = makeFinalFixture();
      const linked = path.join(fixture.repoRoot, relative);
      renameSync(linked, path.join(fixture.repoRoot, "saved-original"));
      linkFixtureDirectory(path.join(other.repoRoot, relative), linked);
      vi.clearAllMocks();
      expectErrorCode(
        () => resolveMeasurementCohortAnalysisArchive(fixture.repoRoot),
        "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL",
      );
      expectErrorCode(() => loadFixture(fixture), "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL");
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it("rejects a repository reached through a junction", () => {
      const fixture = makeFinalFixture();
      const owner = makeFinalFixture();
      const alias = path.join(owner.repoRoot, "repo-alias");
      linkFixtureDirectory(fixture.repoRoot, alias);
      vi.clearAllMocks();
      expectErrorCode(
        () => resolveMeasurementCohortAnalysisArchive(alias),
        "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL",
      );
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it.each(artifactNames)(
      "rejects a linked artifact %s without reading its target",
      (artifact) => {
        const fixture = makeFinalFixture();
        const other = makeFinalFixture();
        const linked = path.join(fixture.root, artifact);
        unlinkSync(linked);
        linkFixtureDirectory(other.root, linked);
        vi.clearAllMocks();
        expectLoaderError(
          fixture.root,
          fixture.identity,
          "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
        );
        expect(vi.mocked(readFileSync).mock.calls.map(([file]) => file)).not.toContain(linked);
      },
    );

    it.each(["docs", "docs/research-protocols"])(
      "rejects a protocol parent junction at %s without reading protocol bytes",
      (relative) => {
        const fixture = makeFinalFixture();
        const other = makeFinalFixture();
        const linked = path.join(fixture.repoRoot, relative);
        renameSync(linked, path.join(fixture.repoRoot, "saved-docs"));
        linkFixtureDirectory(path.join(other.repoRoot, relative), linked);
        vi.clearAllMocks();
        expectLoaderError(
          fixture.root,
          fixture.identity,
          "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
        );
        expect(vi.mocked(readFileSync).mock.calls.map(([file]) => file)).not.toContain(
          path.join(fixture.repoRoot, MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH),
        );
      },
    );

    it.each(["missing", "directory", "different-bytes", "outside-override"])(
      "rejects a %s protocol source",
      (condition) => {
        const fixture = makeFinalFixture();
        const protocol = path.join(fixture.repoRoot, MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH);
        if (condition === "missing" || condition === "directory") unlinkSync(protocol);
        if (condition === "directory") mkdirSync(protocol);
        if (condition === "different-bytes") writeFileSync(protocol, "synthetic changed protocol");
        const options =
          condition === "outside-override"
            ? {
                identity: fixture.identity,
                protocolPath: path.join(repoRoot, MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_PATH),
              }
            : { identity: fixture.identity };
        vi.clearAllMocks();
        expectErrorCode(
          () => new MeasurementCohortAnalysisLoader(options).load(fixture.root, fixture.repoRoot),
          "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
        );
        if (condition !== "different-bytes") {
          expect(vi.mocked(readFileSync).mock.calls.map(([file]) => file)).not.toContain(protocol);
        }
      },
    );

    it.each(artifactNames)("rejects a missing final artifact %s", (artifact) => {
      const fixture = makeFinalFixture();
      unlinkSync(path.join(fixture.root, artifact));
      vi.clearAllMocks();
      expectLoaderError(
        fixture.root,
        fixture.identity,
        "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
      );
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it("bounds unexpected filesystem failures without leaking paths or exception text", () => {
      const fixture = makeFinalFixture();
      vi.mocked(lstatSync).mockImplementationOnce(() => {
        throw new Error("synthetic-sensitive-path");
      });
      expectErrorCode(
        () => resolveMeasurementCohortAnalysisArchive(fixture.repoRoot),
        "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL",
      );
      expect(formatMeasurementCohortAnalysisError(new Error("synthetic-sensitive-path"))).toBe(
        "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY: Measurement cohort analysis failed closed.",
      );
    });
  });

  it("pins exactly one complete source-controlled production archive identity", () => {
    expect(MEASUREMENT_COHORT_ANALYSIS_APPROVED_IDENTITY).toEqual({
      protocolSha256: MEASUREMENT_COHORT_ANALYSIS_PROTOCOL_SHA256,
      artifacts: {
        "cohort-manifest.v1.json":
          "15cdf48a48d21f9533a2db1dea36aeac41ca180127ff174fa90ad21c433efd8b",
        "units.v1.ndjson": "10d86dd3e4d03eb5c57b40ac358b8cc683de5dcfaac97659688736710289fe29",
        "source-inventory.v1.json":
          "45239e8ee422b6c240592093d85347b8fa7ba4cf512a0ee735951f585c5ac7bc",
        "collection-summary.v1.json":
          "22d29fb0528ad568f070a229c65a429bfc797563fe53b3d64d7198f556f74f68",
      },
    });
  });

  it("loads an injected identity fixture and confirms measurement capability without raw values", () => {
    const fixture = makeFinalFixture();
    const archive = loadFixture(fixture);
    const analysis = new MeasurementCohortAnalysisService({
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    }).buildFromLoadedArchive(archive);
    const json = formatMeasurementCohortAnalysisJson(analysis);
    const markdown = formatMeasurementCohortAnalysisMarkdown(analysis);
    expect(analysis.outcome).toEqual({
      status: "MEASUREMENT_CAPABILITY_CONFIRMED",
      failedGateIds: [],
    });
    expect(analysis.archiveIdentity.status).toBe("MATCHED");
    expect(analysis.safety).toMatchObject({ providerCalls: 0, filesystemWrites: 0 });
    expect(json).not.toContain("12345.6789");
    expect(markdown).not.toContain("12345.6789");
    expect(json).not.toContain("SLOT_");
    expect(markdown).not.toContain("https://");
  });

  it("allows a bounded unrecorded slot while rejecting invalid slot-ledger evidence", () => {
    const unrecordedSlot = makeFinalFixture({ unrecordedSlotIndex: 64 });
    expect(loadFixture(unrecordedSlot).validUnitCount).toBe(96);

    for (const mutate of [
      (slots: Record<string, unknown>[]) => {
        const first = slots[0];
        const second = slots[1];
        if (!first || !second)
          throw new Error("Synthetic slot fixture is unexpectedly incomplete.");
        second.slotIndex = first.slotIndex;
        second.slotId = first.slotId;
        second.anchorAt = first.anchorAt;
      },
      (slots: Record<string, unknown>[]) => {
        const first = slots[0];
        const second = slots[1];
        if (!first || !second)
          throw new Error("Synthetic slot fixture is unexpectedly incomplete.");
        slots[0] = second;
        slots[1] = first;
      },
      (slots: Record<string, unknown>[]) => {
        const first = slots[0];
        if (!first) throw new Error("Synthetic slot fixture is unexpectedly incomplete.");
        first.slotId = "SLOT_168";
      },
      (slots: Record<string, unknown>[]) => {
        const first = slots[0];
        if (!first) throw new Error("Synthetic slot fixture is unexpectedly incomplete.");
        first.anchorAt = "2026-09-04T23:00:00.000Z";
      },
    ]) {
      const invalid = makeFinalFixture();
      const manifest = JSON.parse(
        readFileSync(path.join(invalid.root, "cohort-manifest.v1.json"), "utf8"),
      );
      {
        const slots = manifest.slots;
        if (!Array.isArray(slots))
          throw new Error("Synthetic manifest slots are unexpectedly absent.");
        mutate(slots as Record<string, unknown>[]);
      }
      writeFileSync(path.join(invalid.root, "cohort-manifest.v1.json"), JSON.stringify(manifest));
      const identity = rewriteInternalHashes(invalid.root);
      expectLoaderError(invalid.root, identity, "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY");
    }
  });

  it("reports a frozen availability failure without inspecting numerical values", () => {
    const fixture = makeFinalFixture({ unavailableLiquidity: 6 });
    const analysis = new MeasurementCohortAnalysisService({
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    }).buildFromLoadedArchive(loadFixture(fixture));
    expect(analysis.outcome.status).toBe("MEASUREMENT_CAPABILITY_NOT_CONFIRMED");
    expect(analysis.outcome.failedGateIds).toContain("LIQUIDITY_AVAILABILITY:DISCOVERY");
  });

  it("reports insufficient evidence independently from the planned 96-unit target", () => {
    const archive = syntheticArchive({ validUnitCount: 71 });
    const analysis = new MeasurementCohortAnalysisService({
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    }).buildFromLoadedArchive(archive);
    expect(analysis.outcome.status).toBe("MEASUREMENT_EVIDENCE_INSUFFICIENT");
    expect(analysis.outcome.failedGateIds).toContain("MINIMUM_VALID_UNITS");
    expect(analysis.outcome.failedGateIds).not.toContain("PLANNED_VALID_UNITS");
  });

  it("implements the exact 90 percent availability boundary as a frozen gate", () => {
    const archive = syntheticArchive({ validUnitCount: 100 });
    const unavailable = new Set(
      archive.units
        .map((unit, index) => ({ unit, index }))
        .filter(({ unit }) => unit.partition === "DISCOVERY")
        .slice(0, 5)
        .map(({ index }) => index),
    );
    const boundaryArchive = {
      ...archive,
      units: archive.units.map((unit, index) =>
        unavailable.has(index)
          ? {
              ...unit,
              facts: {
                ...unit.facts,
                LIQUIDITY: {
                  availability: "UNAVAILABLE_AT_ANCHOR" as const,
                  sourceCategory: "MARKET_CONTEXT" as const,
                  sourceIdentifier: "BEST_PAIR" as const,
                },
              },
            }
          : unit,
      ),
    } satisfies LoadedMeasurementCohortAnalysisArchive;
    const analysis = new MeasurementCohortAnalysisService({
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    }).buildFromLoadedArchive(boundaryArchive);
    const liquidityDiscovery = analysis.objectiveAvailabilityLedger.find(
      (row) => row.objective === "LIQUIDITY" && row.partition === "DISCOVERY",
    );
    expect(liquidityDiscovery?.availabilityPct).toBe(90);
    expect(liquidityDiscovery?.availabilityGatePassed).toBe(true);
    expect(analysis.outcome.status).toBe("MEASUREMENT_CAPABILITY_CONFIRMED");
  });

  it("fails closed for every externally registered artifact mismatch and coherent rewrite", () => {
    for (const artifact of artifactNames) {
      const fixture = makeFinalFixture();
      writeFileSync(
        path.join(fixture.root, artifact),
        `${readFileSync(path.join(fixture.root, artifact), "utf8")} `,
      );
      expectLoaderError(
        fixture.root,
        fixture.identity,
        "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
      );
    }
    const fixture = makeFinalFixture();
    const unitsPath = path.join(fixture.root, "units.v1.ndjson");
    const [firstUnitLine, ...remainingUnitLines] = readFileSync(unitsPath, "utf8").split("\n");
    if (!firstUnitLine) throw new Error("Synthetic unit fixture is unexpectedly empty.");
    const changedUnit = JSON.parse(firstUnitLine) as Record<string, unknown>;
    const snapshots = (changedUnit.decisionTime as Record<string, unknown>).snapshots as Record<
      string,
      unknown
    >[];
    const firstSnapshot = snapshots[0];
    if (!firstSnapshot) throw new Error("Synthetic snapshot fixture is unexpectedly empty.");
    (firstSnapshot.priceUsd as Record<string, unknown>).value = 98765.4321;
    writeFileSync(
      unitsPath,
      `${JSON.stringify(changedUnit)}\n${remainingUnitLines.join("\n")}`,
      "utf8",
    );
    rewriteInternalHashes(fixture.root);
    expectLoaderError(
      fixture.root,
      fixture.identity,
      "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
    );
  });

  it("quarantines labels and rejects active, unsafe, and inconsistent fixture states", () => {
    const labelled = makeFinalFixture();
    const rows = readFileSync(path.join(labelled.root, "units.v1.ndjson"), "utf8")
      .trim()
      .split("\n");
    const firstLine = rows[0];
    if (!firstLine) throw new Error("Synthetic unit fixture is unexpectedly empty.");
    const first = JSON.parse(firstLine) as Record<string, unknown>;
    first.laterObservations = [];
    rows[0] = JSON.stringify(first);
    writeFileSync(path.join(labelled.root, "units.v1.ndjson"), `${rows.join("\n")}\n`, "utf8");
    const identity = rewriteInternalHashes(labelled.root);
    expectLoaderError(
      labelled.root,
      identity,
      "MEASUREMENT_COHORT_ANALYSIS_LABEL_QUARANTINE_VIOLATION",
    );

    const locked = makeFinalFixture();
    writeFileSync(path.join(locked.root, "collection.lock"), "synthetic", "utf8");
    expectLoaderError(
      locked.root,
      locked.identity,
      "MEASUREMENT_COHORT_ANALYSIS_ARCHIVE_NOT_FINAL",
    );

    const invalid = makeFinalFixture();
    const manifestPath = path.join(invalid.root, "cohort-manifest.v1.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.outcome = "COLLECTING";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const invalidIdentity = fixtureIdentity(invalid.root);
    expectLoaderError(
      invalid.root,
      invalidIdentity,
      "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
    );
  });

  it("fails closed on unexpected artifacts and semantic source-integrity violations", () => {
    const unexpected = makeFinalFixture();
    writeFileSync(path.join(unexpected.root, "unexpected.tmp"), "fixture", "utf8");
    expectLoaderError(
      unexpected.root,
      unexpected.identity,
      "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
    );

    const invalidSource = makeFinalFixture();
    const sourcesPath = path.join(invalidSource.root, "source-inventory.v1.json");
    const sources = JSON.parse(readFileSync(sourcesPath, "utf8")) as Record<string, unknown>[];
    const firstSource = sources[0];
    if (!firstSource) throw new Error("Synthetic source fixture is unexpectedly empty.");
    firstSource.sourceHash = "0".repeat(64);
    writeFileSync(sourcesPath, JSON.stringify(sources), "utf8");
    const invalidSourceIdentity = rewriteInternalHashes(invalidSource.root);
    expectLoaderError(
      invalidSource.root,
      invalidSourceIdentity,
      "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
    );

    const stale = makeFinalFixture();
    const staleRows = readFileSync(path.join(stale.root, "units.v1.ndjson"), "utf8")
      .trim()
      .split("\n");
    const staleFirstLine = staleRows[0];
    if (!staleFirstLine) throw new Error("Synthetic unit fixture is unexpectedly empty.");
    const staleUnit = JSON.parse(staleFirstLine) as Record<string, unknown>;
    const staleSnapshots = (staleUnit.decisionTime as Record<string, unknown>).snapshots as Record<
      string,
      unknown
    >[];
    const staleAnchor = staleSnapshots[3];
    if (!staleAnchor) throw new Error("Synthetic anchor snapshot is unexpectedly absent.");
    const staleLiquidity = staleAnchor.liquidityUsd as Record<string, unknown>;
    const staleAt = new Date(
      new Date(staleAnchor.scheduledAt as string).valueOf() + 61_000,
    ).toISOString();
    staleLiquidity.sourceTimestamp = staleAt;
    (
      (staleUnit.decisionTime as Record<string, unknown>).market as Record<string, unknown>
    ).liquidityUsd = staleLiquidity;
    staleRows[0] = JSON.stringify(staleUnit);
    writeFileSync(path.join(stale.root, "units.v1.ndjson"), `${staleRows.join("\n")}\n`, "utf8");
    const staleIdentity = rewriteInternalHashes(stale.root);
    expectLoaderError(
      stale.root,
      staleIdentity,
      "MEASUREMENT_COHORT_ANALYSIS_SOURCE_INCONSISTENCY",
    );
  });

  it("makes canonical output stable except for generatedAt and retains the empty fingerprint preimage", () => {
    const archive = syntheticArchive({ validUnitCount: 96 });
    const first = new MeasurementCohortAnalysisService({
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    }).buildFromLoadedArchive(archive);
    const second = new MeasurementCohortAnalysisService({
      now: () => new Date("2026-10-02T00:00:00.000Z"),
    }).buildFromLoadedArchive(archive);
    expect(first.contentFingerprint).toBe(second.contentFingerprint);
    const firstJson = JSON.parse(formatMeasurementCohortAnalysisJson(first)) as Record<
      string,
      unknown
    >;
    const secondJson = JSON.parse(formatMeasurementCohortAnalysisJson(second)) as Record<
      string,
      unknown
    >;
    delete firstJson.generatedAt;
    delete secondJson.generatedAt;
    expect(firstJson).toEqual(secondJson);
  });

  it("keeps the analysis implementation isolated from collection, provider, runtime, and execution modules", () => {
    const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
    for (const name of [
      "MeasurementCohortAnalysisCli.ts",
      "MeasurementCohortAnalysisConfig.ts",
      "MeasurementCohortAnalysisFormatter.ts",
      "MeasurementCohortAnalysisIdentity.ts",
      "MeasurementCohortAnalysisLoader.ts",
      "MeasurementCohortAnalysisService.ts",
    ]) {
      const importLines = readFileSync(path.join(sourceRoot, name), "utf8")
        .split("\n")
        .filter((line) => line.includes(" from "))
        .join("\n");
      expect(importLines).not.toMatch(
        /research-measurement-cohort\/(?!analysis)|providers\/|database|runtime\//i,
      );
    }
  });
});

function expectNoFilesystemAccess(): void {
  for (const operation of [existsSync, lstatSync, readdirSync, realpathSync, readFileSync]) {
    expect(operation).not.toHaveBeenCalled();
  }
}

function assertOwnedFixturePath(file: string): void {
  if (
    !temporaryRoots.some((root) => {
      const relative = path.relative(root, path.resolve(file));
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    })
  )
    throw new Error("Refusing filesystem mutation outside owned synthetic fixtures.");
}

function linkFixtureDirectory(target: string, link: string): void {
  assertOwnedFixturePath(link);
  if (!temporaryRoots.some((root) => target === root || target.startsWith(`${root}${path.sep}`))) {
    throw new Error("Refusing a link to a non-fixture target.");
  }
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  temporaryLinks.push(link);
}
