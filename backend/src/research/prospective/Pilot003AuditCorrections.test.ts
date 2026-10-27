/**
 * Phase 12.94-D Milestone D.3.3: Pilot 003 Consolidated Audit Corrections Verification Suite
 *
 * Covers:
 * 1. Exact, case-sensitive pool identity rejection on altered case.
 * 2. Mandatory finite positive baseline liquidity and price validation.
 * 3. Complete auditable HTTP evidence capture for baseline and forward observations.
 * 4. Preservation of selectedPoolAddress, poolSelectionBasis, and lpBurnPct in decision records.
 * 5. Late response status (MISSING_QUOTE_UNAVAILABLE) and honest pool drainage price retention.
 * 6. Evidence finalization and manifest digest verification.
 * 7. Observation-quality summary calculation (latency only on OBSERVED_PRICE; null when unavailable).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { GlobalResourceBudgetManager } from "./GlobalResourceBudgetManager.js";
import {
  type FetchFunction,
  LiveDexScreenerCandidateSource,
  LiveDexScreenerQuoteProvider,
  WSOL_MINT,
} from "./LiveShadowProviders.js";
import { ProspectiveObservationRecorder } from "./ProspectiveObservationRecorder.js";
import {
  type IShadowMarketDataProvider,
  ShadowObservationRunner,
} from "./ShadowObservationRunner.js";

const VALID_POOL = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const VALID_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

describe("D.3.3 Pilot 003 Consolidated Audit Corrections", () => {
  it("Requirement 1: Enforces exact, case-sensitive pool identity during seeded admission and forward validation", async () => {
    const clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    // Provide mock response that returns the exact pool address
    const mockFetch: FetchFunction = async () => {
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: VALID_POOL, // Exact case
              baseToken: { address: VALID_MINT, symbol: "RAY" },
              quoteToken: { address: WSOL_MINT, symbol: "SOL" },
              priceNative: "0.025",
              liquidity: { usd: 4_500_000 },
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
    );
    const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager, mockFetch, () => clock);

    // 1. Seeded lookup with altered letter case MUST fail closed
    const alteredCasePool = VALID_POOL.toLowerCase();
    const resultAltered = await candidateSource.enrichCandidate(VALID_MINT, alteredCasePool);
    expect(resultAltered).toBeNull();

    const diagAltered = candidateSource.getSeededLookupDiagnostics();
    expect(diagAltered).toBeDefined();
    expect(diagAltered?.failureReason).toBe("SEED_POOL_ADDRESS_NOT_FOUND_IN_MATCHING_ASSESSMENTS");

    // 2. Forward quote with altered letter case MUST fail closed
    const quoteAltered = await quoteProvider.fetchQuote(alteredCasePool, VALID_MINT);
    expect(quoteAltered.indicativePriceSol).toBeNull();
    expect(quoteAltered.missingReason).toBe("PAIR_ADDRESS_MISMATCH_OR_NOT_FOUND");

    // 3. Exact case lookup MUST succeed
    const resultExact = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
    expect(resultExact).not.toBeNull();
    expect(resultExact?.poolId).toBe(VALID_POOL);

    const quoteExact = await quoteProvider.fetchQuote(VALID_POOL, VALID_MINT);
    expect(quoteExact.indicativePriceSol).toBe(0.025);
    expect(quoteExact.missingReason).toBeUndefined();
  });

  it("Requirement 2: Rejects missing, zero, or negative liquidity with explicit diagnostic failure", async () => {
    const clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    let currentLiquidityUsd: number | null = 0;

    const mockFetch: FetchFunction = async () => {
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: VALID_POOL,
              baseToken: { address: VALID_MINT, symbol: "RAY" },
              quoteToken: { address: WSOL_MINT, symbol: "SOL" },
              priceNative: "0.025",
              liquidity: currentLiquidityUsd !== null ? { usd: currentLiquidityUsd } : {},
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
    );

    // 1. Zero liquidity
    currentLiquidityUsd = 0;
    const resZero = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
    expect(resZero).toBeNull();
    expect(candidateSource.getSeededLookupDiagnostics()?.failureReason).toBe(
      "SEED_ZERO_OR_NEGATIVE_LIQUIDITY",
    );

    // 2. Negative liquidity
    currentLiquidityUsd = -500;
    const resNeg = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
    expect(resNeg).toBeNull();
    expect(candidateSource.getSeededLookupDiagnostics()?.failureReason).toBe(
      "SEED_ZERO_OR_NEGATIVE_LIQUIDITY",
    );

    // 3. Missing liquidity field
    currentLiquidityUsd = null;
    const resMissing = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
    expect(resMissing).toBeNull();
    expect(candidateSource.getSeededLookupDiagnostics()?.failureReason).toBe(
      "SEED_LIQUIDITY_INVALID_OR_MISSING",
    );

    // 4. Positive finite liquidity succeeds
    currentLiquidityUsd = 4_500_000;
    const resValid = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
    expect(resValid).not.toBeNull();
    expect(resValid?.liquidityUsd).toBe(4_500_000);
    expect(candidateSource.getSeededLookupDiagnostics()?.failureReason).toBeNull();
  });

  it("Requirement 3 & 6: Preserves complete HTTP evidence for baseline and forward observations with manifest digest", async () => {
    let clock = 10_000_000;
    const tmpDir = path.join(os.tmpdir(), `nxt-audit-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    const mockFetch: FetchFunction = async () => {
      clock += 50; // 50ms latency
      return new Response(
        JSON.stringify({
          pairs: [
            {
              chainId: "solana",
              dexId: "raydium",
              pairAddress: VALID_POOL,
              baseToken: { address: VALID_MINT, symbol: "RAY" },
              quoteToken: { address: WSOL_MINT, symbol: "SOL" },
              priceNative: "0.025",
              liquidity: { usd: 4_500_000 },
            },
          ],
        }),
        { status: 200, statusText: "OK" },
      );
    };

    const candidateSource = new LiveDexScreenerCandidateSource(
      budgetManager,
      mockFetch,
      () => clock,
    );
    const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager, mockFetch, () => clock);

    const runner = new ShadowObservationRunner(
      {
        sessionId: "session-audit-evidence",
        configFingerprint: "sha256:evidence-test",
        outputDir: tmpDir,
        clock: () => clock,
      },
      { marketDataProvider: quoteProvider, budgetManager },
    );

    // Step 1: Ingest seeded candidate
    const seedCand = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
    expect(seedCand).not.toBeNull();
    const decId = runner.ingestCandidate(seedCand!, clock);
    expect(decId).toBeTruthy();

    // Verify baseline diagnostics retain complete pair data and timestamps
    const baselineDiag = candidateSource.getSeededLookupDiagnostics();
    expect(baselineDiag).toBeDefined();
    expect(baselineDiag?.evidenceType).toBe("BASELINE_SEEDED_LOOKUP");
    expect(baselineDiag?.rawResponseSha256).toBeTruthy();
    expect(baselineDiag?.requestStartMs).toBeLessThan(baselineDiag!.responseCompleteMs!);
    expect(baselineDiag?.preservedPairData).toBeDefined();
    expect((baselineDiag?.preservedPairData as Record<string, unknown>)?.pairAddress).toBe(
      VALID_POOL,
    );
    expect(baselineDiag?.priceInterpretation).toBe("DIRECT_BASE_WSOL");

    // Save baseline evidence linked to decision
    const linkedBaseline = { ...baselineDiag, decisionEventId: decId };
    fs.writeFileSync(
      path.join(tmpDir, "seeded-lookup-evidence.json"),
      JSON.stringify(linkedBaseline, null, 2),
      "utf8",
    );

    // Step 2: Advance clock by 300s to mature +5m horizon and process observation
    clock += 300_000;
    const processed = await runner.processDueObservations(clock);
    expect(processed).toBe(1);

    // Step 3: Close session cleanly
    const { summary, manifest } = runner.closeSession(clock);
    expect(summary.totalCandidatesScreened).toBe(1);
    expect(manifest).toBeDefined();

    // Check forward HTTP evidence on runner
    const fwdEvidence = runner.getForwardHttpEvidence();
    expect(fwdEvidence.length).toBe(1);
    expect(fwdEvidence[0]?.evidenceType).toBe("FORWARD_QUOTE_OBSERVATION");
    expect(fwdEvidence[0]?.decisionEventId).toBe(decId);
    expect(fwdEvidence[0]?.horizonSec).toBe(300);
    expect(fwdEvidence[0]?.forwardOutcomeId).toBeTruthy();
    expect(fwdEvidence[0]?.rawResponseSha256).toBeTruthy();
    expect(fwdEvidence[0]?.preservedPairData).toBeDefined();
    expect(fwdEvidence[0]?.extractedPriceSol).toBe(0.025);

    // Verify all 5 expected artifacts are present and covered in manifest
    const manifestFilenames = manifest!.files.map((f) => f.filename);
    expect(manifestFilenames).toContain("decision-observations.jsonl");
    expect(manifestFilenames).toContain("forward-observations.jsonl");
    expect(manifestFilenames).toContain("prospective-session-summary.json");
    expect(manifestFilenames).toContain("seeded-lookup-evidence.json");
    expect(manifestFilenames).toContain("forward-quote-evidence.json");

    for (const f of manifest!.files) {
      const diskPath = path.join(tmpDir, f.filename);
      expect(fs.existsSync(diskPath)).toBe(true);
      const computedSha = crypto
        .createHash("sha256")
        .update(fs.readFileSync(diskPath))
        .digest("hex");
      expect(computedSha).toBe(f.sha256);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Requirement 4: Persists selectedPoolAddress, poolSelectionBasis, and lpBurnPct in immutable decision records", () => {
    const clock = 10_000_000;
    const tmpDir = path.join(os.tmpdir(), `nxt-market-features-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const recorder = new ProspectiveObservationRecorder({
      sessionId: "test-market-features",
      configFingerprint: "sha256:mf-test",
      outputDir: tmpDir,
      clock: () => clock,
    });

    const record = recorder.recordDecisionEvent({
      discoveryTimestampMs: clock - 1000,
      streamSource: "DEXSCREENER_EXACT_PAIR_LOOKUP",
      mintAddress: VALID_MINT,
      poolId: VALID_POOL,
      symbol: "RAY",
      strategyCohort: "UNCLASSIFIED",
      marketFeatures: {
        indicativePriceSol: 0.025,
        priceQuoteTimestampMs: null,
        priceQuoteFreshnessMs: null,
        liquidityUsd: 4_500_000,
        volume5mUsd: 150_000,
        marketCapUsd: 500_000_000,
        assetAgeSeconds: 86_400 * 365,
        holdersCount: null,
        buyToSellRatio: 1.2,
        recentBuys60s: null,
        recentSells60s: null,
        lmcRatio: null,
        rugScore: null,
        bundlerPct: null,
        top10HolderPct: null,
        unavailableInputs: ["lpBurnPct"],
        selectedPoolAddress: VALID_POOL,
        poolSelectionBasis: "EXACT_ENFORCED_SEED_POOL_MATCH",
        lpBurnPct: 99.5,
      },
      triggered: false,
      rejectionReason: "AGE_EXCEEDS_MAXIMUM",
      gateChecks: [],
    });

    expect(record).not.toBeNull();
    expect(record!.marketFeatures.selectedPoolAddress).toBe(VALID_POOL);
    expect(record!.marketFeatures.poolSelectionBasis).toBe("EXACT_ENFORCED_SEED_POOL_MATCH");
    expect(record!.marketFeatures.lpBurnPct).toBe(99.5);

    // Verify persisted JSONL on disk contains the exact metadata fields
    const jsonlContent = fs.readFileSync(path.join(tmpDir, "decision-observations.jsonl"), "utf8");
    const parsed = JSON.parse(jsonlContent.trim());
    expect(parsed.marketFeatures.selectedPoolAddress).toBe(VALID_POOL);
    expect(parsed.marketFeatures.poolSelectionBasis).toBe("EXACT_ENFORCED_SEED_POOL_MATCH");
    expect(parsed.marketFeatures.lpBurnPct).toBe(99.5);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Requirement 5: Corrects late-response status (MISSING_QUOTE_UNAVAILABLE) and preserves residual price on pool drainage", async () => {
    let clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    let mockQuotePrice: number | null = 0.005;
    let mockIsDrained = false;

    const mockQuoteProvider: IShadowMarketDataProvider = {
      providerName: "DEXSCREENER",
      fetchQuote: async () => {
        return {
          indicativePriceSol: mockQuotePrice,
          liquidityUsd: mockIsDrained ? 200 : 4_500_000,
          quoteTimestampMs: null,
          quoteSource: "DEXSCREENER",
          isExecutableQuote: false,
          isPoolDrained: mockIsDrained,
        };
      },
    };

    const runner = new ShadowObservationRunner(
      {
        sessionId: "test-outcomes",
        configFingerprint: "sha256:outcomes-test",
        intakeDurationMs: 60_000,
        drainDurationMs: 300_000, // Total deadline: 10_360_000
        clock: () => clock,
      },
      { marketDataProvider: mockQuoteProvider, budgetManager },
    );

    runner.ingestCandidate(
      {
        poolId: VALID_POOL,
        mintAddress: VALID_MINT,
        symbol: "RAY",
        discoveryTimestampMs: clock,
        streamSource: "DEXSCREENER_EXACT_PAIR_LOOKUP",
        indicativePriceSol: 0.025,
        priceQuoteTimestampMs: null,
        liquidityUsd: 4_500_000,
        marketCapUsd: 500_000_000,
        lmcRatio: null,
        lpBurnPct: null,
        assetAgeSeconds: 86400,
        volume5mUsd: 50000,
        buys5m: 10,
        sells5m: 5,
        buyToSellRatio: 2.0,
      },
      clock,
    );

    // 1. Pool drainage with residual price preserves actual price and does NOT invent 0
    clock += 300_000; // Due at 10_300_000
    mockIsDrained = true;
    mockQuotePrice = 0.005; // residual price
    await runner.processDueObservations(clock);

    const fwdRecords = runner.getRecorder().getForwardRecords();
    const h300 = fwdRecords.find((f) => f.horizonSec === 300);
    expect(h300).toBeDefined();
    expect(h300?.outcomeStatus).toBe("POOL_DRAINED");
    expect(h300?.indicativePriceSol).toBe(0.005); // Preserves residual price!
    expect(h300?.priceReturnPct).toBe(-80.0); // (0.005 - 0.025)/0.025 * 100

    // 2. Late response arriving after session deadline is MISSING_QUOTE_UNAVAILABLE, NOT WINDOW_TRUNCATED
    const runnerLate = new ShadowObservationRunner(
      {
        sessionId: "test-late",
        configFingerprint: "sha256:late-test",
        intakeDurationMs: 60_000,
        drainDurationMs: 300_000, // Deadline at 10_360_000
        clock: () => clock,
      },
      { marketDataProvider: mockQuoteProvider, budgetManager },
    );

    runnerLate.ingestCandidate(
      {
        poolId: VALID_POOL,
        mintAddress: VALID_MINT,
        symbol: "RAY",
        discoveryTimestampMs: clock,
        streamSource: "DEXSCREENER_EXACT_PAIR_LOOKUP",
        indicativePriceSol: 0.025,
        priceQuoteTimestampMs: null,
        liquidityUsd: 4_500_000,
        marketCapUsd: 500_000_000,
        lmcRatio: null,
        lpBurnPct: null,
        assetAgeSeconds: 86400,
        volume5mUsd: 50000,
        buys5m: 10,
        sells5m: 5,
        buyToSellRatio: 2.0,
      },
      clock,
    );

    // Advance clock past session deadline (10_360_000)
    clock += 400_000;
    // Simulate late response check
    const lateTasks = runnerLate.getScheduledTasks().filter((t) => t.horizonSec === 300);
    expect(lateTasks.length).toBe(1);
    // At session close, future horizons are WINDOW_TRUNCATED, but overdue unobserved horizons are MISSING
    const { summary } = runnerLate.closeSession(clock);
    expect(summary.totalCandidatesScreened).toBe(1);
    const lateForwards = runnerLate.getRecorder().getForwardRecords();
    const lateH300 = lateForwards.find((f) => f.horizonSec === 300);
    expect(lateH300?.outcomeStatus).toBe("MISSING_QUOTE_UNAVAILABLE");
    expect(lateH300?.missingReason).toBe("UNOBSERVED_AT_SESSION_CLOSE_ALREADY_DUE");
  });

  it("Requirement 7: Observation-quality summary calculates latency only on OBSERVED_PRICE and returns null when unavailable", () => {
    const clock = 10_000_000;
    const recorder = new ProspectiveObservationRecorder({
      sessionId: "test-summary-quality",
      configFingerprint: "sha256:sq-test",
      clock: () => clock,
    });

    const dec = recorder.recordDecisionEvent({
      discoveryTimestampMs: clock,
      streamSource: "DEXSCREENER_EXACT_PAIR_LOOKUP",
      mintAddress: VALID_MINT,
      poolId: VALID_POOL,
      symbol: "RAY",
      strategyCohort: "UNCLASSIFIED",
      marketFeatures: {
        indicativePriceSol: 0.025,
        priceQuoteTimestampMs: null,
        priceQuoteFreshnessMs: null,
        liquidityUsd: 4_500_000,
        volume5mUsd: 50000,
        marketCapUsd: 500_000_000,
        assetAgeSeconds: 86400,
        holdersCount: null,
        buyToSellRatio: 1.0,
        recentBuys60s: null,
        recentSells60s: null,
        lmcRatio: null,
        rugScore: null,
        bundlerPct: null,
        top10HolderPct: null,
        unavailableInputs: [],
      },
      triggered: false,
      gateChecks: [],
    });
    expect(dec).not.toBeNull();

    // Case A: Zero observed prices (e.g. truncated session) -> averageQuoteLatencyMs is null, quoteFreshnessAverageMs is null
    recorder.closeSession(clock);
    const summaryNoPrices = recorder.generateSessionSummary();
    expect(summaryNoPrices.dataQuality.averageQuoteLatencyMs).toBeNull();
    expect(summaryNoPrices.dataQuality.quoteFreshnessAverageMs).toBeNull();

    // Case B: Session with 1 OBSERVED_PRICE (latency = 120ms) and 3 WINDOW_TRUNCATED
    const recorder2 = new ProspectiveObservationRecorder({
      sessionId: "test-summary-quality-2",
      configFingerprint: "sha256:sq-test-2",
      clock: () => clock,
    });

    const dec2 = recorder2.recordDecisionEvent({
      discoveryTimestampMs: clock,
      streamSource: "DEXSCREENER_EXACT_PAIR_LOOKUP",
      mintAddress: VALID_MINT,
      poolId: VALID_POOL,
      symbol: "RAY",
      strategyCohort: "UNCLASSIFIED",
      marketFeatures: {
        indicativePriceSol: 0.025,
        priceQuoteTimestampMs: null,
        priceQuoteFreshnessMs: null,
        liquidityUsd: 4_500_000,
        volume5mUsd: 50000,
        marketCapUsd: 500_000_000,
        assetAgeSeconds: 86400,
        holdersCount: null,
        buyToSellRatio: 1.0,
        recentBuys60s: null,
        recentSells60s: null,
        lmcRatio: null,
        rugScore: null,
        bundlerPct: null,
        top10HolderPct: null,
        unavailableInputs: [],
      },
      triggered: false,
      gateChecks: [],
    });

    // Record +300s observed price with 120ms latency and null upstream quoteTimestamp
    recorder2.recordHorizonOutcome({
      decisionEventId: dec2!.decisionEventId,
      horizonSec: 300,
      observationTimestampMs: clock + 300_120, // 120ms latency
      outcomeStatus: "OBSERVED_PRICE",
      indicativePriceSol: 0.026,
      liquidityUsd: 4_500_000,
      quoteTimestampMs: null,
    });

    // Close session to truncate remaining horizons
    recorder2.closeSession(clock + 300_120);
    const summaryObserved = recorder2.generateSessionSummary();

    // Latency is calculated ONLY from the 1 OBSERVED_PRICE record (120ms), not diluted by truncated records
    expect(summaryObserved.dataQuality.averageQuoteLatencyMs).toBe(120);
    // Upstream quote freshness was unknown (null) across all records -> average is null
    expect(summaryObserved.dataQuality.quoteFreshnessAverageMs).toBeNull();
  });

  it("Requirement 8: HTTP timeout covers full body retrieval; prompt headers with stalled body aborts cleanly", async () => {
    let clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    const mockFetch: FetchFunction = async (_url, init) => {
      clock += 20; // Headers arrive in 20ms
      const signal = init?.signal;
      return {
        status: 200,
        statusText: "OK",
        ok: true,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            // Body stalls until aborted
            if (signal?.aborted) {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            } else {
              signal?.addEventListener("abort", () => {
                clock += 180; // Abort fires at 200ms total
                const err = new Error("The operation was aborted");
                err.name = "AbortError";
                reject(err);
              });
            }
          }),
      } as unknown as Response;
    };

    const quoteProvider = new LiveDexScreenerQuoteProvider(
      budgetManager,
      mockFetch,
      () => clock,
      200, // 200ms timeout
    );

    const result = await quoteProvider.fetchQuote(VALID_POOL, VALID_MINT);
    expect(result.indicativePriceSol).toBeNull();
    expect(result.missingReason).toContain("HTTP_TIMEOUT_AFTER_200MS");
    expect(result.httpStatus).toBe(200); // Retains genuine headers status received before body stalled!

    const evidence = result.httpEvidence;
    expect(evidence).toBeDefined();
    expect(evidence?.headersReceivedMs).toBe(10_000_020);
    expect(evidence?.responseCompleteMs).toBeNull(); // Never manufactured
    expect(evidence?.failureTimestampMs).toBe(10_000_200);
    expect(evidence?.requestDurationMs).toBe(200);
  });

  it("Requirement 9: Body completion occurring later than headers records accurate completion timing", async () => {
    let clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    const mockFetch: FetchFunction = async () => {
      clock += 50; // Headers arrive at +50ms
      return {
        status: 200,
        statusText: "OK",
        ok: true,
        text: async () => {
          clock += 200; // Body stream finishes at +250ms total
          return JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: VALID_POOL,
                baseToken: { address: VALID_MINT, symbol: "RAY" },
                quoteToken: { address: WSOL_MINT, symbol: "SOL" },
                priceNative: "0.025",
                liquidity: { usd: 4_500_000 },
              },
            ],
          });
        },
      } as unknown as Response;
    };

    const quoteProvider = new LiveDexScreenerQuoteProvider(
      budgetManager,
      mockFetch,
      () => clock,
      1000,
    );

    const result = await quoteProvider.fetchQuote(VALID_POOL, VALID_MINT);
    expect(result.indicativePriceSol).toBe(0.025);
    const ev = result.httpEvidence;
    expect(ev).toBeDefined();
    expect(ev?.requestStartMs).toBe(10_000_000);
    expect(ev?.headersReceivedMs).toBe(10_000_050);
    expect(ev?.responseCompleteMs).toBe(10_000_250);
    expect(ev?.requestDurationMs).toBe(250);
  });

  it("Requirement 10: Transport and body-read failures retain truthful request evidence and genuine status", async () => {
    let clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    // Case A: Connection refused (no headers, no status)
    const connRefusedFetch: FetchFunction = async () => {
      clock += 75;
      throw new Error("connect ECONNREFUSED 127.0.0.1:443");
    };

    const quoteProviderConn = new LiveDexScreenerQuoteProvider(
      budgetManager,
      connRefusedFetch,
      () => clock,
    );
    const resultConn = await quoteProviderConn.fetchQuote(VALID_POOL, VALID_MINT);
    expect(resultConn.indicativePriceSol).toBeNull();
    expect(resultConn.httpStatus).toBeNull();
    const evConn = resultConn.httpEvidence;
    expect(evConn?.targetUrl).toBe(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${VALID_POOL}`,
    );
    expect(evConn?.requestStartMs).toBe(10_000_000);
    expect(evConn?.headersReceivedMs).toBeNull();
    expect(evConn?.responseCompleteMs).toBeNull();
    expect(evConn?.failureTimestampMs).toBe(10_000_075);
    expect(evConn?.requestDurationMs).toBe(75);
    expect(evConn?.failureReason).toContain("ECONNREFUSED");

    // Case B: HTTP 500 headers arrived, but body stream fails mid-read
    clock = 20_000_000;
    const streamFailFetch: FetchFunction = async () => {
      clock += 40; // Headers received at +40ms
      return {
        status: 500,
        statusText: "Internal Server Error",
        ok: false,
        text: async () => {
          clock += 60; // Body read fails at +100ms total
          throw new Error("Premature close of response stream");
        },
      } as unknown as Response;
    };

    const quoteProviderStream = new LiveDexScreenerQuoteProvider(
      budgetManager,
      streamFailFetch,
      () => clock,
    );
    const resultStream = await quoteProviderStream.fetchQuote(VALID_POOL, VALID_MINT);
    expect(resultStream.indicativePriceSol).toBeNull();
    expect(resultStream.httpStatus).toBe(500); // Genuinely received 500 status retained!
    const evStream = resultStream.httpEvidence;
    expect(evStream?.headersReceivedMs).toBe(20_000_040);
    expect(evStream?.responseCompleteMs).toBeNull();
    expect(evStream?.failureTimestampMs).toBe(20_000_100);
    expect(evStream?.requestDurationMs).toBe(100);
    expect(evStream?.failureReason).toContain("Premature close");
  });

  it("Requirement 11: Validates complete priceNative string and rejects reciprocal overflow & malformed values", async () => {
    const clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    // Helper to test quoteProvider with custom priceNative & base/quote configuration
    const testPriceParsing = async (
      priceNative: unknown,
      isBaseWsol: boolean,
    ): Promise<{ price: number | null; reason: string | undefined }> => {
      const mockFetch: FetchFunction = async () => {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                pairAddress: VALID_POOL,
                baseToken: isBaseWsol
                  ? { address: WSOL_MINT, symbol: "SOL" }
                  : { address: VALID_MINT, symbol: "RAY" },
                quoteToken: isBaseWsol
                  ? { address: VALID_MINT, symbol: "RAY" }
                  : { address: WSOL_MINT, symbol: "SOL" },
                priceNative,
                liquidity: { usd: 4_500_000 },
              },
            ],
          }),
          { status: 200 },
        );
      };
      const provider = new LiveDexScreenerQuoteProvider(budgetManager, mockFetch, () => clock);
      const res = await provider.fetchQuote(VALID_POOL, VALID_MINT);
      return { price: res.indicativePriceSol, reason: res.missingReason };
    };

    // 1. Direct path: numeric prefix (parseFloat bug) MUST be rejected as malformed
    const prefixRes = await testPriceParsing("0.025abc", false);
    expect(prefixRes.price).toBeNull();
    expect(prefixRes.reason).toBe("MALFORMED_PRICE_NATIVE_STRING");

    // 2. Direct path: negative price MUST be rejected
    const negativeRes = await testPriceParsing("-0.025", false);
    expect(negativeRes.price).toBeNull();
    expect(negativeRes.reason).toBe("MALFORMED_PRICE_NATIVE_STRING");

    // 3. Direct path: zero price MUST be rejected
    const zeroRes = await testPriceParsing("0.000", false);
    expect(zeroRes.price).toBeNull();
    expect(zeroRes.reason).toBe("INVALID_PRICE_NATIVE_VALUE");

    // 4. Inverted path: reciprocal overflow (tiny denominator 1e-320 -> Infinity) MUST be rejected
    const overflowRes = await testPriceParsing("1e-320", true);
    expect(overflowRes.price).toBeNull();
    expect(overflowRes.reason).toBe("RECIPROCAL_OVERFLOW_OR_UNDERFLOW");

    // 5. Inverted path: non-finite float (1e320 > MAX_VALUE -> Infinity) MUST be rejected
    const nonFiniteRes = await testPriceParsing("1e320", true);
    expect(nonFiniteRes.price).toBeNull();
    expect(nonFiniteRes.reason).toBe("INVALID_PRICE_NATIVE_VALUE");

    // 6. Valid inverted price (1 / 0.025 = 40.0) MUST succeed
    const validInverted = await testPriceParsing("0.025", true);
    expect(validInverted.price).toBe(40.0);
    expect(validInverted.reason).toBeUndefined();
  });

  it("Requirement 12: Forward request beginning when due and completing after session deadline exercises response-after-deadline branch and links evidence", async () => {
    let clock = 10_000_000;
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 10,
      minProviderSpacingMs: 0,
      clock: () => clock,
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nxt-late-deadline-"));
    const recorder = new ProspectiveObservationRecorder({
      sessionId: "session-late-resp-test",
      configFingerprint: "sha256:late-resp",
      outputDir: tmpDir,
      clock: () => clock,
    });

    // Mock quote provider whose fetchQuote begins when due (t0 + 300s) and completes after session deadline (t0 + 360s)
    const mockQuoteProvider: IShadowMarketDataProvider = {
      providerName: "DEXSCREENER",
      getTargetUrl: () => `https://api.dexscreener.com/latest/dex/pairs/solana/${VALID_POOL}`,
      fetchQuote: async () => {
        clock = 10_365_000; // Response completes 5 seconds AFTER the 10_360_000 session deadline!
        return {
          indicativePriceSol: 0.026,
          liquidityUsd: 4_500_000,
          quoteTimestampMs: null,
          quoteSource: "DEXSCREENER",
          isExecutableQuote: false,
          httpStatus: 200,
          httpEvidence: {
            evidenceType: "FORWARD_QUOTE_OBSERVATION",
            targetUrl: `https://api.dexscreener.com/latest/dex/pairs/solana/${VALID_POOL}`,
            httpStatus: 200,
            requestStartMs: 10_300_000,
            responseCompleteMs: 10_365_000,
            requestDurationMs: 65_000,
            rawResponseSha256: crypto.createHash("sha256").update("mock").digest("hex"),
            rawResponseLengthBytes: 4,
            observedPairCount: 1,
            preservedPairData: { pool: VALID_POOL },
            extractedPriceSol: 0.026,
            priceInterpretation: "DIRECT_BASE_WSOL",
            observedLiquidityUsd: 4_500_000,
            failureReason: null,
          },
        };
      },
    };

    const runner = new ShadowObservationRunner(
      {
        sessionId: "session-late-resp-test",
        configFingerprint: "sha256:late-resp",
        intakeDurationMs: 60_000,
        drainDurationMs: 300_000, // Total session ceiling: 10_360_000
        outputDir: tmpDir,
        clock: () => clock,
      },
      { marketDataProvider: mockQuoteProvider, budgetManager, recorder },
    );

    const decId = runner.ingestCandidate(
      {
        poolId: VALID_POOL,
        mintAddress: VALID_MINT,
        symbol: "RAY",
        discoveryTimestampMs: clock,
        streamSource: "DEXSCREENER_EXACT_PAIR_LOOKUP",
        indicativePriceSol: 0.025,
        priceQuoteTimestampMs: null,
        liquidityUsd: 4_500_000,
        marketCapUsd: 500_000_000,
        lmcRatio: null,
        lpBurnPct: null,
        assetAgeSeconds: 86400,
        volume5mUsd: 50000,
        buys5m: 10,
        sells5m: 5,
        buyToSellRatio: 2.0,
      },
      clock,
    );
    expect(decId).not.toBeNull();

    // Advance clock to when horizon 300 is due (10_300_000)
    clock = 10_300_000;
    const processed = await runner.processDueObservations(clock);
    expect(processed).toBe(1);

    // Verify outcome recorded as MISSING_QUOTE_UNAVAILABLE with RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE
    const fwdRecords = recorder.getForwardRecords();
    const h300Record = fwdRecords.find((r) => r.horizonSec === 300);
    expect(h300Record).toBeDefined();
    expect(h300Record?.outcomeStatus).toBe("MISSING_QUOTE_UNAVAILABLE");
    expect(h300Record?.missingReason).toBe("RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE");
    expect(h300Record?.actualObservationTimestampMs).toBe(10_365_000);

    // Verify evidence linkage
    const forwardEv = runner.getForwardHttpEvidence();
    expect(forwardEv.length).toBe(1);
    expect(forwardEv[0]?.decisionEventId).toBe(decId);
    expect(forwardEv[0]?.horizonSec).toBe(300);
    expect(forwardEv[0]?.forwardOutcomeId).toBe(h300Record?.forwardOutcomeId);
    expect(forwardEv[0]?.failureReason).toBe("RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE");

    // Close session and verify manifest file digests include forward-quote-evidence.json
    const { manifest } = runner.closeSession(10_365_000);
    expect(manifest!.files.some((f) => f.filename === "forward-quote-evidence.json")).toBe(true);

    const fwdEvidenceDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "forward-quote-evidence.json"), "utf8"),
    );
    expect(fwdEvidenceDisk[0].forwardOutcomeId).toBe(h300Record?.forwardOutcomeId);
    expect(fwdEvidenceDisk[0].failureReason).toBe("RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
