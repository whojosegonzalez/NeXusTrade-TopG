/**
 * Phase 12.94-D Milestone D.2.3: Empirical Market Data Pilot Types & Contracts
 *
 * Implements strict, offline-first contracts for the empirical research pilot.
 * Preserves separation between market telemetry, synthetic quoting, and execution.
 * Zero network dependencies, zero wallet access, zero trading daemon bindings.
 */

/**
 * Authoritative hypothesis mapping for Phase 12.94-D quantitative research.
 */
export const PILOT_HYPOTHESES = {
  H1: "Liquidity depth and AMM price impact",
  H2: "Order-flow momentum and buyer dominance",
  H3: "Structural safety and developer holdings",
  H4: "Capacity-aware position sizing",
} as const;

export type PilotHypothesisId = keyof typeof PILOT_HYPOTHESES;

/**
 * Canonical 5-Tier Execution Taxonomy (D23P-04 / Baseline).
 */
export const EXECUTION_TIERS = {
  TIER_1_OBSERVED: "Tier 1: Observed Market States (Read-only telemetry)",
  TIER_2_SYNTHETIC_QUOTES: "Tier 2: Synthetic Reserve Quotes (Local constant-product math)",
  TIER_3_AGGREGATOR_QUOTES: "Tier 3: Live Aggregator Quotes (Jupiter API - UNAUTHORIZED)",
  TIER_4_SIMULATED_FILLS: "Tier 4: Simulated Fills (Counterfactual research)",
  TIER_5_REAL_EXECUTION: "Tier 5: Real Execution (Keypair signing & broadcast - PROHIBITED)",
} as const;

export type ExecutionTierLevel = 1 | 2 | 3 | 4 | 5;

/**
 * Canonical Session Statuses. Strictly ACTIVE, FINALIZED, INTERRUPTED.
 */
export type CanonicalSessionStatus = "ACTIVE" | "FINALIZED" | "INTERRUPTED";

/**
 * Raydium AMM v4 binary state decoded from 752-byte account data (D23P-01).
 * All raw token integer amounts are preserved as exact `bigint` values.
 */
export interface D23RaydiumAmmV4State {
  readonly status: bigint;
  readonly baseDecimal: bigint;
  readonly quoteDecimal: bigint;
  readonly baseVault: string; // 32-byte pubkey in base58
  readonly quoteVault: string; // 32-byte pubkey in base58
  readonly baseMint: string; // 32-byte pubkey in base58
  readonly quoteMint: string; // 32-byte pubkey in base58
  readonly lpMint?: string | undefined; // 32-byte pubkey in base58
  readonly openOrders?: string | undefined; // 32-byte pubkey in base58
  readonly marketId?: string | undefined; // 32-byte pubkey in base58
  readonly marketProgramId?: string | undefined; // 32-byte pubkey in base58
  readonly targetOrders?: string | undefined; // 32-byte pubkey in base58
  readonly baseNeedTakePnl?: bigint | undefined;
  readonly quoteNeedTakePnl?: bigint | undefined;
  readonly baseTotalPnl?: bigint | undefined;
  readonly quoteTotalPnl?: bigint | undefined;
  readonly poolAddress: string;
  readonly programId: string;
  readonly accountSlot?: number | undefined;
}

/**
 * Raydium pair asset orientation.
 */
export type RaydiumPairOrientation =
  | "TOKEN_BASE_SOL_QUOTE" // Quote is WSOL; Base is target token
  | "SOL_BASE_TOKEN_QUOTE" // Base is WSOL; Quote is target token
  | "NON_SOL_PAIR"; // Neither is canonical WSOL

/**
 * Decoded SPL Token Vault Account State (165 bytes).
 */
export interface D23SplTokenVaultState {
  readonly vaultAddress: string;
  readonly mintAddress: string;
  readonly ownerAddress: string;
  readonly rawAmount: bigint;
  readonly slot?: number | undefined;
}

/**
 * Verified base and quote vault balances with slot coherence tracking (D23P-02).
 */
export interface D23VaultBalances {
  readonly baseVaultRaw: bigint;
  readonly quoteVaultRaw: bigint;
  readonly baseVaultSlot?: number | undefined;
  readonly quoteVaultSlot?: number | undefined;
  readonly slotDiscrepancy: boolean;
  readonly slotDelta?: number | undefined;
}

/**
 * Reserve accounting classification and computation mode (D23P-02).
 */
export interface D23ReserveAccounting {
  readonly mode: "VAULT_ONLY_PROXY" | "COMPLETE_AMM_ACCOUNTING";
  readonly tokenMint: string;
  readonly solMint: string;
  readonly tokenReserveRaw: bigint;
  readonly solReserveRaw: bigint;
  readonly tokenDecimals: number;
  readonly solDecimals: number;
  readonly tokenReserveDecimal: number;
  readonly solReserveDecimal: number;
  readonly spotPriceSol: number | null;
  readonly orientation: RaydiumPairOrientation;
  readonly effectiveReservesAvailable: boolean;
  readonly executionFeasible: boolean;
  readonly unavailabilityReason?: string | undefined;
}

