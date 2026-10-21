/**
 * Phase 12.94-D Milestone D.2.9-A: Protocol-Neutral Event Discovery Ingestion Engine
 *
 * Implements the offline event ingestion pipeline capable of receiving WebSocket
 * log-notification envelopes, resolving versioned transaction metadata, identifying
 * pool initialization instructions (including inner CPI and multi-pool transactions),
 * managing bounded queues with backpressure, idempotently deduplicating events,
 * and dispatching to read-only on-chain parsers.
 *
 * Requirements (D29-A1, D29-A5, D29-F5):
 * 1. Typed WebSocket log-notification envelopes.
 * 2. Bounded queue with configurable capacity and backpressure policy (DROP_OLDEST / DROP_NEWEST).
 * 3. Separate observed signatures, queued signatures, completed transactions, verified pools, rejected pools, and recoverable failures.
 * 4. Queue drops and exhausted retries are explicitly accounted for and do not permanently suppress re-observed events.
 * 5. Retry accounting with failure semantics and bounded queue/resource budgets.
 * 6. Fetched transaction identity verification: validates signature and slot coherence.
 * 7. Never assigns VERIFIED_COHERENT to a PARTIALLY_VERIFIED result.
 * 8. WebSocket connection lifecycle simulation (CONNECTING, SUBSCRIBED, RECONNECTING, etc.).
 * 9. Honest coverage, latency, and causality metrics tracking.
 * 10. Zero live network or WebSocket activity: 100% offline injectable interfaces.
 */

import type {
  DiscoveredPoolInitializationEvent,
  EventDiscoveryMetricsSnapshot,
  EventLifecycleState,
  IOnChainAccountFetcher,
  VerificationDispatchResult,
  VersionedTransactionMetadata,
  WebSocketConnectionStatus,
  WebSocketLogNotificationEnvelope,
} from "./EventDiscoveryContracts.js";
import { identifyPoolInitializationInstructions } from "./PoolInitializationParser.js";
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
  readonly maxVerificationRetries?: number | undefined; // Max verification attempts per event (default 3, BREADY-04)
  readonly clock?: { now(): number } | undefined; // Injectable clock for deterministic tests
  readonly maxSlotDelta?: number | undefined; // Maximum acceptable slot delta (default 1000)
  readonly maxEvents?: number | undefined; // Total session events budget ceiling (BREADY-05)
  readonly maxTransactions?: number | undefined; // Total session fetched transactions budget ceiling (BREADY-05)
}

interface QueuedItem {
  readonly signature: string;
  readonly slot: number;
  readonly detectedAtMs: number;
  retryCount: number;
  lifecycleState: EventLifecycleState;
}

export interface PendingVerificationItem {
  readonly event: DiscoveredPoolInitializationEvent;
  readonly detectedAtMs: number;
  readonly signature: string;
  retryCount: number;
  lastError?: string;
}

/**
 * Protocol-neutral event discovery ingestion engine.
 */
export class EventDiscoveryIngestionEngine {
  private readonly maxQueueSize: number;
  private readonly backpressurePolicy: "DROP_OLDEST" | "DROP_NEWEST";
  private readonly maxRetries: number;
  private readonly maxVerificationRetries: number;
  private readonly clock: { now(): number };
  private readonly maxSlotDelta: number;
  private readonly maxEvents?: number | undefined;
  private readonly maxTransactions?: number | undefined;

  private totalTransactionsProcessed = 0;

  private connectionStatus: WebSocketConnectionStatus = "DISCONNECTED";
  private queue: QueuedItem[] = [];
  private readonly pendingVerifications = new Map<string, PendingVerificationItem>();

  // Decoupled lifecycle sets (D29-F5)
  private readonly observedSignatures = new Set<string>(); // All signatures seen in notifications
  private readonly queuedSignatures = new Set<string>(); // Signatures currently in queue
  private readonly completedSignatures = new Set<string>(); // Transactions fetched and processed
  private readonly failedSignatures = new Set<string>(); // Transactions abandoned after retries exhausted
  private readonly verifiedPoolIds = new Set<string>(); // Pools verified coherent
  private readonly rejectedPoolIds = new Set<string>(); // Pools rejected by verification

