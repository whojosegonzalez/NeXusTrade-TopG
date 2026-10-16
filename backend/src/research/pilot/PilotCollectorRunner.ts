/**
 * Phase 12.94-D Milestone D.2.3: Pilot Collector Runner
 *
 * Implements bounded, read-only collection state machine for the empirical pilot.
 * Enforces canonical statuses (ACTIVE, FINALIZED, INTERRUPTED), isolated path confinement,
 * resource ceilings (20MB operational disk, 4KB emergency metadata, 256MB RSS),
 * foreign-key consistency, prospective file admission, append-time evidence reconciliation,
 * and crash recovery.
 *
 * NOTE: Network access is strictly disabled. All operations run offline against
 * synthetic fixtures and deterministic mock transports.
 *
 * Corrections: Resolves D23F-02 (path traversal & actual quota breach) and
 * D23F-03 (foreign attribution, duplicate decision rejection, append-time reconciliation,
 * and corrupted finalized recovery downgrade).
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { SystemPilotClock, type IPilotClock } from "./PilotClock.js";
import {
  toCanonicalCandidateDecision,
  toCanonicalMarketObservation,
  toCanonicalShadowEvaluation,
} from "./PilotSchemaBridge.js";
import {
  generateSessionExportManifest,
  verifySessionExportManifest,
} from "./PilotExportManifest.js";
import {
  validateShadowEvaluationEligibility,
  validateShadowEvaluationRecord,
} from "../ShadowEvaluationContract.js";
import type {
  CanonicalSessionStatus,
  D23ObservationRecord,
  D23ScreenedCandidate,
  PilotCollectorConfig,
} from "./PilotTypes.js";
import type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
} from "../../telemetry/TelemetryTypes.js";
import type { ShadowEvaluationRecord } from "../ShadowEvaluationTypes.js";

export interface MockPilotDataSource {
  fetchLatestProfiles(): Promise<unknown>;
  fetchTokenPairs(tokenAddress: string): Promise<unknown>;
  fetchPoolAccountInfo(poolAddress: string): Promise<unknown>;
  fetchVaultBalances(vaultAddresses: readonly [string, string]): Promise<unknown>;
}

export interface ResolvedPilotConfig {
  readonly sessionId: string;
  readonly generationId: string;
  readonly strategyRevision: string;
  readonly outputRootDir: string;
  readonly allowedRootDir?: string | undefined;
  readonly targetCandidates: number;
  readonly targetPools: number;
  readonly maxDurationSec: number;
  readonly maxDiskBytes: number;
  readonly maxEmergencyDiskBytes: number;
  readonly maxRssBytes: number;
  readonly maxConsecutiveErrors: number;
  readonly candidatePollIntervalMs: number;
}

/**
 * Validates a session ID to prevent path traversal or special characters (D23F-02).
 */
export function validateSessionId(sessionId: string): { isValid: boolean; error?: string } {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return { isValid: false, error: "SESSION_ID_EMPTY" };
  }
  if (
    sessionId.includes("..") ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes(":") ||
    sessionId.includes("\0")
  ) {
    return { isValid: false, error: "SESSION_ID_CONTAINS_PATH_SEPARATORS_OR_TRAVERSAL" };
  }
  if (sessionId.length > 100) {
    return { isValid: false, error: "SESSION_ID_EXCEEDS_MAX_LENGTH" };
  }
  if (!/^[a-zA-Z0-9_\-.]+$/.test(sessionId)) {
    return { isValid: false, error: "SESSION_ID_INVALID_CHARACTERS" };
  }
  return { isValid: true };
}

/**
 * Verifies strict path confinement against forbidden canonical directories and allowed roots (D23F-02).
 */
