import { ScoreAttributionService } from "../calibration/ScoreAttributionService.js";
import type { StrategyDecisionRecord } from "../db/schema/index.js";
import { parseJson } from "../db/utils/json.js";
import type { ResearchArchiveMetadata } from "../research/ResearchAggregateTypes.js";
import type { ShadowCalibrationRawRun } from "../shadow-calibration/ShadowCalibrationTypes.js";
import { FastShadowCandidateSelector } from "../shadow-fast/FastShadowCandidateSelector.js";
import { fastEntryExactCoverage, fastEntryPrimaryLabel } from "./FastEntryPrimaryLabel.js";
import type {
  FastEntryAttributionGate,
  FastEntryAttributionReport,
  FastEntryCandidateAttribution,
  FastEntryFeature,
  FastEntryFeatureSource,
  FastEntryFeatureSummary,
  FastEntryFeatureValue,
  FastEntryPrimaryLabel,
  RegisteredFastEntryHypothesis,
} from "./FastEntryAttributionTypes.js";

const labels: readonly FastEntryPrimaryLabel[] = [
  "TARGET_FIRST",
  "STOP_FIRST",
  "MAX_HOLD",
  "NO_OBSERVATION",
  "AMBIGUOUS",
];

export class FastEntryAttributionService {
  constructor(
    private readonly options: {
      readonly archives: readonly ResearchArchiveMetadata[];
      readonly runs: readonly ShadowCalibrationRawRun[];
      readonly clock?: () => number;
      readonly registeredHypothesis?: RegisteredFastEntryHypothesis;
    },
  ) {}

  generate(): FastEntryAttributionReport {
    const candidates = this.options.runs.flatMap((run) => this.selectCandidates(run));
    const runSummaries = this.options.runs.map((run) => summarizeRun(run, candidates));
    const labelCounts = countLabels(candidates.map((candidate) => candidate.primaryLabel));
    const exactCoverage = candidates.filter((candidate) =>
      candidate.exactCoverage.every((row) => row.onTime),
    );
    const selectedRunSharesPct = shares(candidates.map((candidate) => candidate.runLabel));
    const targetRunSharesPct = shares(
      candidates
        .filter((candidate) => candidate.primaryLabel === "TARGET_FIRST")
        .map((candidate) => candidate.runLabel),
    );
    const nonTargetRunSharesPct = shares(
      candidates.filter(isNonTarget).map((candidate) => candidate.runLabel),
    );
    const gates = this.gates({
      candidates,
      runSummaries,
      exactCoverageCount: exactCoverage.length,
      selectedRunSharesPct,
      targetRunSharesPct,
      nonTargetRunSharesPct,
      ...(this.options.registeredHypothesis
        ? { registeredHypothesis: this.options.registeredHypothesis }
        : {}),
    });
    const failed = gates.filter((gate) => !gate.passed);

    return {
      generatedAtMs: (this.options.clock ?? Date.now)(),
      profile: {
        sourceProfileKey: "F65E@v1",
        analysisKey: "F65E_ATTRIBUTION@v1",
        sourceDecision: "SKIP",
        originalBuyScoreThreshold: 90,
        originalWatchScoreThreshold: 70,
        observationHorizonsMinutes: [3, 5, 15],
        primaryScenario: { targetPct: 10, stopPct: 15, maxHoldMinutes: 15 },
      },
      archives: this.options.archives.map((archive) => ({
        label: archive.label,
        inputPath: archive.inputPath,
        warnings: archive.warnings,
      })),
      safety: {
        databaseAccess: "READ_ONLY_ARCHIVES",
        providerCalls: false,
        databaseWrites: false,
        sessionCreation: false,
        strategyDefaultsChanged: false,
        paperExecution: false,
        walletLoaded: false,
        transactionSigning: false,
        transactionSubmission: false,
      },
      runs: runSummaries,
      aggregate: {
        selectedCount: candidates.length,
        exactCoverageCount: exactCoverage.length,
        labelCounts,
        selectedRunSharesPct,
        targetRunSharesPct,
        nonTargetRunSharesPct,
      },
      featureSummaries: summarizeFeatures(candidates),
      gates,
      recommendation:
        failed.length === 0 ? "PRE_REGISTER_SUCCESSOR_HYPOTHESIS" : "NO_DEFENSIBLE_HYPOTHESIS",
      recommendationReason:
        failed.length === 0
          ? "all fixed Phase 9.29 defensibility gates passed; a separate approval is still required"
          : `no defensible successor hypothesis: ${failed.map((gate) => gate.name).join(", ")}`,
      ...(failed.length === 0 && this.options.registeredHypothesis
        ? { successor: registeredSuccessor(this.options.registeredHypothesis) }
        : {}),
      candidates,
      limitations: [
        "F65E@v1 is an archived PAPER shadow study and cannot model executable fills, fees, slippage, latency, MEV, or intra-interval paths.",
        "Outcome labels are attached only after fixed stored-fact selection and feature extraction; labels are not entry inputs.",
        "Provider-wide health without a deterministic candidate link is reported unavailable rather than inferred as provenance.",
        "PRE_REGISTER_SUCCESSOR_HYPOTHESIS would authorize planning only and never paper BUY or live execution.",
      ],
    };
  }

