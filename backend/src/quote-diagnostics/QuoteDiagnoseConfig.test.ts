import { describe, expect, it } from "vitest";

import { parseQuoteDiagnoseArgs } from "./QuoteDiagnoseConfig.js";

describe("parseQuoteDiagnoseArgs", () => {
  it("parses defaults for the one-shot diagnostic command", () => {
    const config = parseQuoteDiagnoseArgs(["--once"]);

    expect(config).toMatchObject({
      once: true,
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amountRaw: "100000000",
      slippageBps: 100,
      mode: "all",
      json: false,
      roundTrip: false,
    });
  });

  it("rejects loop mode and session IDs", () => {
    expect(() => parseQuoteDiagnoseArgs([])).toThrow("requires --once");
    expect(() => parseQuoteDiagnoseArgs(["--once", "--session-id=abc"])).toThrow(
      "does not accept --session-id",
    );
  });

  it("validates amount, slippage, and mode before provider calls", () => {
    expect(() => parseQuoteDiagnoseArgs(["--once", "--amount-raw=0"])).toThrow("positive integer");
    expect(() => parseQuoteDiagnoseArgs(["--once", "--slippage-bps=10001"])).toThrow(
      "slippage-bps",
    );
    expect(() => parseQuoteDiagnoseArgs(["--once", "--mode=swap"])).toThrow("Invalid --mode");
  });
});
