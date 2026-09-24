import { afterEach, describe, expect, it } from "vitest";

import {
  parseTokenMintAddress,
  providerSuccess,
  type ProviderResult,
  type TokenEnrichmentSnapshot,
} from "@nexustrade/shared";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories, type Repositories } from "../db/repositories/index.js";
import type { TokenEnrichmentRequest } from "../providers/MarketDataService.js";
import type { QuoteBudgetPlannerConfig } from "../providers/config/providerConfig.js";
import { parseJson } from "../db/utils/json.js";
import { defaultRiskConfig, type RiskRuntimeConfig } from "./RiskConfig.js";
import { RiskRunner } from "./RiskRunner.js";

const TOKEN_MINT = parseTokenMintAddress("Fake111111111111111111111111111111111111111");
const SOL_MINT = parseTokenMintAddress("So11111111111111111111111111111111111111112");
const now = new Date();
let testDb: TestDatabaseContext | undefined;

describe("RiskRunner", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("writes RiskAssessment records, updates TokenRadar safely, and creates no trading records", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const radar = repositories.tokenRadar.createRadarEntry({
      sessionId: session.id,
      mintAddress: TOKEN_MINT,
      source: "DEXSCREENER",
      pairAddress: "pair_1",
      firstSeenAtMs: now.getTime() - 60 * 60 * 1000,
      discoveredAtMs: now.getTime(),
      status: "DISCOVERED",
      notes: "scanner note",
    });
    const result = await createRunner(repositories).runOnce();
    const risk = repositories.riskAssessments.getLatestRiskAssessment(session.id, TOKEN_MINT);
    const updatedRadar = repositories.tokenRadar.getRadarEntryById(radar.id);

    expect(result).toMatchObject({
      selectedCount: 1,
      evaluatedCount: 1,
      writtenCount: 1,
      warnCount: 1,
      failCount: 0,
      errorCount: 0,
    });
    expect(risk?.result).toBe("WARN");
    expect(risk?.score).toBe(80);
    expect(risk?.mintAuthorityDisabled).toBeNull();
    expect(risk?.freezeAuthorityDisabled).toBeNull();
    expect(updatedRadar?.status).toBe("WATCHING");
    expect(updatedRadar?.notes).toContain("scanner note");
    expect(updatedRadar?.notes).toContain("Risk WARN");
    assertRiskSafetyBoundaries(repositories, session.id);
  });

  it("skips RiskAssessment and TokenRadar writes in dry-run mode", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);

    repositories.tokenRadar.createRadarEntry({
      sessionId: session.id,
      mintAddress: TOKEN_MINT,
      source: "DEXSCREENER",
      firstSeenAtMs: now.getTime() - 60 * 60 * 1000,
      discoveredAtMs: now.getTime(),
      status: "DISCOVERED",
    });

    const result = await createRunner(repositories, { dryRun: true }).runOnce();

    expect(result.evaluatedCount).toBe(1);
    expect(result.writtenCount).toBe(0);
    expect(repositories.riskAssessments.listRiskAssessments(session.id)).toHaveLength(0);
    expect(repositories.tokenRadar.listRadarEntries(session.id)[0]?.status).toBe("DISCOVERED");
    assertRiskSafetyBoundaries(repositories, session.id);
  });

  it("records local quote-budget non-selection without requesting router quotes", async () => {
    const repositories = setupRepositories();
    const session = createSession(repositories);
    const selectedMint = SOL_MINT;
    const unselectedMint = parseTokenMintAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const requests: TokenEnrichmentRequest[] = [];

    repositories.tokenRadar.createRadarEntry({
      sessionId: session.id,
      mintAddress: selectedMint,
      source: "DEXSCREENER",
      pairAddress: "pair_selected",
      firstSeenAtMs: now.getTime() - 60 * 60 * 1000,
      discoveredAtMs: now.getTime(),
      liquidityUsd: "20000",
      volume1hUsd: "5000",
      ageSeconds: 3600,
      priceSol: "0.00001",
      status: "DISCOVERED",
    });
    repositories.tokenRadar.createRadarEntry({
      sessionId: session.id,
      mintAddress: unselectedMint,
      source: "DEXSCREENER",
      pairAddress: "pair_unselected",
      firstSeenAtMs: now.getTime() - 2 * 60 * 60 * 1000,
      discoveredAtMs: now.getTime() - 2 * 60 * 60 * 1000,
      liquidityUsd: "100",
      status: "DISCOVERED",
    });

    const result = await new RiskRunner({
      repositories,
      config: { ...defaultRiskConfig(), limit: 10 },
      quoteBudgetPlannerConfig: quoteBudgetPlannerConfig,
      marketDataService: {
        enrichToken: async (request) => {
          requests.push(request);
          return providerSuccess({
            provider: "MOCK",
            data: createEnrichment(Boolean(request.sellQuoteRequest)),
            fetchedAt: now,
          });
        },
      },
    }).runOnce();
    const unselectedRisk = repositories.riskAssessments.getLatestRiskAssessment(
      session.id,
      unselectedMint,
    );
    const rawEvidence = parseJson(unselectedRisk?.rawProviderDataJson ?? "{}") as {
      quoteBudget?: { selectionReason?: string; selected?: boolean };
    };

    expect(result).toMatchObject({
      quoteBudgetEnabled: true,
      quoteBudgetSelectedCount: 1,
      quoteBudgetNotSelectedCount: 1,
    });
    expect(requests).toHaveLength(3);
    expect(requests.filter((request) => request.buyQuoteRequest)).toHaveLength(1);
    expect(requests.filter((request) => request.sellQuoteRequest)).toHaveLength(1);
    expect(
      requests.some((request) => request.mintAddress === unselectedMint && request.buyQuoteRequest),
    ).toBe(false);
    expect(rawEvidence.quoteBudget).toMatchObject({
      selectionReason: "QUOTE_BUDGET_NOT_SELECTED",
      selected: false,
    });
    assertRiskSafetyBoundaries(repositories, session.id);
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createSession(repositories: Repositories) {
  return repositories.sessions.createSession({
    id: "session_risk",
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: now.getTime(),
    startingBalanceLamports: 0,
    currentCashLamports: 0,
    configSnapshotJson: "{}",
  });
}

function createRunner(
  repositories: Repositories,
  config: Partial<RiskRuntimeConfig> = {},
): RiskRunner {
  return new RiskRunner({
    repositories,
    config: {
      ...defaultRiskConfig(),
      ...config,
    },
    marketDataService: {
      enrichToken: async (
        request: TokenEnrichmentRequest,
      ): Promise<ProviderResult<TokenEnrichmentSnapshot>> =>
        providerSuccess({
          provider: "MOCK",
          data: createEnrichment(Boolean(request.sellQuoteRequest)),
          fetchedAt: now,
        }),
    },
  });
}

function createEnrichment(includeSellQuote: boolean): TokenEnrichmentSnapshot {
  return {
    identity: {
      chainId: "solana",
      mintAddress: TOKEN_MINT,
      symbol: "FAKE",
      tokenProgram: "spl-token",
    },
    bestPair: {
      chainId: "solana",
      dexId: "raydium",
      pairAddress: "pair_1",
      baseMint: TOKEN_MINT,
      quoteMint: SOL_MINT,
      source: "DEXSCREENER",
      fetchedAt: now,
      liquidityUsd: 20_000,
      pairCreatedAt: new Date(now.getTime() - 60 * 60 * 1000),
    },
    riskEvidence: {
      mintAddress: TOKEN_MINT,
      source: "HELIUS",
      fetchedAt: now,
      flags: ["mint_authority_absent_or_unknown", "freeze_authority_absent_or_unknown"],
      mintAuthorityRisk: "UNKNOWN",
      freezeAuthorityRisk: "UNKNOWN",
    },
    buyQuote: {
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
      inputAmountRaw: "10000000",
      outputAmountRaw: "1000000",
      estimatedPriceImpactPct: 1,
      source: "JUPITER",
      fetchedAt: now,
    },
    ...(includeSellQuote
      ? {
          sellQuote: {
            inputMint: TOKEN_MINT,
            outputMint: SOL_MINT,
            inputAmountRaw: "1000000",
            outputAmountRaw: "9000000",
            estimatedPriceImpactPct: 1,
            source: "JUPITER" as const,
            fetchedAt: now,
          },
        }
      : {}),
    sourcesUsed: ["DEXSCREENER", "JUPITER", "HELIUS"],
    warnings: [],
    fetchedAt: now,
  };
}

function assertRiskSafetyBoundaries(repositories: Repositories, sessionId: string): void {
  expect(repositories.strategyDecisions.listStrategyDecisions(sessionId)).toHaveLength(0);
  expect(repositories.orders.listOrders(sessionId)).toHaveLength(0);
  expect(repositories.fills.listFillsForSession(sessionId)).toHaveLength(0);
  expect(repositories.positions.listOpenPositions(sessionId)).toHaveLength(0);
  expect(repositories.positions.listClosedPositions(sessionId)).toHaveLength(0);
}

const quoteBudgetPlannerConfig: QuoteBudgetPlannerConfig = {
  enabled: true,
  maxCandidatesPerCycle: 1,
  recencyWeight: 4,
  liquidityWeight: 3,
  volumeWeight: 3,
  ageWeight: 2,
  priorEvidenceWeight: 2,
};