  private selectCandidates(run: ShadowCalibrationRawRun): readonly FastEntryCandidateAttribution[] {
    if (run.sourceKind !== "database") return [];
    const selection = new FastShadowCandidateSelector().select(run.strategyDecisions);
    const observationsByDecision = groupBy(run.watchlistReturns, (row) => row.strategyDecisionId);
    const attributionService = new ScoreAttributionService();

    return selection.selected.map((candidate) => {
      const decision = candidate.decision;
      const observations = observationsByDecision.get(decision.id) ?? [];
      const snapshot = snapshotFor(decision);
      return {
        runLabel: run.label,
        decisionId: decision.id,
        mintAddress: decision.mintAddress,
        ...(candidate.attribution.symbol ? { symbol: candidate.attribution.symbol } : {}),
        decidedAtMs: decision.decidedAtMs,
        classification: candidate.classification,
        classificationReason: candidate.reason,
        primaryLabel: fastEntryPrimaryLabel(observations),
        exactCoverage: fastEntryExactCoverage(observations),
        features: featuresFor({
          decision,
          run,
          snapshot,
          attribution: attributionService.explain(decision),
        }),
      };
    });
  }

  private gates(input: {
    readonly candidates: readonly FastEntryCandidateAttribution[];
    readonly runSummaries: FastEntryAttributionReport["runs"];
    readonly exactCoverageCount: number;
    readonly selectedRunSharesPct: Readonly<Record<string, number>>;
    readonly targetRunSharesPct: Readonly<Record<string, number>>;
    readonly nonTargetRunSharesPct: Readonly<Record<string, number>>;
    readonly registeredHypothesis?: RegisteredFastEntryHypothesis;
  }): readonly FastEntryAttributionGate[] {
    const target = input.candidates.filter(
      (candidate) => candidate.primaryLabel === "TARGET_FIRST",
    );
    const nonTarget = input.candidates.filter(isNonTarget);
    const valid = input.runSummaries.filter((run) => run.mechanicallyValid);
    const targetRuns = new Set(target.map((candidate) => candidate.runLabel));
    const nonTargetRuns = new Set(nonTarget.map((candidate) => candidate.runLabel));

    return [
      {
        name: "three_mechanically_valid_archives",
        passed: input.runSummaries.length === 3 && valid.length === 3,
        detail: `${valid.length}/${input.runSummaries.length} source archives are mechanically valid`,
      },
      {
        name: "exact_primary_coverage",
        passed: input.exactCoverageCount === input.candidates.length,
        detail: `${input.exactCoverageCount}/${input.candidates.length} selected candidates have exact 3/5/15-minute coverage`,
      },
      {
        name: "minimum_compared_labels",
        passed: target.length >= 3 && nonTarget.length >= 3,
        detail: `target-first=${target.length}; non-target=${nonTarget.length}; each requires at least 3`,
      },
      {
        name: "independent_label_run_support",
        passed: targetRuns.size >= 2 && nonTargetRuns.size >= 2,
        detail: `target-first runs=${targetRuns.size}; non-target runs=${nonTargetRuns.size}; each requires at least 2`,
      },
      shareGate("selected_run_concentration", input.selectedRunSharesPct),
      shareGate("target_run_concentration", input.targetRunSharesPct),
      shareGate("non_target_run_concentration", input.nonTargetRunSharesPct),
      directionGate(
        "leave_one_run_out_direction",
        input.candidates,
        "run",
        input.registeredHypothesis,
      ),
      directionGate(
        "leave_one_mint_out_direction",
        input.candidates,
        "mint",
        input.registeredHypothesis,
      ),
      predicateGate(input.candidates, input.registeredHypothesis),
    ];
  }
}