export function validatePathConfinement(targetPath: string, outputRootDir: string): void {
  const normalizedRoot = path.resolve(outputRootDir);
  const normalizedTarget = path.resolve(targetPath);

  // 1. Session path must be directly inside outputRootDir
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(normalizedRoot + path.sep)
  ) {
    throw new Error(
      `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Target directory '${normalizedTarget}' escapes configured output root '${normalizedRoot}'.`,
    );
  }

  // 2. Default forbidden repository areas that pilot MUST NEVER write to
  const repoRoot = path.resolve(process.cwd());
  const forbidden = [
    path.join(repoRoot, ".tmp", "telemetry"),
    path.join(repoRoot, ".tmp", "sessions"),
    path.join(repoRoot, ".tmp", "virtual-wallet.json"),
    path.join(repoRoot, "backend"),
    path.join(repoRoot, "frontend"),
    path.join(repoRoot, "shared"),
    path.join(repoRoot, "audit"),
    path.join(repoRoot, "scripts"),
  ].map((p) => path.resolve(p));

  for (const f of forbidden) {
    if (normalizedTarget === f || normalizedTarget.startsWith(f + path.sep)) {
      throw new Error(
        `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Target path '${normalizedTarget}' resolves inside forbidden path '${f}'.`,
      );
    }
  }

  // 3. Symlink / realpath inspection of closest existing ancestor
  let closest = normalizedTarget;
  while (!fsSync.existsSync(closest) && closest !== path.dirname(closest)) {
    closest = path.dirname(closest);
  }
  if (fsSync.existsSync(closest)) {
    const realClosest = fsSync.realpathSync(closest);
    const realRoot = fsSync.existsSync(normalizedRoot)
      ? fsSync.realpathSync(normalizedRoot)
      : normalizedRoot;
    if (realClosest !== realRoot && !realClosest.startsWith(realRoot + path.sep)) {
      throw new Error(
        `[PilotCollectorRunner] [SYMLINK_CONFINEMENT_VIOLATION] Real directory '${realClosest}' escapes allowed real root '${realRoot}'.`,
      );
    }
  }
}

