import { describe, expect, it } from "vitest";

import { defaultStrategyConfig, parseStrategyArgs } from "./StrategyConfig.js";

describe("StrategyConfig", () => {
  it("uses Phase 6 defaults", () => {
    expect(defaultStrategyConfig()).toEqual({
      status: "WATCHING",
      riskPolicy: "PASS_OR_ELIGIBLE_WARN",
      sinceHours: 24,
      limit: 50,
      maxBuyDecisions: 5,
      minLiquidityUsd: 10_000,
      minVolume1hUsd: 10_000,
      maxPriceImpactPct: 5,
      minPairAgeMinutes: 30,
      buyScoreThreshold: 90,
      watchScoreThreshold: 70,
      strategyName: "phase6_first_pass",
      once: false,
      dryRun: false,
    });
  });

  it("parses strategy CLI arguments", () => {
    expect(
      parseStrategyArgs([
        "--once",
        "--dry-run",
        "--session-id=session_123",
        "--status=WATCHING",
        "--since-hours=12",
        "--limit=25",
        "--max-buy-decisions=3",
        "--strategy-name=custom_strategy",
        "--min-liquidity-usd=25000",
        "--min-volume-1h-usd=50000",
        "--max-price-impact-pct=2.5",
        "--min-pair-age-minutes=60",
        "--buy-score-threshold=75",
        "--watch-score-threshold=65",
      ]),
    ).toEqual({
      status: "WATCHING",
      riskPolicy: "PASS_OR_ELIGIBLE_WARN",
      sinceHours: 12,
      limit: 25,
      maxBuyDecisions: 3,
      minLiquidityUsd: 25_000,
      minVolume1hUsd: 50_000,
      maxPriceImpactPct: 2.5,
      minPairAgeMinutes: 60,
      buyScoreThreshold: 75,
      watchScoreThreshold: 65,
      strategyName: "custom_strategy",
      once: true,
      dryRun: true,
      sessionId: "session_123",
    });
  });

  it("rejects invalid runtime values", () => {
    expect(() => parseStrategyArgs(["--status=REJECTED"])).toThrow(/status/);
    expect(() => parseStrategyArgs(["--status=NOT_A_STATUS"])).toThrow(/valid TokenRadar/);
    expect(() => parseStrategyArgs(["--since-hours=0"])).toThrow(/sinceHours/);
    expect(() => parseStrategyArgs(["--limit=251"])).toThrow(/limit/);
    expect(() => parseStrategyArgs(["--max-buy-decisions=0"])).toThrow(/maxBuyDecisions/);
    expect(() => parseStrategyArgs(["--strategy-name="])).toThrow(/strategyName/);
    expect(() => parseStrategyArgs(["--min-liquidity-usd=-1"])).toThrow(/minLiquidityUsd/);
    expect(() => parseStrategyArgs(["--min-volume-1h-usd=-1"])).toThrow(/minVolume1hUsd/);
    expect(() => parseStrategyArgs(["--max-price-impact-pct=101"])).toThrow(/maxPriceImpactPct/);
    expect(() => parseStrategyArgs(["--min-pair-age-minutes=-1"])).toThrow(/minPairAgeMinutes/);
    expect(() => parseStrategyArgs(["--buy-score-threshold=-1"])).toThrow(/buyScoreThreshold/);
    expect(() => parseStrategyArgs(["--buy-score-threshold=101"])).toThrow(/buyScoreThreshold/);
    expect(() => parseStrategyArgs(["--watch-score-threshold=-1"])).toThrow(/watchScoreThreshold/);
    expect(() => parseStrategyArgs(["--buy-score-threshold=70.5"])).toThrow(/buy-score-threshold/);
    expect(() =>
      parseStrategyArgs(["--buy-score-threshold=60", "--watch-score-threshold=70"]),
    ).toThrow(/buyScoreThreshold/);
    expect(() => parseStrategyArgs(["--unknown"])).toThrow(/Unknown strategy option/);
  });
});