function featuresFor(input: {
  readonly decision: StrategyDecisionRecord;
  readonly run: ShadowCalibrationRawRun;
  readonly snapshot: Record<string, unknown> | undefined;
  readonly attribution: ReturnType<ScoreAttributionService["explain"]>;
}): readonly FastEntryFeature[] {
  const snapshotSource = available(
    "DECISION_SNAPSHOT",
    "strategy_decisions.input_snapshot_json",
    input.decision.decidedAtMs,
  );
  const strategyScore = record(input.snapshot?.strategyScore);
  const facts = record(strategyScore?.facts);
  const token = record(input.snapshot?.tokenRadar);
  const snapshotRisk = record(input.snapshot?.riskAssessment);
  const features: FastEntryFeature[] = [
    feature("score", "SCORE_ATTRIBUTION", input.decision.score ?? undefined, snapshotSource),
    feature("factor_total", "SCORE_ATTRIBUTION", input.attribution.factorTotal, snapshotSource),
    feature("buy_eligible", "SCORE_ATTRIBUTION", input.attribution.buyEligible, snapshotSource),
    feature(
      "duplicate_buy_blocked",
      "SCORE_ATTRIBUTION",
      input.attribution.duplicateBuyBlocked,
      snapshotSource,
    ),
    feature(
      "max_buy_cap_blocked",
      "SCORE_ATTRIBUTION",
      input.attribution.maxBuyCapBlocked,
      snapshotSource,
    ),
    feature("risk_result", "RISK", input.attribution.riskResult, snapshotSource),
    feature("risk_flags", "RISK", input.attribution.riskFlags, snapshotSource),
    feature("liquidity_usd", "MARKET_SNAPSHOT", input.attribution.liquidityUsd, snapshotSource),
    feature("volume_5m_usd", "MARKET_SNAPSHOT", input.attribution.volume5mUsd, snapshotSource),
    feature("volume_1h_usd", "MARKET_SNAPSHOT", input.attribution.volume1hUsd, snapshotSource),
    feature("age_seconds", "MARKET_SNAPSHOT", input.attribution.ageSeconds, snapshotSource),
    feature("token_source", "PROVIDER_PROVENANCE", stringValue(token?.source), snapshotSource),
    feature("missing_quote", "QUOTE_AND_IMPACT", input.attribution.missingQuote, snapshotSource),
    feature(
      "missing_price_impact",
      "QUOTE_AND_IMPACT",
      input.attribution.missingPriceImpact,
      snapshotSource,
    ),
    feature(
      "buy_price_impact_pct",
      "QUOTE_AND_IMPACT",
      numberValue(facts?.buyPriceImpactPct),
      snapshotSource,
    ),
    feature(
      "sell_price_impact_pct",
      "QUOTE_AND_IMPACT",
      numberValue(facts?.sellPriceImpactPct),
      snapshotSource,
    ),
    feature(
      "max_price_impact_pct",
      "QUOTE_AND_IMPACT",
      input.attribution.maxPriceImpactPct,
      snapshotSource,
    ),
  ];

  for (const factor of input.attribution.factors) {
    features.push(
      feature(
        `factor.${factor.ruleName}.points`,
        "SCORE_ATTRIBUTION",
        factor.points,
        snapshotSource,
      ),
    );
    features.push(
      feature(
        `factor.${factor.ruleName}.passed`,
        "SCORE_ATTRIBUTION",
        factor.passed,
        snapshotSource,
      ),
    );
  }

  const volume5m = input.attribution.volume5mUsd;
  const volume1h = input.attribution.volume1hUsd;
  features.push(
    feature(
      "volume_5m_to_hourly_pace",
      "MOMENTUM",
      volume5m !== undefined && volume1h !== undefined && volume1h > 0
        ? volume5m / (volume1h / 12)
        : undefined,
      snapshotSource,
    ),
  );

  const riskId = stringValue(snapshotRisk?.id);
  const archivedRisk = riskId
    ? input.run.riskAssessments.find(
        (row) => row.id === riskId && row.checkedAtMs <= input.decision.decidedAtMs,
      )
    : undefined;
  const riskSource = archivedRisk
    ? available("ARCHIVED_RISK", "risk_assessments.id", archivedRisk.checkedAtMs)
    : unavailable(
        "ARCHIVED_RISK",
        "risk_assessments.id",
        "matching pre-decision risk record was not available",
      );
  features.push(
    feature(
      "mint_authority_disabled",
      "RISK",
      archivedRisk?.mintAuthorityDisabled ?? undefined,
      riskSource,
    ),
    feature(
      "freeze_authority_disabled",
      "RISK",
      archivedRisk?.freezeAuthorityDisabled ?? undefined,
      riskSource,
    ),
    feature("token_program", "RISK", archivedRisk?.tokenProgram ?? undefined, riskSource),
    feature(
      "top_holders_percent",
      "RISK",
      numberValue(archivedRisk?.topHoldersPercent),
      riskSource,
    ),
  );

  const priorDecisions = input.run.strategyDecisions.filter(
    (row) =>
      row.mintAddress === input.decision.mintAddress &&
      row.decidedAtMs < input.decision.decidedAtMs,
  );
  const priorRadar = input.run.tokenRadar.filter(
    (row) =>
      row.mintAddress === input.decision.mintAddress &&
      row.firstSeenAtMs < input.decision.decidedAtMs,
  );
  const earliestSeen = min(priorRadar.map((row) => row.firstSeenAtMs));
  const attentionSource =
    priorDecisions.length > 0 || priorRadar.length > 0
      ? available(
          "DERIVED_PRE_DECISION",
          "strategy_decisions.decided_at_ms|token_radar.first_seen_at_ms",
          input.decision.decidedAtMs,
        )
      : unavailable(
          "DERIVED_PRE_DECISION",
          "strategy_decisions.decided_at_ms|token_radar.first_seen_at_ms",
          "no earlier same-session attention record exists",
        );
  features.push(
    feature(
      "prior_strategy_decision_count",
      "REPEATED_ATTENTION",
      priorDecisions.length,
      attentionSource,
    ),
    feature("prior_token_radar_count", "REPEATED_ATTENTION", priorRadar.length, attentionSource),
    feature(
      "elapsed_since_earliest_prior_seen_ms",
      "REPEATED_ATTENTION",
      earliestSeen === undefined ? undefined : input.decision.decidedAtMs - earliestSeen,
      attentionSource,
    ),
  );
  return features;
}

