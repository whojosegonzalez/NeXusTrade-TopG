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
import type { UnavailabilityReason } from "../ResearchTypes.js";
import type {
  ShadowEvaluationRecord,
  ShadowQualificationResult,
  ShadowReserveSnapshot,
} from "../ShadowEvaluationTypes.js";
import {
  createShadowEvaluationRecord,
  validateShadowEvaluationEligibility,
  validateShadowEvaluationRecord,
} from "../ShadowEvaluationContract.js";
import { validateClockMonotonicity } from "../ClockMonotonicityValidator.js";
import type {
  CollectorLifecycleState,
  CrashRecoveryResult,
  IMarketDataProvider,
  IVirtualClock,
  PointInTimeReserves,
  SessionDrainSummary,
  ShadowCollectorConfig,
} from "./ShadowCollectorTypes.js";
import { DeterministicVirtualClock, isApprovedMockProvider } from "./MockMarketDataProvider.js";
import {
  DeterministicBackoffCalculator,
  ShadowResourceController,
  validatePathConfinement,
  validateSessionId,
  VirtualTokenBucket,
} from "./ShadowResourceController.js";

/**
 * Validates the full canonical schema and identity requirements for CandidateDecisionRecord (D22C-03, D22R-02).
 */
export function isValidCandidateDecisionRecord(
  obj: unknown,
  expectedSessionId?: string,
): obj is CandidateDecisionRecord {
  if (!obj || typeof obj !== "object") return false;
  const d = obj as Record<string, unknown>;
  if (typeof d.eventId !== "string" || d.eventId.trim().length === 0) return false;
  if (typeof d.sessionId !== "string" || d.sessionId.trim().length === 0) return false;
  if (expectedSessionId && d.sessionId !== expectedSessionId) return false;
  if (typeof d.generationId !== "string" || d.generationId.trim().length === 0) return false;
  if (typeof d.mintAddress !== "string" || d.mintAddress.trim().length === 0) return false;
  if (typeof d.poolId !== "string" || d.poolId.trim().length === 0) return false;
  if (typeof d.symbol !== "string" || d.symbol.trim().length === 0) return false;
  if (
    typeof d.sourceTimestampMs !== "number" ||
    !Number.isFinite(d.sourceTimestampMs) ||
    d.sourceTimestampMs <= 0
  ) {
    return false;
  }
  if (
    typeof d.ingestionTimestampMs !== "number" ||
    !Number.isFinite(d.ingestionTimestampMs) ||
    d.ingestionTimestampMs <= 0
  ) {
    return false;
  }
  if (
    typeof d.decisionTimestampMs !== "number" ||
    !Number.isFinite(d.decisionTimestampMs) ||
    d.decisionTimestampMs <= 0
  ) {
    return false;
  }
  // Causal chronological ordering: source <= ingestion <= decision
  if (
    d.sourceTimestampMs > d.ingestionTimestampMs ||
    d.ingestionTimestampMs > d.decisionTimestampMs
  ) {
    return false;
  }
  if (typeof d.strategyRevision !== "string" || d.strategyRevision.trim().length === 0)
    return false;
  if (
    !["FILTERED_REJECTED", "WATCHLIST_RADAR", "TRIGGER_REJECTED", "EXECUTED_BUY"].includes(
      d.decisionCohort as string,
    )
  ) {
    return false;
  }
  if (!Array.isArray(d.filterEvaluations)) return false;
  if (typeof d.metricsSnapshot !== "object" || d.metricsSnapshot === null) return false;
  if (!Array.isArray(d.missingFields)) return false;
  if (typeof d.providerIdentity !== "string" || d.providerIdentity.trim().length === 0)
    return false;

  return true;
}

/**
 * Validates the full canonical schema and identity requirements for MarketObservationRecord (D22C-03, D22R-02).
 */
export function isValidMarketObservationRecord(
  obj: unknown,
  expectedSessionId?: string,
): obj is MarketObservationRecord {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.observationId !== "string" || o.observationId.trim().length === 0) return false;
  if (typeof o.sessionId !== "string" || o.sessionId.trim().length === 0) return false;
  if (expectedSessionId && o.sessionId !== expectedSessionId) return false;
  if (typeof o.generationId !== "string" || o.generationId.trim().length === 0) return false;
  if (typeof o.mintAddress !== "string" || o.mintAddress.trim().length === 0) return false;
  if (typeof o.poolId !== "string" || o.poolId.trim().length === 0) return false;
  if (
    typeof o.sourceTimestampMs !== "number" ||
    !Number.isFinite(o.sourceTimestampMs) ||
    o.sourceTimestampMs <= 0
  ) {
    return false;
  }
  if (
    typeof o.ingestionTimestampMs !== "number" ||
    !Number.isFinite(o.ingestionTimestampMs) ||
    o.ingestionTimestampMs <= 0
  ) {
    return false;
  }
  // Causal chronological ordering: source <= ingestion
  if (o.sourceTimestampMs > o.ingestionTimestampMs) {
    return false;
  }
  if (
    typeof o.dataFreshnessMs !== "number" ||
    !Number.isFinite(o.dataFreshnessMs) ||
    o.dataFreshnessMs < 0
  ) {
    return false;
  }
  if (typeof o.measurementWindow !== "object" || o.measurementWindow === null) return false;
  const mw = o.measurementWindow as Record<string, unknown>;
  if (
    typeof mw.windowStartMs !== "number" ||
    !Number.isFinite(mw.windowStartMs) ||
    typeof mw.windowEndMs !== "number" ||
    !Number.isFinite(mw.windowEndMs) ||
    typeof mw.durationSec !== "number" ||
    !Number.isFinite(mw.durationSec) ||
    mw.windowStartMs > mw.windowEndMs
  ) {
    return false;
  }
  if (typeof o.strategyRevision !== "string" || o.strategyRevision.trim().length === 0)
    return false;
  if (typeof o.providerIdentity !== "string" || o.providerIdentity.trim().length === 0)
    return false;
  if (typeof o.priceMetrics !== "object" || o.priceMetrics === null) return false;
  const pm = o.priceMetrics as Record<string, unknown>;
  if (
    typeof pm.priceSource !== "string" ||
    !["POOL_RESERVE", "ROUTE_QUOTE", "INDEXED_TICK"].includes(pm.priceSource)
  ) {
    return false;
  }
  if (typeof o.liquidityMetrics !== "object" || o.liquidityMetrics === null) return false;
  if (typeof o.flowMetrics !== "object" || o.flowMetrics === null) return false;
  if (!Array.isArray(o.missingFields)) return false;

  return true;
}

