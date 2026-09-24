import { afterEach, describe, expect, it } from "vitest";

import type { TestDatabaseContext } from "../db/testing/createTestDatabase.js";
import { createTestDatabase } from "../db/testing/createTestDatabase.js";
import { createRepositories, type Repositories } from "../db/repositories/index.js";
import { defaultRiskConfig } from "./RiskConfig.js";
import { RiskCandidateSelector } from "./RiskCandidateSelector.js";

const nowMs = new Date("2026-06-21T12:00:00.000Z").getTime();
let testDb: TestDatabaseContext | undefined;

describe("RiskCandidateSelector", () => {
  afterEach(() => {
    testDb?.cleanup();
    testDb = undefined;
  });

  it("uses the latest RUNNING PAPER session with eligible TokenRadar candidates", () => {
    const repositories = setupRepositories();
    const older = createSession(repositories, "older", nowMs - 10_000);
    const latest = createSession(repositories, "latest", nowMs);

    createRadar(repositories, older.id, "DISCOVERED", nowMs);
    createRadar(repositories, latest.id, "WATCHING", nowMs);

    const selection = new RiskCandidateSelector(repositories).selectCandidates(
      defaultRiskConfig(),
      nowMs,
    );

    expect(selection.session.id).toBe(latest.id);
    expect(selection.candidates).toHaveLength(1);
  });

  it("does not auto-create a session when no eligible scanner output exists", () => {
    const repositories = setupRepositories();

    createSession(repositories, "empty", nowMs);

    expect(() =>
      new RiskCandidateSelector(repositories).selectCandidates(defaultRiskConfig(), nowMs),
    ).toThrow(/No RUNNING PAPER session/);
    expect(repositories.sessions.listSessions()).toHaveLength(1);
  });

  it("filters candidates by status and recency", () => {
    const repositories = setupRepositories();
    const session = createSession(repositories, "session", nowMs);

    createRadar(repositories, session.id, "DISCOVERED", nowMs - 60 * 60 * 1000);
    createRadar(repositories, session.id, "REJECTED", nowMs);
    createRadar(repositories, session.id, "DISCOVERED", nowMs - 48 * 60 * 60 * 1000);

    const selection = new RiskCandidateSelector(repositories).selectCandidates(
      defaultRiskConfig(),
      nowMs,
    );

    expect(selection.candidates).toHaveLength(1);
    expect(selection.candidates[0]?.status).toBe("DISCOVERED");
  });
});

function setupRepositories(): Repositories {
  testDb = createTestDatabase();
  return createRepositories(testDb.context.db);
}

function createSession(repositories: Repositories, suffix: string, startedAtMs: number) {
  return repositories.sessions.createSession({
    id: `session_${suffix}`,
    mode: "PAPER",
    status: "RUNNING",
    startedAtMs,
    startingBalanceLamports: 0,
    currentCashLamports: 0,
    configSnapshotJson: "{}",
  });
}

function createRadar(
  repositories: Repositories,
  sessionId: string,
  status: "DISCOVERED" | "WATCHING" | "REJECTED",
  discoveredAtMs: number,
) {
  return repositories.tokenRadar.createRadarEntry({
    sessionId,
    mintAddress: `Fake${discoveredAtMs}1111111111111111111111111111`.slice(0, 44),
    source: "DEXSCREENER",
    firstSeenAtMs: discoveredAtMs,
    discoveredAtMs,
    status,
  });
}
