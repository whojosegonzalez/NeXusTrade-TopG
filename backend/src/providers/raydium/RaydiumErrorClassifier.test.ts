import { describe, expect, it } from "vitest";

import {
  classifyRaydiumFailure,
  classifyRaydiumFailureDetail,
  sanitizeRaydiumMessage,
} from "./RaydiumErrorClassifier.js";

describe("RaydiumErrorClassifier", () => {
  it("classifies route, amount, unsupported token, and rate-limit failures", () => {
    expect(classifyRaydiumFailure({ statusCode: 404 })).toBe("NO_ROUTE");
    expect(classifyRaydiumFailure({ statusCode: 429 })).toBe("RATE_LIMITED");
    expect(classifyRaydiumFailure({ message: "cannot find route for token pair" })).toBe(
      "NO_ROUTE",
    );
    expect(classifyRaydiumFailure({ message: "token-2022 transfer fee is unsupported" })).toBe(
      "UNSUPPORTED_TOKEN_PROGRAM",
    );
    expect(classifyRaydiumFailure({ message: "invalid amount input" })).toBe("BAD_AMOUNT");
  });

  it("sanitizes noisy messages before storing provider-health context", () => {
    expect(sanitizeRaydiumMessage("  no\nroute\tavailable  ", 40)).toBe("no route available");
    expect(sanitizeRaydiumMessage("x".repeat(20), 8)).toBe("xxxxx...");
  });

  it("classifies documented Raydium REQ_* messages into precise details", () => {
    expect(classifyRaydiumFailureDetail({ message: "REQ_INPUT_MINT_ERROR" })).toBe(
      "REQ_INPUT_MINT_ERROR",
    );
    expect(classifyRaydiumFailure({ message: "REQ_INPUT_MINT_ERROR" })).toBe("UNSUPPORTED_MINT");
    expect(classifyRaydiumFailureDetail({ message: "REQ_OUTPUT_MINT_ERROR" })).toBe(
      "REQ_OUTPUT_MINT_ERROR",
    );
    expect(classifyRaydiumFailure({ message: "REQ_OUTPUT_MINT_ERROR" })).toBe("UNSUPPORTED_MINT");
    expect(classifyRaydiumFailureDetail({ message: "REQ_AMOUNT_ERROR" })).toBe("REQ_AMOUNT_ERROR");
    expect(classifyRaydiumFailure({ message: "REQ_AMOUNT_ERROR" })).toBe("BAD_AMOUNT");
    expect(classifyRaydiumFailureDetail({ message: "REQ_SLIPPAGE_BPS_ERROR" })).toBe(
      "REQ_SLIPPAGE_BPS_ERROR",
    );
    expect(classifyRaydiumFailure({ message: "REQ_SLIPPAGE_BPS_ERROR" })).toBe("BAD_AMOUNT");
    expect(classifyRaydiumFailureDetail({ message: "REQ_TX_VERSION_ERROR" })).toBe(
      "REQ_TX_VERSION_ERROR",
    );
    expect(classifyRaydiumFailure({ message: "REQ_TX_VERSION_ERROR" })).toBe("BAD_REQUEST");
  });
});
