import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFormulationBArchive } from "./FormulationBArchiveLoader.js";
import { analyzeFormulationBArchive } from "./FormulationBAnalysisService.js";
import {
  buildStandardSyntheticCohort,
  writeSyntheticArchive,
  type SyntheticUnitInput,
} from "./FormulationBAnalysis.test-support.js";
import { FormulationBAnalysisError } from "./FormulationBAnalysisErrors.js";

describe("FormulationBAnalysis (8 Synthetic Fixture Matrix)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "formulation-b-fixtures-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("Fixture 01: Passing Discovery & Validation Replication -> PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL", () => {
    const units = buildStandardSyntheticCohort("passing");
    writeSyntheticArchive(tempDir, { units });

    const loaded = loadFormulationBArchive(tempDir);
    const report = analyzeFormulationBArchive(loaded);

    expect(report.decisionOutcome).toBe("PRE_REGISTRATION_READY_FOR_SEPARATE_APPROVAL");
    expect(report.qualityGates.every((g) => g.passed)).toBe(true);
    expect(report.discoveryGates.every((g) => g.passed)).toBe(true);
    expect(report.validationGates.every((g) => g.passed)).toBe(true);
    expect(report.discoveryEvaluation.rateDifference).toBeGreaterThanOrEqual(0.2);
    expect(report.validationEvaluation.rateDifference).toBeGreaterThan(0.0);
    expect(report.discoveryQ3Threshold).toBeDefined();
    expect(report.quantileIndex0Based).toBeDefined();
  });

  it("Fixture 02: Validation Replication Rejected -> PRE_REGISTRATION_CANDIDATE_REJECTED", () => {
    const units = buildStandardSyntheticCohort("validation_rejected");
    writeSyntheticArchive(tempDir, { units });

    const loaded = loadFormulationBArchive(tempDir);
    const report = analyzeFormulationBArchive(loaded);

    expect(report.decisionOutcome).toBe("PRE_REGISTRATION_CANDIDATE_REJECTED");
    expect(report.qualityGates.every((g) => g.passed)).toBe(true);
    expect(report.discoveryGates.every((g) => g.passed)).toBe(true);
    expect(report.validationGates.some((g) => !g.passed)).toBe(true);
  });

  it("Fixture 03: Discovery Effect < 0.20 -> NO_DEFENSIBLE_HYPOTHESIS", () => {
    const units = buildStandardSyntheticCohort("no_defensible");
    writeSyntheticArchive(tempDir, { units });

    const loaded = loadFormulationBArchive(tempDir);
    const report = analyzeFormulationBArchive(loaded);

    expect(report.decisionOutcome).toBe("NO_DEFENSIBLE_HYPOTHESIS");
    expect(report.qualityGates.every((g) => g.passed)).toBe(true);
    expect(report.discoveryGates.find((g) => g.gateId === "DISC_EFFECT_GATE")?.passed).toBe(false);
  });

  it("Fixture 04: Momentum Availability < 90% -> DATA_INSUFFICIENT", () => {
    const units = buildStandardSyntheticCohort("insufficient_mom");
    writeSyntheticArchive(tempDir, { units });

    const loaded = loadFormulationBArchive(tempDir);
    const report = analyzeFormulationBArchive(loaded);

    expect(report.decisionOutcome).toBe("DATA_INSUFFICIENT");
    expect(
      report.qualityGates.find((g) => g.gateId === "MOMENTUM_AVAILABILITY_FLOOR")?.passed,
    ).toBe(false);
  });

  it("Fixture 05: Valid Units < 72 -> DATA_INSUFFICIENT", () => {
    const units = buildStandardSyntheticCohort("insufficient_size");
    writeSyntheticArchive(tempDir, { units });

    const loaded = loadFormulationBArchive(tempDir);
    const report = analyzeFormulationBArchive(loaded);

    expect(report.decisionOutcome).toBe("DATA_INSUFFICIENT");
    expect(report.qualityGates.find((g) => g.gateId === "MINIMUM_VALID_UNITS")?.passed).toBe(false);
  });

  it("Fixture 06: Date Concentration > 20% -> DATA_INSUFFICIENT", () => {
    const units = buildStandardSyntheticCohort("concentration_breach");
    writeSyntheticArchive(tempDir, { units });

    const loaded = loadFormulationBArchive(tempDir);
    const report = analyzeFormulationBArchive(loaded);

    expect(report.decisionOutcome).toBe("DATA_INSUFFICIENT");
    expect(report.qualityGates.find((g) => g.gateId === "MAXIMUM_DATE_SHARE")?.passed).toBe(false);
  });

  it("Fixture 07: Tampered Manifest Checksum -> FORMULATION_B_SOURCE_INCONSISTENCY", () => {
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

  it("Fixture 08: Liquidity Feature Leakage Detection -> FORMULATION_B_SOURCE_INCONSISTENCY", () => {
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
      injectedLiquidity: 100000,
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
});
