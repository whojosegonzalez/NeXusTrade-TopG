import { describe, expect, it } from "vitest";
import { MockFormulationBProviderClient } from "./FormulationBCollection.test-support.js";
import { FormulationBCollectionError } from "./FormulationBCollectionErrors.js";
import { FormulationBMomentumCapture } from "./FormulationBMomentumCapture.js";
import { FormulationBSafetyMonitor } from "./FormulationBSafetyMonitor.js";

describe("FormulationBMomentumCapture", () => {
  it("captures momentum and calculates acceleration correctly", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient({
      momentumOverride: {
        priceUsd: 2.5,
        momentum5mPct: 12.0,
        momentum15mPct: 4.0,
      },
    });

    const capture = new FormulationBMomentumCapture(provider, safety);
    const facts = await capture.captureMomentumEvidence(
      "MintTest000000000000000000000000000000001",
      "2026-09-01T12:00:00.000Z",
      "2026-09-01",
      450,
    );

    expect(facts.priceUsd).toBe(2.5);
    expect(facts.momentum5mPct).toBe(12.0);
    expect(facts.momentum15mPct).toBe(4.0);
    expect(facts.momentumAccelerationPct).toBe(8.0); // 12.0 - 4.0
    expect(facts.assetAgeSeconds).toBe(450);
    expect(facts.missingnessCode).toBeUndefined();
  });

  it("handles missing momentum history and marks missingnessCode", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient({
      missingMomentum: true,
    });

    const capture = new FormulationBMomentumCapture(provider, safety);
    const facts = await capture.captureMomentumEvidence(
      "MintTest000000000000000000000000000000002",
      "2026-09-01T12:00:00.000Z",
      "2026-09-01",
      450,
    );

    expect(facts.momentum5mPct).toBeNull();
    expect(facts.momentum15mPct).toBeNull();
    expect(facts.momentumAccelerationPct).toBeNull();
    expect(facts.missingnessCode).toBe("MISSING_MOMENTUM_HISTORY");
  });

  it("throws fail-closed when provider injects liquidity fields", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient({
      injectedLiquidityKey: "liquidityUsd",
    });

    const capture = new FormulationBMomentumCapture(provider, safety);
    await expect(
      capture.captureMomentumEvidence(
        "MintTest000000000000000000000000000000003",
        "2026-09-01T12:00:00.000Z",
        "2026-09-01",
        450,
      ),
    ).rejects.toThrowError(FormulationBCollectionError);
  });
});
