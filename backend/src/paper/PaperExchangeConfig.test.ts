import { describe, expect, it } from "vitest";

import {
  defaultPaperExchangeConfig,
  parsePaperExchangeArgs,
  validatePaperExchangeConfig,
} from "./PaperExchangeConfig.js";

describe("PaperExchangeConfig", () => {
  it("uses Phase 7 defaults", () => {
    expect(defaultPaperExchangeConfig()).toMatchObject({
      buySolLamports: 10_000_000,
      limit: 10,
      baseFeeLamports: 5_000,
      priorityFeeLamports: 0,
      slippageBps: 100,
      quoteSource: "TOKEN_RADAR_PRICE",
      once: false,
      dryRun: false,
    });
  });

  it("parses supported command-line options", () => {
    expect(
      parsePaperExchangeArgs([
        "--once",
        "--dry-run",
        "--session-id=session_123",
        "--buy-sol=0.05",
        "--limit=25",
      ]),
    ).toMatchObject({
      once: true,
      dryRun: true,
      sessionId: "session_123",
      buySolLamports: 50_000_000,
      limit: 25,
    });
  });

  it("rejects invalid command-line options", () => {
    expect(() => parsePaperExchangeArgs(["--buy-sol=0"])).toThrow(/buySol/);
    expect(() => parsePaperExchangeArgs(["--buy-sol=0.0000000001"])).toThrow(/buySol/);
    expect(() => parsePaperExchangeArgs(["--limit=0"])).toThrow(/limit/);
    expect(() => parsePaperExchangeArgs(["--session-id="])).toThrow(/session-id/);
    expect(() => parsePaperExchangeArgs(["--unknown"])).toThrow(/Unknown paper exchange option/);
  });

  it("validates internal bounds", () => {
    expect(() =>
      validatePaperExchangeConfig({
        ...defaultPaperExchangeConfig(),
        slippageBps: 10_001,
      }),
    ).toThrow(/slippageBps/);
  });
});
