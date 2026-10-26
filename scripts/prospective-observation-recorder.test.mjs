import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");

// Dynamically import compiled or direct module
const { ProspectiveObservationRecorder } = await import(
  `file://${path.join(distDir, "research", "prospective", "ProspectiveObservationRecorder.js").replace(/\\/g, "/")}`
).catch(async () => {
  // If dist not yet emitted, compile on the fly or test direct ts
  throw new Error("Compiled module not found in dist");
});

function createMockDecisionInput(overrides = {}) {
  return {
    discoveryTimestampMs: 1_000_000,
    decisionTimestampMs: 1_000_010,
    streamSource: "RAYDIUM_TOP_TRADED",
    mintAddress: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    poolId: "Dw4uLKPb3tvRfuUYNvaiNMZyCk85c4zLffaieVXUDUxF",
    symbol: "SOLRUN",
    strategyCohort: "ESTABLISHED_RUNNER",
    triggered: true,
    marketFeatures: {
      indicativePriceSol: 0.000005,
      priceQuoteTimestampMs: 1_000_008,
      priceQuoteFreshnessMs: 2,
      liquidityUsd: 65000,
      volume5mUsd: 35000,
      marketCapUsd: 250000,
      assetAgeSeconds: 2400,
      holdersCount: 420,
      buyToSellRatio: 2.1,
      recentBuys60s: 18,
      recentSells60s: 8,
      lmcRatio: 0.26,
      rugScore: 150,
      bundlerPct: 0.12,
      top10HolderPct: 0.18,
      unavailableInputs: [],
    },
    gateChecks: [
      { name: "MIN_LIQUIDITY_GATE", passed: true, value: 65000, requirement: ">= $50k" },
      {
        name: "MATURITY_WINDOW_GATE",
        passed: true,
        value: 2400,
        requirement: "1800s <= Age <= 7200s",
      },
    ],
    ...overrides,
  };
}

test("ProspectiveObservationRecorder — Immutability of Decision Records", () => {
  const recorder = new ProspectiveObservationRecorder({
    sessionId: "shadow-test-01",
    configFingerprint: "sha256:abc123config",
  });

  const record = recorder.recordDecisionEvent(createMockDecisionInput());
  assert.ok(record, "Record should be created");
  assert.equal(record.gateOutcome.decision, "ACCEPTED_ARMED");

  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.marketFeatures));
  assert.ok(Object.isFrozen(record.gateOutcome));

  assert.throws(() => {
    record.symbol = "TAMPERED";
  }, TypeError);

  assert.throws(() => {
    record.marketFeatures.indicativePriceSol = 999;
  }, TypeError);
});

test("ProspectiveObservationRecorder — Rejection Categorization Invariants", () => {
  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection("REJECTED_DANGER_RISK", [
      "RUGCHECK_SECURITY_GATE",
    ]),
    "REJECTED_BY_RISK",
  );
  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection(undefined, ["BUNDLER_CONCENTRATION_GATE"]),
    "REJECTED_BY_RISK",
  );
  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection("REJECTED_ESTABLISHED_MACRO_DOWNTREND", [
      "ESTABLISHED_MACRO_TREND_GATE",
    ]),
    "REJECTED_BY_RISK",
  );

  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection("GATE_FAIL_LIQUIDITY", [
      "MIN_LIQUIDITY_GATE",
    ]),
    "REJECTED_BY_ELIGIBILITY",
  );
  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection("GATE_FAIL_MATURITY", [
      "MATURITY_WINDOW_GATE",
    ]),
    "REJECTED_BY_ELIGIBILITY",
  );
  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection(undefined, ["FLOW_ABSORPTION_GATE"]),
    "REJECTED_BY_ELIGIBILITY",
  );

  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection("MISSING_PRICE_DATA", []),
    "REJECTED_BY_MISSING_DATA",
  );
  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection(undefined, ["UNAVAILABLE_RUGCHECK"]),
    "REJECTED_BY_MISSING_DATA",
  );

  assert.equal(
    ProspectiveObservationRecorder.categorizeRejection("MAX_OPEN_POSITIONS_REACHED", []),
    "REJECTED_BY_CAPACITY",
  );
});

