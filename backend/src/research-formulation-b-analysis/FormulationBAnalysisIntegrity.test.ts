import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFormulationBArchive } from "./FormulationBArchiveLoader.js";
import {
  buildStandardSyntheticCohort,
  writeSyntheticArchive,
  type SyntheticUnitInput,
} from "./FormulationBAnalysis.test-support.js";
import { FormulationBAnalysisError } from "./FormulationBAnalysisErrors.js";

describe("FormulationBAnalysisIntegrity", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "formulation-b-integrity-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("loads a valid synthetic archive successfully", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, { units });

    const loaded = loadFormulationBArchive(tempDir);
    expect(loaded.validUnitCount).toBe(96);
    expect(loaded.distinctMintCount).toBe(96);
    expect(loaded.finalOutcome).toBe("COHORT_COMPLETE");
  });

  it("fails closed with FORMULATION_B_ARCHIVE_NOT_FINAL when collection.lock is present", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, { units, activeLock: true });

    expect(() => loadFormulationBArchive(tempDir)).toThrowError(FormulationBAnalysisError);
    try {
      loadFormulationBArchive(tempDir);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(FormulationBAnalysisError);
      expect((err as FormulationBAnalysisError).code).toBe("FORMULATION_B_ARCHIVE_NOT_FINAL");
    }
  });

  it("fails closed with FORMULATION_B_UNSUPPORTED_ARCHIVE on protocol SHA mismatch", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, {
      units,
      protocolSha256: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    expect(() => loadFormulationBArchive(tempDir)).toThrowError(FormulationBAnalysisError);
    try {
      loadFormulationBArchive(tempDir);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(FormulationBAnalysisError);
      expect((err as FormulationBAnalysisError).code).toBe("FORMULATION_B_UNSUPPORTED_ARCHIVE");
    }
  });

  it("fails closed with FORMULATION_B_SOURCE_INCONSISTENCY on tampered units artifact", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, { units, tamperArtifact: "units" });

    expect(() => loadFormulationBArchive(tempDir)).toThrowError(FormulationBAnalysisError);
    try {
      loadFormulationBArchive(tempDir);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(FormulationBAnalysisError);
      expect((err as FormulationBAnalysisError).code).toBe("FORMULATION_B_SOURCE_INCONSISTENCY");
    }
  });

  it("fails closed with FORMULATION_B_SOURCE_INCONSISTENCY when liquidity fields are injected", () => {
    const baseUnits = buildStandardSyntheticCohort("passing");
    const first = baseUnits[0];
    const tamperedUnit: SyntheticUnitInput = {
      unitId: first?.unitId ?? "unit-000",
      canonicalMint: first?.canonicalMint ?? "Mint0",
      anchorAt: first?.anchorAt ?? "2026-09-01T00:00:00.000Z",
      slotId: first?.slotId ?? "slot-0",
      momentum5mPct: first?.momentum5mPct ?? 1.0,
      momentum15mPct: first?.momentum15mPct ?? 1.0,
      return60mPct: first?.return60mPct ?? 1.0,
      injectedLiquidity: 50000,
    };
    const units = [tamperedUnit, ...baseUnits.slice(1)];
    writeSyntheticArchive(tempDir, { units });

    expect(() => loadFormulationBArchive(tempDir)).toThrowError(FormulationBAnalysisError);
    try {
      loadFormulationBArchive(tempDir);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(FormulationBAnalysisError);
      expect((err as FormulationBAnalysisError).code).toBe("FORMULATION_B_SOURCE_INCONSISTENCY");
      expect((err as FormulationBAnalysisError).message).toContain(
        "Forbidden liquidity field detected",
      );
    }
  });

  it("fails closed with FORMULATION_B_SOURCE_INCONSISTENCY on nonzero safety counters", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, {
      units,
      safetyCounters: {
        clockDriftStops: 1,
        schemaIntegrityStops: 0,
        secretLeakageStops: 0,
        budgetExceededStops: 0,
      },
    });

    expect(() => loadFormulationBArchive(tempDir)).toThrowError(FormulationBAnalysisError);
    try {
      loadFormulationBArchive(tempDir);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(FormulationBAnalysisError);
      expect((err as FormulationBAnalysisError).code).toBe("FORMULATION_B_SOURCE_INCONSISTENCY");
    }
  });

  it("fails closed with FORMULATION_B_SOURCE_INCONSISTENCY on enabled execution flags", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, {
      units,
      executionFlags: {
        walletLoaded: true,
        transactionSigned: false,
        orderSubmitted: false,
      },
    });

    expect(() => loadFormulationBArchive(tempDir)).toThrowError(FormulationBAnalysisError);
    try {
      loadFormulationBArchive(tempDir);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(FormulationBAnalysisError);
      expect((err as FormulationBAnalysisError).code).toBe("FORMULATION_B_SOURCE_INCONSISTENCY");
    }
  });
});
