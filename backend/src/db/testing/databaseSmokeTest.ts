import { createPaperDatabaseContext } from "../DatabaseFactory.js";
import { assertMigrationsApplied, runMigrations } from "../migrations.js";
import { createRepositories } from "../repositories/index.js";
import { parseJson } from "../utils/json.js";
import { seedPaperDatabase } from "../seeds/seedPaperDatabase.js";

function requireValue<T>(value: T | undefined, message: string): T {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

const context = createPaperDatabaseContext();

try {
  console.log(`DB SMOKE: opened PAPER database at ${context.path}`);
  runMigrations(context);
  assertMigrationsApplied(context);
  console.log("DB SMOKE: migrations verified");

  const result = seedPaperDatabase(context);
  const repos = createRepositories(context.db);
  const session = requireValue(
    repos.sessions.getSessionById(result.sessionId),
    "Session readback failed.",
  );
  const radar = requireValue(
    repos.tokenRadar.getRadarEntryById(result.radarTokenId),
    "Radar readback failed.",
  );
  const risk = requireValue(
    repos.riskAssessments.getLatestRiskAssessment(session.id, radar.mintAddress),
    "Risk readback failed.",
  );
  const decisions = repos.strategyDecisions.listDecisionsForMint(session.id, radar.mintAddress);
  const fills = repos.fills.listFillsForOrder(result.buyOrderId);
  const position = requireValue(
    repos.positions.getOpenPositionByMint(session.id, radar.mintAddress),
    "Position readback failed.",
  );
  const latestEquity = requireValue(
    repos.snapshots.getLatestEquitySnapshot(session.id),
    "Latest equity snapshot readback failed.",
  );
  const recentLogs = repos.systemLogs.listRecentLogs(5);
  const providerStatus = requireValue(
    repos.providerHealth.getLatestProviderStatus("seed-jupiter"),
    "Provider status readback failed.",
  );

  parseJson<string[]>(risk.riskFlagsJson);

  if (decisions.length === 0 || fills.length === 0 || recentLogs.length === 0) {
    throw new Error("Expected seeded decisions, fills, and logs to be readable.");
  }

  if (position.id !== result.positionId || latestEquity.id !== result.equitySnapshotId) {
    throw new Error("Seeded position or equity snapshot did not match readback IDs.");
  }

  if (providerStatus.id !== result.providerHealthId) {
    throw new Error("Provider health readback did not match seeded ID.");
  }

  console.log(`DB SMOKE: created session ${result.sessionId}`);
  console.log(
    "DB SMOKE: inserted radar/risk/decision/order/fill/position/snapshots/logs/provider health",
  );
  console.log("DB SMOKE: readback checks passed");
  console.log("DB SMOKE: success");
} finally {
  context.close();
}
