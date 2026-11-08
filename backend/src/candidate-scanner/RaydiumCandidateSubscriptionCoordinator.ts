/**
 * Phase 12.94-D Milestone D.3.3: Raydium Candidate Subscription Coordinator
 *
 * Implements offline-tested, exact candidate-pool WebSocket subscription lifecycle
 * coordination connecting Solana RPC log streaming to the accepted transaction adapter
 * (RaydiumAmmV4TransactionSourceAdapter) and rolling trade flow tracker (RollingTradeFlowTracker).
 *
 * Core Guarantees & Audited Safeguards (Independent Review Hardened):
 * 1. Exact Candidate Binding & Immutable Snapshotting:
 *    - Clones and freezes candidate pool context on intake; mutations by the caller cannot alter binding.
 *    - Full 8-field comparison against adapter context (poolId, candidateTokenMint, quoteTokenMint,
 *      baseVault, quoteVault, baseMint, quoteMint, orientation) and tracker identifiers.
 *    - Exact candidate pool mentions only ({ mentions: [poolId] }); program-wide IDs fail closed.
 *    - Strictly requires an injected transport implementing ISolanaWebSocketTransport; default network calls are banned.
 * 2. Subscription Lifecycle, Idempotency & Reconnection Gap Preservation:
 *    - Manages connection lifecycle state machine: DISCONNECTED -> CONNECTING -> SUBSCRIBING -> SUBSCRIBED -> CLOSED.
 *    - Idempotent subscription initiation: prevents duplicate logsSubscribe dispatches on repeated open events.
 *    - Connection epoch isolation rejects delayed messages or acks from prior transport generations.
 *    - Transport replacement and connection drops immediately record collection gaps in the tracker.
 * 3. Consistent Source Loss & Inactive Invalidation:
 *    - Disconnected or closed coordinator immediately invalidates usable flow across evaluateFlow(),
 *      createRetestSpotInfo(), and getCoverageDiagnostic(), returning COLLECTION_GAP and null buy/sell counts.
 *    - Preserves source loss without waiting for a reconnect.
 * 4. Active-Source Contract Validation & Uncertainty Preservation:
 *    - Validates JSON-RPC version ('2.0'), non-negative integer IDs, slot, err, logs, and base58 signature format.
 *    - Unparseable JSON, JSON null, non-object frames, malformed err/logs, and unrecognized active frames
 *      immediately record collection gaps in the tracker to preserve source uncertainty.
 *    - Identifiable unrelated subscriptions are dropped without treating them as candidate losses.
 *    - Draining queued adapter transactions cannot erase recorded source uncertainty.
 * 5. Strict Separation of Synthetic Proofs & Production Evaluation:
 *    - Explanatory text strings are flatly rejected as completeness proof.
 *    - Synthetic completeness proofs are disallowed under default production configuration.
 *    - Synthetic completeness is available only through an explicit, opted-in offline test configuration
 *      (allowSyntheticCompletenessProofs: true).
 *    - Default production evaluation retains unavailable flow counts (isCoverageSufficient: false,
 *      recentBuys60s: null, recentSells60s: null) until production completeness is established.
 *    - Production source completeness via gapless block-range polling remains an explicit open readiness gap.
 * 6. Resource Validation & Diagnostic Sanitization:
 *    - Validates constructor options (rejecting NaN, negative, or non-integer budgets).
 *    - Sanitizes transport errors, close reasons, and URLs, redacting API keys, secrets, and credentials.
 */

