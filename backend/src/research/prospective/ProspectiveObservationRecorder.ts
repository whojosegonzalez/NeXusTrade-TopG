/**
 * Phase 12.94-D Milestone D.3.2: Prospective Observation Recorder
 *
 * Implements lightweight, zero-lookahead recording for prospective candidate evaluations
 * and multi-horizon forward outcomes (+5m, +15m, +30m, +60m).
 *
 * KEY GUARANTEES:
 * 1. Zero PAPER or wallet mutations: Operates strictly as a passive observation recorder.
 * 2. Immutable decision events: Once recorded, decision records cannot be modified or backfilled.
 * 3. Forward outcomes are stored as independent events referencing the baseline decisionEventId.
 * 4. Missing observations remain explicitly recorded with failure/truncation status codes.
 * 5. Rejection categories explicitly segregate Risk, Eligibility, Missing Data, and Capacity.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  FORWARD_HORIZONS_SEC,
  type CandidateStreamSource,
  type CohortHorizonStatistics,
  type DecisionGateOutcome,
  type DecisionMarketFeatures,
  type DecisionTimeObservationRecord,
  type ForwardHorizonOutcomeRecord,
  type ForwardHorizonSec,
  type ForwardOutcomeStatus,
  type GateCheckRecord,
  type HorizonCoverageSummary,
  type ProspectiveSessionSummary,
  type ProspectiveStrategyCohort,
  type RejectionCategory,
} from "./ProspectiveObservationTypes.js";

export interface ProspectiveRecorderOptions {
  readonly sessionId: string;
  readonly configFingerprint: string;
  readonly outputDir?: string | undefined;
  readonly clock?: () => number;
  readonly suppressDuplicateCandidates?: boolean;
}

export interface RecordDecisionInput {
  readonly discoveryTimestampMs: number;
  readonly decisionTimestampMs?: number;
  readonly streamSource: CandidateStreamSource;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly symbol: string;
  readonly strategyCohort: ProspectiveStrategyCohort;
  readonly marketFeatures: DecisionMarketFeatures;
  readonly triggered: boolean;
  readonly rejectionReason?: string | undefined;
  readonly gateChecks: readonly GateCheckRecord[];
}

export interface RecordHorizonOutcomeInput {
  readonly decisionEventId: string;
  readonly horizonSec: ForwardHorizonSec;
  readonly observationTimestampMs?: number;
  readonly outcomeStatus: ForwardOutcomeStatus;
  readonly indicativePriceSol: number | null;
  readonly liquidityUsd: number | null;
  readonly missingReason?: string | undefined;
}

export class ProspectiveObservationRecorder {
  private readonly sessionId: string;
  private readonly configFingerprint: string;
  private readonly outputDir: string | null;
  private readonly clock: () => number;
  private readonly suppressDuplicates: boolean;

  private readonly decisionRecords = new Map<string, DecisionTimeObservationRecord>();
  private readonly forwardRecords = new Map<string, ForwardHorizonOutcomeRecord[]>(); // decisionEventId -> records
  private readonly observedMints = new Set<string>();

  private sessionStartedAtMs: number;
  private intakeStoppedAtMs: number | null = null;
  private sessionClosedAtMs: number | null = null;
  private duplicateSuppressedCount = 0;

  constructor(options: ProspectiveRecorderOptions) {
    this.sessionId = options.sessionId;
    this.configFingerprint = options.configFingerprint;
    this.outputDir = options.outputDir ?? null;
    this.clock = options.clock ?? (() => Date.now());
    this.suppressDuplicates = options.suppressDuplicateCandidates ?? true;
    this.sessionStartedAtMs = this.clock();

    if (this.outputDir && !fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Helper to categorize rejection reason into one of 4 strict buckets.
   */
  public static categorizeRejection(
    rejectionReason: string | undefined,
    failedRules: readonly string[],
  ): RejectionCategory | null {
    if (!rejectionReason && failedRules.length === 0) return null;

    const allReasons = [rejectionReason, ...failedRules].filter(Boolean) as string[];

    // 1. Missing Data
    if (
      allReasons.some((r) =>
        [
          "MISSING_PRICE_DATA",
          "MISSING_LIQUIDITY_DATA",
          "UNAVAILABLE_RUGCHECK",
          "UNAVAILABLE_HOLDERS",
          "GATE_FAIL_MISSING_DATA",
        ].includes(r),
      )
    ) {
      return "REJECTED_BY_MISSING_DATA";
    }

    // 2. Capacity
    if (
      allReasons.some((r) =>
        [
          "MAX_OPEN_POSITIONS_REACHED",
          "WATCHLIST_CAPACITY_EXCEEDED",
          "ANTI_REBUY_COOLDOWN_ACTIVE",
          "RATE_LIMIT_EXCEEDED",
        ].includes(r),
      )
    ) {
      return "REJECTED_BY_CAPACITY";
    }

    // 3. Risk
    if (
      allReasons.some((r) =>
        [
          "BUNDLER_CONCENTRATION_GATE",
          "TOP_HOLDER_CONCENTRATION_GATE",
          "RUGCHECK_SECURITY_GATE",
          "SINGLE_TX_DISPOSAL_GATE",
          "ESTABLISHED_MACRO_TREND_GATE",
          "REJECTED_BLACKLISTED_SYMBOL",
          "REJECTED_HIGH_BUNDLER",
          "REJECTED_TOP10_CONCENTRATION",
          "REJECTED_DANGER_RISK",
          "REJECTED_ESTABLISHED_MACRO_DOWNTREND",
          "REJECTED_EXCESSIVE_DISPOSAL",
        ].includes(r),
      )
    ) {
      return "REJECTED_BY_RISK";
    }

    // 4. Eligibility (Default for parameter screening: age, liquidity floor, flow, etc.)
    return "REJECTED_BY_ELIGIBILITY";
  }

  /**
   * Records a candidate decision evaluation at decision time.
   * Produces an immutable, frozen record and schedules forward observation targets.
   */
  public recordDecisionEvent(input: RecordDecisionInput): DecisionTimeObservationRecord | null {
    const now = input.decisionTimestampMs ?? this.clock();

    // Check duplicate suppression
    if (this.suppressDuplicates && this.observedMints.has(input.mintAddress)) {
      this.duplicateSuppressedCount += 1;
      return null;
    }
    this.observedMints.add(input.mintAddress);

    const eventId = `dec-${input.mintAddress.slice(0, 8)}-${now}-${crypto.randomBytes(4).toString("hex")}`;

    const failedRules = input.gateChecks.filter((g) => !g.passed).map((g) => g.name);
    const rejectionCategory = input.triggered
      ? null
      : ProspectiveObservationRecorder.categorizeRejection(input.rejectionReason, failedRules);

    const gateOutcome: DecisionGateOutcome = Object.freeze({
      decision: input.triggered ? "ACCEPTED_ARMED" : "FILTERED_REJECTED",
      rejectionCategory,
      primaryFailedRule: failedRules[0] ?? input.rejectionReason ?? null,
      allFailedRules: Object.freeze([...failedRules]),
      gateChecks: Object.freeze(
        input.gateChecks.map((g) =>
          Object.freeze({
            name: g.name,
            passed: g.passed,
            value: g.value,
            requirement: g.requirement,
          }),
        ),
      ),
    });

    const marketFeatures: DecisionMarketFeatures = Object.freeze({
      indicativePriceSol: input.marketFeatures.indicativePriceSol,
      priceQuoteTimestampMs: input.marketFeatures.priceQuoteTimestampMs,
      priceQuoteFreshnessMs:
        input.marketFeatures.priceQuoteFreshnessMs ??
        Math.max(0, now - input.marketFeatures.priceQuoteTimestampMs),
      liquidityUsd: input.marketFeatures.liquidityUsd,
      volume5mUsd: input.marketFeatures.volume5mUsd,
      marketCapUsd: input.marketFeatures.marketCapUsd,
      assetAgeSeconds: input.marketFeatures.assetAgeSeconds,
      holdersCount: input.marketFeatures.holdersCount,
      buyToSellRatio: input.marketFeatures.buyToSellRatio,
      recentBuys60s: input.marketFeatures.recentBuys60s,
      recentSells60s: input.marketFeatures.recentSells60s,
      lmcRatio: input.marketFeatures.lmcRatio,
      rugScore: input.marketFeatures.rugScore,
      bundlerPct: input.marketFeatures.bundlerPct,
      top10HolderPct: input.marketFeatures.top10HolderPct,
      unavailableInputs: Object.freeze([...input.marketFeatures.unavailableInputs]),
    });

    const record: DecisionTimeObservationRecord = Object.freeze({
      decisionEventId: eventId,
      sessionId: this.sessionId,
      candidateDiscoveryTimestampMs: input.discoveryTimestampMs,
      decisionTimestampMs: now,
      streamSource: input.streamSource,
      mintAddress: input.mintAddress,
      poolId: input.poolId,
      symbol: input.symbol,
      strategyCohort: input.strategyCohort,
      configFingerprint: this.configFingerprint,
      marketFeatures,
      gateOutcome,
    });

    this.decisionRecords.set(eventId, record);
    this.forwardRecords.set(eventId, []);

    // Append to decision-observations.jsonl if outputDir is configured
    if (this.outputDir) {
      const decisionLogPath = path.join(this.outputDir, "decision-observations.jsonl");
      fs.appendFileSync(decisionLogPath, JSON.stringify(record) + "\n", "utf8");
    }

    return record;
  }

  /**
   * Records a forward outcome observation (+5m, +15m, +30m, +60m) referencing a decision.
   */
  public recordHorizonOutcome(input: RecordHorizonOutcomeInput): ForwardHorizonOutcomeRecord {
    const baseline = this.decisionRecords.get(input.decisionEventId);
    if (!baseline) {
      throw new Error(
        `[HORIZON_NOT_FOUND] Baseline decision ${input.decisionEventId} does not exist.`,
      );
    }

    const now = input.observationTimestampMs ?? this.clock();
    const scheduledDue = baseline.decisionTimestampMs + input.horizonSec * 1000;
    const latency = now - scheduledDue;

    const basePrice = baseline.marketFeatures.indicativePriceSol;
    let priceReturnPct: number | null = null;
    if (
      input.indicativePriceSol !== null &&
      basePrice > 0 &&
      input.outcomeStatus === "OBSERVED_PRICE"
    ) {
      priceReturnPct = Number(
        (((input.indicativePriceSol - basePrice) / basePrice) * 100).toFixed(4),
      );
    }

    const baseLiq = baseline.marketFeatures.liquidityUsd;
    let liquidityChangePct: number | null = null;
    if (input.liquidityUsd !== null && baseLiq > 0) {
      liquidityChangePct = Number((((input.liquidityUsd - baseLiq) / baseLiq) * 100).toFixed(4));
    }

    const forwardId = `fwd-${baseline.mintAddress.slice(0, 8)}-h${input.horizonSec}-${now}`;

    const record: ForwardHorizonOutcomeRecord = Object.freeze({
      forwardOutcomeId: forwardId,
      decisionEventId: baseline.decisionEventId,
      sessionId: this.sessionId,
      mintAddress: baseline.mintAddress,
      poolId: baseline.poolId,
      horizonSec: input.horizonSec,
      scheduledDueTimestampMs: scheduledDue,
      actualObservationTimestampMs: now,
      observationLatencyMs: latency,
      outcomeStatus: input.outcomeStatus,
      indicativePriceSol: input.indicativePriceSol,
      priceReturnPct,
      liquidityUsd: input.liquidityUsd,
      liquidityChangePct,
      missingReason: input.missingReason,
    });

    const list = this.forwardRecords.get(input.decisionEventId)!;
    list.push(record);

    // Append to forward-observations.jsonl if outputDir is configured
    if (this.outputDir) {
      const forwardLogPath = path.join(this.outputDir, "forward-observations.jsonl");
      fs.appendFileSync(forwardLogPath, JSON.stringify(record) + "\n", "utf8");
    }

    return record;
  }

  /**
   * Marks candidate intake as stopped. No new candidates will be evaluated,
   * but pending horizons will continue to be sampled until drain duration expires.
   */
  public stopIntake(nowTimestampMs?: number): void {
    this.intakeStoppedAtMs = nowTimestampMs ?? this.clock();
  }

  /**
   * Closes the session and marks any remaining unobserved horizons as truncated.
   */
  public closeSession(nowTimestampMs?: number): void {
    const now = nowTimestampMs ?? this.clock();
    this.sessionClosedAtMs = now;
    if (!this.intakeStoppedAtMs) {
      this.intakeStoppedAtMs = now;
    }

    // Identify any scheduled horizons that were never recorded
    for (const decisionId of this.decisionRecords.keys()) {
      const recorded = this.forwardRecords.get(decisionId) || [];
      const recordedHorizons = new Set(recorded.map((r) => r.horizonSec));

      for (const h of FORWARD_HORIZONS_SEC) {
        if (!recordedHorizons.has(h)) {
          this.recordHorizonOutcome({
            decisionEventId: decisionId,
            horizonSec: h,
            observationTimestampMs: now,
            outcomeStatus: "WINDOW_TRUNCATED",
            indicativePriceSol: null,
            liquidityUsd: null,
            missingReason: "SESSION_CLOSED_BEFORE_HORIZON_ELAPSED",
          });
        }
      }
    }
  }

  /**
   * Computes statistical aggregates for a subset of forward outcomes.
   */
  private computeHorizonStats(outcomes: ForwardHorizonOutcomeRecord[]): CohortHorizonStatistics {
    const validPrices = outcomes
      .filter((o) => o.outcomeStatus === "OBSERVED_PRICE" && o.priceReturnPct !== null)
      .map((o) => o.priceReturnPct!);

    const sampleCount = outcomes.length;
    const validCount = validPrices.length;
    const missingCount = sampleCount - validCount;

    if (validCount === 0) {
      return {
        sampleCount,
        validPriceCount: 0,
        missingCount,
        meanReturnPct: null,
        medianReturnPct: null,
        minReturnPct: null,
        maxReturnPct: null,
        standardDeviationPct: null,
        positiveReturnRatio: null,
      };
    }

    const sorted = [...validPrices].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const mean = Number((sum / validCount).toFixed(4));

    const mid = Math.floor(sorted.length / 2);
    const median = Number(
      (sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2).toFixed(4),
    );

    const min = sorted[0]!;
    const max = sorted[sorted.length - 1]!;

    const variance = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / validCount;
    const stdDev = Number(Math.sqrt(variance).toFixed(4));
    const positiveCount = sorted.filter((v) => v > 0).length;
    const positiveRatio = Number((positiveCount / validCount).toFixed(4));

    return {
      sampleCount,
      validPriceCount: validCount,
      missingCount,
      meanReturnPct: mean,
      medianReturnPct: median,
      minReturnPct: min,
      maxReturnPct: max,
      standardDeviationPct: stdDev,
      positiveReturnRatio: positiveRatio,
    };
  }

  /**
   * Generates a verifiable prospective session summary.
   */
  public generateSessionSummary(): ProspectiveSessionSummary {
    const allDecisions = Array.from(this.decisionRecords.values());
    const allForwards = Array.from(this.forwardRecords.values()).flat();

    const acceptedDecisions = allDecisions.filter(
      (d) => d.gateOutcome.decision === "ACCEPTED_ARMED",
    );
    const rejectedDecisions = allDecisions.filter(
      (d) => d.gateOutcome.decision === "FILTERED_REJECTED",
    );

    const rejectionsByCategory: Record<RejectionCategory, number> = {
      REJECTED_BY_RISK: 0,
      REJECTED_BY_ELIGIBILITY: 0,
      REJECTED_BY_MISSING_DATA: 0,
      REJECTED_BY_CAPACITY: 0,
    };
    const rejectionsByRule: Record<string, number> = {};

    for (const r of rejectedDecisions) {
      if (r.gateOutcome.rejectionCategory) {
        rejectionsByCategory[r.gateOutcome.rejectionCategory] =
          (rejectionsByCategory[r.gateOutcome.rejectionCategory] || 0) + 1;
      }
      const rule = r.gateOutcome.primaryFailedRule || "UNKNOWN";
      rejectionsByRule[rule] = (rejectionsByRule[rule] || 0) + 1;
    }

    const candidatesByCohort: Record<ProspectiveStrategyCohort, number> = {
      ESTABLISHED_RUNNER: allDecisions.filter((d) => d.strategyCohort === "ESTABLISHED_RUNNER")
        .length,
      MICRO_CAP_PROBE: allDecisions.filter((d) => d.strategyCohort === "MICRO_CAP_PROBE").length,
      UNCLASSIFIED: allDecisions.filter((d) => d.strategyCohort === "UNCLASSIFIED").length,
    };

    // Coverage by horizon
    const horizonCoverage: Record<string, HorizonCoverageSummary> = {};
    for (const h of FORWARD_HORIZONS_SEC) {
      const hOutcomes = allForwards.filter((f) => f.horizonSec === h);
      const observed = hOutcomes.filter((f) => f.outcomeStatus === "OBSERVED_PRICE").length;
      const missing = hOutcomes.length - observed;
      const coveragePct =
        hOutcomes.length > 0 ? Number(((observed / hOutcomes.length) * 100).toFixed(2)) : 0;
      horizonCoverage[`${h}s`] = {
        scheduledCount: hOutcomes.length,
        observedCount: observed,
        missingCount: missing,
        coveragePct,
      };
    }

    // Sub-segment stats by cohort and outcome
    const getStatsByFilter = (filterFn: (d: DecisionTimeObservationRecord) => boolean) => {
      const matchingIds = new Set(allDecisions.filter(filterFn).map((d) => d.decisionEventId));
      const res: Record<string, CohortHorizonStatistics> = {};
      for (const h of FORWARD_HORIZONS_SEC) {
        const outcomes = allForwards.filter(
          (f) => f.horizonSec === h && matchingIds.has(f.decisionEventId),
        );
        res[`${h}s`] = this.computeHorizonStats(outcomes);
      }
      return res;
    };

    const cohortHorizonStats = {
      established: getStatsByFilter((d) => d.strategyCohort === "ESTABLISHED_RUNNER"),
      microCap: getStatsByFilter((d) => d.strategyCohort === "MICRO_CAP_PROBE"),
      accepted: getStatsByFilter((d) => d.gateOutcome.decision === "ACCEPTED_ARMED"),
      rejectedByRisk: getStatsByFilter(
        (d) => d.gateOutcome.rejectionCategory === "REJECTED_BY_RISK",
      ),
      rejectedByEligibility: getStatsByFilter(
        (d) => d.gateOutcome.rejectionCategory === "REJECTED_BY_ELIGIBILITY",
      ),
    };

    // Data quality
    const observedLatencyForwards = allForwards.filter((f) => f.observationLatencyMs !== null);
    const avgLatency =
      observedLatencyForwards.length > 0
        ? Math.round(
            observedLatencyForwards.reduce((acc, f) => acc + Math.abs(f.observationLatencyMs!), 0) /
              observedLatencyForwards.length,
          )
        : 0;

    const summary: ProspectiveSessionSummary = {
      sessionId: this.sessionId,
      configFingerprint: this.configFingerprint,
      sessionStartedAtMs: this.sessionStartedAtMs,
      intakeStoppedAtMs: this.intakeStoppedAtMs ?? this.clock(),
      sessionClosedAtMs: this.sessionClosedAtMs ?? this.clock(),
      totalCandidatesScreened: allDecisions.length,
      uniqueMintsCount: this.observedMints.size,
      duplicateCandidatesSuppressed: this.duplicateSuppressedCount,
      acceptedCandidatesCount: acceptedDecisions.length,
      rejectedCandidatesCount: rejectedDecisions.length,
      rejectionsByCategory,
      rejectionsByRule,
      candidatesByCohort,
      horizonCoverage,
      cohortHorizonStats,
      dataQuality: {
        averageQuoteLatencyMs: avgLatency,
        staleQuotesDetected: allForwards.filter((f) => f.outcomeStatus === "MISSING_STALE_QUOTE")
          .length,
        unavailableQuotesDetected: allForwards.filter(
          (f) => f.outcomeStatus === "MISSING_QUOTE_UNAVAILABLE",
        ).length,
      },
    };

    if (this.outputDir) {
      const summaryPath = path.join(this.outputDir, "prospective-session-summary.json");
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    }

    return summary;
  }

  // Getters for inspectability
  public getDecisionRecords(): readonly DecisionTimeObservationRecord[] {
    return Array.from(this.decisionRecords.values());
  }

  public getForwardRecords(): readonly ForwardHorizonOutcomeRecord[] {
    return Array.from(this.forwardRecords.values()).flat();
  }
}
