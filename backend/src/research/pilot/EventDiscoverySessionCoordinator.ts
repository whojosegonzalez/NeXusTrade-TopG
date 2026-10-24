/**
 * Phase 12.94-D Milestone D.2.9-B2: Event Discovery Session Coordinator
 *
 * Orchestrates prospective, event-driven Raydium pool discovery sessions.
 * Manages WebSocket subscriptions, decoupled transaction fetching, on-chain account verification,
 * bounded queues, explicit resource budgets, and immutable evidence capture.
 *
 * Core Guarantees:
 * 1. Protocol Separation: Separate AMM v4 and CPMM WebSocket log subscriptions.
 * 2. Strict Budget Ceilings:
 *    - maxWsMessagesBudget (e.g. 500)
 *    - maxTransactionsBudget (e.g. 25)
 *    - maxAccountReadsBudget (e.g. 20)
 *    - maxTotalRpcBudget (e.g. 50)
 *    - durationSec (e.g. 60s)
 *    - maxRssMb (e.g. 256MB)
 * 3. Auditable Accounting: Distinct counts for:
 *    - notifications received
 *    - transactions fetched
 *    - pool initializations decoded
 *    - unique pools discovered
 *    - pools independently verified
 *    - pools rejected
 *    - unresolved observations
 * 4. Two-Strategy Separation: Operates exclusively for Micro-Cap Probes prospective discovery.
 *    Does NOT replace or alter Established Runners mature-pool catalog discovery.
 * 5. Immutable Evidence & Manifest: Persists session-unique directory with sorted SHA-256 manifest.
 *    Marks status as FINALIZED, INTERRUPTED, or FAILED honestly.
 */

import type {
  DiscoveredPoolInitializationEvent,
  EventDiscoveryMetricsSnapshot,
  VerificationDispatchResult,
} from "./EventDiscoveryContracts.js";
import {
  EventDiscoveryIngestionEngine,
  type EventDiscoveryEngineOptions,
} from "./EventDiscoveryIngestionEngine.js";
import {
  type B2SnapshotManifest,
  ProgressiveEvidenceRecorder,
  verifyB2SessionManifest,
} from "./EventSessionEvidenceCapture.js";
import type { SolanaRpcRecordingAccountFetcher } from "./SolanaRpcRecordingAccountFetcher.js";
import {
  type ISharedRpcBudget,
  type SolanaRpcTransactionFetcher,
} from "./SolanaRpcTransactionFetcher.js";
import type { SolanaWebSocketSubscriptionClient } from "./SolanaWebSocketSubscriptionClient.js";

/**
 * Shared cross-client RPC budget counter enforcing total ceiling across transaction and account clients (B2-READY-02).
 */
class SharedRpcBudgetTracker implements ISharedRpcBudget {
  private count = 0;
  constructor(private readonly maxCalls: number) {}
  public canExecute(): boolean {
    return this.count < this.maxCalls;
  }
  public recordCall(): void {
    this.count++;
  }
  public getRemaining(): number {
    return Math.max(0, this.maxCalls - this.count);
  }
  public getTotalExecuted(): number {
    return this.count;
  }
}

export interface EventDiscoverySessionBudgets {
  readonly durationSec?: number | undefined; // Session runtime ceiling in seconds (default: 60)
  readonly maxEvents?: number | undefined; // Discovered events ceiling (default: 50)
  readonly maxWsMessages?: number | undefined; // WebSocket message budget ceiling (default: 500)
  readonly maxTransactions?: number | undefined; // getTransaction ceiling (default: 25)
  readonly maxAccountReads?: number | undefined; // Account read calls ceiling (default: 20)
  readonly maxTotalRpcCalls?: number | undefined; // Combined RPC calls ceiling (default: 45)
  readonly maxFallbackTransactions?: number | undefined; // Fallback transactions budget ceiling (default: 5, B2-GO-FIX-02)
  readonly reservedPrioritizedTransactions?: number | undefined; // Budget reserved for prioritized inits (default: 20, B2-GO-FIX-02)
  readonly maxRssMb?: number | undefined; // Process RSS ceiling in megabytes (default: 256)
  readonly maxDiskMb?: number | undefined; // Disk write limit in megabytes (default: 256)
}

