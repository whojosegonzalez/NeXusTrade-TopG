import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeFormulationBArchive } from "../research-formulation-b-analysis/FormulationBAnalysisService.js";
import { loadFormulationBArchive } from "../research-formulation-b-analysis/FormulationBArchiveLoader.js";
import { MockFormulationBProviderClient } from "./FormulationBCollection.test-support.js";
import { FormulationBCollectionError } from "./FormulationBCollectionErrors.js";
import { FormulationBCollectionRunner } from "./FormulationBCollectionRunner.js";
import type { FormulationBCollectionConfig } from "./FormulationBCollectionTypes.js";

const TEST_ARCHIVE_ROOT = "node_modules/.cache/test-formulation-b-collection-archive";

describe("FormulationBCollectionRunner", () => {
  beforeEach(() => {
    if (existsSync(TEST_ARCHIVE_ROOT)) {
      rmSync(TEST_ARCHIVE_ROOT, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_ARCHIVE_ROOT)) {
      rmSync(TEST_ARCHIVE_ROOT, { recursive: true, force: true });
    }
  });

  it("executes full synthetic collection and produces an archive that passes downstream analysis", async () => {
    const config: FormulationBCollectionConfig = {
      archiveRoot: TEST_ARCHIVE_ROOT,
      targetSlots: 96,
      days: 8,
      slotsPerDay: 12,
      dryRun: false,
      rateLimitMs: 0,
      requestTimeoutMs: 5000,
    };

    const provider = new MockFormulationBProviderClient({
      spotPriceUsd: 1.1, // Positive outcome
    });

    const runner = new FormulationBCollectionRunner(config, provider);
    const result = await runner.run();

    expect(result.success).toBe(true);
    expect(result.validUnits).toBe(96);
    expect(result.attemptedSlots).toBe(96);
    expect(result.finalOutcome).toBe("COHORT_COMPLETE");

    // Check files generated
    expect(existsSync(path.join(TEST_ARCHIVE_ROOT, "units.v1.ndjson"))).toBe(true);
    expect(existsSync(path.join(TEST_ARCHIVE_ROOT, "cohort-manifest.v1.json"))).toBe(true);
    expect(existsSync(path.join(TEST_ARCHIVE_ROOT, "collection-summary.v1.json"))).toBe(true);
    expect(existsSync(path.join(TEST_ARCHIVE_ROOT, "source-inventory.v1.json"))).toBe(true);

    // Lock file must be unlinked on success
    expect(existsSync(path.join(TEST_ARCHIVE_ROOT, "collection.lock"))).toBe(false);

    // Check NDJSON lines
    const ndjson = readFileSync(path.join(TEST_ARCHIVE_ROOT, "units.v1.ndjson"), "utf8");
    const lines = ndjson.trim().split("\n");
    expect(lines.length).toBe(96);

    // Verify downstream analyzer can load and analyze this archive cleanly
    const loaded = loadFormulationBArchive(TEST_ARCHIVE_ROOT);
    expect(loaded.units.length).toBe(96);
    expect(loaded.validUnitCount).toBe(96);

    const report = analyzeFormulationBArchive(loaded);
    expect(report.qualityGates.every((g) => g.passed)).toBe(true);
    expect(report.summary.totalUnits).toBe(96);
    expect(report.summary.discoveryUnits).toBeGreaterThanOrEqual(32);
    expect(report.summary.validationUnits).toBeGreaterThanOrEqual(32);
    expect(report.archiveOutcome).toBe("COHORT_COMPLETE");
  });

  it("fails closed on clock drift tripwire and preserves lock file", async () => {
    const config: FormulationBCollectionConfig = {
      archiveRoot: TEST_ARCHIVE_ROOT,
      targetSlots: 96,
      days: 8,
      slotsPerDay: 12,
      dryRun: false,
      rateLimitMs: 0,
      requestTimeoutMs: 5000,
    };

    const provider = new MockFormulationBProviderClient({
      discoverHeaders: {
        date: new Date(Date.now() - 10000).toUTCString(), // 10s drift (> 5s)
      },
    });

    const runner = new FormulationBCollectionRunner(config, provider);
    await expect(runner.run()).rejects.toThrowError(FormulationBCollectionError);

    // Lock file MUST be retained so downstream loaders fail closed
    expect(existsSync(path.join(TEST_ARCHIVE_ROOT, "collection.lock"))).toBe(true);

    // Manifest should record the stop
    const manifest = JSON.parse(
      readFileSync(path.join(TEST_ARCHIVE_ROOT, "cohort-manifest.v1.json"), "utf8"),
    );
    expect(manifest.finalOutcome).toBe("FORMULATION_B_CLOCK_DRIFT_STOP");
  });

  it("fails closed on secret leakage tripwire and preserves lock file", async () => {
    const config: FormulationBCollectionConfig = {
      archiveRoot: TEST_ARCHIVE_ROOT,
      targetSlots: 96,
      days: 8,
      slotsPerDay: 12,
      dryRun: false,
      rateLimitMs: 0,
      requestTimeoutMs: 5000,
    };

    const provider = new MockFormulationBProviderClient({
      momentumRawBody: "Error in request: Bearer secret_live_token_1234567890",
    });

    const runner = new FormulationBCollectionRunner(config, provider);
    await expect(runner.run()).rejects.toThrowError(FormulationBCollectionError);

    expect(existsSync(path.join(TEST_ARCHIVE_ROOT, "collection.lock"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(path.join(TEST_ARCHIVE_ROOT, "cohort-manifest.v1.json"), "utf8"),
    );
    expect(manifest.finalOutcome).toBe("FORMULATION_B_SECRET_LEAKAGE_STOP");
  });
});
