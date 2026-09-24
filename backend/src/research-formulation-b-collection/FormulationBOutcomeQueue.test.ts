import { describe, expect, it } from "vitest";
import { MockFormulationBProviderClient } from "./FormulationBCollection.test-support.js";
import { FormulationBOutcomeQueue } from "./FormulationBOutcomeQueue.js";
import { FormulationBSafetyMonitor } from "./FormulationBSafetyMonitor.js";

describe("FormulationBOutcomeQueue", () => {
  it("evaluates forward outcomes with positive return", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient({
      spotPriceUsd: 1.2, // +20% from anchor of 1.0
    });

    const queue = new FormulationBOutcomeQueue(provider, safety);
    const outcomes = await queue.evaluateForwardOutcomes(
      "MintOutcome0000000000000000000000000000001",
      1.0,
      "2026-09-01T12:00:00.000Z",
      "2026-09-01",
    );

    expect(outcomes.return60mPct).toBeCloseTo(20.0);
    expect(outcomes.primaryLabel).toBe("POSITIVE_60M");
    expect(outcomes.return3mPct).toBeCloseTo(20.0);
  });

  it("evaluates non-positive returns correctly", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient({
      spotPriceUsd: 0.9, // -10% from anchor of 1.0
    });

    const queue = new FormulationBOutcomeQueue(provider, safety);
    const outcomes = await queue.evaluateForwardOutcomes(
      "MintOutcome0000000000000000000000000000002",
      1.0,
      "2026-09-01T12:00:00.000Z",
      "2026-09-01",
    );

    expect(outcomes.return60mPct).toBeCloseTo(-10.0);
    expect(outcomes.primaryLabel).toBe("NON_POSITIVE_60M");
  });

  it("marks unusable when 60m price is null", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient({
      spotPriceUsd: null,
    });

    const queue = new FormulationBOutcomeQueue(provider, safety);
    const outcomes = await queue.evaluateForwardOutcomes(
      "MintOutcome0000000000000000000000000000003",
      1.0,
      "2026-09-01T12:00:00.000Z",
      "2026-09-01",
    );

    expect(outcomes.return60mPct).toBeNull();
    expect(outcomes.primaryLabel).toBe("UNUSABLE_60M");
  });

  it("marks unusable when anchor price is null or zero", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient();

    const queue = new FormulationBOutcomeQueue(provider, safety);
    const outcomes = await queue.evaluateForwardOutcomes(
      "MintOutcome0000000000000000000000000000004",
      null,
      "2026-09-01T12:00:00.000Z",
      "2026-09-01",
    );

    expect(outcomes.return60mPct).toBeNull();
    expect(outcomes.primaryLabel).toBe("UNUSABLE_60M");
  });
});
