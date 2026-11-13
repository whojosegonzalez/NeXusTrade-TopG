/**
 * Phase 12.94-D D.3.3: PAPER request session (one request-accounting boundary; offline-tested only).
 *
 * The serialized, paced, bounded HTTP dispatcher extracted from PaperRollingCandidateFlowProvider so
 * that flow collection, security-evidence retrieval and any accounted spot-price request share ONE:
 *
 * - session-wide HTTP-attempt ceiling and ledger (never reset);
 * - absolute deadline from open();
 * - per-lane serialization and minimum dispatch-to-dispatch pacing (Solana RPC >= 2,500 ms);
 * - stop on the first HTTP 429 (recognised from headers) and on any redirect;
 * - bounded body reads with bounded cancellation, and a per-request timeout.
 *
 * Accounting: only an actual dispatch is counted, exactly once (ledger and budget alike). Admission
 * checks, refusals and cancellations before dispatch are never counted. The ledger records request
 * identity, JSON-RPC id, owner, purpose, dispatch and completion times, HTTP status and body
 * completeness; it never records URLs or headers, so credentials cannot appear in it.
 *
 * Boundaries: importing and constructing a session is inert. Requests are possible only after an
 * explicit open() and only under PAPER_SIMULATION. Transport, clock, timers and every limit are
 * injected; there are no default limits.
 */

import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { RequestPurpose } from "../research/prospective/GlobalResourceBudgetManager.js";
import { boundedCancel, readBoundedStream } from "./RaydiumTransportObservationProbe.js";

export const PAPER_REQUEST_LANES = Object.freeze([
  "SOLANA_RPC",
  "RUGCHECK",
  "SOLANA_TRACKER",
  "DEXSCREENER",
] as const);
export type PaperRequestLane = (typeof PAPER_REQUEST_LANES)[number];
export type PaperRequestOwner = "FLOW" | "SECURITY" | "SPOT";

/** Minimum Solana RPC dispatch-to-dispatch spacing (unchanged rule). */
export const MIN_SOLANA_RPC_PACING_MS = 2_500;

export interface PaperRequestLaneLimits {
  /** Attempts allowed on this lane (0 disables it). Counted against the session ceiling too. */
  readonly maxAttempts: number;
  /** Minimum dispatch-to-dispatch spacing on this lane. */
  readonly pacingMs: number;
  /** Decoded response-body ceiling per request on this lane (bytes). */
  readonly maxResponseBytes: number;
}

/** Explicit limits. Every field is mandatory; no value is approved for live execution. */
export interface PaperRequestSessionLimits {
  /** Absolute lifetime from open(). Never extended. */
  readonly lifetimeMs: number;
  /** Session-wide HTTP-attempt ceiling across every lane and owner. */
  readonly maxHttpAttempts: number;
  /** Per-request timeout (headers and body together). */
  readonly requestTimeoutMs: number;
  readonly lanes: Readonly<Record<PaperRequestLane, PaperRequestLaneLimits>>;
}

export interface PaperRequestSessionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const DEFAULT_TIMERS: PaperRequestSessionTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PaperRequestSessionOptions {
  readonly executionContext: "PAPER_SIMULATION";
  /** Injected HTTP transport. Mandatory; no default networking. */
  readonly fetchFn: typeof fetch;
  readonly limits: PaperRequestSessionLimits;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
}

export interface PaperRequestLedgerEntry {
  readonly seq: number;
  readonly lane: PaperRequestLane;
  readonly owner: PaperRequestOwner;
  readonly purpose: string;
  /** The pool, mint or account the request was for. */
  readonly requestedIdentity: string;
  /** JSON-RPC id sent in the body, when the request is JSON-RPC. */
  readonly jsonRpcId: number | string | null;
  readonly dispatchedAtMs: number;
  readonly completedAtMs: number | null;
  readonly httpStatus: number | null;
  /** True only when the whole body was read within the lane's limit. */
  readonly bodyComplete: boolean;
  readonly error: string | null;
}