function summarizeRun(
  run: ShadowCalibrationRawRun,
  candidates: readonly FastEntryCandidateAttribution[],
): FastEntryAttributionReport["runs"][number] {
  const selected = candidates.filter((candidate) => candidate.runLabel === run.label);
  return {
    label: run.label,
    mechanicallyValid: run.orderCount === 0 && run.fillCount === 0 && run.positionCount === 0,
    selectedCount: selected.length,
    labelCounts: countLabels(selected.map((candidate) => candidate.primaryLabel)),
    orderCount: run.orderCount,
    fillCount: run.fillCount,
    positionCount: run.positionCount,
    warnings: run.warnings,
  };
}

function summarizeFeatures(
  candidates: readonly FastEntryCandidateAttribution[],
): readonly FastEntryFeatureSummary[] {
  const byKey = new Map<string, FastEntryFeature[]>();
  for (const candidate of candidates) {
    for (const entry of candidate.features)
      byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  }
  return [...byKey.entries()]
    .map(([key, entries]) => {
      const family = entries[0]?.family ?? "SCORE_ATTRIBUTION";
      const byLabel = labels.map((label) => {
        const matching = candidates.filter((candidate) => candidate.primaryLabel === label);
        const featureEntries = matching.flatMap((candidate) =>
          candidate.features.filter((item) => item.key === key),
        );
        const values = featureEntries.flatMap((entry) =>
          entry.value === undefined ? [] : [entry.value],
        );
        return {
          label,
          candidateCount: matching.length,
          availableCount: values.length,
          unavailableCount: matching.length - values.length,
          values,
        };
      });
      const values = entries.flatMap((entry) => (entry.value === undefined ? [] : [entry.value]));
      return {
        key,
        family,
        candidateCount: candidates.length,
        availableCount: values.length,
        unavailableCount: candidates.length - values.length,
        hasVariation: new Set(values.map(stableValue)).size > 1,
        byLabel,
      };
    })
    .sort(
      (left, right) => left.family.localeCompare(right.family) || left.key.localeCompare(right.key),
    );
}

