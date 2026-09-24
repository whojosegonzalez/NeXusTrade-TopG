import { describe, expect, it } from "vitest";

import type {
  RiskAssessmentRecord,
  StrategyDecisionRecord,
  TokenRadarRecord,
} from "../db/schema/index.js";
import { stringifyJson } from "../db/utils/json.js";
import { defaultStrategyConfig } from "./StrategyConfig.js";
import type { StrategyCandidate } from "./StrategyCandidateSelector.js";
import { StrategyScoringService } from "./StrategyScoringService.js";

describe("StrategyScoringService", () => {
  it("maps a high-scoring eligible candidate to BUY", () => {
    const result = new StrategyScoringService().evaluate({
      candidate: createCandidate(),
      config: defaultStrategyConfig(),
      duplicateBuyInCurrentRun: false,
      maxBuyCapReached: false,
    });

    expect(result).toMatchObject({
      score: 100,
      rawDecision: "BUY",
      decision: "BUY",
      buyEligible: true,
    });
  });

  it("maps eligible WARN risk to WATCH when score stays below BUY", () => {
    const result = new StrategyScoringService().evaluate({
      candidate: createCandidate({
        risk: {
          result: "WARN",
          score: 70,
          passed: false,
          riskFlagsJson: stringifyJson(["MISSING_AUTHORITY_EVIDENCE", "MISSING_QUOTE"]),
          rawProviderDataJson: stringifyJson({
            scoring: {
              facts: {
                pairAgeSeconds: 48 * 60 * 60,
              },
            },
          }),
        },
      }),
      config: defaultStrategyConfig(),
      duplicateBuyInCurrentRun: false,
      maxBuyCapReached: false,
    });

    expect(result).toMatchObject({
      score: 70,
      rawDecision: "WATCH",
      decision: "WATCH",
      buyEligible: true,
    });
  });

  it("allows explicit paper calibration threshold to map eligible WARN score 80 to BUY", () => {
    const result = new StrategyScoringService().evaluate({
      candidate: createCandidate({
        risk: {
          result: "WARN",
          score: 80,
          passed: false,
          riskFlagsJson: stringifyJson(["MISSING_AUTHORITY_EVIDENCE", "MISSING_QUOTE"]),
          rawProviderDataJson: stringifyJson({
            scoring: {
              facts: {
                pairAgeSeconds: 48 * 60 * 60,
                maxPriceImpactPct: 1,
              },
            },
          }),
        },
      }),
      config: {
        ...defaultStrategyConfig(),
        buyScoreThreshold: 75,
      },
      duplicateBuyInCurrentRun: false,
      maxBuyCapReached: false,
    });

    expect(result).toMatchObject({
      score: 80,
      rawDecision: "BUY",
      decision: "BUY",
      buyEligible: true,
    });
  });

  it("keeps ineligible candidates blocked even when the BUY threshold is lowered", () => {
    const result = new StrategyScoringService().evaluate({
      candidate: createCandidate({
        tokenRadar: {
          liquidityUsd: null,
        },
        risk: {
          liquidityUsd: null,
        },
      }),
      config: {
        ...defaultStrategyConfig(),
        buyScoreThreshold: 75,
      },
      duplicateBuyInCurrentRun: false,
      maxBuyCapReached: false,
    });

    expect(result.rawDecision).toBe("BUY");
    expect(result.decision).toBe("SKIP");
    expect(result.buyEligible).toBe(false);
    expect(result.reason).toContain("BUY_INELIGIBLE");
  });

  it("maps low-scoring candidates to SKIP", () => {
    const result = new StrategyScoringService().evaluate({
      candidate: createCandidate({
        tokenRadar: {
          liquidityUsd: "12000",
          volume1hUsd: "100",
          ageSeconds: 20 * 60,
        },
        risk: {
          liquidityUsd: "12000",
        },
      }),
      config: defaultStrategyConfig(),
      duplicateBuyInCurrentRun: false,
      maxBuyCapReached: false,
    });

    expect(result.score).toBeLessThan(70);
    expect(result.decision).toBe("SKIP");
  });

  it("downgrades duplicate and capped BUY decisions to WATCH", () => {
    const duplicate = new StrategyScoringService().evaluate({
      candidate: createCandidate({
        existingDecisions: [createDecision("BUY")],
      }),
      config: defaultStrategyConfig(),
      duplicateBuyInCurrentRun: false,
      maxBuyCapReached: false,
    });
    const capped = new StrategyScoringService().evaluate({
      candidate: createCandidate(),
      config: defaultStrategyConfig(),
      duplicateBuyInCurrentRun: false,
      maxBuyCapReached: true,
    });

    expect(duplicate).toMatchObject({
      rawDecision: "BUY",
      decision: "WATCH",
      duplicateBuyBlocked: true,
    });
    expect(duplicate.reason).toContain("DUPLICATE_BUY_PREVENTED");
    expect(capped).toMatchObject({
      rawDecision: "BUY",
      decision: "WATCH",
      maxBuyCapBlocked: true,
    });
    expect(capped.reason).toContain("MAX_BUY_DECISIONS_REACHED");
  });
});

function createCandidate(
  input: {
    readonly tokenRadar?: Partial<TokenRadarRecord>;
    readonly risk?: Partial<RiskAssessmentRecord>;
    readonly existingDecisions?: readonly StrategyDecisionRecord[];
  } = {},
): StrategyCandidate {
  const tokenRadar: TokenRadarRecord = {
    id: "radar_1",
    sessionId: "session_1",
    mintAddress: "Mint1111111111111111111111111111111111111111",
    symbol: "MINT",
    name: "Mint",
    pairAddress: "pair_1",
    source: "DEXSCREENER",
    firstSeenAtMs: 1,
    discoveredAtMs: 1,
    priceUsd: "0.01",
    priceSol: "0.00001",
    liquidityUsd: "60000",
    volume5mUsd: "10000",
    volume1hUsd: "80000",
    ageSeconds: 48 * 60 * 60,
    status: "WATCHING",
    notes: null,
    rawDataJson: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...input.tokenRadar,
  };
  const latestRiskAssessment: RiskAssessmentRecord = {
    id: "risk_1",
    sessionId: tokenRadar.sessionId,
    tokenRadarId: tokenRadar.id,
    mintAddress: tokenRadar.mintAddress,
    checkedAtMs: 1,
    score: 95,
    result: "PASS",
    passed: true,
    mintAuthorityDisabled: null,
    freezeAuthorityDisabled: null,
    tokenProgram: null,
    topHoldersPercent: null,
    liquidityUsd: "60000",
    riskFlagsJson: stringifyJson([]),
    rawProviderDataJson: stringifyJson({
      scoring: {
        facts: {
          pairAgeSeconds: 48 * 60 * 60,
          maxPriceImpactPct: 1,
        },
      },
    }),
    createdAtMs: 1,
    ...input.risk,
  };

  return {
    tokenRadar,
    latestRiskAssessment,
    existingDecisions: input.existingDecisions ?? [],
  };
}

function createDecision(decision: StrategyDecisionRecord["decision"]): StrategyDecisionRecord {
  return {
    id: "decision_1",
    sessionId: "session_1",
    mintAddress: "Mint1111111111111111111111111111111111111111",
    decidedAtMs: 1,
    decision,
    strategyName: "phase6_first_pass",
    score: 100,
    reason: "test",
    inputSnapshotJson: "{}",
    createdAtMs: 1,
  };
}