/**
 * Deep equality check for serialized research records (D22R4-02).
 * Verifies complete recursive payloads (nested financial metrics, snapshots, filter arrays, reserves).
 */
export function deepEqualRecords(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || typeof a !== "object" || b === null || typeof b !== "object") return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return false;
    for (let i = 0; i < arrA.length; i++) {
      if (!deepEqualRecords(arrA[i], arrB[i])) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;

  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined);
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined);

  if (keysA.length !== keysB.length) return false;

  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k) || objB[k] === undefined) {
      return false;
    }
    if (!deepEqualRecords(objA[k], objB[k])) {
      return false;
    }
  }

  return true;
}

export class ShadowCollectorEngine {
  public state: CollectorLifecycleState = "IDLE";
  private readonly config: ShadowCollectorConfig;
  private readonly provider: IMarketDataProvider;
  private readonly clock: IVirtualClock;
  private readonly resourceController: ShadowResourceController;
  private readonly rateLimiter: VirtualTokenBucket;
  private readonly backoffCalculator: DeterministicBackoffCalculator;

  private inFlightOps: number = 0;

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

  constructor(options: {
    config: ShadowCollectorConfig;
    provider: IMarketDataProvider;
    clock?: IVirtualClock | undefined;
  }) {
    // D22-S02: Explicit runtime mock-only provider boundary enforcement
    if (!options.provider || !isApprovedMockProvider(options.provider)) {
      throw new Error(
        `[ShadowCollectorEngine] [PROHIBITED_LIVE_PROVIDER_ATTEMPT] [MOCK_PROVIDER_REQUIRED] Provider must be an approved offline MockMarketDataProvider (got '${(options.provider as unknown as Record<string, unknown>)?.providerId ?? typeof options.provider}'). Alternate or live provider adapters are strictly prohibited in Milestone D.2.2.`,
      );
    }

    // D22-S01: Enforce strict session ID validation
    const sessionValidation = validateSessionId(options.config.sessionId);
    if (!sessionValidation.isValid) {
      throw new Error(
        `[ShadowCollectorEngine] [INVALID_SESSION_ID] Session ID '${options.config.sessionId}' is invalid: ${sessionValidation.error}`,
      );
    }

    if (!options.config.outputRootDir || options.config.outputRootDir.trim().length === 0) {
      throw new Error(
        "[ShadowCollectorEngine] [INVALID_OUTPUT_ROOT] outputRootDir must be a non-empty path.",
      );
    }

    this.config = options.config;
    this.provider = options.provider;
    this.clock = options.clock ?? new DeterministicVirtualClock();

    // D22-S01: Safe resolution of the complete session path and symlink-aware verification before write
    const resolvedOutputRoot = path.resolve(this.config.outputRootDir);
    const targetSessionDir = path.resolve(resolvedOutputRoot, this.config.sessionId);

    const confinement = validatePathConfinement(targetSessionDir, {
      allowedRoot: resolvedOutputRoot,
    });
    if (!confinement.isConfinementValid) {
      throw new Error(
        `[ShadowCollectorEngine] [PATH_CONFINEMENT_VIOLATION] Output path confinement rejected: ${confinement.rejectionReason}`,
      );
    }

    this.sessionDir = confinement.resolvedPath;
    this.metaPath = path.join(this.sessionDir, "session-meta.json");
    this.summaryPath = path.join(this.sessionDir, "session-summary.json");
    this.decisionsPath = path.join(this.sessionDir, "candidate-decisions.jsonl");
    this.observationsPath = path.join(this.sessionDir, "market-observations.jsonl");
    this.evaluationsPath = path.join(this.sessionDir, "shadow-evaluations.jsonl");

    this.resourceController = new ShadowResourceController({
      clock: this.clock,
      maxSessionDiskBytes: this.config.maxSessionDiskBytes,
      maxEmergencyMetadataBytes: this.config.maxEmergencyMetadataBytes,
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

    this.backoffCalculator = new DeterministicBackoffCalculator({
      baseMs: this.config.rateLimits?.retryBackoffBaseMs ?? 50,
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

    this.startedAtIso = new Date(this.clock.now()).toISOString();

    // Prepare initial ACTIVE session-meta.json
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

    const metaContent = JSON.stringify(initialMeta, null, 2);
    const metaBytes = Buffer.byteLength(metaContent, "utf8");

    // D22-S05: Preflight admission check for metadata write
    try {
      this.resourceController.checkWriteAdmission(metaBytes);
    } catch (err: unknown) {
      this.state = "TERMINATED";
      this.interruptionReason = "STORAGE_QUOTA_EXCEEDED";
      throw err;
    }

    // Ensure session directory exists
    fs.mkdirSync(this.sessionDir, { recursive: true });

    this.writeAtomicJson(this.metaPath, initialMeta);
    this.state = "COLLECTING";
  }

  /**
   * Ingests an existing candidate decision from a deterministic fixture (D22-A02, D22-S04).
   */
  public ingestCandidateDecision(decision: CandidateDecisionRecord): void {
    this.assertState("COLLECTING");
    this.checkResourceLimits();

    // D22-S04: Attribution validation
    if (decision.sessionId !== this.config.sessionId) {
      throw new Error(
        `[ShadowCollectorEngine] [FOREIGN_DECISION_ATTRIBUTION] Candidate decision sessionId '${decision.sessionId}' does not match collector sessionId '${this.config.sessionId}'.`,
      );
    }
    if (decision.generationId !== this.config.generationId) {
      throw new Error(
        `[ShadowCollectorEngine] [FOREIGN_DECISION_ATTRIBUTION] Candidate decision generationId '${decision.generationId}' does not match collector generationId '${this.config.generationId}'.`,
      );
    }

    // D22R-02: Full canonical schema validation on candidate ingestion
    const candidateObj = decision as unknown as Record<string, unknown>;
    if (!isValidCandidateDecisionRecord(decision, this.config.sessionId)) {
      throw new Error(
        `[ShadowCollectorEngine] [INVALID_CANDIDATE_DECISION_SCHEMA] Candidate decision '${candidateObj?.eventId}' failed canonical schema validation.`,
      );
    }

    // D22-S04: Reject duplicate eventId BEFORE appending to JSONL
    if (this.decisions.has(decision.eventId)) {
      throw new Error(
        `[ShadowCollectorEngine] [DUPLICATE_DECISION_ID] Candidate decision '${decision.eventId}' is already ingested in this session.`,
      );
    }

    // Cohort preservation & D22R4-02: Ensure candidate is recorded as given, capturing immutable append-time baseline
    const appendSnapshot = JSON.parse(JSON.stringify(decision)) as CandidateDecisionRecord;
    this.appendJsonLine(this.decisionsPath, appendSnapshot);
    this.decisions.set(appendSnapshot.eventId, appendSnapshot);
  }

  /**
   * Evaluates and records a shadow qualification sidecar record (D22-A02, D22-A03, D22-S03).
   * Supports 1:N evaluations per decision across different time horizons.
   */
  public async evaluateShadowCandidate(params: {
    decisionEventId: string;
    evaluationTimestampMs?: number | undefined;
    targetSizeSol?: number | undefined;
  }): Promise<ShadowEvaluationRecord> {
    this.assertState("COLLECTING");
    this.checkResourceLimits();

    this.inFlightOps++;
    try {
      const decision = this.decisions.get(params.decisionEventId);
      if (!decision) {
        throw new Error(
          `[ShadowCollectorEngine] [ORPHAN_DECISION_QUARANTINED] [ORPHAN_DECISION_REJECTED] Decision '${params.decisionEventId}' not found in active session.`,
        );
      }

      const monotonicElapsed = this.clock.monotonicNow();

      // Rate-limited provider poll
      if (!this.rateLimiter.tryConsume(1)) {
        throw new Error(
          "[ShadowCollectorEngine] [RATE_LIMIT_EXCEEDED] Rate limit tokens exhausted.",
        );
      }

      // D22R-01: Call-time mock-only provider boundary enforcement
      if (!isApprovedMockProvider(this.provider)) {
        throw new Error(
          `[ShadowCollectorEngine] [PROHIBITED_LIVE_PROVIDER_ATTEMPT] [MOCK_PROVIDER_TAMPERED] Provider failed mock-only call-time attestation. Post-construction method substitution or unauthorized helper override detected.`,
        );
      }

      // D22-S05: Fetch pool reserves with backoff retry on 429/503
      let reserves: PointInTimeReserves;
      let attempt = 0;
      const maxRetries = this.config.rateLimits?.maxRetryAttempts ?? 2;
      while (true) {
        try {
          if (!isApprovedMockProvider(this.provider)) {
            throw new Error(
              `[ShadowCollectorEngine] [PROHIBITED_LIVE_PROVIDER_ATTEMPT] [MOCK_PROVIDER_TAMPERED] Provider failed mock-only call-time attestation.`,
            );
          }
          reserves = await this.provider.getPoolReserves(decision.poolId);
          break;
        } catch (err: unknown) {
          const e = err as { status?: number };
          if ((e?.status === 429 || e?.status === 503) && attempt < maxRetries) {
            attempt++;
            const backoffMs = this.backoffCalculator.getDelayMs(attempt);
            this.clock.advanceBy(backoffMs);
            continue;
          }
          throw err;
        }
      }

      const evalTime = params.evaluationTimestampMs ?? this.clock.now();

      // Causal chronology check: Evaluation must be at or after decision time (D22-A03)
      if (evalTime < decision.decisionTimestampMs) {
        throw new Error(
          `[ShadowCollectorEngine] [EVALUATION_PRECEDES_DECISION] Evaluation timestamp (${evalTime}) precedes decision timestamp (${decision.decisionTimestampMs}).`,
        );
      }

      // D22C-02: Validate decision-time clock causality against decision.decisionTimestampMs
      const decisionClockValidation = validateClockMonotonicity({
        sourceTimestampMs: reserves.sourceTimestampMs,
        ingestionTimestampMs: reserves.ingestionTimestampMs,
        responseReceivedMs: reserves.responseReceivedMs,
        decisionTimestampMs: decision.decisionTimestampMs,
      });

      // Also validate evaluation-time clock causality (evalTime >= responseReceivedMs)
      const evalClockValidation = validateClockMonotonicity({
        sourceTimestampMs: reserves.sourceTimestampMs,
        ingestionTimestampMs: reserves.ingestionTimestampMs,
        responseReceivedMs: reserves.responseReceivedMs,
        decisionTimestampMs: evalTime,
      });

      // D22-S03 & D22C-02: Verified pool, vault, and causal reserve provenance
      let unavailabilityReason: UnavailabilityReason | undefined;
      let reservesEligible = false;

      if (!evalClockValidation.isCausallyMonotonic || evalClockValidation.isQuarantined) {
        unavailabilityReason =
          evalClockValidation.unavailabilityReason ?? "IMPOSSIBLE_TIMESTAMP_ORDERING";
      } else if (reserves.poolId !== decision.poolId) {
        unavailabilityReason = "POOL_IDENTITY_MISMATCH_DISCARDED";
      } else if (reserves.isVerifiedPool !== true) {
        unavailabilityReason = "POOL_IDENTITY_MISMATCH_DISCARDED";
      } else if (
        !reserves.vaultA ||
        !reserves.vaultB ||
        typeof reserves.vaultA !== "string" ||
        typeof reserves.vaultB !== "string" ||
        reserves.vaultA.trim().length === 0 ||
        reserves.vaultB.trim().length === 0
      ) {
        unavailabilityReason = "POOL_IDENTITY_MISMATCH_DISCARDED";
      } else if (
        reserves.baseReserve === null ||
        reserves.quoteReserve === null ||
        !Number.isFinite(reserves.baseReserve) ||
        !Number.isFinite(reserves.quoteReserve) ||
        reserves.baseReserve <= 0 ||
        reserves.quoteReserve <= 0
      ) {
        unavailabilityReason = "RESERVE_QUANTITY_ZERO_OR_NONFINITE";
      } else if (
        !decisionClockValidation.isCausallyMonotonic ||
        decisionClockValidation.isQuarantined ||
        reserves.sourceTimestampMs > decision.decisionTimestampMs ||
        reserves.ingestionTimestampMs > decision.decisionTimestampMs ||
        reserves.responseReceivedMs > decision.decisionTimestampMs
      ) {
        // D22C-02: Snapshot was not available at decision time (source, ingestion, or receipt after decision)
        unavailabilityReason = "LATE_RECEIPT_LOOKAHEAD_PREVENTION";
      } else if (reserves.sourceTimestampMs > evalTime || reserves.responseReceivedMs > evalTime) {
        unavailabilityReason = "LATE_RECEIPT_LOOKAHEAD_PREVENTION";
      } else {
        reservesEligible = true;
      }

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
        unavailabilityReason,
      };

      // Construct unified record via factory (ensuring parity with validator)
      const record = createShadowEvaluationRecord({
        decision,
        qualificationResult,
        evaluationTimestampMs: evalTime,
        hostMonotonicElapsedMs: monotonicElapsed,
        ...(snapshot ? { observedReserveSnapshot: snapshot } : {}),
      });

      // D22-S03: Parity check against accepted D.2.1 eligibility contract
      const eligibility = validateShadowEvaluationEligibility(record, decision);
      if (record.qualificationResult.executionFeasible && !eligibility.executionFeasible) {
        throw new Error(
          `[ShadowCollectorEngine] [ELIGIBILITY_PARITY_ERROR] Record declared executionFeasible but failed D.2.1 eligibility check: ${eligibility.rejectionReasons.join("; ")}`,
        );
      }

      // D22-S04: Enforce 1:N unique evaluation ID and avoid collision
      if (this.evaluations.has(record.evaluationId)) {
        throw new Error(
          `[ShadowCollectorEngine] [DUPLICATE_EVALUATION_ID] Evaluation '${record.evaluationId}' already recorded.`,
        );
      }

      // Check state again before writing (in case drain was triggered during async wait)
      this.assertState("COLLECTING");

      // D22R4-02: Capture immutable append-time baseline via deep clone
      const appendSnapshot = JSON.parse(JSON.stringify(record)) as ShadowEvaluationRecord;
      this.appendJsonLine(this.evaluationsPath, appendSnapshot);
      this.evaluations.set(appendSnapshot.evaluationId, appendSnapshot);

      return record;
    } finally {
      this.inFlightOps--;
    }
  }

  /**
   * Records a forward, post-decision market observation (D22-A03, D22-S04).
   * Retained as outcome/diagnostic without contaminating decision-time features.
   */
  public recordForwardObservation(observation: MarketObservationRecord): void {
    this.assertState("COLLECTING");
    this.checkResourceLimits();

    // D22-S04: Attribution validation
    if (observation.sessionId !== this.config.sessionId) {
      throw new Error(
        `[ShadowCollectorEngine] [FOREIGN_OBSERVATION_ATTRIBUTION] Observation sessionId '${observation.sessionId}' does not match collector sessionId '${this.config.sessionId}'.`,
      );
    }
    if (observation.generationId !== this.config.generationId) {
      throw new Error(
        `[ShadowCollectorEngine] [FOREIGN_OBSERVATION_ATTRIBUTION] Observation generationId '${observation.generationId}' does not match collector generationId '${this.config.generationId}'.`,
      );
    }

    // D22R-02: Full canonical schema validation on observation recording
    const obsObj = observation as unknown as Record<string, unknown>;
    if (!isValidMarketObservationRecord(observation, this.config.sessionId)) {
      throw new Error(
        `[ShadowCollectorEngine] [INVALID_MARKET_OBSERVATION_SCHEMA] Observation '${obsObj?.observationId}' failed canonical schema validation.`,
      );
    }

    // D22-S04: Must match an ingested decision for pool and mint
    const matchingDecision = Array.from(this.decisions.values()).find(
      (d) => d.poolId === observation.poolId && d.mintAddress === observation.mintAddress,
    );
    if (!matchingDecision) {
      throw new Error(
        `[ShadowCollectorEngine] [FOREIGN_OBSERVATION_ATTRIBUTION] [ORPHAN_OBSERVATION_REJECTED] Forward observation '${observation.observationId}' (pool: '${observation.poolId}', mint: '${observation.mintAddress}') has no matching candidate decision in session.`,
      );
    }

    // D22-S04: Temporal causality check
    if (observation.sourceTimestampMs < matchingDecision.decisionTimestampMs) {
      throw new Error(
        `[ShadowCollectorEngine] [OBSERVATION_PRECEDES_DECISION] [PRE_DECISION_FORWARD_OBSERVATION] Forward observation source time (${observation.sourceTimestampMs}) precedes matching decision time (${matchingDecision.decisionTimestampMs}).`,
      );
    }
    if (observation.ingestionTimestampMs < observation.sourceTimestampMs) {
      throw new Error(
        `[ShadowCollectorEngine] [IMPOSSIBLE_TIMESTAMP_ORDERING] Observation ingestion time (${observation.ingestionTimestampMs}) precedes source time (${observation.sourceTimestampMs}).`,
      );
    }
    if (
      observation.responseReceivedMs !== undefined &&
      observation.responseReceivedMs < observation.ingestionTimestampMs
    ) {
      throw new Error(
        `[ShadowCollectorEngine] [IMPOSSIBLE_TIMESTAMP_ORDERING] Observation response receipt time (${observation.responseReceivedMs}) precedes ingestion time (${observation.ingestionTimestampMs}).`,
      );
    }

    // D22-S04: Duplicate observation ID check
    if (this.observations.some((o) => o.observationId === observation.observationId)) {
      throw new Error(
        `[ShadowCollectorEngine] [DUPLICATE_OBSERVATION_ID] Observation '${observation.observationId}' already recorded.`,
      );
    }

    // D22R4-02: Capture immutable append-time baseline via deep clone
    const appendSnapshot = JSON.parse(JSON.stringify(observation)) as MarketObservationRecord;
    this.appendJsonLine(this.observationsPath, appendSnapshot);
    this.observations.push(appendSnapshot);
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
    const bytes = Buffer.byteLength(line, "utf8");
    try {
      this.resourceController.checkWriteAdmission(bytes);
    } catch (err) {
      this.abort("STORAGE_QUOTA_EXCEEDED");
      throw err;
    }
    fs.appendFileSync(filePath, line, "utf8");
    this.resourceController.recordBytesWritten(bytes, false);
  }

  private writeAtomicJson(filePath: string, data: unknown, isEmergency = false): void {
    const content = JSON.stringify(data, null, 2);
    const bytes = Buffer.byteLength(content, "utf8");
    if (isEmergency) {
      // D22C-04: Emergency writes (meta, summary, diagnostics) are admitted against the dedicated emergency allowance
      this.resourceController.checkEmergencyWriteAdmission(bytes);
    } else {
      try {
        this.resourceController.checkWriteAdmission(bytes);
      } catch (err) {
        this.abort("STORAGE_QUOTA_EXCEEDED");
        throw err;
      }
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = path.join(
      dir,
      `.tmp.${path.basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
    );
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
    this.resourceController.recordBytesWritten(bytes, isEmergency);
  }

  /**
   * Graceful drain sequence writing finalized dual-file consensus (D22-A01, D22-A06, D22-S04, D22C-03).
   */
  public async drain(): Promise<SessionDrainSummary> {
    if (this.state !== "COLLECTING") {
      throw new Error(`[ShadowCollectorEngine] Cannot drain collector in state '${this.state}'.`);
    }

    this.state = "DRAINING";

    // D22-S04: Await or cancel all in-flight operations before finalizing
    const drainTimeoutMs = this.config.drainTimeoutMs ?? 5000;
    const startWaitMs = Date.now();
    while (this.inFlightOps > 0) {
      if (Date.now() - startWaitMs > drainTimeoutMs) {
        return this.abort("DRAIN_TIMEOUT_IN_FLIGHT_OPERATIONS");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // D22C-03 & D22R-02: Parse, full-schema validate, and verify exact identity/count/foreign-keys of all on-disk records before claiming FINALIZED
    const readAndValidateStream = <T>(
      filePath: string,
      validator: (item: unknown) => boolean,
      getId: (item: T) => string,
    ): { count: number; ids: Set<string>; records: T[]; error?: string | undefined } => {
      if (!fs.existsSync(filePath)) return { count: 0, ids: new Set(), records: [] };
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n");
      const ids = new Set<string>();
      const records: T[] = [];
      let validCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return {
            count: validCount,
            ids,
            records,
            error: `RECONCILIATION_PARSE_ERROR: '${path.basename(filePath)}' line ${i + 1} is not valid JSON.`,
          };
        }

        if (!validator(parsed)) {
          return {
            count: validCount,
            ids,
            records,
            error: `RECONCILIATION_SCHEMA_INVALID: '${path.basename(filePath)}' line ${i + 1} failed schema or session-id validation.`,
          };
        }

        const id = getId(parsed as T);
        if (ids.has(id)) {
          return {
            count: validCount,
            ids,
            records,
            error: `RECONCILIATION_DUPLICATE_ID: '${path.basename(filePath)}' contains duplicate ID '${id}'.`,
          };
        }
        ids.add(id);
        records.push(parsed as T);
        validCount++;
      }

      return { count: validCount, ids, records };
    };

    const decisionsCheck = readAndValidateStream<CandidateDecisionRecord>(
      this.decisionsPath,
      (item) => isValidCandidateDecisionRecord(item, this.config.sessionId),
      (item) => item.eventId,
    );
    if (decisionsCheck.error) {
      return this.abort(decisionsCheck.error);
    }

    if (decisionsCheck.count !== this.decisions.size) {
      return this.abort(
        `RECONCILIATION_COUNT_MISMATCH: decisions disk=${decisionsCheck.count}/mem=${this.decisions.size}`,
      );
    }

    // D22R-02 Reproduction A: Verify exact 1:1 decision identity and content matching against in-memory records
    for (const d of decisionsCheck.records) {
      if (!this.decisions.has(d.eventId)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: Persisted decision ID '${d.eventId}' was not recorded by in-memory session.`,
        );
      }
      const mem = this.decisions.get(d.eventId)!;
      if (!deepEqualRecords(d, mem)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: Persisted decision '${d.eventId}' content does not match append-time record (tampered metrics or payload detected).`,
        );
      }
    }
    for (const memId of this.decisions.keys()) {
      if (!decisionsCheck.ids.has(memId)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: In-memory decision '${memId}' is missing from persisted records.`,
        );
      }
    }

    const observationsCheck = readAndValidateStream<MarketObservationRecord>(
      this.observationsPath,
      (item) => isValidMarketObservationRecord(item, this.config.sessionId),
      (item) => item.observationId,
    );
    if (observationsCheck.error) {
      return this.abort(observationsCheck.error);
    }

    if (observationsCheck.count !== this.observations.length) {
      return this.abort(
        `RECONCILIATION_COUNT_MISMATCH: observations disk=${observationsCheck.count}/mem=${this.observations.length}`,
      );
    }

    const memObsMap = new Map(this.observations.map((o) => [o.observationId, o]));
    for (const o of observationsCheck.records) {
      if (!memObsMap.has(o.observationId)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: Persisted observation ID '${o.observationId}' was not recorded by in-memory session.`,
        );
      }
      const mem = memObsMap.get(o.observationId)!;
      if (!deepEqualRecords(o, mem)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: Persisted observation '${o.observationId}' content does not match append-time record (tampered metrics or payload detected).`,
        );
      }
    }
    for (const memId of memObsMap.keys()) {
      if (!observationsCheck.ids.has(memId)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: In-memory observation '${memId}' is missing from persisted records.`,
        );
      }
    }

    const evaluationsCheck = readAndValidateStream<ShadowEvaluationRecord>(
      this.evaluationsPath,
      (item) => {
        try {
          const rec = validateShadowEvaluationRecord(item);
          return rec.sessionId === this.config.sessionId;
        } catch {
          return false;
        }
      },
      (item) => item.evaluationId,
    );
    if (evaluationsCheck.error) {
      return this.abort(evaluationsCheck.error);
    }

    if (evaluationsCheck.count !== this.evaluations.size) {
      return this.abort(
        `RECONCILIATION_COUNT_MISMATCH: evaluations disk=${evaluationsCheck.count}/mem=${this.evaluations.size}`,
      );
    }

    // D22R-02 Reproduction C: Verify 1:N composite foreign keys and orphan prevention in drain path
    for (const ev of evaluationsCheck.records) {
      if (!this.evaluations.has(ev.evaluationId)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: Persisted evaluation ID '${ev.evaluationId}' was not recorded by in-memory session.`,
        );
      }
      if (!decisionsCheck.ids.has(ev.decisionEventId)) {
        return this.abort(
          `RECONCILIATION_ORPHAN_EVALUATION: Persisted evaluation '${ev.evaluationId}' references non-existent decision '${ev.decisionEventId}'.`,
        );
      }
      const refDec = this.decisions.get(ev.decisionEventId)!;
      if (
        refDec.sessionId !== ev.sessionId ||
        refDec.generationId !== ev.generationId ||
        refDec.mintAddress !== ev.mintAddress ||
        refDec.poolId !== ev.poolId
      ) {
        return this.abort(
          `RECONCILIATION_FOREIGN_KEY_MISMATCH: Persisted evaluation '${ev.evaluationId}' composite foreign key does not match referenced decision '${ev.decisionEventId}'.`,
        );
      }
      const mem = this.evaluations.get(ev.evaluationId)!;
      if (!deepEqualRecords(ev, mem)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: Persisted evaluation '${ev.evaluationId}' content does not match append-time record (tampered reserves or qualification payload detected).`,
        );
      }
    }
    for (const memId of this.evaluations.keys()) {
      if (!evaluationsCheck.ids.has(memId)) {
        return this.abort(
          `RECONCILIATION_IDENTITY_MISMATCH: In-memory evaluation '${memId}' is missing from persisted records.`,
        );
      }
    }

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

    // D22-S05: Preflight admission check for final metadata
    const metaBytes = Buffer.byteLength(JSON.stringify(finalMeta, null, 2), "utf8");
    const summaryBytes = Buffer.byteLength(JSON.stringify(finalSummary, null, 2), "utf8");
    try {
      this.resourceController.checkWriteAdmission(metaBytes + summaryBytes);
    } catch {
      return this.abort("STORAGE_QUOTA_EXCEEDED");
    }

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

    try {
      this.writeAtomicJson(this.metaPath, interruptedMeta, true);
      this.writeAtomicJson(this.summaryPath, interruptedSummary, true);
    } catch {
      // Best-effort write on abort if filesystem fails
    }

    // Write crash diagnostics sidecar
    const diagnosticsPath = path.join(this.sessionDir, "session-diagnostics.json");
    try {
      this.writeAtomicJson(
        diagnosticsPath,
        {
          interruptedAtIso: this.closedAtIso,
          interruptionReason: reason,
          flushedDecisionsCount: this.decisions.size,
          flushedObservationsCount: this.observations.length,
          flushedEvaluationsCount: this.evaluations.size,
        },
        true,
      );
    } catch {
      // Best-effort
    }

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
   * Recovers a session directory after an unclean crash, quarantines torn/schema-invalid lines,
   * repairs active streams, checks identity/count consensus, and updates on-disk finality metadata (D22-A06, D22-S05, D22C-03).
   */
  public static recoverSessionDirectory(sessionDir: string): CrashRecoveryResult {
    const metaPath = path.join(sessionDir, "session-meta.json");
    const summaryPath = path.join(sessionDir, "session-summary.json");
    const decisionsPath = path.join(sessionDir, "candidate-decisions.jsonl");
    const observationsPath = path.join(sessionDir, "market-observations.jsonl");
    const evaluationsPath = path.join(sessionDir, "shadow-evaluations.jsonl");

    let totalTornCount = 0;
    let totalSchemaInvalidCount = 0;
    const repairedFiles: string[] = [];
    const quarantinedFiles: string[] = [];
    const failureReasons: string[] = [];

    const hasMeta = fs.existsSync(metaPath);
    const hasSummary = fs.existsSync(summaryPath);

    let meta: SessionTelemetryMeta | null = null;
    let summary: SessionTelemetrySummary | null = null;

    if (hasMeta) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        meta = null;
        failureReasons.push("UNPARSEABLE_SESSION_META");
      }
    } else {
      failureReasons.push("MISSING_SESSION_META");
    }

    if (hasSummary) {
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      } catch {
        summary = null;
        failureReasons.push("UNPARSEABLE_SESSION_SUMMARY");
      }
    } else {
      failureReasons.push("MISSING_SESSION_SUMMARY");
    }

    const declaredSessionId = meta?.sessionId ?? summary?.sessionId ?? path.basename(sessionDir);

    // D22C-03: Deep validation and repair of JSONL streams (syntax, schema, session identity, unique IDs)
    const repairAndValidateStream = <T>(
      filePath: string,
      validator: (item: unknown) => boolean,
      getId: (item: T) => string,
    ): { validRecords: T[]; validIds: Set<string> } => {
      if (!fs.existsSync(filePath)) return { validRecords: [], validIds: new Set() };
      const raw = fs.readFileSync(filePath, "utf8");
      const lines = raw.split("\n");
      const validLines: string[] = [];
      const validRecords: T[] = [];
      const validIds = new Set<string>();
      let fileCorruptCount = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          totalTornCount++;
          fileCorruptCount++;
          failureReasons.push(`SYNTAX_ERROR_${path.basename(filePath)}_LINE_${i + 1}`);
          continue;
        }

        if (!validator(parsed)) {
          totalSchemaInvalidCount++;
          fileCorruptCount++;
          failureReasons.push(`SCHEMA_OR_SESSION_INVALID_${path.basename(filePath)}_LINE_${i + 1}`);
          continue;
        }

        const id = getId(parsed as T);
        if (validIds.has(id)) {
          totalSchemaInvalidCount++;
          fileCorruptCount++;
          failureReasons.push(`DUPLICATE_ID_${id}_IN_${path.basename(filePath)}`);
          continue;
        }

        validIds.add(id);
        validRecords.push(parsed as T);
        validLines.push(trimmed);
      }

      if (fileCorruptCount > 0) {
        const corruptPath = `${filePath}.corrupt-${Date.now()}`;
        fs.copyFileSync(filePath, corruptPath);
        quarantinedFiles.push(path.basename(corruptPath));

        const tempPath = `${filePath}.repaired-${Date.now()}`;
        const repairedContent = validLines.length > 0 ? validLines.join("\n") + "\n" : "";
        fs.writeFileSync(tempPath, repairedContent, "utf8");
        fs.renameSync(tempPath, filePath);
        repairedFiles.push(path.basename(filePath));
      }

      return { validRecords, validIds };
    };

    const decisionsResult = repairAndValidateStream<CandidateDecisionRecord>(
      decisionsPath,
      (item) => isValidCandidateDecisionRecord(item, declaredSessionId),
      (item) => item.eventId,
    );

    const observationsResult = repairAndValidateStream<MarketObservationRecord>(
      observationsPath,
      (item) => isValidMarketObservationRecord(item, declaredSessionId),
      (item) => item.observationId,
    );

    // D22R-02 Reproduction C: Evaluations must validate schema, link to valid decision in this session, and match composite FK
    const evaluationsResult = repairAndValidateStream<ShadowEvaluationRecord>(
      evaluationsPath,
      (item) => {
        try {
          const rec = validateShadowEvaluationRecord(item);
          if (rec.sessionId !== declaredSessionId) return false;
          if (!decisionsResult.validIds.has(rec.decisionEventId)) return false;
          const refDec = decisionsResult.validRecords.find(
            (d) => d.eventId === rec.decisionEventId,
          );
          if (!refDec) return false;
          if (
            refDec.sessionId !== rec.sessionId ||
            refDec.generationId !== rec.generationId ||
            refDec.mintAddress !== rec.mintAddress ||
            refDec.poolId !== rec.poolId
          ) {
            return false;
          }
          return true;
        } catch {
          return false;
        }
      },
      (item) => item.evaluationId,
    );

    const validDecisions = decisionsResult.validRecords.length;
    const validObservations = observationsResult.validRecords.length;
    const validEvaluations = evaluationsResult.validRecords.length;

    // Verify foreign keys: all evaluations must point to a valid decision in this session
    for (const ev of evaluationsResult.validRecords) {
      if (!decisionsResult.validIds.has(ev.decisionEventId)) {
        failureReasons.push(`ORPHAN_EVALUATION_${ev.evaluationId}_DECISION_${ev.decisionEventId}`);
      }
    }

    // D22R-02 Reproduction D: Strict Dual-File Metadata-Summary Consensus Checks
    if (meta !== null && summary !== null) {
      if (meta.sessionId !== summary.sessionId) {
        failureReasons.push(
          `METADATA_SUMMARY_SESSION_ID_MISMATCH: meta=${meta.sessionId}, summary=${summary.sessionId}`,
        );
      }
      if (meta.generationId !== summary.generationId) {
        failureReasons.push(
          `METADATA_SUMMARY_GENERATION_ID_MISMATCH: meta=${meta.generationId}, summary=${summary.generationId}`,
        );
      }
      if (meta.strategyRevision !== summary.strategyRevision) {
        failureReasons.push(
          `METADATA_SUMMARY_STRATEGY_REVISION_MISMATCH: meta=${meta.strategyRevision}, summary=${summary.strategyRevision}`,
        );
      }
      if (meta.startedAtIso !== summary.startedAtIso) {
        failureReasons.push(
          `METADATA_SUMMARY_STARTED_AT_MISMATCH: meta=${meta.startedAtIso}, summary=${summary.startedAtIso}`,
        );
      }
      if (meta.closedAtIso !== summary.closedAtIso) {
        failureReasons.push(
          `METADATA_SUMMARY_CLOSED_AT_MISMATCH: meta=${meta.closedAtIso}, summary=${summary.closedAtIso}`,
        );
      }
      if (
        meta.sessionStatus !== "FINALIZED" ||
        meta.isInterruptedSession !== false ||
        summary.isCompleteSession !== true ||
        summary.isInterruptedSession !== false
      ) {
        failureReasons.push(
          `METADATA_SUMMARY_STATUS_MISMATCH: metaStatus=${meta.sessionStatus}, metaInterrupted=${meta.isInterruptedSession}, summaryComplete=${summary.isCompleteSession}, summaryInterrupted=${summary.isInterruptedSession}`,
        );
      }
      const breakdownSum =
        (summary.cohortBreakdown?.filteredRejected ?? 0) +
        (summary.cohortBreakdown?.watchlistRadar ?? 0) +
        (summary.cohortBreakdown?.triggerRejected ?? 0) +
        (summary.cohortBreakdown?.executedBuy ?? 0);
      if (breakdownSum !== summary.totalDecisionsRecorded) {
        failureReasons.push(
          `COHORT_BREAKDOWN_SUM_MISMATCH: breakdownSum=${breakdownSum}, totalDecisionsRecorded=${summary.totalDecisionsRecorded}`,
        );
      }
      if (summary.totalDecisionsRecorded !== validDecisions) {
        failureReasons.push(
          `DECISIONS_COUNT_MISMATCH: summary=${summary.totalDecisionsRecorded}, validOnDisk=${validDecisions}`,
        );
      }
      if (summary.totalMarketObservationsRecorded !== validObservations) {
        failureReasons.push(
          `OBSERVATIONS_COUNT_MISMATCH: summary=${summary.totalMarketObservationsRecorded}, validOnDisk=${validObservations}`,
        );
      }
      const actualCohorts = {
        filteredRejected: 0,
        watchlistRadar: 0,
        triggerRejected: 0,
        executedBuy: 0,
      };
      for (const dec of decisionsResult.validRecords) {
        if (dec.decisionCohort === "FILTERED_REJECTED") actualCohorts.filteredRejected++;
        else if (dec.decisionCohort === "WATCHLIST_RADAR") actualCohorts.watchlistRadar++;
        else if (dec.decisionCohort === "TRIGGER_REJECTED") actualCohorts.triggerRejected++;
        else if (dec.decisionCohort === "EXECUTED_BUY") actualCohorts.executedBuy++;
      }
      if (
        actualCohorts.filteredRejected !== (summary.cohortBreakdown?.filteredRejected ?? 0) ||
        actualCohorts.watchlistRadar !== (summary.cohortBreakdown?.watchlistRadar ?? 0) ||
        actualCohorts.triggerRejected !== (summary.cohortBreakdown?.triggerRejected ?? 0) ||
        actualCohorts.executedBuy !== (summary.cohortBreakdown?.executedBuy ?? 0)
      ) {
        failureReasons.push(
          `COHORT_BREAKDOWN_MISMATCH_WITH_RECORDS: disk=${JSON.stringify(actualCohorts)}, summary=${JSON.stringify(summary.cohortBreakdown)}`,
        );
      }
    }

    // Determine authoritative recovered status (D22C-03, D22R-02)
    const isCleanFinalized =
      totalTornCount === 0 &&
      totalSchemaInvalidCount === 0 &&
      failureReasons.length === 0 &&
      meta !== null &&
      summary !== null &&
      meta.sessionStatus === "FINALIZED" &&
      meta.isInterruptedSession === false &&
      summary.isCompleteSession === true &&
      summary.isInterruptedSession === false &&
      summary.totalDecisionsRecorded === validDecisions &&
      summary.totalMarketObservationsRecorded === validObservations;

    let status: "INTERRUPTED" | "FINALIZED" | "CORRUPTED" = "INTERRUPTED";

    if (isCleanFinalized) {
      status = "FINALIZED";
    } else {
      status = "INTERRUPTED";
      const recoveryTimestampIso = new Date().toISOString();
      const updatedMeta: SessionTelemetryMeta = {
        sessionId: meta?.sessionId ?? path.basename(sessionDir),
        generationId: meta?.generationId ?? "gen-1",
        strategyRevision: meta?.strategyRevision ?? "unknown",
        startedAtIso: meta?.startedAtIso ?? recoveryTimestampIso,
        closedAtIso: recoveryTimestampIso,
        initialWalletBalanceSol: meta?.initialWalletBalanceSol ?? 7.9259,
        environment: meta?.environment ?? {
          platform: "mock_offline_harness",
          nodeVersion: process.version,
        },
        sessionStatus: "INTERRUPTED",
        isInterruptedSession: true,
      };

      const updatedSummary: SessionTelemetrySummary = {
        sessionId: summary?.sessionId ?? path.basename(sessionDir),
        generationId: summary?.generationId ?? "gen-1",
        strategyRevision: summary?.strategyRevision ?? "unknown",
        startedAtIso: summary?.startedAtIso ?? recoveryTimestampIso,
        closedAtIso: recoveryTimestampIso,
        totalCandidatesScreened: validDecisions,
        totalDecisionsRecorded: validDecisions,
        decisionWriteFailures: 0,
        cohortBreakdown: summary?.cohortBreakdown ?? {
          filteredRejected: 0,
          watchlistRadar: validDecisions,
          triggerRejected: 0,
          executedBuy: 0,
        },
        topRejectionReasons: {
          CRASH_RECOVERY_INTERRUPTED: 1,
          ...(failureReasons.length > 0 ? { [failureReasons[0]!]: 1 } : {}),
          ...(summary?.topRejectionReasons ?? {}),
        },
        totalMarketObservationsRecorded: validObservations,
        totalStratifiedCandidatesTracked: 0,
        missedWinnersCount: 0,
        avoidedRugsCount: 0,
        isCompleteSession: false,
        isInterruptedSession: true,
      };

      // Atomically write updated meta and summary
      const writeAtomic = (p: string, obj: unknown) => {
        const tmp = path.join(path.dirname(p), `.tmp.${path.basename(p)}.${Date.now()}`);
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
        fs.renameSync(tmp, p);
      };
      writeAtomic(metaPath, updatedMeta);
      writeAtomic(summaryPath, updatedSummary);
    }

    const diagnosticsPath = path.join(sessionDir, "session-diagnostics.json");
    const diagTmp = path.join(sessionDir, `.tmp.session-diagnostics.${Date.now()}`);
    fs.writeFileSync(
      diagTmp,
      JSON.stringify(
        {
          recoveryTimestampIso: new Date().toISOString(),
          recoveredStatus: status,
          validDecisionsCount: validDecisions,
          validObservationsCount: validObservations,
          validEvaluationsCount: validEvaluations,
          tornLinesQuarantinedCount: totalTornCount,
          schemaInvalidLinesQuarantinedCount: totalSchemaInvalidCount,
          failureReasons,
          repairedFiles,
          quarantinedFiles,
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.renameSync(diagTmp, diagnosticsPath);

    return {
      sessionId: path.basename(sessionDir),
      recoveredStatus: status,
      validDecisionsCount: validDecisions,
      validObservationsCount: validObservations,
      validEvaluationsCount: validEvaluations,
      tornLinesQuarantinedCount: totalTornCount,
      schemaInvalidLinesQuarantinedCount: totalSchemaInvalidCount,
      failureReasons,
      repairedFiles,
      quarantinedFiles,
      diagnosticsFileWritten: true,
    };
  }
}
