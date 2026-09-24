import { describe, expect, it } from "vitest";
import { computeGroupStats, evaluateAllGates } from "./FormulationBAnalysisGates.js";
import { buildStandardSyntheticCohort } from "./FormulationBAnalysis.test-support.js";
import type { FormulationBUnitRecord } from "./FormulationBAnalysisTypes.js";

describe("FormulationBAnalysisGates", () => {
  it("computes group statistics and positive rates correctly", () => {
    const rawUnits = buildStandardSyntheticCohort("passing");
    const formattedUnits: FormulationBUnitRecord[] = rawUnits.map((u) => ({
      unitId: u.unitId,
      canonicalMint: u.canonicalMint,
      anchorAt: u.anchorAt,
      anchorDate: u.anchorAt.substring(0, 10),
      slotId: u.slotId,
      partition: "DISCOVERY",
      decisionTimeEvidence: {
        priceUsd: 1.0,
        momentum5mPct: u.momentum5mPct,
        momentum15mPct: u.momentum15mPct,
        momentumAccelerationPct:
          u.momentum5mPct !== null && u.momentum15mPct !== null
            ? u.momentum5mPct - u.momentum15mPct
            : null,
        assetAgeSeconds: 300,
      },
      forwardOutcomeLabels: {
        return60mPct: u.return60mPct,
        primaryLabel: (u.return60mPct ?? 0) > 0 ? "POSITIVE_60M" : "NON_POSITIVE_60M",
      },
    }));

    const stats = computeGroupStats(formattedUnits);
    expect(stats.totalUnits).toBe(96);
    expect(stats.usableUnits).toBe(96);
    expect(stats.unusableUnits).toBe(0);
    expect(stats.distinctUtcDates).toBe(8);
    expect(stats.positiveRate).toBeGreaterThan(0);
  });

  it("evaluates Discovery selection effect size and gates", () => {
    const rawUnits = buildStandardSyntheticCohort("passing");
    const formattedUnits: FormulationBUnitRecord[] = rawUnits.map((u, i) => ({
      unitId: u.unitId,
      canonicalMint: u.canonicalMint,
      anchorAt: u.anchorAt,
      anchorDate: u.anchorAt.substring(0, 10),
      slotId: u.slotId,
      partition: i % 2 === 0 ? "DISCOVERY" : "VALIDATION",
      decisionTimeEvidence: {
        priceUsd: 1.0,
        momentum5mPct: u.momentum5mPct,
        momentum15mPct: u.momentum15mPct,
        momentumAccelerationPct:
          u.momentum5mPct !== null && u.momentum15mPct !== null
            ? u.momentum5mPct - u.momentum15mPct
            : null,
        assetAgeSeconds: 300,
      },
      forwardOutcomeLabels: {
        return60mPct: u.return60mPct,
        primaryLabel: (u.return60mPct ?? 0) > 0 ? "POSITIVE_60M" : "NON_POSITIVE_60M",
      },
    }));

    const gateEval = evaluateAllGates(formattedUnits);
    expect(gateEval.qualityGates.every((g) => g.passed)).toBe(true);
    expect(gateEval.discoveryGates.every((g) => g.passed)).toBe(true);
    expect(gateEval.validationGates.every((g) => g.passed)).toBe(true);
    expect(gateEval.discoveryQ3Threshold).toBeDefined();
  });
});
