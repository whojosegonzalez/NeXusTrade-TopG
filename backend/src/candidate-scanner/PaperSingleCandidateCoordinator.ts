/**
 * Phase 12.94-D D.3.3: PAPER single-candidate coordinator (offline-tested only; not installed).
 *
 * Bounded scheduling and lifecycle control for ONE fixed pool and mint, built only from the accepted
 * components:
 *
 * - one PaperRequestSession (one ledger, one HTTP-attempt ceiling, one serialized Solana lane);
 * - the PaperRollingCandidateFlowProvider on that session;
 * - the PaperCandidateSecurityEvidenceLoader and PaperSecurityEvidenceCache (prefetch, selective
 *   refresh, pending components withheld);
 * - CandidateStreamEngine in validated-LP mode (evaluatePoolAsync only; no discovery, no polling);
 * - retrieveAndEvaluatePaperDaemonEntry with the cache as its security path.
 *
 * It returns decision and status records only. It never executes a buy or creates a position.
 *
 * Boundaries:
 * - Import and construction are inert: nothing is opened, sent or scheduled until start().
 * - PAPER_SIMULATION only; one canonical pool and mint; transports, credentials, clock, timers and
 *   every limit are injected; there are no defaults.
 * - start() may be called once. stop(), the session deadline, a terminal session failure, the end
 *   of flow collection or a terminal decision stop everything: scheduled work is cleared, the
 *   loader is cancelled, collection is stopped and the session is closed, so no later request or
 *   decision follows.
 * - Status reads never acquire. Freshness, pacing, ceilings and the existing rejection, expiry and
 *   disarming rules are unchanged; nothing is extended, reset or re-stamped.
 */

import type { WatchlistCandidateItem } from "@nexustrade/shared";
import { BuyGateTriggerService, type ArmedPullbackState } from "./BuyGateTriggerService.js";
import type { CandidateFlowResult } from "./CandidateFlowProvider.js";
import type {
  CandidateScannerEvaluationResult,
  CandidateScannerRuntimeConfig,
  ScannedPoolRecord,
} from "./CandidateScannerTypes.js";
import { CandidateStreamEngine } from "./CandidateStreamEngine.js";
import { isCanonicalSolanaBase58 } from "./LpScreeningBridge.js";
import {
  PAPER_SECURITY_CONTEXT_POLICY,
  evaluatePaperCandidateSecurityContext,
  type PaperCandidateSecurityEvidence,
  type PaperSecurityEvidenceComponent,
  type PaperSecurityTarget,
} from "./PaperCandidateSecurityContext.js";
import {
  PaperCandidateSecurityEvidenceLoader,
  PaperSecurityEvidenceCache,
  type PaperSecurityEvidenceCacheLimits,
  type PaperSecurityEvidenceCacheStatus,
  type PaperSecurityEvidenceLoaderLimits,
} from "./PaperCandidateSecurityEvidenceLoader.js";
import {
  PaperRequestSession,
  type PaperRequestExchangeEvidence,
  type PaperRequestSessionLimits,
  type PaperRequestSessionTimers,
} from "./PaperRequestSession.js";
import {
  PAPER_ROLLING_FLOW_FIXED_RULES,
  PaperRollingCandidateFlowProvider,
  type PaperRollingFlowLimits,
  type PaperRollingFlowStopReport,
} from "./PaperRollingCandidateFlowProvider.js";
import type { ISolanaKeepaliveWebSocketTransport } from "./RaydiumTransportObservationProbe.js";
import type { EvidenceOrigin } from "../research/pilot/RaydiumAmmV4SnapshotValidator.js";
import {
  retrieveAndEvaluatePaperDaemonEntry,
  type PaperDaemonEntryEvaluation,
  type PaperDaemonEntrySpotInput,
} from "../scripts/paper-trading-daemon.js";

/** Explicit scheduling limits. Every field is mandatory; no value is approved for live execution. */
export interface PaperCoordinatorScheduleLimits {
  /** Prefetch this long before the epoch's earliest first refresh (subscription + 65 s warm-up). */
  readonly prefetchLeadMs: number;
  /** Arm-to-confirmation spacing (the planned confirmation time). */
  readonly confirmDelayMs: number;
  /** Minimum spacing between unarmed decisions. */
  readonly decisionIntervalMs: number;
  /** Time a decision needs after it starts (its market request); used for the due check. */
  readonly decisionLeadMs: number;
  /** Planning horizon of a pre-decision refresh (components must stay valid this long). */
  readonly refreshHorizonMs: number;
  /** Interval of local state checks (pure reads only; no request). */
  readonly tickMs: number;
  /** Entry decisions allowed in the coordinator's lifetime (each makes one market request). */
  readonly maxDecisions: number;
  /** Subscription epochs for which a prefetch may be scheduled (first epoch plus reconnects). */
  readonly maxPrefetchEpochs: number;
}

export interface PaperCoordinatorLimits {
  readonly session: PaperRequestSessionLimits;
  readonly flow: PaperRollingFlowLimits;
  readonly loader: PaperSecurityEvidenceLoaderLimits;
  readonly cache: PaperSecurityEvidenceCacheLimits;
  readonly schedule: PaperCoordinatorScheduleLimits;
}

