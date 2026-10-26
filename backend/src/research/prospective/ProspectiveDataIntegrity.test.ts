/**
 * Phase 12.94-D Milestone D.3.3: Data Integrity Counterexample Test Suite
 *
 * Exercises all operator-specified counterexamples and data-integrity requirements:
 * 1. Missing LP burn, holders, age, or market cap cannot pass gates or become fabricated.
 * 2. Exact pairAddress, chainId, and dexId validations.
 * 3. USDC-quoted token vs WSOL-quoted token (no arbitrary $150/SOL conversions).
 * 4. Missing liquidity field vs confirmed pool drainage.
 * 5. One and two HTTP 429s without premature circuit breaker; halts only on 3 consecutive distinct requests.
 * 6. CLI launcher argument validation and dry-run safety.
 * 7. Request timeouts and abort handling.
 * 8. Accurate request-budget accounting and cryptographic session manifest sealing.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateLauncherArgs } from "../../scripts/launch-shadow-observation.js";
import { GlobalResourceBudgetManager } from "./GlobalResourceBudgetManager.js";
import {
  LiveDexScreenerQuoteProvider,
  WSOL_MINT,
  type FetchFunction,
} from "./LiveShadowProviders.js";
import { ShadowObservationRunner, type ShadowCandidateInput } from "./ShadowObservationRunner.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("Milestone D.3.3 Data Integrity & Safeguards Suite", () => {
  it("counterexample 1: missing LP burn, holders, age, or market cap cannot pass screening", () => {
    const clock = 1_000_000;
    const runner = new ShadowObservationRunner({
      sessionId: "test-missing-inputs",
      configFingerprint: "sha256:missing-test",
      clock: () => clock,
    });

    // Candidate A: Unverified LP burn (lpBurnPct === null)
    const candA: ShadowCandidateInput = {
      poolId: "pool-test-burn-missing",
      mintAddress: "MINT_TEST_BURN_MISSING",
      symbol: "NOBURN",
      discoveryTimestampMs: clock,
      streamSource: "DEXSCREENER_LATEST_TOKEN_PROFILES",
      indicativePriceSol: 0.0001,
      liquidityUsd: 60000,
      marketCapUsd: 200000,
      lmcRatio: 0.3,
      lpBurnPct: null, // UNVERIFIED LP BURN
      assetAgeSeconds: 2400,
      volume5mUsd: 15000,
      buys5m: 40,
      sells5m: 20,
      buyToSellRatio: 2.0,
      unavailableInputs: ["lpBurnPct"],
    };

    const decIdA = runner.ingestCandidate(candA);
    expect(decIdA).toBeDefined();

    const recordA = runner
      .getRecorder()
      .getDecisionRecords()
      .find((d) => d.decisionEventId === decIdA);
    expect(recordA).toBeDefined();
    expect(recordA?.gateOutcome.decision).toBe("FILTERED_REJECTED");
    expect(recordA?.gateOutcome.rejectionCategory).toBe("REJECTED_BY_MISSING_DATA");
    expect(recordA?.gateOutcome.primaryFailedRule).toBe("UNVERIFIED_LP_BURN_DATA");
    expect(recordA?.marketFeatures.unavailableInputs).toContain("lpBurnPct");

    // Candidate B: Missing asset age (assetAgeSeconds === null)
    const candB: ShadowCandidateInput = {
      poolId: "pool-test-age-missing",
      mintAddress: "MINT_TEST_AGE_MISSING",
      symbol: "NOAGE",
      discoveryTimestampMs: clock,
      streamSource: "DEXSCREENER_LATEST_TOKEN_PROFILES",
      indicativePriceSol: 0.0001,
      liquidityUsd: 60000,
      marketCapUsd: 200000,
      lmcRatio: 0.3,
      lpBurnPct: 100,
      assetAgeSeconds: null, // MISSING AGE
      volume5mUsd: 15000,
      buys5m: 40,
      sells5m: 20,
      buyToSellRatio: 2.0,
      unavailableInputs: ["assetAgeSeconds"],
    };

    const decIdB = runner.ingestCandidate(candB);
    const recordB = runner
      .getRecorder()
      .getDecisionRecords()
      .find((d) => d.decisionEventId === decIdB);
    expect(recordB?.strategyCohort).toBe("UNCLASSIFIED"); // Missing age cannot be classified as runner
    expect(recordB?.gateOutcome.decision).toBe("FILTERED_REJECTED");
    expect(recordB?.gateOutcome.rejectionCategory).toBe("REJECTED_BY_MISSING_DATA");
    expect(recordB?.gateOutcome.primaryFailedRule).toBe("MISSING_ASSET_AGE_DATA");

    // Candidate C: Missing Market Cap & L/MC ratio
    const candC: ShadowCandidateInput = {
      poolId: "pool-test-mcap-missing",
      mintAddress: "MINT_TEST_MCAP_MISSING",
      symbol: "NOMCAP",
      discoveryTimestampMs: clock,
      streamSource: "DEXSCREENER_LATEST_TOKEN_PROFILES",
      indicativePriceSol: 0.0001,
      liquidityUsd: 60000,
      marketCapUsd: null, // NO FABRICATED MCAP
      lmcRatio: null,
      lpBurnPct: 100,
      assetAgeSeconds: 2400,
      volume5mUsd: 15000,
      buys5m: 40,
      sells5m: 20,
      buyToSellRatio: 2.0,
      unavailableInputs: ["marketCapUsd", "lmcRatio"],
    };

    const decIdC = runner.ingestCandidate(candC);
    const recordC = runner
      .getRecorder()
      .getDecisionRecords()
      .find((d) => d.decisionEventId === decIdC);
    expect(recordC?.gateOutcome.decision).toBe("FILTERED_REJECTED");
    expect(recordC?.gateOutcome.rejectionCategory).toBe("REJECTED_BY_MISSING_DATA");
    expect(recordC?.gateOutcome.primaryFailedRule).toBe("MISSING_MARKET_CAP_DATA");
  });

  it("counterexample 2: validates exact pairAddress, chainId, and dexId without fallback", async () => {
    let clock = 1_000_000;
    const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

    // Mock fetch returning mismatching pair
    const fetchFn: FetchFunction = async (url: string) => {
      if (url.includes("pool-EXPECTED-11111111111111111111")) {
        // Returns different pairAddress
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "pool-DIFFERENT-99999999999999999999",
                baseToken: { address: "MINT_A" },
                quoteToken: { address: WSOL_MINT },
                priceNative: "0.00005",
                liquidity: { usd: 50000 },
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("pool-ORCA-MATCH-11111111111111111111")) {
        // Exact pair address matches, but dexId is Orca (not Raydium)
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "orca",
                pairAddress: "pool-ORCA-MATCH-11111111111111111111",
                baseToken: { address: "MINT_B" },
                quoteToken: { address: WSOL_MINT },
                priceNative: "0.00005",
                liquidity: { usd: 50000 },
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("pool-ORCA-PAIR") || url.includes("MINT_B")) {
        // Returns Orca dexId
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "orca",
                pairAddress: "pool-ORCA-PAIR",
                baseToken: { address: "MINT_B" },
                quoteToken: { address: WSOL_MINT },
                priceNative: "0.00005",
                liquidity: { usd: 50000 },
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("pool-ETH-CHAIN") || url.includes("MINT_C")) {
        // Returns non-Solana chain
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "ethereum",
                dexId: "uniswap",
                pairAddress: "pool-ETH-CHAIN",
                baseToken: { address: "MINT_C" },
                quoteToken: { address: "WETH" },
                priceNative: "0.00005",
                liquidity: { usd: 50000 },
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ pairs: [] }), { status: 200 });
    };

    const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager, fetchFn, () => clock);

    // 1. Mismatching pairAddress
    const resA = await quoteProvider.fetchQuote("pool-EXPECTED-11111111111111111111", "MINT_A");
    expect(resA.indicativePriceSol).toBeNull();
    expect(resA.missingReason).toBe("PAIR_ADDRESS_MISMATCH_OR_NOT_FOUND");

    // 2. Exact pairAddress match on non-Raydium DEX (Orca)
    clock += 3000;
    const resOrca = await quoteProvider.fetchQuote(
      "pool-ORCA-MATCH-11111111111111111111",
      "MINT_B",
    );
    expect(resOrca.indicativePriceSol).toBeNull();
    expect(resOrca.missingReason).toBe("NON_RAYDIUM_DEX_REJECTED");

    // 3. Non-Raydium dexId without poolId
    clock += 3000;
    const resB = await quoteProvider.fetchQuote("", "MINT_B");
    expect(resB.indicativePriceSol).toBeNull();
    expect(resB.missingReason).toBe("NO_RAYDIUM_POOL_FOUND");

    // 4. Non-Solana chain
    clock += 3000;
    const resC = await quoteProvider.fetchQuote("pool-ETH-CHAIN", "MINT_C");
    expect(resC.indicativePriceSol).toBeNull();
    expect(resC.missingReason).toBe("NON_SOLANA_CHAIN");
  });

  it("counterexample 3: USDC-quoted token vs WSOL-quoted token (no arbitrary $150/SOL conversion)", async () => {
    let clock = 1_000_000;
    const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

    const fetchFn: FetchFunction = async (url: string) => {
      if (url.includes("MINT_USDC") || url.includes("pool-USDC-PAIR")) {
        // Pair quoted against USDC
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "pool-USDC-PAIR-11111111111111111111",
                baseToken: { address: "MINT_USDC", symbol: "USDC_RUNNER" },
                quoteToken: { address: USDC_MINT, symbol: "USDC" },
                priceNative: "1.50", // 1.50 USDC, NOT SOL!
                priceUsd: "1.50",
                liquidity: { usd: 60000 },
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("MINT_FAKESOL") || url.includes("pool-FAKESOL-PAIR")) {
        // Fake WSOL token: symbol is "WSOL" but mint address is NOT canonical WSOL
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "pool-FAKESOL-PAIR-11111111111111111",
                baseToken: { address: "MINT_FAKESOL", symbol: "FAKE_RUNNER" },
                quoteToken: {
                  address: "FakeWSolAddress11111111111111111111111111",
                  symbol: "WSOL",
                },
                priceNative: "0.005",
                priceUsd: "0.75",
                liquidity: { usd: 60000 },
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("MINT_WSOL") || url.includes("pool-WSOL-PAIR")) {
        // Pair quoted against canonical WSOL mint
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "pool-WSOL-PAIR-11111111111111111111",
                baseToken: { address: "MINT_WSOL", symbol: "SOL_RUNNER" },
                quoteToken: { address: WSOL_MINT, symbol: "WSOL" },
                priceNative: "0.005", // 0.005 SOL
                priceUsd: "0.75",
                liquidity: { usd: 60000 },
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ pairs: [] }), { status: 404 });
    };

    const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager, fetchFn, () => clock);

    // 1. USDC pair query
    const resUsdc = await quoteProvider.fetchQuote(
      "pool-USDC-PAIR-11111111111111111111",
      "MINT_USDC",
    );
    expect(resUsdc.indicativePriceSol).toBeNull();
    expect(resUsdc.missingReason).toBe("NON_SOL_QUOTE_DENOMINATION");

    // 2. Fake WSOL pair query (symbol is WSOL, but mint is non-canonical)
    clock += 3000;
    const resFakeSol = await quoteProvider.fetchQuote(
      "pool-FAKESOL-PAIR-11111111111111111",
      "MINT_FAKESOL",
    );
    expect(resFakeSol.indicativePriceSol).toBeNull();
    expect(resFakeSol.missingReason).toBe("NON_SOL_QUOTE_DENOMINATION");

    // 3. Canonical WSOL pair query
    clock += 3000;
    const resWsol = await quoteProvider.fetchQuote(
      "pool-WSOL-PAIR-11111111111111111111",
      "MINT_WSOL",
    );
    expect(resWsol.indicativePriceSol).toBe(0.005);
    expect(resWsol.missingReason).toBeUndefined();
  });

  it("counterexample 4: missing liquidity field vs confirmed pool drainage", async () => {
    let clock = 1_000_000;
    const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

    const fetchFn: FetchFunction = async (url: string) => {
      if (url.includes("pool-MISSING-LIQ")) {
        // Missing liquidity field entirely
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "pool-MISSING-LIQ-11111111111111111111",
                baseToken: { address: "MINT_MLIQ" },
                quoteToken: { address: WSOL_MINT },
                priceNative: "0.0005",
                // liquidity property completely absent
              },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes("pool-CONFIRMED-DRAIN")) {
        // Explicitly reported liquidity of $120 (< $500 threshold)
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "pool-CONFIRMED-DRAIN-11111111111111111",
                baseToken: { address: "MINT_DRAIN" },
                quoteToken: { address: WSOL_MINT },
                priceNative: "0.000001",
                liquidity: { usd: 120 },
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ pairs: [] }), { status: 404 });
    };

    const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager, fetchFn, () => clock);

    // 1. Missing liquidity field: must NOT be pool drainage
    const resMissing = await quoteProvider.fetchQuote(
      "pool-MISSING-LIQ-11111111111111111111",
      "MINT_MLIQ",
    );
    expect(resMissing.liquidityUsd).toBeNull();
    expect(resMissing.isPoolDrained).toBe(false);
    expect(resMissing.missingReason).toBe("MISSING_LIQUIDITY_DATA");

    // 2. Confirmed low liquidity: must be pool drainage
    clock += 3000;
    const resDrain = await quoteProvider.fetchQuote(
      "pool-CONFIRMED-DRAIN-11111111111111111",
      "MINT_DRAIN",
    );
    expect(resDrain.liquidityUsd).toBe(120);
    expect(resDrain.isPoolDrained).toBe(true);
  });

  it("counterexample 5: one and two HTTP 429s without premature circuit breaker; halts on 3 consecutive distinct requests", () => {
    let clock = 1_000_000;
    const budget = new GlobalResourceBudgetManager({ clock: () => clock });

    // Request 1: 429
    budget.recordRequestAttempt("DEXSCREENER", "DISCOVERY_POLL", clock);
    budget.recordResponseStatus(429);
    expect(budget.getStats().consecutive429sEncountered).toBe(1);
    expect(budget.is429HaltRequired()).toBe(false);

    // Request 2: 200 (resets counter)
    clock += 3000;
    budget.recordRequestAttempt("DEXSCREENER", "DISCOVERY_POLL", clock);
    budget.recordResponseStatus(200);
    expect(budget.getStats().consecutive429sEncountered).toBe(0);
    expect(budget.is429HaltRequired()).toBe(false);

    // Request 3: 429
    clock += 3000;
    budget.recordRequestAttempt("DEXSCREENER", "FORWARD_OBSERVATION", clock);
    budget.recordResponseStatus(429);
    expect(budget.getStats().consecutive429sEncountered).toBe(1);
    expect(budget.is429HaltRequired()).toBe(false);

    // Request 4: 429
    clock += 3000;
    budget.recordRequestAttempt("DEXSCREENER", "FORWARD_OBSERVATION", clock);
    budget.recordResponseStatus(429);
    expect(budget.getStats().consecutive429sEncountered).toBe(2);
    expect(budget.is429HaltRequired()).toBe(false);

    // Request 5: 429 (3rd consecutive 429 across distinct requests)
    clock += 3000;
    budget.recordRequestAttempt("DEXSCREENER", "FORWARD_OBSERVATION", clock);
    budget.recordResponseStatus(429);
    expect(budget.getStats().consecutive429sEncountered).toBe(3);
    expect(budget.is429HaltRequired()).toBe(true); // Circuit breaker trips on 3

    // Next request is rejected by budget manager
    const check = budget.canMakeRequest("DEXSCREENER", clock + 3000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("CONSECUTIVE_HTTP_429_LIMIT_REACHED");
  });

  it("counterexample 6: launcher argument validation rejects invalid parameters", () => {
    // Negative duration
    expect(() => validateLauncherArgs({ intakeMinutes: -5 })).toThrow(
      /intakeMinutes must be between 1 and 120/,
    );

    // Exceeding candidate ceiling
    expect(() => validateLauncherArgs({ maxCandidates: 50 })).toThrow(
      /maxCandidates must be between 1 and 25/,
    );

    // Exceeding request cap
    expect(() => validateLauncherArgs({ maxRequests: 200 })).toThrow(
      /maxRequests must be between 1 and 120/,
    );

    // Pacing below 2500ms
    expect(() => validateLauncherArgs({ pacingMs: 1500 })).toThrow(/pacingMs must be >= 2500 ms/);

    // Session duration exceeding 180m total
    expect(() => validateLauncherArgs({ intakeMinutes: 120, drainMinutes: 90 })).toThrow(
      /Total session duration .* cannot exceed 180 minutes/,
    );

    // Valid parameters
    expect(() =>
      validateLauncherArgs({
        intakeMinutes: 60,
        drainMinutes: 60,
        maxCandidates: 25,
        maxRequests: 120,
        pacingMs: 2500,
        pollIntervalMs: 180_000,
      }),
    ).not.toThrow();
  });

  it("counterexample 7: delayed or hanging requests abort cleanly without indefinitely extending session", async () => {
    let clock = 1_000_000;
    const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

    let fetchCallCount = 0;
    // Hanging fetch mock that never resolves on its own
    const hangingFetch: FetchFunction = (_url, init) => {
      fetchCallCount++;
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => {
            clock += 50;
            const abortErr = new Error("This operation was aborted");
            abortErr.name = "AbortError";
            reject(abortErr);
          });
        }
      });
    };

    // Provider configured with 50ms timeout
    const quoteProvider = new LiveDexScreenerQuoteProvider(
      budgetManager,
      hangingFetch,
      () => clock,
      50,
    );

    const result = await quoteProvider.fetchQuote("pool-HANGING", "MINT_HANG");
    expect(result.indicativePriceSol).toBeNull();
    expect(result.missingReason).toContain("HTTP_TIMEOUT_AFTER_50MS");
    expect(result.httpStatus).toBeNull();

    const evidence = result.httpEvidence;
    expect(evidence).toBeDefined();
    expect(evidence?.targetUrl).toBe("https://api.dexscreener.com/latest/dex/tokens/MINT_HANG");
    expect(evidence?.requestStartMs).toBe(1_000_000);
    expect(evidence?.headersReceivedMs).toBeNull();
    expect(evidence?.responseCompleteMs).toBeNull();
    expect(evidence?.failureTimestampMs).toBe(1_000_050);
    expect(evidence?.requestDurationMs).toBe(50);
    expect(evidence?.failureReason).toContain("HTTP_TIMEOUT_AFTER_50MS");

    // Bounded completion: exactly 1 request attempted with no retries or additional requests
    expect(fetchCallCount).toBe(1);
    expect(budgetManager.getStats().totalRequests).toBe(0);
  });

  it("counterexample 8: accurate request-budget accounting and cryptographic session manifest", () => {
    let clock = 1_000_000;
    const tmpDir = path.join(os.tmpdir(), `shadow-accounting-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const budget = new GlobalResourceBudgetManager({
      maxTotalRequests: 120,
      minProviderSpacingMs: 2500,
      clock: () => clock,
    });

    const runner = new ShadowObservationRunner(
      {
        sessionId: "session-budget-accounting",
        configFingerprint: "sha256:accounting-test",
        outputDir: tmpDir,
        clock: () => clock,
      },
      { budgetManager: budget },
    );

    // Record multi-purpose requests in budget manager
    budget.recordRequestAttempt("DEXSCREENER", "DISCOVERY_POLL", clock);
    clock += 3000;
    budget.recordRequestAttempt("DEXSCREENER", "CANDIDATE_ENRICHMENT", clock);
    clock += 3000;
    budget.recordRequestAttempt("DEXSCREENER", "FORWARD_OBSERVATION", clock);

    const stats = budget.getStats();
    expect(stats.discoveryRequests).toBe(1);
    expect(stats.enrichmentRequests).toBe(1);
    expect(stats.forwardObservationRequests).toBe(1);
    expect(stats.totalRequests).toBe(3);

    // Ingest candidate with truthful unobserved inputs
    const cand: ShadowCandidateInput = {
      poolId: "pool-honest-data-11111111111111111111",
      mintAddress: "MINT_HONEST_DATA",
      symbol: "HONEST",
      discoveryTimestampMs: clock,
      streamSource: "DEXSCREENER_LATEST_TOKEN_PROFILES",
      indicativePriceSol: 0.005,
      liquidityUsd: 55000,
      marketCapUsd: 180000,
      lmcRatio: 0.3055,
      lpBurnPct: null, // Truthfully absent
      assetAgeSeconds: 2400,
      volume5mUsd: 20000,
      buys5m: 50,
      sells5m: 20,
      buyToSellRatio: 2.5,
      unavailableInputs: ["lpBurnPct"],
    };

    runner.ingestCandidate(cand, clock);

    // Close session and verify manifest
    clock += 3600_000;
    const { summary, manifest } = runner.closeSession(clock);

    expect(summary.totalCandidatesScreened).toBe(1);
    expect(summary.globalRequestStats?.totalRequests).toBe(3);
    expect(manifest).toBeDefined();
    expect(manifest?.files.length).toBe(3);

    for (const f of manifest!.files) {
      const p = path.join(tmpDir, f.filename);
      expect(fs.existsSync(p)).toBe(true);
      const hash = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      expect(hash).toBe(f.sha256);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
