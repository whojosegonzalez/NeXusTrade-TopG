/**
 * NeXusTrade — Isolated PAPER rolling candidate flow provider (offline implementation; NOT installed).
 *
 * Supplies fresh, candidate-bound PAPER flow for ONE fixed pool/mint through the existing synchronous
 * CandidateFlowProvider.getCandidateFlow(target, T) interface, reusing the accepted subscription coordinator,
 * transaction source adapter, rolling tracker, history enumerator, window reconciliation evaluator and
 * PAPER reconciled flow adapter (§8.28 / §8.29 of the D.3.3 readiness assessment).
 *
 * SAFETY INVARIANTS:
 * 1. Inert import and construction: no I/O, timers, sockets or requests until start(signal) is called.
 * 2. Reads are pure: getCandidateFlow performs no requests, timers, promises or collection-state mutation.
 *    Freshness is re-derived at each read from the ORIGINAL cutoff by the existing PAPER adapter; snapshots
 *    are never re-stamped.
 * 3. Contradicted evidence is withdrawn immediately (never served until expiry, no fallback to an affected
 *    snapshot): any unaccounted stream notification (its block time is unknown, so it cannot be excluded from
 *    a published window), any newly recorded gap, any unresolved retrieval, any history signature that the
 *    existing slot/window rules cannot exclude, and any disconnect, missing pong or epoch change.
 *    Withdrawal marks availability only; the frozen reconciliation results are never rewritten.
 * 4. One serialized Solana RPC dispatcher: at least `rpcPacingMs` (>= 2,500 ms) between dispatches, never
 *    overlapping, every actual dispatch counted exactly once (session ledger and shared budget alike), and
 *    refused once the session ceiling, retrieval ceiling, lifetime deadline, a 429 or a stop is reached.
 *    Admission by the adapter or enumerator is checked but never counted as a dispatch. No counter resets.
 * 5. Absolute lifetime measured from start(), including setup and reconnects; never extended. A deadline
 *    timer stops collection at expiry even while a subscription ack, pacing wait, request or body read is
 *    pending; every wait is capped at the deadline.
 * 6. Keepalive is timer-driven: a missing pong withdraws snapshots and aborts in-flight epoch work at the
 *    pong timeout, independent of any pending RPC.
 * 7. HTTP responses: the first 429 is terminal (recognised from headers, before any body read); redirects are
 *    rejected without being followed (terminal); bodies are read with a finite decoded-byte ceiling and
 *    cancelled on overflow, timeout or stop. No automatic retries.
 * 8. All limits are supplied explicitly by the caller. No defaults are approved for live execution.
 */

import {
  RAYDIUM_AMM_V4_LAYOUT_LENGTH,
  WSOL_MINT,
  parseRaydiumAmmV4Account,
} from "../research/pilot/RaydiumAmmParser.js";
import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import {
  RaydiumCandidateSubscriptionCoordinator,
  type SubscriptionCoordinatorStatus,
} from "./RaydiumCandidateSubscriptionCoordinator.js";
import {
  RaydiumAmmV4TransactionSourceAdapter,
  type ProcessNotificationResult,
} from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import {
  ExactPoolHistoryEnumerator,
  isValidSolanaSignature,
  type HistoryPageQueryParams,
  type HistorySignatureRecord,
} from "./ExactPoolHistoryEnumerator.js";
import {
  evaluateExactPoolWindowReconciliation,
  type SourceCutoffEvidence,
  type WindowReconciliationResult,
} from "./ExactPoolWindowReconciliationEvaluator.js";
import { PaperReconciledCandidateFlowAdapter } from "./PaperReconciledCandidateFlowAdapter.js";
import type {
  CandidateFlowProvider,
  CandidateFlowResult,
  CandidateFlowTarget,
} from "./CandidateFlowProvider.js";
import { buildStreamResolutionRecords } from "./CandidateDecisionDiagnostic.js";
import {
  PaperRequestSession,
  type PaperRequestLedgerEntry,
  type PaperSessionDispatchBudget,
} from "./PaperRequestSession.js";
import type { ISolanaKeepaliveWebSocketTransport } from "./RaydiumTransportObservationProbe.js";

/** Fixed (not configurable) rules reused unchanged from the accepted diagnostic and evaluator. */
export const PAPER_ROLLING_FLOW_FIXED_RULES = Object.freeze({
  /** First GET_SLOT of each epoch is not dispatched before subscription confirmation + this nominal warm-up. */
  nominalWarmUpMs: 65_000,
  /** Unchanged cutoff freshness limit applied by the PAPER adapter and validator at every read. */
  maxEvidenceAgeMs: 15_000,
  windowMs: 60_000,
  minRpcPacingMs: 2_500,
  historyPageSize: 20,
  historyMaxPages: 1,
  maxSnapshotsRetained: 2,
  idleStepMs: 250,
  ackPollMs: 50,
});

const PROVIDER_NAME = "SOLANA_RPC";

/** Requests that belong to an established subscription epoch (aborted when the epoch is lost). */
const EPOCH_SCOPED_PURPOSES: ReadonlySet<string> = new Set([
  "GET_SLOT",
  "GET_BLOCK_TIME",
  "HISTORY_ENUMERATION",
  "TRANSACTION_RETRIEVAL",
]);

/** Refusals that end collection instead of being retried. */
const TERMINAL_REFUSALS: ReadonlySet<string> = new Set([
  "LIFETIME_EXPIRED",
  "HTTP_ATTEMPT_CEILING_REACHED",
  "TRANSACTION_RETRIEVAL_CEILING_REACHED",
  "BUDGET_MANAGER_DENIED",
  // A stopped or unopened shared session ends collection instead of being retried.
  "REQUEST_SESSION_STOPPED",
  "REQUEST_SESSION_NOT_OPEN",
]);

/**
 * Explicit collection limits. Every field is mandatory; no default is approved for live execution.
 */
export interface PaperRollingFlowLimits {
  /** Absolute lifetime from start(), including setup and reconnects. Never extended. */
  readonly lifetimeMs: number;
  /** Shared ceiling of Solana RPC HTTP attempts (all purposes). */
  readonly maxHttpAttempts: number;
  /** Shared ceiling of stream notifications (coordinator closes the subscription beyond it). */
  readonly maxNotifications: number;
  /** Shared ceiling of transaction retrievals. */
  readonly maxTransactionRetrievals: number;
  readonly maxReconnects: number;
  /** Retrievals allowed in one cycle before its refresh; beyond it the refresh is skipped. */
  readonly maxRetrievalsPerCycle: number;
  /** Adapter queue/workload ceiling (overflow is recorded as capacity loss). */
  readonly queueCeiling: number;
  /** Minimum dispatch-to-dispatch spacing for Solana RPC (>= 2,500 ms). */
  readonly rpcPacingMs: number;
  /** Per-request timeout (headers and body together). */
  readonly requestTimeoutMs: number;
  /** Decoded response-body ceiling per request (bytes). */
  readonly maxResponseBytes: number;
  readonly subscriptionAckTimeoutMs: number;
  readonly keepalivePingIntervalMs: number;
  readonly keepalivePongTimeoutMs: number;
  readonly maxKeepalivePings: number;
  /** Incoming WebSocket data messages (acks, notifications, anything else) per session. */
  readonly maxWsMessages: number;
  /** Incoming WebSocket data-message bytes per session. */
  readonly maxWsMessageBytes: number;
  /** Incoming control frames (pongs and server pings) per session. */
  readonly maxWsControlFrames: number;
}

/** Injectable timer scheduler (deterministic virtual timers in offline tests; global timers by default). */
export interface PaperRollingFlowTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMERS: PaperRollingFlowTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PaperRollingCandidateFlowProviderOptions {
  readonly target: CandidateFlowTarget;
  readonly executionContext: "PAPER_SIMULATION";
  readonly rpcUrl: string;
  /**
   * Injected HTTP transport for a provider-private request session. Exactly one of fetchFn and
   * requestSession is required; there is no default networking.
   */
  readonly fetchFn?: typeof fetch | undefined;
  /**
   * Shared request session (one HTTP-attempt ceiling, ledger and Solana pacing with other owners,
   * such as the security-evidence loader). The session's owner opens and stops it.
   */
  readonly requestSession?: PaperRequestSession | undefined;
  /** Injected WebSocket transport factory (one call per epoch). Mandatory; no default networking. */
  readonly createWebSocketTransport: () => ISolanaKeepaliveWebSocketTransport;
  readonly limits: PaperRollingFlowLimits;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRollingFlowTimers | undefined;
}