type MutableLedgerEntry = {
  -readonly [K in keyof PaperRequestLedgerEntry]: PaperRequestLedgerEntry[K];
};

export interface PaperRequestExchange {
  readonly dispatched: boolean;
  readonly ok: boolean;
  readonly status?: number | undefined;
  /** Present only when the body was read completely. */
  readonly text?: string | undefined;
  readonly bodyComplete: boolean;
  readonly error?: string | undefined;
  readonly entry?: PaperRequestLedgerEntry | undefined;
}

export interface PaperRequestDispatch {
  readonly lane: PaperRequestLane;
  readonly owner: PaperRequestOwner;
  readonly purpose: string;
  readonly requestedIdentity: string;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly jsonRpcId?: number | string | null | undefined;
  /** Owner refusal, checked before and after every pacing wait and immediately before dispatch. */
  readonly refusal?: (() => string | null) | undefined;
  /** Checked once after pacing; a non-null value declines the request (never terminal). */
  readonly precondition?: (() => string | null) | undefined;
  /** Signals that cut a pacing wait short (the request is then re-checked, not sent). */
  readonly waitSignals?: readonly AbortSignal[] | undefined;
  /** Signals linked to the in-flight request, read at dispatch time. */
  readonly linkSignals?: (() => readonly AbortSignal[]) | undefined;
  /** Called exactly once, synchronously, when the request is counted and about to be sent. */
  readonly onDispatched?: ((entry: PaperRequestLedgerEntry) => void) | undefined;
  /** Owner's own per-request timeout; the stricter of this and the session's applies. */
  readonly timeoutMs?: number | undefined;
  /** Owner's own body ceiling; the stricter of this and the lane's applies. */
  readonly maxResponseBytes?: number | undefined;
}

export interface PaperRequestSessionStatus {
  readonly state: "NOT_OPEN" | "OPEN" | "STOPPED";
  readonly stopReason: string | null;
  readonly openedAtMs: number | null;
  readonly stoppedAtMs: number | null;
  readonly deadlineMs: number | null;
  readonly httpAttempts: number;
  readonly budgetManagerAttempts: number;
  readonly attemptsByLane: Readonly<Record<PaperRequestLane, number>>;
  readonly maxConcurrentByLane: Readonly<Record<PaperRequestLane, number>>;
  readonly inFlight: number;
  readonly activeTimers: number;
  readonly ledger: readonly PaperRequestLedgerEntry[];
  /** Refused (never sent, never counted) requests by reason, for observability. */
  readonly refusalsByReason: Readonly<Record<string, number>>;
}

/** Session stops: the first cause wins and every listener (flow provider, loader) is told once. */
const SESSION_TERMINAL_REFUSALS: ReadonlySet<string> = new Set([
  "LIFETIME_EXPIRED",
  "HTTP_ATTEMPT_CEILING_REACHED",
  "BUDGET_MANAGER_DENIED",
]);

/**
 * Shared budget: callers' recordRequestAttempt() is ADMISSION only (pacing and ceiling checks, never
 * counted); the session counts each ACTUAL dispatch exactly once through recordActualDispatch().
 * The shared GlobalResourceBudgetManager class is unchanged for other callers.
 */
export class PaperSessionDispatchBudget extends GlobalResourceBudgetManager {
  public override recordRequestAttempt(
    providerName: string,
    purpose: RequestPurpose,
    nowMs?: number,
  ): boolean {
    return this.canMakeRequest(providerName, nowMs, purpose).allowed;
  }

  public recordActualDispatch(nowMs: number, providerName: string = "SOLANA_RPC"): boolean {
    return super.recordRequestAttempt(providerName, "CANDIDATE_ENRICHMENT", nowMs);
  }
}

function isSafeInteger(v: unknown, min: number): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min;
}