  // Metrics counters
  private rawLogNotificationsReceived = 0;
  private uniqueTransactionsEncountered = 0;
  private duplicateNotificationsIgnored = 0;
  private successfulInitDecodes = 0;
  private failedInitDecodes = 0;
  private candidatePoolsDiscovered = 0;
  private duplicatePoolIdsIgnored = 0;
  private transactionFetchFailures = 0;
  private transactionFetchRetries = 0;
  private exhaustedRetriesCount = 0;
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
  private verificationRetries = 0;
  private exhaustedVerificationRetriesCount = 0;
  private readonly discoveredEvents: DiscoveredPoolInitializationEvent[] = [];
  private readonly verificationReports: VerificationDispatchResult[] = [];

  constructor(options: EventDiscoveryEngineOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 500;
    this.backpressurePolicy = options.backpressurePolicy ?? "DROP_OLDEST";
    this.maxRetries = options.maxRetriesPerTx ?? 3;
    this.maxVerificationRetries = options.maxVerificationRetries ?? 3;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxSlotDelta = options.maxSlotDelta ?? 1000;
    this.maxEvents = options.maxEvents;
    this.maxTransactions = options.maxTransactions;
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
   * Receives a raw WebSocket log-notification envelope (D29-F5).
   * Separates observed, active queued, and completed signatures to prevent
   * permanent candidate suppression after queue drops or transient failures.
   */
  public async handleLogNotification(
    envelope: WebSocketLogNotificationEnvelope,
  ): Promise<{ enqueued: boolean; reason?: string }> {
    this.rawLogNotificationsReceived += 1;

    if (this.maxEvents !== undefined && this.discoveredEvents.length >= this.maxEvents) {
      this.rateLimitDrops += 1;
      return { enqueued: false, reason: "MAX_EVENTS_EXCEEDED" };
    }

    const value = envelope.params?.result?.value;
    const context = envelope.params?.result?.context;

    if (!value || !value.signature) {
      return { enqueued: false, reason: "MALFORMED_ENVELOPE" };
    }

    const signature = value.signature;
    const slot = context?.slot ?? 0;
    const now = this.clock.now();

    // Track total unique signatures observed across all notifications
    if (!this.observedSignatures.has(signature)) {
      this.observedSignatures.add(signature);
      this.uniqueTransactionsEncountered += 1;
    }

    // Deduplication check: ignore if currently queued or already completed
    if (this.completedSignatures.has(signature) || this.queuedSignatures.has(signature)) {
      this.duplicateNotificationsIgnored += 1;
      return { enqueued: false, reason: "DUPLICATE_SIGNATURE" };
    }

    // Fail early on failed transaction
    if (value.err !== null) {
      this.failedInitDecodes += 1;
      this.failedSignatures.add(signature);
      return { enqueued: false, reason: "FAILED_TRANSACTION" };
    }

    // Check bounded queue capacity and apply backpressure policy (D29-F5)
    if (this.queue.length >= this.maxQueueSize) {
      this.queueFullDrops += 1;
      if (this.backpressurePolicy === "DROP_OLDEST") {
        const dropped = this.queue.shift(); // Evict oldest
        if (dropped) {
          this.queuedSignatures.delete(dropped.signature);
        }
      } else {
        // DROP_NEWEST: Do not add to queuedSignatures so it can be re-observed later
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
    this.queuedSignatures.add(signature);
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
    options?: { readonly deadlineEpochMs?: number | undefined } | undefined,
  ): Promise<readonly VerificationDispatchResult[]> {
    const results: VerificationDispatchResult[] = [];

    // Stop queue draining if wall-clock deadline already passed (B2-LAUNCH-03)
    if (options?.deadlineEpochMs !== undefined && Date.now() >= options.deadlineEpochMs) {
      return results;
    }

    // 0. Retry any pending verifications from previous attempts (BREADY-04, B2-GO-02)
    const retried = await this.retryPendingVerifications(accountFetcher, options);
    results.push(...retried);

    while (this.queue.length > 0) {
      if (options?.deadlineEpochMs !== undefined && Date.now() >= options.deadlineEpochMs) {
        break;
      }
      if (
        this.maxTransactions !== undefined &&
        this.totalTransactionsProcessed >= this.maxTransactions
      ) {
        break;
      }
      if (this.maxEvents !== undefined && this.discoveredEvents.length >= this.maxEvents) {
        break;
      }
      const item = this.queue.shift()!;
      this.queuedSignatures.delete(item.signature);
      item.lifecycleState = "TX_FETCH_QUEUED";
      this.totalTransactionsProcessed += 1;

      // 1. Fetch transaction metadata with bounded retry accounting (D29-F5)
      let tx: VersionedTransactionMetadata | null = null;
      try {
        tx = await txFetcher.fetchTransaction(item.signature);
      } catch {
        tx = null;
      }

      if (!tx) {
        this.transactionFetchRetries += 1;
        if (item.retryCount < this.maxRetries) {
          item.retryCount += 1;
          this.queue.push(item); // Re-enqueue for retry
          this.queuedSignatures.add(item.signature);
          continue;
        } else {
          this.transactionFetchFailures += 1;
          this.exhaustedRetriesCount += 1;
          this.failedSignatures.add(item.signature);
          item.lifecycleState = "TX_DECODE_FAILED";
          continue;
        }
      }

      // 2. Validate transaction identity (D29-F5)
      if (tx.signature !== item.signature) {
        this.failedInitDecodes += 1;
        this.failedSignatures.add(item.signature);
        item.lifecycleState = "TX_DECODE_FAILED";
        continue;
      }

      // Validate slot delta bounds (D29-H2: fail closed on excessive slot disagreement)
      const txSlotDelta = Math.abs(tx.slot - item.slot);
      if (txSlotDelta > this.maxSlotDelta) {
        this.slotDiscrepancyIncidents += 1;
        this.completedSignatures.add(item.signature);
        this.slotDiscrepantTierCount += 1;
        item.lifecycleState = "SLOT_DISCREPANT";
        continue;
      }

      item.lifecycleState = "TX_FETCHED";

      // 3. Parse pool initialization instructions (scanning top-level and inner CPI) (D29-F4)
      const scanResult = identifyPoolInitializationInstructions(tx, item.detectedAtMs);
      if (!scanResult.ok) {
        this.failedInitDecodes += 1;
        this.completedSignatures.add(item.signature);
        item.lifecycleState = "TX_DECODE_FAILED";
        continue;
      }

      item.lifecycleState = "TX_DECODE_SUCCESS";
      this.successfulInitDecodes += scanResult.events.length;

      // 4. Dispatch verification for each identified pool initialization event
      for (const event of scanResult.events) {
        // Enforce exact ceiling on admitted discovered events (B2-GO-01)
        if (this.maxEvents !== undefined && this.discoveredEvents.length >= this.maxEvents) {
          this.rateLimitDrops += 1;
          continue;
        }

        // Admit discovered event up to the hard ceiling
        this.discoveredEvents.push(event);

        // Stop initiating further account queries if observation deadline has elapsed (B2-GO-02)
        if (options?.deadlineEpochMs !== undefined && Date.now() >= options.deadlineEpochMs) {
          break;
        }

        // Pool ID deduplication (check if already verified or encountered)
        if (this.verifiedPoolIds.has(event.poolId)) {
          this.duplicatePoolIdsIgnored += 1;
          item.lifecycleState = "DUPLICATE_IGNORED";
          continue;
        }

        // If event is already in pending queue for retry, suppress duplicate
        if (this.pendingVerifications.has(event.eventId)) {
          this.duplicatePoolIdsIgnored += 1;
          continue;
        }

        this.candidatePoolsDiscovered += 1;

        // Track detection latency
        if (event.blockTimeSec !== null) {
          const blockTimeMs = event.blockTimeSec * 1000;
          const detectionLatencyMs = Math.max(0, item.detectedAtMs - blockTimeMs);
          this.totalDetectionLatencyMs += detectionLatencyMs;
          this.detectionLatencySamples += 1;
        }

        // Dispatch to independent on-chain verification with bounded per-event retry (BREADY-04, B2-GO-02)
        item.lifecycleState = "VERIFICATION_QUEUED";
        let dispatchResult: VerificationDispatchResult | null = null;
        try {
          dispatchResult = await dispatchPoolVerification(event, accountFetcher, {
            deadlineEpochMs: options?.deadlineEpochMs,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.verificationRetries += 1;
          const pendingItem: PendingVerificationItem = {
            event,
            detectedAtMs: item.detectedAtMs,
            signature: item.signature,
            retryCount: 1,
            lastError: errMsg,
          };

          if (pendingItem.retryCount <= this.maxVerificationRetries) {
            this.pendingVerifications.set(event.eventId, pendingItem);
            item.lifecycleState = "VERIFICATION_FAILED";
          } else {
            this.rpcVerificationFailures += 1;
            this.exhaustedVerificationRetriesCount += 1;
            this.rejectedPoolIds.add(event.poolId);
            item.lifecycleState = "VERIFICATION_FAILED";
          }

          if (errMsg.includes("DEADLINE_EXCEEDED")) {
            // Deadline reached: stop further verification dispatches immediately
            break;
          }
          continue;
        }

        this.recordDispatchMetrics(dispatchResult, event, item.detectedAtMs);
        if (
          dispatchResult.verificationTier === "INDEPENDENTLY_COHERENT" ||
          dispatchResult.verificationTier === "VERIFIED_AMM_V4"
        ) {
          item.lifecycleState = "VERIFIED_COHERENT";
        } else if (dispatchResult.verificationTier === "PARTIALLY_VERIFIED") {
          item.lifecycleState = "PARTIALLY_VERIFIED";
        } else if (dispatchResult.verificationTier === "SLOT_DISCREPANT") {
          item.lifecycleState = "SLOT_DISCREPANT";
        } else {
          item.lifecycleState = "REJECTED_NON_COHERENT";
        }

        results.push(dispatchResult);
      }

      this.completedSignatures.add(item.signature);
    }

    return Object.freeze(results);
  }

  /**
   * Retries all pending verification events with bounded retry limits (BREADY-04, B2-GO-02).
   * Successful events are preserved without re-processing already completed events.
   */
  public async retryPendingVerifications(
    accountFetcher: IOnChainAccountFetcher,
    options?: { readonly deadlineEpochMs?: number | undefined } | undefined,
  ): Promise<readonly VerificationDispatchResult[]> {
    const recoveredResults: VerificationDispatchResult[] = [];
    const pendingEntries = Array.from(this.pendingVerifications.entries());

    for (const [eventId, pending] of pendingEntries) {
      // Check deadline before each retry iteration (B2-GO-02)
      if (options?.deadlineEpochMs !== undefined && Date.now() >= options.deadlineEpochMs) {
        break;
      }

      if (this.verifiedPoolIds.has(pending.event.poolId)) {
        this.pendingVerifications.delete(eventId);
        continue;
      }

      try {
        const dispatchResult = await dispatchPoolVerification(pending.event, accountFetcher, {
          deadlineEpochMs: options?.deadlineEpochMs,
        });
        this.pendingVerifications.delete(eventId);
        this.recordDispatchMetrics(dispatchResult, pending.event, pending.detectedAtMs);
        recoveredResults.push(dispatchResult);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("DEADLINE_EXCEEDED")) {
          // Cease retries when observation deadline has passed; leave pending item intact without fabricating verdict (B2-GO-02)
          pending.lastError = errMsg;
          break;
        }

        pending.retryCount += 1;
        pending.lastError = errMsg;
        this.verificationRetries += 1;

        if (pending.retryCount > this.maxVerificationRetries) {
          this.pendingVerifications.delete(eventId);
          this.rpcVerificationFailures += 1;
          this.exhaustedVerificationRetriesCount += 1;
          this.rejectedPoolIds.add(pending.event.poolId);
          const failureResult: VerificationDispatchResult = {
            poolId: pending.event.poolId,
            protocol: pending.event.protocol,
            verified: false,
            rejectionReason: `Verification retries exhausted (${this.maxVerificationRetries}): ${pending.lastError}`,
            verificationTier: "REJECTED",
            transactionSlot: pending.event.slot,
            poolAccountSlot: null,
            vault0AccountSlot: null,
            vault1AccountSlot: null,
            slotDiscrepancy: false,
            slotDelta: 0,
            verifiedAtEpochMs: this.clock.now(),
            hostObservationTimestampMs: this.clock.now(),
            effectiveReservesAvailable: false,
            spotPriceSol: null,
            spotPrice0Per1: null,
          };
          this.recordDispatchMetrics(failureResult, pending.event, pending.detectedAtMs);
          recoveredResults.push(failureResult);
        }
      }
    }

    return Object.freeze(recoveredResults);
  }

  private recordDispatchMetrics(
    dispatchResult: VerificationDispatchResult,
    event: DiscoveredPoolInitializationEvent,
    detectedAtMs: number,
  ): void {
    this.verificationReports.push(dispatchResult);
    const verificationLatencyMs = Math.max(0, dispatchResult.verifiedAtEpochMs - detectedAtMs);
    this.totalVerificationLatencyMs += verificationLatencyMs;
    this.verificationLatencySamples += 1;

    if (event.blockTimeSec !== null) {
      const totalDiscoveryLatencyMs = Math.max(
        0,
        dispatchResult.verifiedAtEpochMs - event.blockTimeSec * 1000,
      );
      this.totalDiscoveryLatencyMs += totalDiscoveryLatencyMs;
      this.totalDiscoverySamples += 1;
    }

    if (dispatchResult.slotDelta > this.maxSlotDeltaObserved) {
      this.maxSlotDeltaObserved = dispatchResult.slotDelta;
    }
    if (dispatchResult.slotDiscrepancy) {
      this.slotDiscrepancyIncidents += 1;
    }

    switch (dispatchResult.verificationTier) {
      case "INDEPENDENTLY_COHERENT":
      case "VERIFIED_AMM_V4":
        this.coherentTierPoolsCount += 1;
        this.verifiedPoolIds.add(event.poolId);
        break;
      case "PARTIALLY_VERIFIED":
        this.partiallyVerifiedTierCount += 1;
        break;
      case "SLOT_DISCREPANT":
        this.slotDiscrepantTierCount += 1;
        break;
      default:
        this.rejectedPoolIds.add(event.poolId);
        this.unavailableTierCount += 1;
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Telemetry & Metrics Snapshot
  // --------------------------------------------------------------------------

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getPendingVerificationsCount(): number {
    return this.pendingVerifications.size;
  }

  public getDiscoveredEvents(): readonly DiscoveredPoolInitializationEvent[] {
    return this.discoveredEvents;
  }

  public getVerificationReports(): readonly VerificationDispatchResult[] {
    return this.verificationReports;
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
      transactionFetchRetries: this.transactionFetchRetries,
      exhaustedRetriesCount: this.exhaustedRetriesCount,
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
      verificationRetries: this.verificationRetries,
      exhaustedVerificationRetriesCount: this.exhaustedVerificationRetriesCount,
      pendingVerificationsCount: this.pendingVerifications.size,
    });
  }
}