function feature(
  key: string,
  family: FastEntryFeature["family"],
  value: FastEntryFeatureValue | undefined,
  source: FastEntryFeatureSource,
): FastEntryFeature {
  return value === undefined
    ? { key, family, source: unavailableFrom(source) }
    : { key, family, value, source };
}

function available(
  kind: FastEntryFeatureSource["kind"],
  path: string,
  timestampMs: number,
): FastEntryFeatureSource {
  return { kind, path, timestampMs, availability: "AVAILABLE_AT_DECISION_TIME" };
}

function unavailable(
  kind: FastEntryFeatureSource["kind"],
  path: string,
  reason: string,
): FastEntryFeatureSource {
  return { kind, path, availability: "UNAVAILABLE_AT_DECISION_TIME", unavailableReason: reason };
}

function unavailableFrom(source: FastEntryFeatureSource): FastEntryFeatureSource {
  return source.availability === "UNAVAILABLE_AT_DECISION_TIME"
    ? source
    : {
        ...source,
        availability: "UNAVAILABLE_AT_DECISION_TIME",
        unavailableReason: "stored decision-time value is absent",
      };
}

function snapshotFor(decision: StrategyDecisionRecord): Record<string, unknown> | undefined {
  if (!decision.inputSnapshotJson) return undefined;
  try {
    return record(parseJson<unknown>(decision.inputSnapshotJson));
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item]);
  return grouped;
}

function countLabels(
  values: readonly FastEntryPrimaryLabel[],
): Readonly<Record<FastEntryPrimaryLabel, number>> {
  return Object.fromEntries(
    labels.map((label) => [label, values.filter((value) => value === label).length]),
  ) as Record<FastEntryPrimaryLabel, number>;
}

function shares(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].map(([key, count]) => [
      key,
      values.length === 0 ? 0 : (count / values.length) * 100,
    ]),
  );
}

function shareGate(
  name: string,
  shareByRun: Readonly<Record<string, number>>,
): FastEntryAttributionGate {
  const maximum = Math.max(0, ...Object.values(shareByRun));
  return {
    name,
    passed: maximum <= 40,
    detail: `largest source-run share=${maximum.toFixed(2)}%; maximum allowed=40%`,
  };
}

function isNonTarget(candidate: FastEntryCandidateAttribution): boolean {
  return candidate.primaryLabel === "STOP_FIRST" || candidate.primaryLabel === "MAX_HOLD";
}