/** Market snapshot parser for the one accounted market request (pure; supplied by the caller). */
export type PaperCoordinatorMarketParser = (
  json: unknown,
  target: PaperSecurityTarget,
  /** Session time the response was received (for the snapshot record only). */
  receivedAtMs?: number,
) => {
  readonly pool: ScannedPoolRecord;
  readonly spot: PaperDaemonEntrySpotInput & { readonly spotPriceSol: number | null };
} | null;

export interface PaperSingleCandidateCoordinatorOptions {
  readonly executionContext: "PAPER_SIMULATION";
  readonly target: PaperSecurityTarget;
  readonly transports: {
    readonly fetchFn: typeof fetch;
    readonly createWebSocketTransport: () => ISolanaKeepaliveWebSocketTransport;
  };
  readonly endpoints: {
    readonly solanaRpcUrl: string;
    readonly rugCheckApiUrl: string;
    readonly solanaTrackerApiUrl: string;
    /** Market (spot and pool snapshot) URL for the fixed candidate, sent on the DEXSCREENER lane. */
    readonly marketUrl: string;
  };
  readonly credentials?: { readonly solanaTrackerApiKey?: string | undefined } | undefined;
  readonly market: { readonly parse: PaperCoordinatorMarketParser };
  readonly scannerConfig: CandidateScannerRuntimeConfig;
  readonly lpEvidenceOrigin: EvidenceOrigin;
  readonly limits: PaperCoordinatorLimits;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  /** Optional read-only evidence observer for every dispatched request (see PaperRequestSession). */
  readonly onRequestExchange?: ((evidence: PaperRequestExchangeEvidence) => void) | undefined;
}

export type PaperCoordinatorState = "NOT_STARTED" | "RUNNING" | "STOPPED";

/** One flow read made by a decision, with the snapshot it selected (kept after retirement). */
export interface PaperCoordinatorFlowRead {
  readonly evaluationTimestampMs: number;
  readonly result: CandidateFlowResult;
  readonly snapshot: ReturnType<PaperRollingCandidateFlowProvider["getSnapshotReferenceAt"]>;
  readonly epochState: ReturnType<PaperRollingCandidateFlowProvider["getEpochState"]>;
  readonly recordedGaps: ReturnType<PaperRollingCandidateFlowProvider["getRecordedGaps"]>;
}

/** Where a cached security component came from: its refresh and that refresh's requests. */
export interface PaperCoordinatorSecuritySource {
  readonly present: boolean;
  readonly retrievedAtMs: number | null;
  readonly refresh: number | null;
  readonly refreshRequestSeqs: readonly number[];
}

/** One security-evidence read made by a decision (or by intake), as the reader saw it. */
export interface PaperCoordinatorSecurityRead {
  readonly readAtMs: number;
  readonly evidence: PaperCandidateSecurityEvidence;
  readonly pendingComponents: readonly PaperSecurityEvidenceComponent[];
  readonly sources: Readonly<
    Record<PaperSecurityEvidenceComponent, PaperCoordinatorSecuritySource>
  >;
}

/** The inputs a decision actually consumed (flow and security reads, in order). */
export interface PaperCoordinatorDecisionInputs {
  readonly seq: number;
  readonly launchedAtMs: number;
  readonly flowReads: readonly PaperCoordinatorFlowRead[];
  readonly securityReads: readonly PaperCoordinatorSecurityRead[];
}

/** The session requests each security refresh dispatched (refreshes run one at a time). */
export interface PaperCoordinatorSecurityRefreshRequests {
  readonly refresh: number;
  readonly plannedDecisionMs: number;
  readonly requestSeqs: readonly number[];
  readonly settled: boolean;
}

const SECURITY_COMPONENT_KEYS: Readonly<
  Record<PaperSecurityEvidenceComponent, keyof PaperCandidateSecurityEvidence>
> = Object.freeze({
  LP: "lp",
  MINT_ACCOUNT: "mintAccount",
  RUGCHECK: "rugCheck",
  BUNDLER: "bundler",
});

export interface PaperCoordinatorDecisionRecord {
  readonly seq: number;
  readonly launchedAtMs: number;
  readonly decisionAtMs: number | null;
  readonly armed: boolean;
  readonly kind: string;
  readonly outcome: string | null;
  readonly reason: string | null;
  readonly flowReason: string | null;
  readonly flowCutoffAgeMs: number | null;
  /** Age derived from the original creation time at the actual decision time. */
  readonly assetAgeSecondsAtDecision: number | null;
  readonly preAdmissionPassed: boolean | null;
  readonly securityStatuses: Readonly<Record<string, string>> | null;
  readonly action:
    | "ARMED"
    | "KEPT_ARMED"
    | "DISARMED"
    | "DROPPED"
    | "CONFIRMED"
    | "NONE"
    | "DISCARDED_AFTER_STOP";
}

export interface PaperCoordinatorStatus {
  readonly state: PaperCoordinatorState;
  readonly stopReason: string | null;
  readonly startedAtMs: number | null;
  readonly stoppedAtMs: number | null;
  readonly schedule: {
    readonly prefetches: readonly {
      readonly epoch: number;
      readonly observationStartMs: number;
      readonly atMs: number;
    }[];
  };
  readonly intake: {
    readonly state: "PENDING" | "ADMITTED" | "REJECTED";
    readonly atMs: number | null;
    readonly reason: string | null;
  };
  readonly armedAtMs: number | null;
  /** The pool's original creation time, as observed at intake (never re-stamped). */
  readonly creation: {
    readonly openTimeSec: number;
    readonly provenance: string;
    readonly observedAtMs: number;
    readonly ageAtIntakeSec: number;
  } | null;
  /** When and why an armed candidate was disarmed. */
  readonly disarms: readonly {
    readonly atMs: number;
    readonly decisionSeq: number | null;
    readonly reason: string;
  }[];
  readonly decisions: readonly PaperCoordinatorDecisionRecord[];
  readonly refreshErrors: readonly string[];
  readonly skippedTicks: Readonly<Record<string, number>>;
  readonly activeTimers: number;
}

