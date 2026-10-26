/**
 * Phase 12.94-D Milestone D.3.3: Shadow Pipeline Yield & Budget Reservation Integration Suite
 *
 * Verifies that:
 * 1. The discovery loop respects the per-session enrichment attempt ceiling.
 * 2. Budget is strictly reserved for forward horizon observations, preventing enrichment exhaustion.
 * 3. At least one forward quote (+5m) is successfully fetched and recorded without look-ahead.
 * 4. Genuine canonical WSOL Raydium pools are preferred deterministically over non-SOL or non-Raydium pools.
 * 5. Zero qualifying candidates are handled truthfully without inventing data or observations.
 * 6. Safety invariants (wallet frozen at 7.9259 SOL, zero positions) are strictly maintained.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobalResourceBudgetManager } from "./GlobalResourceBudgetManager.js";
import {
  type FetchFunction,
  LiveDexScreenerCandidateSource,
  LiveDexScreenerQuoteProvider,
  WSOL_MINT,
} from "./LiveShadowProviders.js";
import { ShadowObservationRunner, type ShadowRunnerConfig } from "./ShadowObservationRunner.js";
import {
  computeCombinedSessionFingerprint,
  computeStrategyConfigFingerprint,
} from "./StrategyConfigurationFingerprint.js";

const TEST_OUT_DIR = path.resolve("data/research/prospective/test-pipeline-yield-suite");

describe("Milestone D.3.3: Shadow Pipeline Yield & Budget Reservation Integration Suite", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_OUT_DIR)) {
      fs.rmSync(TEST_OUT_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_OUT_DIR)) {
      fs.rmSync(TEST_OUT_DIR, { recursive: true, force: true });
    }
  });

  it("Invariant 1: Enforces enrichment ceiling and preserves budget for forward quote observation", async () => {
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

    // Mock fetch resembling live DexScreener conditions:
    // 1 discovery poll returns 8 Solana tokens
    // Mint 1: Orca only (mismatched)
    // Mint 2: Valid Raydium WSOL pool (0.005 SOL, $60k liq, age 2400s)
    // Mint 3: USDC only (mismatched)
    // Mint 4: Empty pair address (mismatched)
    // Mints 5-8: Should be skipped because maxEnrichmentAttempts = 4
    const mockFetch: FetchFunction = async (url: string) => {
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
        // At clock < 10_300_000 (decision time), returns 0.005 SOL
        // At clock >= 10_300_000 (+5m forward quote), returns 0.006 SOL (+20% return)
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
                pairCreatedAt: 10_000_000 - 2400 * 1000, // 2400s age
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
                pairAddress: "", // Empty pair address
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
      sessionId: "test-pipeline-yield-session",
      maxRequests,
      maxEnrichmentAttempts,
      minReservedForwardRequests,
    });

    const runnerConfig: ShadowRunnerConfig = {
      sessionId: "test-pipeline-yield-session",
      configFingerprint: fingerprints.combinedFingerprint,
      strategyConfigFingerprint: fingerprints.strategyConfigFingerprint,
      launcherConfigFingerprint: fingerprints.launcherConfigFingerprint,
      strategyVersion: fingerprints.strategyVersion,
      outputDir: TEST_OUT_DIR,
      approvedRootPath: path.resolve("data/research/prospective"),
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

    // 1. Discovery poll
    const candidates = await candidateSource.pollCandidates(5);

    // Verify candidate source yield metrics
    const srcYield = candidateSource.getYieldStats();
    expect(srcYield.profilesReceivedCount).toBe(8);
    expect(srcYield.enrichmentAttemptsCount).toBe(4); // Capped by maxEnrichmentAttempts
    expect(srcYield.mismatchedPairsCount).toBe(3); // MINT_ORCA, MINT_USDC, MINT_NO_PAIR
    expect(srcYield.priceQualifiedCandidatesCount).toBe(1); // MINT_VALID_RUNNER
    expect(candidates.length).toBe(1);

    const validCandidate = candidates[0]!;
    expect(validCandidate.symbol).toBe("VALID_RUN");
    expect(validCandidate.indicativePriceSol).toBe(0.005);
    expect(validCandidate.poolId).toBe("pool-valid-wsol-222222222222222222");
    expect(validCandidate.selectedPoolAddress).toBe("pool-valid-wsol-222222222222222222");
    expect(validCandidate.poolSelectionBasis).toBe("HIGHEST_LIQUIDITY_CANONICAL_WSOL_RAYDIUM_PAIR");
    expect(validCandidate.priceQuoteTimestampMs).toBeNull(); // Upstream tick timestamp preserved as null

    // 2. Ingest candidate into runner
    const decId = runner.ingestCandidate(validCandidate, clock);
    expect(decId).toBeTruthy();

    const decisionRecord = runner
      .getRecorder()
      .getDecisionRecords()
      .find((d) => d.decisionEventId === decId);
    expect(decisionRecord?.strategyCohort).toBe("ESTABLISHED_RUNNER");
    expect(decisionRecord?.gateOutcome.decision).toBe("FILTERED_REJECTED");
    expect(decisionRecord?.gateOutcome.primaryFailedRule).toBe("UNVERIFIED_LP_BURN_DATA");

    // Total requests used after intake: 1 discovery + 4 enrichments = 5
    expect(budgetManager.getTotalRequests()).toBe(5);
    expect(budgetManager.getRemainingRequests()).toBe(5);

    // 3. Advance virtual clock by 300 seconds (+5m horizon due)
    clock += 300_000;

    // Process due observations
    const processed = await runner.processDueObservations(clock);
    expect(processed).toBe(1);

    // Verify forward outcome was recorded with genuine price return (+20.0%)
    const forwardRecords = runner.getRecorder().getForwardRecords();
    const h300Record = forwardRecords.find((r) => r.horizonSec === 300);
    expect(h300Record).toBeDefined();
    expect(h300Record?.outcomeStatus).toBe("OBSERVED_PRICE");
    expect(h300Record?.indicativePriceSol).toBe(0.006);
    expect(h300Record?.priceReturnPct).toBe(20.0); // (0.006 - 0.005) / 0.005 * 100
    expect(h300Record?.liquidityUsd).toBe(65000);

    // Total requests used: 1 discovery + 4 enrichments + 1 forward quote = 6
    expect(budgetManager.getTotalRequests()).toBe(6);
    expect(budgetManager.getStats().forwardObservationRequests).toBe(1);

    // 4. Close session and inspect summary & manifest
    const { summary, manifest } = runner.closeSession(clock, candidateSource.getYieldStats());
    expect(summary.totalCandidatesScreened).toBe(1);
    expect(summary.acceptedCandidatesCount).toBe(0);
    expect(summary.rejectedCandidatesCount).toBe(1);
    expect(summary.candidatesByCohort.ESTABLISHED_RUNNER).toBe(1);

    // Verify pipeline yield stats in session summary
    const yieldStats = summary.pipelineYieldStats;
    expect(yieldStats).toBeDefined();
    expect(yieldStats?.profilesReceivedCount).toBe(8);
    expect(yieldStats?.enrichmentAttemptsCount).toBe(4);
    expect(yieldStats?.mismatchedPairsCount).toBe(3);
    expect(yieldStats?.priceQualifiedCandidatesCount).toBe(1);
    expect(yieldStats?.candidateDecisionsRecordedCount).toBe(1);
    expect(yieldStats?.forwardQuoteAttemptsCount).toBe(1);
    expect(yieldStats?.successfulForwardPriceObservationsCount).toBe(1);

    // Verify strategy configuration fingerprints
    expect(summary.strategyConfigFingerprint).toBe(computeStrategyConfigFingerprint());
    expect(summary.strategyVersion).toBe("nexustrade-strategy-v1.0");
    expect(manifest?.strategyConfigFingerprint).toBe(computeStrategyConfigFingerprint());

    // Verify safety invariants
    const safety = runner.verifySafetyInvariants();
    expect(safety.walletFrozen).toBe(true);
    expect(safety.balanceSol).toBe(7.9259);
    expect(safety.paperTradingActive).toBe(false);
    expect(safety.openPositionsCount).toBe(0);
  });

  it("Invariant 2: Safely handles discovery with zero qualifying candidates without inventing observations", async () => {
    let clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      maxEnrichmentAttempts: 3,
      clock: () => clock,
    });

    // Mock fetch returning only non-Raydium pairs
    const mockFetch: FetchFunction = async (url: string) => {
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
    expect(candidates.length).toBe(0);

    const yieldStats = candidateSource.getYieldStats();
    expect(yieldStats.profilesReceivedCount).toBe(2);
    expect(yieldStats.enrichmentAttemptsCount).toBe(2);
    expect(yieldStats.mismatchedPairsCount).toBe(2);
    expect(yieldStats.priceQualifiedCandidatesCount).toBe(0);

    const runner = new ShadowObservationRunner(
      {
        sessionId: "test-zero-candidates",
        configFingerprint: "sha256:zero-test",
        clock: () => clock,
      },
      { budgetManager },
    );

    const { summary } = runner.closeSession(clock, yieldStats);
    expect(summary.totalCandidatesScreened).toBe(0);
    expect(summary.acceptedCandidatesCount).toBe(0);
    expect(summary.rejectedCandidatesCount).toBe(0);
    expect(summary.pipelineYieldStats?.successfulForwardPriceObservationsCount).toBe(0);
  });

  it("Invariant 3: Deterministic pool selection prefers highest liquidity canonical WSOL pair with valid price", async () => {
    let clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

    const mockFetch: FetchFunction = async (url: string) => {
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
              // Pair 1: High liquidity ($100k) but USDC quote
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
              // Pair 2: WSOL quote, lower liquidity ($30k)
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
              // Pair 3: WSOL quote, higher liquidity ($75k) -> Should be selected!
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
    expect(candidates.length).toBe(1);

    const candidate = candidates[0]!;
    expect(candidate.poolId).toBe("pool-raydium-wsol-target-highest");
    expect(candidate.selectedPoolAddress).toBe("pool-raydium-wsol-target-highest");
    expect(candidate.poolSelectionBasis).toBe("HIGHEST_LIQUIDITY_CANONICAL_WSOL_RAYDIUM_PAIR");
    expect(candidate.liquidityUsd).toBe(75000);
    expect(candidate.indicativePriceSol).toBe(0.003);
  });

  it("Invariant 4: Enforces exact target pool address for seeded candidate and never substitutes higher-liquidity alternatives", async () => {
    let clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

    const mockFetch: FetchFunction = async (url: string) => {
      if (url.includes("MINT_SEED_MULTI")) {
        return new Response(
          JSON.stringify({
            pairs: [
              // Pool A: $200,000 liquidity (high liquidity alternative)
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "pool-a-high-liq-200k",
                baseToken: { address: "MINT_SEED_MULTI", symbol: "SEED" },
                quoteToken: { address: WSOL_MINT, symbol: "WSOL" },
                priceNative: "0.005",
                liquidity: { usd: 200000 },
                marketCap: 500000,
                pairCreatedAt: 10_000_000 - 3000 * 1000,
              },
              // Pool B: $50,000 liquidity (target seed pool)
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: "pool-b-seed-target-50k",
                baseToken: { address: "MINT_SEED_MULTI", symbol: "SEED" },
                quoteToken: { address: WSOL_MINT, symbol: "WSOL" },
                priceNative: "0.004",
                liquidity: { usd: 50000 },
                marketCap: 500000,
                pairCreatedAt: 10_000_000 - 3000 * 1000,
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

    // 1. Explicitly request target seed pool (Pool B)
    const seedCandidate = await candidateSource.enrichCandidate(
      "MINT_SEED_MULTI",
      "pool-b-seed-target-50k",
    );
    expect(seedCandidate).not.toBeNull();
    expect(seedCandidate?.poolId).toBe("pool-b-seed-target-50k");
    expect(seedCandidate?.selectedPoolAddress).toBe("pool-b-seed-target-50k");
    expect(seedCandidate?.poolSelectionBasis).toBe("EXACT_ENFORCED_SEED_POOL_MATCH");
    expect(seedCandidate?.liquidityUsd).toBe(50000);
    expect(seedCandidate?.indicativePriceSol).toBe(0.004);

    // 2. Request nonexistent Pool C -> MUST return null and NEVER substitute Pool A or B
    const missingCandidate = await candidateSource.enrichCandidate(
      "MINT_SEED_MULTI",
      "pool-c-nonexistent-999k",
    );
    expect(missingCandidate).toBeNull();
  });

  it("Invariant 5: Enforces decision timestamp causality and rejects retrospective timestamps", async () => {
    let clock = 10_000_000;
    const initialClock = clock;
    const budgetManager = new GlobalResourceBudgetManager({ clock: () => clock });

    const mockFetch: FetchFunction = async () => {
      // Simulate network latency advancing clock during enrichment
      clock += 5000;
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: "pool-latency-test-111",
              baseToken: { address: "MINT_LATENCY", symbol: "LAT" },
              quoteToken: { address: WSOL_MINT, symbol: "WSOL" },
              priceNative: "0.01",
              liquidity: { usd: 60000 },
              marketCap: 200000,
              pairCreatedAt: clock - 2000 * 1000,
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

    const candidate = await candidateSource.enrichCandidate("MINT_LATENCY");
    expect(candidate).not.toBeNull();
    // Clock advanced by 5000ms during fetch
    expect(candidate!.discoveryTimestampMs).toBe(10_005_000);

    const runner = new ShadowObservationRunner(
      {
        sessionId: "test-causality",
        configFingerprint: "sha256:causality-test",
        clock: () => clock,
      },
      { budgetManager },
    );

    // 1. Passing retrospective timestamp (initialClock = 10_000_000 < discoveryTimestamp = 10_005_000) MUST throw CAUSALITY_VIOLATION
    expect(() => {
      runner.ingestCandidate(candidate!, initialClock);
    }).toThrowError(/\[CAUSALITY_VIOLATION\]/);

    // 2. Passing valid causal timestamp (clock = 10_005_000 or later) succeeds
    const evaluationTimestamp = clock + 1000; // 10_006_000
    const decId = runner.ingestCandidate(candidate!, evaluationTimestamp);
    expect(decId).toBeTruthy();

    const decisionRecord = runner
      .getRecorder()
      .getDecisionRecords()
      .find((d) => d.decisionEventId === decId);
    expect(decisionRecord).toBeDefined();
    expect(decisionRecord!.decisionTimestampMs).toBe(evaluationTimestamp);
    expect(decisionRecord!.decisionTimestampMs).toBeGreaterThanOrEqual(
      candidate!.discoveryTimestampMs,
    );

    // 3. Forward horizons are scheduled strictly relative to decision timestamp
    const scheduled = runner.getScheduledTasks();
    expect(scheduled.length).toBe(4);
    for (const task of scheduled) {
      expect(task.scheduledDueTimestampMs).toBe(evaluationTimestamp + task.horizonSec * 1000);
    }
  });
});
