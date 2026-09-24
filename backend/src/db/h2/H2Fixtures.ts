import { createRepositories } from "../repositories/RepositoryFactory.js";
import { createH2TestDatabase } from "./H2TestDatabase.js";

export function h2Fixture() {
  const fixture = createH2TestDatabase();
  const repositories = createRepositories(fixture.context.db);
  const session = repositories.sessions.createSession({
    id: "h2-session",
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs: 1_000,
    startingBalanceLamports: 1_000_000_000,
    currentCashLamports: 1_000_000_000,
    configSnapshotJson: "{}",
  });
  const radarInput = {
    sessionId: session.id,
    mintAddress: "So11111111111111111111111111111111111111112",
    source: "SYNTHETIC",
    firstSeenAtMs: 1_000,
    discoveredAtMs: 1_000,
    priceSol: "0.001",
    status: "APPROVED" as const,
  };
  const radar = repositories.tokenRadar.createRadarEntry(radarInput);
  const decision = repositories.strategyDecisions.createStrategyDecision({
    sessionId: session.id,
    mintAddress: radar.mintAddress,
    decidedAtMs: 1_000,
    decision: "BUY",
    strategyName: "synthetic",
    reason: "fixture",
  });
  return { ...fixture, repositories, session, radar, radarInput, decision };
}