export interface PaperCoordinatorReport {
  readonly stopReason: string;
  readonly status: PaperCoordinatorStatus;
  readonly flow: PaperRollingFlowStopReport | null;
}

const fail = (msg: string): never => {
  throw new Error(`[PAPER_COORDINATOR_INIT] ${msg}`);
};

function validateSchedule(s: unknown): PaperCoordinatorScheduleLimits {
  const l = (s ?? {}) as Record<string, unknown>;
  const keys: readonly (keyof PaperCoordinatorScheduleLimits)[] = [
    "prefetchLeadMs",
    "confirmDelayMs",
    "decisionIntervalMs",
    "decisionLeadMs",
    "refreshHorizonMs",
    "tickMs",
    "maxDecisions",
    "maxPrefetchEpochs",
  ];
  for (const k of keys) {
    const v = l[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      fail(`limits.schedule.${k} must be a positive safe integer`);
    }
  }
  const typed = l as unknown as PaperCoordinatorScheduleLimits;
  if (typed.refreshHorizonMs > PAPER_SECURITY_CONTEXT_POLICY.maxEvidenceAgeMs) {
    fail("limits.schedule.refreshHorizonMs cannot exceed the 15 s evidence limit");
  }
  return Object.freeze({ ...typed });
}

/** Marker for an authority the validated security path did not observe as disabled. */
const UNVERIFIED_AUTHORITY = "UNVERIFIED_AUTHORITY";

export class PaperSingleCandidateCoordinator {
  private readonly target: PaperSecurityTarget;
  private readonly session: PaperRequestSession;
  private readonly provider: PaperRollingCandidateFlowProvider;
  private readonly loader: PaperCandidateSecurityEvidenceLoader;
  private readonly cache: PaperSecurityEvidenceCache;
  private readonly marketUrl: string;
  private readonly parse: PaperCoordinatorMarketParser;
  private readonly scannerConfig: CandidateScannerRuntimeConfig;
  private readonly schedule: PaperCoordinatorScheduleLimits;
  private readonly clock: () => number;
  private readonly timers: PaperRequestSessionTimers;
  private readonly activeTimers = new Set<unknown>();
  private readonly buyGate = new BuyGateTriggerService();

  private state: PaperCoordinatorState = "NOT_STARTED";
  private stopReason: string | null = null;
  private startedAtMs: number | null = null;
  private stoppedAtMs: number | null = null;
  private collection: Promise<PaperRollingFlowStopReport> | null = null;
  private readonly pendingWork = new Set<Promise<unknown>>();

  private readonly prefetches: { epoch: number; observationStartMs: number; atMs: number }[] = [];
  private lastPrefetchEpoch: number | null = null;
  private intake: {
    state: "PENDING" | "ADMITTED" | "REJECTED";
    atMs: number | null;
    reason: string | null;
  } = {
    state: "PENDING",
    atMs: null,
    reason: null,
  };
  private candidateAt: ((atMs: number) => WatchlistCandidateItem) | null = null;
  private creation: {
    readonly openTimeSec: number;
    readonly provenance: string;
    readonly observedAtMs: number;
    readonly ageAtIntakeSec: number;
  } | null = null;
  private readonly disarms: { atMs: number; decisionSeq: number | null; reason: string }[] = [];
  private armed: ArmedPullbackState | undefined;
  private nextDecisionNotBeforeMs = 0;
  private decisionInFlight = false;
  private refreshInFlight = false;
  private intakeInFlight = false;
  private decisionSeq = 0;
  private readonly decisions: PaperCoordinatorDecisionRecord[] = [];
  private readonly decisionInputs: PaperCoordinatorDecisionInputs[] = [];
  private readonly intakeSecurityReads: PaperCoordinatorSecurityRead[] = [];
  private readonly securityRefreshRequests: PaperCoordinatorSecurityRefreshRequests[] = [];
  private readonly refreshErrors: string[] = [];
  private readonly skippedTicks: Record<string, number> = {};
  private tickHandle: unknown = null;
  private finished: Promise<PaperCoordinatorReport> | null = null;

