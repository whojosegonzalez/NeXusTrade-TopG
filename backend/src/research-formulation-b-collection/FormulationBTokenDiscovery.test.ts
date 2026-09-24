import { describe, expect, it } from "vitest";
import { MockFormulationBProviderClient } from "./FormulationBCollection.test-support.js";
import { FormulationBSafetyMonitor } from "./FormulationBSafetyMonitor.js";
import { FormulationBTokenDiscovery } from "./FormulationBTokenDiscovery.js";

describe("FormulationBTokenDiscovery", () => {
  it("discovers candidate and ignores candidates with age < 300s", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient({
      discoverCandidates: [
        {
          canonicalMint: "MintTooYoung00000000000000000000000001",
          slotId: "slot-001",
          discoveredAt: "2026-09-01T00:00:00.000Z",
          assetAgeSeconds: 120, // < 300s
        },
        {
          canonicalMint: "MintMature0000000000000000000000000002",
          slotId: "slot-001",
          discoveredAt: "2026-09-01T00:00:00.000Z",
          assetAgeSeconds: 350, // >= 300s
        },
      ],
    });

    const discovery = new FormulationBTokenDiscovery(provider, safety);
    const candidate = await discovery.discoverNextCandidate("2026-09-01", "slot-001");

    expect(candidate).not.toBeNull();
    expect(candidate?.canonicalMint).toBe("MintMature0000000000000000000000000002");
    expect(candidate?.assetAgeSeconds).toBe(350);
  });

  it("deduplicates mints and avoids repeat discoveries", async () => {
    const safety = new FormulationBSafetyMonitor();
    const provider = new MockFormulationBProviderClient({
      discoverCandidates: [
        {
          canonicalMint: "MintDup0000000000000000000000000000001",
          slotId: "slot-001",
          discoveredAt: "2026-09-01T00:00:00.000Z",
          assetAgeSeconds: 400,
        },
      ],
    });

    const discovery = new FormulationBTokenDiscovery(provider, safety);

    const cand1 = await discovery.discoverNextCandidate("2026-09-01", "slot-001");
    expect(cand1).not.toBeNull();
    expect(discovery.isMintSeen("MintDup0000000000000000000000000000001")).toBe(true);

    const cand2 = await discovery.discoverNextCandidate("2026-09-01", "slot-002");
    expect(cand2).toBeNull(); // Already seen, none left
  });
});
