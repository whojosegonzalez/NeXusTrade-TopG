/**
 * Phase 12.94-D Milestone D.3.3: Shadow Observation Runner Standalone Node.js Test Suite
 *
 * Verifies all 10 operational invariants under node:test test runner.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");

const { ShadowObservationRunner } = await import(
  `file://${path.join(distDir, "research", "prospective", "ShadowObservationRunner.js").replace(/\\/g, "/")}`
);

function createCandidate(overrides = {}) {
  return {
    poolId: "Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF",
    mintAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    symbol: "SOLRUN",
    discoveryTimestampMs: 1_000_000,
    streamSource: "RAYDIUM_TOP_TRADED",
    indicativePriceSol: 0.000005,
    priceQuoteTimestampMs: 1_000_000,
    liquidityUsd: 65000,
    marketCapUsd: 250000,
    lmcRatio: 0.26,
    lpBurnPct: 100,
    assetAgeSeconds: 2400,
    volume5mUsd: 35000,
    buys5m: 45,
    sells5m: 20,
    buyToSellRatio: 2.25,
    holdersCount: 450,
    rugScore: 120,
    bundlerPct: 0.12,
    top10HolderPct: 0.18,
    recentBuys60s: 18,
    recentSells60s: 8,
    ...overrides,
  };
}

class MockMarketDataProvider {
  constructor() {
    this.providerName = "MOCK_PROVIDER";
    this.callsCount = 0;
    this.failNextWith = null;
    this.nextQuoteOverrides = {};
  }

  async fetchQuote(poolId, mintAddress) {
    void poolId;
    void mintAddress;
    this.callsCount++;
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }
    return {
      indicativePriceSol: 0.000006,
      liquidityUsd: 70000,
      quoteTimestampMs: 1_300_010,
      quoteSource: "MOCK_PROVIDER",
      isExecutableQuote: false,
      isPoolDrained: false,
      ...this.nextQuoteOverrides,
    };
  }
}

test("ShadowObservationRunner — Invariant 1: Accepted candidate evaluation, gates & scheduling", () => {
  let virtualClock = 1_000_000;
  const runner = new ShadowObservationRunner({
    sessionId: "test-accepted-candidate",
    configFingerprint: "sha256:fp1",
    clock: () => virtualClock,
  });

  const decisionId = runner.ingestCandidate(createCandidate());
  assert.ok(decisionId);

  const decisionRecord = runner
    .getRecorder()
    .getDecisionRecords()
    .find((d) => d.decisionEventId === decisionId);
  assert.ok(decisionRecord);
  assert.equal(decisionRecord.gateOutcome.decision, "ACCEPTED_ARMED");
  assert.equal(decisionRecord.strategyCohort, "ESTABLISHED_RUNNER");

  const tasks = runner.getScheduledTasks();
  assert.equal(tasks.length, 4);
  assert.deepEqual(
    tasks.map((t) => t.horizonSec),
    [300, 900, 1800, 3600],
  );
  assert.ok(tasks.every((t) => t.status === "PENDING"));
});

test("ShadowObservationRunner — Invariant 2: Rejected candidate categorization & counterfactual scheduling", () => {
  let virtualClock = 1_000_000;
  const runner = new ShadowObservationRunner({
    sessionId: "test-rejected-candidate",
    configFingerprint: "sha256:fp2",
    clock: () => virtualClock,
  });

  const decisionId = runner.ingestCandidate(
    createCandidate({
      mintAddress: "MINT_HIGH_RUG",
      rugScore: 850,
    }),
  );
  assert.ok(decisionId);

  const decisionRecord = runner
    .getRecorder()
    .getDecisionRecords()
    .find((d) => d.decisionEventId === decisionId);
  assert.ok(decisionRecord);
  assert.equal(decisionRecord.gateOutcome.decision, "FILTERED_REJECTED");
  assert.equal(decisionRecord.gateOutcome.rejectionCategory, "REJECTED_BY_RISK");

  const tasks = runner.getScheduledTasks();
  assert.equal(tasks.length, 4);
});

test("ShadowObservationRunner — Invariants 3 & 4: Premature observation & duplicate finalization guards", () => {
  let virtualClock = 1_000_000;
  const runner = new ShadowObservationRunner({
    sessionId: "test-causality-guard",
    configFingerprint: "sha256:fp3",
    clock: () => virtualClock,
  });

  const decisionId = runner.ingestCandidate(createCandidate());
  const recorder = runner.getRecorder();

  virtualClock = 1_250_000;
  assert.throws(() => {
    recorder.recordHorizonOutcome({
      decisionEventId: decisionId,
      horizonSec: 300,
      observationTimestampMs: 1_250_000,
      outcomeStatus: "OBSERVED_PRICE",
      indicativePriceSol: 0.000006,
      liquidityUsd: 70000,
    });
  }, /PREMATURE_OBSERVATION/);

  virtualClock = 1_300_005;
  recorder.recordHorizonOutcome({
    decisionEventId: decisionId,
    horizonSec: 300,
    observationTimestampMs: 1_300_005,
    outcomeStatus: "OBSERVED_PRICE",
    indicativePriceSol: 0.000006,
    liquidityUsd: 70000,
  });

  assert.throws(() => {
    recorder.recordHorizonOutcome({
      decisionEventId: decisionId,
      horizonSec: 300,
      observationTimestampMs: 1_300_010,
      outcomeStatus: "OBSERVED_PRICE",
      indicativePriceSol: 0.0000065,
      liquidityUsd: 75000,
    });
  }, /DUPLICATE_HORIZON/);
});

test("ShadowObservationRunner — Invariant 5: Intake deadline fail-closed candidate rejection", () => {
  let virtualClock = 1_000_000;
  const runner = new ShadowObservationRunner({
    sessionId: "test-intake-deadline",
    configFingerprint: "sha256:fp5",
    intakeDurationMs: 300_000,
    clock: () => virtualClock,
  });

  const d1 = runner.ingestCandidate(createCandidate({ mintAddress: "MINT_ONE" }));
  assert.ok(d1);

  virtualClock = 1_300_001;
  const d2 = runner.ingestCandidate(createCandidate({ mintAddress: "MINT_TWO" }));
  assert.equal(d2, null);

  assert.equal(runner.getCandidateCount(), 1);
});

test("ShadowObservationRunner — Invariant 6: Session closure differentiates due missing vs truncated", () => {
  let virtualClock = 1_000_000;
  const runner = new ShadowObservationRunner({
    sessionId: "test-drain-truncation",
    configFingerprint: "sha256:fp6",
    clock: () => virtualClock,
  });

  runner.ingestCandidate(createCandidate());

  virtualClock = 1_500_000;
  runner.closeSession();

  const forwardRecords = runner.getRecorder().getForwardRecords();
  assert.equal(forwardRecords.length, 4);

  const fwd5m = forwardRecords.find((f) => f.horizonSec === 300);
  assert.equal(fwd5m.outcomeStatus, "MISSING_QUOTE_UNAVAILABLE");
  assert.equal(fwd5m.missingReason, "UNOBSERVED_AT_SESSION_CLOSE_ALREADY_DUE");

  const fwd15m = forwardRecords.find((f) => f.horizonSec === 900);
  assert.equal(fwd15m.outcomeStatus, "WINDOW_TRUNCATED");
  assert.equal(fwd15m.missingReason, "SESSION_CLOSED_BEFORE_HORIZON_ELAPSED");
});

test("ShadowObservationRunner — Invariant 7: Aggregate request ceiling and per-provider pacing", async () => {
  let virtualClock = 1_000_000;
  const mockProvider = new MockMarketDataProvider();
  const runner = new ShadowObservationRunner(
    {
      sessionId: "test-pacing-ceiling",
      configFingerprint: "sha256:fp7",
      minProviderSpacingMs: 2_000,
      maxAggregateRequests: 2,
      clock: () => virtualClock,
    },
    { marketDataProvider: mockProvider },
  );

  runner.ingestCandidate(createCandidate({ mintAddress: "MINT_REQ1" }));
  runner.ingestCandidate(createCandidate({ mintAddress: "MINT_REQ2" }));
  runner.ingestCandidate(createCandidate({ mintAddress: "MINT_REQ3" }));

  virtualClock = 1_300_000;

  const processed1 = await runner.processDueObservations();
  assert.equal(processed1, 1);
  assert.equal(runner.getTotalRequestsMade(), 1);

  const processedPaced = await runner.processDueObservations();
  assert.equal(processedPaced, 0);

  virtualClock = 1_302_000;
  const processed2 = await runner.processDueObservations();
  assert.equal(processed2, 2);
  assert.equal(runner.getTotalRequestsMade(), 2);

  const forwardRecords = runner.getRecorder().getForwardRecords();
  const ceilingRecord = forwardRecords.find(
    (f) => f.missingReason === "AGGREGATE_REQUEST_CEILING_REACHED",
  );
  assert.ok(ceilingRecord);
  assert.equal(ceilingRecord.outcomeStatus, "MISSING_QUOTE_UNAVAILABLE");
});

test("ShadowObservationRunner — Invariant 8: Provider failure and pool drainage resilience", async () => {
  let virtualClock = 1_000_000;
  const mockProvider = new MockMarketDataProvider();
  const runner = new ShadowObservationRunner(
    {
      sessionId: "test-provider-resilience",
      configFingerprint: "sha256:fp8",
      clock: () => virtualClock,
    },
    { marketDataProvider: mockProvider },
  );

  runner.ingestCandidate(createCandidate({ mintAddress: "MINT_ERROR" }));
  runner.ingestCandidate(createCandidate({ mintAddress: "MINT_DRAINED" }));

  virtualClock = 1_300_000;
  mockProvider.failNextWith = new Error("HTTP 503 Service Unavailable");
  await runner.processDueObservations();

  virtualClock = 1_302_000;
  mockProvider.nextQuoteOverrides = {
    isPoolDrained: true,
    indicativePriceSol: 0,
    liquidityUsd: 100,
  };
  await runner.processDueObservations();

  const forwardRecords = runner.getRecorder().getForwardRecords();
  const errorRecord = forwardRecords.find((f) =>
    f.missingReason?.includes("HTTP 503 Service Unavailable"),
  );
  assert.ok(errorRecord);
  assert.equal(errorRecord.outcomeStatus, "MISSING_QUOTE_UNAVAILABLE");

  const drainedRecord = forwardRecords.find((f) => f.outcomeStatus === "POOL_DRAINED");
  assert.ok(drainedRecord);
  assert.equal(drainedRecord.priceReturnPct, -100);
});

test("ShadowObservationRunner — Invariant 9: SHA-256 session manifest verification", () => {
  const tmpDir = path.join(os.tmpdir(), `shadow-manifest-test-${Date.now()}`);
  let virtualClock = 1_000_000;

  const runner = new ShadowObservationRunner({
    sessionId: "test-manifest-verification",
    configFingerprint: "sha256:expectedconfigdigest",
    outputDir: tmpDir,
    clock: () => virtualClock,
  });

  runner.ingestCandidate(createCandidate({ mintAddress: "MINT_MANIFEST_1" }));
  virtualClock = 1_300_000;
  const { manifest, summary } = runner.closeSession();

  assert.ok(manifest);
  assert.ok(summary);
  assert.equal(manifest.verificationStatus, "VERIFIED_OFFLINE");
  assert.equal(manifest.files.length, 3);

  for (const fileEntry of manifest.files) {
    const filePath = path.join(tmpDir, fileEntry.filename);
    assert.ok(fs.existsSync(filePath));
    const actualContent = fs.readFileSync(filePath);
    const actualHash = crypto.createHash("sha256").update(actualContent).digest("hex");
    assert.equal(actualHash, fileEntry.sha256);
    assert.equal(actualContent.length, fileEntry.byteSize);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("ShadowObservationRunner — Invariant 10: Safety invariant assertions", () => {
  const runner = new ShadowObservationRunner({
    sessionId: "test-safety-invariants",
    configFingerprint: "sha256:fp10",
  });

  const safety = runner.verifySafetyInvariants();
  assert.equal(safety.walletFrozen, true);
  assert.equal(safety.balanceSol, 7.9259);
  assert.equal(safety.paperTradingActive, false);
  assert.equal(safety.openPositionsCount, 0);
  assert.equal(safety.networkMutationsAllowed, false);
});