/**
 * Dual-domain clock readings (D23P-03).
 */
export interface DualClockReading {
  /** UTC epoch millisecond timestamp for cross-record temporal causality */
  readonly epochMs: number;
  /** Host monotonic elapsed millisecond timestamp for latency/timeout profiling */
  readonly monotonicElapsedMs: number;
}

/**
 * Empirical observation payload with truthful temporal causality (D23P-03).
 */
export interface D23ObservationRecord {
  readonly observationId: string;
  readonly compositeId: {
    readonly decisionEventId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly mintAddress: string;
    readonly poolId: string;
  };
  readonly requestEpochMs: number;
  readonly receiptEpochMs: number;
  readonly sourceReportedTimeMs: number | null; // Nullable: never synthesized from HTTP headers or pair creation
  readonly hostMonotonicElapsedMs: number;
  readonly onChainSlot: number | null;
  readonly slotDiscrepancy: boolean;
  readonly provenance: "D23_OBSERVATIONAL_SCREENING";
  readonly providerIdentity: string;
  readonly actualResponsePoolId: string;
  readonly isMatchingPool: boolean;
  readonly reserveAccounting: D23ReserveAccounting | null;
  readonly flowMetrics: {
    readonly volume5mUsd: number | null;
    readonly buys5m: number | null;
    readonly sells5m: number | null;
    readonly netBuyerVolumeUsd: number | null;
  };
  readonly missingFields: readonly string[];
}

/**
 * Screened candidate record from two-stage discovery (D23P-01, D23P-03).
 */
export interface D23ScreenedCandidate {
  readonly compositeId: {
    readonly decisionEventId: string;
    readonly sessionId: string;
    readonly generationId: string;
    readonly mintAddress: string;
    readonly poolId: string;
  };
  readonly symbol: string;
  readonly decisionType: "CANDIDATE_DISCOVERY_PROFILE";
  readonly decisionCohort: "WATCHLIST_RADAR" | "FILTERED_REJECTED";
  readonly selectionBias: "DEXSCREENER_PROMOTIONAL_PROFILE" | "RAYDIUM_API_STANDARD_POOLS";
  readonly decisionEpochMs: number;
  readonly requestEpochMs: number;
  readonly receiptEpochMs: number;
  readonly sourceTimestampMs: number | null;
  readonly poolOpenTimeMs?: number | null | undefined;
  readonly poolAgeAtDiscoverySec?: number | null | undefined;
  readonly discoverySource?: "dexscreener" | "raydium" | undefined;
  readonly passedEligibility: boolean;
  readonly filterEvaluations: readonly {
    readonly filterName: string;
    readonly passed: boolean;
    readonly observed: unknown;
    readonly threshold: unknown;
    readonly rejectionReason?: string | undefined;
  }[];
  readonly rejectionReasons: readonly string[];
  readonly missingFields: readonly string[];
  readonly providerIdentity: string;
}

/**
 * Export manifest entry for a single file in the session directory (D23P-04).
 */
export interface ManifestFileEntry {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly lineCount?: number | undefined;
}

/**
 * Session export manifest for dataset transfer verification (D23P-04).
 */
export interface SessionExportManifest {
  readonly schemaVersion: "1.0.0";
  readonly sessionId: string;
  readonly generationId: string;
  readonly exportTimestampUtc: string;
  readonly exportEpochMs: number;
  readonly files: readonly ManifestFileEntry[];
  readonly manifestDigestSha256: string;
}

/**
 * Manifest verification result.
 */
export interface ManifestVerificationResult {
  readonly valid: boolean;
  readonly mismatchedFiles: readonly string[];
  readonly missingFiles: readonly string[];
  readonly extraFiles: readonly string[];
  readonly errorDetails?: string | undefined;
}

/**
 * Configuration for the bounded D.2.3 pilot runner.
 */
export interface PilotCollectorConfig {
  readonly sessionId: string;
  readonly generationId: string;
  readonly strategyRevision: string;
  readonly outputRootDir: string;
  readonly allowedRootDir?: string | undefined;
  readonly targetCandidates?: number | undefined; // Default 100
  readonly targetPools?: number | undefined; // Default 20
  readonly maxDurationSec?: number | undefined; // Default 7200s (2h)
  readonly maxDiskBytes?: number | undefined; // Default 20 MB (20 * 1024 * 1024)
  readonly maxEmergencyDiskBytes?: number | undefined; // Default 4096 bytes (emergency metadata allowance)
  readonly maxRssBytes?: number | undefined; // Default 256 MB (256 * 1024 * 1024)
  readonly maxConsecutiveErrors?: number | undefined; // Default 5
  readonly candidatePollIntervalMs?: number | undefined; // Default 60,000ms
  readonly discoverySource?: "dexscreener" | "raydium" | undefined;
  readonly maxPoolAgeSec?: number | undefined;
  readonly minRequestIntervalMs?: number | undefined;
}
