import { describe, expect, it } from "vitest";

import {
  createProviderError,
  parseTokenMintAddress,
  providerFailure,
  providerSuccess,
  type ProviderName,
  type ProviderResult,
  type QuoteRequest,
  type QuoteResult,
} from "@nexustrade/shared";

import type { QuoteProvider } from "../interfaces/index.js";
import { QuoteAttemptJournal } from "./QuoteAttemptJournal.js";
import { QuoteBackoffPolicy } from "./QuoteBackoffPolicy.js";
import { QuoteCache } from "./QuoteCache.js";
import { QuoteNegativeCache } from "./QuoteNegativeCache.js";
import { QuoteProviderRouter } from "./QuoteProviderRouter.js";
import { QuoteScheduler } from "./QuoteScheduler.js";
import { QuoteSingleFlight } from "./QuoteSingleFlight.js";
import { RaydiumNegativeCache } from "../raydium/RaydiumNegativeCache.js";
import { RaydiumVenueGuard } from "../raydium/RaydiumVenueGuard.js";

const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const USDC_MINT = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const request: QuoteRequest = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  amountRaw: "10000000",
};
const quote: QuoteResult = {
  inputMint: SOL_MINT,
  outputMint: USDC_MINT,
  inputAmountRaw: "10000000",
  outputAmountRaw: "1000000",
  source: "JUPITER",
  fetchedAt: new Date("2026-07-11T00:00:00.000Z"),
};
const raydiumQuote: QuoteResult = {
  ...quote,
  source: "RAYDIUM",
};

describe("QuoteProviderRouter", () => {
  it("returns cached quotes without repeating live provider calls", async () => {
    let calls = 0;
    const provider = quoteProvider("JUPITER", async () => {
      calls++;

      return providerSuccess({
        provider: "JUPITER",
        data: quote,
      });
    });
    const router = createRouter(provider);

    const first = await router.getQuote(request);
    const second = await router.getQuote(request);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.warnings).toContain("Quote cache hit (0ms old).");
    expect(second.ok ? second.data.provenance : undefined).toMatchObject({
      quoteProvider: "JUPITER",
      quoteSourceType: "CACHE",
    });
    expect(router.getDiagnosticSnapshot(request)).toMatchObject({
      latestAttempt: {
        provider: "JUPITER",
        sourceType: "CACHE",
        outcome: "SUCCESS",
      },
      lastSuccessfulQuote: {
        provider: "JUPITER",
        sourceType: "LIVE",
        outputAmountRaw: "1000000",
      },
    });
    expect(calls).toBe(1);
  });

  it("opens cooldown after rate limits and skips later calls", async () => {
    let calls = 0;
    const provider = quoteProvider("JUPITER", async () => {
      calls++;

      return providerFailure({
        provider: "JUPITER",
        error: createProviderError({
          code: "RATE_LIMITED",
          message: "Too many requests.",
          statusCode: 429,
        }),
      });
    });
    const router = createRouter(provider);

    const first = await router.getQuote(request);
    const second = await router.getQuote(request);

    expect(first.ok).toBe(false);
    expect(first.rateLimited).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.rateLimited).toBe(true);
    expect(second.warnings).toContain("Quote skipped during JUPITER cooldown.");
    expect(router.getDiagnosticSnapshot(request)?.latestAttempt).toMatchObject({
      provider: "JUPITER",
      sourceType: "NONE",
      outcome: "COOLDOWN_SKIP",
      failureCode: "RATE_LIMITED",
    });
    expect(calls).toBe(1);
  });

  it("falls back to Raydium after Jupiter rate limits", async () => {
    const jupiter = quoteProvider("JUPITER", async () =>
      providerFailure({
        provider: "JUPITER",
        error: createProviderError({
          code: "RATE_LIMITED",
          message: "Too many requests.",
          statusCode: 429,
        }),
      }),
    );
    const raydium = quoteProvider("RAYDIUM", async () =>
      providerSuccess({
        provider: "RAYDIUM",
        data: raydiumQuote,
      }),
    );
    const router = createRouter(jupiter, raydium);

    const result = await router.getQuote(request);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.data.source : undefined).toBe("RAYDIUM");
    expect(result.ok ? result.data.provenance : undefined).toMatchObject({
      quoteProvider: "RAYDIUM",
      quoteSourceType: "LIVE",
      fallbackReason: "JUPITER_RATE_LIMITED",
      attemptedProviders: ["JUPITER", "RAYDIUM"],
      providerOrder: ["JUPITER", "RAYDIUM"],
    });
  });

  it("falls back to Raydium after Jupiter cooldown skips", async () => {
    let jupiterCalls = 0;
    let raydiumCalls = 0;
    const jupiter = quoteProvider("JUPITER", async () => {
      jupiterCalls++;

      return providerFailure({
        provider: "JUPITER",
        error: createProviderError({
          code: "RATE_LIMITED",
          message: "Too many requests.",
          statusCode: 429,
        }),
      });
    });
    const raydium = quoteProvider("RAYDIUM", async () => {
      raydiumCalls++;

      return providerSuccess({
        provider: "RAYDIUM",
        data: raydiumQuote,
      });
    });
    const router = createRouter(jupiter, raydium);

    await router.getQuote({
      ...request,
      amountRaw: "10000000",
    });
    const result = await router.getQuote({
      ...request,
      amountRaw: "20000000",
    });

    expect(jupiterCalls).toBe(1);
    expect(raydiumCalls).toBe(2);
    expect(result.ok ? result.data.provenance : undefined).toMatchObject({
      quoteProvider: "RAYDIUM",
      quoteSourceType: "LIVE",
      fallbackReason: "JUPITER_COOLDOWN",
    });
  });

  it("caches deterministic Raydium no-route failures without suppressing Jupiter", async () => {
    let jupiterCalls = 0;
    let raydiumCalls = 0;
    const jupiter = quoteProvider("JUPITER", async () => {
      jupiterCalls += 1;
      return providerFailure({
        provider: "JUPITER",
        error: createProviderError({ code: "RATE_LIMITED", message: "Too many requests." }),
      });
    });
    const raydium = quoteProvider("RAYDIUM", async () => {
      raydiumCalls += 1;
      return providerFailure({
        provider: "RAYDIUM",
        error: createProviderError({ code: "NOT_FOUND", message: "No route.", retryable: false }),
      });
    });
    const router = createRouter(jupiter, raydium);

    await router.getQuote(request);
    await router.getQuote(request);

    expect(jupiterCalls).toBe(1);
    expect(raydiumCalls).toBe(1);
  });

  it("skips Raydium when the known DexScreener venue is incompatible", async () => {
    let calls = 0;
    const raydium = quoteProvider("RAYDIUM", async () => {
      calls += 1;
      return providerSuccess({ provider: "RAYDIUM", data: raydiumQuote });
    });
    const router = createRouter(raydium);

    const result = await router.getQuoteWithContext(request, {
      raydiumObservedDexIds: ["orca"],
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error.code).toBe("NOT_FOUND");
    expect(calls).toBe(0);
  });
});