  constructor(options: PaperSingleCandidateCoordinatorOptions) {
    if (!options || typeof options !== "object") fail("options are mandatory");
    if (options.executionContext !== "PAPER_SIMULATION") {
      fail("executionContext must be PAPER_SIMULATION");
    }
    const t = options.target;
    if (
      !t ||
      !isCanonicalSolanaBase58(t.poolId) ||
      !isCanonicalSolanaBase58(t.mintAddress) ||
      t.poolId === t.mintAddress
    ) {
      fail("target must name one canonical pool and mint");
    }
    if (typeof options.market?.parse !== "function") fail("market.parse is mandatory");
    if (typeof options.endpoints?.marketUrl !== "string" || options.endpoints.marketUrl === "") {
      fail("endpoints.marketUrl is mandatory");
    }
    if (!options.scannerConfig || typeof options.scannerConfig !== "object") {
      fail("scannerConfig is mandatory");
    }
    this.target = Object.freeze({ poolId: t.poolId, mintAddress: t.mintAddress });
    this.schedule = validateSchedule(options.limits?.schedule);
    this.clock = options.clock ?? (() => Date.now());
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    // Inert construction of the accepted components on ONE session (nothing is opened or sent).
    this.session = new PaperRequestSession({
      executionContext: "PAPER_SIMULATION",
      fetchFn: options.transports.fetchFn,
      limits: options.limits.session,
      clock: this.clock,
      timers: this.timers,
      onExchangeComplete: options.onRequestExchange,
    });
    this.provider = new PaperRollingCandidateFlowProvider({
      target: { poolAddress: this.target.poolId, tokenMint: this.target.mintAddress },
      executionContext: "PAPER_SIMULATION",
      rpcUrl: options.endpoints.solanaRpcUrl,
      requestSession: this.session,
      createWebSocketTransport: options.transports.createWebSocketTransport,
      limits: options.limits.flow,
      clock: this.clock,
      timers: this.timers,
    });
    this.loader = new PaperCandidateSecurityEvidenceLoader({
      executionContext: "PAPER_SIMULATION",
      target: this.target,
      session: this.session,
      solanaRpcUrl: options.endpoints.solanaRpcUrl,
      rugCheckApiUrl: options.endpoints.rugCheckApiUrl,
      solanaTrackerApiUrl: options.endpoints.solanaTrackerApiUrl,
      solanaTrackerApiKey: options.credentials?.solanaTrackerApiKey,
      lpEvidenceOrigin: options.lpEvidenceOrigin,
      limits: options.limits.loader,
    });
    this.cache = new PaperSecurityEvidenceCache({
      loader: this.loader,
      target: this.target,
      limits: options.limits.cache,
    });
    this.marketUrl = options.endpoints.marketUrl;
    this.parse = options.market.parse;
    this.scannerConfig = Object.freeze({ ...options.scannerConfig });
  }

  // ===========================================================================================
  // Read-only views (no acquisition)
  // ===========================================================================================

  public getStatus(): PaperCoordinatorStatus {
    return Object.freeze({
      state: this.state,
      stopReason: this.stopReason,
      startedAtMs: this.startedAtMs,
      stoppedAtMs: this.stoppedAtMs,
      schedule: Object.freeze({
        prefetches: Object.freeze(this.prefetches.map((p) => ({ ...p }))),
      }),
      intake: Object.freeze({ ...this.intake }),
      armedAtMs: this.armed?.armedAtMs ?? null,
      creation: this.creation,
      disarms: Object.freeze(this.disarms.map((d) => Object.freeze({ ...d }))),
      decisions: Object.freeze([...this.decisions]),
      refreshErrors: Object.freeze([...this.refreshErrors]),
      skippedTicks: Object.freeze({ ...this.skippedTicks }),
      activeTimers: this.activeTimers.size,
    });
  }

  public getSessionStatus() {
    return this.session.getStatus();
  }

  public getFlowStatus() {
    return this.provider.getStatus();
  }

  public getCacheStatus() {
    return this.cache.getStatus();
  }

  public getLoaderStatus() {
    return this.loader.getStatus();
  }

  /** The cached security evidence as readers see it (pure read; pending components withheld). */
  public getSecurityEvidence() {
    return this.cache.getEvidence();
  }

  /** The frozen reconciliation result behind a retained flow snapshot (pure read). */
  public getFlowSnapshotResult(id: number) {
    return this.provider.getSnapshotResult(id);
  }

  /** Flow epoch state and recorded gaps (pure reads). */
  public getFlowEpochState() {
    return this.provider.getEpochState();
  }

  public getFlowRecordedGaps() {
    return this.provider.getRecordedGaps();
  }

  /** The inputs each decision consumed, kept even after the cache or snapshot was replaced. */
  public getDecisionInputs(): readonly PaperCoordinatorDecisionInputs[] {
    return Object.freeze([...this.decisionInputs]);
  }

  /** The security evidence intake read (validated-LP scanner input). */
  public getIntakeSecurityReads(): readonly PaperCoordinatorSecurityRead[] {
    return Object.freeze([...this.intakeSecurityReads]);
  }

  /** The session requests each security refresh dispatched. */
  public getSecurityRefreshRequests(): readonly PaperCoordinatorSecurityRefreshRequests[] {
    return Object.freeze(this.securityRefreshRequests.map((r) => Object.freeze({ ...r })));
  }