/** Validates explicit limits; throws `[PAPER_REQUEST_SESSION_INIT]` on any invalid or unsafe value. */
export function validatePaperRequestSessionLimits(limits: unknown): PaperRequestSessionLimits {
  const fail = (msg: string): never => {
    throw new Error(`[PAPER_REQUEST_SESSION_INIT] ${msg}`);
  };
  if (!limits || typeof limits !== "object") fail("limits are mandatory");
  const l = limits as Record<string, unknown>;
  for (const k of ["lifetimeMs", "maxHttpAttempts", "requestTimeoutMs"] as const) {
    if (!isSafeInteger(l[k], 1)) fail(`limits.${k} must be a positive safe integer`);
  }
  const lanes = l.lanes as Record<string, unknown> | undefined;
  if (!lanes || typeof lanes !== "object") fail("limits.lanes is mandatory");
  const frozenLanes: Partial<Record<PaperRequestLane, PaperRequestLaneLimits>> = {};
  for (const lane of PAPER_REQUEST_LANES) {
    const v = lanes![lane] as Record<string, unknown> | undefined;
    if (!v || typeof v !== "object") fail(`limits.lanes.${lane} is mandatory`);
    if (!isSafeInteger(v!.maxAttempts, 0)) fail(`limits.lanes.${lane}.maxAttempts must be >= 0`);
    if (!isSafeInteger(v!.pacingMs, 1)) fail(`limits.lanes.${lane}.pacingMs must be positive`);
    if (!isSafeInteger(v!.maxResponseBytes, 1)) {
      fail(`limits.lanes.${lane}.maxResponseBytes must be positive`);
    }
    if ((v!.maxAttempts as number) > (l.maxHttpAttempts as number)) {
      fail(`limits.lanes.${lane}.maxAttempts cannot exceed maxHttpAttempts`);
    }
    frozenLanes[lane] = Object.freeze({
      maxAttempts: v!.maxAttempts as number,
      pacingMs: v!.pacingMs as number,
      maxResponseBytes: v!.maxResponseBytes as number,
    });
  }
  if (frozenLanes.SOLANA_RPC!.pacingMs < MIN_SOLANA_RPC_PACING_MS) {
    fail("limits.lanes.SOLANA_RPC.pacingMs must be at least 2500 ms");
  }
  return Object.freeze({
    lifetimeMs: l.lifetimeMs as number,
    maxHttpAttempts: l.maxHttpAttempts as number,
    requestTimeoutMs: l.requestTimeoutMs as number,
    lanes: Object.freeze(frozenLanes as Record<PaperRequestLane, PaperRequestLaneLimits>),
  });
}

/** The stricter (smaller) of a session limit and an owner's optional positive limit. */
function stricter(sessionLimit: number, ownerLimit: number | undefined): number {
  return typeof ownerLimit === "number" && Number.isSafeInteger(ownerLimit) && ownerLimit > 0
    ? Math.min(sessionLimit, ownerLimit)
    : sessionLimit;
}

function cancelResponseBody(response: Response, reason: string): void {
  if (response.body) void boundedCancel(response.body, new Error(reason), 500);
}

const laneRecord = <T>(value: () => T): Record<PaperRequestLane, T> =>
  Object.fromEntries(PAPER_REQUEST_LANES.map((lane) => [lane, value()])) as Record<
    PaperRequestLane,
    T
  >;

export class PaperRequestSession {
  public readonly limits: PaperRequestSessionLimits;
  public readonly budget: PaperSessionDispatchBudget;
  private readonly fetchFn: typeof fetch;
  private readonly clockFn: () => number;
  private readonly timers: PaperRequestSessionTimers;
  private readonly activeTimers = new Set<unknown>();

  private state: "NOT_OPEN" | "OPEN" | "STOPPED" = "NOT_OPEN";
  private stopReason: string | null = null;
  private openedAtMs: number | null = null;
  private stoppedAtMs: number | null = null;
  private deadlineMs: number | null = null;
  private readonly abort = new AbortController();
  private readonly stopListeners: ((reason: string) => void)[] = [];

  private readonly ledger: MutableLedgerEntry[] = [];
  private readonly chains = laneRecord<Promise<void>>(() => Promise.resolve());
  private readonly lastDispatchAtMs = laneRecord<number | null>(() => null);
  private readonly attemptsByLane = laneRecord(() => 0);
  private readonly inFlightByLane = laneRecord(() => 0);
  private readonly maxConcurrentByLane = laneRecord(() => 0);
  private jsonRpcIdSeq = 0;
  private readonly refusalsByReason: Record<string, number> = {};

