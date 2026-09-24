import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseContext } from "../connection.js";
import { createPaperDatabaseContext } from "../DatabaseFactory.js";
import { runMigrations } from "../migrations.js";
import { createRepositories } from "../repositories/index.js";
import { stringifyJson } from "../utils/json.js";
import { solToLamports } from "../utils/money.js";
import { nowMs } from "../utils/timestamps.js";

export interface PaperSeedResult {
  readonly sessionId: string;
  readonly radarTokenId: string;
  readonly rejectedRadarTokenId: string;
  readonly buyDecisionId: string;
  readonly buyOrderId: string;
  readonly buyFillId: string;
  readonly positionId: string;
  readonly equitySnapshotId: string;
  readonly providerHealthId: string;
}

export function seedPaperDatabase(context: DatabaseContext): PaperSeedResult {
  const repos = createRepositories(context.db);
  const timestamp = nowMs();
  const fakeMint = "Fake111111111111111111111111111111111111111";
  const rejectedMint = "Reject111111111111111111111111111111111111";

  const session = repos.sessions.createSession({
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: timestamp,
    startingBalanceLamports: solToLamports("2"),
    currentCashLamports: solToLamports("1.8995"),
    targetProfitLamports: solToLamports("0.1"),
    targetProfitBps: 500,
    maxDrawdownLamports: solToLamports("0.2"),
    configSnapshotJson: stringifyJson({
      seed: "phase-2-paper",
      mode: "PAPER",
      allocationSol: "0.10",
    }),
  });

  const radarToken = repos.tokenRadar.createRadarEntry({
    sessionId: session.id,
    mintAddress: fakeMint,
    symbol: "FAKE1",
    name: "Fake Momentum Token",
    pairAddress: "PairFake111111111111111111111111111111111111",
    source: "phase2_seed",
    firstSeenAtMs: timestamp - 30_000,
    discoveredAtMs: timestamp,
    priceUsd: "0.00042",
    priceSol: "0.0000021",
    liquidityUsd: "12000",
    volume5mUsd: "1800",
    volume1hUsd: "12500",
    ageSeconds: 900,
    status: "APPROVED",
    rawDataJson: stringifyJson({
      provider: "seed",
      quoteQuality: "good",
    }),
  });

  const rejectedRadarToken = repos.tokenRadar.createRadarEntry({
    sessionId: session.id,
    mintAddress: rejectedMint,
    symbol: "NOPE",
    name: "Rejected Seed Token",
    pairAddress: "PairReject1111111111111111111111111111111111",
    source: "phase2_seed",
    firstSeenAtMs: timestamp - 20_000,
    discoveredAtMs: timestamp,
    liquidityUsd: "500",
    status: "REJECTED",
    notes: "Seeded low-liquidity rejection.",
    rawDataJson: stringifyJson({
      provider: "seed",
      quoteQuality: "poor",
    }),
  });

  repos.riskAssessments.createRiskAssessment({
    sessionId: session.id,
    tokenRadarId: radarToken.id,
    mintAddress: fakeMint,
    checkedAtMs: timestamp + 1_000,
    score: 82,
    result: "PASS",
    passed: true,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    tokenProgram: "spl-token",
    topHoldersPercent: "18.5",
    liquidityUsd: "12000",
    riskFlagsJson: stringifyJson(["mint_authority_disabled", "liquidity_ok"]),
    rawProviderDataJson: stringifyJson({
      provider: "seed-risk",
      evidence: "synthetic pass",
    }),
  });

  repos.riskAssessments.createRiskAssessment({
    sessionId: session.id,
    tokenRadarId: rejectedRadarToken.id,
    mintAddress: rejectedMint,
    checkedAtMs: timestamp + 1_500,
    score: 18,
    result: "FAIL",
    passed: false,
    mintAuthorityDisabled: false,
    freezeAuthorityDisabled: null,
    tokenProgram: "spl-token",
    topHoldersPercent: "72.4",
    liquidityUsd: "500",
    riskFlagsJson: stringifyJson(["low_liquidity", "holder_concentration"]),
    rawProviderDataJson: stringifyJson({
      provider: "seed-risk",
      evidence: "synthetic fail",
    }),
  });

  const buyDecision = repos.strategyDecisions.createStrategyDecision({
    sessionId: session.id,
    mintAddress: fakeMint,
    decidedAtMs: timestamp + 2_000,
    decision: "BUY",
    strategyName: "phase2_seed_strategy",
    score: 91,
    reason: "Seed scenario passed risk and momentum checks.",
    inputSnapshotJson: stringifyJson({
      riskScore: 82,
      liquidityUsd: "12000",
      volume5mUsd: "1800",
    }),
  });

  const buyOrder = repos.orders.createOrder({
    sessionId: session.id,
    mode: "PAPER",
    side: "BUY",
    mintAddress: fakeMint,
    status: "FILLED",
    requestedSolLamports: solToLamports("0.1"),
    quoteSource: "seed-jupiter",
    quoteId: "seed-quote-001",
    strategyDecisionId: buyDecision.id,
    reason: "Seeded paper buy order.",
    rawOrderJson: stringifyJson({
      slippageBps: 75,
      quoteSource: "seed-jupiter",
    }),
  });

  const buyFill = repos.fills.createFill({
    orderId: buyOrder.id,
    sessionId: session.id,
    filledAtMs: timestamp + 3_000,
    fillPriceSol: "0.0000021",
    fillPriceUsd: "0.00042",
    tokensFilled: "47619.047619",
    solSpentLamports: solToLamports("0.1"),
    estimatedBaseFeeLamports: 5_000,
    estimatedPriorityFeeLamports: 25_000,
    estimatedSlippageLamports: 470_000,
    priceImpactBps: 42,
    quoteSource: "seed-jupiter",
    rawQuoteJson: stringifyJson({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: fakeMint,
      priceImpactBps: 42,
    }),
  });

  const position = repos.positions.openPosition({
    sessionId: session.id,
    mintAddress: fakeMint,
    status: "OPEN",
    openedAtMs: timestamp + 3_500,
    avgEntryPriceSol: "0.0000021",
    tokensHeld: "47619.047619",
    costBasisLamports: solToLamports("0.1"),
    feesPaidLamports: 500_000,
  });

  repos.snapshots.createPositionSnapshot({
    positionId: position.id,
    sessionId: session.id,
    timestampMs: timestamp + 4_000,
    markPriceSol: "0.00000212",
    sellQuoteLamports: 100_650_000,
    unrealizedPnlLamports: 150_000,
    unrealizedPnlBps: 15,
    liquidityUsd: "12150",
    rawQuoteJson: stringifyJson({
      source: "seed-jupiter",
      quoteLamports: 100_650_000,
    }),
  });

  const equitySnapshot = repos.snapshots.createEquitySnapshot({
    sessionId: session.id,
    timestampMs: timestamp + 4_500,
    cashLamports: solToLamports("1.8995"),
    openPositionValueLamports: 100_650_000,
    totalEquityLamports: 2_000_150_000,
    realizedPnlLamports: 0,
    unrealizedPnlLamports: 150_000,
    drawdownLamports: 0,
  });

  const providerHealth = repos.providerHealth.createProviderHealth({
    sessionId: session.id,
    provider: "seed-jupiter",
    timestampMs: timestamp + 5_000,
    status: "OK",
    latencyMs: 120,
    rateLimited: false,
    creditsUsed: 0,
    contextJson: stringifyJson({
      operation: "quote",
      source: "seed",
    }),
  });

  repos.systemLogs.createLog({
    sessionId: session.id,
    timestampMs: timestamp + 5_500,
    level: "INFO",
    scope: "DB",
    message: "Seeded paper database scenario.",
    contextJson: stringifyJson({
      sessionId: session.id,
    }),
  });

  repos.systemLogs.createLog({
    sessionId: session.id,
    timestampMs: timestamp + 6_000,
    level: "INFO",
    scope: "SESSION",
    message: "Paper seed session is ready for readback checks.",
  });

  return {
    sessionId: session.id,
    radarTokenId: radarToken.id,
    rejectedRadarTokenId: rejectedRadarToken.id,
    buyDecisionId: buyDecision.id,
    buyOrderId: buyOrder.id,
    buyFillId: buyFill.id,
    positionId: position.id,
    equitySnapshotId: equitySnapshot.id,
    providerHealthId: providerHealth.id,
  };
}

function isDirectRun(): boolean {
  const entryPoint = process.argv[1];

  return entryPoint !== undefined && path.resolve(entryPoint) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const context = createPaperDatabaseContext();

  try {
    runMigrations(context);
    const result = seedPaperDatabase(context);
    console.log(`DB SEED: created paper seed session ${result.sessionId}`);
  } finally {
    context.close();
  }
}
