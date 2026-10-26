/**
 * Phase 12.94-D Milestone D.3.3: Shadow Pipeline Yield & Budget Reservation Integration Suite (Node.js)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");

const { GlobalResourceBudgetManager } = await import(
  `file://${path.join(distDir, "research", "prospective", "GlobalResourceBudgetManager.js").replace(/\\/g, "/")}`
);

const { LiveDexScreenerCandidateSource, LiveDexScreenerQuoteProvider, WSOL_MINT } = await import(
  `file://${path.join(distDir, "research", "prospective", "LiveShadowProviders.js").replace(/\\/g, "/")}`
);

const { ShadowObservationRunner } = await import(
  `file://${path.join(distDir, "research", "prospective", "ShadowObservationRunner.js").replace(/\\/g, "/")}`
);

const { computeCombinedSessionFingerprint, computeStrategyConfigFingerprint } = await import(
  `file://${path.join(distDir, "research", "prospective", "StrategyConfigurationFingerprint.js").replace(/\\/g, "/")}`
);

const TEST_OUT_DIR = path.resolve(rootDir, "data/research/prospective/test-pipeline-yield-node");

test("Invariant 1: Enforces enrichment ceiling and preserves budget for forward quote observation", async (t) => {
  if (fs.existsSync(TEST_OUT_DIR)) {
    fs.rmSync(TEST_OUT_DIR, { recursive: true, force: true });
  }

  t.after(() => {
    if (fs.existsSync(TEST_OUT_DIR)) {
      fs.rmSync(TEST_OUT_DIR, { recursive: true, force: true });
    }
  });

  let clock = 10_000_000;
  const maxRequests = 10;
  const maxEnrichmentAttempts = 4;
  const minReservedForwardRequests = 3;
  const pacingMs = 2500;

  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: maxRequests,
    maxEnrichmentAttempts,
    minReservedForwardRequests,
    minProviderSpacingMs: pacingMs,
    clock: () => clock,
  });

  const mockFetch = async (url) => {
    if (url.includes("/token-profiles/latest/v1")) {
      return new Response(
        JSON.stringify([
          { chainId: "solana", tokenAddress: "MINT_ORCA_ONLY" },
          { chainId: "solana", tokenAddress: "MINT_VALID_RUNNER" },
          { chainId: "solana", tokenAddress: "MINT_USDC_ONLY" },
          { chainId: "solana", tokenAddress: "MINT_NO_PAIR_ADDR" },
          { chainId: "solana", tokenAddress: "MINT_EXTRA_5" },
          { chainId: "solana", tokenAddress: "MINT_EXTRA_6" },
          { chainId: "solana", tokenAddress: "MINT_EXTRA_7" },
          { chainId: "solana", tokenAddress: "MINT_EXTRA_8" },
        ]),
        { status: 200 },
      );
    }

    if (url.includes("MINT_ORCA_ONLY")) {
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "orca",
              pairAddress: "pool-orca-only-111111111111111111",
              baseToken: { address: "MINT_ORCA_ONLY", symbol: "ORCA_TOK" },
              quoteToken: { address: WSOL_MINT },
              priceNative: "0.001",
              liquidity: { usd: 30000 },
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes("MINT_VALID_RUNNER") || url.includes("pool-valid-wsol-222222222222222222")) {
      const isForwardObservation = clock >= 10_300_000;
      const priceNative = isForwardObservation ? "0.006" : "0.005";
      const liquidityUsd = isForwardObservation ? 65000 : 60000;

      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-valid-wsol-222222222222222222",
              baseToken: { address: "MINT_VALID_RUNNER", symbol: "VALID_RUN" },
              quoteToken: { address: WSOL_MINT, symbol: "WSOL" },
              priceNative,
              liquidity: { usd: liquidityUsd },
              marketCap: 200000,
              pairCreatedAt: 10_000_000 - 2400 * 1000,
              volume: { m5: 15000 },
              txns: { m5: { buys: 40, sells: 20 } },
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes("MINT_USDC_ONLY")) {
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-usdc-33333333333333333333",
              baseToken: { address: "MINT_USDC_ONLY", symbol: "USDC_TOK" },
              quoteToken: {
                address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                symbol: "USDC",
              },
              priceNative: "1.25",
              liquidity: { usd: 40000 },
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes("MINT_NO_PAIR_ADDR")) {
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "",
              baseToken: { address: "MINT_NO_PAIR_ADDR", symbol: "NOPAIR" },
              quoteToken: { address: WSOL_MINT },
              priceNative: "0.002",
            },
          ],
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ pairs: [] }), { status: 404 });
  };

  const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager, mockFetch, () => clock);
  const candidateSource = new LiveDexScreenerCandidateSource(
    budgetManager,
    mockFetch,
    () => clock,
    async (ms) => {
      clock += ms;
    },
  );

  const fingerprints = computeCombinedSessionFingerprint({
    sessionId: "test-pipeline-yield-session-node",
    maxRequests,
    maxEnrichmentAttempts,
    minReservedForwardRequests,
  });

  const runnerConfig = {
    sessionId: "test-pipeline-yield-session-node",
    configFingerprint: fingerprints.combinedFingerprint,
    strategyConfigFingerprint: fingerprints.strategyConfigFingerprint,
    launcherConfigFingerprint: fingerprints.launcherConfigFingerprint,
    strategyVersion: fingerprints.strategyVersion,
    outputDir: TEST_OUT_DIR,
    approvedRootPath: path.resolve(rootDir, "data/research/prospective"),
    maxCandidates: 5,
    intakeDurationMs: 600_000,
    drainDurationMs: 300_000,
    minProviderSpacingMs: pacingMs,
    maxAggregateRequests: maxRequests,
    clock: () => clock,
  };

  const runner = new ShadowObservationRunner(runnerConfig, {
    marketDataProvider: quoteProvider,
    budgetManager,
  });

  const candidates = await candidateSource.pollCandidates(5);
  const srcYield = candidateSource.getYieldStats();
  assert.equal(srcYield.profilesReceivedCount, 8);
  assert.equal(srcYield.enrichmentAttemptsCount, 4);
  assert.equal(srcYield.mismatchedPairsCount, 3);
  assert.equal(srcYield.priceQualifiedCandidatesCount, 1);
  assert.equal(candidates.length, 1);

  const validCandidate = candidates[0];
  assert.equal(validCandidate.symbol, "VALID_RUN");
  assert.equal(validCandidate.indicativePriceSol, 0.005);
  assert.equal(validCandidate.poolId, "pool-valid-wsol-222222222222222222");
  assert.equal(validCandidate.selectedPoolAddress, "pool-valid-wsol-222222222222222222");
  assert.equal(validCandidate.poolSelectionBasis, "HIGHEST_LIQUIDITY_CANONICAL_WSOL_RAYDIUM_PAIR");
  assert.equal(validCandidate.priceQuoteTimestampMs, null);

  const decId = runner.ingestCandidate(validCandidate, clock);
  assert.ok(decId);

  const decisionRecord = runner
    .getRecorder()
    .getDecisionRecords()
    .find((d) => d.decisionEventId === decId);
  assert.equal(decisionRecord.strategyCohort, "ESTABLISHED_RUNNER");
  assert.equal(decisionRecord.gateOutcome.decision, "FILTERED_REJECTED");
  assert.equal(decisionRecord.gateOutcome.primaryFailedRule, "UNVERIFIED_LP_BURN_DATA");

  assert.equal(budgetManager.getTotalRequests(), 5);
  assert.equal(budgetManager.getRemainingRequests(), 5);

  clock += 300_000;
  const processed = await runner.processDueObservations(clock);
  assert.equal(processed, 1);

  const forwardRecords = runner.getRecorder().getForwardRecords();
  const h300Record = forwardRecords.find((r) => r.horizonSec === 300);
  assert.ok(h300Record);
  assert.equal(h300Record.outcomeStatus, "OBSERVED_PRICE");
  assert.equal(h300Record.indicativePriceSol, 0.006);
  assert.equal(h300Record.priceReturnPct, 20.0);
  assert.equal(h300Record.liquidityUsd, 65000);

  assert.equal(budgetManager.getTotalRequests(), 6);
  assert.equal(budgetManager.getStats().forwardObservationRequests, 1);

  const { summary, manifest } = runner.closeSession(clock, candidateSource.getYieldStats());
  assert.equal(summary.totalCandidatesScreened, 1);
  assert.equal(summary.acceptedCandidatesCount, 0);
  assert.equal(summary.rejectedCandidatesCount, 1);
  assert.equal(summary.candidatesByCohort.ESTABLISHED_RUNNER, 1);

  const yieldStats = summary.pipelineYieldStats;
  assert.ok(yieldStats);
  assert.equal(yieldStats.profilesReceivedCount, 8);
  assert.equal(yieldStats.enrichmentAttemptsCount, 4);
  assert.equal(yieldStats.mismatchedPairsCount, 3);
  assert.equal(yieldStats.priceQualifiedCandidatesCount, 1);
  assert.equal(yieldStats.candidateDecisionsRecordedCount, 1);
  assert.equal(yieldStats.forwardQuoteAttemptsCount, 1);
  assert.equal(yieldStats.successfulForwardPriceObservationsCount, 1);

  assert.equal(summary.strategyConfigFingerprint, computeStrategyConfigFingerprint());
  assert.equal(summary.strategyVersion, "nexustrade-strategy-v1.0");
  assert.equal(manifest.strategyConfigFingerprint, computeStrategyConfigFingerprint());

  const safety = runner.verifySafetyInvariants();
  assert.equal(safety.walletFrozen, true);
  assert.equal(safety.balanceSol, 7.9259);
  assert.equal(safety.paperTradingActive, false);
  assert.equal(safety.openPositionsCount, 0);
});

test("Invariant 2: Safely handles discovery with zero qualifying candidates without inventing observations", async () => {
  let clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    maxEnrichmentAttempts: 3,
    clock: () => clock,
  });

  const mockFetch = async (url) => {
    if (url.includes("/token-profiles/latest/v1")) {
      return new Response(
        JSON.stringify([
          { chainId: "solana", tokenAddress: "MINT_NONRAY_1" },
          { chainId: "solana", tokenAddress: "MINT_NONRAY_2" },
        ]),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        pairs: [
          {
            chainId: "solana",
            dexId: "meteora",
            pairAddress: "pool-meteora",
            baseToken: { address: "MINT_NONRAY_1" },
            quoteToken: { address: WSOL_MINT },
          },
        ],
      }),
      { status: 200 },
    );
  };

  const candidateSource = new LiveDexScreenerCandidateSource(
    budgetManager,
    mockFetch,
    () => clock,
    async (ms) => {
      clock += ms;
    },
  );

  const candidates = await candidateSource.pollCandidates(5);
  assert.equal(candidates.length, 0);

  const yieldStats = candidateSource.getYieldStats();
  assert.equal(yieldStats.profilesReceivedCount, 2);
  assert.equal(yieldStats.enrichmentAttemptsCount, 2);
  assert.equal(yieldStats.mismatchedPairsCount, 2);
  assert.equal(yieldStats.priceQualifiedCandidatesCount, 0);

  const runner = new ShadowObservationRunner(
    {
      sessionId: "test-zero-candidates",
      configFingerprint: "sha256:zero-test",
      clock: () => clock,
    },
    { budgetManager },
  );

  const { summary } = runner.closeSession(clock, yieldStats);
  assert.equal(summary.totalCandidatesScreened, 0);
  assert.equal(summary.acceptedCandidatesCount, 0);
  assert.equal(summary.rejectedCandidatesCount, 0);
  assert.equal(summary.pipelineYieldStats.successfulForwardPriceObservationsCount, 0);
});

test("Invariant 3: Deterministic pool selection prefers highest liquidity canonical WSOL pair", async () => {
  let clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

  const mockFetch = async (url) => {
    if (url.includes("/token-profiles/latest/v1")) {
      return new Response(
        JSON.stringify([{ chainId: "solana", tokenAddress: "MINT_MULTI_POOL" }]),
        { status: 200 },
      );
    }

    if (url.includes("MINT_MULTI_POOL")) {
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-raydium-usdc-high-liq",
              baseToken: { address: "MINT_MULTI_POOL", symbol: "MULTI" },
              quoteToken: {
                address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
                symbol: "USDC",
              },
              priceNative: "1.50",
              liquidity: { usd: 100000 },
            },
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-raydium-wsol-low-liq",
              baseToken: { address: "MINT_MULTI_POOL", symbol: "MULTI" },
              quoteToken: { address: WSOL_MINT, symbol: "WSOL" },
              priceNative: "0.003",
              liquidity: { usd: 30000 },
              marketCap: 150000,
              pairCreatedAt: 10_000_000 - 2000 * 1000,
            },
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-raydium-wsol-target-highest",
              baseToken: { address: "MINT_MULTI_POOL", symbol: "MULTI" },
              quoteToken: { address: WSOL_MINT, symbol: "WSOL" },
              priceNative: "0.003",
              liquidity: { usd: 75000 },
              marketCap: 150000,
              pairCreatedAt: 10_000_000 - 2000 * 1000,
            },
          ],
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ pairs: [] }), { status: 404 });
  };

  const candidateSource = new LiveDexScreenerCandidateSource(
    budgetManager,
    mockFetch,
    () => clock,
    async (ms) => {
      clock += ms;
    },
  );

  const candidates = await candidateSource.pollCandidates(5);
  assert.equal(candidates.length, 1);

  const candidate = candidates[0];
  assert.equal(candidate.poolId, "pool-raydium-wsol-target-highest");
  assert.equal(candidate.selectedPoolAddress, "pool-raydium-wsol-target-highest");
  assert.equal(candidate.poolSelectionBasis, "HIGHEST_LIQUIDITY_CANONICAL_WSOL_RAYDIUM_PAIR");
  assert.equal(candidate.liquidityUsd, 75000);
  assert.equal(candidate.indicativePriceSol, 0.003);
});
