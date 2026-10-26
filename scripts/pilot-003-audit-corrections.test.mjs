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
  assert.ok(dec);

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
