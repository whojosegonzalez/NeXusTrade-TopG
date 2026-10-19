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
import { SystemPilotClock, type IPilotClock, validateCausalEpochOrdering } from "./PilotClock.js";
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
  DiscoveryDiagnosticRecord,
  PilotCollectorConfig,
} from "./PilotTypes.js";
import type {
  CandidateDecisionRecord,
  DiscoveryFunnelMetrics,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
} from "../../telemetry/TelemetryTypes.js";
import type { ShadowEvaluationRecord } from "../ShadowEvaluationTypes.js";
import {
  auditPilotSessionCompatibility,
  type PilotSessionCompatibilityReport,
} from "./PilotResearchCompatibility.js";

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
  readonly discoverySource?: "dexscreener" | "raydium" | undefined;
  readonly maxPoolAgeSec?: number | undefined;
  readonly minRequestIntervalMs?: number | undefined;
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
 * Verifies strict path confinement against forbidden canonical directories and allowed roots (D23F-02, D23R-04).
 * Checks both lexical and canonical realpath of target, output root, and allowed root against protected directories.
 */
export function validatePathConfinement(
  targetPath: string,
  outputRootDir: string,
  allowedRootDir?: string | undefined,
): void {
  const normalizedRoot = path.resolve(outputRootDir);
  const normalizedTarget = path.resolve(targetPath);

  // 1. Session path must be directly inside outputRootDir lexically
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(normalizedRoot + path.sep)
  ) {
    throw new Error(
      `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Target directory '${normalizedTarget}' escapes configured output root '${normalizedRoot}'.`,
    );
  }

  // 2. Helper to detect protected repository paths (both segment patterns and specific repo paths)
  const repoRoot = path.resolve(process.cwd());
  const repoRootReal = fsSync.existsSync(repoRoot) ? fsSync.realpathSync(repoRoot) : repoRoot;
  const repoForbidden = [
    path.join(repoRoot, ".tmp", "telemetry"),
    path.join(repoRoot, ".tmp", "sessions"),
    path.join(repoRoot, ".tmp", "virtual-wallet.json"),
    path.join(repoRoot, "backend"),
    path.join(repoRoot, "frontend"),
    path.join(repoRoot, "shared"),
    path.join(repoRoot, "audit"),
    path.join(repoRoot, "scripts"),
  ];

  const checkProtectedPath = (candidatePath: string): { isProtected: boolean; reason?: string } => {
    const norm = path.resolve(candidatePath);
    const normSlash = norm.replace(/\\/g, "/");

    // Segment checks: completely prevent writes into telemetry or sessions directories
    if (normSlash.includes("/.tmp/telemetry") || normSlash.endsWith("/.tmp/telemetry")) {
      return { isProtected: true, reason: "telemetry directory (.tmp/telemetry)" };
    }
    if (normSlash.includes("/.tmp/sessions") || normSlash.endsWith("/.tmp/sessions")) {
      return { isProtected: true, reason: "sessions directory (.tmp/sessions)" };
    }
    if (
      normSlash.includes("/.tmp/virtual-wallet.json") ||
      normSlash.endsWith("/.tmp/virtual-wallet.json")
    ) {
      return { isProtected: true, reason: "virtual wallet file (.tmp/virtual-wallet.json)" };
    }

    // Repository protected folders (lexical, realpath, and canonical relative)
    for (const f of repoForbidden) {
      const fNorm = path.resolve(f);
      if (norm === fNorm || norm.startsWith(fNorm + path.sep)) {
        return { isProtected: true, reason: `repository protected path '${fNorm}'` };
      }
      if (fsSync.existsSync(fNorm)) {
        const fReal = fsSync.realpathSync(fNorm);
        if (norm === fReal || norm.startsWith(fReal + path.sep)) {
          return { isProtected: true, reason: `repository real protected path '${fReal}'` };
        }
      }
      const relToReal = path.resolve(repoRootReal, path.relative(repoRoot, f));
      if (norm === relToReal || norm.startsWith(relToReal + path.sep)) {
        return { isProtected: true, reason: `repository real protected path '${relToReal}'` };
      }
    }

    return { isProtected: false };
  };

  // Check lexical target & root
  const lexTargetCheck = checkProtectedPath(normalizedTarget);
  if (lexTargetCheck.isProtected) {
    throw new Error(
      `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Target path '${normalizedTarget}' resolves inside forbidden path '${lexTargetCheck.reason}'.`,
    );
  }
  const lexRootCheck = checkProtectedPath(normalizedRoot);
  if (lexRootCheck.isProtected) {
    throw new Error(
      `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Output root '${normalizedRoot}' resolves inside forbidden path '${lexRootCheck.reason}'.`,
    );
  }

  // 3. Symlink / realpath inspection of target, root, and allowed root (D23R-04)
  let closestTarget = normalizedTarget;
  while (!fsSync.existsSync(closestTarget) && closestTarget !== path.dirname(closestTarget)) {
    closestTarget = path.dirname(closestTarget);
  }
  let closestRoot = normalizedRoot;
  while (!fsSync.existsSync(closestRoot) && closestRoot !== path.dirname(closestRoot)) {
    closestRoot = path.dirname(closestRoot);
  }

  const realTarget = fsSync.existsSync(closestTarget)
    ? fsSync.realpathSync(closestTarget)
    : closestTarget;
  const realRoot = fsSync.existsSync(closestRoot) ? fsSync.realpathSync(closestRoot) : closestRoot;

  // Real paths must not resolve inside any protected directories
  const realTargetCheck = checkProtectedPath(realTarget);
  if (realTargetCheck.isProtected) {
    throw new Error(
      `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Real target path '${realTarget}' resolves inside forbidden path '${realTargetCheck.reason}'.`,
    );
  }
  const realRootCheck = checkProtectedPath(realRoot);
  if (realRootCheck.isProtected) {
    throw new Error(
      `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Real output root '${realRoot}' resolves inside forbidden path '${realRootCheck.reason}'.`,
    );
  }

  // Real target must remain inside real root
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(
      `[PilotCollectorRunner] [SYMLINK_CONFINEMENT_VIOLATION] Real directory '${realTarget}' escapes allowed real root '${realRoot}'.`,
    );
  }

  // If allowedRootDir is configured, both realRoot and realTarget must remain inside it
  if (allowedRootDir) {
    const normalizedAllowed = path.resolve(allowedRootDir);
    let closestAllowed = normalizedAllowed;
    while (!fsSync.existsSync(closestAllowed) && closestAllowed !== path.dirname(closestAllowed)) {
      closestAllowed = path.dirname(closestAllowed);
    }
    const realAllowed = fsSync.existsSync(closestAllowed)
      ? fsSync.realpathSync(closestAllowed)
      : closestAllowed;

    if (realRoot !== realAllowed && !realRoot.startsWith(realAllowed + path.sep)) {
      throw new Error(
        `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Real output root '${realRoot}' escapes configured allowed root '${realAllowed}'.`,
      );
    }
    if (realTarget !== realAllowed && !realTarget.startsWith(realAllowed + path.sep)) {
      throw new Error(
        `[PilotCollectorRunner] [PATH_CONFINEMENT_VIOLATION] Real target path '${realTarget}' escapes configured allowed root '${realAllowed}'.`,
      );
    }
  }
}