test("ProspectiveObservationRecorder — Causality & Forward Horizon Non-Backfilling", () => {
  let virtualClock = 1_000_000;
  const recorder = new ProspectiveObservationRecorder({
    sessionId: "shadow-test-02",
    configFingerprint: "sha256:fingerprint",
    clock: () => virtualClock,
  });

  const baseline = recorder.recordDecisionEvent(createMockDecisionInput());
  const baselineId = baseline.decisionEventId;

  assert.equal(baseline.forwardHorizons, undefined);

  // Advance clock to +5m (300s = 300,000 ms -> scheduledDue = 1_000_010 + 300_000 = 1_300_010 ms)
  // Set observation time to 1_300_015 ms (+5ms latency)
  virtualClock = 1_300_015;
  const fwd5m = recorder.recordHorizonOutcome({
    decisionEventId: baselineId,
    horizonSec: 300,
    indicativePriceSol: 0.000006,
    liquidityUsd: 70000,
    outcomeStatus: "OBSERVED_PRICE",
  });

  assert.equal(fwd5m.decisionEventId, baselineId);
  assert.equal(fwd5m.horizonSec, 300);
  assert.equal(fwd5m.priceReturnPct, 20);
  assert.equal(fwd5m.observationLatencyMs, 5);

  const storedBaseline = recorder
    .getDecisionRecords()
    .find((d) => d.decisionEventId === baselineId);
  assert.equal(storedBaseline.marketFeatures.indicativePriceSol, 0.000005);
  assert.equal(storedBaseline.priceReturnPct, undefined);
});

test("ProspectiveObservationRecorder — Missing Observation Handling & Truncation", () => {
  let virtualClock = 1_000_000;
  const recorder = new ProspectiveObservationRecorder({
    sessionId: "shadow-test-03",
    configFingerprint: "sha256:fingerprint",
    clock: () => virtualClock,
  });

  const baseline = recorder.recordDecisionEvent(createMockDecisionInput());

  virtualClock = 1_300_000;
  recorder.recordHorizonOutcome({
    decisionEventId: baseline.decisionEventId,
    horizonSec: 300,
    indicativePriceSol: 0.0000045,
    liquidityUsd: 60000,
    outcomeStatus: "OBSERVED_PRICE",
  });

  virtualClock = 1_900_000;
  const fwd15m = recorder.recordHorizonOutcome({
    decisionEventId: baseline.decisionEventId,
    horizonSec: 900,
    indicativePriceSol: null,
    liquidityUsd: null,
    outcomeStatus: "MISSING_QUOTE_UNAVAILABLE",
    missingReason: "DEXSCREENER_TIMEOUT_504",
  });

  assert.equal(fwd15m.outcomeStatus, "MISSING_QUOTE_UNAVAILABLE");
  assert.equal(fwd15m.indicativePriceSol, null);
  assert.equal(fwd15m.priceReturnPct, null);
  assert.equal(fwd15m.missingReason, "DEXSCREENER_TIMEOUT_504");

  virtualClock = 2_000_000;
  recorder.closeSession();

  const allForwards = recorder.getForwardRecords();
  assert.equal(allForwards.length, 4);

  const fwd30m = allForwards.find((f) => f.horizonSec === 1800);
  const fwd60m = allForwards.find((f) => f.horizonSec === 3600);

  assert.equal(fwd30m.outcomeStatus, "WINDOW_TRUNCATED");
  assert.equal(fwd30m.missingReason, "SESSION_CLOSED_BEFORE_HORIZON_ELAPSED");
  assert.equal(fwd60m.outcomeStatus, "WINDOW_TRUNCATED");
});

