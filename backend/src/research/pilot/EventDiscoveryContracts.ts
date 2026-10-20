/**
 * Phase 12.94-D Milestone D.2.9-A: Event Discovery Contracts & Lifecycle Specifications
 *
 * Implements strict, offline-first, protocol-neutral contracts for Solana event-driven
 * pool discovery and verification.
 *
 * Requirements (D29-A1, D29-A2, D29-A3, D29-A5):
 * 1. Typed WebSocket log-notification envelopes.
 * 2. Transaction signature and slot provenance.
 * 3. Subscription commitment and observation timestamps.
 * 4. Versioned transaction decoding inputs (legacy and v0 with Address Lookup Tables).
 * 5. Initialization event classification: AMM v4, CPMM, and explicit unsupported protocols.
 * 6. Disconnected lifecycle states: detection, retrieval, decode, and verification.
 * 7. Bounded queue, deduplication, retry accounting, and failure semantics.
 * 8. Coverage and latency metrics with honest reporting.
 */

import type {
  CpmmVerificationTier,
  D23RaydiumAmmV4State,
  D28CpmmReserveAccounting,
  D28RaydiumCpmmState,
  QuoteAssetCohort,
} from "./PilotTypes.js";

/**
 * Subscription commitment levels for Solana WebSocket subscriptions.
 */
export type SubscriptionCommitment = "processed" | "confirmed" | "finalized";

/**
 * WebSocket connection status for event listener telemetry.
 */
export type WebSocketConnectionStatus =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "SUBSCRIBED"
  | "RECONNECTING"
  | "STALE_DROPPED";

/**
 * Value payload inside a Solana logsNotification result.
 */
export interface SolanaRpcLogNotificationValue {
  readonly signature: string;
  readonly err: unknown | null;
  readonly logs: readonly string[];
}

/**
 * Context payload inside a Solana logsNotification result.
 */
export interface SolanaRpcLogNotificationContext {
  readonly slot: number;
}

/**
 * Parameters object of a standard Solana WebSocket JSON-RPC logsNotification.
 */
export interface SolanaRpcLogNotificationParams {
  readonly result: {
    readonly context: SolanaRpcLogNotificationContext;
    readonly value: SolanaRpcLogNotificationValue;
  };
  readonly subscription: number;
}

/**
 * Fully typed WebSocket JSON-RPC log-notification envelope.
 */
export interface WebSocketLogNotificationEnvelope {
  readonly jsonrpc: "2.0";
  readonly method: "logsNotification";
  readonly params: SolanaRpcLogNotificationParams;
}

/**
 * Instruction data encodings supported by Solana JSON RPC and pilot ingestion.
 */
export type InstructionDataEncoding = "raw" | "base58" | "base64";

/**
 * Individual compiled instruction within a Solana transaction.
 */
export interface CompiledInstruction {
  readonly programIdIndex: number;
  readonly accountKeyIndexes: readonly number[];
  readonly data: Uint8Array | Buffer | string; // Raw bytes, base58, or base64 string
  readonly dataEncoding?: InstructionDataEncoding | undefined;
}

/**
 * Account resolution structure supporting Version 0 (v0) Address Lookup Tables (ALTs).
 */
export interface VersionedTransactionAccountResolution {
  readonly staticAccountKeys: readonly string[];
  readonly loadedAddresses?:
    | {
        readonly writable: readonly string[];
        readonly readonly: readonly string[];
      }
    | undefined;
}

/**
 * Inner instruction group resulting from CPI calls.
 */
export interface InnerInstructionGroup {
  readonly index: number;
  readonly instructions: readonly CompiledInstruction[];
}

/**
 * Versioned transaction metadata required for offline pool initialization recognition.
 */
export interface VersionedTransactionMetadata {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err: unknown | null;
  readonly version: "legacy" | 0;
  readonly accountKeys: VersionedTransactionAccountResolution;
  readonly instructions: readonly CompiledInstruction[];
  readonly innerInstructions?: readonly InnerInstructionGroup[] | undefined;
  readonly logMessages?: readonly string[] | undefined;
}

/**
 * Governed protocol classification for discovered pool initialization events.
 */
export type DiscoveredProtocolType = "RAYDIUM_AMM_V4" | "RAYDIUM_CPMM" | "UNSUPPORTED_PROTOCOL";

/**
 * Explicit reasons for classifying an event as an unsupported protocol or non-init instruction.
 */
export type UnsupportedProtocolReason =
  | "ORCA_WHIRLPOOL"
  | "RAYDIUM_CLMM"
  | "METEORA_DLMM"
  | "PUMP_FUN"
  | "MOONSHOT"
  | "UNKNOWN_PROGRAM"
  | "NON_INITIALIZATION_INSTRUCTION"
  | "DEPRECATED_INITIALIZE_TAG"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_SIGNATURE_MISMATCH"
  | "MISSING_ACCOUNTS"
  | "CORRUPTED_INSTRUCTION_DATA"
  | "UNRESOLVED_LOOKUP_TABLE_INDEX";

/**
 * Representation of an identified pool initialization event.
 * Preserves strict separation between creation blockTime, host observation, and pool activation openTime.
 */
