import { describe, expect, it } from "vitest";

import {
  PAPER_SELL_DEFAULTS,
  parsePaperSellArgs,
  validatePaperSellConfig,
} from "./PaperSellConfig.js";

const TEST_MINT = "DezXAZ8z7PnrnRJjz3s4c5t5j4NKNQwXn8N9n6RSLH5";

describe("PaperSellConfig", () => {
  it("requires an explicit sell trigger", () => {
    expect(() => parsePaperSellArgs(["--once"])).toThrow(/Missing explicit sell trigger/);
  });

  it("parses sell-all command-line options", () => {
    expect(
      parsePaperSellArgs([
        "--once",
        "--dry-run",
        "--sell-all",
        "--session-id=session_123",
        "--limit=25",
        "--slippage-bps=50",
        "--base-fee-lamports=6000",
        "--priority-fee-lamports=1000",
        "--allow-cached-radar-price",
        "--max-cached-price-age-ms=120000",
      ]),
    ).toMatchObject({
      once: true,
      dryRun: true,
      sessionId: "session_123",
      limit: 25,
      slippageBps: 50,
      baseFeeLamports: 6000,
      priorityFeeLamports: 1000,
      allowCachedRadarPrice: true,
      maxCachedPriceAgeMs: 120000,
      trigger: {
        type: "SELL_ALL",
      },
    });
  });

  it("parses mint trigger command-line options", () => {
    expect(parsePaperSellArgs([`--mint=${TEST_MINT}`])).toMatchObject({
      limit: PAPER_SELL_DEFAULTS.limit,
      trigger: {
        type: "MINT",
        mintAddress: TEST_MINT,
      },
    });
  });

  it("rejects invalid or conflicting options", () => {
    expect(() => parsePaperSellArgs(["--sell-all", `--mint=${TEST_MINT}`])).toThrow(
      /either --sell-all or --mint/,
    );
    expect(() => parsePaperSellArgs(["--sell-all", "--limit=0"])).toThrow(/limit/);
    expect(() => parsePaperSellArgs(["--sell-all", "--slippage-bps=-1"])).toThrow(/slippageBps/);
    expect(() => parsePaperSellArgs(["--sell-all", "--unknown"])).toThrow(
      /Unknown paper sell option/,
    );
  });

  it("validates internal bounds", () => {
    const config = parsePaperSellArgs(["--sell-all"]);

    expect(() =>
      validatePaperSellConfig({
        ...config,
        maxCachedPriceAgeMs: 999,
      }),
    ).toThrow(/maxCachedPriceAgeMs/);
  });
});