  /** A security read as the reader saw it, with the source of every component (pure). */
  private securityRead(evidence: PaperCandidateSecurityEvidence): PaperCoordinatorSecurityRead {
    const cache: PaperSecurityEvidenceCacheStatus = this.cache.getStatus();
    const sources = {} as Record<PaperSecurityEvidenceComponent, PaperCoordinatorSecuritySource>;
    for (const component of Object.keys(
      SECURITY_COMPONENT_KEYS,
    ) as PaperSecurityEvidenceComponent[]) {
      const present = evidence[SECURITY_COMPONENT_KEYS[component]] !== undefined;
      // A dispatched refresh always replaces the component, so its source is the last completed
      // refresh that included it.
      const record = [...cache.records].reverse().find((r) => r.components.includes(component));
      const refresh = present && record ? record.refresh : null;
      sources[component] = Object.freeze({
        present,
        retrievedAtMs: present ? cache.retrievedAtMs[component] : null,
        refresh,
        refreshRequestSeqs:
          refresh === null
            ? []
            : (this.securityRefreshRequests.find((r) => r.refresh === refresh)?.requestSeqs ?? []),
      });
    }
    return Object.freeze({
      readAtMs: this.clock(),
      evidence,
      pendingComponents: cache.pendingComponents,
      sources: Object.freeze(sources),
    });
  }

  // ===========================================================================================
  // Lifecycle
  // ===========================================================================================

  /** Starts the session, collection and scheduling. May be called once; resolves when all settles. */
  public start(): Promise<PaperCoordinatorReport> {
    if (this.state !== "NOT_STARTED") {
      return Promise.reject(new Error("[PAPER_COORDINATOR] start() may be called only once"));
    }
    this.state = "RUNNING";
    this.startedAtMs = this.clock();
    this.session.open();
    this.session.onStop((reason) => this.stop(`REQUEST_SESSION_STOPPED:${reason}`));
    this.collection = this.provider.start();
    // The end of flow collection (for any reason) ends the coordinator.
    void this.collection.then((report) => this.stop(`FLOW_COLLECTION_ENDED:${report.stopReason}`));
    this.scheduleTick(0);
    this.finished = this.settle();
    return this.finished;
  }

  /** Stops everything; no later request or decision follows. Idempotent; first cause wins. */
  public stop(reason = "COORDINATOR_STOP_REQUESTED"): void {
    if (this.state === "NOT_STARTED") {
      this.state = "STOPPED";
      this.stopReason = reason;
      this.stoppedAtMs = this.clock();
      return;
    }
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.stoppedAtMs = this.clock();
    // An armed state never outlives the coordinator.
    if (this.armed) this.recordLocalDisarm(this.stoppedAtMs, `COORDINATOR_STOPPED:${reason}`);
    for (const handle of [...this.activeTimers]) this.clearTimer(handle);
    this.tickHandle = null;
    this.loader.cancelLoads(`COORDINATOR_STOPPED:${reason}`);
    this.provider.stop(`COORDINATOR_STOPPED:${reason}`);
    this.session.stop(`COORDINATOR_STOPPED:${reason}`);
  }

  private async settle(): Promise<PaperCoordinatorReport> {
    const flow = await this.collection!;
    // Drain scheduled work (each settles promptly once the session is stopped).
    while (this.pendingWork.size > 0) {
      await Promise.allSettled([...this.pendingWork]);
    }
    for (const handle of [...this.activeTimers]) this.clearTimer(handle);
    this.state = "STOPPED";
    return { stopReason: this.stopReason ?? "UNKNOWN", status: this.getStatus(), flow };
  }

  private isActive(): boolean {
    return this.state === "RUNNING" && this.stopReason === null;
  }

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

  private track<T>(work: Promise<T>): void {
    const p = work.catch(() => undefined).finally(() => this.pendingWork.delete(p));
    this.pendingWork.add(p);
  }

  private skip(reason: string): void {
    this.skippedTicks[reason] = (this.skippedTicks[reason] ?? 0) + 1;
  }

  // ===========================================================================================
  // Scheduling (local reads on each tick; bounded actions)
  // ===========================================================================================

  private scheduleTick(ms: number): void {
    if (!this.isActive()) return;
    this.tickHandle = this.setTimer(() => this.tick(), ms);
  }

  private tick(): void {
    if (!this.isActive()) return;
    try {
      this.planPrefetch();
      this.advance();
    } finally {
      this.scheduleTick(this.schedule.tickMs);
    }
  }

  /** One prefetch per subscription epoch, derived from the epoch's warm-up (bounded). */
  private planPrefetch(): void {
    const flow = this.provider.getStatus();
    const epoch = flow.currentEpoch;
    const observationStartMs = flow.observationStartMs;
    if (epoch === null || observationStartMs === null || !flow.epochEstablished) return;
    if (this.lastPrefetchEpoch === epoch) return;
    if (this.prefetches.length >= this.schedule.maxPrefetchEpochs) return;
    this.lastPrefetchEpoch = epoch;
    const atMs = Math.max(
      this.clock(),
      observationStartMs +
        PAPER_ROLLING_FLOW_FIXED_RULES.nominalWarmUpMs -
        this.schedule.prefetchLeadMs,
    );
    this.prefetches.push({ epoch, observationStartMs, atMs });
    this.setTimer(() => {
      if (!this.isActive()) return;
      // Plan for the epoch's earliest decision: the first refresh plus the decision lead.
      this.refresh(
        observationStartMs +
          PAPER_ROLLING_FLOW_FIXED_RULES.nominalWarmUpMs +
          this.schedule.decisionLeadMs,
      );
    }, atMs - this.clock());
  }

