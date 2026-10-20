/**
 * Phase 12.94-D Milestone D.2.9-A: Protocol-Neutral Event Discovery Ingestion Engine
 *
 * Implements the offline event ingestion pipeline capable of receiving WebSocket
 * log-notification envelopes, resolving versioned transaction metadata, identifying
 * pool initialization instructions, managing bounded queues with backpressure,
 * idempotently deduplicating events, and dispatching to read-only on-chain parsers.
 *
 * Requirements (D29-A1, D29-A5):
 * 1. Typed WebSocket log-notification envelopes.
 * 2. Bounded queue with configurable capacity and backpressure policy (DROP_OLDEST / DROP_NEWEST).
 * 3. Idempotent deduplication across transaction signatures and pool IDs.
 * 4. Retry accounting with failure semantics.
 * 5. WebSocket connection lifecycle simulation (CONNECTING, SUBSCRIBED, RECONNECTING, etc.).
 * 6. Honest coverage, latency, and causality metrics tracking.
 * 7. Zero live network or WebSocket activity: 100% offline injectable interfaces.
 */

import type {
  EventDiscoveryMetricsSnapshot,
  EventLifecycleState,
  IOnChainAccountFetcher,
  VerificationDispatchResult,
  VersionedTransactionMetadata,
  WebSocketConnectionStatus,
  WebSocketLogNotificationEnvelope,
} from "./EventDiscoveryContracts.js";
import { identifyPoolInitializationInstruction } from "./PoolInitializationParser.js";
import { dispatchPoolVerification } from "./VerificationDispatchService.js";

/**
 * Interface for decoupled transaction retrieval.
 */
export interface ITransactionFetcher {
  fetchTransaction(signature: string): Promise<VersionedTransactionMetadata | null>;
}

/**
 * Configuration options for the ingestion engine.
 */
export interface EventDiscoveryEngineOptions {
  readonly maxQueueSize?: number | undefined; // Maximum queue capacity (default 500)
  readonly backpressurePolicy?: "DROP_OLDEST" | "DROP_NEWEST" | undefined; // Default DROP_OLDEST
  readonly maxRetriesPerTx?: number | undefined; // Max fetch attempts (default 3)
  readonly clock?: { now(): number } | undefined; // Injectable clock for deterministic tests
}

interface QueuedItem {
  readonly signature: string;
  readonly slot: number;
  readonly detectedAtMs: number;
  retryCount: number;
  lifecycleState: EventLifecycleState;
}

/**
 * Protocol-neutral event discovery ingestion engine.
 */
export class EventDiscoveryIngestionEngine {
  private readonly maxQueueSize: number;
  private readonly backpressurePolicy: "DROP_OLDEST" | "DROP_NEWEST";
  private readonly maxRetries: number;
  private readonly clock: { now(): number };

  private connectionStatus: WebSocketConnectionStatus = "DISCONNECTED";
  private queue: QueuedItem[] = [];
  private readonly seenSignatures = new Set<string>();
  private readonly seenEventIds = new Set<string>();
  private readonly seenPoolIds = new Set<string>();

  // Metrics counters
  private rawLogNotificationsReceived = 0;
  private uniqueTransactionsEncountered = 0;
  private duplicateNotificationsIgnored = 0;
  private successfulInitDecodes = 0;
  private failedInitDecodes = 0;
  private candidatePoolsDiscovered = 0;
  private duplicatePoolIdsIgnored = 0;
  private transactionFetchFailures = 0;
  private rpcVerificationFailures = 0;
  private queueFullDrops = 0;
  private rateLimitDrops = 0;
  private reconnectEvents = 0;
  private detectedGaps = 0;
  private boundedBackfillAttempts = 0;

  // Latency tracking
  private totalDetectionLatencyMs = 0;
  private detectionLatencySamples = 0;
  private totalVerificationLatencyMs = 0;
  private verificationLatencySamples = 0;
  private totalDiscoveryLatencyMs = 0;
  private totalDiscoverySamples = 0;

  // Causality tracking
  private maxSlotDeltaObserved = 0;
  private slotDiscrepancyIncidents = 0;
  private coherentTierPoolsCount = 0;
  private partiallyVerifiedTierCount = 0;
  private slotDiscrepantTierCount = 0;
  private unavailableTierCount = 0;