/**
 * Validates temporal causality, source timestamp bounds, and observation clock/identity agreement (D23R-01).
 */
export function validateCandidateCausality(
  candidate: D23ScreenedCandidate,
  observation?: D23ObservationRecord | undefined,
): { valid: boolean; error?: string } {
  // 1. Candidate epoch ordering: request <= receipt <= decision
  const candidateOrdering = validateCausalEpochOrdering(
    candidate.requestEpochMs,
    candidate.receiptEpochMs,
    candidate.decisionEpochMs,
  );
  if (!candidateOrdering.valid) {
    return {
      valid: false,
      error: `[CAUSAL_VIOLATION] CANDIDATE_EPOCH_ORDERING: ${candidateOrdering.violationReason}`,
    };
  }

  // 2. Candidate sourceTimestampMs (if attested: not null and not 0)
  if (candidate.sourceTimestampMs !== null && candidate.sourceTimestampMs !== 0) {
    if (!Number.isFinite(candidate.sourceTimestampMs) || candidate.sourceTimestampMs <= 0) {
      return {
        valid: false,
        error: `[CAUSAL_VIOLATION] INVALID_SOURCE_TIMESTAMP_NON_FINITE: candidate sourceTimestampMs (${candidate.sourceTimestampMs}) is invalid`,
      };
    }
    if (candidate.sourceTimestampMs > candidate.decisionEpochMs) {
      return {
        valid: false,
        error: `[CAUSAL_VIOLATION] FUTURE_SOURCE_TIMESTAMP_LOOKAHEAD: candidate sourceTimestampMs (${candidate.sourceTimestampMs}) > decisionEpochMs (${candidate.decisionEpochMs})`,
      };
    }
    if (candidate.sourceTimestampMs > candidate.receiptEpochMs) {
      return {
        valid: false,
        error: `[CAUSAL_VIOLATION] SOURCE_AFTER_RECEIPT: candidate sourceTimestampMs (${candidate.sourceTimestampMs}) > receiptEpochMs (${candidate.receiptEpochMs})`,
      };
    }
  }

  // 3. Observation causality and clock/identity agreement
  if (observation) {
    if (observation.receiptEpochMs > candidate.decisionEpochMs) {
      return {
        valid: false,
        error: `[CAUSAL_VIOLATION] OBSERVATION_LOOKAHEAD: observation receiptEpochMs (${observation.receiptEpochMs}) > candidate decisionEpochMs (${candidate.decisionEpochMs})`,
      };
    }

    const obsOrdering = validateCausalEpochOrdering(
      observation.requestEpochMs,
      observation.receiptEpochMs,
      candidate.decisionEpochMs,
    );
    if (!obsOrdering.valid) {
      return {
        valid: false,
        error: `[CAUSAL_VIOLATION] OBSERVATION_EPOCH_ORDERING: ${obsOrdering.violationReason}`,
      };
    }

    if (observation.sourceReportedTimeMs !== null && observation.sourceReportedTimeMs !== 0) {
      if (
        !Number.isFinite(observation.sourceReportedTimeMs) ||
        observation.sourceReportedTimeMs <= 0
      ) {
        return {
          valid: false,
          error: `[CAUSAL_VIOLATION] INVALID_OBSERVATION_SOURCE_TIMESTAMP_NON_FINITE: observation sourceReportedTimeMs (${observation.sourceReportedTimeMs}) is invalid`,
        };
      }
      if (observation.sourceReportedTimeMs > candidate.decisionEpochMs) {
        return {
          valid: false,
          error: `[CAUSAL_VIOLATION] FUTURE_SOURCE_TIMESTAMP_LOOKAHEAD: observation sourceReportedTimeMs (${observation.sourceReportedTimeMs}) > candidate decisionEpochMs (${candidate.decisionEpochMs})`,
        };
      }
      if (observation.sourceReportedTimeMs > observation.receiptEpochMs) {
        return {
          valid: false,
          error: `[CAUSAL_VIOLATION] SOURCE_AFTER_RECEIPT: observation sourceReportedTimeMs (${observation.sourceReportedTimeMs}) > receiptEpochMs (${observation.receiptEpochMs})`,
        };
      }
    }

    if (observation.compositeId.mintAddress !== candidate.compositeId.mintAddress) {
      return {
        valid: false,
        error: `[COMPOSITE_FOREIGN_KEY_MISMATCH] Observation mintAddress '${observation.compositeId.mintAddress}' does not match candidate mintAddress '${candidate.compositeId.mintAddress}'.`,
      };
    }

    if (observation.compositeId.poolId !== candidate.compositeId.poolId) {
      return {
        valid: false,
        error: `[COMPOSITE_FOREIGN_KEY_MISMATCH] Observation poolId '${observation.compositeId.poolId}' does not match candidate poolId '${candidate.compositeId.poolId}'.`,
      };
    }

    // D23C3-03: Validate actualResponsePoolId as an exact case-sensitive match to intended pool and verified matching flag
    if (
      typeof observation.actualResponsePoolId !== "string" ||
      observation.actualResponsePoolId.trim().length === 0
    ) {
      return {
        valid: false,
        error: `[ACTUAL_RESPONSE_POOL_MISMATCH] Observation actualResponsePoolId is missing or empty.`,
      };
    }

    if (observation.actualResponsePoolId !== candidate.compositeId.poolId) {
      return {
        valid: false,
        error: `[ACTUAL_RESPONSE_POOL_MISMATCH] Observation actualResponsePoolId '${observation.actualResponsePoolId}' does not exactly match intended candidate poolId '${candidate.compositeId.poolId}'.`,
      };
    }

    if (observation.actualResponsePoolId !== observation.compositeId.poolId) {
      return {
        valid: false,
        error: `[COMPOSITE_FOREIGN_KEY_MISMATCH] Observation actualResponsePoolId '${observation.actualResponsePoolId}' does not match observation composite poolId '${observation.compositeId.poolId}'.`,
      };
    }

    if (observation.isMatchingPool !== true) {
      return {
        valid: false,
        error: `[UNVERIFIED_MATCHING_POOL] Observation isMatchingPool flag is false (provider response pool unverified).`,
      };
    }
  }

  return { valid: true };
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
  private isClosing: boolean = false;
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
  private readonly rejectionReasonsCounts = new Map<string, number>();
  private interruptionReason?: string | undefined;
  private discoveryFunnel?: DiscoveryFunnelMetrics | undefined;

  // Append-time baseline tracking for deep reconciliation (D23F-03)
  private readonly seenDecisionEventIds = new Set<string>();
  private readonly decisionsBaseline = new Map<string, CandidateDecisionRecord>();
  private readonly evaluationsBaseline = new Map<string, ShadowEvaluationRecord>();
  private readonly observationsBaseline: MarketObservationRecord[] = [];
  private readonly discoveryDiagnosticsBaseline = new Map<string, DiscoveryDiagnosticRecord>();
  private writeMutex: Promise<void> = Promise.resolve();

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
      discoverySource: config.discoverySource ?? "dexscreener",
      maxPoolAgeSec: config.maxPoolAgeSec,
      minRequestIntervalMs: config.minRequestIntervalMs,
    };

    this.dataSource = dataSource;
    this.clock = clock;
    this.sessionDir = path.resolve(this.config.outputRootDir, this.config.sessionId);
    validatePathConfinement(this.sessionDir, this.config.outputRootDir, this.config.allowedRootDir);
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
      discoverySource: this.config.discoverySource,
      ...(this.config.maxPoolAgeSec !== undefined
        ? { maxPoolAgeSec: this.config.maxPoolAgeSec }
        : {}),
    };

    await this.writeSessionMeta(meta, false);
  }

  public async recordScreenedCandidate(
    candidate: D23ScreenedCandidate,
    observation?: D23ObservationRecord | undefined,
  ): Promise<void> {
    if (this.status !== "ACTIVE" || this.isClosing) {
      throw new Error(
        `[PilotCollectorRunner] Cannot record candidate in session state ${this.status} (closing=${this.isClosing})`,
      );
    }

    const eventId = candidate.compositeId.decisionEventId;

    // Reject duplicate decision IDs and reserve synchronously before ANY await (D23F-03, D23R-03)
    if (this.seenDecisionEventIds.has(eventId)) {
      throw new Error(
        `[PilotCollectorRunner] [DUPLICATE_DECISION_ID] Candidate decision '${eventId}' has already been recorded in this session.`,
      );
    }
    this.seenDecisionEventIds.add(eventId);

    let canonicalCandidate: CandidateDecisionRecord;
    let canonicalEvaluation: ShadowEvaluationRecord;
    let canonicalObs: MarketObservationRecord | null = null;
    let candidateLine: string;
    let evalLine: string;
    let obsLine: string;
    let diagRecord: DiscoveryDiagnosticRecord;
    let diagLine: string;
    let totalProjectedBytes: number;

    try {
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

      // 2. Foreign key consistency between candidate and observation (D23F-03)
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

      // 3. Enforce temporal causality, source time bounds, and clock/identity matching (D23R-01)
      const causality = validateCandidateCausality(candidate, observation);
      if (!causality.valid) {
        throw new Error(`[PilotCollectorRunner] ${causality.error}`);
      }

      // 4. Translate canonical records and enforce downstream contract and eligibility validation (D23R-01)
      canonicalCandidate = toCanonicalCandidateDecision(candidate, observation);
      canonicalEvaluation = toCanonicalShadowEvaluation(candidate, observation);
      validateShadowEvaluationRecord(canonicalEvaluation);
      const eligibility = validateShadowEvaluationEligibility(
        canonicalEvaluation,
        canonicalCandidate,
      );
      if (!eligibility.isEligible) {
        throw new Error(
          `[PilotCollectorRunner] [INELIGIBLE_CANDIDATE] Candidate failed shadow evaluation eligibility: ${eligibility.rejectionReasons.join(", ")}`,
        );
      }

      if (observation) {
        canonicalObs = toCanonicalMarketObservation(observation, this.config.strategyRevision);
      }

      // 5. Prospective file admission: check projected bytes before writing ANY record (D23F-02)
      candidateLine = JSON.stringify(canonicalCandidate) + "\n";
      evalLine = JSON.stringify(canonicalEvaluation) + "\n";
      obsLine = canonicalObs ? JSON.stringify(canonicalObs) + "\n" : "";

      diagRecord = {
        decisionEventId: candidate.compositeId.decisionEventId,
        sessionId: candidate.compositeId.sessionId,
        generationId: candidate.compositeId.generationId,
        mintAddress: candidate.compositeId.mintAddress,
        poolId: candidate.compositeId.poolId,
        symbol: candidate.symbol,
        discoverySource:
          candidate.discoverySource ??
          (candidate.selectionBias === "RAYDIUM_API_STANDARD_POOLS" ? "raydium" : "dexscreener"),
        cohortLabel: candidate.decisionCohort,
        primaryRejectionReason: candidate.rejectionReasons[0] ?? null,
        poolOpenTimeMs: candidate.poolOpenTimeMs ?? null,
        poolAgeAtDiscoverySec: candidate.poolAgeAtDiscoverySec ?? null,
        firstSeenEpochMs: candidate.firstSeenEpochMs ?? candidate.receiptEpochMs,
        decisionEpochMs: candidate.decisionEpochMs,
        sourceTimestampMs: candidate.sourceTimestampMs,
        requestEndpoint:
          candidate.discoveryEndpoint ??
          (candidate.discoverySource === "raydium"
            ? "https://api-v3.raydium.io/pools/info/list"
            : "https://api.dexscreener.com/token-profiles/latest/v1"),
        requestPage: candidate.discoveryPage ?? 1,
        requestSortField:
          candidate.discoverySortField ??
          (candidate.discoverySource === "raydium" ? "default" : "latest"),
        requestPageSize: candidate.discoverySource === "raydium" ? 50 : 30,
      };
      diagLine = JSON.stringify(diagRecord) + "\n";

      const candidateBytes = Buffer.byteLength(candidateLine, "utf8");
      const evalBytes = Buffer.byteLength(evalLine, "utf8");
      const obsBytes = obsLine ? Buffer.byteLength(obsLine, "utf8") : 0;
      const diagBytes = Buffer.byteLength(diagLine, "utf8");
      totalProjectedBytes = candidateBytes + evalBytes + obsBytes + diagBytes;
    } catch (err) {
      // Synchronous validation error before disk queue: cancel synchronous reservation (D23R-03)
      this.seenDecisionEventIds.delete(eventId);
      throw err;
    }

    // 6. Serialize async append and state mutations via writeMutex (D23R-03)
    const writeOp = async () => {
      // D23C3-01: Terminal boundary seal - reject queued write if runner has finalized or interrupted
      if (this.status !== "ACTIVE") {
        this.seenDecisionEventIds.delete(eventId);
        throw new Error(
          `[PilotCollectorRunner] [WRITE_AFTER_TERMINAL_BOUNDARY] Cannot write candidate '${eventId}': session status is ${this.status}`,
        );
      }

      try {
        this.checkWriteAdmission(totalProjectedBytes, false);
      } catch (err: unknown) {
        // Fail closed: immediately transition status to INTERRUPTED and write emergency metadata (D23F-02)
        this.status = "INTERRUPTED";
        this.isClosing = true;
        const reason = err instanceof Error ? err.message : String(err);
        this.interruptionReason = reason.includes("STORAGE_QUOTA_EXCEEDED")
          ? "STORAGE_QUOTA_EXCEEDED"
          : reason;
        await this.writeEmergencyInterruptedMetadata(this.interruptionReason);
        throw err;
      }

      // Append records to disk
      await this.appendFile("candidate-decisions.jsonl", candidateLine);
      await this.appendFile("shadow-evaluations.jsonl", evalLine);
      if (obsLine) {
        await this.appendFile("market-observations.jsonl", obsLine);
      }
      await this.appendFile("discovery-diagnostics.jsonl", diagLine);

      // Record immutable append snapshots for pre-finalization deep reconciliation (D23F-03)
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
      this.discoveryDiagnosticsBaseline.set(
        diagRecord.decisionEventId,
        JSON.parse(JSON.stringify(diagRecord)),
      );

      // Update counters
      this.totalCandidatesScreened += 1;
      if (candidate.decisionCohort === "WATCHLIST_RADAR") {
        this.totalWatchlistRadar += 1;
      } else {
        this.totalFilteredRejected += 1;
        const reason =
          canonicalCandidate.primaryRejectionReason ??
          candidate.rejectionReasons[0] ??
          "INELIGIBLE";
        this.rejectionReasonsCounts.set(reason, (this.rejectionReasonsCounts.get(reason) ?? 0) + 1);
      }
      if (candidate.compositeId.poolId) {
        this.uniquePoolsSeen.add(candidate.compositeId.poolId);
      }
      this.totalEvaluationsRecorded += 1;
      if (canonicalObs) {
        this.totalObservationsRecorded += 1;
      }
      this.consecutiveErrors = 0;

      // Check target stopping conditions
      if (
        this.totalCandidatesScreened >= this.config.targetCandidates &&
        this.uniquePoolsSeen.size >= this.config.targetPools
      ) {
        await this.finalizeInternal("FINALIZED");
      }
    };

    const previousMutex = this.writeMutex;
    const currentOp = previousMutex.then(writeOp, writeOp);
    this.writeMutex = currentOp.then(
      () => {},
      () => {},
    );
    await currentOp;
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

    // Reconcile discovery-diagnostics.jsonl (D25-F3)
    const diagPath = path.join(this.sessionDir, "discovery-diagnostics.jsonl");
    if (this.discoveryDiagnosticsBaseline.size > 0) {
      if (!fsSync.existsSync(diagPath)) {
        return { success: false, reason: "MISSING_PERSISTED_DISCOVERY_DIAGNOSTICS_FILE" };
      }
      const content = await fs.readFile(diagPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length !== this.discoveryDiagnosticsBaseline.size) {
        return {
          success: false,
          reason: `DIAGNOSTIC_COUNT_MISMATCH: expected ${this.discoveryDiagnosticsBaseline.size}, on-disk ${lines.length}`,
        };
      }
      for (const line of lines) {
        let parsed: DiscoveryDiagnosticRecord;
        try {
          parsed = JSON.parse(line);
        } catch {
          return { success: false, reason: "CORRUPT_JSONL_DIAGNOSTIC_LINE" };
        }
        const baseline = this.discoveryDiagnosticsBaseline.get(parsed.decisionEventId);
        if (!baseline) {
          return {
            success: false,
            reason: `UNKNOWN_DIAGNOSTIC_ON_DISK: ${parsed.decisionEventId}`,
          };
        }
        if (!deepEqualRecords(parsed, baseline)) {
          return {
            success: false,
            reason: `RECONCILIATION_IDENTITY_MISMATCH: Diagnostic record '${parsed.decisionEventId}' on disk does not match append baseline.`,
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
    if (this.status !== "ACTIVE" || this.isClosing) {
      return;
    }
    // D23C3-01: Immediately mark isClosing so new candidate admissions fail closed
    this.isClosing = true;

    // Drain all in-flight writes that entered before finalize was called
    const finalOp = async () => {
      await this.finalizeInternal(targetStatus, interruptionReason);
    };
    const prev = this.writeMutex;
    const curr = prev.then(finalOp, finalOp);
    this.writeMutex = curr.then(
      () => {},
      () => {},
    );
    await curr;
  }

  private async finalizeInternal(
    targetStatus: "FINALIZED" | "INTERRUPTED",
    interruptionReason?: string | undefined,
  ): Promise<void> {
    if (this.status !== "ACTIVE") {
      return;
    }
    // D23C3-01: Seal closing boundary so in-flight writes cannot proceed
    this.isClosing = true;

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
      discoverySource: this.config.discoverySource,
      ...(this.config.maxPoolAgeSec !== undefined
        ? { maxPoolAgeSec: this.config.maxPoolAgeSec }
        : {}),
    };

    await this.writeSessionMeta(meta, false);

    // D23C3-04: Evaluate exploratory flow observations without provider source time
    let exploratoryReceiptTimeFlowDecisions = 0;
    for (const dec of this.decisionsBaseline.values()) {
      const ms = dec.metricsSnapshot;
      const hasFlow =
        ms?.volume5mUsd !== null &&
        ms?.volume5mUsd !== undefined &&
        ms?.buys5m !== null &&
        ms?.buys5m !== undefined &&
        ms?.sells5m !== null &&
        ms?.sells5m !== undefined;
      const hasSourceTime =
        dec.sourceTimestampMs !== null &&
        dec.sourceTimestampMs !== undefined &&
        dec.sourceTimestampMs > 0 &&
        !dec.missingFields?.includes("sourceTimestampMs");
      if (hasFlow && !hasSourceTime) {
        exploratoryReceiptTimeFlowDecisions++;
      }
    }

    const summary: SessionTelemetrySummary & { researchClassification?: Record<string, unknown> } =
      {
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
        topRejectionReasons: (() => {
          const rejections: Record<string, number> = {};
          for (const [r, count] of this.rejectionReasonsCounts.entries()) {
            rejections[r] = count;
          }
          if (interruptionReason && Object.keys(rejections).length === 0) {
            rejections[interruptionReason] = 1;
          }
          return rejections;
        })(),
        totalMarketObservationsRecorded: this.totalObservationsRecorded,
        totalStratifiedCandidatesTracked: 0,
        missedWinnersCount: 0,
        avoidedRugsCount: 0,
        isCompleteSession: targetStatus === "FINALIZED",
        isInterruptedSession: targetStatus === "INTERRUPTED",
        discoverySource: this.config.discoverySource,
        ...(this.config.maxPoolAgeSec !== undefined
          ? { maxPoolAgeSec: this.config.maxPoolAgeSec }
          : {}),
        ...(this.discoveryFunnel ? { discoveryFunnel: this.discoveryFunnel } : {}),
        ...(exploratoryReceiptTimeFlowDecisions > 0
          ? {
              researchClassification: {
                classification: "RECEIPT_TIME_EXPLORATORY_SOURCE_UNVERIFIED",
                exploratoryReceiptTimeH2DecisionsCount: exploratoryReceiptTimeFlowDecisions,
                authoritativeD1H2DecisionsCount: 0,
                reconciliationNotice:
                  "Observed 5-minute flow metrics at receipt time without provider source timestamp attestation (sourceTimestampMs=0). Classified as receipt-time exploratory / source-time unverified, NOT authoritatively qualified D.1 H2 evidence.",
              },
            }
          : {}),
      };

    await this.writeSessionSummary(summary, false);

    if (targetStatus === "FINALIZED") {
      if (exploratoryReceiptTimeFlowDecisions > 0) {
        const compatibilityRecord = {
          sessionId: this.config.sessionId,
          generationId: this.config.generationId,
          strategyRevision: this.config.strategyRevision,
          totalCandidatesScreened: this.totalCandidatesScreened,
          exploratoryReceiptTimeH2DecisionsCount: exploratoryReceiptTimeFlowDecisions,
          authoritativeD1H2DecisionsCount: 0,
          classification: "RECEIPT_TIME_EXPLORATORY_SOURCE_UNVERIFIED",
          reconciliationStatus: "RECONCILED_WITH_CAVEAT",
          caveatNotice:
            "Observed 5-minute flow metrics at receipt time without provider source timestamp attestation (sourceTimestampMs=0). Classified as receipt-time exploratory / source-time unverified, NOT authoritatively qualified D.1 H2 evidence.",
        };
        await fs.writeFile(
          path.join(this.sessionDir, "pilot-research-compatibility.json"),
          JSON.stringify(compatibilityRecord, null, 2),
          "utf8",
        );
      }

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
      topRejectionReasons: (() => {
        const rejections: Record<string, number> = {};
        for (const [r, count] of this.rejectionReasonsCounts.entries()) {
          rejections[r] = count;
        }
        if (Object.keys(rejections).length === 0) {
          rejections[reason] = 1;
        }
        return rejections;
      })(),
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

    // Clean any torn lines in jsonl files and collect parsed records (D23F-03, D23R-02)
    const decisions: CandidateDecisionRecord[] = [];
    const evaluations: ShadowEvaluationRecord[] = [];
    const observations: MarketObservationRecord[] = [];

    const jsonlFiles = [
      { name: "candidate-decisions.jsonl", list: decisions },
      { name: "shadow-evaluations.jsonl", list: evaluations },
      { name: "market-observations.jsonl", list: observations },
      { name: "discovery-diagnostics.jsonl", list: [] },
    ];
    for (const { name: file, list } of jsonlFiles) {
      const filePath = path.join(sessionDir, file);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const lines = content.split("\n");
        const validLines: string[] = [];
        const corruptLines: string[] = [];

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            validLines.push(line);
            list.push(parsed);
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

    const priorStatus =
      meta?.sessionStatus ?? (meta as unknown as Record<string, unknown> | null)?.status;

    let mustInterrupt = false;
    let interruptionReason = "RECOVERED_FROM_UNGRACEFUL_PROCESS_INTERRUPTION";

    if (!meta || !summary) {
      mustInterrupt = true;
      interruptionReason = "RECOVERED_FROM_UNGRACEFUL_PROCESS_INTERRUPTION";
      diagnostics.push("Session lacks valid session-meta.json or session-summary.json");
    } else if (tornLinesIsolated > 0) {
      mustInterrupt = true;
      interruptionReason =
        priorStatus === "FINALIZED"
          ? "CORRUPTED_FINALIZED_ARCHIVE_QUARANTINED"
          : "RECOVERED_FROM_UNGRACEFUL_PROCESS_INTERRUPTION";
      diagnostics.push(`Isolated ${tornLinesIsolated} torn/corrupted line(s) in persisted files`);
    } else if (priorStatus !== "FINALIZED" || summary.isCompleteSession !== true) {
      mustInterrupt = true;
      interruptionReason = "RECOVERED_FROM_UNGRACEFUL_PROCESS_INTERRUPTION";
      diagnostics.push(
        `Session status was not finalized (meta status: ${priorStatus}, summary complete: ${summary.isCompleteSession})`,
      );
    } else {
      // 1. Cross-file metadata and summary consensus checks (D23R-02)
      if (meta.sessionId !== summary.sessionId) {
        mustInterrupt = true;
        interruptionReason = "METADATA_SUMMARY_IDENTITY_CONTRADICTION";
        diagnostics.push(
          `Metadata sessionId (${meta.sessionId}) contradicts summary sessionId (${summary.sessionId})`,
        );
      } else if (meta.generationId !== summary.generationId) {
        mustInterrupt = true;
        interruptionReason = "METADATA_SUMMARY_IDENTITY_CONTRADICTION";
        diagnostics.push(
          `Metadata generationId (${meta.generationId}) contradicts summary generationId (${summary.generationId})`,
        );
      } else if (
        meta.strategyRevision &&
        summary.strategyRevision &&
        meta.strategyRevision !== summary.strategyRevision
      ) {
        mustInterrupt = true;
        interruptionReason = "METADATA_SUMMARY_IDENTITY_CONTRADICTION";
        diagnostics.push(
          `Metadata strategyRevision (${meta.strategyRevision}) contradicts summary strategyRevision (${summary.strategyRevision})`,
        );
      } else if (
        meta.startedAtIso &&
        summary.startedAtIso &&
        meta.startedAtIso !== summary.startedAtIso
      ) {
        mustInterrupt = true;
        interruptionReason = "METADATA_SUMMARY_IDENTITY_CONTRADICTION";
        diagnostics.push(
          `Metadata startedAtIso (${meta.startedAtIso}) contradicts summary startedAtIso (${summary.startedAtIso})`,
        );
      } else if (
        meta.closedAtIso &&
        summary.closedAtIso &&
        meta.closedAtIso !== summary.closedAtIso
      ) {
        mustInterrupt = true;
        interruptionReason = "METADATA_SUMMARY_IDENTITY_CONTRADICTION";
        diagnostics.push(
          `Metadata closedAtIso (${meta.closedAtIso}) contradicts summary closedAtIso (${summary.closedAtIso})`,
        );
      } else if (
        meta.startedAtIso &&
        meta.closedAtIso &&
        Date.parse(meta.startedAtIso) > Date.parse(meta.closedAtIso)
      ) {
        mustInterrupt = true;
        interruptionReason = "METADATA_SUMMARY_IDENTITY_CONTRADICTION";
        diagnostics.push(
          `Metadata startedAtIso (${meta.startedAtIso}) is chronologically after closedAtIso (${meta.closedAtIso})`,
        );
      } else if (meta.isInterruptedSession || summary.isInterruptedSession) {
        mustInterrupt = true;
        interruptionReason = "METADATA_SUMMARY_IDENTITY_CONTRADICTION";
        diagnostics.push("Session flag claims finalized but has affirmative interruption flags");
      }

      // 2. Persisted record count consensus against summary (D23R-02)
      if (!mustInterrupt) {
        if (decisions.length !== summary.totalCandidatesScreened) {
          mustInterrupt = true;
          interruptionReason = "RECORD_COUNT_SUMMARY_CONTRADICTION";
          diagnostics.push(
            `Candidate decisions count (${decisions.length}) does not match summary totalCandidatesScreened (${summary.totalCandidatesScreened})`,
          );
        } else if (decisions.length !== summary.totalDecisionsRecorded) {
          mustInterrupt = true;
          interruptionReason = "RECORD_COUNT_SUMMARY_CONTRADICTION";
          diagnostics.push(
            `Candidate decisions count (${decisions.length}) does not match summary totalDecisionsRecorded (${summary.totalDecisionsRecorded})`,
          );
        } else if (evaluations.length !== summary.totalCandidatesScreened) {
          mustInterrupt = true;
          interruptionReason = "RECORD_COUNT_SUMMARY_CONTRADICTION";
          diagnostics.push(
            `Shadow evaluations count (${evaluations.length}) does not match summary totalCandidatesScreened (${summary.totalCandidatesScreened})`,
          );
        } else if (observations.length !== summary.totalMarketObservationsRecorded) {
          mustInterrupt = true;
          interruptionReason = "RECORD_COUNT_SUMMARY_CONTRADICTION";
          diagnostics.push(
            `Market observations count (${observations.length}) does not match summary totalMarketObservationsRecorded (${summary.totalMarketObservationsRecorded})`,
          );
        }
      }

      // 3. Persisted record linkage, complete 5-part foreign keys, and unique identities (D23R-02, D23C3-02)
      if (!mustInterrupt) {
        // A. Validate decision records and build identity map
        const decisionsMap = new Map<string, CandidateDecisionRecord>();
        const seenDecisionEventIds = new Set<string>();

        for (const dec of decisions) {
          if (seenDecisionEventIds.has(dec.eventId)) {
            mustInterrupt = true;
            interruptionReason = "DUPLICATE_PERSISTED_DECISION_ID";
            diagnostics.push(`Duplicate candidate decision eventId detected: '${dec.eventId}'`);
            break;
          }
          seenDecisionEventIds.add(dec.eventId);

          if (
            dec.sessionId !== meta.sessionId ||
            dec.generationId !== meta.generationId ||
            (meta.strategyRevision && dec.strategyRevision !== meta.strategyRevision)
          ) {
            mustInterrupt = true;
            interruptionReason = "PERSISTED_RECORD_FOREIGN_KEY_CONTRADICTION";
            diagnostics.push(
              `Decision record '${dec.eventId}' contradicts session identity: sessionId=${dec.sessionId}, generationId=${dec.generationId}, strategyRevision=${dec.strategyRevision}`,
            );
            break;
          }
          decisionsMap.set(dec.eventId, dec);
        }

        // B. Validate complete five-part evaluation-to-decision relationship and unique evaluation identities (D23C3-02)
        if (!mustInterrupt) {
          const seenEvaluationIds = new Set<string>();
          const seenEvaluatedDecisionIds = new Set<string>();

          for (const ev of evaluations) {
            if (seenEvaluationIds.has(ev.evaluationId)) {
              mustInterrupt = true;
              interruptionReason = "DUPLICATE_PERSISTED_EVALUATION_ID";
              diagnostics.push(
                `Duplicate shadow evaluation evaluationId detected: '${ev.evaluationId}'`,
              );
              break;
            }
            seenEvaluationIds.add(ev.evaluationId);

            if (seenEvaluatedDecisionIds.has(ev.decisionEventId)) {
              mustInterrupt = true;
              interruptionReason = "DUPLICATE_DECISION_EVALUATION";
              diagnostics.push(
                `Multiple shadow evaluations link to the same decisionEventId: '${ev.decisionEventId}'`,
              );
              break;
            }
            seenEvaluatedDecisionIds.add(ev.decisionEventId);

            // Complete five-part foreign key check against candidate decisions:
            // 1) decisionEventId must exist in persisted decisions (orphan evaluation check)
            const parentDec = decisionsMap.get(ev.decisionEventId);
            if (!parentDec) {
              mustInterrupt = true;
              interruptionReason = "ORPHAN_EVALUATION_RECORD";
              diagnostics.push(
                `Shadow evaluation '${ev.evaluationId}' is an orphan: references non-existent decisionEventId '${ev.decisionEventId}'`,
              );
              break;
            }

            // 2) sessionId, 3) generationId, 4) mintAddress, 5) poolId
            if (
              ev.sessionId !== parentDec.sessionId ||
              ev.generationId !== parentDec.generationId ||
              ev.mintAddress !== parentDec.mintAddress ||
              ev.poolId !== parentDec.poolId
            ) {
              mustInterrupt = true;
              interruptionReason = "EVALUATION_DECISION_IDENTITY_MISMATCH";
              diagnostics.push(
                `Shadow evaluation '${ev.evaluationId}' contradicts parent decision '${parentDec.eventId}' composite identity: ` +
                  `ev(session=${ev.sessionId}, gen=${ev.generationId}, mint=${ev.mintAddress}, pool=${ev.poolId}) vs ` +
                  `dec(session=${parentDec.sessionId}, gen=${parentDec.generationId}, mint=${parentDec.mintAddress}, pool=${parentDec.poolId})`,
              );
              break;
            }

            if (ev.sessionId !== meta.sessionId || ev.generationId !== meta.generationId) {
              mustInterrupt = true;
              interruptionReason = "PERSISTED_RECORD_FOREIGN_KEY_CONTRADICTION";
              diagnostics.push(
                `Shadow evaluation record '${ev.evaluationId}' contradicts session identity: sessionId=${ev.sessionId}, generationId=${ev.generationId}`,
              );
              break;
            }
          }
        }

        // C. Validate market observations and observation linkage (D23C3-02, D23C3-03)
        if (!mustInterrupt) {
          const seenObservationIds = new Set<string>();
          for (const obs of observations) {
            if (seenObservationIds.has(obs.observationId)) {
              mustInterrupt = true;
              interruptionReason = "DUPLICATE_PERSISTED_OBSERVATION_ID";
              diagnostics.push(
                `Duplicate market observation observationId detected: '${obs.observationId}'`,
              );
              break;
            }
            seenObservationIds.add(obs.observationId);

            if (obs.sessionId !== meta.sessionId || obs.generationId !== meta.generationId) {
              mustInterrupt = true;
              interruptionReason = "PERSISTED_RECORD_FOREIGN_KEY_CONTRADICTION";
              diagnostics.push(
                `Market observation record '${obs.observationId}' contradicts session identity: sessionId=${obs.sessionId}, generationId=${obs.generationId}`,
              );
              break;
            }

            // Check that observation pool & mint match a candidate decision in the session
            const matchesDec = decisions.some(
              (d) => d.poolId === obs.poolId && d.mintAddress === obs.mintAddress,
            );
            if (!matchesDec && decisions.length > 0) {
              mustInterrupt = true;
              interruptionReason = "ORPHAN_OBSERVATION_RECORD";
              diagnostics.push(
                `Market observation '${obs.observationId}' does not match any candidate decision pool/mint in session`,
              );
              break;
            }

            // If actualResponsePoolId is present, verify exact case-sensitive match (D23C3-03)
            if (obs.actualResponsePoolId && obs.actualResponsePoolId !== obs.poolId) {
              mustInterrupt = true;
              interruptionReason = "OBSERVATION_POOL_IDENTITY_MISMATCH";
              diagnostics.push(
                `Market observation '${obs.observationId}' actualResponsePoolId '${obs.actualResponsePoolId}' does not match poolId '${obs.poolId}'`,
              );
              break;
            }
          }
        }
      }

      // 4. Export manifest verification (D23P-04 / D23R-02)
      if (!mustInterrupt) {
        const manifestVerification = await verifySessionExportManifest(sessionDir);
        if (!manifestVerification.valid) {
          mustInterrupt = true;
          interruptionReason = "EXPORT_MANIFEST_VERIFICATION_FAILED";
          diagnostics.push(
            `Manifest verification failed during recovery: ${manifestVerification.errorDetails ?? "corrupted/mismatched files"}`,
          );
        }
      }
    }

    if (mustInterrupt) {
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
        recoveryDiagnostics: diagnostics,
      };
      await fs.writeFile(metaPath, JSON.stringify(repairedMeta, null, 2), "utf8");

      const repairedSummary: Record<string, unknown> = {
        sessionId: summary?.sessionId ?? meta?.sessionId ?? path.basename(sessionDir),
        generationId: summary?.generationId ?? meta?.generationId ?? "unknown",
        strategyRevision: summary?.strategyRevision ?? meta?.strategyRevision ?? "unknown",
        startedAtIso: summary?.startedAtIso ?? meta?.startedAtIso ?? new Date().toISOString(),
        closedAtIso: new Date().toISOString(),
        totalCandidatesScreened: decisions.length,
        totalDecisionsRecorded: decisions.length,
        decisionWriteFailures: summary?.decisionWriteFailures ?? 0,
        cohortBreakdown: summary?.cohortBreakdown ?? {
          filteredRejected: decisions.filter((d) => d.decisionCohort === "FILTERED_REJECTED")
            .length,
          watchlistRadar: decisions.filter((d) => d.decisionCohort === "WATCHLIST_RADAR").length,
          triggerRejected: 0,
          executedBuy: 0,
        },
        topRejectionReasons: (() => {
          const recoveredRejections: Record<string, number> = {};
          for (const dec of decisions) {
            if (dec.decisionCohort === "FILTERED_REJECTED") {
              const reason = dec.primaryRejectionReason ?? "INELIGIBLE";
              recoveredRejections[reason] = (recoveredRejections[reason] ?? 0) + 1;
            }
          }
          if (interruptionReason && Object.keys(recoveredRejections).length === 0) {
            recoveredRejections[interruptionReason] = 1;
          }
          return recoveredRejections;
        })(),
        totalMarketObservationsRecorded: observations.length,
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

  public setDiscoveryFunnel(funnel: DiscoveryFunnelMetrics): void {
    this.discoveryFunnel = funnel;
  }

  public getDiscoveryFunnel(): DiscoveryFunnelMetrics | undefined {
    return this.discoveryFunnel;
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

  public static async auditSessionCompatibility(
    sessionDir: string,
    options?: { legacySessionsDir?: string | undefined; reportOutputPath?: string | undefined },
  ): Promise<PilotSessionCompatibilityReport> {
    return auditPilotSessionCompatibility(sessionDir, options);
  }
}
