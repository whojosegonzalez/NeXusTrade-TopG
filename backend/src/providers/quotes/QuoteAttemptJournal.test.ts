import { describe, expect, it } from "vitest";

import { parseTokenMintAddress, type QuoteRequest } from "@nexustrade/shared";

import { QuoteAttemptJournal } from "./QuoteAttemptJournal.js";

const request: QuoteRequest = {
  inputMint: parseTokenMintAddress("So11111111111111111111111111111111111111112"),
  outputMint: parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  amountRaw: "100000000",
  slippageBps: 100,
};

describe("QuoteAttemptJournal", () => {
  it("keeps latest attempt separate from last successful quote", () => {
    let nowMs = 1_000;
    const journal = new QuoteAttemptJournal({
      enabled: true,
      ttlMs: 10_000,
      maxEntries: 10,
      clock: () => nowMs,
    });

    journal.recordLatestAttempt({
      request,
      provider: "JUPITER",
      sourceType: "LIVE",
      outcome: "SUCCESS",
      fallbackReason: "NONE",
      httpAttemptCount: 1,
      lastHttpStatus: 200,
    });
    journal.recordLastSuccessfulQuote({
      request,
      provider: "JUPITER",
      sourceType: "LIVE",
      outputAmountRaw: "7500000",
      fallbackReason: "NONE",
    });

    nowMs = 2_000;
    journal.recordLatestAttempt({
      request,
      provider: "RAYDIUM",
      sourceType: "NONE",
      outcome: "FAILURE",
      fallbackReason: "JUPITER_RATE_LIMITED",
      failureCode: "NOT_FOUND",
      raydiumFailureCategory: "NO_ROUTE",
      raydiumFailureDetail: "NO_ROUTE",
      httpAttemptCount: 1,
      lastHttpStatus: 200,
    });

    const snapshot = journal.getSnapshot(request);

    expect(snapshot?.latestAttempt).toMatchObject({
      provider: "RAYDIUM",
      outcome: "FAILURE",
      raydiumFailureDetail: "NO_ROUTE",
    });
    expect(snapshot?.lastSuccessfulQuote).toMatchObject({
      provider: "JUPITER",
      outputAmountRaw: "7500000",
      ageMs: 1_000,
    });
  });

  it("evicts expired entries", () => {
    let nowMs = 1_000;
    const journal = new QuoteAttemptJournal({
      enabled: true,
      ttlMs: 500,
      maxEntries: 10,
      clock: () => nowMs,
    });

    journal.recordLatestAttempt({
      request,
      provider: "JUPITER",
      sourceType: "LIVE",
      outcome: "SUCCESS",
      fallbackReason: "NONE",
    });

    nowMs = 2_000;

    expect(journal.getSnapshot(request)).toBeUndefined();
  });
});