export type PaperRollingFlowRequestPurpose =
  | "POOL_LAYOUT"
  | "PRIOR_ANCHOR"
  | "GET_SLOT"
  | "GET_BLOCK_TIME"
  | "HISTORY_ENUMERATION"
  | "TRANSACTION_RETRIEVAL";

export interface PaperRollingFlowLedgerEntry {
  /** Provider-local sequence (contiguous over this provider's own dispatches). */
  readonly seq: number;
  /** Sequence in the request session's ledger (equal to seq for a private session). */
  readonly sessionSeq: number;
  readonly purpose: PaperRollingFlowRequestPurpose;
  readonly epoch: number;
  readonly dispatchedAtMs: number;
  readonly completedAtMs: number | null;
  readonly httpStatus: number | null;
  readonly error: string | null;
}

export type PaperRollingFlowState = "NOT_STARTED" | "RUNNING" | "STOPPED";

export interface PaperRollingFlowSnapshotSummary {
  readonly id: number;
  readonly epoch: number;
  readonly qualificationKind: "QUIET_WINDOW" | "ACTIVE_WINDOW";
  readonly publishedAtMs: number;
  readonly cutoffSlot: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly recentBuys60s: number;
  readonly recentSells60s: number;
  readonly withdrawnReason: string | null;
  readonly withdrawnAtMs: number | null;
}

export interface PaperRollingFlowCycleRecord {
  readonly cycle: number;
  readonly epoch: number;
  readonly outcome: string;
  readonly retrievals: number;
  readonly endedAtMs: number;
  readonly getSlotDispatchedAtMs: number | null;
  readonly cutoffTimestampMs: number | null;
  readonly snapshotId: number | null;
}

export interface PaperRollingFlowStatus {
  readonly state: PaperRollingFlowState;
  readonly stopReason: string | null;
  readonly startedAtMs: number | null;
  readonly deadlineMs: number | null;
  readonly stoppedAtMs: number | null;
  readonly currentEpoch: number | null;
  readonly observationStartMs: number | null;
  readonly epochEstablished: boolean;
  readonly reconnects: number;
  /** This provider's own dispatches. */
  readonly httpAttempts: number;
  /** Every dispatch in the request session (equal to httpAttempts for a private session). */
  readonly sessionHttpAttempts: number;
  readonly transactionRetrievals: number;
  readonly notificationsReceived: number;
  readonly budgetManagerAttempts: number;
  readonly maxConcurrentRpc: number;
  readonly activeTimers: number;
  readonly cycles: number;
  readonly refreshesAttempted: number;
  readonly refreshesPublished: number;
  readonly refreshesSkipped: number;
  readonly keepalive: {
    readonly pingsSent: number;
    readonly matchedPongs: number;
    readonly unmatchedPongs: number;
  };
  readonly ws: {
    readonly messages: number;
    readonly messageBytes: number;
    readonly controlFrames: number;
  };
  readonly ledger: readonly PaperRollingFlowLedgerEntry[];
  readonly snapshots: readonly PaperRollingFlowSnapshotSummary[];
  readonly cycleLog: readonly PaperRollingFlowCycleRecord[];
}

export interface PaperRollingFlowStopReport {
  readonly stopReason: string;
  readonly status: PaperRollingFlowStatus;
}

/**
 * The budget is the request session's (one per session): the adapter and history enumerator call
 * recordRequestAttempt() for ADMISSION only (never counted); the session counts each ACTUAL dispatch
 * exactly once. Re-exported under the accepted name; the shared GlobalResourceBudgetManager class is
 * unchanged for other callers.
 */
export { PaperSessionDispatchBudget as PaperRollingDispatchBudget } from "./PaperRequestSession.js";

interface PublishedSnapshot {
  readonly id: number;
  readonly epoch: number;
  readonly result: WindowReconciliationResult;
  readonly qualificationKind: "QUIET_WINDOW" | "ACTIVE_WINDOW";
  readonly publishedAtMs: number;
  readonly cutoffSlot: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  /** Every signature in the snapshot's history page (anchor included). */
  readonly accountedSignatures: ReadonlySet<string>;
}

/** This provider's dispatch: the session's (live-updated) ledger entry plus its epoch. */
interface FlowDispatchRecord {
  readonly entry: PaperRequestLedgerEntry;
  readonly epoch: number;
}

interface RpcExchange {
  readonly dispatched: boolean;
  readonly ok: boolean;
  readonly status?: number | undefined;
  readonly text?: string | undefined;
  readonly error?: string | undefined;
}

type RpcCallResult =
  | { readonly ok: true; readonly result: unknown; readonly json: unknown }
  | { readonly ok: false; readonly dispatched: boolean; readonly error: string };

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  const obj = value as unknown as object;
  if (seen.has(obj)) return value;
  seen.add(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key], seen);
  }
  Object.freeze(obj);
  return value;
}

function isPositiveSafeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function parseJson(text: string | undefined): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

/** Validates explicit limits; throws `[PAPER_FLOW_PROVIDER_INIT]` on any invalid or unsafe value. */
export function validatePaperRollingFlowLimits(limits: unknown): PaperRollingFlowLimits {
  if (!limits || typeof limits !== "object") {
    throw new Error("[PAPER_FLOW_PROVIDER_INIT] limits are mandatory");
  }
  const l = limits as Record<string, unknown>;
  const keys: readonly (keyof PaperRollingFlowLimits)[] = [
    "lifetimeMs",
    "maxHttpAttempts",
    "maxNotifications",
    "maxTransactionRetrievals",
    "maxReconnects",
    "maxRetrievalsPerCycle",
    "queueCeiling",
    "rpcPacingMs",
    "requestTimeoutMs",
    "maxResponseBytes",
    "subscriptionAckTimeoutMs",
    "keepalivePingIntervalMs",
    "keepalivePongTimeoutMs",
    "maxKeepalivePings",
    "maxWsMessages",
    "maxWsMessageBytes",
    "maxWsControlFrames",
  ];
  for (const k of keys) {
    const v = l[k];
    const allowZero = k === "maxReconnects";
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || (!allowZero && v === 0)) {
      throw new Error(`[PAPER_FLOW_PROVIDER_INIT] limits.${k} must be a finite safe integer`);
    }
  }
  const typed = limits as PaperRollingFlowLimits;
  if (typed.rpcPacingMs < PAPER_ROLLING_FLOW_FIXED_RULES.minRpcPacingMs) {
    throw new Error("[PAPER_FLOW_PROVIDER_INIT] limits.rpcPacingMs must be at least 2500 ms");
  }
  if (typed.lifetimeMs <= PAPER_ROLLING_FLOW_FIXED_RULES.nominalWarmUpMs) {
    throw new Error(
      "[PAPER_FLOW_PROVIDER_INIT] limits.lifetimeMs must exceed the 65,000 ms warm-up",
    );
  }
  if (typed.keepalivePongTimeoutMs >= typed.keepalivePingIntervalMs) {
    throw new Error(
      "[PAPER_FLOW_PROVIDER_INIT] limits.keepalivePongTimeoutMs must be below the ping interval",
    );
  }
  if (typed.maxTransactionRetrievals > typed.maxHttpAttempts) {
    throw new Error(
      "[PAPER_FLOW_PROVIDER_INIT] limits.maxTransactionRetrievals cannot exceed maxHttpAttempts",
    );
  }
  return Object.freeze({ ...typed });
}

/**
 * Rolling PAPER flow provider for one fixed candidate pool and mint.
 */
export class PaperRollingCandidateFlowProvider implements CandidateFlowProvider {
  private readonly target: CandidateFlowTarget;
  private readonly rpcUrl: string;
  private readonly session: PaperRequestSession;
  private readonly ownsSession: boolean;
  private readonly createWebSocketTransport: () => ISolanaKeepaliveWebSocketTransport;
  private readonly limits: PaperRollingFlowLimits;
  private readonly clock: () => number;
  private readonly timers: PaperRollingFlowTimers;
  private readonly paperAdapter = new PaperReconciledCandidateFlowAdapter();
  private readonly activeTimers = new Set<unknown>();

  // Lifecycle
  private state: PaperRollingFlowState = "NOT_STARTED";
  private stopReason: string | null = null;
  private startedAtMs: number | null = null;
  private deadlineMs: number | null = null;
  private stoppedAtMs: number | null = null;
  private sessionAbort: AbortController | null = null;
  private externalSignal: AbortSignal | undefined;
  private externalAbortListener: (() => void) | undefined;