import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import {
  type RollingTradeFlowTracker,
  type RollingFlowEvaluationResult,
  type FlowCoverageStatus,
  type StreamGap,
} from "./RollingTradeFlowTracker.js";
import {
  type RaydiumAmmV4TransactionSourceAdapter,
  type ProcessTransactionOptions,
  type ProcessNotificationResult,
  type ProcessBatchResult,
} from "./RaydiumAmmV4TransactionSourceAdapter.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import type { SubscriptionCommitment } from "../research/pilot/EventDiscoveryContracts.js";
import { RAYDIUM_AMM_V4_PROGRAM_ID } from "../research/pilot/RaydiumAmmParser.js";
import { RAYDIUM_CPMM_PROGRAM_ID } from "../research/pilot/RaydiumCpmmParser.js";
import type { RetestSpotInfo } from "./RetestGateEvaluator.js";
import type { ExactPoolHistoryEnumerator } from "./ExactPoolHistoryEnumerator.js";
import type { ExactPoolTransactionResolutionBridge } from "./ExactPoolTransactionResolutionBridge.js";
import {
  cloneSourceCutoff,
  evaluateExactPoolWindowReconciliation,
  type SourceCutoffEvidence,
  type WindowReconciliationResult,
  type PaperQuietStreamPolicyOptions,
} from "./ExactPoolWindowReconciliationEvaluator.js";
import type { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";

export type SubscriptionCoordinatorStatus =
  | "DISCONNECTED"
  | "CONNECTING"
  | "SUBSCRIBING"
  | "SUBSCRIBED"
  | "CLOSED";

export type CompletenessVerificationMode =
  | "PROVEN_GAPLESS_BLOCK_RANGE_POLL"
  | "SYNTHETIC_TEST_FIXTURE";

export interface SourceCompletenessProof {
  readonly mode: CompletenessVerificationMode;
  readonly poolId: string;
  readonly connectionEpoch: number;
  readonly rangeStartMs: number;
  readonly rangeEndMs: number;
  readonly startSlot?: number | undefined;
  readonly endSlot?: number | undefined;
  readonly testFixtureLabel?: string | undefined;
}

export interface RaydiumCandidateSubscriptionCoordinatorOptions {
  readonly poolContext: TrackedRaydiumPoolContext;
  readonly adapter: RaydiumAmmV4TransactionSourceAdapter;
  readonly tracker: RollingTradeFlowTracker;
  readonly transport?: ISolanaWebSocketTransport | undefined;
  readonly commitment?: SubscriptionCommitment | undefined;
  readonly clock?: (() => number) | undefined;
  readonly maxNotificationsBudget?: number | undefined;
  readonly onLog?: ((msg: string) => void) | undefined;
  readonly onStatusChange?: ((status: SubscriptionCoordinatorStatus) => void) | undefined;
  /**
   * Explicit opt-in flag for offline testing only.
   * When false (default), synthetic completeness proofs are rejected and
   * flow evaluations retain unavailable counts because production completeness
   * is unproven.
   */
  readonly allowSyntheticCompletenessProofs?: boolean | undefined;
}

export interface AdvanceCoverageOptions {
  readonly checkpointMs: number;
  readonly proof: SourceCompletenessProof;
}

export interface AdvanceCoverageResult {
  readonly ok: boolean;
  readonly reason?: string | undefined;
  readonly message?: string | undefined;
  readonly checkpointMs?: number | undefined;
  readonly coverage?: FlowCoverageStatus | undefined;
  readonly isCoverageSufficient?: boolean | undefined;
  readonly isProductionCompletenessEstablished?: boolean | undefined;
}

export interface CoordinatorMetrics {
  readonly totalNotificationsReceived: number;
  readonly totalNotificationsRouted: number;
  readonly totalDuplicatesSkipped: number;
  readonly totalQueueOverflows: number;
  readonly totalUnrelatedDropped: number;
  readonly totalMalformedFramesDropped: number;
  readonly totalStaleEpochMessagesDropped: number;
  readonly totalDisconnectGapsRecorded: number;
  readonly totalCoverageAdvancesAttempted: number;
  readonly totalCoverageAdvancesSucceeded: number;
  readonly totalCoverageAdvancesRejected: number;
}

export interface CandidateWindowReconciliationOptions {
  readonly knownAnchorSignature: string;
  readonly historyEnumerator: ExactPoolHistoryEnumerator;
  readonly resolutionBridge?: ExactPoolTransactionResolutionBridge | undefined;
  readonly decisionTimestampMs?: number | undefined;
  readonly observationStartMs?: number | undefined;
  readonly observationEndMs?: number | undefined;
  readonly budgetManager?: GlobalResourceBudgetManager | undefined;
  readonly hasActiveBacklog?: boolean | undefined;
  readonly paperQuietStreamPolicy?: PaperQuietStreamPolicyOptions | undefined;
}

export interface CoordinatorCoverageDiagnostic {
  readonly poolId: string;
  readonly tokenMint: string;
  readonly status: SubscriptionCoordinatorStatus;
  readonly activeSubscriptionId: number | null;
  readonly connectionEpoch: number;
  readonly disconnectedAtMs: number | null;
  readonly coverage: FlowCoverageStatus;
  readonly isCoverageSufficient: boolean;
  readonly isProductionCompletenessEstablished: boolean;
  readonly recentBuys60s: number | null;
  readonly recentSells60s: number | null;
  readonly flowRatio: number | null;
  readonly limitationReason: string;
  readonly adapterPendingQueueLength: number;
  readonly adapterInFlightCount: number;
  readonly adapterActiveWorkload: number;
  readonly metrics: CoordinatorMetrics;
  readonly lastReconciliationResult?: WindowReconciliationResult | undefined;
}

export class RaydiumCandidateSubscriptionCoordinator {
  private readonly poolContext: TrackedRaydiumPoolContext;
  private readonly adapter: RaydiumAmmV4TransactionSourceAdapter;
  private readonly tracker: RollingTradeFlowTracker;
  private readonly commitment: SubscriptionCommitment;
  private readonly clock: () => number;
  private readonly maxNotificationsBudget?: number | undefined;
  private readonly onLog?: ((msg: string) => void) | undefined;
  private readonly onStatusChange?: ((status: SubscriptionCoordinatorStatus) => void) | undefined;
  private readonly allowSyntheticCompletenessProofs: boolean;

  private transport: ISolanaWebSocketTransport | null = null;
  private status: SubscriptionCoordinatorStatus = "DISCONNECTED";
  private connectionEpoch = 0;
  private activeSubscriptionId: number | null = null;
  private pendingSubscriptionRequestId: number | null = null;
  private pendingRequestEpoch: number | null = null;
  private disconnectedAtMs: number | null = null;
  private nextRequestId = 1;
  private lastReconciliationResult?: WindowReconciliationResult | undefined;

  // Bounded metrics counters
  private totalNotificationsReceived = 0;
  private totalNotificationsRouted = 0;
  private totalDuplicatesSkipped = 0;
  private totalQueueOverflows = 0;
  private totalUnrelatedDropped = 0;
  private totalMalformedFramesDropped = 0;
  private totalStaleEpochMessagesDropped = 0;
  private totalDisconnectGapsRecorded = 0;
  private totalCoverageAdvancesAttempted = 0;
  private totalCoverageAdvancesSucceeded = 0;
  private totalCoverageAdvancesRejected = 0;

  constructor(options: RaydiumCandidateSubscriptionCoordinatorOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("[COORDINATOR_INIT] Options must be a non-null object");
    }

    const rawCtx = options.poolContext;
    if (!rawCtx || typeof rawCtx !== "object") {
      throw new Error("[COORDINATOR_INIT] poolContext must be a non-null object");
    }

    // Defensive clone and immutable freezing of candidate pool context
    const clonedContext: TrackedRaydiumPoolContext = Object.freeze({
      poolId: String(rawCtx.poolId ?? ""),
      candidateTokenMint: String(rawCtx.candidateTokenMint ?? ""),
      quoteTokenMint: String(rawCtx.quoteTokenMint ?? ""),
      baseVault: String(rawCtx.baseVault ?? ""),
      quoteVault: String(rawCtx.quoteVault ?? ""),
      baseMint: String(rawCtx.baseMint ?? ""),
      quoteMint: String(rawCtx.quoteMint ?? ""),
      orientation: rawCtx.orientation,
    });

    validateTrackedPoolContext(clonedContext);
    this.poolContext = clonedContext;

    // Reject program-wide IDs: coordinator requires an exact candidate pool account
    if (
      this.poolContext.poolId === RAYDIUM_AMM_V4_PROGRAM_ID ||
      this.poolContext.poolId === RAYDIUM_CPMM_PROGRAM_ID
    ) {
      throw new Error(
        `[COORDINATOR_BINDING] Program-wide subscription is prohibited. Coordinator requires exact candidate pool account ID, received program ID '${this.poolContext.poolId}'`,
      );
    }

    if (!options.adapter) {
      throw new Error("[COORDINATOR_INIT] RaydiumAmmV4TransactionSourceAdapter must be provided");
    }
    this.adapter = options.adapter;

    if (!options.tracker) {
      throw new Error("[COORDINATOR_INIT] RollingTradeFlowTracker must be provided");
    }
    this.tracker = options.tracker;

    // Validate complete candidate context consistency against adapter
    const adapterCtx = this.adapter.getPoolContext();
    if (adapterCtx.poolId !== this.poolContext.poolId) {
      throw new Error(
        `[COORDINATOR_BINDING] Adapter poolId (${adapterCtx.poolId}) does not match coordinator poolId (${this.poolContext.poolId})`,
      );
    }
    if (adapterCtx.candidateTokenMint !== this.poolContext.candidateTokenMint) {
      throw new Error(
        `[COORDINATOR_BINDING] Adapter candidateTokenMint (${adapterCtx.candidateTokenMint}) does not match coordinator candidateTokenMint (${this.poolContext.candidateTokenMint})`,
      );
    }
    if (adapterCtx.quoteTokenMint !== this.poolContext.quoteTokenMint) {
      throw new Error(
        `[COORDINATOR_BINDING] Adapter quoteTokenMint (${adapterCtx.quoteTokenMint}) does not match coordinator quoteTokenMint (${this.poolContext.quoteTokenMint})`,
      );
    }
    if (adapterCtx.baseVault !== this.poolContext.baseVault) {
      throw new Error(
        `[COORDINATOR_BINDING] Adapter baseVault (${adapterCtx.baseVault}) does not match coordinator baseVault (${this.poolContext.baseVault})`,
      );
    }
    if (adapterCtx.quoteVault !== this.poolContext.quoteVault) {
      throw new Error(
        `[COORDINATOR_BINDING] Adapter quoteVault (${adapterCtx.quoteVault}) does not match coordinator quoteVault (${this.poolContext.quoteVault})`,
      );
    }
    if (adapterCtx.baseMint !== this.poolContext.baseMint) {
      throw new Error(
        `[COORDINATOR_BINDING] Adapter baseMint (${adapterCtx.baseMint}) does not match coordinator baseMint (${this.poolContext.baseMint})`,
      );
    }
    if (adapterCtx.quoteMint !== this.poolContext.quoteMint) {
      throw new Error(
        `[COORDINATOR_BINDING] Adapter quoteMint (${adapterCtx.quoteMint}) does not match coordinator quoteMint (${this.poolContext.quoteMint})`,
      );
    }
    if (adapterCtx.orientation !== this.poolContext.orientation) {
      throw new Error(
        `[COORDINATOR_BINDING] Adapter orientation (${adapterCtx.orientation}) does not match coordinator orientation (${this.poolContext.orientation})`,
      );
    }

    // Validate tracker identity
    if (this.tracker.getPoolId() !== this.poolContext.poolId) {
      throw new Error(
        `[COORDINATOR_BINDING] Tracker poolId (${this.tracker.getPoolId()}) does not match coordinator poolId (${this.poolContext.poolId})`,
      );
    }

    if (this.tracker.getTokenMint() !== this.poolContext.candidateTokenMint) {
      throw new Error(
        `[COORDINATOR_BINDING] Tracker tokenMint (${this.tracker.getTokenMint()}) does not match coordinator candidateTokenMint (${this.poolContext.candidateTokenMint})`,
      );
    }

    // Associate tracker with adapter to ensure backlog and loss-gap synchronization
    if (this.adapter.getAssociatedTracker() !== this.tracker) {
      this.adapter.associateTracker(this.tracker);
    }

    // Validate resource options
    if (options.maxNotificationsBudget !== undefined) {
      if (
        typeof options.maxNotificationsBudget !== "number" ||
        !Number.isFinite(options.maxNotificationsBudget) ||
        !Number.isInteger(options.maxNotificationsBudget) ||
        options.maxNotificationsBudget <= 0
      ) {
        throw new Error(
          `[COORDINATOR_INIT] maxNotificationsBudget must be a positive integer, received: ${String(options.maxNotificationsBudget)}`,
        );
      }
    }
    this.maxNotificationsBudget = options.maxNotificationsBudget;

    this.commitment = options.commitment ?? "confirmed";
    this.clock = options.clock ?? (() => Date.now());
    this.onLog = options.onLog;
    this.onStatusChange = options.onStatusChange;
    this.allowSyntheticCompletenessProofs = options.allowSyntheticCompletenessProofs === true;

    if (options.transport) {
      this.attachTransport(options.transport);
    }
  }

  public getStatus(): SubscriptionCoordinatorStatus {
    return this.status;
  }

  public getActiveSubscriptionId(): number | null {
    return this.activeSubscriptionId;
  }

  public getConnectionEpoch(): number {
    return this.connectionEpoch;
  }

  public getDisconnectedAtMs(): number | null {
    return this.disconnectedAtMs;
  }

  public getPoolContext(): TrackedRaydiumPoolContext {
    return this.poolContext;
  }

  public getAdapter(): RaydiumAmmV4TransactionSourceAdapter {
    return this.adapter;
  }

  public getTracker(): RollingTradeFlowTracker {
    return this.tracker;
  }

  public isSyntheticCompletenessAllowed(): boolean {
    return this.allowSyntheticCompletenessProofs;
  }

  public getMetrics(): CoordinatorMetrics {
    return Object.freeze({
      totalNotificationsReceived: this.totalNotificationsReceived,
      totalNotificationsRouted: this.totalNotificationsRouted,
      totalDuplicatesSkipped: this.totalDuplicatesSkipped,
      totalQueueOverflows: this.totalQueueOverflows,
      totalUnrelatedDropped: this.totalUnrelatedDropped,
      totalMalformedFramesDropped: this.totalMalformedFramesDropped,
      totalStaleEpochMessagesDropped: this.totalStaleEpochMessagesDropped,
      totalDisconnectGapsRecorded: this.totalDisconnectGapsRecorded,
      totalCoverageAdvancesAttempted: this.totalCoverageAdvancesAttempted,
      totalCoverageAdvancesSucceeded: this.totalCoverageAdvancesSucceeded,
      totalCoverageAdvancesRejected: this.totalCoverageAdvancesRejected,
    });
  }

  /**
   * Sanitizes diagnostic text by redacting API keys, query secrets, URLs with credentials, and tokens.
   */
  public sanitizeDiagnostic(text: string | undefined): string {
    if (!text) return "";
    let out = text;
    out = out.replace(
      /([?&])(api[-_]?key|token|secret|password|auth)=([^&\s'"]+)/gi,
      "$1$2=[REDACTED]",
    );
    out = out.replace(
      /(^|\s)(api[-_]?key|token|secret|password|auth)=([^&\s'"]+)/gi,
      "$1$2=[REDACTED]",
    );
    out = out.replace(
      /(api[-_]?key|token|secret|password|auth):\s*['"]?([^&\s'"]+)['"]?/gi,
      "$1:[REDACTED]",
    );
    out = out.replace(/([a-zA-Z0-9]+:\/\/)([^:]+):([^@]+)@/g, "$1[REDACTED]:[REDACTED]@");
    return out;
  }

  private log(msg: string): void {
    this.onLog?.(this.sanitizeDiagnostic(msg));
  }

  /**
   * Attaches an injected WebSocket transport.
   * Explicitly accounts for replacement interruptions before incrementing connectionEpoch.
   */
  public attachTransport(transport: ISolanaWebSocketTransport): void {
    if (this.status === "CLOSED") {
      throw new Error("[COORDINATOR_CLOSED] Cannot attach transport to a closed coordinator");
    }

    if (!transport || typeof transport !== "object" || typeof transport.send !== "function") {
      throw new Error(
        "[COORDINATOR_TRANSPORT] Invalid injected transport: must implement ISolanaWebSocketTransport",
      );
    }

    // Explicitly record replacement interruption gap in tracker before changing connection epoch
    if (this.transport && this.transport !== transport) {
      if (this.status === "SUBSCRIBED" || this.status === "SUBSCRIBING") {
        const now = this.clock();
        if (this.disconnectedAtMs === null) {
          this.disconnectedAtMs = now;
        }
        this.tracker.recordCollectionGap({
          gapStartMs: now,
          gapEndMs: now + 1,
          reason: "TRANSPORT_REPLACEMENT_INTERRUPTION",
        });
        this.totalDisconnectGapsRecorded++;
        this.setStatus("CONNECTING");
      }
      try {
        this.transport.close(1000, "Attaching replacement transport");
      } catch {
        // ignore
      }
    }

    this.connectionEpoch++;
    const currentEpoch = this.connectionEpoch;

    this.transport = transport;
    this.activeSubscriptionId = null;
    this.pendingSubscriptionRequestId = null;
    this.pendingRequestEpoch = null;

    this.setStatus("CONNECTING");

    transport.on("open", () => {
      if (this.connectionEpoch !== currentEpoch || this.status === "CLOSED") return;
      this.handleTransportOpen();
    });

    transport.on("message", (data: string | Buffer) => {
      if (this.connectionEpoch !== currentEpoch || this.status === "CLOSED") {
        this.totalStaleEpochMessagesDropped++;
        return;
      }
      this.handleIncomingMessage(data);
    });

    transport.on("error", (err: Error) => {
      if (this.connectionEpoch !== currentEpoch || this.status === "CLOSED") return;
      this.handleTransportError(err);
    });

    transport.on("close", (code: number, reason: string) => {
      if (this.connectionEpoch !== currentEpoch || this.status === "CLOSED") return;
      this.handleTransportClose(code, reason);
    });
  }

  /**
   * Sends the exact candidate-pool logsSubscribe request.
   * Idempotent: rejects duplicate sends if subscription is already active or pending.
   */
  public sendSubscriptionRequest(): void {
    if (!this.transport) {
      throw new Error("[COORDINATOR_TRANSPORT] No transport attached");
    }
    if (this.status === "CLOSED") {
      throw new Error(
        "[COORDINATOR_CLOSED] Cannot send subscription request on closed coordinator",
      );
    }

    // Idempotency guarantee: prevent redundant requests if subscription is already pending or active
    if (this.status === "SUBSCRIBED" || this.status === "SUBSCRIBING") {
      this.log(
        `[IDEMPOTENT_SUBSCRIPTION_SKIPPED] Subscription already active or pending (status: ${this.status}, activeId: ${this.activeSubscriptionId})`,
      );
      return;
    }

    const reqId = this.nextRequestId++;
    this.pendingSubscriptionRequestId = reqId;
    this.pendingRequestEpoch = this.connectionEpoch;
    this.setStatus("SUBSCRIBING");

    // Exact candidate pool mentions filter
    const payload = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "logsSubscribe",
      params: [{ mentions: [this.poolContext.poolId] }, { commitment: this.commitment }],
    };

    try {
      this.transport.send(JSON.stringify(payload));
      this.log(
        `Sent logsSubscribe for candidate pool ${this.poolContext.poolId} (reqId: ${reqId}, epoch: ${this.connectionEpoch})`,
      );
    } catch (err) {
      this.handleTransportError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Processes a raw WebSocket frame from the active transport with full contract validation.
   */
  public handleIncomingMessage(rawMessage: string | Buffer): void {
    const text = typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (this.status === "SUBSCRIBED") {
        this.handleActiveSourceCorruption(
          "UNPARSEABLE_FRAME",
          `Active source emitted unparseable frame: ${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        this.totalMalformedFramesDropped++;
        this.log(
          `Failed to parse WebSocket JSON frame: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (this.status === "SUBSCRIBED") {
        this.handleActiveSourceCorruption(
          "NON_OBJECT_FRAME",
          `Active source emitted non-object frame: ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
        );
      } else {
        this.totalMalformedFramesDropped++;
      }
      return;
    }

    const obj = parsed as Record<string, unknown>;

    // 1. Subscription acknowledgment or RPC error response
    if ("id" in obj && typeof obj.id === "number") {
      if (obj.jsonrpc !== "2.0") {
        this.totalMalformedFramesDropped++;
        this.log(
          `[MALFORMED_ACK_DROPPED] Invalid jsonrpc version: expected '2.0', received '${String(obj.jsonrpc)}'`,
        );
        return;
      }

      if (
        obj.id !== this.pendingSubscriptionRequestId ||
        this.pendingRequestEpoch !== this.connectionEpoch
      ) {
        this.totalStaleEpochMessagesDropped++;
        this.log(
          `[STALE_ACK_DROPPED] Ack id ${obj.id} does not match pending request ${this.pendingSubscriptionRequestId} or epoch ${this.connectionEpoch}`,
        );
        return;
      }

      if ("error" in obj && obj.error) {
        this.totalMalformedFramesDropped++;
        this.log(`Subscription request rejected by RPC: ${JSON.stringify(obj.error)}`);
        return;
      }

      if (
        typeof obj.result !== "number" ||
        !Number.isFinite(obj.result) ||
        !Number.isInteger(obj.result) ||
        obj.result < 0
      ) {
        this.totalMalformedFramesDropped++;
        this.log(`[MALFORMED_ACK_DROPPED] Invalid subscriptionId in result: ${String(obj.result)}`);
        return;
      }

      this.activeSubscriptionId = obj.result;
      this.pendingSubscriptionRequestId = null;
      this.pendingRequestEpoch = null;
      this.setStatus("SUBSCRIBED");
      this.log(
        `Subscription active: pool ${this.poolContext.poolId} assigned subscriptionId ${this.activeSubscriptionId}`,
      );

      // Record reconnection gap in tracker if we experienced a disconnected interval
      if (this.disconnectedAtMs !== null) {
        const reconnectedAtMs = this.clock();
        const gapEndMs = Math.max(reconnectedAtMs, this.disconnectedAtMs + 1);
        const gap: StreamGap = Object.freeze({
          gapStartMs: this.disconnectedAtMs,
          gapEndMs,
          reason: "SUBSCRIPTION_DISCONNECT",
        });
        this.tracker.recordCollectionGap(gap);
        this.totalDisconnectGapsRecorded++;
        this.disconnectedAtMs = null;
      }
      return;
    }

    // 2. Incoming logsNotification
    if (obj.method === "logsNotification") {
      if (obj.jsonrpc !== "2.0") {
        this.handleActiveSourceCorruption(
          "MALFORMED_JSONRPC_VERSION",
          `Expected jsonrpc '2.0', received '${String(obj.jsonrpc)}'`,
        );
        return;
      }

      if (!obj.params || typeof obj.params !== "object" || Array.isArray(obj.params)) {
        this.handleActiveSourceCorruption("MISSING_PARAMS", "Missing or non-object params");
        return;
      }

      const params = obj.params as Record<string, unknown>;
      const subId = params.subscription;

      // Validate subscription identifier
      const isIdentifiableSubId =
        typeof subId === "number" &&
        Number.isFinite(subId) &&
        Number.isInteger(subId) &&
        subId >= 0;

      if (!isIdentifiableSubId) {
        this.handleActiveSourceCorruption(
          "INVALID_SUBSCRIPTION_ID",
          `Active source notification has invalid subscription ID: ${String(subId)}`,
        );
        return;
      }

      // Continue rejecting identifiable unrelated subscriptions without treating them as candidate losses
      if (this.activeSubscriptionId === null || subId !== this.activeSubscriptionId) {
        this.totalUnrelatedDropped++;
        return;
      }

      // Active-source message arrived! Any envelope corruption MUST preserve collection uncertainty!
      const result = params.result as Record<string, unknown> | undefined;
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        this.handleActiveSourceCorruption(
          "MISSING_RESULT",
          "Active source notification missing or non-object result",
        );
        return;
      }

      const context = result.context as Record<string, unknown> | undefined;
      if (!context || typeof context !== "object" || Array.isArray(context)) {
        this.handleActiveSourceCorruption(
          "MISSING_CONTEXT",
          "Active source notification missing or non-object context",
        );
        return;
      }

      if (
        typeof context.slot !== "number" ||
        !Number.isFinite(context.slot) ||
        !Number.isInteger(context.slot) ||
        context.slot < 0
      ) {
        this.handleActiveSourceCorruption(
          "INVALID_SLOT",
          `Active source notification has invalid slot: ${String(context.slot)}`,
        );
        return;
      }
      const slot = context.slot;

      const value = result.value as Record<string, unknown> | undefined;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        this.handleActiveSourceCorruption(
          "MISSING_VALUE",
          "Active source notification missing or non-object value",
        );
        return;
      }

      // Contract validation for err: must be null, string, or non-array object
      if (!("err" in value) || value.err === undefined) {
        this.handleActiveSourceCorruption(
          "MISSING_ERR_FIELD",
          "Active source notification missing err field",
        );
        return;
      }

      const errVal = value.err;
      const isErrValid =
        errVal === null ||
        typeof errVal === "string" ||
        (typeof errVal === "object" && !Array.isArray(errVal));

      if (!isErrValid) {
        this.handleActiveSourceCorruption(
          "MALFORMED_ERR_FIELD",
          `Active source notification err field violates contract (must be null, string, or object; received: ${typeof errVal})`,
        );
        return;
      }

      // Contract validation for logs: must be an array of strings
      if (!Array.isArray(value.logs)) {
        this.handleActiveSourceCorruption(
          "MISSING_LOGS_ARRAY",
          "Active source notification missing logs array",
        );
        return;
      }

      if (!value.logs.every((item: unknown) => typeof item === "string")) {
        this.handleActiveSourceCorruption(
          "MALFORMED_LOGS_FIELD",
          "Active source notification logs array contains non-string elements",
        );
        return;
      }

      const rawSig = value.signature;
      if (
        typeof rawSig !== "string" ||
        rawSig.trim().length < 32 ||
        rawSig.trim().length > 128 ||
        !/^[1-9A-HJ-NP-Za-km-z]+$/.test(rawSig.trim())
      ) {
        this.handleActiveSourceCorruption(
          "INVALID_SIGNATURE",
          `Active source notification has invalid signature: '${String(rawSig)}'`,
        );
        return;
      }
      const signature = rawSig.trim();

      this.totalNotificationsReceived++;

      // Check notification budget ceiling
      if (
        this.maxNotificationsBudget !== undefined &&
        this.totalNotificationsReceived > this.maxNotificationsBudget
      ) {
        this.log(
          `[WS_NOTIFICATION_BUDGET_EXCEEDED] Closing WebSocket: reached budget ceiling of ${this.maxNotificationsBudget}`,
        );
        this.close();
        return;
      }

      // Route signature notification to adapter
      const enqueueResult = this.adapter.enqueueNotification({
        signature,
        slot,
        receivedAtMs: this.clock(),
        provenance: "HOST_OBSERVED",
      });

      if (enqueueResult.queued) {
        this.totalNotificationsRouted++;
      } else if (enqueueResult.reason === "DUPLICATE_NOTIFICATION") {
        this.totalDuplicatesSkipped++;
      } else if (enqueueResult.reason === "QUEUE_OVERFLOW") {
        this.totalQueueOverflows++;
      } else {
        // Enqueue rejection for active-source input preserves collection uncertainty
        this.handleActiveSourceCorruption(
          enqueueResult.reason ?? "ENQUEUE_REJECTED",
          `Adapter rejected active source notification for ${signature}: ${enqueueResult.reason}`,
        );
      }
      return;
    }

    // Unrecognized frame while actively subscribed could conceal active stream traffic
    if (this.status === "SUBSCRIBED") {
      this.handleActiveSourceCorruption(
        "UNRECOGNIZED_ACTIVE_FRAME",
        `Active source emitted unrecognized frame: ${Object.keys(obj).join(",")}`,
      );
      return;
    }

    // Unrecognized frame while not subscribed
    this.totalMalformedFramesDropped++;
  }

  private handleActiveSourceCorruption(reason: string, details: string): void {
    const now = this.clock();
    this.totalMalformedFramesDropped++;
    this.log(`[ACTIVE_SOURCE_CORRUPTION] ${details}`);
    // Immediately record collection gap in tracker to preserve uncertainty
    this.tracker.recordCollectionGap({
      gapStartMs: Math.max(1, now - 1000),
      gapEndMs: now,
      reason: `ACTIVE_SOURCE_CORRUPTION:${reason}`,
    });
    this.totalDisconnectGapsRecorded++;
  }

  /**
   * Advances the tracker observation timeline ONLY if a validated SourceCompletenessProof
   * is provided, subscription is active, and adapter workload is zero. Explanatory text is rejected.
   */
  public advanceCoverage(options: AdvanceCoverageOptions): AdvanceCoverageResult {
    this.totalCoverageAdvancesAttempted++;

    if (!options || typeof options !== "object") {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "INVALID_OPTIONS",
        message: "AdvanceCoverageOptions must be a non-null object",
      };
    }

    // 1. Subscription must be active
    if (this.status !== "SUBSCRIBED" || this.activeSubscriptionId === null) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "SUBSCRIPTION_NOT_ACTIVE",
        message: `Cannot advance coverage: subscription status is '${this.status}' (activeSubscriptionId: ${this.activeSubscriptionId})`,
      };
    }

    // 2. Adapter queue and in-flight retrievals must be completely drained
    const adapterWorkload = this.adapter.getActiveWorkload();
    if (adapterWorkload > 0) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "UNRESOLVED_ADAPTER_WORK",
        message: `Cannot advance coverage: adapter has ${this.adapter.getPendingQueueLength()} pending and ${this.adapter.getInFlightCount()} in-flight transaction retrievals`,
      };
    }

    // 3. Completeness proof validation: text strings do not establish proof
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proof = (options as any).proof;
    if (!proof || typeof proof !== "object" || typeof proof === "string") {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "UNTRUSTED_COMPLETENESS_PROOF",
        message:
          "Explanatory text strings do not establish source completeness. A validated SourceCompletenessProof object is required.",
      };
    }

    if (proof.poolId !== this.poolContext.poolId) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "PROOF_POOL_MISMATCH",
        message: `Completeness proof poolId (${proof.poolId}) does not match coordinator poolId (${this.poolContext.poolId})`,
      };
    }

    if (proof.connectionEpoch !== this.connectionEpoch) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "PROOF_EPOCH_MISMATCH",
        message: `Completeness proof connectionEpoch (${proof.connectionEpoch}) does not match coordinator connectionEpoch (${this.connectionEpoch})`,
      };
    }

    if (proof.mode === "PROVEN_GAPLESS_BLOCK_RANGE_POLL") {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "COMPLETENESS_MECHANISM_UNAVAILABLE",
        message:
          "Production source-completeness verification mechanism is not implemented (identified readiness gap)",
      };
    }

    if (proof.mode !== "SYNTHETIC_TEST_FIXTURE") {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "UNRECOGNIZED_COMPLETENESS_MODE",
        message: `Unrecognized completeness mode: '${String(proof.mode)}'`,
      };
    }

    // Strict separation: synthetic completeness proofs are disallowed under production configuration
    if (!this.allowSyntheticCompletenessProofs) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "SYNTHETIC_PROOFS_DISALLOWED",
        message:
          "Synthetic completeness proofs are disallowed under production configuration (requires explicit allowSyntheticCompletenessProofs opt-in for offline tests)",
      };
    }

    if (
      !proof.testFixtureLabel ||
      typeof proof.testFixtureLabel !== "string" ||
      proof.testFixtureLabel.trim().length === 0
    ) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "MISSING_FIXTURE_LABEL",
        message: "Synthetic completeness proof requires an explicit non-empty testFixtureLabel",
      };
    }

    // 4. Validate checkpoint timestamp
    const now = this.clock();
    const cpMs = options.checkpointMs;
    if (
      typeof cpMs !== "number" ||
      !Number.isFinite(cpMs) ||
      !Number.isInteger(cpMs) ||
      cpMs <= 0
    ) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "INVALID_CHECKPOINT_TIMESTAMP",
        message: `Invalid checkpointMs: expected positive finite integer, received: ${String(cpMs)}`,
      };
    }

    if (cpMs !== proof.rangeEndMs) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "CHECKPOINT_PROOF_MISMATCH",
        message: `checkpointMs (${cpMs}) does not match proof rangeEndMs (${proof.rangeEndMs})`,
      };
    }

    if (cpMs > now + 5_000) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "FUTURE_DATED_CHECKPOINT",
        message: `Checkpoint timestamp ${cpMs} exceeds current host time ${now} by more than allowed skew`,
      };
    }

    // 5. Advance observation timeline in tracker
    this.tracker.recordHeartbeat(cpMs, proof.endSlot, {
      isBacklogged: false,
    });

    const evaluation = this.evaluateFlow(cpMs);
    this.totalCoverageAdvancesSucceeded++;

    return {
      ok: true,
      checkpointMs: cpMs,
      coverage: evaluation.coverage,
      isCoverageSufficient: evaluation.isCoverageSufficient,
      isProductionCompletenessEstablished: false,
    };
  }

  /**
   * Records a completed, gapless observed time range into the tracker.
   * Requires a validated SourceCompletenessProof and zero adapter backlog. Explanatory text is rejected.
   */
  public recordCompletedRange(
    rangeStartMs: number,
    rangeEndMs: number,
    proof: SourceCompletenessProof,
  ): AdvanceCoverageResult {
    this.totalCoverageAdvancesAttempted++;

    if (this.status !== "SUBSCRIBED" || this.activeSubscriptionId === null) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "SUBSCRIPTION_NOT_ACTIVE",
        message: `Cannot record completed range: subscription status is '${this.status}' (activeSubscriptionId: ${this.activeSubscriptionId})`,
      };
    }

    const adapterWorkload = this.adapter.getActiveWorkload();
    if (adapterWorkload > 0) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "UNRESOLVED_ADAPTER_WORK",
        message: `Cannot record completed range: adapter has ${this.adapter.getPendingQueueLength()} pending and ${this.adapter.getInFlightCount()} in-flight transaction retrievals`,
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!proof || typeof proof !== "object" || typeof (proof as any) === "string") {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "UNTRUSTED_COMPLETENESS_PROOF",
        message:
          "Explanatory text strings do not establish source completeness. A validated SourceCompletenessProof object is required.",
      };
    }

    if (proof.poolId !== this.poolContext.poolId) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "PROOF_POOL_MISMATCH",
        message: `Completeness proof poolId (${proof.poolId}) does not match coordinator poolId (${this.poolContext.poolId})`,
      };
    }

    if (proof.connectionEpoch !== this.connectionEpoch) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "PROOF_EPOCH_MISMATCH",
        message: `Completeness proof connectionEpoch (${proof.connectionEpoch}) does not match coordinator connectionEpoch (${this.connectionEpoch})`,
      };
    }

    if (proof.mode === "PROVEN_GAPLESS_BLOCK_RANGE_POLL") {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "COMPLETENESS_MECHANISM_UNAVAILABLE",
        message:
          "Production source-completeness verification mechanism is not implemented (identified readiness gap)",
      };
    }

    if (proof.mode !== "SYNTHETIC_TEST_FIXTURE") {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "UNRECOGNIZED_COMPLETENESS_MODE",
        message: `Unrecognized completeness mode: '${String(proof.mode)}'`,
      };
    }

    // Strict separation: synthetic completeness proofs are disallowed under production configuration
    if (!this.allowSyntheticCompletenessProofs) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "SYNTHETIC_PROOFS_DISALLOWED",
        message:
          "Synthetic completeness proofs are disallowed under production configuration (requires explicit allowSyntheticCompletenessProofs opt-in for offline tests)",
      };
    }

    if (
      !proof.testFixtureLabel ||
      typeof proof.testFixtureLabel !== "string" ||
      proof.testFixtureLabel.trim().length === 0
    ) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "MISSING_FIXTURE_LABEL",
        message: "Synthetic completeness proof requires an explicit non-empty testFixtureLabel",
      };
    }

    const now = this.clock();
    if (
      typeof rangeStartMs !== "number" ||
      typeof rangeEndMs !== "number" ||
      !Number.isFinite(rangeStartMs) ||
      !Number.isFinite(rangeEndMs) ||
      !Number.isInteger(rangeStartMs) ||
      !Number.isInteger(rangeEndMs) ||
      rangeStartMs <= 0 ||
      rangeEndMs <= 0 ||
      rangeStartMs > rangeEndMs
    ) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "INVALID_RANGE_TIMESTAMPS",
        message: `Invalid range: [${rangeStartMs}, ${rangeEndMs}]`,
      };
    }

    if (rangeStartMs !== proof.rangeStartMs || rangeEndMs !== proof.rangeEndMs) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "RANGE_PROOF_MISMATCH",
        message: `Range [${rangeStartMs}, ${rangeEndMs}] does not match proof range [${proof.rangeStartMs}, ${proof.rangeEndMs}]`,
      };
    }

    if (rangeEndMs > now + 5_000) {
      this.totalCoverageAdvancesRejected++;
      return {
        ok: false,
        reason: "FUTURE_DATED_RANGE",
        message: `Range end timestamp ${rangeEndMs} exceeds current host time ${now}`,
      };
    }

    this.tracker.recordCompletedRange(rangeStartMs, rangeEndMs);
    const evaluation = this.evaluateFlow(rangeEndMs);
    this.totalCoverageAdvancesSucceeded++;

    return {
      ok: true,
      checkpointMs: rangeEndMs,
      coverage: evaluation.coverage,
      isCoverageSufficient: evaluation.isCoverageSufficient,
      isProductionCompletenessEstablished: false,
    };
  }

  /**
   * Evaluates rolling flow across the latest 60-second window.
   * Inactive or unproven source subscriptions immediately invalidate usable flow, returning null counts.
   */
  public evaluateFlow(evaluationTimestampMs?: number): RollingFlowEvaluationResult {
    const nowMs = evaluationTimestampMs ?? this.clock();

    // If subscription is not actively SUBSCRIBED, usable flow is immediately invalidated
    if (this.status !== "SUBSCRIBED" || this.activeSubscriptionId === null) {
      // Ensure ongoing disconnect interval is reflected in tracker as a collection gap
      if (this.disconnectedAtMs !== null && nowMs > this.disconnectedAtMs) {
        this.tracker.recordCollectionGap({
          gapStartMs: this.disconnectedAtMs,
          gapEndMs: nowMs,
          reason: "ONGOING_SUBSCRIPTION_DISCONNECT",
        });
      }

      const baseResult = this.tracker.evaluateWindow(nowMs);
      const coverage: FlowCoverageStatus =
        this.disconnectedAtMs !== null || baseResult.diagnostics.trackingDurationMs >= 60_000
          ? "COLLECTION_GAP"
          : baseResult.coverage === "UNINITIALIZED"
            ? "UNINITIALIZED"
            : "WARM_UP";

      return Object.freeze({
        ...baseResult,
        coverage,
        isCoverageSufficient: false,
        recentBuys60s: null,
        recentSells60s: null,
        flowRatio: null,
      });
    }

    const baseResult = this.tracker.evaluateWindow(nowMs);

    // Under default production configuration (when synthetic proofs are not explicitly opted into),
    // production source completeness remains unproven (identified readiness gap).
    // Therefore, flow counts must be retained as unavailable (null) and coverage cannot be SUFFICIENT.
    if (!this.allowSyntheticCompletenessProofs) {
      const coverage: FlowCoverageStatus =
        baseResult.coverage === "SUFFICIENT" ? "COLLECTION_GAP" : baseResult.coverage;

      return Object.freeze({
        ...baseResult,
        coverage,
        isCoverageSufficient: false,
        recentBuys60s: null,
        recentSells60s: null,
        flowRatio: null,
      });
    }

    return baseResult;
  }

  /**
   * Integration bridge to construct RetestSpotInfo for RetestGateEvaluator.
   * Inactive subscription or source loss immediately produces unavailable counts and non-SUFFICIENT coverage.
   */
  public createRetestSpotInfo(
    baseSpot: {
      readonly spotPriceSol: number;
      readonly spotPriceUsd?: number | null | undefined;
      readonly liquidityUsd?: number | null | undefined;
    },
    evaluationTimestampMs?: number | undefined,
  ): RetestSpotInfo {
    const flowResult = this.evaluateFlow(evaluationTimestampMs);
    return {
      spotPriceSol: baseSpot.spotPriceSol,
      spotPriceUsd: baseSpot.spotPriceUsd,
      liquidityUsd: baseSpot.liquidityUsd,
      recentBuys60s: flowResult.recentBuys60s,
      recentSells60s: flowResult.recentSells60s,
      flowCoverage: flowResult.coverage,
    };
  }

  /**
   * Produces an honest coverage diagnostic explaining whether rolling flow is sufficient,
   * retaining unavailable flow counts when limitations prevent complete 60s coverage.
   */
  public getCoverageDiagnostic(evaluationTimestampMs?: number): CoordinatorCoverageDiagnostic {
    const evalResult = this.evaluateFlow(evaluationTimestampMs);

    let limitationReason: string;
    if (this.status !== "SUBSCRIBED" || this.activeSubscriptionId === null) {
      limitationReason = `Subscription is not active (${this.status}; activeId: ${this.activeSubscriptionId})`;
    } else if (this.adapter.getActiveWorkload() > 0) {
      limitationReason = `Adapter has unresolved workload (${this.adapter.getPendingQueueLength()} pending, ${this.adapter.getInFlightCount()} in-flight)`;
    } else if (!this.allowSyntheticCompletenessProofs) {
      limitationReason =
        "Production source completeness is unproven (production gapless block range verifier is an open readiness gap)";
    } else {
      switch (evalResult.coverage) {
        case "SUFFICIENT":
          limitationReason =
            "Coverage is sufficient; 60-second window is continuously observed without gaps (offline synthetic proof only; production completeness remains unproven)";
          break;
        case "WARM_UP":
          limitationReason = `Warm-up in progress: tracking elapsed ${evalResult.diagnostics.trackingDurationMs}ms < required 60,000ms window`;
          break;
        case "PROCESSING_BACKLOG":
          limitationReason = "Trade stream has active processing backlog in adapter or tracker";
          break;
        case "COLLECTION_GAP":
          limitationReason = `Collection gap detected: window intersects ${evalResult.diagnostics.gapCount} stream gap(s)`;
          break;
        case "CAPACITY_LOSS":
          limitationReason =
            "Capacity loss detected: active events or deduplication keys exceeded buffer limits";
          break;
        case "STALE_DATA":
          limitationReason =
            "Observation stream is stale: silence since last observation exceeds inactivity ceiling";
          break;
        case "UNINITIALIZED":
        default:
          limitationReason = "Tracker is uninitialized";
          break;
      }
    }

    return Object.freeze({
      poolId: this.poolContext.poolId,
      tokenMint: this.poolContext.candidateTokenMint,
      status: this.status,
      activeSubscriptionId: this.activeSubscriptionId,
      connectionEpoch: this.connectionEpoch,
      disconnectedAtMs: this.disconnectedAtMs,
      coverage: evalResult.coverage,
      isCoverageSufficient: evalResult.isCoverageSufficient,
      isProductionCompletenessEstablished: false,
      recentBuys60s: evalResult.recentBuys60s,
      recentSells60s: evalResult.recentSells60s,
      flowRatio: evalResult.flowRatio,
      limitationReason,
      adapterPendingQueueLength: this.adapter.getPendingQueueLength(),
      adapterInFlightCount: this.adapter.getInFlightCount(),
      adapterActiveWorkload: this.adapter.getActiveWorkload(),
      metrics: this.getMetrics(),
      lastReconciliationResult: this.lastReconciliationResult,
    });
  }

  /**
   * Orchestrates provider-relative exact-pool window reconciliation for research and diagnostics.
   *
   * Asynchronous research orchestration:
   * 1. Validates candidate pool binding and initial active subscription state.
   * 2. Awaits ExactPoolHistoryEnumerator.enumerate(), verifying connection epoch and active status.
   * 3. Awaits ExactPoolTransactionResolutionBridge.resolve(), which ingests discovered swaps into tracker.
   * 4. Evaluates the cutoff-anchored research window [T_cutoff - 60s, T_cutoff] using evaluateExactPoolWindowReconciliation.
   *
   * Note: Production flow getters (createRetestSpotInfo, evaluateFlow) remain synchronous,
   * perform zero network dispatch or reconciliation, and fail closed with unavailable counts.
   */
  public async reconcileCandidateWindow(
    sourceCutoff: SourceCutoffEvidence,
    options: CandidateWindowReconciliationOptions,
  ): Promise<WindowReconciliationResult> {
    // Snapshot cutoff and operation inputs before awaiting work to guarantee an immutable research window
    const sourceCutoffSnapshot = cloneSourceCutoff(sourceCutoff);
    const optionsSnapshot: CandidateWindowReconciliationOptions = {
      knownAnchorSignature: options?.knownAnchorSignature,
      historyEnumerator: options?.historyEnumerator,
      resolutionBridge: options?.resolutionBridge,
      decisionTimestampMs: options?.decisionTimestampMs,
      observationStartMs: options?.observationStartMs,
      observationEndMs: options?.observationEndMs,
      budgetManager: options?.budgetManager,
      hasActiveBacklog: options?.hasActiveBacklog,
      paperQuietStreamPolicy: options?.paperQuietStreamPolicy,
    };

    const initialEpoch = this.connectionEpoch;
    const initialStatus = this.status;
    const now = this.clock();
    const cutoffTimestampMs = sourceCutoffSnapshot?.cutoffTimestampMs ?? now;

    // 1. Validate identity binding for candidate pool and mint
    if (sourceCutoffSnapshot && sourceCutoffSnapshot.provenance === "ON_CHAIN_BLOCK_TIME") {
      if (
        sourceCutoffSnapshot.sourceMethod === "getSignaturesForAddress" &&
        sourceCutoffSnapshot.requestContext?.address &&
        sourceCutoffSnapshot.requestContext.address !== this.poolContext.poolId
      ) {
        return evaluateExactPoolWindowReconciliation({
          poolContext: this.poolContext,
          decisionTimestampMs: optionsSnapshot.decisionTimestampMs ?? now,
          observationStartMs:
            optionsSnapshot.observationStartMs ?? this.tracker.getTrackingStartedMs(),
          observationEndMs: optionsSnapshot.observationEndMs ?? now,
          sourceCutoff: sourceCutoffSnapshot,
          budgetManager: optionsSnapshot.budgetManager ?? this.adapter.getBudgetManager(),
          clock: this.clock,
          paperQuietStreamPolicy: optionsSnapshot.paperQuietStreamPolicy,
        });
      }
    }

    // 2. Pre-await lifecycle validation: must be actively SUBSCRIBED
    if (initialStatus !== "SUBSCRIBED" || this.activeSubscriptionId === null) {
      return evaluateExactPoolWindowReconciliation({
        poolContext: this.poolContext,
        decisionTimestampMs: optionsSnapshot.decisionTimestampMs ?? now,
        observationStartMs:
          optionsSnapshot.observationStartMs ?? this.tracker.getTrackingStartedMs(),
        observationEndMs: optionsSnapshot.observationEndMs ?? now,
        sourceCutoff: sourceCutoffSnapshot,
        tracker: this.tracker,
        hasActiveBacklog:
          optionsSnapshot.hasActiveBacklog ?? this.adapter.getPendingQueueLength() > 0,
        budgetManager: optionsSnapshot.budgetManager ?? this.adapter.getBudgetManager(),
        clock: this.clock,
        paperQuietStreamPolicy: optionsSnapshot.paperQuietStreamPolicy,
        recordedGaps: [
          {
            gapStartMs: Math.min(now, cutoffTimestampMs - 1),
            gapEndMs: Math.max(now + 1, cutoffTimestampMs),
            reason: `COORDINATOR_NOT_SUBSCRIBED (${initialStatus})`,
          },
        ],
      });
    }

    // 3. Await history enumeration and record retrieval completion timestamp
    const historyResult = await optionsSnapshot.historyEnumerator.enumerate();
    const historyRetrievedAtMs = this.clock();

    // 4. Post-history await lifecycle check: detect disconnect or epoch change during await
    if (this.connectionEpoch !== initialEpoch || this.status !== "SUBSCRIBED") {
      const postEnumNow = this.clock();
      return evaluateExactPoolWindowReconciliation({
        poolContext: this.poolContext,
        decisionTimestampMs: optionsSnapshot.decisionTimestampMs ?? postEnumNow,
        observationStartMs:
          optionsSnapshot.observationStartMs ?? this.tracker.getTrackingStartedMs(),
        observationEndMs: optionsSnapshot.observationEndMs ?? postEnumNow,
        sourceCutoff: sourceCutoffSnapshot,
        historyResult,
        historyRetrievedAtMs,
        acquisitionCompletedAtMs: postEnumNow,
        tracker: this.tracker,
        hasActiveBacklog:
          optionsSnapshot.hasActiveBacklog ?? this.adapter.getPendingQueueLength() > 0,
        budgetManager: optionsSnapshot.budgetManager ?? this.adapter.getBudgetManager(),
        clock: this.clock,
        paperQuietStreamPolicy: optionsSnapshot.paperQuietStreamPolicy,
        recordedGaps: [
          {
            gapStartMs: Math.min(this.disconnectedAtMs ?? postEnumNow - 1, cutoffTimestampMs - 1),
            gapEndMs: Math.max(postEnumNow + 1, cutoffTimestampMs),
            reason: "LIFECYCLE_CANCELLED_DURING_ENUMERATION",
          },
        ],
      });
    }

    // 5. Await transaction resolution (ingests discovered swaps into tracker) and record completion timestamp
    const resolutionResult = optionsSnapshot.resolutionBridge
      ? await optionsSnapshot.resolutionBridge.resolve(historyResult)
      : null;
    const resolutionRetrievedAtMs = this.clock();
    const acquisitionCompletedAtMs = this.clock();

    // 6. Post-resolution await lifecycle check: detect disconnect or epoch change during await
    if (this.connectionEpoch !== initialEpoch || this.status !== "SUBSCRIBED") {
      const postResNow = this.clock();
      return evaluateExactPoolWindowReconciliation({
        poolContext: this.poolContext,
        decisionTimestampMs: optionsSnapshot.decisionTimestampMs ?? postResNow,
        observationStartMs:
          optionsSnapshot.observationStartMs ?? this.tracker.getTrackingStartedMs(),
        observationEndMs: optionsSnapshot.observationEndMs ?? postResNow,
        sourceCutoff: sourceCutoffSnapshot,
        historyResult,
        ...(resolutionResult ? { resolutionResult } : {}),
        historyRetrievedAtMs,
        resolutionRetrievedAtMs,
        acquisitionCompletedAtMs,
        tracker: this.tracker,
        hasActiveBacklog:
          optionsSnapshot.hasActiveBacklog ?? this.adapter.getPendingQueueLength() > 0,
        budgetManager: optionsSnapshot.budgetManager ?? this.adapter.getBudgetManager(),
        clock: this.clock,
        paperQuietStreamPolicy: optionsSnapshot.paperQuietStreamPolicy,
        recordedGaps: [
          {
            gapStartMs: Math.min(this.disconnectedAtMs ?? postResNow - 1, cutoffTimestampMs - 1),
            gapEndMs: Math.max(postResNow + 1, cutoffTimestampMs),
            reason: "LIFECYCLE_CANCELLED_DURING_RESOLUTION",
          },
        ],
      });
    }

    // 7. Evaluate using decision timestamp at which evidence is actually available
    const explicitDecisionTime = optionsSnapshot.decisionTimestampMs;
    const decisionTimestampMs = explicitDecisionTime ?? acquisitionCompletedAtMs;
    const observationEndMs = optionsSnapshot.observationEndMs ?? decisionTimestampMs;
    const hasActiveBacklog =
      optionsSnapshot.hasActiveBacklog !== undefined
        ? optionsSnapshot.hasActiveBacklog
        : this.adapter.getPendingQueueLength() > 0;

    const reconciliationResult = evaluateExactPoolWindowReconciliation({
      poolContext: this.poolContext,
      decisionTimestampMs,
      observationStartMs: optionsSnapshot.observationStartMs ?? this.tracker.getTrackingStartedMs(),
      observationEndMs,
      sourceCutoff: sourceCutoffSnapshot,
      historyResult,
      ...(resolutionResult ? { resolutionResult } : {}),
      historyRetrievedAtMs,
      resolutionRetrievedAtMs,
      acquisitionCompletedAtMs,
      tracker: this.tracker,
      hasActiveBacklog,
      knownAnchorSignature: optionsSnapshot.knownAnchorSignature,
      budgetManager: optionsSnapshot.budgetManager ?? this.adapter.getBudgetManager(),
      clock: this.clock,
      paperQuietStreamPolicy: optionsSnapshot.paperQuietStreamPolicy,
    });

    this.lastReconciliationResult = reconciliationResult;
    return reconciliationResult;
  }

  /**
   * Drains one pending transaction notification via the adapter.
   */
  public async processNextPending(
    options?: ProcessTransactionOptions,
  ): Promise<ProcessNotificationResult | null> {
    return this.adapter.processNextPending(this.tracker, options);
  }

  /**
   * Drains all pending transaction notifications via the adapter.
   */
  public async processAllPending(options?: ProcessTransactionOptions): Promise<ProcessBatchResult> {
    return this.adapter.processAllPending(this.tracker, options);
  }

  /**
   * Closes the coordinator and underlying transport.
   * Immediately records source loss gap in tracker.
   */
  public close(): void {
    if (this.status === "CLOSED") return;

    const now = this.clock();
    if (this.status === "SUBSCRIBED" || this.status === "SUBSCRIBING") {
      if (this.disconnectedAtMs === null) {
        this.disconnectedAtMs = now;
      }
      this.tracker.recordCollectionGap({
        gapStartMs: now,
        gapEndMs: now + 1,
        reason: "COORDINATOR_CLOSED",
      });
      this.totalDisconnectGapsRecorded++;
    }

    this.setStatus("CLOSED");
    this.activeSubscriptionId = null;
    this.pendingSubscriptionRequestId = null;
    this.pendingRequestEpoch = null;

    if (this.transport) {
      try {
        this.transport.close(1000, "Coordinator closed");
      } catch {
        // ignore
      }
    }
  }

  private setStatus(newStatus: SubscriptionCoordinatorStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.log(`Subscription status changed: ${newStatus}`);
      this.onStatusChange?.(newStatus);
    }
  }

  private handleTransportOpen(): void {
    this.sendSubscriptionRequest();
  }

  private handleTransportClose(code?: number, reason?: string): void {
    if (this.status === "CLOSED") return;
    const now = this.clock();
    if (this.status === "SUBSCRIBED" || this.status === "SUBSCRIBING") {
      if (this.disconnectedAtMs === null) {
        this.disconnectedAtMs = now;
      }
      this.tracker.recordCollectionGap({
        gapStartMs: now,
        gapEndMs: now + 1,
        reason: "SUBSCRIPTION_DISCONNECT",
      });
      this.totalDisconnectGapsRecorded++;
    }
    this.activeSubscriptionId = null;
    this.pendingSubscriptionRequestId = null;
    this.pendingRequestEpoch = null;
    this.setStatus("DISCONNECTED");
    this.log(`Transport closed (code: ${code ?? 1000}, reason: ${reason ?? "unknown"})`);
  }

  private handleTransportError(err: Error): void {
    if (this.status === "CLOSED") return;
    const now = this.clock();
    if (this.status === "SUBSCRIBED" || this.status === "SUBSCRIBING") {
      if (this.disconnectedAtMs === null) {
        this.disconnectedAtMs = now;
      }
      this.tracker.recordCollectionGap({
        gapStartMs: now,
        gapEndMs: now + 1,
        reason: "SUBSCRIPTION_ERROR",
      });
      this.totalDisconnectGapsRecorded++;
    }
    this.activeSubscriptionId = null;
    this.pendingSubscriptionRequestId = null;
    this.pendingRequestEpoch = null;
    this.setStatus("DISCONNECTED");
    this.log(`Transport error: ${err.message}`);
  }
}