  constructor(options: EventDiscoveryEngineOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 500;
    this.backpressurePolicy = options.backpressurePolicy ?? "DROP_OLDEST";
    this.maxRetries = options.maxRetriesPerTx ?? 3;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  // --------------------------------------------------------------------------
  // Connection Lifecycle Simulation
  // --------------------------------------------------------------------------

  public setConnectionStatus(status: WebSocketConnectionStatus): void {
    this.connectionStatus = status;
  }

  public simulateDisconnect(): void {
    this.connectionStatus = "RECONNECTING";
    this.reconnectEvents += 1;
  }

  public simulateReconnect(lastObservedSlot: number, currentSlot: number): void {
    this.connectionStatus = "SUBSCRIBED";
    if (currentSlot - lastObservedSlot > 1) {
      this.detectedGaps += 1;
      this.boundedBackfillAttempts += 1;
    }
  }

  // --------------------------------------------------------------------------
  // Ingestion & Enqueueing
  // --------------------------------------------------------------------------

  /**
   * Receives a raw WebSocket log-notification envelope.
   */
  public async handleLogNotification(
    envelope: WebSocketLogNotificationEnvelope,
  ): Promise<{ enqueued: boolean; reason?: string }> {
    this.rawLogNotificationsReceived += 1;

    const value = envelope.params?.result?.value;
    const context = envelope.params?.result?.context;

    if (!value || !value.signature) {
      return { enqueued: false, reason: "MALFORMED_ENVELOPE" };
    }

    const signature = value.signature;
    const slot = context?.slot ?? 0;
    const now = this.clock.now();

    // Idempotent deduplication check
    if (this.seenSignatures.has(signature)) {
      this.duplicateNotificationsIgnored += 1;
      return { enqueued: false, reason: "DUPLICATE_SIGNATURE" };
    }
    this.seenSignatures.add(signature);
    this.uniqueTransactionsEncountered += 1;

    // Fail early on failed transaction
    if (value.err !== null) {
      this.failedInitDecodes += 1;
      return { enqueued: false, reason: "FAILED_TRANSACTION" };
    }

    // Check bounded queue capacity
    if (this.queue.length >= this.maxQueueSize) {
      this.queueFullDrops += 1;
      if (this.backpressurePolicy === "DROP_OLDEST") {
        this.queue.shift(); // Drop oldest
      } else {
        return { enqueued: false, reason: "QUEUE_FULL_DROP_NEWEST" };
      }
    }

    const item: QueuedItem = {
      signature,
      slot,
      detectedAtMs: now,
      retryCount: 0,
      lifecycleState: "LOG_DETECTED",
    };

    this.queue.push(item);
    return { enqueued: true };
  }

  // --------------------------------------------------------------------------
  // Queue Processing & Verification Dispatch
  // --------------------------------------------------------------------------

  /**
   * Processes all pending items in the bounded queue.
   */
  public async processQueue(
    txFetcher: ITransactionFetcher,
    accountFetcher: IOnChainAccountFetcher,
  ): Promise<readonly VerificationDispatchResult[]> {
    const results: VerificationDispatchResult[] = [];

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.lifecycleState = "TX_FETCH_QUEUED";

      // 1. Fetch transaction metadata
      let tx: VersionedTransactionMetadata | null = null;
      try {
        tx = await txFetcher.fetchTransaction(item.signature);
      } catch {
        tx = null;
      }

      if (!tx) {
        if (item.retryCount < this.maxRetries) {
          item.retryCount += 1;
          this.queue.push(item); // Re-enqueue for retry
          continue;
        } else {
          this.transactionFetchFailures += 1;
          item.lifecycleState = "TX_DECODE_FAILED";
          continue;
        }
      }

      item.lifecycleState = "TX_FETCHED";

      // 2. Parse pool initialization instruction
      const parseResult = identifyPoolInitializationInstruction(tx, item.detectedAtMs);
      if (!parseResult.ok) {
        this.failedInitDecodes += 1;
        item.lifecycleState = "TX_DECODE_FAILED";
        continue;
      }

      const event = parseResult.event;
      item.lifecycleState = "TX_DECODE_SUCCESS";
      this.successfulInitDecodes += 1;

      // Deduplicate pool ID
      if (this.seenPoolIds.has(event.poolId)) {
        this.duplicatePoolIdsIgnored += 1;
        item.lifecycleState = "DUPLICATE_IGNORED";
        continue;
      }
      this.seenPoolIds.add(event.poolId);
      this.candidatePoolsDiscovered += 1;

      // Track detection latency (if blockTime is available)
      if (event.blockTimeSec !== null) {
        const blockTimeMs = event.blockTimeSec * 1000;
        const detectionLatencyMs = Math.max(0, item.detectedAtMs - blockTimeMs);
        this.totalDetectionLatencyMs += detectionLatencyMs;
        this.detectionLatencySamples += 1;
      }

      // 3. Dispatch to independent on-chain verification
      item.lifecycleState = "VERIFICATION_QUEUED";
      let dispatchResult: VerificationDispatchResult;
      try {
        dispatchResult = await dispatchPoolVerification(event, accountFetcher);
      } catch {
        this.rpcVerificationFailures += 1;
        item.lifecycleState = "VERIFICATION_FAILED";
        continue;
      }

      // Track verification latency
      const verificationLatencyMs = Math.max(
        0,
        dispatchResult.verifiedAtEpochMs - item.detectedAtMs,
      );
      this.totalVerificationLatencyMs += verificationLatencyMs;
      this.verificationLatencySamples += 1;

      // Track total discovery latency
      if (event.blockTimeSec !== null) {
        const totalDiscoveryLatencyMs = Math.max(
          0,
          dispatchResult.verifiedAtEpochMs - event.blockTimeSec * 1000,
        );
        this.totalDiscoveryLatencyMs += totalDiscoveryLatencyMs;
        this.totalDiscoverySamples += 1;
      }

      // Track slot metrics
      if (dispatchResult.slotDelta > this.maxSlotDeltaObserved) {
        this.maxSlotDeltaObserved = dispatchResult.slotDelta;
      }
      if (dispatchResult.slotDiscrepancy) {
        this.slotDiscrepancyIncidents += 1;
      }

      // Track verification tiers
      switch (dispatchResult.verificationTier) {
        case "INDEPENDENTLY_COHERENT":
        case "VERIFIED_AMM_V4":
          this.coherentTierPoolsCount += 1;
          item.lifecycleState = "VERIFIED_COHERENT";
          break;
        case "PARTIALLY_VERIFIED":
          this.partiallyVerifiedTierCount += 1;
          item.lifecycleState = "VERIFIED_COHERENT";
          break;
        case "SLOT_DISCREPANT":
          this.slotDiscrepantTierCount += 1;
          item.lifecycleState = "VERIFICATION_FAILED";
          break;
        default:
          this.unavailableTierCount += 1;
          item.lifecycleState = "VERIFICATION_FAILED";
          break;
      }

      results.push(dispatchResult);
    }

    return Object.freeze(results);
  }