  /** Coalesced selective refresh (one at a time; the cache's and loader's ceilings apply). */
  private refresh(plannedDecisionMs: number): void {
    if (this.refreshInFlight || !this.isActive()) return;
    if (this.cache.componentsDueAt(plannedDecisionMs).length === 0) return;
    this.refreshInFlight = true;
    // Refreshes run one at a time and are the only SECURITY dispatches, so the SECURITY entries
    // added to the ledger while this one runs are exactly its requests.
    const ledgerBefore = this.session.getLedgerLength();
    const refreshesBefore = this.cache.getStatus().refreshes;
    const pending = this.cache.refreshFor(plannedDecisionMs);
    const refreshNo = this.cache.getStatus().refreshes;
    const record =
      refreshNo > refreshesBefore
        ? { refresh: refreshNo, plannedDecisionMs, requestSeqs: [] as number[], settled: false }
        : null;
    if (record) this.securityRefreshRequests.push(record);
    this.track(
      pending
        .finally(() => {
          if (!record) return;
          record.requestSeqs = this.session
            .getLedgerSince(ledgerBefore)
            .filter((e) => e.owner === "SECURITY")
            .map((e) => e.seq);
          record.settled = true;
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.refreshErrors.push(message);
          // A spent refresh or load budget is permanent (never renewed): evidence that is due can
          // no longer be refreshed, so no further decision is possible. Stop instead of retrying.
          if (message.includes("CEILING_REACHED")) {
            this.stop(`SECURITY_REFRESH_BUDGET_EXHAUSTED:${message}`);
          }
        })
        .finally(() => {
          this.refreshInFlight = false;
        }),
    );
  }

  private advance(): void {
    const now = this.clock();
    // The daemon's 120 s armed-state prune (unchanged).
    if (this.armed && now - this.armed.armedAtMs > 120_000) {
      this.recordLocalDisarm(now, "ARMED_STATE_PRUNED_AFTER_120_S");
    }
    if (this.decisionInFlight) return this.skip("DECISION_IN_FLIGHT");
    if (this.intake.state === "REJECTED") return;
    // Scanner intake runs once, after the first prefetch has settled. The scanner itself decides
    // on missing, mismatched or below-threshold LP evidence.
    if (this.intake.state === "PENDING") {
      if (this.refreshInFlight) return this.skip("REFRESH_PENDING");
      if (this.cache.getStatus().refreshes === 0) return this.skip("PREFETCH_NOT_DONE");
      if (!this.intakeInFlight) this.runIntake();
      return this.skip("INTAKE_PENDING");
    }
    // An armed candidate's planned decision is never postponed until evidence looks favourable:
    // when it is due, the existing entry path runs whatever the evidence. Unavailable flow or
    // withheld, stale or pending security is rejected there, and the existing rules disarm.
    // (Local polling ticks between decisions do not decide.)
    if (this.armed && now >= this.nextDecisionNotBeforeMs) {
      if (this.decisions.length >= this.schedule.maxDecisions) {
        // No decision can be made: the armed state is not kept without one.
        this.recordLocalDisarm(now, "DECISION_BUDGET_SPENT_WHILE_ARMED");
        this.stop("DECISION_BUDGET_EXHAUSTED_WHILE_ARMED");
        return;
      }
      this.launchDecision(now);
      return;
    }
    if (this.refreshInFlight) return this.skip("REFRESH_PENDING");
    const flow: CandidateFlowResult = this.provider.getCandidateFlow(
      { poolAddress: this.target.poolId, tokenMint: this.target.mintAddress },
      now,
    );
    if (!flow.isCoverageSufficient) return this.skip("FLOW_UNAVAILABLE");
    if (now < this.nextDecisionNotBeforeMs) return this.skip("WAITING_FOR_PLANNED_DECISION");
    if (this.decisions.length >= this.schedule.maxDecisions)
      return this.skip("DECISION_BUDGET_SPENT");
    const due = this.cache.componentsDueAt(now + this.schedule.decisionLeadMs);
    if (due.length > 0) {
      this.refresh(now + this.schedule.refreshHorizonMs);
      return this.skip("SECURITY_REFRESH_NEEDED");
    }
    this.launchDecision(now);
  }

  // ===========================================================================================
  // Scanner intake (validated-LP mode, evaluatePoolAsync only)
  // ===========================================================================================

