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
 * Governed Quote Asset Research Classification Cohort (D28-ADG-02).
 * Orthogonal to strategy cohorts (Established Runner vs Micro-Cap Probe).
 */
export type QuoteAssetCohort =
  | "WSOL_NATIVE" // Paired directly with WSOL (Single-hop execution candidate)
  | "STABLECOIN_USD" // Paired directly with USDC/USDT (Requires synchronous reference rate)
  | "EXOTIC_CROSS"; // Meme-to-meme or other SPL cross-pair (Observation-only quarantined)

/**
 * CPMM Reserve and Price Verification Tier (D28-F3, D28-F4).
 */
export type CpmmVerificationTier =
  | "INDEPENDENTLY_COHERENT" // All 3 slots match exactly, authority & token programs verified, pool owner verified
  | "PARTIALLY_VERIFIED" // Decoded without error but lacks complete slot provenance or authority proof
  | "SLOT_DISCREPANT" // Explicit mismatch between vault slots or pool-to-vault slots
  | "UNAVAILABLE"; // Insolvent reserves, zero reserves, or data mismatch

/**
 * Decoded Raydium CPMM Pool State (637 bytes Anchor layout: raydium-cp-swap v0.1.0).
 * All raw token integer amounts are preserved as exact `bigint` values.
 */
export interface D28RaydiumCpmmState {
  readonly ammConfig: string;
  readonly poolCreator: string;
  readonly token0Vault: string;
  readonly token1Vault: string;
  readonly lpMint: string;
  readonly token0Mint: string;
  readonly token1Mint: string;
  readonly token0Program: string;
  readonly token1Program: string;
  readonly observationKey: string;
  readonly authBump: number;
  readonly status: number;
  readonly lpMintDecimals: number;
  readonly mint0Decimals: number;
  readonly mint1Decimals: number;
  readonly lpSupply: bigint;
  readonly protocolFeesToken0: bigint;
  readonly protocolFeesToken1: bigint;
  readonly fundFeesToken0: bigint;
  readonly fundFeesToken1: bigint;
  /** Creator fee collection mode (0: BothToken, 1: OnlyToken0, 2: OnlyToken1) */
  readonly creatorFeeOn: number;
  /** Whether creator trade fees are enabled for this pool */
  readonly enableCreatorFee: boolean;
  /** Accumulated uncollected creator fees for token 0 */
  readonly creatorFeesToken0: bigint;
  /** Accumulated uncollected creator fees for token 1 */
  readonly creatorFeesToken1: bigint;
  /** Recent epoch of pool interaction */
  readonly recentEpoch: bigint;
  /** Pool unlock / swap-activation Unix timestamp in seconds (not independently established pool-creation time) */
  readonly swapActivationTimeSec: bigint;
  readonly poolAddress: string;
  /** Verified program ID or null if unverified/missing owner proof (D28-F3) */
  readonly programId: string | null;
  /** Whether pool account owner was independently confirmed as canonical CPMM program */
  readonly ownerVerified: boolean;
  readonly accountSlot?: number | undefined;
}

/**
 * CPMM Reserve Accounting with Fee Liability Segregation (D28-ADG-02, D28-F1, D28-F3, D28-F4).
 */
