import type { StrategyDecision } from "../db/schema/index.js";
import type { ShadowEntryRuntimeConfig, ShadowEntryTimingMode } from "./ShadowEntryConfig.js";
import type { ShadowEntryCandidate, ShadowEntryProfile } from "./ShadowEntryTypes.js";

const ALL_RESEARCH_DECISIONS = [
  "BUY",
  "WATCH",
  "SKIP",
] as const satisfies readonly StrategyDecision[];

export function buildDefaultEntryProfiles(
  config: ShadowEntryRuntimeConfig,
): readonly ShadowEntryProfile[] {
  const profiles: ShadowEntryProfile[] = [
    {
      id: "P001",
      profileVersion: "v1",
      profileKey: profileKey("P001", "v1"),
      name: "baseline_raw_buy",
      description: "Immutable baseline raw BUY behavior from Phase 8.91.",
      minScore: 65,
      decisions: ["BUY"],
      timingModes: ["decision"],
      confirmationRequired: false,
      duplicatePolicy: "any",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: ["off"],
      recoveryOnly: false,
      readonlyBaseline: true,
    },
    {
      id: "P002",
      profileVersion: "v1",
      profileKey: profileKey("P002", "v1"),
      name: "score65_confirmed",
      description: "Score >= 65 candidates with short-horizon confirmation.",
      minScore: 65,
      decisions: ALL_RESEARCH_DECISIONS,
      timingModes: intersectTimings(["decision", "first_entry", "latest_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "any",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: config.earlyDrawdownModes,
      recoveryOnly: false,
      readonlyBaseline: false,
    },
    {
      id: "P003",
      profileVersion: "v1",
      profileKey: profileKey("P003", "v1"),
      name: "duplicate_attention",
      description: "Duplicate-buy-blocked or repeated-mint candidates.",
      minScore: 55,
      decisions: ALL_RESEARCH_DECISIONS,
      timingModes: intersectTimings(["first_entry", "latest_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "duplicate_or_repeated",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: config.earlyDrawdownModes,
      recoveryOnly: false,
      readonlyBaseline: false,
    },
    {
      id: "P004",
      profileVersion: "v1",
      profileKey: profileKey("P004", "v1"),
      name: "score55_research",
      description: "Score 55-59 WATCH/SKIP research band.",
      minScore: 55,
      maxScore: 59,
      decisions: ["WATCH", "SKIP"],
      timingModes: intersectTimings(["decision", "first_entry", "latest_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "any",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: config.earlyDrawdownModes,
      recoveryOnly: false,
      readonlyBaseline: false,
    },
    {
      id: "P005",
      profileVersion: "v1",
      profileKey: profileKey("P005", "v1"),
      name: "quote_control",
      description: "Quote availability cohort split without default rejection.",
      minScore: config.minScore,
      decisions: ALL_RESEARCH_DECISIONS,
      timingModes: intersectTimings(["decision"], config),
      confirmationRequired: false,
      duplicatePolicy: "any",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: ["off"],
      recoveryOnly: false,
      readonlyBaseline: false,
    },
    {
      id: "P006",
      profileVersion: "v1",
      profileKey: profileKey("P006", "v1"),
      name: "recovery_after_drawdown",
      description: "Early drawdown followed by recovery confirmation.",
      minScore: 55,
      decisions: ALL_RESEARCH_DECISIONS,
      timingModes: intersectTimings(["first_entry", "latest_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "any",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: ["require_recovery"],
      recoveryOnly: true,
      readonlyBaseline: false,
    },
    {
      id: "P007",
      profileVersion: "v1",
      profileKey: profileKey("P007", "v1"),
      name: "watch_first_confirmed",
      description: "WATCH candidates with score >= 60 and confirmation-first entry timing.",
      minScore: 60,
      decisions: ["WATCH"],
      timingModes: intersectTimings(["first_entry", "latest_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "any",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: intersectDrawdownModes(["warn_only", "reject_10"], config),
      recoveryOnly: false,
      readonlyBaseline: false,
    },
    {
      id: "P008",
      profileVersion: "v1",
      profileKey: profileKey("P008", "v1"),
      name: "duplicate_attention_confirmed",
      description: "Repeated-attention candidates with score >= 55 and confirmation.",
      minScore: 55,
      decisions: ALL_RESEARCH_DECISIONS,
      timingModes: intersectTimings(["first_entry", "latest_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "duplicate_or_repeated",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: intersectDrawdownModes(["warn_only", "reject_10"], config),
      recoveryOnly: false,
      readonlyBaseline: false,
    },
    {
      id: "P009",
      profileVersion: "v1",
      profileKey: profileKey("P009", "v1"),
      name: "score65_79_confirmed",
      description: "Score 65-79 BUY/WATCH candidates with confirmation and drawdown research.",
      minScore: 65,
      maxScore: 79,
      decisions: ["BUY", "WATCH"],
      timingModes: intersectTimings(["decision", "first_entry", "latest_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "any",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: intersectDrawdownModes(
        ["warn_only", "reject_10", "require_recovery"],
        config,
      ),
      recoveryOnly: false,
      readonlyBaseline: false,
    },
    {
      id: "P010",
      profileVersion: "v1",
      profileKey: profileKey("P010", "v1"),
      name: "high_score75_research",
      description: "High-score BUY/WATCH research cohort with warning-only early drawdown.",
      minScore: 75,
      decisions: ["BUY", "WATCH"],
      timingModes: intersectTimings(["decision", "first_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "any",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: intersectDrawdownModes(["warn_only"], config),
      recoveryOnly: false,
      readonlyBaseline: false,
    },
    {
      id: "P011",
      profileVersion: "v1",
      profileKey: profileKey("P011", "v1"),
      name: "watch_duplicate_hybrid",
      description: "WATCH candidates with repeated-attention evidence and confirmation.",
      minScore: 60,
      decisions: ["WATCH"],
      timingModes: intersectTimings(["first_entry", "latest_entry"], config),
      confirmationRequired: true,
      duplicatePolicy: "duplicate_or_repeated",
      quotePolicy: "evidence_only",
      earlyDrawdownModes: intersectDrawdownModes(
        ["warn_only", "reject_10", "require_recovery"],
        config,
      ),
      recoveryOnly: false,
      readonlyBaseline: false,
    },
  ];

  return profiles.filter((profile) => config.profileIds.includes(profile.id));
}

export function candidateMatchesProfile(
  candidate: ShadowEntryCandidate,
  profile: ShadowEntryProfile,
): boolean {
  const score = candidate.score ?? -1;

  if (!profile.decisions.includes(candidate.decision)) {
    return false;
  }

  if (score < profile.minScore) {
    return false;
  }

  if (profile.maxScore !== undefined && score > profile.maxScore) {
    return false;
  }

  if (
    profile.duplicatePolicy === "duplicate_or_repeated" &&
    !candidate.duplicateBuyBlocked &&
    !candidate.repeatedMintDecision
  ) {
    return false;
  }

  if (profile.quotePolicy === "require_quote" && candidate.missingQuote) {
    return false;
  }

  return true;
}

export function selectCandidatesForTiming(
  candidates: readonly ShadowEntryCandidate[],
  timingMode: ShadowEntryTimingMode,
): readonly ShadowEntryCandidate[] {
  if (timingMode === "decision") {
    return candidates;
  }

  return [
    ...groupBy(
      candidates,
      (candidate) => `${candidate.runLabel}:${candidate.mintAddress}`,
    ).values(),
  ]
    .map((items) => selectMintCandidate(items, timingMode))
    .filter((candidate): candidate is ShadowEntryCandidate => candidate !== undefined);
}

function selectMintCandidate(
  candidates: readonly ShadowEntryCandidate[],
  timingMode: ShadowEntryTimingMode,
): ShadowEntryCandidate | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  return [...candidates].sort((left, right) =>
    timingMode === "latest_entry"
      ? right.decidedAtMs - left.decidedAtMs
      : left.decidedAtMs - right.decidedAtMs,
  )[0];
}

function intersectTimings(
  preferred: readonly ShadowEntryTimingMode[],
  config: ShadowEntryRuntimeConfig,
): readonly ShadowEntryTimingMode[] {
  const selected = preferred.filter((mode) => config.entryTimingModes.includes(mode));

  return selected.length > 0 ? selected : preferred;
}

function intersectDrawdownModes(
  preferred: readonly ShadowEntryProfile["earlyDrawdownModes"][number][],
  config: ShadowEntryRuntimeConfig,
): readonly ShadowEntryProfile["earlyDrawdownModes"][number][] {
  const selected = preferred.filter((mode) => config.earlyDrawdownModes.includes(mode));

  return selected.length > 0 ? selected : preferred;
}

function profileKey(id: ShadowEntryProfile["id"], version: string): string {
  return `${id}@${version}`;
}

function groupBy<T>(
  items: readonly T[],
  getKey: (item: T) => string,
): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key);

    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return groups;
}