export interface DiscoveredPoolInitializationEvent {
  readonly eventId: string; // ${signature}:${outerInstructionIndex} or ${signature}:${outerInstructionIndex}:inner:${innerInstructionIndex}
  readonly signature: string;
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex?: number | undefined;
  readonly instructionIndex: number; // Retained for backward compatibility (= outerInstructionIndex)
  readonly slot: number;
  readonly blockTimeSec: number | null;
  readonly firstSeenTimestampMs: number;
  readonly poolOpenTimeSec: number | null;
  readonly protocol: DiscoveredProtocolType;
  readonly unsupportedReason?: UnsupportedProtocolReason | undefined;
  readonly poolId: string;
  readonly token0Mint: string;
  readonly token1Mint: string;
  readonly token0Vault: string;
  readonly token1Vault: string;
  readonly lpMint?: string | undefined;
  readonly token0Program?: string | undefined;
  readonly token1Program?: string | undefined;
  readonly ammConfigOrMarket?: string | undefined;
  readonly authorityPda?: string | undefined;
  readonly creatorWallet?: string | undefined;
  readonly rawInstructionDataHex?: string | undefined;
}

/**
 * Distinct, auditable lifecycle states for discovered event processing.
 */
export type EventLifecycleState =
  | "LOG_DETECTED"
  | "TX_FETCH_QUEUED"
  | "TX_FETCHED"
  | "TX_DECODE_SUCCESS"
  | "TX_DECODE_FAILED"
  | "VERIFICATION_QUEUED"
  | "VERIFIED_COHERENT"
  | "PARTIALLY_VERIFIED"
  | "SLOT_DISCREPANT"
  | "REJECTED_NON_COHERENT"
  | "VERIFICATION_FAILED"
  | "DROPPED_RESOURCE_LIMIT"
  | "DUPLICATE_IGNORED";

/**
 * Generic account payload returned by read-only RPC fetchers.
 */
export interface DiscoveredPoolAccountPayload {
  readonly address: string;
  readonly data: Buffer | Uint8Array;
  readonly owner: string;
  readonly lamports: bigint | number;
  readonly slot: number;
}

/**
 * Interface for decoupled, read-only on-chain account fetching.
 * Kept strictly behind interfaces to enable deterministic offline testing.
 */
export interface IOnChainAccountFetcher {
  getAccountInfo(address: string): Promise<DiscoveredPoolAccountPayload | null>;
  getMultipleAccounts(
    addresses: readonly string[],
  ): Promise<readonly (DiscoveredPoolAccountPayload | null)[]>;
  getSlot(): Promise<number>;
}

/**
 * Result of independent on-chain verification dispatch.
 */
export interface VerificationDispatchResult {
  readonly poolId: string;
  readonly protocol: DiscoveredProtocolType;
  readonly verified: boolean;
  readonly rejectionReason?: string | undefined;
  readonly verificationTier: CpmmVerificationTier | "VERIFIED_AMM_V4" | "REJECTED";
  readonly transactionSlot: number;
  readonly poolAccountSlot: number | null;
  readonly vault0AccountSlot: number | null;
  readonly vault1AccountSlot: number | null;
  readonly slotDiscrepancy: boolean;
  readonly slotDelta: number;
  readonly verifiedAtEpochMs: number;
  readonly hostObservationTimestampMs: number;
  readonly effectiveReservesAvailable: boolean;
  readonly spotPriceSol: number | null;
  readonly spotPrice0Per1: number | null;
  readonly quoteCohort?: QuoteAssetCohort | undefined;
  readonly decodedAmmState?: D23RaydiumAmmV4State | undefined;
  readonly decodedCpmmState?: D28RaydiumCpmmState | undefined;
  readonly cpmmReserveAccounting?: D28CpmmReserveAccounting | undefined;
}

/**
 * Comprehensive coverage, latency, and causality metrics snapshot.
 */
export interface EventDiscoveryMetricsSnapshot {
  readonly connectionStatus: WebSocketConnectionStatus;
  readonly rawLogNotificationsReceived: number;
  readonly uniqueTransactionsEncountered: number;
  readonly duplicateNotificationsIgnored: number;
  readonly successfulInitDecodes: number;
  readonly failedInitDecodes: number;
  readonly candidatePoolsDiscovered: number;
  readonly duplicatePoolIdsIgnored: number;
  readonly transactionFetchFailures: number;
  readonly transactionFetchRetries: number;
  readonly exhaustedRetriesCount: number;
  readonly rpcVerificationFailures: number;
  readonly queueFullDrops: number;
  readonly rateLimitDrops: number;
  readonly reconnectEvents: number;
  readonly detectedGaps: number;
  readonly boundedBackfillAttempts: number;
  readonly averageDetectionLatencyMs: number;
  readonly averageVerificationLatencyMs: number;
  readonly averageTotalDiscoveryLatencyMs: number;
  readonly maxSlotDeltaObserved: number;
  readonly slotDiscrepancyIncidents: number;
  readonly coherentTierPoolsCount: number;
  readonly partiallyVerifiedTierCount: number;
  readonly slotDiscrepantTierCount: number;
  readonly unavailableTierCount: number;
}