/**
 * Deep equality check for serialized research records (D23F-03).
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
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!deepEqualRecords(objA[key], objB[key])) return false;
  }
  return true;
}

export class PilotCollectorRunner {
  private readonly config: ResolvedPilotConfig;
  private readonly sessionDir: string;
  private readonly clock: IPilotClock;
  private readonly dataSource?: MockPilotDataSource | undefined;

  private status: CanonicalSessionStatus = "ACTIVE";
  private startEpochMs: number = 0;
  private operationalBytesWritten: number = 0;
  private emergencyBytesWritten: number = 0;
  private consecutiveErrors: number = 0;

  private totalCandidatesScreened: number = 0;
  private totalWatchlistRadar: number = 0;
  private totalFilteredRejected: number = 0;
  private totalEvaluationsRecorded: number = 0;
  private totalObservationsRecorded: number = 0;
  private readonly uniquePoolsSeen = new Set<string>();
  private interruptionReason?: string | undefined;

  // Append-time baseline tracking for deep reconciliation (D23F-03)
  private readonly seenDecisionEventIds = new Set<string>();
  private readonly decisionsBaseline = new Map<string, CandidateDecisionRecord>();
  private readonly evaluationsBaseline = new Map<string, ShadowEvaluationRecord>();
  private readonly observationsBaseline: MarketObservationRecord[] = [];

  constructor(
    config: PilotCollectorConfig,
    dataSource?: MockPilotDataSource | undefined,
    clock: IPilotClock = new SystemPilotClock(),
  ) {
    // Strict session ID validation (D23F-02)
    const sessionValidation = validateSessionId(config.sessionId);
    if (!sessionValidation.isValid) {
      throw new Error(
        `[PilotCollectorRunner] [INVALID_SESSION_ID] ${sessionValidation.error}: '${config.sessionId}'`,
      );
    }

    this.config = {
      sessionId: config.sessionId,
      generationId: config.generationId,
      strategyRevision: config.strategyRevision,
      outputRootDir: config.outputRootDir,
      allowedRootDir: config.allowedRootDir,
      targetCandidates: config.targetCandidates ?? 100,
      targetPools: config.targetPools ?? 20,
      maxDurationSec: config.maxDurationSec ?? 7200,
      maxDiskBytes: config.maxDiskBytes ?? 20 * 1024 * 1024, // 20 MB
      maxEmergencyDiskBytes: config.maxEmergencyDiskBytes ?? 4096, // 4 KB emergency metadata
      maxRssBytes: config.maxRssBytes ?? 256 * 1024 * 1024, // 256 MB
      maxConsecutiveErrors: config.maxConsecutiveErrors ?? 5,
      candidatePollIntervalMs: config.candidatePollIntervalMs ?? 60_000,
    };

    this.dataSource = dataSource;
    this.clock = clock;
    this.sessionDir = path.resolve(this.config.outputRootDir, this.config.sessionId);
    const rootToEnforce = this.config.allowedRootDir ?? this.config.outputRootDir;
    validatePathConfinement(this.sessionDir, rootToEnforce);
  }

  /**
   * Prospective write admission check (D23F-02).
   */
  private checkWriteAdmission(projectedBytes: number, isEmergency: boolean = false): void {
    if (isEmergency) {
      if (this.emergencyBytesWritten + projectedBytes > this.config.maxEmergencyDiskBytes) {
        throw new Error(
          `[PilotCollectorRunner] [EMERGENCY_QUOTA_EXCEEDED] Emergency write of ${projectedBytes} bytes exceeds allowance (${this.emergencyBytesWritten} + ${projectedBytes} > ${this.config.maxEmergencyDiskBytes}).`,
        );
      }
      return;
    }

    if (this.operationalBytesWritten + projectedBytes > this.config.maxDiskBytes) {
      throw new Error(
        `[PilotCollectorRunner] [STORAGE_QUOTA_EXCEEDED] Projected write of ${projectedBytes} bytes exceeds operational quota (${this.operationalBytesWritten} + ${projectedBytes} > ${this.config.maxDiskBytes}).`,
      );
    }

    const memoryUsage = process.memoryUsage();
    if (memoryUsage.rss >= this.config.maxRssBytes) {
      throw new Error(
        `[PilotCollectorRunner] [MEMORY_RSS_CEILING_EXCEEDED] ${memoryUsage.rss} >= ${this.config.maxRssBytes}`,
      );
    }

    if (this.startEpochMs > 0) {
      const elapsedSec = (this.clock.getEpochNow() - this.startEpochMs) / 1000;
      if (elapsedSec >= this.config.maxDurationSec) {
        throw new Error(
          `[PilotCollectorRunner] [DURATION_BOX_EXPIRED] ${elapsedSec}s >= ${this.config.maxDurationSec}s`,
        );
      }
    }
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    this.startEpochMs = this.clock.getEpochNow();
    this.status = "ACTIVE";

    const meta: SessionTelemetryMeta = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: new Date(this.startEpochMs).toISOString(),
      initialWalletBalanceSol: 7.9259,
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
      },
      sessionStatus: "ACTIVE",
      isInterruptedSession: false,
      resumedFromPriorCrash: false,
    };

    await this.writeSessionMeta(meta, false);
  }

  public async recordScreenedCandidate(
    candidate: D23ScreenedCandidate,
    observation?: D23ObservationRecord | undefined,
  ): Promise<void> {
    if (this.status !== "ACTIVE") {
      throw new Error(
        `[PilotCollectorRunner] Cannot record candidate in session state ${this.status}`,
      );
    }

    // 1. Session and generation attribution check (D23F-03)
    if (candidate.compositeId.sessionId !== this.config.sessionId) {
      throw new Error(
        `[PilotCollectorRunner] [FOREIGN_SESSION_ATTRIBUTION] Candidate sessionId '${candidate.compositeId.sessionId}' does not match runner sessionId '${this.config.sessionId}'.`,
      );
    }
    if (candidate.compositeId.generationId !== this.config.generationId) {
      throw new Error(
        `[PilotCollectorRunner] [FOREIGN_GENERATION_ATTRIBUTION] Candidate generationId '${candidate.compositeId.generationId}' does not match runner generationId '${this.config.generationId}'.`,
      );
    }

    // 2. Reject duplicate decision IDs (D23F-03)
    if (this.seenDecisionEventIds.has(candidate.compositeId.decisionEventId)) {
      throw new Error(
        `[PilotCollectorRunner] [DUPLICATE_DECISION_ID] Candidate decision '${candidate.compositeId.decisionEventId}' has already been recorded in this session.`,
      );
    }

    // 3. Foreign key consistency between candidate and observation (D23F-03)
    if (observation) {
      if (observation.compositeId.decisionEventId !== candidate.compositeId.decisionEventId) {
        throw new Error(
          `[PilotCollectorRunner] [COMPOSITE_FOREIGN_KEY_MISMATCH] Observation decisionEventId '${observation.compositeId.decisionEventId}' does not match candidate decisionEventId '${candidate.compositeId.decisionEventId}'.`,
        );
      }
      if (observation.compositeId.sessionId !== this.config.sessionId) {
        throw new Error(
          `[PilotCollectorRunner] [FOREIGN_SESSION_ATTRIBUTION] Observation sessionId '${observation.compositeId.sessionId}' does not match runner sessionId '${this.config.sessionId}'.`,
        );
      }
      if (observation.compositeId.generationId !== this.config.generationId) {
        throw new Error(
          `[PilotCollectorRunner] [FOREIGN_GENERATION_ATTRIBUTION] Observation generationId '${observation.compositeId.generationId}' does not match runner generationId '${this.config.generationId}'.`,
        );
      }
      if (observation.compositeId.poolId !== candidate.compositeId.poolId) {
        throw new Error(
          `[PilotCollectorRunner] [COMPOSITE_FOREIGN_KEY_MISMATCH] Observation poolId '${observation.compositeId.poolId}' does not match candidate poolId '${candidate.compositeId.poolId}'.`,
        );
      }
    }

    // 4. Translate canonical records and enforce downstream contract validation
    const canonicalCandidate = toCanonicalCandidateDecision(candidate, observation);
    const canonicalEvaluation = toCanonicalShadowEvaluation(candidate, observation);
    validateShadowEvaluationRecord(canonicalEvaluation);
    validateShadowEvaluationEligibility(canonicalEvaluation, canonicalCandidate);

    let canonicalObs: MarketObservationRecord | null = null;
    if (observation) {
      canonicalObs = toCanonicalMarketObservation(observation, this.config.strategyRevision);
    }

    // 5. Prospective file admission: check projected bytes before writing ANY record (D23F-02)
    const candidateLine = JSON.stringify(canonicalCandidate) + "\n";
    const evalLine = JSON.stringify(canonicalEvaluation) + "\n";
    const obsLine = canonicalObs ? JSON.stringify(canonicalObs) + "\n" : "";

    const candidateBytes = Buffer.byteLength(candidateLine, "utf8");
    const evalBytes = Buffer.byteLength(evalLine, "utf8");
    const obsBytes = obsLine ? Buffer.byteLength(obsLine, "utf8") : 0;
    const totalProjectedBytes = candidateBytes + evalBytes + obsBytes;

    try {
      this.checkWriteAdmission(totalProjectedBytes, false);
    } catch (err: unknown) {
      // Fail closed: immediately transition status to INTERRUPTED and write emergency metadata (D23F-02)
      this.status = "INTERRUPTED";
      const reason = err instanceof Error ? err.message : String(err);
      this.interruptionReason = reason.includes("STORAGE_QUOTA_EXCEEDED")
        ? "STORAGE_QUOTA_EXCEEDED"
        : reason;
      await this.writeEmergencyInterruptedMetadata(this.interruptionReason);
      throw err;
    }

    // 6. Append records to disk
    await this.appendFile("candidate-decisions.jsonl", candidateLine);
    await this.appendFile("shadow-evaluations.jsonl", evalLine);
    if (obsLine) {
      await this.appendFile("market-observations.jsonl", obsLine);
    }

    // 7. Record immutable append snapshots for pre-finalization deep reconciliation (D23F-03)
    this.decisionsBaseline.set(
      canonicalCandidate.eventId,
      JSON.parse(JSON.stringify(canonicalCandidate)),
    );
    this.evaluationsBaseline.set(
      canonicalEvaluation.evaluationId,
      JSON.parse(JSON.stringify(canonicalEvaluation)),
    );
    if (canonicalObs) {
      this.observationsBaseline.push(JSON.parse(JSON.stringify(canonicalObs)));
    }
    this.seenDecisionEventIds.add(candidate.compositeId.decisionEventId);

    // 8. Update counters
    this.totalCandidatesScreened += 1;
    if (candidate.decisionCohort === "WATCHLIST_RADAR") {
      this.totalWatchlistRadar += 1;
    } else {
      this.totalFilteredRejected += 1;
    }
    if (candidate.compositeId.poolId) {
      this.uniquePoolsSeen.add(candidate.compositeId.poolId);
    }
    this.totalEvaluationsRecorded += 1;
    if (canonicalObs) {
      this.totalObservationsRecorded += 1;
    }
    this.consecutiveErrors = 0;

    // 9. Check target stopping conditions
    if (
      this.totalCandidatesScreened >= this.config.targetCandidates &&
      this.uniquePoolsSeen.size >= this.config.targetPools
    ) {
      await this.finalize("FINALIZED");
    }
  }

  public async recordError(error: Error | string): Promise<void> {
    this.consecutiveErrors += 1;
    if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      await this.finalize("INTERRUPTED", `EXCEEDED_MAX_CONSECUTIVE_ERRORS: ${String(error)}`);
    }
  }

  /**
   * Reconciles all persisted JSONL files against append-time baseline snapshots (D23F-03).
   */
  private async reconcilePersistedEvidence(): Promise<{ success: boolean; reason?: string }> {
    // Reconcile candidate-decisions.jsonl
    const decisionsPath = path.join(this.sessionDir, "candidate-decisions.jsonl");
    if (this.decisionsBaseline.size > 0) {
      if (!fsSync.existsSync(decisionsPath)) {
        return { success: false, reason: "MISSING_PERSISTED_CANDIDATE_DECISIONS_FILE" };
      }
      const content = await fs.readFile(decisionsPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length !== this.decisionsBaseline.size) {
        return {
          success: false,
          reason: `DECISION_COUNT_MISMATCH: expected ${this.decisionsBaseline.size}, on-disk ${lines.length}`,
        };
      }
      for (const line of lines) {
        let parsed: CandidateDecisionRecord;
        try {
          parsed = JSON.parse(line);
        } catch {
          return { success: false, reason: "CORRUPT_JSONL_DECISION_LINE" };
        }
        const baseline = this.decisionsBaseline.get(parsed.eventId);
        if (!baseline) {
          return { success: false, reason: `UNKNOWN_DECISION_ON_DISK: ${parsed.eventId}` };
        }
        if (!deepEqualRecords(parsed, baseline)) {
          return {
            success: false,
            reason: `RECONCILIATION_IDENTITY_MISMATCH: Decision record '${parsed.eventId}' on disk does not match append baseline.`,
          };
        }
      }
    }

    // Reconcile shadow-evaluations.jsonl
    const evalsPath = path.join(this.sessionDir, "shadow-evaluations.jsonl");
    if (this.evaluationsBaseline.size > 0) {
      if (!fsSync.existsSync(evalsPath)) {
        return { success: false, reason: "MISSING_PERSISTED_SHADOW_EVALUATIONS_FILE" };
      }
      const content = await fs.readFile(evalsPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length !== this.evaluationsBaseline.size) {
        return {
          success: false,
          reason: `EVALUATION_COUNT_MISMATCH: expected ${this.evaluationsBaseline.size}, on-disk ${lines.length}`,
        };
      }
      for (const line of lines) {
        let parsed: ShadowEvaluationRecord;
        try {
          parsed = JSON.parse(line);
        } catch {
          return { success: false, reason: "CORRUPT_JSONL_EVALUATION_LINE" };
        }
        const baseline = this.evaluationsBaseline.get(parsed.evaluationId);
        if (!baseline) {
          return { success: false, reason: `UNKNOWN_EVALUATION_ON_DISK: ${parsed.evaluationId}` };
        }
        if (!deepEqualRecords(parsed, baseline)) {
          return {
            success: false,
            reason: `RECONCILIATION_IDENTITY_MISMATCH: Evaluation record '${parsed.evaluationId}' on disk does not match append baseline.`,
          };
        }
      }
    }

    // Reconcile market-observations.jsonl
    const obsPath = path.join(this.sessionDir, "market-observations.jsonl");
    if (this.observationsBaseline.length > 0) {
      if (!fsSync.existsSync(obsPath)) {
        return { success: false, reason: "MISSING_PERSISTED_MARKET_OBSERVATIONS_FILE" };
      }
      const content = await fs.readFile(obsPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length !== this.observationsBaseline.length) {
        return {
          success: false,
          reason: `OBSERVATION_COUNT_MISMATCH: expected ${this.observationsBaseline.length}, on-disk ${lines.length}`,
        };
      }
      for (let i = 0; i < lines.length; i++) {
        let parsed: MarketObservationRecord;
        try {
          parsed = JSON.parse(lines[i]!);
        } catch {
          return { success: false, reason: "CORRUPT_JSONL_OBSERVATION_LINE" };
        }
        const baseline = this.observationsBaseline[i];
        if (!deepEqualRecords(parsed, baseline)) {
          return {
            success: false,
            reason: `RECONCILIATION_IDENTITY_MISMATCH: Observation record at line ${i + 1} on disk does not match append baseline.`,
          };
        }
      }
    }

    return { success: true };
  }

  public async finalize(
    targetStatus: "FINALIZED" | "INTERRUPTED",
    interruptionReason?: string | undefined,
  ): Promise<void> {
    if (this.status !== "ACTIVE") {
      return;
    }

    // Before finalization, reconcile all persisted evidence against append baseline (D23F-03)
    if (targetStatus === "FINALIZED") {
      const reconciliation = await this.reconcilePersistedEvidence();
      if (!reconciliation.success) {
        this.status = "INTERRUPTED";
        this.interruptionReason = reconciliation.reason ?? "RECONCILIATION_FAILED";
        await this.writeEmergencyInterruptedMetadata(this.interruptionReason);
        throw new Error(
          `[PilotCollectorRunner] [RECONCILIATION_FAILURE] Cannot finalize session: ${this.interruptionReason}`,
        );
      }
    }

    this.status = targetStatus;
    this.interruptionReason = interruptionReason;
    const endEpochMs = this.clock.getEpochNow();

    const meta: SessionTelemetryMeta = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: new Date(this.startEpochMs).toISOString(),
      closedAtIso: new Date(endEpochMs).toISOString(),
      initialWalletBalanceSol: 7.9259,
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
      },
      sessionStatus: targetStatus,
      isInterruptedSession: targetStatus === "INTERRUPTED",
      resumedFromPriorCrash: false,
    };

    await this.writeSessionMeta(meta, false);

    const summary: SessionTelemetrySummary = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: new Date(this.startEpochMs).toISOString(),
      closedAtIso: new Date(endEpochMs).toISOString(),
      totalCandidatesScreened: this.totalCandidatesScreened,
      totalDecisionsRecorded: this.totalCandidatesScreened,
      decisionWriteFailures: 0,
      cohortBreakdown: {
        filteredRejected: this.totalFilteredRejected,
        watchlistRadar: this.totalWatchlistRadar,
        triggerRejected: 0,
        executedBuy: 0,
      },
      topRejectionReasons: interruptionReason ? { [interruptionReason]: 1 } : {},
      totalMarketObservationsRecorded: this.totalObservationsRecorded,
      totalStratifiedCandidatesTracked: 0,
      missedWinnersCount: 0,
      avoidedRugsCount: 0,
      isCompleteSession: targetStatus === "FINALIZED",
      isInterruptedSession: targetStatus === "INTERRUPTED",
    };

    await this.writeSessionSummary(summary, false);

    if (targetStatus === "FINALIZED") {
      await generateSessionExportManifest(
        this.sessionDir,
        this.config.sessionId,
        this.config.generationId,
        endEpochMs,
      );
    }
  }

  private async writeEmergencyInterruptedMetadata(reason: string): Promise<void> {
    const endEpochMs = this.clock.getEpochNow();
    const meta: SessionTelemetryMeta = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: new Date(this.startEpochMs || endEpochMs).toISOString(),
      closedAtIso: new Date(endEpochMs).toISOString(),
      initialWalletBalanceSol: 7.9259,
      environment: {
        platform: process.platform,
        nodeVersion: process.version,
      },
      sessionStatus: "INTERRUPTED",
      isInterruptedSession: true,
      resumedFromPriorCrash: false,
    };

    await this.writeSessionMeta(meta, true, reason);

    const summary: SessionTelemetrySummary = {
      sessionId: this.config.sessionId,
      generationId: this.config.generationId,
      strategyRevision: this.config.strategyRevision,
      startedAtIso: new Date(this.startEpochMs || endEpochMs).toISOString(),
      closedAtIso: new Date(endEpochMs).toISOString(),
      totalCandidatesScreened: this.totalCandidatesScreened,
      totalDecisionsRecorded: this.totalCandidatesScreened,
      decisionWriteFailures: 0,
      cohortBreakdown: {
        filteredRejected: this.totalFilteredRejected,
        watchlistRadar: this.totalWatchlistRadar,
        triggerRejected: 0,
        executedBuy: 0,
      },
      topRejectionReasons: { [reason]: 1 },
      totalMarketObservationsRecorded: this.totalObservationsRecorded,
      totalStratifiedCandidatesTracked: 0,
      missedWinnersCount: 0,
      avoidedRugsCount: 0,
      isCompleteSession: false,
      isInterruptedSession: true,
    };

    await this.writeSessionSummary(summary, true);
  }

  /**
   * Recovers a session directory after process interruption or crash (D23F-03).
   * If any torn lines or corrupted lines are isolated, or manifest fails verification,
   * the archive CANNOT remain FINALIZED; it is downgraded to INTERRUPTED with persistent metadata repair.
   */
  public static async recoverSession(sessionDir: string): Promise<{
    recovered: boolean;
    status: CanonicalSessionStatus;
    tornLinesIsolated: number;
    diagnostics: string[];
  }> {
    const diagnostics: string[] = [];
    let tornLinesIsolated = 0;

    const metaPath = path.join(sessionDir, "session-meta.json");
    const summaryPath = path.join(sessionDir, "session-summary.json");
    let meta: SessionTelemetryMeta | null = null;
    let summary: SessionTelemetrySummary | null = null;

    try {
      const content = await fs.readFile(metaPath, "utf8");
      meta = JSON.parse(content) as SessionTelemetryMeta;
    } catch (err) {
      diagnostics.push(`Missing or unreadable session-meta.json: ${String(err)}`);
    }

    try {
      const content = await fs.readFile(summaryPath, "utf8");
      summary = JSON.parse(content) as SessionTelemetrySummary;
    } catch (err) {
      diagnostics.push(`Missing or unreadable session-summary.json: ${String(err)}`);
    }

    // Clean any torn lines in jsonl files
    const jsonlFiles = [
      "candidate-decisions.jsonl",
      "shadow-evaluations.jsonl",
      "market-observations.jsonl",
    ];
    for (const file of jsonlFiles) {
      const filePath = path.join(sessionDir, file);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const lines = content.split("\n");
        const validLines: string[] = [];
        const corruptLines: string[] = [];

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            JSON.parse(line);
            validLines.push(line);
          } catch {
            corruptLines.push(line);
          }
        }

        if (corruptLines.length > 0) {
          tornLinesIsolated += corruptLines.length;
          diagnostics.push(`Isolated ${corruptLines.length} corrupt line(s) in ${file}`);
          await fs.writeFile(
            path.join(sessionDir, `${file}.corrupt-${Date.now()}`),
            corruptLines.join("\n"),
            "utf8",
          );
          await fs.writeFile(filePath, validLines.join("\n") + "\n", "utf8");
        }
      } catch {
        // File might not exist if session crashed before writes
      }
    }

    // D23F-03: If torn lines were isolated, an archive that previously claimed FINALIZED
    // is damaged and MUST be downgraded and repaired to INTERRUPTED.
    const priorStatus =
      meta?.sessionStatus ?? (meta as unknown as Record<string, unknown> | null)?.status;

    let mustInterrupt =
      !meta ||
      priorStatus !== "FINALIZED" ||
      tornLinesIsolated > 0 ||
      summary?.isCompleteSession !== true;

    if (!mustInterrupt) {
      // Check export manifest if session was supposedly finalized
      const manifestVerification = await verifySessionExportManifest(sessionDir);
      if (!manifestVerification.valid) {
        mustInterrupt = true;
        diagnostics.push(
          `Manifest verification failed during recovery: ${manifestVerification.errorDetails ?? "corrupted/mismatched files"}`,
        );
      }
    }

    if (mustInterrupt) {
      const interruptionReason =
        priorStatus === "FINALIZED" && tornLinesIsolated > 0
          ? "CORRUPTED_FINALIZED_ARCHIVE_QUARANTINED"
          : "RECOVERED_FROM_UNGRACEFUL_PROCESS_INTERRUPTION";

      const repairedMeta: Record<string, unknown> = {
        sessionId: meta?.sessionId ?? path.basename(sessionDir),
        generationId: meta?.generationId ?? "unknown",
        strategyRevision: meta?.strategyRevision ?? "unknown",
        startedAtIso: meta?.startedAtIso ?? new Date().toISOString(),
        closedAtIso: new Date().toISOString(),
        initialWalletBalanceSol: 7.9259,
        environment: meta?.environment ?? {
          platform: process.platform,
          nodeVersion: process.version,
        },
        sessionStatus: "INTERRUPTED",
        status: "INTERRUPTED",
        isInterruptedSession: true,
        resumedFromPriorCrash: true,
        interruptionReason,
      };
      await fs.writeFile(metaPath, JSON.stringify(repairedMeta, null, 2), "utf8");

      const repairedSummary: Record<string, unknown> = {
        sessionId: summary?.sessionId ?? meta?.sessionId ?? path.basename(sessionDir),
        generationId: summary?.generationId ?? meta?.generationId ?? "unknown",
        strategyRevision: summary?.strategyRevision ?? meta?.strategyRevision ?? "unknown",
        startedAtIso: summary?.startedAtIso ?? meta?.startedAtIso ?? new Date().toISOString(),
        closedAtIso: new Date().toISOString(),
        totalCandidatesScreened: summary?.totalCandidatesScreened ?? 0,
        totalDecisionsRecorded: summary?.totalDecisionsRecorded ?? 0,
        decisionWriteFailures: summary?.decisionWriteFailures ?? 0,
        cohortBreakdown: summary?.cohortBreakdown ?? {
          filteredRejected: 0,
          watchlistRadar: 0,
          triggerRejected: 0,
          executedBuy: 0,
        },
        topRejectionReasons: { [interruptionReason]: 1 },
        totalMarketObservationsRecorded: summary?.totalMarketObservationsRecorded ?? 0,
        totalStratifiedCandidatesTracked: 0,
        missedWinnersCount: 0,
        avoidedRugsCount: 0,
        isCompleteSession: false,
        isInterruptedSession: true,
        status: "INTERRUPTED",
      };
      await fs.writeFile(summaryPath, JSON.stringify(repairedSummary, null, 2), "utf8");

      diagnostics.push(`Session status marked INTERRUPTED due to recovery: ${interruptionReason}`);
      return {
        recovered: true,
        status: "INTERRUPTED",
        tornLinesIsolated,
        diagnostics,
      };
    }

    return {
      recovered: true,
      status: "FINALIZED",
      tornLinesIsolated: 0,
      diagnostics,
    };
  }

  private async appendFile(filename: string, content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, "utf8");
    const filePath = path.join(this.sessionDir, filename);
    await fs.appendFile(filePath, content, "utf8");
    this.operationalBytesWritten += bytes;
  }

  private async writeSessionMeta(
    meta: SessionTelemetryMeta,
    isEmergency: boolean = false,
    interruptionReason?: string | undefined,
  ): Promise<void> {
    const filePath = path.join(this.sessionDir, "session-meta.json");
    const metaPayload: Record<string, unknown> = {
      ...meta,
      status: meta.sessionStatus,
      ...(interruptionReason ? { interruptionReason } : {}),
    };
    const content = JSON.stringify(metaPayload, null, 2);
    const bytes = Buffer.byteLength(content, "utf8");
    this.checkWriteAdmission(bytes, isEmergency);
    await fs.writeFile(filePath, content, "utf8");
    if (isEmergency) {
      this.emergencyBytesWritten += bytes;
    } else {
      this.operationalBytesWritten += bytes;
    }
  }

  private async writeSessionSummary(
    summary: SessionTelemetrySummary,
    isEmergency: boolean = false,
  ): Promise<void> {
    const filePath = path.join(this.sessionDir, "session-summary.json");
    const summaryPayload: Record<string, unknown> = {
      ...summary,
      status: summary.isCompleteSession ? "FINALIZED" : "INTERRUPTED",
    };
    const content = JSON.stringify(summaryPayload, null, 2);
    const bytes = Buffer.byteLength(content, "utf8");
    this.checkWriteAdmission(bytes, isEmergency);
    await fs.writeFile(filePath, content, "utf8");
    if (isEmergency) {
      this.emergencyBytesWritten += bytes;
    } else {
      this.operationalBytesWritten += bytes;
    }
  }

  public getSessionDirectory(): string {
    return this.sessionDir;
  }

  public getStatus(): CanonicalSessionStatus {
    return this.status;
  }

  public getInterruptionReason(): string | undefined {
    return this.interruptionReason;
  }

  public getStats(): {
    candidates: number;
    radar: number;
    rejected: number;
    evaluations: number;
    observations: number;
    pools: number;
    operationalBytesWritten: number;
    emergencyBytesWritten: number;
    bytesWritten: number;
  } {
    return {
      candidates: this.totalCandidatesScreened,
      radar: this.totalWatchlistRadar,
      rejected: this.totalFilteredRejected,
      evaluations: this.totalEvaluationsRecorded,
      observations: this.totalObservationsRecorded,
      pools: this.uniquePoolsSeen.size,
      operationalBytesWritten: this.operationalBytesWritten,
      emergencyBytesWritten: this.emergencyBytesWritten,
      bytesWritten: this.operationalBytesWritten + this.emergencyBytesWritten,
    };
  }
}
