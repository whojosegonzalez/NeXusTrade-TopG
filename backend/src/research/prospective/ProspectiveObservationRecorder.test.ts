import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProspectiveObservationRecorder,
  type RecordDecisionInput,
} from "./ProspectiveObservationRecorder.js";

function createMockDecisionInput(
  overrides: Partial<RecordDecisionInput> = {},
): RecordDecisionInput {
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

describe("ProspectiveObservationRecorder", () => {
  it("enforces immutability of decision records", () => {
    const recorder = new ProspectiveObservationRecorder({
      sessionId: "shadow-test-01",
      configFingerprint: "sha256:abc123config",
    });

    const record = recorder.recordDecisionEvent(createMockDecisionInput());
    expect(record).toBeDefined();
    expect(record?.gateOutcome.decision).toBe("ACCEPTED_ARMED");

    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record?.marketFeatures)).toBe(true);
    expect(Object.isFrozen(record?.gateOutcome)).toBe(true);

    expect(() => {
      // @ts-expect-error mutating frozen object
      record.symbol = "TAMPERED";
    }).toThrow();

    expect(() => {
      // @ts-expect-error mutating frozen object
      record.marketFeatures.indicativePriceSol = 999;
    }).toThrow();
  });

  it("classifies rejection categories strictly", () => {
    expect(
      ProspectiveObservationRecorder.categorizeRejection("REJECTED_DANGER_RISK", [
        "RUGCHECK_SECURITY_GATE",
      ]),
    ).toBe("REJECTED_BY_RISK");

    expect(
      ProspectiveObservationRecorder.categorizeRejection(undefined, ["BUNDLER_CONCENTRATION_GATE"]),
    ).toBe("REJECTED_BY_RISK");

    expect(
      ProspectiveObservationRecorder.categorizeRejection("REJECTED_ESTABLISHED_MACRO_DOWNTREND", [
        "ESTABLISHED_MACRO_TREND_GATE",
      ]),
    ).toBe("REJECTED_BY_RISK");

    expect(
      ProspectiveObservationRecorder.categorizeRejection("GATE_FAIL_LIQUIDITY", [
        "MIN_LIQUIDITY_GATE",
      ]),
    ).toBe("REJECTED_BY_ELIGIBILITY");

    expect(
      ProspectiveObservationRecorder.categorizeRejection("GATE_FAIL_MATURITY", [
        "MATURITY_WINDOW_GATE",
      ]),
    ).toBe("REJECTED_BY_ELIGIBILITY");

    expect(
      ProspectiveObservationRecorder.categorizeRejection(undefined, ["FLOW_ABSORPTION_GATE"]),
    ).toBe("REJECTED_BY_ELIGIBILITY");

    expect(ProspectiveObservationRecorder.categorizeRejection("MISSING_PRICE_DATA", [])).toBe(
      "REJECTED_BY_MISSING_DATA",
    );

    expect(
      ProspectiveObservationRecorder.categorizeRejection(undefined, ["UNAVAILABLE_RUGCHECK"]),
    ).toBe("REJECTED_BY_MISSING_DATA");

    expect(
      ProspectiveObservationRecorder.categorizeRejection("MAX_OPEN_POSITIONS_REACHED", []),
    ).toBe("REJECTED_BY_CAPACITY");
  });

  it("guarantees causality & prevents forward horizon backfilling", () => {
    let virtualClock = 1_000_000;
    const recorder = new ProspectiveObservationRecorder({
      sessionId: "shadow-test-02",
      configFingerprint: "sha256:fingerprint",
      clock: () => virtualClock,
    });

    const baseline = recorder.recordDecisionEvent(createMockDecisionInput())!;
    const baselineId = baseline.decisionEventId;

    // Verify baseline does NOT contain forward horizons
    // @ts-expect-error verifying non-existence of forward fields
    expect(baseline.forwardHorizons).toBeUndefined();

    // Advance clock to +5m (300s = 300,000 ms -> scheduledDue = 1_000_010 + 300_000 = 1_300_010 ms)
    virtualClock = 1_300_015;
    const fwd5m = recorder.recordHorizonOutcome({
      decisionEventId: baselineId,
      horizonSec: 300,
      indicativePriceSol: 0.000006, // +20% gain
      liquidityUsd: 70000,
      outcomeStatus: "OBSERVED_PRICE",
    });

    expect(fwd5m.decisionEventId).toBe(baselineId);
    expect(fwd5m.horizonSec).toBe(300);
    expect(fwd5m.priceReturnPct).toBe(20);
    expect(fwd5m.observationLatencyMs).toBe(5);

    // Verify original baseline decision record was NOT modified
    const storedBaseline = recorder
      .getDecisionRecords()
      .find((d) => d.decisionEventId === baselineId)!;
    expect(storedBaseline.marketFeatures.indicativePriceSol).toBe(0.000005);
    // @ts-expect-error verifying immutability
    expect(storedBaseline.priceReturnPct).toBeUndefined();
  });

  it("handles missing observations & window truncation cleanly", () => {
    let virtualClock = 1_000_000;
    const recorder = new ProspectiveObservationRecorder({
      sessionId: "shadow-test-03",
      configFingerprint: "sha256:fingerprint",
      clock: () => virtualClock,
    });

    const baseline = recorder.recordDecisionEvent(createMockDecisionInput())!;

    virtualClock = 1_300_000;
    recorder.recordHorizonOutcome({
      decisionEventId: baseline.decisionEventId,
      horizonSec: 300,
      indicativePriceSol: 0.0000045, // -10%
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

    expect(fwd15m.outcomeStatus).toBe("MISSING_QUOTE_UNAVAILABLE");
    expect(fwd15m.indicativePriceSol).toBeNull();
    expect(fwd15m.priceReturnPct).toBeNull();
    expect(fwd15m.missingReason).toBe("DEXSCREENER_TIMEOUT_504");

    virtualClock = 2_000_000;
    recorder.closeSession();

    const allForwards = recorder.getForwardRecords();
    expect(allForwards.length).toBe(4);

    const fwd30m = allForwards.find((f) => f.horizonSec === 1800)!;
    const fwd60m = allForwards.find((f) => f.horizonSec === 3600)!;

    expect(fwd30m.outcomeStatus).toBe("WINDOW_TRUNCATED");
    expect(fwd30m.missingReason).toBe("SESSION_CLOSED_BEFORE_HORIZON_ELAPSED");
    expect(fwd60m.outcomeStatus).toBe("WINDOW_TRUNCATED");
  });

  it("suppresses duplicate candidates during intake", () => {
    const recorder = new ProspectiveObservationRecorder({
      sessionId: "shadow-test-04",
      configFingerprint: "sha256:fingerprint",
      suppressDuplicateCandidates: true,
    });

    const d1 = recorder.recordDecisionEvent(
      createMockDecisionInput({ mintAddress: "MINT_DUPLICATE_TEST" }),
    );
    expect(d1).toBeDefined();

    const d2 = recorder.recordDecisionEvent(
      createMockDecisionInput({ mintAddress: "MINT_DUPLICATE_TEST" }),
    );
    expect(d2).toBeNull();

    expect(recorder.getDecisionRecords().length).toBe(1);
    const summary = recorder.generateSessionSummary();
    expect(summary.duplicateCandidatesSuppressed).toBe(1);
    expect(summary.uniqueMintsCount).toBe(1);
  });

  it("generates verifiable session summaries with segregated stats", () => {
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
    )!;

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
    )!;

    recorder.recordHorizonOutcome({
      decisionEventId: c1.decisionEventId,
      horizonSec: 300,
      indicativePriceSol: 0.000012, // +20%
      liquidityUsd: 80000,
      outcomeStatus: "OBSERVED_PRICE",
    });

    recorder.recordHorizonOutcome({
      decisionEventId: c2.decisionEventId,
      horizonSec: 300,
      indicativePriceSol: 0.000001, // -50% (risk dump)
      liquidityUsd: 10000,
      outcomeStatus: "OBSERVED_PRICE",
    });

    recorder.closeSession();

    const summary = recorder.generateSessionSummary();
    expect(summary.totalCandidatesScreened).toBe(2);
    expect(summary.acceptedCandidatesCount).toBe(1);
    expect(summary.rejectedCandidatesCount).toBe(1);
    expect(summary.rejectionsByCategory.REJECTED_BY_RISK).toBe(1);
    expect(summary.candidatesByCohort.ESTABLISHED_RUNNER).toBe(1);
    expect(summary.candidatesByCohort.MICRO_CAP_PROBE).toBe(1);

    const est5m = summary.cohortHorizonStats.established["300s"];
    expect(est5m?.meanReturnPct).toBe(20);
    expect(est5m?.positiveReturnRatio).toBe(1.0);

    const risk5m = summary.cohortHorizonStats.rejectedByRisk["300s"];
    expect(risk5m?.meanReturnPct).toBe(-50);
    expect(risk5m?.positiveReturnRatio).toBe(0.0);

    expect(fs.existsSync(path.join(tmpDir, "decision-observations.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "forward-observations.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "prospective-session-summary.json"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