  // Components (created during start)
  private poolContext: TrackedRaydiumPoolContext | null = null;
  private readonly budgetManager: PaperSessionDispatchBudget;
  private tracker: RollingTradeFlowTracker | null = null;
  private adapter: RaydiumAmmV4TransactionSourceAdapter | null = null;
  private coordinator: RaydiumCandidateSubscriptionCoordinator | null = null;

  // Dispatch accounting (the request session is authoritative; this is the provider's own share)
  private readonly ledger: FlowDispatchRecord[] = [];
  private transactionRetrievals = 0;

  // Epoch
  private currentEpoch: number | null = null;
  private epochEstablished = false;
  private epochAbort: AbortController | null = null;
  private reconnects = 0;
  private observationStartMs = 0;
  private firstRefreshNotBeforeMs = 0;
  private anchorRecord: HistorySignatureRecord | null = null;
  private lastHistoryRecords: HistorySignatureRecord[] = [];
  private epochStreamResults: ProcessNotificationResult[] = [];
  private readonly txIdentityBySignature = new Map<
    string,
    { readonly slot: number; readonly blockTime: number | null }
  >();
  private readonly notificationEpochBySignature = new Map<string, number>();
  private notificationSeq = 0;
  private transportSeq = 0;
  private currentTransport: ISolanaKeepaliveWebSocketTransport | null = null;

  // Gaps
  private knownGapKeys = new Set<string>();
  private gapVersion = 0;

  // Keepalive and WebSocket limits
  private pingsSent = 0;
  private matchedPongs = 0;
  private unmatchedPongs = 0;
  private outstandingPing: { readonly payload: Buffer; readonly sentAtMs: number } | null = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  private wsMessages = 0;
  private wsMessageBytes = 0;
  private wsControlFrames = 0;

  // Snapshots and cycles
  private snapshots: PublishedSnapshot[] = [];
  private readonly withdrawals = new Map<number, { reason: string; atMs: number }>();
  private snapshotSeq = 0;
  private cycles = 0;
  private refreshesAttempted = 0;
  private refreshesPublished = 0;
  private refreshesSkipped = 0;
  private readonly cycleLog: PaperRollingFlowCycleRecord[] = [];

