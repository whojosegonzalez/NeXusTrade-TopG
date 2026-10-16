/**
 * Phase 12.94-D Milestone D.2.2: Passive Shadow Collector Types & Contracts
 *
 * Implements strict, offline-first contracts for the shadow collection harness.
 * Zero network dependencies, zero wallet access, zero trading daemon bindings.
 */

export type { ProvenanceClass, UnavailabilityReason } from "../ResearchTypes.js";
export type {
  CandidateDecisionRecord,
  MarketObservationRecord,
  SessionTelemetryMeta,
  SessionTelemetrySummary,
} from "../../telemetry/TelemetryTypes.js";
export type {
  ShadowEvaluationRecord,
  ShadowQualificationResult,
  ShadowReserveSnapshot,
} from "../ShadowEvaluationTypes.js";

/**
 * Authoritative hypothesis mapping for Phase 12.94-D quantitative research.
 * Reconciled against D.1 / D.2 architecture baseline (D22-A04).
 */
export const RESEARCH_HYPOTHESES = {
  H1: "Liquidity depth and AMM price impact",
  H2: "Order-flow momentum and buyer dominance",
  H3: "Structural safety and developer holdings",
  H4: "Capacity-aware position sizing",
} as const;

export type ResearchHypothesisId = keyof typeof RESEARCH_HYPOTHESES;

/**
 * Provider capability verification status (D22-A04).
 * All provider capabilities are classified as UNVERIFIED_DESIGN_EXPECTATION
 * until empirical field-level telemetry proves real-world provider payload shapes.
 */
export type ProviderCapabilityStatus =
  | "UNVERIFIED_DESIGN_EXPECTATION"
  | "EMPIRICALLY_VERIFIED"
  | "PROVEN_UNAVAILABLE";

/**
 * Virtual clock interface for deterministic offline simulations (D22-A05, D22-A06).
 */
export interface IVirtualClock {
  /**
   * Returns simulated UTC epoch milliseconds.
   */
  now(): number;
  /**
   * Returns simulated monotonic elapsed milliseconds (isolated from epoch).
   */
  monotonicNow(): number;
  /**
   * Advances the virtual clock by a deterministic millisecond delta.
   */
  advanceBy(ms: number): void;
}

/**
 * Point-in-time pool reserve observation from mock provider.
 */
export interface PointInTimeReserves {
  readonly poolId: string;
  readonly baseReserve: number | null;
  readonly quoteReserve: number | null;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly responseReceivedMs: number;
  readonly isVerifiedPool?: boolean | undefined;
  readonly vaultA?: string | undefined;
  readonly vaultB?: string | undefined;
}

/**
 * Point-in-time order-flow and momentum metrics from mock provider.
 */
export interface PointInTimeMetrics {
  readonly mintAddress: string;
  readonly volume5mUsd: number | null;
  readonly buys5m: number | null;
  readonly sells5m: number | null;
  readonly txCount5m?: number | null | undefined;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly responseReceivedMs: number;
}

/**
 * Point-in-time structural safety and developer holdings from mock provider.
 */
export interface PointInTimeHoldings {
  readonly mintAddress: string;
  readonly devHoldingPct: number | null;
  readonly lpBurnPct: number | null;
  readonly devWalletAddress?: string | undefined;
  readonly isVerifiedDevWallet?: boolean | undefined;
  readonly sourceTimestampMs: number;
  readonly ingestionTimestampMs: number;
  readonly responseReceivedMs: number;
}

/**
 * Pure read-only interface for market data providers (D22-A05).
 * Zero network imports, zero execution capabilities.
 */
export interface IMarketDataProvider {
  readonly providerId: string;
  readonly capabilityStatus: ProviderCapabilityStatus;
  getPoolReserves(poolId: string): Promise<PointInTimeReserves>;
  getTokenMetrics(mintAddress: string): Promise<PointInTimeMetrics>;
  getDeveloperHoldings(mintAddress: string): Promise<PointInTimeHoldings>;
}

/**
 * Shadow collector lifecycle states.
 */
export type CollectorLifecycleState = "IDLE" | "COLLECTING" | "DRAINING" | "STOPPED" | "TERMINATED";

/**
 * Configuration for the shadow collector engine.
 */
export interface ShadowCollectorConfig {
  readonly sessionId: string;
  readonly generationId: string;
  readonly strategyRevision: string;
  /**
   * Output directory MUST be an explicitly injected temporary/fixture path.
   * Path confinement rejects any location inside canonical repositories or protected paths.
   */
  readonly outputRootDir: string;
  readonly maxSessionDiskBytes?: number | undefined; // Default 50 MB
  readonly maxRingBufferRecords?: number | undefined; // Default 1000 records
  readonly maxRssBytes?: number | undefined; // Default 256 MB
  readonly killSwitchPath?: string | undefined; // Optional custom kill switch trigger
  readonly flushIntervalMs?: number | undefined; // Default 5000ms
  readonly drainTimeoutMs?: number | undefined; // Default 3000ms
  readonly rateLimits?:
    | {
        readonly maxRequestsPerSecond: number;
        readonly burstCapacity: number;
        readonly retryBackoffBaseMs?: number | undefined;
        readonly maxRetryAttempts?: number | undefined;
      }
    | undefined;
}

/**
 * Summary emitted upon collector drain or shutdown.
 */
export interface SessionDrainSummary {
  readonly sessionId: string;
  readonly finalStatus: "FINALIZED" | "INTERRUPTED";
  readonly isCompleteSession: boolean;
  readonly interruptionReason?: string | undefined;
  readonly flushedDecisionsCount: number;
  readonly flushedObservationsCount: number;
  readonly flushedEvaluationsCount: number;
  readonly flushedSamplesCount: number;
  readonly closedAtIso: string;
}

/**
 * Diagnostic crash recovery result when scanning an interrupted session directory.
 */
export interface CrashRecoveryResult {
  readonly sessionId: string;
  readonly recoveredStatus: "INTERRUPTED" | "FINALIZED" | "CORRUPTED";
  readonly validDecisionsCount: number;
  readonly validObservationsCount: number;
  readonly validEvaluationsCount: number;
  readonly tornLinesQuarantinedCount: number;
  readonly repairedFiles: readonly string[];
  readonly quarantinedFiles: readonly string[];
  readonly diagnosticsFileWritten: boolean;
}

/**
 * Path confinement verification options.
 */
export interface PathConfinementOptions {
  readonly repoRootDir?: string | undefined;
  readonly forbiddenPaths?: readonly string[] | undefined;
  readonly allowedRoot?: string | undefined;
}

/**
 * Session ID validation result.
 */
export interface SessionIdValidationResult {
  readonly isValid: boolean;
  readonly sanitizedSessionId?: string | undefined;
  readonly error?: string | undefined;
  readonly rejectionReason?: string | undefined;
}

/**
 * Path confinement verification result.
 */
export interface PathConfinementResult {
  readonly isConfinementValid: boolean;
  readonly resolvedPath: string;
  readonly rejectionReason?: string | undefined;
}