  private runIntake(): void {
    this.intakeInFlight = true;
    this.track(
      (async () => {
        const market = await this.marketRequest("MARKET_INTAKE");
        if (!this.isActive()) return;
        const now = this.clock();
        if (!market) {
          this.rejectIntake(now, "MARKET_INTAKE_UNAVAILABLE");
          return;
        }
        const pool = market.pool;
        if (pool.poolId !== this.target.poolId || pool.mintAddress !== this.target.mintAddress) {
          this.rejectIntake(now, "MARKET_IDENTITY_MISMATCH");
          return;
        }
        // Authorities come only from the validated security path: an authority not explicitly
        // observed as disabled is never presented to the scanner as renounced.
        const intakeEvidence = this.cache.getEvidence();
        this.intakeSecurityReads.push(this.securityRead(intakeEvidence));
        const security = await evaluatePaperCandidateSecurityContext({
          executionContext: "PAPER_SIMULATION",
          target: this.target,
          decisionTimeMs: now,
          evidence: intakeEvidence,
        });
        const authority = (e: (typeof security.authorities)["mintAuthority"]) =>
          e?.status === "DISABLED" ? null : (e?.address ?? UNVERIFIED_AUTHORITY);
        const validatedPool: ScannedPoolRecord = {
          ...pool,
          mintAuthority: authority(security.authorities.mintAuthority),
          freezeAuthority: authority(security.authorities.freezeAuthority),
        };
        const scanner = new CandidateStreamEngine({
          config: this.scannerConfig,
          requireValidatedLp: true,
          enableDexScreener: false,
          fetchFn: (() =>
            Promise.reject(
              new Error("scanner network access is disabled"),
            )) as unknown as typeof fetch,
          lpEvidenceResolver: (candidate) =>
            candidate.poolId === this.target.poolId &&
            candidate.mintAddress === this.target.mintAddress
              ? (this.cache.getEvidence().lp ?? null)
              : null,
          lpFreshnessPolicy: {
            maxEvidenceAgeMs: PAPER_SECURITY_CONTEXT_POLICY.maxEvidenceAgeMs,
            currentTimestampMs: now,
            clockSkewToleranceMs: PAPER_SECURITY_CONTEXT_POLICY.lpClockSkewToleranceMs,
          },
        });
        const result: CandidateScannerEvaluationResult = await scanner.evaluatePoolAsync(
          validatedPool,
          Math.floor(now / 1000),
        );
        if (!this.isActive()) return;
        if (!result.admitted || !result.candidate) {
          this.rejectIntake(now, `SCANNER_REJECTED:${result.primaryRejectionReason ?? "UNKNOWN"}`);
          return;
        }
        const nowSec = Math.floor(now / 1000);
        // The pool's original creation time and its provenance are kept; age is derived from it at
        // each actual decision time and never reset by later market requests.
        this.creation = Object.freeze({
          openTimeSec: pool.openTimeSec,
          provenance: pool.metricProvenance?.tokenAgeSec ?? "OBSERVED",
          observedAtMs: now,
          ageAtIntakeSec: Math.max(0, nowSec - pool.openTimeSec),
        });
        const discoveredAt = new Date(now).toISOString();
        const lpBurnPct = result.candidate.lpBurnPct;
        this.candidateAt = (atMs: number): WatchlistCandidateItem =>
          ({
            poolId: this.target.poolId,
            mintAddress: this.target.mintAddress,
            symbol: pool.symbol,
            liquidityUsd: pool.liquidityUsd,
            marketCapUsd: pool.marketCapUsd,
            lmcRatio: pool.marketCapUsd > 0 ? pool.liquidityUsd / pool.marketCapUsd : 0,
            lpBurnPct,
            assetAgeSeconds: Math.max(0, Math.floor(atMs / 1000) - pool.openTimeSec),
            volume5mUsd: pool.volume5mUsd,
            buys5m: pool.buys5m,
            sells5m: pool.sells5m,
            buyToSellRatio: pool.sells5m > 0 ? pool.buys5m / pool.sells5m : pool.buys5m,
            status: "WATCHING",
            discoveredAt,
            lastEvaluatedAt: new Date(atMs).toISOString(),
          }) as WatchlistCandidateItem;
        this.intake = { state: "ADMITTED", atMs: now, reason: null };
      })().finally(() => {
        this.intakeInFlight = false;
      }),
    );
  }

  private recordLocalDisarm(now: number, reason: string): void {
    this.disarms.push({ atMs: now, decisionSeq: null, reason });
    this.armed = undefined;
  }

  private rejectIntake(now: number, reason: string): void {
    this.intake = { state: "REJECTED", atMs: now, reason };
    this.stop(`INTAKE_REJECTED:${reason}`);
  }