  constructor(options: PaperRollingCandidateFlowProviderOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("[PAPER_FLOW_PROVIDER_INIT] options are mandatory");
    }
    const t = options.target;
    if (
      !t ||
      typeof t.poolAddress !== "string" ||
      typeof t.tokenMint !== "string" ||
      t.poolAddress.trim() !== t.poolAddress ||
      t.tokenMint.trim() !== t.tokenMint ||
      t.poolAddress.length === 0 ||
      t.tokenMint.length === 0
    ) {
      throw new Error("[PAPER_FLOW_PROVIDER_INIT] target must name one exact pool and mint");
    }
    if (options.executionContext !== "PAPER_SIMULATION") {
      throw new Error("[PAPER_FLOW_PROVIDER_INIT] executionContext must be PAPER_SIMULATION");
    }
    if (typeof options.rpcUrl !== "string" || options.rpcUrl.length === 0) {
      throw new Error("[PAPER_FLOW_PROVIDER_INIT] rpcUrl is mandatory");
    }
    const shared = options.requestSession;
    if (shared !== undefined) {
      if (!(shared instanceof PaperRequestSession)) {
        throw new Error("[PAPER_FLOW_PROVIDER_INIT] requestSession must be a PaperRequestSession");
      }
      if (options.fetchFn !== undefined) {
        throw new Error(
          "[PAPER_FLOW_PROVIDER_INIT] supply either fetchFn or requestSession, not both",
        );
      }
    } else if (typeof options.fetchFn !== "function") {
      throw new Error("[PAPER_FLOW_PROVIDER_INIT] fetchFn is mandatory (no default networking)");
    }
    if (typeof options.createWebSocketTransport !== "function") {
      throw new Error(
        "[PAPER_FLOW_PROVIDER_INIT] createWebSocketTransport is mandatory (no default networking)",
      );
    }
    this.target = Object.freeze({ poolAddress: t.poolAddress, tokenMint: t.tokenMint });
    this.rpcUrl = options.rpcUrl;
    this.createWebSocketTransport = options.createWebSocketTransport;
    this.limits = validatePaperRollingFlowLimits(options.limits);
    this.clock = options.clock ?? (() => Date.now());
    this.timers = options.timers ?? DEFAULT_TIMERS;
    if (shared !== undefined) {
      if (shared.limits.lanes.SOLANA_RPC.pacingMs < this.limits.rpcPacingMs) {
        throw new Error(
          "[PAPER_FLOW_PROVIDER_INIT] the shared session's Solana pacing is below limits.rpcPacingMs",
        );
      }
      this.session = shared;
      this.ownsSession = false;
    } else {
      // Private session: the provider's own limits, Solana lane only (other lanes disabled).
      const lane = (maxAttempts: number) => ({
        maxAttempts,
        pacingMs: this.limits.rpcPacingMs,
        maxResponseBytes: this.limits.maxResponseBytes,
      });
      this.session = new PaperRequestSession({
        executionContext: "PAPER_SIMULATION",
        fetchFn: options.fetchFn!,
        limits: {
          lifetimeMs: this.limits.lifetimeMs,
          maxHttpAttempts: this.limits.maxHttpAttempts,
          requestTimeoutMs: this.limits.requestTimeoutMs,
          lanes: {
            SOLANA_RPC: lane(this.limits.maxHttpAttempts),
            RUGCHECK: lane(0),
            SOLANA_TRACKER: lane(0),
            DEXSCREENER: lane(0),
          },
        },
        clock: this.clock,
        timers: this.timers,
      });
      this.ownsSession = true;
    }
    this.budgetManager = this.session.budget;
  }

  // ===========================================================================================
  // Synchronous read path (pure: no requests, timers, promises or collection-state mutation)
  // ===========================================================================================

  public getCandidateFlow(
    target: CandidateFlowTarget,
    evaluationTimestampMs: number,
  ): CandidateFlowResult {
    const unavailable = (reason: string): CandidateFlowResult =>
      Object.freeze({
        poolAddress: typeof target?.poolAddress === "string" ? target.poolAddress : "",
        tokenMint: typeof target?.tokenMint === "string" ? target.tokenMint : "",
        recentBuys60s: null,
        recentSells60s: null,
        flowCoverage: "COLLECTION_GAP",
        isCoverageSufficient: false,
        diagnosticReason: reason,
        evaluationTimestampMs,
      });

    if (
      !target ||
      target.poolAddress !== this.target.poolAddress ||
      target.tokenMint !== this.target.tokenMint
    ) {
      return unavailable(
        "PAPER_ROLLING_FLOW_IDENTITY_MISMATCH: provider is bound to a different pool or mint",
      );
    }
    if (!Number.isSafeInteger(evaluationTimestampMs) || evaluationTimestampMs <= 0) {
      return unavailable("PAPER_ROLLING_FLOW_INVALID_EVALUATION_TIMESTAMP");
    }
    if (this.state === "NOT_STARTED") return unavailable("PAPER_ROLLING_FLOW_NOT_STARTED");
    if (this.state === "STOPPED" || this.stopReason !== null) {
      return unavailable(`PAPER_ROLLING_FLOW_STOPPED: ${this.stopReason ?? "UNKNOWN"}`);
    }

    // Newest snapshot published at or before T (a snapshot published after T is never used).
    let selected: PublishedSnapshot | undefined;
    for (const s of this.snapshots) {
      if (s.publishedAtMs <= evaluationTimestampMs) {
        if (!selected || s.publishedAtMs > selected.publishedAtMs) selected = s;
      }
    }
    if (!selected) {
      return unavailable(
        this.snapshotSeq === 0
          ? "PAPER_ROLLING_FLOW_WARMING_UP: no snapshot published yet"
          : "PAPER_ROLLING_FLOW_NO_PUBLISHED_SNAPSHOT_AT_EVALUATION_TIME",
      );
    }
    const withdrawn = this.withdrawals.get(selected.id);
    if (withdrawn) {
      // No fallback to another snapshot: the newest eligible evidence was contradicted.
      return unavailable(`PAPER_ROLLING_FLOW_SNAPSHOT_WITHDRAWN: ${withdrawn.reason}`);
    }
    return this.paperAdapter.convertCandidateFlow(selected.result, target, evaluationTimestampMs, {
      executionContext: "PAPER_SIMULATION",
      maxAllowedEvidenceAgeMs: PAPER_ROLLING_FLOW_FIXED_RULES.maxEvidenceAgeMs,
      allowActiveWindowQualification: true,
    });
  }

  /** Read-only status copy (no side effects). */
  public getStatus(): PaperRollingFlowStatus {
    return deepFreeze({
      state: this.state,
      stopReason: this.stopReason,
      startedAtMs: this.startedAtMs,
      deadlineMs: this.deadlineMs,
      stoppedAtMs: this.stoppedAtMs,
      currentEpoch: this.currentEpoch,
      observationStartMs: this.currentEpoch === null ? null : this.observationStartMs,
      epochEstablished: this.epochEstablished,
      reconnects: this.reconnects,
      httpAttempts: this.ledger.length,
      sessionHttpAttempts: this.session.getStatus().httpAttempts,
      transactionRetrievals: this.transactionRetrievals,
      notificationsReceived: this.coordinator?.getMetrics().totalNotificationsReceived ?? 0,
      budgetManagerAttempts: this.budgetManager.getTotalRequests(),
      maxConcurrentRpc: this.session.getMaxConcurrent("SOLANA_RPC"),
      activeTimers:
        this.activeTimers.size + (this.ownsSession ? this.session.getActiveTimerCount() : 0),
      cycles: this.cycles,
      refreshesAttempted: this.refreshesAttempted,
      refreshesPublished: this.refreshesPublished,
      refreshesSkipped: this.refreshesSkipped,
      keepalive: {
        pingsSent: this.pingsSent,
        matchedPongs: this.matchedPongs,
        unmatchedPongs: this.unmatchedPongs,
      },
      ws: {
        messages: this.wsMessages,
        messageBytes: this.wsMessageBytes,
        controlFrames: this.wsControlFrames,
      },
      ledger: this.ledger.map((r, i) => ({
        seq: i + 1,
        sessionSeq: r.entry.seq,
        purpose: r.entry.purpose as PaperRollingFlowRequestPurpose,
        epoch: r.epoch,
        dispatchedAtMs: r.entry.dispatchedAtMs,
        completedAtMs: r.entry.completedAtMs,
        httpStatus: r.entry.httpStatus,
        error: r.entry.error,
      })),
      snapshots: this.snapshots.map((s) => this.summarize(s)),
      cycleLog: this.cycleLog.map((c) => ({ ...c })),
    });
  }

  /** The frozen reconciliation result behind a retained snapshot (immutable; for inspection only). */
  public getSnapshotResult(id: number): WindowReconciliationResult | undefined {
    return this.snapshots.find((s) => s.id === id)?.result;
  }

  // ===========================================================================================
  // Timers and bounded waits
  // ===========================================================================================

  private setTimer(fn: () => void, ms: number): unknown {
    let handle: unknown = null;
    handle = this.timers.setTimeout(
      () => {
        this.activeTimers.delete(handle);
        fn();
      },
      Math.max(0, ms),
    );
    this.activeTimers.add(handle);
    return handle;
  }

  private clearTimer(handle: unknown): void {
    if (handle === null || handle === undefined) return;
    if (this.activeTimers.delete(handle)) this.timers.clearTimeout(handle);
  }

  /** Waits at most `ms`, never past the lifetime deadline; resolves early on stop or `signal`. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const session = this.sessionAbort?.signal;
    const remaining =
      this.deadlineMs === null ? ms : Math.max(0, Math.min(ms, this.deadlineMs - this.clock()));
    return new Promise<void>((resolve) => {
      if (session?.aborted || signal?.aborted) {
        resolve();
        return;
      }
      let handle: unknown = null;
      const done = () => {
        this.clearTimer(handle);
        session?.removeEventListener("abort", done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      handle = this.setTimer(done, remaining);
      session?.addEventListener("abort", done, { once: true });
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Signal that aborts on stop, deadline or loss of the current epoch. */
  private epochSignal(): AbortSignal {
    const signals = [this.sessionAbort!.signal];
    if (this.epochAbort) signals.push(this.epochAbort.signal);
    return AbortSignal.any(signals);
  }

  // ===========================================================================================
  // Lifecycle
  // ===========================================================================================

  /** Starts collection. May be called once; resolves with the stop report when collection ends. */
  public start(signal?: AbortSignal): Promise<PaperRollingFlowStopReport> {
    if (this.state !== "NOT_STARTED") {
      return Promise.reject(new Error("[PAPER_FLOW_PROVIDER] start() may be called only once"));
    }
    this.state = "RUNNING";
    this.startedAtMs = this.clock();
    this.deadlineMs = this.startedAtMs + this.limits.lifetimeMs;
    this.sessionAbort = new AbortController();
    if (this.ownsSession) this.session.open();
    // Absolute deadline: fires even while an ack wait, pacing wait, request or body read is pending.
    this.setTimer(() => this.requestStop("LIFETIME_EXPIRED"), this.limits.lifetimeMs);
    if (signal) {
      this.externalSignal = signal;
      if (signal.aborted) {
        this.requestStop("EXTERNAL_ABORT");
      } else {
        this.externalAbortListener = () => this.requestStop("EXTERNAL_ABORT");
        signal.addEventListener("abort", this.externalAbortListener, { once: true });
      }
    }
    // A stopped session (429, redirect, shared ceiling, session deadline) stops collection.
    if (!this.ownsSession && this.session.getStatus().state === "NOT_OPEN") {
      this.requestStop("REQUEST_SESSION_NOT_OPEN");
    }
    this.session.onStop((reason) => this.requestStop(reason));
    return this.run();
  }

  /** Stops collection: cancels pacing waits and in-flight requests and withdraws every snapshot. */
  public stop(reason = "STOP_REQUESTED"): void {
    if (this.state === "NOT_STARTED") {
      this.state = "STOPPED";
      this.stopReason = reason;
      this.stoppedAtMs = this.clock();
      return;
    }
    this.requestStop(reason);
  }

  /** First stop cause wins; snapshots are withdrawn and all pending work is aborted immediately. */
  private requestStop(reason: string): void {
    if (this.stopReason === null) {
      this.stopReason = reason;
      this.stoppedAtMs = this.clock();
    }
    this.withdrawAll(`PROVIDER_STOPPED:${this.stopReason}`);
    this.clearKeepaliveTimers();
    this.epochAbort?.abort();
    this.sessionAbort?.abort();
    // A private session ends with the provider; a shared one is stopped only by its owner.
    if (this.ownsSession) this.session.stop(this.stopReason!);
  }

  private isStopping(): boolean {
    return this.stopReason !== null || this.sessionAbort?.signal.aborted === true;
  }

  private async run(): Promise<PaperRollingFlowStopReport> {
    try {
      if (await this.setup()) {
        let first = true;
        while (!this.isStopping()) {
          if (!first) {
            if (this.reconnects >= this.limits.maxReconnects) {
              this.requestStop("RECONNECT_CEILING_REACHED");
              break;
            }
            this.reconnects++;
          }
          first = false;
          if (!(await this.openEpoch())) continue;
          await this.runEpoch();
        }
      }
    } catch (err) {
      this.requestStop(`INTERNAL_ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.cleanup();
    }
    return { stopReason: this.stopReason ?? "UNKNOWN", status: this.getStatus() };
  }

  /** Bounded, synchronous cleanup: no awaits, every provider timer cleared. */
  private cleanup(): void {
    if (this.stopReason === null) this.requestStop("COLLECTION_ENDED");
    this.withdrawAll(`PROVIDER_STOPPED:${this.stopReason}`);
    this.sessionAbort?.abort();
    this.epochEstablished = false;
    this.outstandingPing = null;
    try {
      this.coordinator?.close();
    } catch {
      // ignore
    }
    if (this.externalSignal && this.externalAbortListener) {
      this.externalSignal.removeEventListener("abort", this.externalAbortListener);
    }
    for (const handle of [...this.activeTimers]) this.clearTimer(handle);
    this.state = "STOPPED";
  }

  // ===========================================================================================
  // Setup and epochs
  // ===========================================================================================

  private async setup(): Promise<boolean> {
    const layout = await this.rpcCall("POOL_LAYOUT", "getAccountInfo", [
      this.target.poolAddress,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!layout.ok) {
      this.requestStop(`POOL_LAYOUT_FAILED: ${layout.error}`);
      return false;
    }
    const value = (layout.result as { value?: { data?: unknown } } | null)?.value;
    const raw = Array.isArray(value?.data) ? value?.data[0] : value?.data;
    if (typeof raw !== "string") {
      this.requestStop("POOL_LAYOUT_INVALID: account data is not base64");
      return false;
    }
    const buffer = Buffer.from(raw, "base64");
    if (buffer.length !== RAYDIUM_AMM_V4_LAYOUT_LENGTH) {
      this.requestStop("POOL_LAYOUT_INVALID: unexpected layout length");
      return false;
    }
    const parsed = parseRaydiumAmmV4Account(buffer, this.target.poolAddress);
    if (!parsed.ok || parsed.orientation === "NON_SOL_PAIR") {
      this.requestStop("POOL_LAYOUT_INVALID: not a parseable SOL-paired Raydium AMM v4 pool");
      return false;
    }
    const state = parsed.state;
    const tokenBase = parsed.orientation === "TOKEN_BASE_SOL_QUOTE";
    const candidateMint = tokenBase ? state.baseMint : state.quoteMint;
    const quoteMint = tokenBase ? state.quoteMint : state.baseMint;
    if (candidateMint !== this.target.tokenMint || quoteMint !== WSOL_MINT) {
      this.requestStop("TARGET_MINT_MISMATCH: pool layout does not match the fixed target mint");
      return false;
    }
    const poolContext: TrackedRaydiumPoolContext = {
      poolId: this.target.poolAddress,
      candidateTokenMint: candidateMint,
      quoteTokenMint: quoteMint,
      baseVault: state.baseVault,
      quoteVault: state.quoteVault,
      baseMint: state.baseMint,
      quoteMint: state.quoteMint,
      orientation: parsed.orientation,
    };
    validateTrackedPoolContext(poolContext);
    this.poolContext = Object.freeze(poolContext);

    this.tracker = new RollingTradeFlowTracker({
      poolId: poolContext.poolId,
      tokenMint: poolContext.candidateTokenMint,
      clock: this.clock,
    });
    this.adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: this.poolContext,
      rpcUrl: this.rpcUrl,
      budgetManager: this.budgetManager,
      transport: this.adapterTransport,
      providerName: PROVIDER_NAME,
      requestPurpose: "CANDIDATE_ENRICHMENT",
      pacingMs: this.limits.rpcPacingMs,
      timeoutMs: this.limits.requestTimeoutMs,
      maxPendingQueueSize: this.limits.queueCeiling,
      tracker: this.tracker,
      clock: this.clock,
      sleepFn: (ms) => this.sleep(ms),
      paperFailedTransactionPolicy: { enabled: true, executionContext: "PAPER_SIMULATION" },
    });
    this.coordinator = new RaydiumCandidateSubscriptionCoordinator({
      poolContext: this.poolContext,
      adapter: this.adapter,
      tracker: this.tracker,
      clock: this.clock,
      maxNotificationsBudget: this.limits.maxNotifications,
      onStatusChange: (status) => this.onCoordinatorStatus(status),
    });
    return !this.isStopping();
  }

  /** Acquires a prior anchor and a new confirmed subscription. Returns false when the epoch failed. */
  private async openEpoch(): Promise<boolean> {
    const anchorRes = await this.rpcCall("PRIOR_ANCHOR", "getSignaturesForAddress", [
      this.target.poolAddress,
      { limit: 1 },
    ]);
    if (!anchorRes.ok) {
      this.requestStop(`PRIOR_ANCHOR_FAILED: ${anchorRes.error}`);
      return false;
    }
    const first = Array.isArray(anchorRes.result) ? (anchorRes.result[0] as unknown) : undefined;
    const rec = first as Partial<HistorySignatureRecord> | undefined;
    if (
      !rec ||
      !isValidSolanaSignature(rec.signature) ||
      typeof rec.slot !== "number" ||
      !Number.isSafeInteger(rec.slot) ||
      (rec.blockTime !== null && !isPositiveSafeInteger(rec.blockTime))
    ) {
      this.requestStop("PRIOR_ANCHOR_INVALID");
      return false;
    }
    const anchor: HistorySignatureRecord = Object.freeze({
      signature: rec.signature,
      slot: rec.slot,
      err: rec.err ?? null,
      blockTime: rec.blockTime ?? null,
    });

    // New epoch: discard previous-epoch resolutions and history; the warm-up restarts.
    this.epochStreamResults = [];
    this.lastHistoryRecords = [anchor];
    this.anchorRecord = anchor;
    this.outstandingPing = null;

    const inner = this.createWebSocketTransport();
    const transportId = ++this.transportSeq;
    const wrapped = this.wrapTransport(inner, transportId);
    this.currentTransport = inner;
    inner.on("pong", (data: Buffer) => this.onPong(transportId, data));
    inner.on("ping", () => this.onControlFrame());
    this.coordinator!.attachTransport(wrapped);
    this.coordinator!.sendSubscriptionRequest();

    // Ack wait: bounded by the ack timeout AND the absolute lifetime deadline (sleep is capped).
    const ackDeadline = Math.min(
      this.clock() + this.limits.subscriptionAckTimeoutMs,
      this.deadlineMs!,
    );
    while (
      this.coordinator!.getStatus() !== "SUBSCRIBED" &&
      this.clock() < ackDeadline &&
      !this.isStopping()
    ) {
      await this.sleep(
        Math.min(PAPER_ROLLING_FLOW_FIXED_RULES.ackPollMs, ackDeadline - this.clock()),
      );
    }
    if (this.isStopping()) return false;
    if (this.coordinator!.getStatus() !== "SUBSCRIBED") {
      // Counts as a lost epoch; the caller decides whether a reconnect is still allowed.
      return false;
    }
    this.currentEpoch = this.coordinator!.getConnectionEpoch();
    this.observationStartMs = this.clock();
    this.firstRefreshNotBeforeMs =
      this.observationStartMs + PAPER_ROLLING_FLOW_FIXED_RULES.nominalWarmUpMs;
    this.epochAbort = new AbortController();
    this.epochEstablished = true;
    this.scheduleNextPing();
    return true;
  }

  private onCoordinatorStatus(status: SubscriptionCoordinatorStatus): void {
    if (status === "SUBSCRIBED") return;
    if (this.epochEstablished) this.markEpochLost(`COORDINATOR_${status}`);
    if (status === "CLOSED" && !this.isStopping()) {
      const received = this.coordinator?.getMetrics().totalNotificationsReceived ?? 0;
      this.requestStop(
        received > this.limits.maxNotifications
          ? "NOTIFICATION_CEILING_REACHED"
          : "COORDINATOR_CLOSED",
      );
    }
  }

  /** Withdraws every snapshot and aborts in-flight epoch work immediately. */
  private markEpochLost(reason: string): void {
    if (!this.epochEstablished) return;
    this.epochEstablished = false;
    this.outstandingPing = null;
    this.clearKeepaliveTimers();
    this.withdrawAll(`EPOCH_INVALIDATED:${reason}`);
    this.epochAbort?.abort();
  }

  /** One epoch: cycles of up to maxRetrievalsPerCycle retrievals followed by a refresh (or a skip). */
  private async runEpoch(): Promise<void> {
    let cycleRetrievals = 0;
    while (!this.isStopping() && this.epochEstablished) {
      if (this.clock() >= this.deadlineMs!) {
        this.requestStop("LIFETIME_EXPIRED");
        break;
      }
      this.checkGaps();
      if (!this.epochEstablished || this.isStopping()) break;

      if (this.adapter!.getPendingQueueLength() > 0) {
        if (cycleRetrievals >= this.limits.maxRetrievalsPerCycle) {
          this.endCycle("REFRESH_SKIPPED_RETRIEVAL_ALLOWANCE_EXHAUSTED", cycleRetrievals, null);
          this.refreshesSkipped++;
          cycleRetrievals = 0;
          continue;
        }
        if (this.transactionRetrievals >= this.limits.maxTransactionRetrievals) {
          this.requestStop("TRANSACTION_RETRIEVAL_CEILING_REACHED");
          break;
        }
        if (this.ledger.length >= this.limits.maxHttpAttempts) {
          this.requestStop("HTTP_ATTEMPT_CEILING_REACHED");
          break;
        }
        const before = this.transactionRetrievals;
        const result = await this.coordinator!.processNextPending({
          signal: this.epochSignal(),
          overallTimeoutMs: this.limits.rpcPacingMs + this.limits.requestTimeoutMs + 1_000,
        });
        if (this.transactionRetrievals > before) cycleRetrievals++;
        if (result) this.onRetrievalResult(result);
        this.checkGaps();
        continue;
      }

      const now = this.clock();
      if (now < this.firstRefreshNotBeforeMs) {
        await this.sleep(
          Math.min(PAPER_ROLLING_FLOW_FIXED_RULES.idleStepMs, this.firstRefreshNotBeforeMs - now),
        );
        continue;
      }

      const outcome = await this.refresh();
      if (outcome.kind === "NO_DISPATCH") continue; // backlog appeared before GET_SLOT: same cycle
      this.endCycle(outcome.outcome, cycleRetrievals, outcome);
      cycleRetrievals = 0;
    }
  }

  private endCycle(
    outcome: string,
    retrievals: number,
    refresh: {
      readonly getSlotDispatchedAtMs: number | null;
      readonly cutoffTimestampMs: number | null;
      readonly snapshotId: number | null;
    } | null,
  ): void {
    this.cycles++;
    this.cycleLog.push(
      Object.freeze({
        cycle: this.cycles,
        epoch: this.currentEpoch ?? -1,
        outcome,
        retrievals,
        endedAtMs: this.clock(),
        getSlotDispatchedAtMs: refresh?.getSlotDispatchedAtMs ?? null,
        cutoffTimestampMs: refresh?.cutoffTimestampMs ?? null,
        snapshotId: refresh?.snapshotId ?? null,
      }),
    );
    if (this.cycleLog.length > 500) this.cycleLog.shift();
  }

  // ===========================================================================================
  // Refresh: GET_SLOT -> GET_BLOCK_TIME -> one history page -> evaluate -> publish (or not)
  // ===========================================================================================

  private async refresh(): Promise<
    | { readonly kind: "NO_DISPATCH" }
    | {
        readonly kind: "ATTEMPTED";
        readonly outcome: string;
        readonly getSlotDispatchedAtMs: number | null;
        readonly cutoffTimestampMs: number | null;
        readonly snapshotId: number | null;
      }
  > {
    const epoch = this.currentEpoch!;
    const gapVersionAtStart = this.gapVersion;
    const notificationSeqAtStart = this.notificationSeq;
    const attempted = (
      outcome: string,
      getSlotDispatchedAtMs: number | null,
      cutoffTimestampMs: number | null = null,
      snapshotId: number | null = null,
    ) => ({
      kind: "ATTEMPTED" as const,
      outcome,
      getSlotDispatchedAtMs,
      cutoffTimestampMs,
      snapshotId,
    });

    const slotRes = await this.rpcCall("GET_SLOT", "getSlot", [{ commitment: "confirmed" }], () =>
      this.adapter!.getActiveWorkload() > 0
        ? "BACKLOG_BEFORE_GET_SLOT"
        : !this.epochEstablished
          ? "EPOCH_LOST_BEFORE_GET_SLOT"
          : null,
    );
    if (!slotRes.ok && !slotRes.dispatched) {
      // Backlog, a lost epoch or a stop: no GET_SLOT was sent. Terminal refusals already stopped collection.
      return { kind: "NO_DISPATCH" };
    }
    this.refreshesAttempted++;
    const getSlotDispatchedAtMs = this.ledger[this.ledger.length - 1]?.entry.dispatchedAtMs ?? null;
    if (!slotRes.ok) return attempted(`GET_SLOT_FAILED: ${slotRes.error}`, getSlotDispatchedAtMs);
    const cutoffSlot = slotRes.result;
    if (typeof cutoffSlot !== "number" || !Number.isSafeInteger(cutoffSlot) || cutoffSlot < 0) {
      return attempted("GET_SLOT_INVALID", getSlotDispatchedAtMs);
    }
    if (!this.epochEstablished || this.isStopping()) {
      return attempted("EPOCH_LOST_DURING_REFRESH", getSlotDispatchedAtMs);
    }

    const btRes = await this.rpcCall("GET_BLOCK_TIME", "getBlockTime", [cutoffSlot]);
    if (!btRes.ok) return attempted(`GET_BLOCK_TIME_FAILED: ${btRes.error}`, getSlotDispatchedAtMs);
    if (!isPositiveSafeInteger(btRes.result)) {
      return attempted("GET_BLOCK_TIME_INVALID", getSlotDispatchedAtMs);
    }
    const cutoffTimestampMs = btRes.result * 1000;
    const retrievedAtMs = this.clock();
    const observationEndMs = retrievedAtMs;
    if (!this.epochEstablished || this.isStopping()) {
      return attempted("EPOCH_LOST_DURING_REFRESH", getSlotDispatchedAtMs, cutoffTimestampMs);
    }
    const sourceCutoff: SourceCutoffEvidence = {
      sourceMethod: "getBlockTime",
      responseField: "result",
      commitment: "confirmed",
      provenance: "ON_CHAIN_BLOCK_TIME",
      slot: cutoffSlot,
      cutoffTimestampMs,
      retrievedAtMs,
      responsePayload: btRes.json,
      requestContext: { slot: cutoffSlot },
    };

    // Anchor advance: newest previously enumerated signature at or before the new window start.
    const windowStartMs = cutoffTimestampMs - PAPER_ROLLING_FLOW_FIXED_RULES.windowMs;
    let anchor = this.anchorRecord!;
    for (const r of this.lastHistoryRecords) {
      if (r.blockTime !== null && r.blockTime * 1000 <= windowStartMs && r.slot > anchor.slot) {
        anchor = r;
      }
    }

    const enumerator = new ExactPoolHistoryEnumerator({
      poolContext: this.poolContext!,
      knownAnchorSignature: anchor.signature,
      pageFetcher: (p) => this.fetchHistoryPage(p),
      budgetManager: this.budgetManager,
      providerName: PROVIDER_NAME,
      clock: this.clock,
      pageSize: PAPER_ROLLING_FLOW_FIXED_RULES.historyPageSize,
      maxPages: PAPER_ROLLING_FLOW_FIXED_RULES.historyMaxPages,
      maxRetainedRecords: PAPER_ROLLING_FLOW_FIXED_RULES.historyPageSize,
      operationDeadlineMs: this.limits.rpcPacingMs + this.limits.requestTimeoutMs + 1_000,
      lifecycleTarget: this.coordinator!,
      dispatchEpoch: epoch,
      signal: this.epochSignal(),
      sleepFn: (ms, sig) => this.sleep(ms, sig),
    });
    const historyResult = await enumerator.enumerate();
    const historyRetrievedAtMs = this.clock();
    const pageRecords: HistorySignatureRecord[] = [
      ...(historyResult.anchorRecord ? [historyResult.anchorRecord] : []),
      ...historyResult.discoveredSignatures,
    ];
    // Delayed signatures revealed by history withdraw every snapshot that cannot exclude them.
    this.checkHistoryAgainstSnapshots(pageRecords);
    if (historyResult.outcome === "ANCHOR_WITNESSED") {
      this.lastHistoryRecords = pageRecords;
      this.anchorRecord = historyResult.anchorRecord ?? anchor;
    }
    this.checkGaps();
    if (!this.epochEstablished || this.isStopping()) {
      return attempted("EPOCH_LOST_DURING_REFRESH", getSlotDispatchedAtMs, cutoffTimestampMs);
    }

    const decisionTimestampMs = this.clock();
    const resolvedSignatures = buildStreamResolutionRecords(
      this.epochStreamResults,
      this.txIdentityBySignature,
    );
    const result = evaluateExactPoolWindowReconciliation({
      poolContext: this.poolContext!,
      decisionTimestampMs,
      observationStartMs: this.observationStartMs,
      observationEndMs,
      sourceCutoff,
      tracker: this.tracker!,
      hasActiveBacklog: this.adapter!.getActiveWorkload() > 0,
      knownAnchorSignature: anchor.signature,
      expectedConnectionEpoch: epoch,
      historyResult,
      historyRetrievedAtMs,
      acquisitionCompletedAtMs: decisionTimestampMs,
      resolvedSignatures,
      budgetManager: this.budgetManager,
      providerName: PROVIDER_NAME,
      minHostPacingMs: this.limits.rpcPacingMs,
      maxAllowedEvidenceAgeMs: PAPER_ROLLING_FLOW_FIXED_RULES.maxEvidenceAgeMs,
      clock: this.clock,
      paperQuietStreamPolicy: { enabled: true, executionContext: "PAPER_SIMULATION" },
      paperActiveWindowPolicy: { enabled: true, executionContext: "PAPER_SIMULATION" },
    });

    const quiet = result.paperQuietStreamQualified === true;
    const active = result.paperActiveWindowQualified === true;
    let rejection: string | null = null;
    if (result.status !== "RECONCILED" || (!quiet && !active)) {
      rejection = `NOT_QUALIFIED: ${result.status}: ${result.diagnosticReason}`;
    } else if (this.gapVersion !== gapVersionAtStart) {
      rejection = "NOT_PUBLISHED: gap recorded during refresh";
    } else if (this.notificationSeq !== notificationSeqAtStart) {
      rejection = "NOT_PUBLISHED: notification received during refresh";
    } else if (this.adapter!.getActiveWorkload() > 0) {
      rejection = "NOT_PUBLISHED: backlog at publication";
    } else if (!this.epochEstablished || this.currentEpoch !== epoch || this.isStopping()) {
      rejection = "NOT_PUBLISHED: epoch lost during refresh";
    } else {
      const check = this.paperAdapter.convertCandidateFlow(
        result,
        this.target,
        decisionTimestampMs,
        {
          executionContext: "PAPER_SIMULATION",
          maxAllowedEvidenceAgeMs: PAPER_ROLLING_FLOW_FIXED_RULES.maxEvidenceAgeMs,
          allowActiveWindowQualification: true,
        },
      );
      if (!check.isCoverageSufficient) rejection = `NOT_PUBLISHED: ${check.diagnosticReason}`;
    }
    if (rejection !== null) {
      return attempted(rejection, getSlotDispatchedAtMs, cutoffTimestampMs);
    }

    const snapshot: PublishedSnapshot = Object.freeze({
      id: ++this.snapshotSeq,
      epoch,
      result: deepFreeze(result),
      qualificationKind: active ? ("ACTIVE_WINDOW" as const) : ("QUIET_WINDOW" as const),
      publishedAtMs: decisionTimestampMs,
      cutoffSlot,
      windowStartMs,
      windowEndMs: cutoffTimestampMs,
      accountedSignatures: new Set(pageRecords.map((r) => r.signature)),
    });
    this.snapshots.push(snapshot);
    while (this.snapshots.length > PAPER_ROLLING_FLOW_FIXED_RULES.maxSnapshotsRetained) {
      const retired = this.snapshots.shift();
      if (retired) this.withdrawals.delete(retired.id);
    }
    this.refreshesPublished++;
    return attempted("PUBLISHED", getSlotDispatchedAtMs, cutoffTimestampMs, snapshot.id);
  }

  private async fetchHistoryPage(p: HistoryPageQueryParams): Promise<HistorySignatureRecord[]> {
    const cfg: Record<string, unknown> = { limit: p.limit };
    if (p.before) cfg.before = p.before;
    if (p.commitment) cfg.commitment = p.commitment;
    const id = this.session.nextJsonRpcId();
    const exchange = await this.dispatchRpc(
      "HISTORY_ENUMERATION",
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "getSignaturesForAddress",
        params: [p.address, cfg],
      }),
      { signal: p.signal },
    );
    if (!exchange.ok) throw new Error(exchange.error ?? `HTTP ${String(exchange.status)}`);
    const json = parseJson(exchange.text) as { id?: unknown; result?: unknown } | undefined;
    if (!json || json.id !== id || !Array.isArray(json.result)) {
      throw new Error("Malformed history page response");
    }
    return json.result as HistorySignatureRecord[];
  }

  // ===========================================================================================
  // Withdrawal rules
  // ===========================================================================================

  private summarize(s: PublishedSnapshot): PaperRollingFlowSnapshotSummary {
    const w = this.withdrawals.get(s.id);
    return {
      id: s.id,
      epoch: s.epoch,
      qualificationKind: s.qualificationKind,
      publishedAtMs: s.publishedAtMs,
      cutoffSlot: s.cutoffSlot,
      windowStartMs: s.windowStartMs,
      windowEndMs: s.windowEndMs,
      recentBuys60s: s.result.flowCounts.recentBuys60s ?? -1,
      recentSells60s: s.result.flowCounts.recentSells60s ?? -1,
      withdrawnReason: w?.reason ?? null,
      withdrawnAtMs: w?.atMs ?? null,
    };
  }

  private withdraw(s: PublishedSnapshot, reason: string): void {
    if (this.withdrawals.has(s.id)) return;
    this.withdrawals.set(s.id, { reason, atMs: this.clock() });
  }

  private withdrawAll(reason: string): void {
    for (const s of this.snapshots) this.withdraw(s, reason);
  }

  /** A notification for an unaccounted signature cannot be excluded until its block time is known. */
  private onNotificationObserved(signature: string, slot: number | null): void {
    this.notificationSeq++;
    const epochNow = this.coordinator?.getConnectionEpoch();
    if (epochNow !== undefined && !this.notificationEpochBySignature.has(signature)) {
      this.notificationEpochBySignature.set(signature, epochNow);
    }
    for (const s of this.snapshots) {
      if (s.accountedSignatures.has(signature)) continue;
      this.withdraw(
        s,
        slot !== null && slot <= s.cutoffSlot
          ? "DELAYED_SIGNATURE_AT_OR_BEFORE_CUTOFF_SLOT"
          : "UNACCOUNTED_SIGNATURE_BLOCK_TIME_UNKNOWN",
      );
    }
  }

  /** Existing slot/window rule: only a later slot whose known block time is after the window is excluded. */
  private checkHistoryAgainstSnapshots(records: readonly HistorySignatureRecord[]): void {
    for (const s of this.snapshots) {
      for (const r of records) {
        if (s.accountedSignatures.has(r.signature)) continue;
        const excluded =
          r.slot > s.cutoffSlot && r.blockTime !== null && r.blockTime * 1000 > s.windowEndMs;
        if (!excluded) {
          this.withdraw(s, "DELAYED_SIGNATURE_IN_HISTORY");
          break;
        }
      }
    }
  }

  private onRetrievalResult(result: ProcessNotificationResult): void {
    const epochOfNotification = this.notificationEpochBySignature.get(result.signature);
    if (epochOfNotification === this.currentEpoch) this.epochStreamResults.push(result);
    const resolved =
      result.ok && (result.outcome === "SUCCESS" || result.outcome === "KNOWN_FAILED_TRANSACTION");
    if (!resolved && result.outcome !== "DUPLICATE_NOTIFICATION") {
      for (const s of this.snapshots) {
        if (!s.accountedSignatures.has(result.signature)) {
          this.withdraw(s, `UNRESOLVED_TRANSACTION:${result.outcome}`);
        }
      }
    }
  }

  /** Any newly recorded (or merged) tracker gap withdraws every snapshot. */
  private checkGaps(): void {
    if (!this.tracker) return;
    const keys = this.tracker
      .getRecordedGaps()
      .map((g) => `${g.gapStartMs}:${g.gapEndMs}:${g.reason ?? ""}`);
    let newGap: string | null = null;
    for (const k of keys) {
      if (!this.knownGapKeys.has(k)) {
        newGap = k;
        break;
      }
    }
    this.knownGapKeys = new Set(keys);
    if (newGap !== null) {
      this.gapVersion++;
      this.withdrawAll(`RECORDED_GAP:${newGap.split(":").slice(2).join(":") || "UNSPECIFIED"}`);
    }
  }

  // ===========================================================================================
  // WebSocket inspection, limits and timer-driven keepalive
  // ===========================================================================================

  private wrapTransport(
    inner: ISolanaKeepaliveWebSocketTransport,
    transportId: number,
  ): ISolanaKeepaliveWebSocketTransport {
    const onAny = (event: string, listener: (...args: never[]) => void): void => {
      if (event === "message") {
        inner.on("message", (data: string | Buffer) => {
          if (!this.inspectMessage(transportId, data)) return;
          (listener as (d: string | Buffer) => void)(data);
          this.checkGaps();
        });
      } else if (event === "close" || event === "error" || event === "open") {
        inner.on(event as "close", (...args: [number, string]) => {
          (listener as (...a: [number, string]) => void)(...args);
          this.checkGaps();
        });
      } else {
        inner.on(event as "pong", listener as (data: Buffer) => void);
      }
    };
    const wrapped = {
      send: (data: string) => inner.send(data),
      close: (code?: number, reason?: string) => inner.close(code, reason),
      ping: (data?: Buffer, cb?: (err?: Error) => void) => inner.ping?.(data, cb),
      on: onAny as unknown as ISolanaKeepaliveWebSocketTransport["on"],
    };
    return wrapped as ISolanaKeepaliveWebSocketTransport;
  }

  /** Counts and limits incoming data messages; inspects notifications before the coordinator sees them. */
  private inspectMessage(transportId: number, data: string | Buffer): boolean {
    if (this.isStopping()) return false;
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
    this.wsMessages++;
    this.wsMessageBytes += bytes;
    if (this.wsMessages > this.limits.maxWsMessages) {
      this.requestStop("WS_MESSAGE_CEILING_REACHED");
      return false;
    }
    if (this.wsMessageBytes > this.limits.maxWsMessageBytes) {
      this.requestStop("WS_MESSAGE_BYTE_CEILING_REACHED");
      return false;
    }
    if (transportId !== this.transportSeq) return true; // stale transport: coordinator drops it by epoch
    const parsed = parseJson(typeof data === "string" ? data : data.toString("utf8")) as
      | { method?: unknown; params?: { subscription?: unknown; result?: unknown } }
      | undefined;
    if (parsed?.method === "logsNotification") {
      const active = this.coordinator?.getActiveSubscriptionId();
      if (active !== null && active !== undefined && parsed.params?.subscription === active) {
        const result = parsed.params.result as
          | { context?: { slot?: unknown }; value?: { signature?: unknown } }
          | undefined;
        const sig = result?.value?.signature;
        const slot = result?.context?.slot;
        if (typeof sig === "string") {
          this.onNotificationObserved(
            sig.trim(),
            typeof slot === "number" && Number.isSafeInteger(slot) ? slot : null,
          );
        }
      }
    }
    return true;
  }

  private onControlFrame(): void {
    this.wsControlFrames++;
    if (this.wsControlFrames > this.limits.maxWsControlFrames) {
      this.requestStop("WS_CONTROL_FRAME_CEILING_REACHED");
    }
  }

  private onPong(transportId: number, data: Buffer): void {
    this.onControlFrame();
    if (transportId !== this.transportSeq || !this.outstandingPing) {
      this.unmatchedPongs++;
      return;
    }
    if (Buffer.isBuffer(data) && data.equals(this.outstandingPing.payload)) {
      this.matchedPongs++;
      this.outstandingPing = null;
      this.clearTimer(this.pongTimer);
      this.pongTimer = null;
    } else {
      this.unmatchedPongs++;
    }
  }

  private clearKeepaliveTimers(): void {
    this.clearTimer(this.pingTimer);
    this.clearTimer(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private scheduleNextPing(): void {
    this.clearTimer(this.pingTimer);
    this.pingTimer = this.setTimer(() => this.onPingDue(), this.limits.keepalivePingIntervalMs);
  }

  /** Timer-driven: runs even while the collection loop awaits RPC work. */
  private onPingDue(): void {
    this.pingTimer = null;
    if (!this.epochEstablished || this.isStopping()) return;
    if (this.pingsSent >= this.limits.maxKeepalivePings) {
      this.requestStop("KEEPALIVE_PING_CEILING_REACHED");
      return;
    }
    const transport = this.currentTransport;
    if (!transport || typeof transport.ping !== "function") {
      this.markEpochLost("KEEPALIVE_UNSUPPORTED");
      return;
    }
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(this.transportSeq, 0);
    payload.writeUInt32BE(this.pingsSent + 1, 4);
    this.pingsSent++;
    this.outstandingPing = { payload, sentAtMs: this.clock() };
    this.pongTimer = this.setTimer(() => {
      this.pongTimer = null;
      if (this.outstandingPing?.payload === payload) this.markEpochLost("MISSING_PONG");
    }, this.limits.keepalivePongTimeoutMs);
    this.scheduleNextPing();
    try {
      transport.ping(payload);
    } catch {
      this.markEpochLost("PING_SEND_FAILED");
    }
  }

  // ===========================================================================================
  // Serialized, paced Solana RPC dispatcher (authoritative ledger)
  // ===========================================================================================

  /** Transport handed to the transaction adapter; routes every retrieval through the dispatcher. */
  private readonly adapterTransport = (async (_input: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    const exchange = await this.dispatchRpc("TRANSACTION_RETRIEVAL", body, {
      signal: init?.signal ?? undefined,
    });
    if (!exchange.dispatched || exchange.text === undefined || exchange.status === undefined) {
      throw new Error(exchange.error ?? "Retrieval not dispatched");
    }
    const requested = (parseJson(body) as { params?: unknown[] } | undefined)?.params?.[0];
    const tx = (
      parseJson(exchange.text) as { result?: { slot?: unknown; blockTime?: unknown } } | undefined
    )?.result;
    if (
      typeof requested === "string" &&
      tx &&
      typeof tx.slot === "number" &&
      Number.isSafeInteger(tx.slot) &&
      (tx.blockTime === null ||
        (typeof tx.blockTime === "number" && Number.isSafeInteger(tx.blockTime)))
    ) {
      this.txIdentityBySignature.set(requested, {
        slot: tx.slot,
        blockTime: tx.blockTime as number | null,
      });
    }
    return new Response(exchange.text, { status: exchange.status });
  }) as unknown as typeof fetch;

  private async rpcCall(
    purpose: PaperRollingFlowRequestPurpose,
    method: string,
    params: readonly unknown[],
    precondition?: () => string | null,
  ): Promise<RpcCallResult> {
    const id = this.session.nextJsonRpcId();
    const exchange = await this.dispatchRpc(
      purpose,
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      precondition ? { precondition } : {},
    );
    if (!exchange.dispatched) {
      return { ok: false, dispatched: false, error: exchange.error ?? "NOT_DISPATCHED" };
    }
    if (!exchange.ok) {
      return {
        ok: false,
        dispatched: true,
        error: exchange.error ?? `HTTP_${String(exchange.status)}`,
      };
    }
    const json = parseJson(exchange.text) as
      | { id?: unknown; result?: unknown; error?: unknown }
      | undefined;
    if (!json || typeof json !== "object") {
      return { ok: false, dispatched: true, error: "MALFORMED_RESPONSE" };
    }
    if (json.id !== id) return { ok: false, dispatched: true, error: "RPC_ID_MISMATCH" };
    if (json.error !== undefined && json.error !== null) {
      return { ok: false, dispatched: true, error: "RPC_ERROR" };
    }
    if (!("result" in json)) return { ok: false, dispatched: true, error: "MISSING_RESULT" };
    return { ok: true, result: json.result, json };
  }

  private dispatchRefusal(
    purpose: PaperRollingFlowRequestPurpose,
    callerSignal: AbortSignal | undefined,
  ): string | null {
    if (this.isStopping()) return "PROVIDER_STOPPING";
    if (this.deadlineMs !== null && this.clock() >= this.deadlineMs) return "LIFETIME_EXPIRED";
    if (callerSignal?.aborted) return "CALLER_CANCELLED";
    if (EPOCH_SCOPED_PURPOSES.has(purpose) && (!this.epochEstablished || !this.epochAbort)) {
      return "EPOCH_NOT_ESTABLISHED";
    }
    if (EPOCH_SCOPED_PURPOSES.has(purpose) && this.epochAbort?.signal.aborted) {
      return "EPOCH_NOT_ESTABLISHED";
    }
    if (this.ledger.length >= this.limits.maxHttpAttempts) return "HTTP_ATTEMPT_CEILING_REACHED";
    if (
      purpose === "TRANSACTION_RETRIEVAL" &&
      this.transactionRetrievals >= this.limits.maxTransactionRetrievals
    ) {
      return "TRANSACTION_RETRIEVAL_CEILING_REACHED";
    }
    return null;
  }

  private async dispatchRpc(
    purpose: PaperRollingFlowRequestPurpose,
    body: string,
    opts: {
      readonly precondition?: (() => string | null) | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<RpcExchange> {
    const rpcId = (parseJson(body) as { id?: unknown } | undefined)?.id;
    const waitSignals: AbortSignal[] = [this.sessionAbort!.signal];
    if (opts.signal) waitSignals.push(opts.signal);
    const exchange = await this.session.dispatch({
      lane: "SOLANA_RPC",
      owner: "FLOW",
      purpose,
      requestedIdentity: this.target.poolAddress,
      url: this.rpcUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      jsonRpcId: typeof rpcId === "number" || typeof rpcId === "string" ? rpcId : null,
      // Provider refusals first (stop, lifetime, cancellation, epoch, own ceilings), then the session's.
      refusal: () => this.dispatchRefusal(purpose, opts.signal),
      precondition: opts.precondition,
      waitSignals,
      // Linked at dispatch time: stop, the caller, and (for epoch-scoped work) the current epoch.
      linkSignals: () => {
        const linked: AbortSignal[] = [this.sessionAbort!.signal];
        if (opts.signal) linked.push(opts.signal);
        if (EPOCH_SCOPED_PURPOSES.has(purpose) && this.epochAbort) {
          linked.push(this.epochAbort.signal);
        }
        return linked;
      },
      onDispatched: (entry) => {
        this.ledger.push({ entry, epoch: this.currentEpoch ?? 0 });
        if (purpose === "TRANSACTION_RETRIEVAL") this.transactionRetrievals++;
      },
    });
    if (!exchange.dispatched && exchange.error && TERMINAL_REFUSALS.has(exchange.error)) {
      this.requestStop(exchange.error);
    }
    return {
      dispatched: exchange.dispatched,
      ok: exchange.ok,
      status: exchange.status,
      text: exchange.text,
      error: exchange.error,
    };
  }
}
