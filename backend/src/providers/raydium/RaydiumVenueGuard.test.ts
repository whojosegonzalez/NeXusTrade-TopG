import { describe, expect, it } from "vitest";

import { RaydiumVenueGuard } from "./RaydiumVenueGuard.js";

describe("RaydiumVenueGuard", () => {
  it("skips only when known venue evidence is incompatible", () => {
    const guard = new RaydiumVenueGuard({ enabled: true, skipWhenVenueAbsent: true });

    expect(guard.evaluate({ observedDexIds: ["raydium"] }).decision).toBe("ALLOW");
    expect(guard.evaluate({ observedDexIds: ["orca"] })).toMatchObject({
      decision: "SKIP_NO_RAYDIUM_VENUE",
      reason: "non-raydium-venues-observed",
    });
    expect(guard.evaluate({}).decision).toBe("UNKNOWN_ALLOW");
  });

  it("can require positive venue evidence when explicitly configured", () => {
    const guard = new RaydiumVenueGuard({
      enabled: true,
      skipWhenVenueAbsent: true,
      requireVenueEvidence: true,
    });

    expect(guard.evaluate({})).toMatchObject({
      decision: "SKIP_NO_RAYDIUM_VENUE",
      reason: "raydium-venue-evidence-required",
    });
  });
});