export interface ResolvedEventDiscoveryBudgets {
  readonly durationSec: number;
  readonly maxEvents: number;
  readonly maxWsMessages: number;
  readonly maxTransactions: number;
  readonly maxAccountReads: number;
  readonly maxTotalRpcCalls: number;
  readonly maxFallbackTransactions: number;
  readonly reservedPrioritizedTransactions: number;
  readonly maxRssMb: number;
  readonly maxDiskMb: number;
}

export interface EventDiscoverySessionOptions {
  readonly wsClient: SolanaWebSocketSubscriptionClient;
  readonly txFetcher: SolanaRpcTransactionFetcher;
  readonly accountFetcher: SolanaRpcRecordingAccountFetcher;
  readonly engine?: EventDiscoveryIngestionEngine | undefined;
  readonly engineOptions?: EventDiscoveryEngineOptions | undefined;
  readonly budgets?: EventDiscoverySessionBudgets | undefined;
  readonly captureBaseDir?: string | undefined;
  readonly onLog?: ((msg: string) => void) | undefined;
}

export interface EventDiscoverySessionSummary {
  readonly sessionId: string;
  readonly sessionDir?: string | undefined;
  readonly status: "FINALIZED" | "INTERRUPTED" | "FAILED";
  readonly stopReason: string;
  readonly elapsedSec: number;
  readonly budgets: {
    readonly durationSec: number;
    readonly maxEvents: number;
    readonly maxWsMessages: number;
    readonly maxTransactions: number;
    readonly maxAccountReads: number;
    readonly maxTotalRpcCalls: number;
    readonly maxFallbackTransactions?: number | undefined;
    readonly reservedPrioritizedTransactions?: number | undefined;
  };
  readonly accounting: {
    readonly rawNotificationsReceived: number;
    readonly transactionsFetched: number;
    readonly poolInitializationsDecoded: number;
    readonly uniquePoolsDiscovered: number;
    readonly poolsVerifiedCoherent: number;
    readonly poolsRejected: number;
    readonly unresolvedObservations: number;
    readonly prioritizedTransactionsFetched?: number | undefined;
    readonly fallbackTransactionsFetched?: number | undefined;
    readonly unusedReservedTransactionsBudget?: number | undefined;
    readonly remainingUnfetchedSignatures?: number | undefined;
  };
  readonly rpcCallsExecuted: {
    readonly transactionFetches: number;
    readonly accountReads: number;
    readonly totalRpcCalls: number;
  };
  readonly verificationReports: readonly VerificationDispatchResult[];
  readonly discoveredEvents: readonly DiscoveredPoolInitializationEvent[];
  readonly metrics: EventDiscoveryMetricsSnapshot;
  readonly manifest?: B2SnapshotManifest | undefined;
  readonly manifestVerified?: boolean | undefined;
}

export class EventDiscoverySessionCoordinator {
  private readonly wsClient: SolanaWebSocketSubscriptionClient;
  private readonly txFetcher: SolanaRpcTransactionFetcher;
  private readonly accountFetcher: SolanaRpcRecordingAccountFetcher;
  private readonly engine: EventDiscoveryIngestionEngine;
  private readonly budgets: ResolvedEventDiscoveryBudgets;
  private readonly captureBaseDir?: string | undefined;
  private readonly onLog?: ((msg: string) => void) | undefined;
  private readonly evidenceRecorder?: ProgressiveEvidenceRecorder | undefined;

  private isRunning = false;
  private stopRequested = false;
  private stopReason = "COMPLETED";
  private isDiskExhausted = false;
  private readonly pendingNotificationPromises: Promise<unknown>[] = [];

  private recordedNotificationCount = 0;
  private recordedTxCount = 0;
  private recordedAccCount = 0;
  private recordedEventCount = 0;
  private recordedReportCount = 0;

