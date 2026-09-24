import { describe, expect, it } from "vitest";

import { parseShadowEntryArgs } from "./ShadowEntryConfig.js";

describe("parseShadowEntryArgs", () => {
  it("parses Phase 8.92 source, profile, drawdown, recovery, and portfolio options", () => {
    const config = parseShadowEntryArgs([
      "--once",
      "--label-db=Test1:data/archive/phase8.91/test1",
      "--label-db=Test2:data/archive/phase8.91/test2/nexus_paper.db",
      "--profiles=P001,recovery_after_drawdown,watch_duplicate_hybrid",
      "--source-decisions=BUY,WATCH,SKIP",
      "--entry-timings=decision,latest_entry",
      "--confirmation-horizons=1,3",
      "--confirmation-min-return-pcts=0,2",
      "--early-drawdown-modes=warn_only,require_recovery",
      "--recovery-confirmation-return-pcts=0,5",
      "--recovery-window-minutes=3,10",
      "--target-pcts=10,15",
      "--stop-pcts=10,25",
      "--max-hold-minutes=15,60",
      "--portfolio-starting-sol=1",
      "--portfolio-position-size-sol=0.01",
      "--portfolio-goal-pct=25",
      "--portfolio-max-positions=4",
    ]);

    expect(config.once).toBe(true);
    expect(config.dbSources).toEqual([
      {
        label: "Test1",
        path: "data/archive/phase8.91/test1",
      },
      {
        label: "Test2",
        path: "data/archive/phase8.91/test2/nexus_paper.db",
      },
    ]);
    expect(config.profileIds).toEqual(["P001", "P006", "P011"]);
    expect(config.entryTimingModes).toEqual(["decision", "latest_entry"]);
    expect(config.earlyDrawdownModes).toEqual(["warn_only", "require_recovery"]);
    expect(config.recoveryConfirmationReturnPcts).toEqual([0, 5]);
    expect(config.recoveryWindowMinutes).toEqual([3, 10]);
    expect(config.portfolioMaxPositions).toBe(4);
  });

  it("rejects unknown profiles and drawdown modes", () => {
    expect(() => parseShadowEntryArgs(["--profile=P999"])).toThrow(/profile/i);
    expect(() => parseShadowEntryArgs(["--early-drawdown-mode=panic"])).toThrow(/drawdown/i);
  });

  it("rejects duplicate labels and impossible portfolio sizing", () => {
    expect(() => parseShadowEntryArgs(["--label-db=A:data/a", "--label-db=A:data/b"])).toThrow(
      /duplicate database label/i,
    );

    expect(() =>
      parseShadowEntryArgs(["--portfolio-starting-sol=1", "--portfolio-position-size-sol=2"]),
    ).toThrow(/must not exceed/i);
  });
});
