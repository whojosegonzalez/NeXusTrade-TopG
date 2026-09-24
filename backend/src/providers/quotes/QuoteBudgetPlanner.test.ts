import { describe, expect, it } from "vitest";

import type { QuoteBudgetPlannerConfig } from "../config/providerConfig.js";
import { QuoteBudgetPlanner, type QuoteBudgetCandidate } from "./QuoteBudgetPlanner.js";

const nowMs = 1_800_000_000_000;

const config: QuoteBudgetPlannerConfig = {
  enabled: true,
  maxCandidatesPerCycle: 2,
  recencyWeight: 4,
  liquidityWeight: 3,
  volumeWeight: 3,
  ageWeight: 2,
  priorEvidenceWeight: 2,
};

describe("QuoteBudgetPlanner", () => {
  it("selects exactly the configured limit with transparent, deterministic ordering", () => {
    const planner = new QuoteBudgetPlanner(config);
    const candidates = [
      candidate("mint_c", { discoveredAtMs: nowMs - 10 * 60_000, liquidityUsd: "20000" }),
      candidate("mint_a", {
        discoveredAtMs: nowMs - 5 * 60_000,
        liquidityUsd: "30000",
        volume1hUsd: "5000",
        ageSeconds: 3600,
        priorRiskResult: "PASS",
      }),
      candidate("mint_b", {
        discoveredAtMs: nowMs - 8 * 60_000,
        liquidityUsd: "25000",
        volume1hUsd: "5000",
        ageSeconds: 3600,
      }),
    ];

    const plan = planner.plan(candidates, nowMs);

    expect(plan).toMatchObject({
      enabled: true,
      candidateCount: 3,
      selectedCount: 2,
      notSelectedCount: 1,
      limit: 2,
    });
    expect(plan.entriesByCandidateKey.get("mint_a")).toMatchObject({
      selected: true,
      selectionReason: "SELECTED",
      rank: 1,
    });
    expect(plan.entriesByCandidateKey.get("mint_b")).toMatchObject({
      selected: true,
      selectionReason: "SELECTED",
      rank: 2,
    });
    expect(plan.entriesByCandidateKey.get("mint_c")).toMatchObject({
      selected: false,
      selectionReason: "QUOTE_BUDGET_NOT_SELECTED",
      rank: 3,
    });
  });

  it("uses lexical mint ordering only after the documented numeric tie-breakers", () => {
    const planner = new QuoteBudgetPlanner({ ...config, maxCandidatesPerCycle: 1 });
    const candidates = [candidate("mint_z"), candidate("mint_a")];

    const plan = planner.plan(candidates, nowMs);

    expect(plan.entriesByCandidateKey.get("mint_a")?.rank).toBe(1);
    expect(plan.entriesByCandidateKey.get("mint_z")?.rank).toBe(2);
  });

  it("applies the limit to radar rows even when they share a mint", () => {
    const planner = new QuoteBudgetPlanner({ ...config, maxCandidatesPerCycle: 1 });
    const plan = planner.plan(
      [
        candidate("mint_shared", { candidateKey: "radar_pair_a" }),
        candidate("mint_shared", { candidateKey: "radar_pair_b" }),
      ],
      nowMs,
    );

    expect(plan.selectedCount).toBe(1);
    expect([...plan.entriesByCandidateKey.values()].filter((entry) => entry.selected)).toHaveLength(
      1,
    );
  });

  it("preserves pre-allocation behavior when disabled", () => {
    const planner = new QuoteBudgetPlanner({ ...config, enabled: false, maxCandidatesPerCycle: 1 });
    const plan = planner.plan([candidate("mint_a"), candidate("mint_b")], nowMs);

    expect(plan).toMatchObject({
      enabled: false,
      selectedCount: 2,
      notSelectedCount: 0,
      limit: 2,
    });
    expect(plan.entriesByCandidateKey.get("mint_a")?.selectionReason).toBe("QUOTE_BUDGET_DISABLED");
  });
});

function candidate(
  mintAddress: string,
  overrides: Partial<QuoteBudgetCandidate> = {},
): QuoteBudgetCandidate {
  return {
    candidateKey: mintAddress,
    mintAddress,
    discoveredAtMs: nowMs - 3 * 60 * 60_000,
    liquidityUsd: "0",
    volume1hUsd: "0",
    ageSeconds: 0,
    priceSol: "0.000001",
    priceUsd: "0.01",
    pairAddress: "pair",
    status: "DISCOVERED",
    ...overrides,
  };
}