function min(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : Math.min(...values);
}

function stableValue(value: FastEntryFeatureValue): string {
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

function predicateGate(
  candidates: readonly FastEntryCandidateAttribution[],
  hypothesis: RegisteredFastEntryHypothesis | undefined,
): FastEntryAttributionGate {
  if (!hypothesis) {
    return {
      name: "narrow_single_fact_predicate",
      passed: false,
      detail: "Phase 9.29 does not search or synthesize predicates from outcome labels",
    };
  }
  const selected = candidates.filter((candidate) => matchesHypothesis(candidate, hypothesis));
  return {
    name: "narrow_single_fact_predicate",
    passed: selected.length > 0 && selected.length < candidates.length,
    detail: `${hypothesis.profileId}@${hypothesis.version} selects ${selected.length}/${candidates.length} candidates using ${hypothesis.featureKey} only`,
  };
}

function directionGate(
  name: string,
  candidates: readonly FastEntryCandidateAttribution[],
  dimension: "run" | "mint",
  hypothesis: RegisteredFastEntryHypothesis | undefined,
): FastEntryAttributionGate {
  if (!hypothesis) {
    return {
      name,
      passed: false,
      detail:
        "no pre-registered single-fact successor predicate is available for a direction check",
    };
  }
  const values = [
    ...new Set(
      candidates.map((candidate) =>
        dimension === "run" ? candidate.runLabel : candidate.mintAddress,
      ),
    ),
  ];
  const stable =
    values.length >= 2 &&
    values.every((excluded) => {
      const remaining = candidates.filter(
        (candidate) =>
          (dimension === "run" ? candidate.runLabel : candidate.mintAddress) !== excluded,
      );
      const target = remaining.filter((candidate) => candidate.primaryLabel === "TARGET_FIRST");
      const nonTarget = remaining.filter(isNonTarget);
      return (
        target.length > 0 &&
        nonTarget.length > 0 &&
        matchRate(target, hypothesis) > matchRate(nonTarget, hypothesis)
      );
    });
  return {
    name,
    passed: stable,
    detail: `${hypothesis.featureKey} keeps a higher target-first match rate after each ${dimension} omission=${stable}`,
  };
}

function matchRate(
  candidates: readonly FastEntryCandidateAttribution[],
  hypothesis: RegisteredFastEntryHypothesis,
): number {
  return candidates.length === 0
    ? 0
    : candidates.filter((candidate) => matchesHypothesis(candidate, hypothesis)).length /
        candidates.length;
}

function matchesHypothesis(
  candidate: FastEntryCandidateAttribution,
  hypothesis: RegisteredFastEntryHypothesis,
): boolean {
  const feature = candidate.features.find((item) => item.key === hypothesis.featureKey);
  return (
    feature?.value !== undefined &&
    stableValue(feature.value) === stableValue(hypothesis.expectedValue)
  );
}

function registeredSuccessor(
  hypothesis: RegisteredFastEntryHypothesis,
): NonNullable<FastEntryAttributionReport["successor"]> {
  return {
    ...hypothesis,
    collectionContract: [
      "Collect exactly three new independent 120-minute PAPER/shadow-only runs from reset PAPER databases.",
      "Retain normal BUY=90 / WATCH=70 collection, F65E first-per-mint ordering, cap 10, and exact 3/5/15-minute observations with two-minute lateness.",
      "Apply only the fixed narrower decision-time predicate; do not widen score or hard-factor thresholds to fill the cohort.",
    ],
    promotionGates: [
      "At least 20 exact 15-minute candidates and 15 unique mints; no selected mint or run above 40%; stable leave-one-run/mint-out direction.",
      "Primary target-first >=55%, stop-first <=25%, target-minus-stop >=20 points, median MFE >=+10%, and median MAE >-15%.",
      "A pass authorizes only a separate promotion review, never PAPER BUY, wallet loading, signing, or submission.",
    ],
  };
}
