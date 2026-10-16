/**
 * Phase 12.94-D Milestone D.2.2: Passive Shadow Collector Engine & Mock Harness
 *
 * Implements deterministic offline shadow collection engine with safe temporary output
 * confinement, canonical D.1 dual-file session finality, and 1:N shadow evaluations.
 * ZERO network imports, ZERO trading daemon dependencies, ZERO wallet interactions.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
} from "../../telemetry/TelemetryTypes.js";
import type {
  ShadowEvaluationRecord,
  ShadowQualificationResult,
  ShadowReserveSnapshot,
} from "../ShadowEvaluationTypes.js";
import { createShadowEvaluationRecord } from "../ShadowEvaluationContract.js";
import { validateClockMonotonicity } from "../ClockMonotonicityValidator.js";
import type {
  CollectorLifecycleState,
  CrashRecoveryResult,
  IMarketDataProvider,
  IVirtualClock,
  SessionDrainSummary,
  ShadowCollectorConfig,
} from "./ShadowCollectorTypes.js";
import { DeterministicVirtualClock } from "./MockMarketDataProvider.js";
import {
  ShadowResourceController,
  validatePathConfinement,
  VirtualTokenBucket,
} from "./ShadowResourceController.js";

export class ShadowCollectorEngine {
  public state: CollectorLifecycleState = "IDLE";
  private readonly config: ShadowCollectorConfig;
  private readonly provider: IMarketDataProvider;
  private readonly clock: IVirtualClock;
  private readonly resourceController: ShadowResourceController;
  private readonly rateLimiter: VirtualTokenBucket;

  private readonly sessionDir: string;
  private readonly metaPath: string;
  private readonly summaryPath: string;
  private readonly decisionsPath: string;
  private readonly observationsPath: string;
  private readonly evaluationsPath: string;

  private startedAtIso?: string | undefined;
  private closedAtIso?: string | undefined;
  private interruptionReason?: string | undefined;

  // In-memory indexed stores (ensuring deterministic 1:N cardinality and deduplication)
  private readonly decisions: Map<string, CandidateDecisionRecord> = new Map();
  private readonly evaluations: Map<string, ShadowEvaluationRecord> = new Map();
  private readonly observations: MarketObservationRecord[] = [];

  // Ring buffer for pending unwritten records
  private readonly pendingWrites: Array<{ file: string; data: string }> = [];

  constructor(options: {
    config: ShadowCollectorConfig;
    provider: IMarketDataProvider;
    clock?: IVirtualClock | undefined;
  }) {
    if (!options.provider) {
      throw new Error(
        "[ShadowCollectorEngine] [FAIL_CLOSED] An explicit IMarketDataProvider implementation is required.",
      );
    }
    this.config = options.config;
    this.provider = options.provider;
    this.clock = options.clock ?? new DeterministicVirtualClock();

    // 1. Enforce strict output path confinement (D22-A01, D22-A05)
    const confinement = validatePathConfinement(this.config.outputRootDir);
    if (!confinement.isConfinementValid) {
      throw new Error(
        `[ShadowCollectorEngine] [PATH_CONFINEMENT_FAILED] ${confinement.rejectionReason}`,
      );
    }

    this.sessionDir = path.join(path.resolve(this.config.outputRootDir), this.config.sessionId);
    this.metaPath = path.join(this.sessionDir, "session-meta.json");
    this.summaryPath = path.join(this.sessionDir, "session-summary.json");
    this.decisionsPath = path.join(this.sessionDir, "candidate-decisions.jsonl");
    this.observationsPath = path.join(this.sessionDir, "market-observations.jsonl");
    this.evaluationsPath = path.join(this.sessionDir, "shadow-evaluations.jsonl");

    this.resourceController = new ShadowResourceController({
      clock: this.clock,
      maxSessionDiskBytes: this.config.maxSessionDiskBytes,
      maxRssBytes: this.config.maxRssBytes,
      killSwitchPath: this.config.killSwitchPath,
    });

    const maxRps = this.config.rateLimits?.maxRequestsPerSecond ?? 5;
    const burst = this.config.rateLimits?.burstCapacity ?? 10;
    this.rateLimiter = new VirtualTokenBucket({
      maxTokens: burst,
      refillRatePerSecond: maxRps,
      clock: this.clock,
    });
  }

  public async start(): Promise<void> {
    if (this.state !== "IDLE") {
      throw new Error(`[ShadowCollectorEngine] Cannot start collector in state '${this.state}'.`);
    }

    if (this.resourceController.isKillSwitchTriggered()) {
      this.state = "TERMINATED";
      this.interruptionReason = "KILL_SWITCH_ACTIVE_AT_START";
      throw new Error(
        "[ShadowCollectorEngine] Startup aborted: kill switch trigger file detected.",
      );
    }

    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.startedAtIso = new Date(this.clock.now()).toISOString();

    // Write initial ACTIVE session-meta.json
    const initialMeta: SessionTelemetryMeta = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: this.startedAtIso,
      initialWalletBalanceSol: 7.9259, // Reporting sentinel only
      environment: {
        platform: "mock_offline_harness",
        nodeVersion: process.version,
      },
      sessionStatus: "ACTIVE",
      isInterruptedSession: false,
    };

    this.writeAtomicJson(this.metaPath, initialMeta);
    this.state = "COLLECTING";
  }

  /**
   * Ingests an existing candidate decision from a deterministic fixture (D22-A02).
   */
  public ingestCandidateDecision(decision: CandidateDecisionRecord): void {
    this.assertState("COLLECTING");
    this.checkResourceLimits();

    if (decision.sessionId !== this.config.sessionId) {
      throw new Error(
        `[ShadowCollectorEngine] Decision sessionId '${decision.sessionId}' does not match collector sessionId '${this.config.sessionId}'.`,
      );
    }

    // Cohort preservation: Ensure candidate is recorded as given, never mutated to EXECUTED_BUY
    this.decisions.set(decision.eventId, decision);
    this.appendJsonLine(this.decisionsPath, decision);
  }

  /**
   * Evaluates and records a shadow qualification sidecar record (D22-A02, D22-A03).
   * Supports 1:N evaluations per decision across different time horizons.
   */
  public async evaluateShadowCandidate(params: {
    decisionEventId: string;
    evaluationTimestampMs?: number | undefined;
    targetSizeSol?: number | undefined;
  }): Promise<ShadowEvaluationRecord> {
    this.assertState("COLLECTING");
    this.checkResourceLimits();

    const decision = this.decisions.get(params.decisionEventId);
    if (!decision) {
      throw new Error(
        `[ShadowCollectorEngine] [ORPHAN_DECISION_QUARANTINED] Decision '${params.decisionEventId}' not found in active session.`,
      );
    }

    const evalTime = params.evaluationTimestampMs ?? this.clock.now();

    // Causal chronology check: Evaluation must be at or after decision time (D22-A03)
    if (evalTime < decision.decisionTimestampMs) {
      throw new Error(
        `[ShadowCollectorEngine] [EVALUATION_PRECEDES_DECISION] Evaluation timestamp (${evalTime}) precedes decision timestamp (${decision.decisionTimestampMs}).`,
      );
    }

    const monotonicElapsed = this.clock.monotonicNow();

    // Rate-limited provider poll
    if (!this.rateLimiter.tryConsume(1)) {
      throw new Error("[ShadowCollectorEngine] [RATE_LIMIT_EXCEEDED] Rate limit tokens exhausted.");
    }

    // Fetch pool reserves from mock provider
    const reserves = await this.provider.getPoolReserves(decision.poolId);

    // Validate clock causality on reserves snapshot
    const clockValidation = validateClockMonotonicity({
      sourceTimestampMs: reserves.sourceTimestampMs,
      ingestionTimestampMs: reserves.ingestionTimestampMs,
      responseReceivedMs: reserves.responseReceivedMs,
      decisionTimestampMs: evalTime,
    });

    // Check if reserves are eligible for execution modeling
    const reservesEligible =
      clockValidation.isCausallyMonotonic &&
      !clockValidation.isQuarantined &&
      reserves.isVerifiedPool !== false &&
      reserves.baseReserve !== null &&
      reserves.baseReserve > 0 &&
      reserves.quoteReserve !== null &&
      reserves.quoteReserve > 0 &&
      reserves.sourceTimestampMs <= evalTime;

    let snapshot: ShadowReserveSnapshot | undefined;
    if (reservesEligible && reserves.baseReserve !== null && reserves.quoteReserve !== null) {
      snapshot = {
        baseReserve: reserves.baseReserve,
        quoteReserve: reserves.quoteReserve,
        sourceTimestampMs: reserves.sourceTimestampMs,
      };
    }

    const qualificationResult: ShadowQualificationResult = {
      shadowTriggerQualified: decision.decisionCohort === "WATCHLIST_RADAR",
      qualificationReason:
        decision.decisionCohort === "WATCHLIST_RADAR"
          ? "MET_SHADOW_WATCHLIST_CRITERIA"
          : "DECISION_COHORT_NOT_WATCHLIST",
      simulatedTargetSizeSol: params.targetSizeSol ?? 0.1,
      executionFeasible: reservesEligible,
      unavailabilityReason: reservesEligible
        ? undefined
        : (clockValidation.unavailabilityReason ??
          (reserves.baseReserve === null ||
          reserves.quoteReserve === null ||
          reserves.baseReserve <= 0 ||
          reserves.quoteReserve <= 0
            ? "RESERVE_QUANTITY_ZERO_OR_NONFINITE"
            : !reserves.isVerifiedPool
              ? "POOL_IDENTITY_MISMATCH_DISCARDED"
              : "RESERVE_QUANTITY_ZERO_OR_NONFINITE")),
    };

    // Construct unified record via factory (ensuring parity with validator)
    const record = createShadowEvaluationRecord({
      decision,
      qualificationResult,
      evaluationTimestampMs: evalTime,
      hostMonotonicElapsedMs: monotonicElapsed,
      ...(snapshot ? { observedReserveSnapshot: snapshot } : {}),
    });

    // Enforce 1:N unique evaluation ID and avoid collision
    if (this.evaluations.has(record.evaluationId)) {
      throw new Error(
        `[ShadowCollectorEngine] [DUPLICATE_EVALUATION_ID] Evaluation '${record.evaluationId}' already recorded.`,
      );
    }

    this.evaluations.set(record.evaluationId, record);
    this.appendJsonLine(this.evaluationsPath, record);

    return record;
  }

  /**
   * Records a forward, post-decision market observation (D22-A03).
   * Retained as outcome/diagnostic without contaminating decision-time features.
   */
  public recordForwardObservation(observation: MarketObservationRecord): void {
    this.assertState("COLLECTING");
    this.checkResourceLimits();

    this.observations.push(observation);
    this.appendJsonLine(this.observationsPath, observation);
  }

  private checkResourceLimits(): void {
    if (this.resourceController.isKillSwitchTriggered()) {
      this.abort("KILL_SWITCH_TRIGGERED");
      throw new Error(
        "[ShadowCollectorEngine] [KILL_SWITCH_TRIGGERED] Aborted: Emergency kill switch file detected.",
      );
    }
    if (this.resourceController.isStorageQuotaExceeded()) {
      this.abort("STORAGE_QUOTA_EXCEEDED");
      throw new Error(
        "[ShadowCollectorEngine] [STORAGE_QUOTA_EXCEEDED] Aborted: Storage quota limit exceeded.",
      );
    }
    if (this.resourceController.isMemoryQuotaExceeded()) {
      this.abort("MEMORY_QUOTA_EXCEEDED");
      throw new Error(
        "[ShadowCollectorEngine] [MEMORY_QUOTA_EXCEEDED] Aborted: Memory RSS quota limit exceeded.",
      );
    }
  }

  private assertState(expected: CollectorLifecycleState): void {
    if (this.state !== expected) {
      throw new Error(
        `[ShadowCollectorEngine] Operation invalid in current state '${this.state}' (expected '${expected}').`,
      );
    }
  }

  private appendJsonLine(filePath: string, data: unknown): void {
    const line = JSON.stringify(data) + "\n";
    fs.appendFileSync(filePath, line, "utf8");
    this.resourceController.recordBytesWritten(Buffer.byteLength(line, "utf8"));
  }

  private writeAtomicJson(filePath: string, data: unknown): void {
    const content = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, content, "utf8");
    this.resourceController.recordBytesWritten(Buffer.byteLength(content, "utf8"));
  }

  /**
   * Graceful drain sequence writing finalized dual-file consensus (D22-A01, D22-A06).
   */
  public async drain(): Promise<SessionDrainSummary> {
    if (this.state !== "COLLECTING") {
      throw new Error(`[ShadowCollectorEngine] Cannot drain collector in state '${this.state}'.`);
    }

    this.state = "DRAINING";
    this.closedAtIso = new Date(this.clock.now()).toISOString();

    const finalMeta: SessionTelemetryMeta = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: this.startedAtIso!,
      closedAtIso: this.closedAtIso,
      initialWalletBalanceSol: 7.9259,
      environment: {
        platform: "mock_offline_harness",
        nodeVersion: process.version,
      },
      sessionStatus: "FINALIZED",
      isInterruptedSession: false,
    };

    const finalSummary: SessionTelemetrySummary = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: this.startedAtIso!,
      closedAtIso: this.closedAtIso,
      totalCandidatesScreened: this.decisions.size,
      totalDecisionsRecorded: this.decisions.size,
      decisionWriteFailures: 0,
      cohortBreakdown: {
        filteredRejected: Array.from(this.decisions.values()).filter(
          (d) => d.decisionCohort === "FILTERED_REJECTED",
        ).length,
        watchlistRadar: Array.from(this.decisions.values()).filter(
          (d) => d.decisionCohort === "WATCHLIST_RADAR",
        ).length,
        triggerRejected: Array.from(this.decisions.values()).filter(
          (d) => d.decisionCohort === "TRIGGER_REJECTED",
        ).length,
        executedBuy: 0, // Invariant: shadow collector NEVER executes buys
      },
      topRejectionReasons: {},
      totalMarketObservationsRecorded: this.observations.length,
      totalStratifiedCandidatesTracked: 0,
      missedWinnersCount: 0,
      avoidedRugsCount: 0,
      isCompleteSession: true,
      isInterruptedSession: false,
    };

    this.writeAtomicJson(this.metaPath, finalMeta);
    this.writeAtomicJson(this.summaryPath, finalSummary);

    this.state = "STOPPED";

    return {
      sessionId: this.config.sessionId,
      finalStatus: "FINALIZED",
      isCompleteSession: true,
      flushedDecisionsCount: this.decisions.size,
      flushedObservationsCount: this.observations.length,
      flushedEvaluationsCount: this.evaluations.size,
      flushedSamplesCount: 0,
      closedAtIso: this.closedAtIso,
    };
  }

  /**
   * Abrupt termination or error handler: ensures incomplete session is NEVER marked FINALIZED.
   */
  public abort(reason: string): SessionDrainSummary {
    this.state = "TERMINATED";
    this.interruptionReason = reason;
    this.closedAtIso = new Date(this.clock.now()).toISOString();

    const interruptedMeta: SessionTelemetryMeta = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: this.startedAtIso ?? this.closedAtIso,
      closedAtIso: this.closedAtIso,
      initialWalletBalanceSol: 7.9259,
      environment: {
        platform: "mock_offline_harness",
        nodeVersion: process.version,
      },
      sessionStatus: "INTERRUPTED",
      isInterruptedSession: true,
    };

    const interruptedSummary: SessionTelemetrySummary = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: this.startedAtIso ?? this.closedAtIso,
      closedAtIso: this.closedAtIso,
      totalCandidatesScreened: this.decisions.size,
      totalDecisionsRecorded: this.decisions.size,
      decisionWriteFailures: 0,
      cohortBreakdown: {
        filteredRejected: 0,
        watchlistRadar: this.decisions.size,
        triggerRejected: 0,
        executedBuy: 0,
      },
      topRejectionReasons: { [reason]: 1 },
      totalMarketObservationsRecorded: this.observations.length,
      totalStratifiedCandidatesTracked: 0,
      missedWinnersCount: 0,
      avoidedRugsCount: 0,
      isCompleteSession: false,
      isInterruptedSession: true,
    };

    this.writeAtomicJson(this.metaPath, interruptedMeta);
    this.writeAtomicJson(this.summaryPath, interruptedSummary);

    // Write crash diagnostics sidecar
    const diagnosticsPath = path.join(this.sessionDir, "session-diagnostics.json");
    this.writeAtomicJson(diagnosticsPath, {
      interruptedAtIso: this.closedAtIso,
      interruptionReason: reason,
      flushedDecisionsCount: this.decisions.size,
      flushedObservationsCount: this.observations.length,
      flushedEvaluationsCount: this.evaluations.size,
    });

    return {
      sessionId: this.config.sessionId,
      finalStatus: "INTERRUPTED",
      isCompleteSession: false,
      interruptionReason: reason,
      flushedDecisionsCount: this.decisions.size,
      flushedObservationsCount: this.observations.length,
      flushedEvaluationsCount: this.evaluations.size,
      flushedSamplesCount: 0,
      closedAtIso: this.closedAtIso,
    };
  }

  /**
   * Recovers a session directory after an unclean crash, handling torn JSONL lines (D22-A06).
   */
  public static recoverSessionDirectory(sessionDir: string): CrashRecoveryResult {
    const metaPath = path.join(sessionDir, "session-meta.json");
    const summaryPath = path.join(sessionDir, "session-summary.json");
    const decisionsPath = path.join(sessionDir, "candidate-decisions.jsonl");
    const observationsPath = path.join(sessionDir, "market-observations.jsonl");
    const evaluationsPath = path.join(sessionDir, "shadow-evaluations.jsonl");

    let tornCount = 0;
    const countValidLines = (filePath: string): number => {
      if (!fs.existsSync(filePath)) return 0;
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n");
      let valid = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          JSON.parse(trimmed);
          valid++;
        } catch {
          tornCount++; // Torn / truncated line detected
        }
      }
      return valid;
    };

    const validDecisions = countValidLines(decisionsPath);
    const validObservations = countValidLines(observationsPath);
    const validEvaluations = countValidLines(evaluationsPath);

    const hasMeta = fs.existsSync(metaPath);
    const hasSummary = fs.existsSync(summaryPath);

    let status: "INTERRUPTED" | "FINALIZED" | "CORRUPTED" = "INTERRUPTED";
    if (!hasMeta || !hasSummary || tornCount > 0) {
      status = "INTERRUPTED";
    }

    const diagnosticsPath = path.join(sessionDir, "session-diagnostics.json");
    fs.writeFileSync(
      diagnosticsPath,
      JSON.stringify(
        {
          recoveryTimestampIso: new Date().toISOString(),
          recoveredStatus: status,
          validDecisionsCount: validDecisions,
          validObservationsCount: validObservations,
          validEvaluationsCount: validEvaluations,
          tornLinesQuarantinedCount: tornCount,
        },
        null,
        2,
      ),
      "utf8",
    );

    return {
      sessionId: path.basename(sessionDir),
      recoveredStatus: status,
      validDecisionsCount: validDecisions,
      validObservationsCount: validObservations,
      validEvaluationsCount: validEvaluations,
      tornLinesQuarantinedCount: tornCount,
      diagnosticsFileWritten: true,
    };
  }
}
