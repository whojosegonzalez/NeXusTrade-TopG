import { describe, expect, it } from "vitest";

import { defaultShadowEntryConfig } from "./ShadowEntryConfig.js";
import {
  buildDefaultEntryProfiles,
  candidateMatchesProfile,
  selectCandidatesForTiming,
} from "./ShadowEntryProfile.js";
import type { ShadowEntryCandidate } from "./ShadowEntryTypes.js";

describe("ShadowEntryProfile", () => {
  it("builds profile presets from declarative dimensions", () => {
    const profiles = buildDefaultEntryProfiles(defaultShadowEntryConfig());

    expect(profiles.map((profile) => profile.id)).toEqual([
      "P001",
      "P002",
      "P003",
      "P004",
      "P005",
      "P006",
      "P007",
      "P008",
      "P009",
      "P010",
      "P011",
    ]);
    expect(profiles.find((profile) => profile.id === "P001")).toMatchObject({
      profileVersion: "v1",
      profileKey: "P001@v1",
      name: "baseline_raw_buy",
      readonlyBaseline: true,
      confirmationRequired: false,
      decisions: ["BUY"],
    });
    expect(profiles.find((profile) => profile.id === "P006")).toMatchObject({
      name: "recovery_after_drawdown",
      recoveryOnly: true,
      earlyDrawdownModes: ["require_recovery"],
    });
    expect(profiles.find((profile) => profile.id === "P009")).toMatchObject({
      name: "score65_79_confirmed",
      profileKey: "P009@v1",
      maxScore: 79,
      decisions: ["BUY", "WATCH"],
    });
  });

  it("selects baseline, duplicate attention, and score-55 research candidates", () => {
    const profiles = buildDefaultEntryProfiles(defaultShadowEntryConfig());
    const baseline = mustFindProfile(profiles, "P001");
    const duplicate = mustFindProfile(profiles, "P003");
    const score55 = mustFindProfile(profiles, "P004");
    const watchConfirmed = mustFindProfile(profiles, "P007");
    const score65Band = mustFindProfile(profiles, "P009");

    expect(candidateMatchesProfile(candidate({ decision: "BUY", score: 65 }), baseline)).toBe(true);
    expect(candidateMatchesProfile(candidate({ decision: "WATCH", score: 65 }), baseline)).toBe(
      false,
    );
    expect(
      candidateMatchesProfile(
        candidate({ decision: "WATCH", score: 55, repeated: true }),
        duplicate,
      ),
    ).toBe(true);
    expect(candidateMatchesProfile(candidate({ decision: "WATCH", score: 55 }), duplicate)).toBe(
      false,
    );
    expect(candidateMatchesProfile(candidate({ decision: "SKIP", score: 59 }), score55)).toBe(true);
    expect(candidateMatchesProfile(candidate({ decision: "SKIP", score: 60 }), score55)).toBe(
      false,
    );
    expect(
      candidateMatchesProfile(candidate({ decision: "WATCH", score: 60 }), watchConfirmed),
    ).toBe(true);
    expect(candidateMatchesProfile(candidate({ decision: "BUY", score: 80 }), score65Band)).toBe(
      false,
    );
  });

  it("supports first and latest entry timing without hindsight best-entry selection", () => {
    const candidates = [
      candidate({ id: "early", mint: "mint_a", decidedAtMs: 1 }),
      candidate({ id: "late", mint: "mint_a", decidedAtMs: 2 }),
      candidate({ id: "other", mint: "mint_b", decidedAtMs: 3 }),
    ];

    expect(
      selectCandidatesForTiming(candidates, "first_entry").map((item) => item.decisionId),
    ).toEqual(["early", "other"]);
    expect(
      selectCandidatesForTiming(candidates, "latest_entry").map((item) => item.decisionId),
    ).toEqual(["late", "other"]);
  });
});

function mustFindProfile(
  profiles: readonly ReturnType<typeof buildDefaultEntryProfiles>[number][],
  id: string,
): ReturnType<typeof buildDefaultEntryProfiles>[number] {
  const profile = profiles.find((item) => item.id === id);

  if (!profile) {
    throw new Error(`Missing profile ${id}.`);
  }

  return profile;
}

function candidate(input: {
  readonly id?: string;
  readonly mint?: string;
  readonly decision?: ShadowEntryCandidate["decision"];
  readonly score?: number;
  readonly decidedAtMs?: number;
  readonly repeated?: boolean;
  readonly duplicate?: boolean;
}): ShadowEntryCandidate {
  return {
    runLabel: "RunA",
    decisionId: input.id ?? "decision",
    mintAddress: input.mint ?? "mint",
    decidedAtMs: input.decidedAtMs ?? 1,
    decision: input.decision ?? "BUY",
    score: input.score ?? 65,
    attribution: {
      storedScore: input.score ?? 65,
      factorTotal: input.score ?? 65,
      factors: [],
      buyEligible: true,
      duplicateBuyBlocked: input.duplicate ?? false,
      maxBuyCapBlocked: false,
      riskFlags: [],
      missingQuote: false,
      missingAuthorityEvidence: false,
      missingPriceImpact: false,
      blockingFactors: [],
    },
    observedPoints: [],
    duplicateBuyBlocked: input.duplicate ?? false,
    repeatedMintDecision: input.repeated ?? false,
    repeatedAttentionStrength: input.duplicate ? "HIGH" : input.repeated ? "MEDIUM" : "NONE",
    repeatedAttentionReasons: input.duplicate || input.repeated ? ["test repeated attention"] : [],
    repeatedAttentionSourceCount: input.repeated ? 2 : 1,
    firstAttentionAtMs: input.decidedAtMs ?? 1,
    lastAttentionAtMs: input.repeated
      ? (input.decidedAtMs ?? 1) + 60_000
      : (input.decidedAtMs ?? 1),
    ...(input.repeated ? { timeBetweenAttentionSignalsMinutes: 1 } : {}),
    missingQuote: false,
  };
}