  // --------------------------------------------------------------------------
  // Telemetry & Metrics Snapshot
  // --------------------------------------------------------------------------

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getMetricsSnapshot(): EventDiscoveryMetricsSnapshot {
    const avgDetectionLatencyMs =
      this.detectionLatencySamples > 0
        ? Math.round(this.totalDetectionLatencyMs / this.detectionLatencySamples)
        : 0;

    const avgVerificationLatencyMs =
      this.verificationLatencySamples > 0
        ? Math.round(this.totalVerificationLatencyMs / this.verificationLatencySamples)
        : 0;

    const avgTotalDiscoveryLatencyMs =
      this.totalDiscoverySamples > 0
        ? Math.round(this.totalDiscoveryLatencyMs / this.totalDiscoverySamples)
        : 0;

    return Object.freeze({
      connectionStatus: this.connectionStatus,
      rawLogNotificationsReceived: this.rawLogNotificationsReceived,
      uniqueTransactionsEncountered: this.uniqueTransactionsEncountered,
      duplicateNotificationsIgnored: this.duplicateNotificationsIgnored,
      successfulInitDecodes: this.successfulInitDecodes,
      failedInitDecodes: this.failedInitDecodes,
      candidatePoolsDiscovered: this.candidatePoolsDiscovered,
      duplicatePoolIdsIgnored: this.duplicatePoolIdsIgnored,
      transactionFetchFailures: this.transactionFetchFailures,
      rpcVerificationFailures: this.rpcVerificationFailures,
      queueFullDrops: this.queueFullDrops,
      rateLimitDrops: this.rateLimitDrops,
      reconnectEvents: this.reconnectEvents,
      detectedGaps: this.detectedGaps,
      boundedBackfillAttempts: this.boundedBackfillAttempts,
      averageDetectionLatencyMs: avgDetectionLatencyMs,
      averageVerificationLatencyMs: avgVerificationLatencyMs,
      averageTotalDiscoveryLatencyMs: avgTotalDiscoveryLatencyMs,
      maxSlotDeltaObserved: this.maxSlotDeltaObserved,
      slotDiscrepancyIncidents: this.slotDiscrepancyIncidents,
      coherentTierPoolsCount: this.coherentTierPoolsCount,
      partiallyVerifiedTierCount: this.partiallyVerifiedTierCount,
      slotDiscrepantTierCount: this.slotDiscrepantTierCount,
      unavailableTierCount: this.unavailableTierCount,
    });
  }
}
