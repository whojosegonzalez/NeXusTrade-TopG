/**
 * Phase 12.94-D Milestone D.3.3: Pilot 003 Consolidated Audit Corrections Verification Suite (Node.js)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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

const { ProspectiveObservationRecorder } = await import(
  `file://${path.join(distDir, "research", "prospective", "ProspectiveObservationRecorder.js").replace(/\\/g, "/")}`
);

const { ShadowObservationRunner } = await import(
  `file://${path.join(distDir, "research", "prospective", "ShadowObservationRunner.js").replace(/\\/g, "/")}`
);

const VALID_POOL = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const VALID_MINT = "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R";

test("Requirement 1: Enforces exact, case-sensitive pool identity during seeded admission and forward validation", async () => {
  let clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    minProviderSpacingMs: 0,
    clock: () => clock,
  });

  const mockFetch = async () => {
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
      { status: 200 },
    );
  };

  const candidateSource = new LiveDexScreenerCandidateSource(budgetManager, mockFetch, () => clock);
  const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager, mockFetch, () => clock);

  // 1. Altered case seeded lookup fails closed
  const alteredCasePool = VALID_POOL.toLowerCase();
  const resultAltered = await candidateSource.enrichCandidate(VALID_MINT, alteredCasePool);
  assert.equal(resultAltered, null);
  const diagAltered = candidateSource.getSeededLookupDiagnostics();
  assert.ok(diagAltered);
  assert.equal(diagAltered.failureReason, "SEED_POOL_ADDRESS_NOT_FOUND_IN_MATCHING_ASSESSMENTS");

  // 2. Altered case forward quote fails closed
  const quoteAltered = await quoteProvider.fetchQuote(alteredCasePool, VALID_MINT);
  assert.equal(quoteAltered.indicativePriceSol, null);
  assert.equal(quoteAltered.missingReason, "PAIR_ADDRESS_MISMATCH_OR_NOT_FOUND");

  // 3. Exact case succeeds
  const resultExact = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
  assert.ok(resultExact);
  assert.equal(resultExact.poolId, VALID_POOL);
  const quoteExact = await quoteProvider.fetchQuote(VALID_POOL, VALID_MINT);
  assert.equal(quoteExact.indicativePriceSol, 0.025);
});

test("Requirement 2: Rejects missing, zero, or negative liquidity with explicit diagnostic failure", async () => {
  let clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    minProviderSpacingMs: 0,
    clock: () => clock,
  });

  let currentLiquidityUsd = 0;

  const mockFetch = async () => {
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

  const candidateSource = new LiveDexScreenerCandidateSource(budgetManager, mockFetch, () => clock);

  // Zero liquidity
  currentLiquidityUsd = 0;
  const resZero = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
  assert.equal(resZero, null);
  assert.equal(
    candidateSource.getSeededLookupDiagnostics().failureReason,
    "SEED_ZERO_OR_NEGATIVE_LIQUIDITY",
  );

  // Negative liquidity
  currentLiquidityUsd = -500;
  const resNeg = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
  assert.equal(resNeg, null);
  assert.equal(
    candidateSource.getSeededLookupDiagnostics().failureReason,
    "SEED_ZERO_OR_NEGATIVE_LIQUIDITY",
  );

  // Missing liquidity
  currentLiquidityUsd = null;
  const resMissing = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
  assert.equal(resMissing, null);
  assert.equal(
    candidateSource.getSeededLookupDiagnostics().failureReason,
    "SEED_LIQUIDITY_INVALID_OR_MISSING",
  );

  // Valid positive liquidity
  currentLiquidityUsd = 4_500_000;
  const resValid = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
  assert.ok(resValid);
  assert.equal(resValid.liquidityUsd, 4_500_000);
});

test("Requirement 3 & 6: Preserves complete HTTP evidence for baseline and forward observations with manifest digest", async () => {
  let clock = 10_000_000;
  const tmpDir = path.join(os.tmpdir(), `nxt-audit-test-node-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    minProviderSpacingMs: 0,
    clock: () => clock,
  });

  const mockFetch = async () => {
    clock += 50;
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

  const candidateSource = new LiveDexScreenerCandidateSource(budgetManager, mockFetch, () => clock);
  const quoteProvider = new LiveDexScreenerQuoteProvider(budgetManager, mockFetch, () => clock);

  const runner = new ShadowObservationRunner(
    {
      sessionId: "session-audit-evidence-node",
      configFingerprint: "sha256:evidence-test",
      outputDir: tmpDir,
      clock: () => clock,
    },
    { marketDataProvider: quoteProvider, budgetManager },
  );

  const seedCand = await candidateSource.enrichCandidate(VALID_MINT, VALID_POOL);
  assert.ok(seedCand);
  const decId = runner.ingestCandidate(seedCand, clock);
  assert.ok(decId);

  const baselineDiag = candidateSource.getSeededLookupDiagnostics();
  assert.ok(baselineDiag);
  assert.equal(baselineDiag.evidenceType, "BASELINE_SEEDED_LOOKUP");
  assert.ok(baselineDiag.rawResponseSha256);
  assert.ok(baselineDiag.preservedPairData);

  const linkedBaseline = { ...baselineDiag, decisionEventId: decId };
  fs.writeFileSync(
    path.join(tmpDir, "seeded-lookup-evidence.json"),
    JSON.stringify(linkedBaseline, null, 2),
    "utf8",
  );

  clock += 300_000;
  const processed = await runner.processDueObservations(clock);
  assert.equal(processed, 1);

  const { summary, manifest } = runner.closeSession(clock);
  assert.equal(summary.totalCandidatesScreened, 1);
  assert.ok(manifest);

  const fwdEvidence = runner.getForwardHttpEvidence();
  assert.equal(fwdEvidence.length, 1);
  assert.equal(fwdEvidence[0].evidenceType, "FORWARD_QUOTE_OBSERVATION");
  assert.equal(fwdEvidence[0].decisionEventId, decId);
  assert.equal(fwdEvidence[0].horizonSec, 300);
  assert.ok(fwdEvidence[0].forwardOutcomeId);
  assert.ok(fwdEvidence[0].rawResponseSha256);

  const manifestFilenames = manifest.files.map((f) => f.filename);
  assert.ok(manifestFilenames.includes("decision-observations.jsonl"));
  assert.ok(manifestFilenames.includes("forward-observations.jsonl"));
  assert.ok(manifestFilenames.includes("prospective-session-summary.json"));
  assert.ok(manifestFilenames.includes("seeded-lookup-evidence.json"));
  assert.ok(manifestFilenames.includes("forward-quote-evidence.json"));

  for (const f of manifest.files) {
    const diskPath = path.join(tmpDir, f.filename);
    assert.ok(fs.existsSync(diskPath));
    const computedSha = crypto.createHash("sha256").update(fs.readFileSync(diskPath)).digest("hex");
    assert.equal(computedSha, f.sha256);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Requirement 4: Persists selectedPoolAddress, poolSelectionBasis, and lpBurnPct in immutable decision records", () => {
  let clock = 10_000_000;
  const tmpDir = path.join(os.tmpdir(), `nxt-market-features-node-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const recorder = new ProspectiveObservationRecorder({
    sessionId: "test-market-features-node",
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

  assert.ok(record);
  assert.equal(record.marketFeatures.selectedPoolAddress, VALID_POOL);
  assert.equal(record.marketFeatures.poolSelectionBasis, "EXACT_ENFORCED_SEED_POOL_MATCH");
  assert.equal(record.marketFeatures.lpBurnPct, 99.5);

  const jsonlContent = fs.readFileSync(path.join(tmpDir, "decision-observations.jsonl"), "utf8");
  const parsed = JSON.parse(jsonlContent.trim());
  assert.equal(parsed.marketFeatures.selectedPoolAddress, VALID_POOL);
  assert.equal(parsed.marketFeatures.poolSelectionBasis, "EXACT_ENFORCED_SEED_POOL_MATCH");
  assert.equal(parsed.marketFeatures.lpBurnPct, 99.5);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Requirement 7: Observation-quality summary calculates latency only on OBSERVED_PRICE and returns null when unavailable", () => {
  let clock = 10_000_000;
  const recorder = new ProspectiveObservationRecorder({
    sessionId: "test-summary-quality-node",
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
  assert.ok(dec);

  recorder.closeSession(clock);
  const summaryNoPrices = recorder.generateSessionSummary();
  assert.equal(summaryNoPrices.dataQuality.averageQuoteLatencyMs, null);
  assert.equal(summaryNoPrices.dataQuality.quoteFreshnessAverageMs, null);

  const recorder2 = new ProspectiveObservationRecorder({
    sessionId: "test-summary-quality-node-2",
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
  assert.ok(dec2);

  recorder2.recordHorizonOutcome({
    decisionEventId: dec2.decisionEventId,
    horizonSec: 300,
    observationTimestampMs: clock + 300_120,
    outcomeStatus: "OBSERVED_PRICE",
    indicativePriceSol: 0.026,
    liquidityUsd: 4_500_000,
    quoteTimestampMs: null,
  });

  recorder2.closeSession(clock + 300_120);
  const summaryObserved = recorder2.generateSessionSummary();

  assert.equal(summaryObserved.dataQuality.averageQuoteLatencyMs, 120);
  assert.equal(summaryObserved.dataQuality.quoteFreshnessAverageMs, null);
});

test("Requirement 8: HTTP timeout covers full body retrieval; prompt headers with stalled body aborts cleanly", async () => {
  let clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    minProviderSpacingMs: 0,
    clock: () => clock,
  });

  const mockFetch = async (_url, init) => {
    clock += 20; // Headers arrive in 20ms
    const signal = init?.signal;
    return {
      status: 200,
      statusText: "OK",
      ok: true,
      text: () =>
        new Promise((_resolve, reject) => {
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
    };
  };

  const quoteProvider = new LiveDexScreenerQuoteProvider(
    budgetManager,
    mockFetch,
    () => clock,
    200,
  );

  const result = await quoteProvider.fetchQuote(VALID_POOL, VALID_MINT);
  assert.equal(result.indicativePriceSol, null);
  assert.ok(result.missingReason.includes("HTTP_TIMEOUT_AFTER_200MS"));
  assert.equal(result.httpStatus, 200);

  const evidence = result.httpEvidence;
  assert.ok(evidence);
  assert.equal(evidence.headersReceivedMs, 10_000_020);
  assert.equal(evidence.responseCompleteMs, null);
  assert.equal(evidence.failureTimestampMs, 10_000_200);
  assert.equal(evidence.requestDurationMs, 200);
});

test("Requirement 9: Body completion occurring later than headers records accurate completion timing", async () => {
  let clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    minProviderSpacingMs: 0,
    clock: () => clock,
  });

  const mockFetch = async () => {
    clock += 50; // Headers at +50ms
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
    };
  };

  const quoteProvider = new LiveDexScreenerQuoteProvider(
    budgetManager,
    mockFetch,
    () => clock,
    1000,
  );

  const result = await quoteProvider.fetchQuote(VALID_POOL, VALID_MINT);
  assert.equal(result.indicativePriceSol, 0.025);
  const ev = result.httpEvidence;
  assert.ok(ev);
  assert.equal(ev.requestStartMs, 10_000_000);
  assert.equal(ev.headersReceivedMs, 10_000_050);
  assert.equal(ev.responseCompleteMs, 10_000_250);
  assert.equal(ev.requestDurationMs, 250);
});

test("Requirement 10: Transport and body-read failures retain truthful request evidence and genuine status", async () => {
  let clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    minProviderSpacingMs: 0,
    clock: () => clock,
  });

  // Case A: Connection refused (no headers, no status)
  const connRefusedFetch = async () => {
    clock += 75;
    throw new Error("connect ECONNREFUSED 127.0.0.1:443");
  };

  const quoteProviderConn = new LiveDexScreenerQuoteProvider(
    budgetManager,
    connRefusedFetch,
    () => clock,
  );
  const resultConn = await quoteProviderConn.fetchQuote(VALID_POOL, VALID_MINT);
  assert.equal(resultConn.indicativePriceSol, null);
  assert.equal(resultConn.httpStatus, null);
  const evConn = resultConn.httpEvidence;
  assert.equal(
    evConn?.targetUrl,
    `https://api.dexscreener.com/latest/dex/pairs/solana/${VALID_POOL}`,
  );
  assert.equal(evConn?.requestStartMs, 10_000_000);
  assert.equal(evConn?.headersReceivedMs, null);
  assert.equal(evConn?.responseCompleteMs, null);
  assert.equal(evConn?.failureTimestampMs, 10_000_075);
  assert.equal(evConn?.requestDurationMs, 75);
  assert.ok(evConn?.failureReason.includes("ECONNREFUSED"));

  // Case B: HTTP 500 headers arrived, but body stream fails mid-read
  clock = 20_000_000;
  const streamFailFetch = async () => {
    clock += 40; // Headers received at +40ms
    return {
      status: 500,
      statusText: "Internal Server Error",
      ok: false,
      text: async () => {
        clock += 60; // Body read fails at +100ms total
        throw new Error("Premature close of response stream");
      },
    };
  };

  const quoteProviderStream = new LiveDexScreenerQuoteProvider(
    budgetManager,
    streamFailFetch,
    () => clock,
  );
  const resultStream = await quoteProviderStream.fetchQuote(VALID_POOL, VALID_MINT);
  assert.equal(resultStream.indicativePriceSol, null);
  assert.equal(resultStream.httpStatus, 500); // Genuinely received 500 status retained!
  const evStream = resultStream.httpEvidence;
  assert.equal(evStream?.headersReceivedMs, 20_000_040);
  assert.equal(evStream?.responseCompleteMs, null);
  assert.equal(evStream?.failureTimestampMs, 20_000_100);
  assert.equal(evStream?.requestDurationMs, 100);
  assert.ok(evStream?.failureReason.includes("Premature close"));
});

test("Requirement 11: Validates complete priceNative string and rejects reciprocal overflow & malformed values", async () => {
  const clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    minProviderSpacingMs: 0,
    clock: () => clock,
  });

  const testPriceParsing = async (priceNative, isBaseWsol) => {
    const mockFetch = async () => {
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

  // 1. Direct path: numeric prefix (parseFloat bug) rejected
  const prefixRes = await testPriceParsing("0.025abc", false);
  assert.equal(prefixRes.price, null);
  assert.equal(prefixRes.reason, "MALFORMED_PRICE_NATIVE_STRING");

  // 2. Direct path: negative price rejected
  const negativeRes = await testPriceParsing("-0.025", false);
  assert.equal(negativeRes.price, null);
  assert.equal(negativeRes.reason, "MALFORMED_PRICE_NATIVE_STRING");

  // 3. Direct path: zero price rejected
  const zeroRes = await testPriceParsing("0.000", false);
  assert.equal(zeroRes.price, null);
  assert.equal(zeroRes.reason, "INVALID_PRICE_NATIVE_VALUE");

  // 4. Inverted path: reciprocal overflow rejected
  const overflowRes = await testPriceParsing("1e-320", true);
  assert.equal(overflowRes.price, null);
  assert.equal(overflowRes.reason, "RECIPROCAL_OVERFLOW_OR_UNDERFLOW");

  // 5. Inverted path: non-finite float rejected
  const nonFiniteRes = await testPriceParsing("1e320", true);
  assert.equal(nonFiniteRes.price, null);
  assert.equal(nonFiniteRes.reason, "INVALID_PRICE_NATIVE_VALUE");

  // 6. Valid inverted price succeeds
  const validInverted = await testPriceParsing("0.025", true);
  assert.equal(validInverted.price, 40.0);
  assert.equal(validInverted.reason, undefined);
});

test("Requirement 12: Forward request beginning when due and completing after session deadline exercises response-after-deadline branch and links evidence", async () => {
  let clock = 10_000_000;
  const budgetManager = new GlobalResourceBudgetManager({
    maxTotalRequests: 10,
    minProviderSpacingMs: 0,
    clock: () => clock,
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nxt-late-deadline-node-"));
  const recorder = new ProspectiveObservationRecorder({
    sessionId: "session-late-resp-test-node",
    configFingerprint: "sha256:late-resp-node",
    outputDir: tmpDir,
    clock: () => clock,
  });

  const mockQuoteProvider = {
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
      sessionId: "session-late-resp-test-node",
      configFingerprint: "sha256:late-resp-node",
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
  assert.ok(decId);

  // Advance clock to when horizon 300 is due (10_300_000)
  clock = 10_300_000;
  const processed = await runner.processDueObservations(clock);
  assert.equal(processed, 1);

  // Verify outcome recorded as MISSING_QUOTE_UNAVAILABLE with RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE
  const fwdRecords = recorder.getForwardRecords();
  const h300Record = fwdRecords.find((r) => r.horizonSec === 300);
  assert.ok(h300Record);
  assert.equal(h300Record.outcomeStatus, "MISSING_QUOTE_UNAVAILABLE");
  assert.equal(h300Record.missingReason, "RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE");
  assert.equal(h300Record.actualObservationTimestampMs, 10_365_000);

  // Verify evidence linkage
  const forwardEv = runner.getForwardHttpEvidence();
  assert.equal(forwardEv.length, 1);
  assert.equal(forwardEv[0].decisionEventId, decId);
  assert.equal(forwardEv[0].horizonSec, 300);
  assert.equal(forwardEv[0].forwardOutcomeId, h300Record.forwardOutcomeId);
  assert.equal(forwardEv[0].failureReason, "RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE");

  // Close session and verify manifest file digests include forward-quote-evidence.json
  const { manifest } = runner.closeSession(10_365_000);
  assert.ok(manifest.files.some((f) => f.filename === "forward-quote-evidence.json"));

  const fwdEvidenceDisk = JSON.parse(
    fs.readFileSync(path.join(tmpDir, "forward-quote-evidence.json"), "utf8"),
  );
  assert.equal(fwdEvidenceDisk[0].forwardOutcomeId, h300Record.forwardOutcomeId);
  assert.equal(fwdEvidenceDisk[0].failureReason, "RESPONSE_ARRIVED_AFTER_SESSION_DEADLINE");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
