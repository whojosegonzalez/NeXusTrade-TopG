import { describe, expect, it } from "vitest";

import {
  defaultExitManagerConfig,
  parseExitManagerArgs,
  validateExitManagerConfig,
} from "./ExitManagerConfig.js";

describe("ExitManagerConfig", () => {
  it("parses required one-shot observe defaults", () => {
    expect(parseExitManagerArgs(["--once"])).toMatchObject({
      once: true,
      dryRun: false,
      targetAction: "observe",
      drawdownAction: "observe",
      completeSessionOnExit: false,
      limit: 250,
      baseFeeLamports: 5_000,
      priorityFeeLamports: 0,
      slippageBps: 100,
      allowCachedRadarPrice: false,
    });
  });

  it("parses sell actions, completion, session, and PaperSell passthrough options", () => {
    expect(
      parseExitManagerArgs([
        "--once",
        "--dry-run",
        "--session-id=session_exit",
        "--target-action=sell-all",
        "--drawdown-action=sell-all",
        "--complete-session-on-exit=true",
        "--allow-cached-radar-price",
        "--limit=25",
        "--slippage-bps=250",
        "--base-fee-lamports=6000",
        "--priority-fee-lamports=1000",
        "--max-cached-price-age-ms=120000",
      ]),
    ).toMatchObject({
      once: true,
      dryRun: true,
      sessionId: "session_exit",
      targetAction: "sell-all",
      drawdownAction: "sell-all",
      completeSessionOnExit: true,
      allowCachedRadarPrice: true,
      limit: 25,
      slippageBps: 250,
      baseFeeLamports: 6000,
      priorityFeeLamports: 1000,
      maxCachedPriceAgeMs: 120000,
    });
  });

  it("rejects missing --once", () => {
    expect(() => validateExitManagerConfig(defaultExitManagerConfig())).toThrow(/--once/);
  });

  it("rejects unsupported actions and unknown flags", () => {
    expect(() => parseExitManagerArgs(["--once", "--target-action=partial"])).toThrow(
      /observe or sell-all/,
    );
    expect(() => parseExitManagerArgs(["--once", "--trailing-stop=1"])).toThrow(
      /Unknown exit manager option/,
    );
  });

  it("rejects completion unless a sell-all action is configured", () => {
    expect(() => parseExitManagerArgs(["--once", "--complete-session-on-exit=true"])).toThrow(
      /requires --target-action=sell-all or --drawdown-action=sell-all/,
    );
  });

  it("rejects invalid numeric values", () => {
    expect(() => parseExitManagerArgs(["--once", "--limit=0"])).toThrow(/limit/);
    expect(() => parseExitManagerArgs(["--once", "--slippage-bps=-1"])).toThrow(/slippageBps/);
    expect(() => parseExitManagerArgs(["--once", "--base-fee-lamports=1.5"])).toThrow(/integer/);
  });
});
