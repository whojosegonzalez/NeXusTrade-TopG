/**
 * Phase 12.94-D Milestone D.3.3: Data Integrity Counterexample Test Suite (Node.js)
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");

const { GlobalResourceBudgetManager } = await import(
  `file://${path.join(distDir, "research", "prospective", "GlobalResourceBudgetManager.js").replace(/\\/g, "/")}`
);

const { LiveDexScreenerQuoteProvider, WSOL_MINT } = await import(
  `file://${path.join(distDir, "research", "prospective", "LiveShadowProviders.js").replace(/\\/g, "/")}`
);

const { ShadowObservationRunner } = await import(
  `file://${path.join(distDir, "research", "prospective", "ShadowObservationRunner.js").replace(/\\/g, "/")}`
);

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("Counterexample 1: Missing LP burn, age, or market cap cannot pass screening", () => {
  let clock = 1_000_000;
  const runner = new ShadowObservationRunner({
    sessionId: "test-missing-inputs-node",
    configFingerprint: "sha256:missing-test-node",
    clock: () => clock,
  });

  const candA = {
    poolId: "pool-test-burn-missing",
    mintAddress: "MINT_TEST_BURN_MISSING",
    symbol: "NOBURN",
    discoveryTimestampMs: clock,
    streamSource: "DEXSCREENER_LATEST_TOKEN_PROFILES",
    indicativePriceSol: 0.0001,
    liquidityUsd: 60000,
    marketCapUsd: 200000,
    lmcRatio: 0.3,
    lpBurnPct: null,
    assetAgeSeconds: 2400,
    volume5mUsd: 15000,
    buys5m: 40,
    sells5m: 20,
    buyToSellRatio: 2.0,
    unavailableInputs: ["lpBurnPct"],
  };

  const decIdA = runner.ingestCandidate(candA);
  assert.ok(decIdA);

  const recordA = runner
    .getRecorder()
    .getDecisionRecords()
    .find((d) => d.decisionEventId === decIdA);
  assert.ok(recordA);
  assert.equal(recordA.gateOutcome.decision, "FILTERED_REJECTED");
  assert.equal(recordA.gateOutcome.rejectionCategory, "REJECTED_BY_MISSING_DATA");
  assert.equal(recordA.gateOutcome.primaryFailedRule, "UNVERIFIED_LP_BURN_DATA");

  const candB = {
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
    assetAgeSeconds: null,
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
  assert.equal(recordB.strategyCohort, "UNCLASSIFIED");
  assert.equal(recordB.gateOutcome.decision, "FILTERED_REJECTED");
  assert.equal(recordB.gateOutcome.rejectionCategory, "REJECTED_BY_MISSING_DATA");
  assert.equal(recordB.gateOutcome.primaryFailedRule, "MISSING_ASSET_AGE_DATA");

  const candC = {
    poolId: "pool-test-mcap-missing",
    mintAddress: "MINT_TEST_MCAP_MISSING",
    symbol: "NOMCAP",
    discoveryTimestampMs: clock,
    streamSource: "DEXSCREENER_LATEST_TOKEN_PROFILES",
    indicativePriceSol: 0.0001,
    liquidityUsd: 60000,
    marketCapUsd: null,
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
  assert.equal(recordC.gateOutcome.decision, "FILTERED_REJECTED");
  assert.equal(recordC.gateOutcome.rejectionCategory, "REJECTED_BY_MISSING_DATA");
  assert.equal(recordC.gateOutcome.primaryFailedRule, "MISSING_MARKET_CAP_DATA");
});

test("Counterexample 2: Validates exact pairAddress, chainId, and dexId without fallback", async () => {
  let clock = 1_000_000;
  const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

  const fetchFn = async (url) => {
    if (url.includes("pool-EXPECTED-11111111111111111111")) {
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

  const resA = await quoteProvider.fetchQuote("pool-EXPECTED-11111111111111111111", "MINT_A");
  assert.equal(resA.indicativePriceSol, null);
  assert.equal(resA.missingReason, "PAIR_ADDRESS_MISMATCH_OR_NOT_FOUND");

  clock += 3000;
  const resOrca = await quoteProvider.fetchQuote("pool-ORCA-MATCH-11111111111111111111", "MINT_B");
  assert.equal(resOrca.indicativePriceSol, null);
  assert.equal(resOrca.missingReason, "NON_RAYDIUM_DEX_REJECTED");

  clock += 3000;
  const resB = await quoteProvider.fetchQuote("", "MINT_B");
  assert.equal(resB.indicativePriceSol, null);
  assert.equal(resB.missingReason, "NO_RAYDIUM_POOL_FOUND");

  clock += 3000;
  const resC = await quoteProvider.fetchQuote("pool-ETH-CHAIN", "MINT_C");
  assert.equal(resC.indicativePriceSol, null);
  assert.equal(resC.missingReason, "NON_SOLANA_CHAIN");
});

test("Counterexample 3: USDC-quoted token vs WSOL-quoted token", async () => {
  let clock = 1_000_000;
  const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

  const fetchFn = async (url) => {
    if (url.includes("MINT_USDC") || url.includes("pool-USDC-PAIR")) {
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-USDC-PAIR-11111111111111111111",
              baseToken: { address: "MINT_USDC", symbol: "USDC_RUNNER" },
              quoteToken: { address: USDC_MINT, symbol: "USDC" },
              priceNative: "1.50",
              priceUsd: "1.50",
              liquidity: { usd: 60000 },
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes("MINT_FAKESOL") || url.includes("pool-FAKESOL-PAIR")) {
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-FAKESOL-PAIR-11111111111111111",
              baseToken: { address: "MINT_FAKESOL", symbol: "FAKE_RUNNER" },
              quoteToken: { address: "FakeWSolAddress11111111111111111111111111", symbol: "WSOL" },
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
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-WSOL-PAIR-11111111111111111111",
              baseToken: { address: "MINT_WSOL", symbol: "SOL_RUNNER" },
              quoteToken: { address: WSOL_MINT, symbol: "WSOL" },
              priceNative: "0.005",
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

  const resUsdc = await quoteProvider.fetchQuote(
    "pool-USDC-PAIR-11111111111111111111",
    "MINT_USDC",
  );
  assert.equal(resUsdc.indicativePriceSol, null);
  assert.equal(resUsdc.missingReason, "NON_SOL_QUOTE_DENOMINATION");

  clock += 3000;
  const resFakeSol = await quoteProvider.fetchQuote(
    "pool-FAKESOL-PAIR-11111111111111111",
    "MINT_FAKESOL",
  );
  assert.equal(resFakeSol.indicativePriceSol, null);
  assert.equal(resFakeSol.missingReason, "NON_SOL_QUOTE_DENOMINATION");

  clock += 3000;
  const resWsol = await quoteProvider.fetchQuote(
    "pool-WSOL-PAIR-11111111111111111111",
    "MINT_WSOL",
  );
  assert.equal(resWsol.indicativePriceSol, 0.005);
  assert.equal(resWsol.missingReason, undefined);
});

test("Counterexample 4: Missing liquidity field vs confirmed pool drainage", async () => {
  let clock = 1_000_000;
  const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

  const fetchFn = async (url) => {
    if (url.includes("pool-MISSING-LIQ")) {
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
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes("pool-CONFIRMED-DRAIN")) {
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

  const resMissing = await quoteProvider.fetchQuote(
    "pool-MISSING-LIQ-11111111111111111111",
    "MINT_MLIQ",
  );
  assert.equal(resMissing.liquidityUsd, null);
  assert.equal(resMissing.isPoolDrained, false);
  assert.equal(resMissing.missingReason, "MISSING_LIQUIDITY_DATA");

  clock += 3000;
  const resDrain = await quoteProvider.fetchQuote(
    "pool-CONFIRMED-DRAIN-11111111111111111",
    "MINT_DRAIN",
  );
  assert.equal(resDrain.liquidityUsd, 120);
  assert.equal(resDrain.isPoolDrained, true);
});

test("Counterexample 5: 429 tracking resets on 200 and halts on 3 consecutive distinct requests", () => {
  let clock = 1_000_000;
  const budget = new GlobalResourceBudgetManager({ clock: () => clock });

  budget.recordRequestAttempt("DEXSCREENER", "DISCOVERY_POLL", clock);
  budget.recordResponseStatus(429);
  assert.equal(budget.getStats().consecutive429sEncountered, 1);
  assert.equal(budget.is429HaltRequired(), false);

  clock += 3000;
  budget.recordRequestAttempt("DEXSCREENER", "DISCOVERY_POLL", clock);
  budget.recordResponseStatus(200);
  assert.equal(budget.getStats().consecutive429sEncountered, 0);
  assert.equal(budget.is429HaltRequired(), false);

  clock += 3000;
  budget.recordRequestAttempt("DEXSCREENER", "FORWARD_OBSERVATION", clock);
  budget.recordResponseStatus(429);
  clock += 3000;
  budget.recordRequestAttempt("DEXSCREENER", "FORWARD_OBSERVATION", clock);
  budget.recordResponseStatus(429);
  assert.equal(budget.is429HaltRequired(), false);

  clock += 3000;
  budget.recordRequestAttempt("DEXSCREENER", "FORWARD_OBSERVATION", clock);
  budget.recordResponseStatus(429);
  assert.equal(budget.is429HaltRequired(), true);

  const check = budget.canMakeRequest("DEXSCREENER", clock + 3000);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "CONSECUTIVE_HTTP_429_LIMIT_REACHED");
});