function createRouter(...providers: readonly QuoteProvider[]): QuoteProviderRouter {
  return new QuoteProviderRouter({
    providers,
    cache: new QuoteCache({
      enabled: true,
      ttlMs: 1_000,
      maxEntries: 10,
      clock: () => 1_000,
    }),
    negativeCache: new QuoteNegativeCache({
      enabled: true,
      ttlMs: 1_000,
      maxEntries: 10,
      clock: () => 1_000,
    }),
    raydiumNegativeCache: new RaydiumNegativeCache({
      enabled: true,
      ttlMs: 1_000,
      maxEntries: 10,
      clock: () => 1_000,
    }),
    backoff: new QuoteBackoffPolicy({
      enabled: true,
      baseCooldownMs: 1_000,
      maxCooldownMs: 1_000,
      multiplier: 2,
      jitterPct: 0,
      clock: () => 1_000,
    }),
    scheduler: new QuoteScheduler({
      enabled: false,
      minIntervalMsByProvider: {},
      clock: () => 1_000,
    }),
    singleFlight: new QuoteSingleFlight({
      enabled: true,
      ttlMs: 10_000,
      clock: () => 1_000,
    }),
    raydiumVenueGuard: new RaydiumVenueGuard({
      enabled: true,
      skipWhenVenueAbsent: true,
    }),
    attemptJournal: new QuoteAttemptJournal({
      enabled: true,
      ttlMs: 10_000,
      maxEntries: 100,
      clock: () => 1_000,
    }),
    skipLowPriorityDuringCooldown: true,
  });
}

function quoteProvider(
  name: ProviderName,
  getQuote: (request: QuoteRequest) => Promise<ProviderResult<QuoteResult>>,
): QuoteProvider {
  return {
    name,
    capabilities: ["QUOTE"],
    getQuote,
  };
}