  constructor(options: PaperRequestSessionOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("[PAPER_REQUEST_SESSION_INIT] options are mandatory");
    }
    if (options.executionContext !== "PAPER_SIMULATION") {
      throw new Error("[PAPER_REQUEST_SESSION_INIT] executionContext must be PAPER_SIMULATION");
    }
    if (typeof options.fetchFn !== "function") {
      throw new Error("[PAPER_REQUEST_SESSION_INIT] fetchFn is mandatory (no default networking)");
    }
    this.limits = validatePaperRequestSessionLimits(options.limits);
    this.fetchFn = options.fetchFn;
    this.clockFn = options.clock ?? (() => Date.now());
    this.timers = options.timers ?? DEFAULT_TIMERS;
    // Spacing is enforced per lane by the session before a dispatch is recorded, so the budget's own
    // spacing is the smallest lane pacing and can never deny a dispatch the session has paced.
    this.budget = new PaperSessionDispatchBudget({
      maxTotalRequests: this.limits.maxHttpAttempts,
      maxEnrichmentAttempts: this.limits.maxHttpAttempts,
      minReservedForwardRequests: 0,
      minProviderSpacingMs: Math.min(
        ...PAPER_REQUEST_LANES.map((lane) => this.limits.lanes[lane].pacingMs),
      ),
      clock: this.clockFn,
    });
  }

  public now(): number {
    return this.clockFn();
  }

  /** Session-wide JSON-RPC id sequence (unique across owners). */
  public nextJsonRpcId(): number {
    return ++this.jsonRpcIdSeq;
  }

  public isOpen(): boolean {
    return this.state === "OPEN" && this.stopReason === null;
  }

  public getStopReason(): string | null {
    return this.stopReason;
  }

  public getDeadlineMs(): number | null {
    return this.deadlineMs;
  }

  /** Starts the absolute lifetime. May be called once. */
  public open(): void {
    if (this.state !== "NOT_OPEN") {
      throw new Error("[PAPER_REQUEST_SESSION] open() may be called only once");
    }
    this.state = "OPEN";
    this.openedAtMs = this.clockFn();
    this.deadlineMs = this.openedAtMs + this.limits.lifetimeMs;
    this.setTimer(() => this.stop("LIFETIME_EXPIRED"), this.limits.lifetimeMs);
  }

  /** Registers a listener told once when the session stops (immediately if already stopped). */
  public onStop(listener: (reason: string) => void): void {
    if (this.stopReason !== null) {
      listener(this.stopReason);
      return;
    }
    this.stopListeners.push(listener);
  }

  /** First cause wins; pending waits and in-flight requests are aborted; every timer is cleared. */
  public stop(reason = "SESSION_STOP_REQUESTED"): void {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.stoppedAtMs = this.clockFn();
    this.state = "STOPPED";
    this.abort.abort();
    for (const handle of [...this.activeTimers]) this.clearTimer(handle);
    const listeners = this.stopListeners.splice(0);
    for (const listener of listeners) listener(reason);
  }

  public getStatus(): PaperRequestSessionStatus {
    return Object.freeze({
      state: this.state,
      stopReason: this.stopReason,
      openedAtMs: this.openedAtMs,
      stoppedAtMs: this.stoppedAtMs,
      deadlineMs: this.deadlineMs,
      httpAttempts: this.ledger.length,
      budgetManagerAttempts: this.budget.getTotalRequests(),
      attemptsByLane: Object.freeze({ ...this.attemptsByLane }),
      maxConcurrentByLane: Object.freeze({ ...this.maxConcurrentByLane }),
      inFlight: PAPER_REQUEST_LANES.reduce((n, lane) => n + this.inFlightByLane[lane], 0),
      activeTimers: this.activeTimers.size,
      ledger: Object.freeze(this.ledger.map((e) => Object.freeze({ ...e }))),
      refusalsByReason: Object.freeze({ ...this.refusalsByReason }),
    });
  }

  public getActiveTimerCount(): number {
    return this.activeTimers.size;
  }

  public getMaxConcurrent(lane: PaperRequestLane): number {
    return this.maxConcurrentByLane[lane];
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

  /** Waits at most `ms`, never past the session deadline; resolves early on stop or any signal. */
  public sleep(ms: number, signals: readonly AbortSignal[] = []): Promise<void> {
    const all = [this.abort.signal, ...signals];
    const remaining =
      this.deadlineMs === null ? ms : Math.max(0, Math.min(ms, this.deadlineMs - this.clockFn()));
    return new Promise<void>((resolve) => {
      if (all.some((s) => s.aborted)) {
        resolve();
        return;
      }
      let handle: unknown = null;
      const done = () => {
        this.clearTimer(handle);
        for (const s of all) s.removeEventListener("abort", done);
        resolve();
      };
      handle = this.setTimer(done, remaining);
      for (const s of all) s.addEventListener("abort", done, { once: true });
    });
  }

  private sessionRefusal(
    lane: PaperRequestLane,
    waitSignals: readonly AbortSignal[],
  ): string | null {
    if (this.state === "NOT_OPEN") return "REQUEST_SESSION_NOT_OPEN";
    if (this.stopReason !== null) return "REQUEST_SESSION_STOPPED";
    if (this.deadlineMs !== null && this.clockFn() >= this.deadlineMs) return "LIFETIME_EXPIRED";
    if (waitSignals.some((s) => s.aborted)) return "CALLER_CANCELLED";
    if (this.ledger.length >= this.limits.maxHttpAttempts) return "HTTP_ATTEMPT_CEILING_REACHED";
    if (this.attemptsByLane[lane] >= this.limits.lanes[lane].maxAttempts) {
      return `${lane}_ATTEMPT_CEILING_REACHED`;
    }
    return null;
  }

  private refusalOf(req: PaperRequestDispatch): string | null {
    return req.refusal?.() ?? this.sessionRefusal(req.lane, req.waitSignals ?? []);
  }

  private refuse(error: string): PaperRequestExchange {
    this.refusalsByReason[error] = (this.refusalsByReason[error] ?? 0) + 1;
    if (SESSION_TERMINAL_REFUSALS.has(error)) this.stop(error);
    return { dispatched: false, ok: false, bodyComplete: false, error };
  }

  /** Serialized and paced per lane; counted exactly once at dispatch; bounded throughout. */
  public async dispatch(req: PaperRequestDispatch): Promise<PaperRequestExchange> {
    const lane = req.lane;
    const previous = this.chains[lane];
    let release!: () => void;
    this.chains[lane] = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const laneLimits = this.limits.lanes[lane];
      for (;;) {
        const refusal = this.refusalOf(req);
        if (refusal) return this.refuse(refusal);
        const last = this.lastDispatchAtMs[lane];
        const wait = last === null ? 0 : last + laneLimits.pacingMs - this.clockFn();
        if (wait <= 0) break;
        await this.sleep(wait, req.waitSignals ?? []);
      }
      const pre = req.precondition?.() ?? null;
      if (pre) return { dispatched: false, ok: false, bodyComplete: false, error: pre };
      // Immediate pre-dispatch recheck: stop, deadline, cancellation and ceilings.
      const late = this.refusalOf(req);
      if (late) return this.refuse(late);
      const now = this.clockFn();
      // The only place a dispatch is counted.
      if (!this.budget.recordActualDispatch(now, lane)) return this.refuse("BUDGET_MANAGER_DENIED");

      const entry: MutableLedgerEntry = {
        seq: this.ledger.length + 1,
        lane,
        owner: req.owner,
        purpose: req.purpose,
        requestedIdentity: req.requestedIdentity,
        jsonRpcId: req.jsonRpcId ?? null,
        dispatchedAtMs: now,
        completedAtMs: null,
        httpStatus: null,
        bodyComplete: false,
        error: null,
      };
      this.ledger.push(entry);
      this.lastDispatchAtMs[lane] = now;
      this.attemptsByLane[lane]++;
      this.inFlightByLane[lane]++;
      this.maxConcurrentByLane[lane] = Math.max(
        this.maxConcurrentByLane[lane],
        this.inFlightByLane[lane],
      );
      req.onDispatched?.(entry);
      return await this.exchange(
        req,
        entry,
        stricter(laneLimits.maxResponseBytes, req.maxResponseBytes),
        stricter(this.limits.requestTimeoutMs, req.timeoutMs),
      );
    } finally {
      release();
    }
  }

  private async exchange(
    req: PaperRequestDispatch,
    entry: MutableLedgerEntry,
    maxResponseBytes: number,
    timeoutMs: number,
  ): Promise<PaperRequestExchange> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    const linked: AbortSignal[] = [this.abort.signal, ...(req.linkSignals?.() ?? [])];
    for (const s of linked) s.addEventListener("abort", onAbort, { once: true });
    if (linked.some((s) => s.aborted)) controller.abort();
    const timer = this.setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let abortReject: ((e: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    const onControllerAbort = () => abortReject?.(new Error("REQUEST_ABORTED"));
    controller.signal.addEventListener("abort", onControllerAbort, { once: true });
    if (controller.signal.aborted) onControllerAbort();
    aborted.catch(() => undefined);
    const fail = (error: string, status?: number): PaperRequestExchange => {
      entry.error = error;
      return {
        dispatched: true,
        ok: false,
        bodyComplete: false,
        error,
        ...(status !== undefined ? { status } : {}),
        entry,
      };
    };
    try {
      const response = await Promise.race([
        this.fetchFn(req.url, {
          method: req.method,
          headers: { ...(req.headers ?? {}) },
          ...(req.body !== undefined ? { body: req.body } : {}),
          signal: controller.signal,
          redirect: "manual", // never follow redirects
        }),
        aborted,
      ]);
      entry.httpStatus = response.status;
      this.budget.recordResponseStatus(response.status);
      // The first 429 stops the whole session; recognised from headers, before any body read.
      if (response.status === 429) {
        cancelResponseBody(response, "HTTP_429_RECEIVED");
        this.stop("HTTP_429_RECEIVED");
        return fail("HTTP_429_RECEIVED", 429);
      }
      if (
        (response.status >= 300 && response.status < 400) ||
        response.type === "opaqueredirect" ||
        response.redirected
      ) {
        cancelResponseBody(response, "HTTP_REDIRECT_REJECTED");
        this.stop("HTTP_REDIRECT_REJECTED");
        return fail("HTTP_REDIRECT_REJECTED", response.status);
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && Number(declared) > maxResponseBytes) {
        cancelResponseBody(response, "RESPONSE_TOO_LARGE");
        return fail("RESPONSE_TOO_LARGE", response.status);
      }
      let text = "";
      if (response.body) {
        const read = await Promise.race([
          readBoundedStream(response.body, maxResponseBytes, controller.signal),
          aborted,
        ]);
        if (read.overflow) return fail("RESPONSE_TOO_LARGE", response.status);
        text = read.bytes.toString("utf8");
      }
      entry.bodyComplete = true;
      return {
        dispatched: true,
        ok: response.ok,
        status: response.status,
        text,
        bodyComplete: true,
        entry,
      };
    } catch {
      // A status already received from the headers is kept; the body stays incomplete.
      return fail(
        timedOut
          ? "REQUEST_TIMED_OUT"
          : controller.signal.aborted
            ? "REQUEST_ABORTED"
            : "NETWORK_ERROR",
        entry.httpStatus ?? undefined,
      );
    } finally {
      this.clearTimer(timer);
      controller.signal.removeEventListener("abort", onControllerAbort);
      for (const s of linked) s.removeEventListener("abort", onAbort);
      this.inFlightByLane[req.lane]--;
      entry.completedAtMs = this.clockFn();
    }
  }
}