test("ProspectiveObservationRecorder — Duplicate Candidate Suppression", () => {
  const recorder = new ProspectiveObservationRecorder({
    sessionId: "shadow-test-04",
    configFingerprint: "sha256:fingerprint",
    suppressDuplicateCandidates: true,
  });

  const d1 = recorder.recordDecisionEvent(
    createMockDecisionInput({ mintAddress: "MINT_DUPLICATE_TEST" }),
  );
  assert.ok(d1);

  const d2 = recorder.recordDecisionEvent(
    createMockDecisionInput({ mintAddress: "MINT_DUPLICATE_TEST" }),
  );
  assert.equal(d2, null);

  assert.equal(recorder.getDecisionRecords().length, 1);
  const summary = recorder.generateSessionSummary();
  assert.equal(summary.duplicateCandidatesSuppressed, 1);
  assert.equal(summary.uniqueMintsCount, 1);
});

test("ProspectiveObservationRecorder — Verifiable Session Summary Generation & Segregated Stats", () => {
  const tmpDir = path.join(os.tmpdir(), `shadow-session-test-${Date.now()}`);
  const recorder = new ProspectiveObservationRecorder({
    sessionId: "shadow-test-05",
    configFingerprint: "sha256:testfingerprint",
    outputDir: tmpDir,
  });

  const c1 = recorder.recordDecisionEvent(
    createMockDecisionInput({
      mintAddress: "MINT_1111",
      strategyCohort: "ESTABLISHED_RUNNER",
      triggered: true,
      marketFeatures: {
        ...createMockDecisionInput().marketFeatures,
        indicativePriceSol: 0.00001,
      },
    }),
  );

  const c2 = recorder.recordDecisionEvent(
    createMockDecisionInput({
      mintAddress: "MINT_2222",
      strategyCohort: "MICRO_CAP_PROBE",
      triggered: false,
      rejectionReason: "REJECTED_DANGER_RISK",
      gateChecks: [
        { name: "RUGCHECK_SECURITY_GATE", passed: false, value: 850, requirement: "<= 700" },
      ],
      marketFeatures: {
        ...createMockDecisionInput().marketFeatures,
        indicativePriceSol: 0.000002,
      },
    }),
  );

  recorder.recordHorizonOutcome({
    decisionEventId: c1.decisionEventId,
    horizonSec: 300,
    indicativePriceSol: 0.000012,
    liquidityUsd: 80000,
    outcomeStatus: "OBSERVED_PRICE",
  });

  recorder.recordHorizonOutcome({
    decisionEventId: c2.decisionEventId,
    horizonSec: 300,
    indicativePriceSol: 0.000001,
    liquidityUsd: 10000,
    outcomeStatus: "OBSERVED_PRICE",
  });

  recorder.closeSession();

  const summary = recorder.generateSessionSummary();
  assert.equal(summary.totalCandidatesScreened, 2);
  assert.equal(summary.acceptedCandidatesCount, 1);
  assert.equal(summary.rejectedCandidatesCount, 1);
  assert.equal(summary.rejectionsByCategory.REJECTED_BY_RISK, 1);
  assert.equal(summary.candidatesByCohort.ESTABLISHED_RUNNER, 1);
  assert.equal(summary.candidatesByCohort.MICRO_CAP_PROBE, 1);

  const est5m = summary.cohortHorizonStats.established["300s"];
  assert.equal(est5m?.meanReturnPct, 20);
  assert.equal(est5m?.positiveReturnRatio, 1.0);

  const risk5m = summary.cohortHorizonStats.rejectedByRisk["300s"];
  assert.equal(risk5m?.meanReturnPct, -50);
  assert.equal(risk5m?.positiveReturnRatio, 0.0);

  assert.ok(fs.existsSync(path.join(tmpDir, "decision-observations.jsonl")));
  assert.ok(fs.existsSync(path.join(tmpDir, "forward-observations.jsonl")));
  assert.ok(fs.existsSync(path.join(tmpDir, "prospective-session-summary.json")));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