  /** The one accounted market request (DEXSCREENER lane); null when unavailable or stopped. */
  private async marketRequest(purpose: string) {
    const exchange = await this.session.dispatch({
      lane: "DEXSCREENER",
      owner: "SPOT",
      purpose,
      requestedIdentity: this.target.mintAddress,
      url: this.marketUrl,
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!this.isActive() || !exchange.ok || !exchange.bodyComplete || exchange.text === undefined) {
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(exchange.text);
    } catch {
      return null;
    }
    return this.parse(json, this.target, this.clock());
  }

  // ===========================================================================================
  // Decisions (existing entry helper and retest rules; records only, never execution)
  // ===========================================================================================

  private launchDecision(launchedAtMs: number): void {
    const candidateAt = this.candidateAt;
    if (!candidateAt) return;
    const candidate = candidateAt(launchedAtMs);
    this.decisionInFlight = true;
    const wasArmed = this.armed !== undefined;
    const seq = ++this.decisionSeq;
    // Record what this decision actually reads (the same calls, unchanged results), so its inputs
    // stay reviewable after the cache or the flow snapshot is replaced or retired.
    const flowReads: PaperCoordinatorFlowRead[] = [];
    const securityReads: PaperCoordinatorSecurityRead[] = [];
    this.decisionInputs.push(Object.freeze({ seq, launchedAtMs, flowReads, securityReads }));
    const securityPath = this.cache.asSecurityPath();
    this.track(
      retrieveAndEvaluatePaperDaemonEntry({
        candidate,
        flowProvider: {
          getCandidateFlow: (target, evaluationTimestampMs) => {
            const result = this.provider.getCandidateFlow(target, evaluationTimestampMs);
            flowReads.push(
              Object.freeze({
                evaluationTimestampMs,
                result,
                snapshot: this.provider.getSnapshotReferenceAt(evaluationTimestampMs),
                epochState: this.provider.getEpochState(),
                recordedGaps: this.provider.getRecordedGaps(),
              }),
            );
            return result;
          },
        },
        buyGateService: this.buyGate,
        getExistingArmedState: () => this.armed,
        clock: this.clock,
        retrievals: {
          fetchSpotInfo: async () => (await this.marketRequest("SPOT_PRICE"))?.spot ?? null,
          fetchRugCheckMetrics: () =>
            Promise.reject(
              new Error("the direct RugCheck retrieval is not used by the coordinator"),
            ),
        },
        security: {
          executionContext: securityPath.executionContext,
          loadEvidence: async (target) => {
            const evidence = await securityPath.loadEvidence(target);
            securityReads.push(this.securityRead(evidence));
            return evidence;
          },
        },
        // Age, cohort, maturity and retest use the actual post-retrieval decision time.
        candidateAtDecision: candidateAt,
      })
        .then((entry) => this.onDecision(seq, launchedAtMs, wasArmed, entry))
        .finally(() => {
          this.decisionInFlight = false;
        }),
    );
  }

  private onDecision(
    seq: number,
    launchedAtMs: number,
    wasArmed: boolean,
    entry: PaperDaemonEntryEvaluation<PaperDaemonEntrySpotInput, never>,
  ): void {
    const base = { seq, launchedAtMs, armed: wasArmed };
    if (!this.isActive()) {
      this.decisions.push(
        Object.freeze({
          ...base,
          decisionAtMs: null,
          kind: entry.kind,
          outcome: null,
          reason: null,
          flowReason: null,
          flowCutoffAgeMs: null,
          assetAgeSecondsAtDecision: null,
          preAdmissionPassed: null,
          securityStatuses: null,
          action: "DISCARDED_AFTER_STOP" as const,
        }),
      );
      return;
    }
    const now = this.clock();
    let action: PaperCoordinatorDecisionRecord["action"] = "NONE";
    let outcome: string | null = null;
    let reason: string | null = null;
    let flowReason: string | null = null;
    let flowCutoffAgeMs: number | null = null;
    const ctx = entry.kind === "NO_ACTIVE_DEX_PAIR" ? undefined : entry.security?.context;
    if (entry.kind === "NO_ACTIVE_DEX_PAIR") {
      reason = "NO_ACTIVE_DEX_PAIR";
    } else if (entry.kind === "SECURITY_REJECTED") {
      reason = entry.reason;
      // As at the daemon call site: a security rejection disarms.
      if (this.armed) action = "DISARMED";
      this.armed = undefined;
    } else {
      const d = entry.decision;
      outcome = d.outcome;
      reason = d.rejectionReason ?? null;
      flowReason = d.flowResult.diagnosticReason;
      flowCutoffAgeMs = d.flowResult.paperQualificationContext?.cutoffAgeMs ?? null;
      switch (d.outcome) {
        case "ARMED_FIRST_TICK":
          this.armed = d.retestResult.updatedArmedState;
          action = "ARMED";
          break;
        case "RETEST_WAITING":
          this.armed = d.retestResult.updatedArmedState;
          action = "KEPT_ARMED";
          break;
        case "BUY_GATE_REJECTED":
          if (this.armed) action = "DISARMED";
          this.armed = undefined;
          break;
        case "INSUFFICIENT_LIVE_LIQUIDITY":
        case "RETEST_REJECTED":
          this.armed = undefined;
          action = "DROPPED";
          break;
        case "RETEST_CONFIRMED":
          this.armed = undefined;
          action = "CONFIRMED";
          break;
      }
    }
    if (action === "DISARMED" || (action === "DROPPED" && wasArmed)) {
      this.disarms.push({
        atMs: entry.kind === "NO_ACTIVE_DEX_PAIR" ? now : entry.decisionNowMs,
        decisionSeq: seq,
        reason: reason ?? flowReason ?? outcome ?? entry.kind,
      });
    }
    this.decisions.push(
      Object.freeze({
        ...base,
        decisionAtMs: entry.kind === "NO_ACTIVE_DEX_PAIR" ? null : entry.decisionNowMs,
        kind: entry.kind,
        outcome,
        reason,
        flowReason,
        flowCutoffAgeMs,
        assetAgeSecondsAtDecision:
          entry.kind === "NO_ACTIVE_DEX_PAIR" || !this.creation
            ? null
            : Math.max(0, Math.floor(entry.decisionNowMs / 1000) - this.creation.openTimeSec),
        preAdmissionPassed: ctx?.preAdmission.passed ?? null,
        securityStatuses: ctx
          ? Object.freeze({
              lp: ctx.lp.status,
              authorities: ctx.authorities.status,
              rugCheck: ctx.rugCheck.status,
              bundler: ctx.bundler.status,
            })
          : null,
        action,
      }),
    );
    if (action === "CONFIRMED") {
      this.stop("ENTRY_CONFIRMED_NO_EXECUTION");
      return;
    }
    if (action === "DROPPED") {
      this.stop(`CANDIDATE_DROPPED:${outcome}`);
      return;
    }
    if (this.armed) {
      // Plan the confirmation and refresh only what would expire before it.
      const planned = now + this.schedule.confirmDelayMs;
      this.nextDecisionNotBeforeMs = planned;
      this.refresh(planned + this.schedule.decisionLeadMs);
    } else {
      this.nextDecisionNotBeforeMs = now + this.schedule.decisionIntervalMs;
    }
  }
}