  constructor(options: EventDiscoverySessionOptions) {
    this.wsClient = options.wsClient;
    this.txFetcher = options.txFetcher;
    this.accountFetcher = options.accountFetcher;
    this.captureBaseDir = options.captureBaseDir;
    this.onLog = options.onLog;

    const b = options.budgets ?? {};
    this.budgets = {
      durationSec: b.durationSec ?? 60,
      maxEvents: b.maxEvents ?? 50,
      maxWsMessages: b.maxWsMessages ?? 500,
      maxTransactions: b.maxTransactions ?? 25,
      maxAccountReads: b.maxAccountReads ?? 20,
      maxTotalRpcCalls: b.maxTotalRpcCalls ?? 45,
      maxFallbackTransactions: b.maxFallbackTransactions ?? 5,
      reservedPrioritizedTransactions:
        b.reservedPrioritizedTransactions ??
        Math.max(0, (b.maxTransactions ?? 25) - (b.maxFallbackTransactions ?? 5)),
      maxRssMb: b.maxRssMb ?? 256,
      maxDiskMb: b.maxDiskMb ?? 256,
    };

    // Shared RPC budget enforcement across transaction and account fetchers (B2-READY-02)
    const sharedBudget = new SharedRpcBudgetTracker(this.budgets.maxTotalRpcCalls);
    this.txFetcher.setSharedBudget(sharedBudget);
    this.accountFetcher.setSharedBudget(sharedBudget);

    // Initialize progressive evidence recorder if capture directory provided (B2-READY-05)
    if (this.captureBaseDir) {
      this.evidenceRecorder = new ProgressiveEvidenceRecorder({
        captureBaseDir: this.captureBaseDir,
        maxDiskMb: this.budgets.maxDiskMb,
      });
    }

    this.engine =
      options.engine ??
      new EventDiscoveryIngestionEngine({
        maxEvents: this.budgets.maxEvents,
        maxTransactions: this.budgets.maxTransactions,
        maxFallbackTransactions: this.budgets.maxFallbackTransactions,
        reservedPrioritizedTransactions: this.budgets.reservedPrioritizedTransactions,
        ...(options.engineOptions ?? {}),
      });

    this.wsClient.setNotificationHandler((envelope) => {
      const p = this.engine.handleLogNotification(envelope);
      this.pendingNotificationPromises.push(p);

      // Progressively persist raw notification (safely halting if disk limit reached, B2-LAUNCH-02)
      if (this.evidenceRecorder && !this.isDiskExhausted) {
        try {
          const notifications = this.wsClient.getCapturedNotifications();
          while (this.recordedNotificationCount < notifications.length) {
            const rec = notifications[this.recordedNotificationCount];
            if (rec) this.evidenceRecorder.recordNotification(rec);
            this.recordedNotificationCount++;
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("DISK_BUDGET_EXCEEDED")) {
            this.isDiskExhausted = true;
            this.stopRequested = true;
            this.stopReason = `DISK_BUDGET_EXCEEDED: ${errMsg}`;
            this.onLog?.(`[DISK_LIMIT] Notification recording halted: ${errMsg}`);
          } else {
            throw err;
          }
        }
      }
    });
  }

  public getBudgets(): EventDiscoverySessionBudgets {
    return { ...this.budgets };
  }

  public requestStop(reason: string): void {
    this.stopRequested = true;
    this.stopReason = reason;
    this.onLog?.(`[SESSION_STOP_REQUESTED] Reason: ${reason}`);
  }

  private flushProgressiveEvidence(): void {
    if (!this.evidenceRecorder || this.isDiskExhausted) return;

    try {
      const txs = this.txFetcher.getCapturedTransactions();
      while (this.recordedTxCount < txs.length) {
        const rec = txs[this.recordedTxCount];
        if (rec) this.evidenceRecorder.recordTransaction(rec);
        this.recordedTxCount++;
      }

      const accs = this.accountFetcher.getCapturedInteractions();
      while (this.recordedAccCount < accs.length) {
        const rec = accs[this.recordedAccCount];
        if (rec) this.evidenceRecorder.recordAccount(rec);
        this.recordedAccCount++;
      }

      const events = this.engine.getDiscoveredEvents();
      while (this.recordedEventCount < events.length) {
        const ev = events[this.recordedEventCount];
        if (ev) this.evidenceRecorder.recordEvent(ev);
        this.recordedEventCount++;
      }

      const reports = this.engine.getVerificationReports();
      while (this.recordedReportCount < reports.length) {
        const rep = reports[this.recordedReportCount];
        if (rep) this.evidenceRecorder.recordReport(rep);
        this.recordedReportCount++;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("DISK_BUDGET_EXCEEDED")) {
        this.isDiskExhausted = true;
        this.stopRequested = true;
        this.stopReason = `DISK_BUDGET_EXCEEDED: ${errMsg}`;
        this.onLog?.(`[DISK_LIMIT] Progressive evidence flush halted: ${errMsg}`);
      } else {
        throw err;
      }
    }
  }