export interface D28CpmmReserveAccounting {
  readonly poolAddress: string;
  readonly token0Mint: string;
  readonly token1Mint: string;
  readonly token0Decimals: number;
  readonly token1Decimals: number;
  readonly token0VaultRaw: bigint;
  readonly token1VaultRaw: bigint;
  readonly protocolFeesToken0Raw: bigint;
  readonly protocolFeesToken1Raw: bigint;
  readonly fundFeesToken0Raw: bigint;
  readonly fundFeesToken1Raw: bigint;
  readonly creatorFeesToken0Raw: bigint;
  readonly creatorFeesToken1Raw: bigint;
  readonly token0TotalFeesRaw: bigint;
  readonly token1TotalFeesRaw: bigint;
  readonly effectiveReserve0Raw: bigint;
  readonly effectiveReserve1Raw: bigint;
  readonly effectiveReserve0Decimal: number;
  readonly effectiveReserve1Decimal: number;
  readonly spotPrice0Per1: number | null;
  readonly spotPrice1Per0: number | null;
  readonly spotPriceSol: number | null;
  readonly quoteCohort: QuoteAssetCohort;
  readonly orientation: RaydiumPairOrientation;
  readonly effectiveReservesAvailable: boolean;
  readonly verificationTier: CpmmVerificationTier;
  readonly isCoherentPointInTime: boolean;
  readonly poolOwnerVerified: boolean;
  readonly vaultAuthoritiesVerified: boolean;
  readonly vaultTokenProgramsVerified: boolean;
  readonly slotProvenanceComplete: boolean;
  readonly slotDiscrepancy: boolean;
  readonly poolSlot?: number | undefined;
  readonly vault0Slot?: number | undefined;
  readonly vault1Slot?: number | undefined;
  readonly slotDelta?: number | undefined;
  readonly poolVaultSlotDelta?: number | undefined;
  readonly unavailabilityReason?: string | undefined;
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
  readonly firstSeenEpochMs?: number | null | undefined;
  readonly discoverySource?: "dexscreener" | "raydium" | "events" | undefined;
  readonly discoveryEndpoint?: string | undefined;
  readonly discoveryPage?: number | undefined;
  readonly discoverySortField?: string | undefined;
  readonly discoveryPollCycle?: number | undefined;
  readonly isInitialCatalogSnapshot?: boolean | undefined;
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
 * Diagnostic sidecar record for candidate discovery provenance (D25-F3).
 */
export interface DiscoveryDiagnosticRecord {
  readonly decisionEventId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly mintAddress: string;
  readonly poolId: string;
  readonly symbol: string;
  readonly discoverySource: string;
  readonly cohortLabel: "WATCHLIST_RADAR" | "FILTERED_REJECTED";
  readonly primaryRejectionReason: string | null;
  readonly poolOpenTimeMs: number | null;
  readonly poolAgeAtDiscoverySec: number | null;
  readonly firstSeenEpochMs: number;
  readonly decisionEpochMs: number;
  readonly sourceTimestampMs: number | null;
  readonly requestEndpoint: string;
  readonly requestPage: number;
  readonly requestSortField: string;
  readonly requestPageSize: number;
  readonly discoveryPollCycle?: number | undefined;
  readonly isInitialCatalogSnapshot?: boolean | undefined;
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
  readonly targetCandidates?: number | undefined; // Default 100 (or targetDiagnosticYield)
  readonly maxCandidatesScreened?: number | undefined; // Safety ceiling for screened candidates (default 500)
  readonly targetDiagnosticYield?: number | undefined; // Target yield of eligible candidates (default 15)
  readonly targetPools?: number | undefined; // Default 20
  readonly maxDurationSec?: number | undefined; // Default 7200s (2h)
  readonly maxDiskBytes?: number | undefined; // Default 20 MB (20 * 1024 * 1024)
  readonly maxEmergencyDiskBytes?: number | undefined; // Default 4096 bytes (emergency metadata allowance)
  readonly maxRssBytes?: number | undefined; // Default 256 MB (256 * 1024 * 1024)
  readonly maxConsecutiveErrors?: number | undefined; // Default 5
  readonly candidatePollIntervalMs?: number | undefined; // Default 60,000ms
  readonly discoverySource?: "dexscreener" | "raydium" | "events" | undefined;
  readonly maxPoolAgeSec?: number | undefined;
  readonly minRequestIntervalMs?: number | undefined;
}

// Re-export Phase 12.94-D.2.9-A Event Discovery Contracts & Interfaces
export * from "./EventDiscoveryContracts.js";