  /**
   * Executes a bounded prospective event discovery session.
   */
  public async runSession(): Promise<EventDiscoverySessionSummary> {
    this.isRunning = true;
    const startEpochMs = Date.now();
    const durationMs = this.budgets.durationSec * 1000;
    const deadlineEpochMs = startEpochMs + durationMs;
    const maxRssBytes = this.budgets.maxRssMb * 1024 * 1024;

    this.onLog?.(
      `Starting Event Discovery Session with budgets: duration=${this.budgets.durationSec}s, maxEvents=${this.budgets.maxEvents}, maxWsMessages=${this.budgets.maxWsMessages}, maxTx=${this.budgets.maxTransactions}, maxAcc=${this.budgets.maxAccountReads}, maxRpc=${this.budgets.maxTotalRpcCalls}, maxDisk=${this.budgets.maxDiskMb}MB`,
    );

    let sessionStatus: "FINALIZED" | "INTERRUPTED" | "FAILED" = this.stopRequested
      ? "INTERRUPTED"
      : "FINALIZED";
    let executionError: string | undefined = undefined;

    // B2-FINAL-04: Bounded WebSocket startup acknowledgment check.
    // Both AMM v4 and CPMM subscriptions must be acknowledged before classifying any observation.
    const startupTimeoutMs = Math.min(5000, Math.max(50, durationMs));
    const startupStartMs = Date.now();
    let startupAcknowledged = this.wsClient.hasBothSubscriptionsActive();

    while (!startupAcknowledged && Date.now() - startupStartMs < startupTimeoutMs) {
      if (this.stopRequested || this.wsClient.getStatus() === "DISCONNECTED") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      startupAcknowledged = this.wsClient.hasBothSubscriptionsActive();
    }

    if (!startupAcknowledged && !this.stopRequested) {
      const activeCount = this.wsClient.getMetrics().activeSubscriptionsCount;
      sessionStatus = "FAILED";
      executionError = `WS_SUBSCRIPTION_STARTUP_TIMEOUT: Expected 2 active subscriptions (AMM v4 and CPMM), got ${activeCount} within ${startupTimeoutMs}ms startup timeout`;
      this.stopReason = executionError;
      this.onLog?.(`[STARTUP_FAILURE] ${executionError}`);
      this.isRunning = false;
    }

    try {
      while (this.isRunning && !this.stopRequested && !this.isDiskExhausted) {
        const now = Date.now();

        // 1. Duration budget check (wall-clock deadline)
        if (now >= deadlineEpochMs) {
          this.stopReason = `DURATION_LIMIT_REACHED (${this.budgets.durationSec}s)`;
          break;
        }

        // 2. Discovered events ceiling check (B2-LAUNCH-03)
        const eventsCount = this.engine.getDiscoveredEvents().length;
        if (eventsCount >= this.budgets.maxEvents) {
          this.stopReason = `EVENTS_BUDGET_REACHED (${eventsCount}/${this.budgets.maxEvents})`;
          break;
        }

        // 3. WebSocket message ceiling check
        const wsMetrics = this.wsClient.getMetrics();
        if (wsMetrics.messagesReceived >= this.budgets.maxWsMessages) {
          const currentElapsedSec = Math.round((now - startEpochMs) / 1000);
          this.stopReason = `WS_MESSAGES_BUDGET_REACHED (${wsMetrics.messagesReceived}/${this.budgets.maxWsMessages}) after ${currentElapsedSec}s (coverage: ${currentElapsedSec}s / ${this.budgets.durationSec}s)`;
          break;
        }

        // 4. Health check: fail closed if WebSocket disconnected unexpectedly
        if (this.wsClient.getStatus() === "DISCONNECTED") {
          this.stopReason = "WS_DISCONNECTED_UNEXPECTEDLY";
          sessionStatus = "FAILED";
          break;
        }

        // 4. RPC Call budgets check
        const txCalls = this.txFetcher.getCallsExecutedCount();
        const accCalls = this.accountFetcher.getCallsExecutedCount();
        const totalRpc = txCalls + accCalls;

        if (txCalls >= this.budgets.maxTransactions) {
          this.stopReason = `TRANSACTIONS_BUDGET_REACHED (${txCalls}/${this.budgets.maxTransactions})`;
          break;
        }
        if (accCalls >= this.budgets.maxAccountReads) {
          this.stopReason = `ACCOUNT_READS_BUDGET_REACHED (${accCalls}/${this.budgets.maxAccountReads})`;
          break;
        }
        if (totalRpc >= this.budgets.maxTotalRpcCalls) {
          this.stopReason = `TOTAL_RPC_BUDGET_REACHED (${totalRpc}/${this.budgets.maxTotalRpcCalls})`;
          break;
        }

        // 5. Memory watchdog check
        const mem = process.memoryUsage();
        if (mem.rss > maxRssBytes) {
          this.stopReason = `RSS_MEMORY_LIMIT_EXCEEDED (${Math.round(mem.rss / 1024 / 1024)}MB > ${this.budgets.maxRssMb}MB)`;
          sessionStatus = "INTERRUPTED";
          break;
        }

        // 6. Await in-flight notification handling
        if (this.pendingNotificationPromises.length > 0) {
          const promises = this.pendingNotificationPromises.splice(0);
          await Promise.all(promises);
        }

        if (this.isDiskExhausted) {
          break;
        }

        // 7. Drain pending queued transactions and retry pending verifications with wall-clock deadline (B2-GO-02)
        const pendingQueueLength = this.engine.getQueueLength();
        const pendingVerificationsCount = this.engine.getPendingVerificationsCount();
        if (pendingQueueLength > 0 || pendingVerificationsCount > 0) {
          await this.engine.processQueue(this.txFetcher, this.accountFetcher, { deadlineEpochMs });
          if (!this.isDiskExhausted) {
            this.flushProgressiveEvidence();
          }
        } else {
          // Micro-tick pause when queue is empty to yield event loop
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } catch (err) {
      executionError = err instanceof Error ? err.message : String(err);
      if (executionError.includes("DISK_BUDGET_EXCEEDED")) {
        this.isDiskExhausted = true;
        sessionStatus = "INTERRUPTED";
        this.stopReason = `DISK_BUDGET_EXCEEDED: ${executionError}`;
      } else {
        sessionStatus = "FAILED";
        this.stopReason = `EXECUTION_ERROR: ${executionError}`;
      }
      this.onLog?.(`[SESSION_ERROR] ${executionError}`);
    } finally {
      this.isRunning = false;
      this.wsClient.close();
    }

    if (this.isDiskExhausted && sessionStatus === "FINALIZED") {
      sessionStatus = "INTERRUPTED";
    }

    if (this.stopRequested && sessionStatus === "FINALIZED") {
      sessionStatus = "INTERRUPTED";
    }

    // Zero-event session must not be finalized if subscriptions were never acknowledged
    if (sessionStatus === "FINALIZED" && !startupAcknowledged) {
      sessionStatus = "FAILED";
      this.stopReason = "WS_SUBSCRIPTIONS_UNACKNOWLEDGED";
    }

    // Flush remaining in-flight records only if disk is not exhausted (B2-LAUNCH-02)
    if (!this.isDiskExhausted) {
      this.flushProgressiveEvidence();
    }

    const elapsedSec = (Date.now() - startEpochMs) / 1000;
    const metrics = this.engine.getMetricsSnapshot();
    const discoveredEvents = this.engine.getDiscoveredEvents();
    const verificationReports = this.engine.getVerificationReports();

    const txCalls = this.txFetcher.getCallsExecutedCount();
    const accCalls = this.accountFetcher.getCallsExecutedCount();
    const totalRpc = txCalls + accCalls;

    // Auditable Accounting (B2-READY-05)
    const verifiedCoherentCount = verificationReports.filter(
      (r: VerificationDispatchResult) => r.verified,
    ).length;
    const rejectedCount = verificationReports.filter(
      (r: VerificationDispatchResult) => !r.verified,
    ).length;
    const unresolvedCount =
      metrics.rawLogNotificationsReceived -
      (metrics.uniqueTransactionsEncountered - metrics.transactionFetchFailures) +
      (metrics.pendingVerificationsCount ?? 0);

    let manifest: B2SnapshotManifest | undefined = undefined;
    let manifestVerified: boolean | undefined = undefined;
    let sessionDir: string | undefined = undefined;

    // Evidence Capture & Sealing via ProgressiveEvidenceRecorder
    if (this.evidenceRecorder) {
      sessionDir = this.evidenceRecorder.getSessionDir();
      try {
        const sealResult = this.evidenceRecorder.finalize({
          status: sessionStatus,
          wsUrl: this.wsClient.getSanitizedUrl(),
          rpcUrl: this.txFetcher.getSanitizedEndpoint(),
          endpointHost: this.txFetcher.getEndpointHost(),
          endpointFingerprint: this.txFetcher.getEndpointFingerprint(),
          commitment: "confirmed",
          maxEventsBudget: this.budgets.maxEvents,
          maxTransactionsBudget: this.budgets.maxTransactions,
          totalPoolsVerified: verifiedCoherentCount,
          error: executionError,
          metrics,
        });

        manifest = sealResult.manifest;

        // Replay-verify manifest immediately to confirm mathematical integrity
        try {
          const verifyResult = verifyB2SessionManifest(sessionDir);
          manifestVerified = verifyResult.valid;
        } catch (err) {
          manifestVerified = false;
          this.onLog?.(`Manifest verification failed: ${err}`);
        }
      } catch (sealErr: unknown) {
        manifestVerified = false;
        const msg = sealErr instanceof Error ? sealErr.message : String(sealErr);
        this.onLog?.(`Evidence sealing failed: ${msg}`);
      }
    }

    return {
      sessionId: manifest?.sessionId ?? `b2-events-session-${startEpochMs}`,
      sessionDir,
      status: sessionStatus,
      stopReason: this.stopReason,
      elapsedSec,
      budgets: {
        durationSec: this.budgets.durationSec,
        maxEvents: this.budgets.maxEvents,
        maxWsMessages: this.budgets.maxWsMessages,
        maxTransactions: this.budgets.maxTransactions,
        maxAccountReads: this.budgets.maxAccountReads,
        maxTotalRpcCalls: this.budgets.maxTotalRpcCalls,
        maxFallbackTransactions: this.budgets.maxFallbackTransactions,
        reservedPrioritizedTransactions: this.budgets.reservedPrioritizedTransactions,
      },
      accounting: {
        rawNotificationsReceived: metrics.rawLogNotificationsReceived,
        transactionsFetched: metrics.uniqueTransactionsEncountered,
        poolInitializationsDecoded: metrics.successfulInitDecodes,
        uniquePoolsDiscovered: metrics.candidatePoolsDiscovered,
        poolsVerifiedCoherent: verifiedCoherentCount,
        poolsRejected: rejectedCount,
        unresolvedObservations: Math.max(0, unresolvedCount),
        prioritizedTransactionsFetched: metrics.prioritizedTransactionsExecuted ?? 0,
        fallbackTransactionsFetched: metrics.fallbackTransactionsExecuted ?? 0,
        unusedReservedTransactionsBudget: metrics.unusedReservedCalls ?? 0,
        remainingUnfetchedSignatures:
          metrics.remainingUnfetchedSignatures ?? this.engine.getQueueLength(),
      },
      rpcCallsExecuted: {
        transactionFetches: txCalls,
        accountReads: accCalls,
        totalRpcCalls: totalRpc,
      },
      verificationReports,
      discoveredEvents,
      metrics,
      manifest,
      manifestVerified,
    };
  }
}
