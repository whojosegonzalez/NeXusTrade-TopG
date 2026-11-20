/**
 * Bounded CPMM pool connection owner (assessment §8.38.17 item 15). Isolated and unwired.
 *
 * - Owns one injected, dormant, detachable transport for one exact-pool subscription and one run.
 *   It never sees a URL or credential, makes no HTTP request, and never opens, stops or dispatches
 *   through the shared session; it reads the session's clock, deadline and stop state only.
 * - Every incoming message goes through the collector; every accepted envelope reaches
 *   `ledger.account()` with the run's gate, or is counted as explicitly unprocessed.
 * - Deadlines are computed once at start. Timers only wake the owner: every callback and every
 *   return from external code re-checks the clock, session, cancellation and ownership.
 * - Attempts and resolution slots are reserved before external calls, so re-entrant callbacks
 *   cannot exceed any limit. The first terminal cause is kept apart from later uncertainty.
 * - Nothing here establishes notification completeness, a quiet window, a replayable capture or
 *   qualification.
 */
import type {
  CpmmAccountResult,
  CpmmAccountingDisposition,
  CpmmResolutionAccountingLedger,
} from "./CpmmResolutionAccountingLedger.js";
import type {
  CpmmCollectionEpochReport,
  CpmmEpochCloseReason,
  CpmmFrameResult,
  CpmmPoolNotificationCollector,
} from "./CpmmPoolNotificationCollector.js";
import type { PaperRequestSession, PaperRequestSessionTimers } from "./PaperRequestSession.js";
import type {
  CpmmAdapterBinding,
  CpmmLifecycleGate,
} from "./RaydiumCpmmTransactionSourceAdapter.js";

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

/** Dormant until start(); credential-free; every listener is detachable. */
export interface CpmmOwnerTransport {
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED. Read only after terminate() during cleanup. */
  readonly readyState: number;
  /** One time: begins connecting. */
  start(): void;
  /** One text frame. `done(false)` reports local completion, anything else a local failure. */
  send(data: string, done: (failed: boolean) => void): void;
  ping(payload: Uint8Array, done: (failed: boolean) => void): void;
  pong(payload: Uint8Array, done: (failed: boolean) => void): void;
  close(code: 1000): void;
  terminate(): void;
  /** Releases a transport that was never started. */
  dispose(): void;
  on(event: "open", listener: () => void): () => void;
  on(event: "message", listener: (data: unknown) => void): () => void;
  on(event: "error", listener: () => void): () => void;
  on(event: "close", listener: (code: unknown) => void): () => void;
  on(event: "ping", listener: (payload: unknown) => void): () => void;
  on(event: "pong", listener: (payload: unknown) => void): () => void;
}

/** Synchronous; no URL argument; returns a dormant transport that has done no I/O. */
export type CpmmOwnerTransportFactory = () => CpmmOwnerTransport;

/** Injected positive safe integers; no defaults and no live values. */
export interface CpmmConnectionOwnerLimits {
  /** start + observationMs is the nominal observation end. */
  readonly observationMs: number;
  /** From start, before the transport exists; < observationMs. */
  readonly ackTimeoutMs: number;
  /** The bounded tail after the nominal end; the hard intake end follows it. */
  readonly unsubscribeAckTimeoutMs: number;
  readonly pingIntervalMs: number;
  /** < pingIntervalMs. */
  readonly pongTimeoutMs: number;
  /** >= ceil(observationMs / pingIntervalMs). */
  readonly maxPings: number;
  /** Explicit pong replies to incoming pings. */
  readonly maxPongReplies: number;
  /** Incoming pings plus pongs (solicited, unsolicited and unmatched). */
  readonly maxControlFrames: number;
  /** 8..125: checked before any control payload is copied or compared. */
  readonly maxControlPayloadBytes: number;
  readonly maxOutstandingResolutions: number;
  readonly maxRetainedUnprocessed: number;
  readonly drainMs: number;
  readonly cleanupTimeoutMs: number;
}

export interface CpmmConnectionOwnerOptions {
  /** Already opened by its owner; never opened, stopped or dispatched through here. */
  readonly session: PaperRequestSession;
  /** Exclusive to this owner for the run. */
  readonly collector: CpmmPoolNotificationCollector;
  /** Exclusive to this owner for the run. */
  readonly ledger: CpmmResolutionAccountingLedger;
  /** The caller's adapter.getBinding(). */
  readonly binding: CpmmAdapterBinding;
  readonly transportFactory: CpmmOwnerTransportFactory;
  readonly timers: PaperRequestSessionTimers;
  readonly signal?: AbortSignal | undefined;
  /** The same number for the collector and the ledger. */
  readonly epoch: number;
  readonly subscribeRequestId: number;
  readonly unsubscribeRequestId: number;
  readonly limits: CpmmConnectionOwnerLimits;
}

export type CpmmOwnerPhase =
  | "BEFORE_TRANSPORT"
  | "CONNECTING"
  | "AWAITING_ACK"
  | "OBSERVING"
  | "UNSUBSCRIBING"
  | "DRAINING"
  | "CLEANUP";

export type CpmmOwnerTerminalCause =
  | "OBSERVATION_COMPLETED"
  | "START_REFUSED"
  | "CANCELLED"
  | "SESSION_STOPPED"
  | "TRANSPORT_FACTORY_FAILED"
  | "TRANSPORT_ERROR"
  | "TRANSPORT_CLOSED"
  | "SUBSCRIBE_SEND_FAILED"
  | "ACK_TIMEOUT"
  | "SUBSCRIBE_REJECTED"
  | "COLLECTION_DIRTY"
  | "ACQUISITION_LIMIT"
  | "PROCESSING_OVERFLOW"
  | "CONTROL_FRAME_LIMIT"
  | "KEEPALIVE_TIMEOUT"
  | "KEEPALIVE_SEND_FAILED"
  | "EPOCH_OWNERSHIP_LOST"
  | "OWNER_INTERNAL_ERROR";

/** Recorded after (or alongside) the first cause; never replaces it. */
export type CpmmOwnerUncertainty =
  | "COLLECTOR_CLOSE_REFUSED"
  | "UNSUBSCRIBE_NOT_ACKNOWLEDGED"
  | "DEADLINE_OVERRUN"
  | "FRAMES_AFTER_INTAKE"
  | "LOCAL_SEND_FAILED"
  | "LOCAL_COMPLETION_UNRESOLVED"
  | "UNPROCESSED_ENVELOPES"
  | "ACCOUNT_CALL_FAILED"
  | "DRAIN_EXPIRED"
  | "CLEANUP_FAILED"
  | "DISPOSE_FAILED"
  | "EPOCH_OWNERSHIP_LOST"
  | "LEDGER_COUNTER_INCONSISTENT"
  | "CANCELLED_AFTER_TERMINAL"
  | "SESSION_STOPPED_AFTER_TERMINAL";

export type CpmmLocalOutcome = "NOT_ATTEMPTED" | "THREW" | "COMPLETED" | "FAILED" | "UNRESOLVED";

export interface CpmmOwnerAttempt {
  /** The collector built the bytes. */
  readonly prepared: boolean;
  readonly reservedAtMs: number | null;
  readonly local: CpmmLocalOutcome;
  readonly localAtMs: number | null;
  /** From the collector only; never implied by a local completion. */
  readonly observed: "NOT_OBSERVED" | "ACKNOWLEDGED" | "REJECTED" | "MALFORMED";
}

export interface CpmmControlAttempts {
  readonly reserved: number;
  readonly threw: number;
  readonly completed: number;
  readonly failed: number;
  readonly unresolved: number;
}

export interface CpmmUnprocessedEnvelope {
  readonly frameSequence: number;
  readonly signature: string;
  readonly slot: number;
  readonly receivedAtMs: number;
  readonly reason: "CAPACITY" | "INTAKE_STOPPED" | "OWNERSHIP_LOST";
}

/** Summed over this run's own RECORDED (terminal) results; duplicates add nothing. */
export interface CpmmOwnedEventCounts {
  readonly recordsOwned: number;
  readonly byDisposition: Readonly<Record<CpmmAccountingDisposition, number>>;
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly unattempted: number;
  readonly indeterminate: number;
}

export interface CpmmOwnerDeadlines {
  readonly startedAtMs: number;
  readonly ackDeadlineMs: number;
  readonly nominalEndMs: number;
  readonly intakeEndMs: number;
  readonly drainDeadlineMs: number;
  readonly runCeilingMs: number;
  readonly sessionDeadlineMs: number;
}

export type CpmmOwnerCleanupStatus =
  | "NOT_NEEDED"
  | "DISPOSED_UNSTARTED"
  | "DISPOSE_FAILED"
  | "SETTLED"
  | "SETTLED_AFTER_TERMINATE"
  | "FAILED_STILL_OPEN";

export interface CpmmConnectionRunReport {
  readonly binding: CpmmAdapterBinding;
  readonly epoch: number;
  /** Null only for a refusal before the deadlines were computed. */
  readonly deadlines: CpmmOwnerDeadlines | null;
  readonly settledAtMs: number;
  readonly terminal: {
    readonly cause: CpmmOwnerTerminalCause;
    /** Fixed codes only. */
    readonly code: string | null;
    readonly phase: CpmmOwnerPhase;
    readonly atMs: number;
  };
  /** First-seen order, no repeats. */
  readonly uncertainties: readonly CpmmOwnerUncertainty[];
  readonly intake: {
    readonly stoppedAtMs: number | null;
    readonly trigger: "UNSUBSCRIBE_RESPONSE" | "INTAKE_DEADLINE" | "TERMINAL" | null;
    readonly framesAfterIntake: number;
    readonly controlFramesAfterIntake: number;
  };
  readonly transport: {
    readonly constructed: boolean;
    readonly started: boolean;
    readonly openedAtMs: number | null;
    readonly eventsBeforeStart: number;
    readonly disposeFailures: number;
  };
  readonly outgoing: {
    readonly subscribe: CpmmOwnerAttempt;
    readonly unsubscribe: CpmmOwnerAttempt;
    /** <= 2. */
    readonly applicationFramesReserved: number;
    readonly pings: CpmmControlAttempts;
    readonly pongReplies: CpmmControlAttempts;
    readonly pongsMatched: number;
    readonly pongsUnmatched: number;
    /** Second and later local-completion callbacks for one attempt (ignored). */
    readonly duplicateCompletions: number;
  };
  readonly incoming: {
    readonly messageEvents: number;
    readonly passedToCollector: number;
    readonly messagesBeforeStart: number;
    readonly pingsReceived: number;
    readonly pongsReceived: number;
    readonly controlFrames: number;
  };
  readonly handoff: {
    readonly envelopesAccepted: number;
    readonly unprocessed: {
      readonly capacity: number;
      readonly intakeStopped: number;
      readonly ownershipLost: number;
      readonly retained: readonly CpmmUnprocessedEnvelope[];
      readonly dropped: number;
    };
    readonly accountAttempts: number;
    readonly accountThrew: number;
    readonly accountRejected: number;
    readonly settled: {
      readonly recorded: number;
      readonly duplicate: number;
      readonly invalid: number;
      readonly capacityRefused: number;
    };
    readonly outstandingAtSettlement: number;
  };
  readonly events: CpmmOwnedEventCounts;
  readonly ownership: {
    readonly collectorIntact: boolean;
    readonly ledgerEpochIntact: boolean;
    /** Never negative. */
    readonly ledgerExternalOccurrences: number;
    readonly ledgerCountersConsistent: boolean;
  };
  readonly collector: CpmmCollectionEpochReport | null;
  readonly collectorClose: {
    readonly status: "CLOSED" | "REFUSED" | "ALREADY_CLOSED" | "NOT_OPENED";
    readonly reason: CpmmEpochCloseReason | null;
    readonly atMs: number | null;
  };
  readonly drain: {
    readonly status: "NOT_NEEDED" | "COMPLETED" | "EXPIRED" | "ABORTED";
    readonly outstandingAtDeadline: number;
  };
  readonly cleanup: {
    readonly status: CpmmOwnerCleanupStatus;
    readonly startedAtMs: number | null;
    readonly deadlineMs: number | null;
    readonly endedAtMs: number | null;
    readonly closeThrew: boolean;
    readonly terminateAttempted: boolean;
    readonly terminateThrew: boolean;
    readonly closeCode: number | null;
    readonly closeObservedAtMs: number | null;
  };
  readonly cancellation: {
    readonly requestedAtMs: number | null;
    readonly phase: CpmmOwnerPhase | null;
  };
  readonly sessionStopObserved: boolean;
  readonly connectionRunClean: boolean;
  readonly notificationCompletenessEstablished: false;
  readonly quietWindowEstablished: false;
  readonly qualificationEligible: false;
  readonly replayableCaptureEstablished: false;
  readonly ledgerAccountingAssessed: false;
}

/** Callbacks actually invoked after settlement. */
export interface CpmmOwnerLateEvents {
  readonly open: number;
  readonly message: number;
  readonly error: number;
  readonly close: number;
  readonly ping: number;
  readonly pong: number;
  readonly localCompletion: number;
  readonly accountSettlement: number;
  readonly timer: number;
  readonly abort: number;
  readonly sessionStop: number;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const WS_CONTROL_PAYLOAD_LIMIT = 125;
const PING_PAYLOAD_BYTES = 8;
const MAX_APPLICATION_FRAMES = 2;
const ADVANCE_ROUNDS = 64;
const ACCOUNTING_DISPOSITIONS: readonly CpmmAccountingDisposition[] = [
  "PENDING",
  "INGESTED",
  "INGESTION_INCOMPLETE",
  "POLICY_PENDING",
  "UNRESOLVED",
];

const isSafeNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isSafePositive = (v: unknown): v is number => isSafeNonNegative(v) && v >= 1;

function safeAdd(a: number, b: number): number | null {
  const s = a + b;
  return Number.isSafeInteger(s) ? s : null;
}

/** Exact increment that stays at MAX_SAFE_INTEGER instead of losing precision. */
const inc = (v: number, d = 1): number =>
  v > Number.MAX_SAFE_INTEGER - d ? Number.MAX_SAFE_INTEGER : v + d;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Own data properties of a plain object, or null (no accessors are invoked). */
function readData(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== "string") return null;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d)) return null;
    out[k] = d.value;
  }
  return out;
}

function sameBinding(a: CpmmAdapterBinding, b: unknown): boolean {
  const r = readData(b);
  return (
    r !== null &&
    Object.keys(r).length === 2 &&
    r.poolAddress === a.poolAddress &&
    r.candidateMint === a.candidateMint
  );
}

// Genuine byte views through intrinsics captured at module load (the collector's approach): a
// shadowed own property is ignored and a proxy is refused before any trap runs.
const NativeUint8Array = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
function intrinsicGetter(key: PropertyKey): (this: unknown) => unknown {
  const get = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, key)?.get;
  if (typeof get !== "function") throw new Error(`[CPMM_OWNER_INIT] missing intrinsic`);
  return get;
}
const typedArrayName = intrinsicGetter(Symbol.toStringTag);
const typedArrayBuffer = intrinsicGetter("buffer");
const typedArrayByteOffset = intrinsicGetter("byteOffset");
const typedArrayByteLength = intrinsicGetter("byteLength");
const typedArraySet = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "set")!.value as (
  this: Uint8Array,
  source: ArrayLike<number>,
) => void;

type ControlPayload =
  | { readonly kind: "OK"; readonly bytes: Uint8Array }
  | { readonly kind: "INVALID" | "OVERSIZE" };

/** The length is checked against `max` before anything is copied or compared. */
function boundedControlPayload(v: unknown, max: number): ControlPayload {
  try {
    if (Reflect.apply(typedArrayName, v, []) !== "Uint8Array") return { kind: "INVALID" };
    const length = Reflect.apply(typedArrayByteLength, v, []);
    const offset = Reflect.apply(typedArrayByteOffset, v, []);
    if (!isSafeNonNegative(length) || !isSafeNonNegative(offset)) return { kind: "INVALID" };
    if (length > max) return { kind: "OVERSIZE" };
    const buffer = Reflect.apply(typedArrayBuffer, v, []) as ArrayBufferLike;
    const copy = new NativeUint8Array(length);
    Reflect.apply(typedArraySet, copy, [new NativeUint8Array(buffer, offset, length)]);
    return { kind: "OK", bytes: copy };
  } catch {
    return { kind: "INVALID" };
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const COLLECTOR_REASON: Readonly<Record<CpmmOwnerTerminalCause, CpmmEpochCloseReason>> = {
  OBSERVATION_COMPLETED: "OWNER_CLOSED",
  START_REFUSED: "CANCELLED",
  CANCELLED: "CANCELLED",
  SESSION_STOPPED: "CANCELLED",
  TRANSPORT_FACTORY_FAILED: "TRANSPORT_ERROR",
  TRANSPORT_ERROR: "TRANSPORT_ERROR",
  TRANSPORT_CLOSED: "TRANSPORT_CLOSED",
  SUBSCRIBE_SEND_FAILED: "TRANSPORT_ERROR",
  ACK_TIMEOUT: "ACK_TIMEOUT",
  SUBSCRIBE_REJECTED: "CANCELLED",
  COLLECTION_DIRTY: "CANCELLED",
  ACQUISITION_LIMIT: "LIMIT_EXCEEDED",
  PROCESSING_OVERFLOW: "LIMIT_EXCEEDED",
  CONTROL_FRAME_LIMIT: "LIMIT_EXCEEDED",
  KEEPALIVE_TIMEOUT: "KEEPALIVE_TIMEOUT",
  KEEPALIVE_SEND_FAILED: "CANCELLED",
  EPOCH_OWNERSHIP_LOST: "CANCELLED",
  OWNER_INTERNAL_ERROR: "CANCELLED",
};

type LateKind = keyof CpmmOwnerLateEvents;
type MutableLate = { -readonly [K in LateKind]: number };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type AttemptState = Mutable<Omit<CpmmOwnerAttempt, "local">> & {
  local: CpmmLocalOutcome | "PENDING";
};
type ControlState = Mutable<CpmmControlAttempts> & { pending: number };

/** The session keeps only this holder (and the late counters) after settlement. */
interface StopHolder {
  run: { readonly notify: () => void } | null;
  readonly late: MutableLate;
}

function sessionStopListener(holder: StopHolder): (reason: string) => void {
  return () => {
    const r = holder.run;
    if (r) r.notify();
    else holder.late.sessionStop = inc(holder.late.sessionStop);
  };
}

const LIMIT_KEYS = [
  "observationMs",
  "ackTimeoutMs",
  "unsubscribeAckTimeoutMs",
  "pingIntervalMs",
  "pongTimeoutMs",
  "maxPings",
  "maxPongReplies",
  "maxControlFrames",
  "maxControlPayloadBytes",
  "maxOutstandingResolutions",
  "maxRetainedUnprocessed",
  "drainMs",
  "cleanupTimeoutMs",
] as const;

const OPTION_KEYS = [
  "session",
  "collector",
  "ledger",
  "binding",
  "transportFactory",
  "timers",
  "signal",
  "epoch",
  "subscribeRequestId",
  "unsubscribeRequestId",
  "limits",
] as const;

const hasMethods = (o: unknown, names: readonly string[]): boolean =>
  o !== null &&
  typeof o === "object" &&
  names.every((n) => typeof (o as Record<string, unknown>)[n] === "function");

// ---------------------------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------------------------

export class CpmmPoolConnectionOwner {
  private readonly session: PaperRequestSession;
  private readonly collector: CpmmPoolNotificationCollector;
  private readonly ledger: CpmmResolutionAccountingLedger;
  private readonly binding: CpmmAdapterBinding;
  private readonly factory: CpmmOwnerTransportFactory;
  private readonly timers: PaperRequestSessionTimers;
  private readonly signal: AbortSignal | undefined;
  private readonly epoch: number;
  private readonly subscribeRequestId: number;
  private readonly unsubscribeRequestId: number;
  private readonly limits: CpmmConnectionOwnerLimits;

  // run
  private runPromise: Promise<CpmmConnectionRunReport> | null = null;
  private resolveRun: ((r: CpmmConnectionRunReport) => void) | null = null;
  private finalReport: CpmmConnectionRunReport | null = null;
  private readonly late: MutableLate = {
    open: 0,
    message: 0,
    error: 0,
    close: 0,
    ping: 0,
    pong: 0,
    localCompletion: 0,
    accountSettlement: 0,
    timer: 0,
    abort: 0,
    sessionStop: 0,
  };
  private readonly holder: StopHolder;
  private settled = false;
  private settledAt = 0;
  private phase: CpmmOwnerPhase = "BEFORE_TRANSPORT";
  private deadlines: CpmmOwnerDeadlines | null = null;
  private terminal: CpmmConnectionRunReport["terminal"] | null = null;
  private readonly uncertainties: CpmmOwnerUncertainty[] = [];
  private advancing = false;
  /** > 0 while external startup code (factory, registration, start) is running. */
  private busy = 0;
  private advanceAgain = false;
  private lastNow = 0;
  private clockInvalid = false;

  // transport
  private transport: CpmmOwnerTransport | null = null;
  private transportConstructed = false;
  private started = false;
  private openedAtMs: number | null = null;
  private eventsBeforeStart = 0;
  private messagesBeforeStart = 0;
  private disposeFailures = 0;
  private intakeDisposers: (() => void)[] = [];
  private lifecycleDisposers: (() => void)[] = [];
  private abortListener: (() => void) | null = null;
  private wakeHandle: unknown = null;
  private wakeArmed = false;

  // ownership
  private collectorOpened = false;
  private expectedCollectorVersion = 0;
  private collectorIntact = true;
  private ledgerOpened = false;
  private ledgerEpochIntact = true;
  private ledgerOccurrences0 = 0;
  private ledgerOpenRefused0 = 0;
  private ledgerExternal = 0;
  private ledgerConsistent = true;
  private ownershipLost = false;
  private collectorClose: Mutable<CpmmConnectionRunReport["collectorClose"]> = {
    status: "NOT_OPENED",
    reason: null,
    atMs: null,
  };
  private subscribeText = "";

  // intake
  private intakeStopped = false;
  private intakeStoppedAt: number | null = null;
  private intakeTrigger: CpmmConnectionRunReport["intake"]["trigger"] = null;
  private framesAfterIntake = 0;
  private controlFramesAfterIntake = 0;
  private acked = false;

  // outgoing
  private readonly subscribe: AttemptState = {
    prepared: false,
    reservedAtMs: null,
    local: "NOT_ATTEMPTED",
    localAtMs: null,
    observed: "NOT_OBSERVED",
  };
  private readonly unsubscribe: AttemptState = {
    prepared: false,
    reservedAtMs: null,
    local: "NOT_ATTEMPTED",
    localAtMs: null,
    observed: "NOT_OBSERVED",
  };
  private appReserved = 0;
  private readonly pings: ControlState = {
    reserved: 0,
    threw: 0,
    completed: 0,
    failed: 0,
    unresolved: 0,
    pending: 0,
  };
  private readonly pongReplies: ControlState = {
    reserved: 0,
    threw: 0,
    completed: 0,
    failed: 0,
    unresolved: 0,
    pending: 0,
  };
  private pongsMatched = 0;
  private pongsUnmatched = 0;
  private duplicateCompletions = 0;
  private outstandingPing: Uint8Array | null = null;
  private pongDeadline: number | null = null;
  private nextPingAt: number | null = null;
  private pingSeq = 0;

  // incoming
  private messageEvents = 0;
  private passed = 0;
  private pingsReceived = 0;
  private pongsReceived = 0;
  private controlFrames = 0;

  // handoff
  private readonly runAbort = new AbortController();
  private readonly gate: CpmmLifecycleGate;
  private envelopes = 0;
  private unprocCapacity = 0;
  private unprocIntake = 0;
  private unprocOwnership = 0;
  private retained: CpmmUnprocessedEnvelope[] = [];
  private dropped = 0;
  private attempts = 0;
  private accountCallsInProgress = 0;
  private threw = 0;
  private rejected = 0;
  private readonly settledCounts = { recorded: 0, duplicate: 0, invalid: 0, capacityRefused: 0 };
  private outstanding = 0;
  private readonly events = {
    recordsOwned: 0,
    byDisposition: Object.fromEntries(ACCOUNTING_DISPOSITIONS.map((d) => [d, 0])) as Record<
      CpmmAccountingDisposition,
      number
    >,
    total: 0,
    accepted: 0,
    rejected: 0,
    unattempted: 0,
    indeterminate: 0,
  };
  private drainStatus: "NOT_NEEDED" | "PENDING" | "COMPLETED" | "EXPIRED" | "ABORTED" =
    "NOT_NEEDED";
  private outstandingAtDeadline = 0;
  private drainExpired = false;

  // cleanup
  private cleanupStatus: CpmmOwnerCleanupStatus | "NOT_STARTED" | "PENDING" = "NOT_STARTED";
  private cleanupStartedAt: number | null = null;
  private cleanupDeadline: number | null = null;
  private cleanupEndedAt: number | null = null;
  private closeThrew = false;
  private terminateAttempted = false;
  private terminateThrew = false;
  private closeCode: number | null = null;
  private closeObservedAt: number | null = null;

  // cancellation and session stop
  private cancellation: Mutable<CpmmConnectionRunReport["cancellation"]> = {
    requestedAtMs: null,
    phase: null,
  };
  private cancelSeen = false;
  private sessionStopSeen = false;

  constructor(options: CpmmConnectionOwnerOptions) {
    const fail = (msg: string): never => {
      throw new Error(`[CPMM_OWNER_INIT] ${msg}`);
    };
    const o = readData(options);
    if (!o) throw new Error("[CPMM_OWNER_INIT] options must be a plain object of data");
    for (const k of Object.keys(o)) {
      if (!(OPTION_KEYS as readonly string[]).includes(k)) fail(`unknown option ${k}`);
    }
    for (const k of OPTION_KEYS) {
      if (k !== "signal" && !(k in o)) fail(`missing option ${k}`);
    }
    if (!hasMethods(o.session, ["now", "isOpen", "getDeadlineMs", "getStopReason", "onStop"])) {
      fail("session must be a PaperRequestSession");
    }
    if (
      !hasMethods(o.collector, [
        "openEpoch",
        "acceptFrame",
        "unsubscribeFrame",
        "closeEpoch",
        "epochReport",
        "getBinding",
      ])
    ) {
      fail("collector must be a CpmmPoolNotificationCollector");
    }
    if (!hasMethods(o.ledger, ["openEpoch", "account", "epochs", "counters", "getBinding"])) {
      fail("ledger must be a CpmmResolutionAccountingLedger");
    }
    if (typeof o.transportFactory !== "function") fail("transportFactory must be a function");
    if (!hasMethods(o.timers, ["setTimeout", "clearTimeout"])) fail("timers are required");
    if (o.signal !== undefined && !(o.signal instanceof AbortSignal)) {
      fail("signal must be an AbortSignal");
    }
    const b = readData(o.binding);
    if (
      !b ||
      Object.keys(b).length !== 2 ||
      typeof b.poolAddress !== "string" ||
      typeof b.candidateMint !== "string" ||
      b.poolAddress.length === 0 ||
      b.candidateMint.length === 0
    ) {
      fail("binding must be exactly { poolAddress, candidateMint }");
    }
    if (!isSafeNonNegative(o.epoch)) fail("epoch must be a non-negative safe integer");
    if (!isSafePositive(o.subscribeRequestId) || !isSafePositive(o.unsubscribeRequestId)) {
      fail("request IDs must be positive safe integers");
    }
    if (o.subscribeRequestId === o.unsubscribeRequestId) fail("request IDs must differ");
    const l = readData(o.limits);
    if (!l || Object.keys(l).length !== LIMIT_KEYS.length) {
      fail(`limits must be exactly ${LIMIT_KEYS.join(", ")}`);
    }
    for (const k of LIMIT_KEYS) {
      if (!isSafePositive(l![k])) fail(`${k} must be a positive safe integer`);
    }
    const limits = Object.freeze(
      Object.fromEntries(LIMIT_KEYS.map((k) => [k, l![k] as number])),
    ) as unknown as CpmmConnectionOwnerLimits;
    if (limits.ackTimeoutMs >= limits.observationMs) fail("ackTimeoutMs must be < observationMs");
    if (limits.pongTimeoutMs >= limits.pingIntervalMs) {
      fail("pongTimeoutMs must be < pingIntervalMs");
    }
    if (limits.maxPings < Math.ceil(limits.observationMs / limits.pingIntervalMs)) {
      fail("maxPings must be >= ceil(observationMs / pingIntervalMs)");
    }
    if (
      limits.maxControlPayloadBytes < PING_PAYLOAD_BYTES ||
      limits.maxControlPayloadBytes > WS_CONTROL_PAYLOAD_LIMIT
    ) {
      fail("maxControlPayloadBytes must be within 8..125");
    }
    this.session = o.session as PaperRequestSession;
    this.collector = o.collector as CpmmPoolNotificationCollector;
    this.ledger = o.ledger as CpmmResolutionAccountingLedger;
    this.binding = Object.freeze({
      poolAddress: b!.poolAddress as string,
      candidateMint: b!.candidateMint as string,
    });
    this.factory = o.transportFactory as CpmmOwnerTransportFactory;
    this.timers = o.timers as PaperRequestSessionTimers;
    this.signal = o.signal as AbortSignal | undefined;
    this.epoch = o.epoch as number;
    this.subscribeRequestId = o.subscribeRequestId as number;
    this.unsubscribeRequestId = o.unsubscribeRequestId as number;
    this.limits = limits;
    this.holder = { run: null, late: this.late };
    this.gate = Object.freeze({
      signal: this.runAbort.signal,
      refusal: () => (this.gateRefuses() ? "OWNER_TERMINATED" : null),
    });
  }

  /** One execution: every call, including re-entrant ones, returns the same promise. */
  public run(): Promise<CpmmConnectionRunReport> {
    if (this.runPromise) return this.runPromise;
    this.runPromise = new Promise<CpmmConnectionRunReport>((resolve) => {
      this.resolveRun = resolve;
    });
    this.guard(() => this.begin());
    return this.runPromise;
  }

  public lateEvents(): CpmmOwnerLateEvents {
    return Object.freeze({ ...this.late });
  }

  // --- infrastructure ---------------------------------------------------------------------------

  private guard(fn: () => void): void {
    try {
      fn();
    } catch {
      this.internalError();
    }
  }

  private internalError(): void {
    try {
      if (!this.terminal) this.terminate("OWNER_INTERNAL_ERROR", "EXCEPTION");
      this.advance();
    } catch {
      this.emergencySettle();
    }
  }

  private emergencySettle(): void {
    if (this.settled) return;
    try {
      if (!this.terminal) {
        this.terminal = {
          cause: "OWNER_INTERNAL_ERROR",
          code: "EXCEPTION",
          phase: this.phase,
          atMs: this.lastNow,
        };
      }
      this.settle(this.lastNow);
    } catch {
      // Unreachable by construction; the report builder only reads owner fields.
    }
  }

  private uncertain(u: CpmmOwnerUncertainty): void {
    if (!this.uncertainties.includes(u)) this.uncertainties.push(u);
  }

  private readNow(): number {
    let t: unknown;
    try {
      t = this.session.now();
    } catch {
      t = null;
    }
    if (!isSafePositive(t)) {
      this.clockInvalid = true;
      return this.lastNow;
    }
    this.lastNow = t;
    return t;
  }

  private gateRefuses(): boolean {
    return (
      (this.terminal !== null && this.terminal.cause !== "OBSERVATION_COMPLETED") ||
      this.drainExpired ||
      this.ownershipLost ||
      this.cancelSeen ||
      this.sessionStopSeen
    );
  }

  private abortGate(): void {
    try {
      if (!this.runAbort.signal.aborted) this.runAbort.abort();
    } catch {
      // Listener errors are not the owner's; the gate refusal still applies.
    }
  }

  /** Re-entrancy-safe: a nested call only requests another round. */
  private advance(): void {
    if (this.settled) return;
    if (this.advancing) {
      this.advanceAgain = true;
      return;
    }
    this.advancing = true;
    try {
      let rounds = 0;
      do {
        this.advanceAgain = false;
        this.step();
        rounds++;
      } while (this.advanceAgain && !this.settled && rounds < ADVANCE_ROUNDS);
    } finally {
      this.advancing = false;
    }
  }

  // --- start --------------------------------------------------------------------------------------

  private finishEarly(cause: CpmmOwnerTerminalCause, code: string | null, now: number): void {
    this.terminal = { cause, code, phase: this.phase, atMs: now };
    this.cleanupStatus = "NOT_NEEDED";
    this.settle(now);
  }

  private begin(): void {
    const t0 = this.readNow();
    if (this.clockInvalid) return this.finishEarly("START_REFUSED", "CLOCK_INVALID", t0);
    let open = false;
    try {
      open = this.session.isOpen() === true && this.session.getStopReason() === null;
    } catch {
      open = false;
    }
    if (!open) return this.finishEarly("START_REFUSED", "SESSION_NOT_OPEN", t0);
    if (this.signal?.aborted) {
      this.cancelSeen = true;
      this.cancellation = { requestedAtMs: t0, phase: this.phase };
      return this.finishEarly("CANCELLED", "ABORTED_BEFORE_START", t0);
    }
    const L = this.limits;
    const ack = safeAdd(t0, L.ackTimeoutMs);
    const nominal = safeAdd(t0, L.observationMs);
    const intake = nominal === null ? null : safeAdd(nominal, L.unsubscribeAckTimeoutMs);
    const drain = intake === null ? null : safeAdd(intake, L.drainMs);
    const ceiling =
      intake === null ? null : safeAdd(intake, Math.max(L.drainMs, L.cleanupTimeoutMs));
    if (ack === null || nominal === null || intake === null || drain === null || ceiling === null) {
      return this.finishEarly("START_REFUSED", "DEADLINE_ARITHMETIC", t0);
    }
    let sessionDeadline: unknown = null;
    try {
      sessionDeadline = this.session.getDeadlineMs();
    } catch {
      sessionDeadline = null;
    }
    if (!isSafePositive(sessionDeadline) || ceiling > sessionDeadline) {
      return this.finishEarly("START_REFUSED", "SESSION_DEADLINE_TOO_SOON", t0);
    }
    this.deadlines = Object.freeze({
      startedAtMs: t0,
      ackDeadlineMs: ack,
      nominalEndMs: nominal,
      intakeEndMs: intake,
      drainDeadlineMs: drain,
      runCeilingMs: ceiling,
      sessionDeadlineMs: sessionDeadline,
    });
    // Identity: all three bindings agree before any epoch is opened.
    if (
      !sameBinding(this.binding, this.collector.getBinding()) ||
      !sameBinding(this.binding, this.ledger.getBinding())
    ) {
      return this.finishEarly("START_REFUSED", "BINDING_MISMATCH", t0);
    }
    // Ownership witnesses, then the two epochs.
    const lc = this.ledger.counters();
    this.ledgerOccurrences0 = lc.occurrences;
    this.ledgerOpenRefused0 = lc.openEpochRefused;
    this.expectedCollectorVersion = inc(this.collector.version);
    const co = this.collector.openEpoch({
      epoch: this.epoch,
      observationStartMs: t0,
      subscribeRequestId: this.subscribeRequestId,
    });
    if (co.status !== "OPENED") {
      return this.finishEarly("START_REFUSED", "COLLECTOR_EPOCH_REFUSED", t0);
    }
    this.collectorOpened = true;
    this.subscribe.prepared = true;
    this.subscribeText = new TextDecoder().decode(co.subscribeFrame);
    const lo = this.ledger.openEpoch({ epoch: this.epoch, observationStartMs: t0 });
    if (lo.status !== "OPENED") {
      this.terminal = {
        cause: "START_REFUSED",
        code: "LEDGER_EPOCH_REFUSED",
        phase: this.phase,
        atMs: t0,
      };
      this.closeCollector("CANCELLED", this.readNow());
      this.cleanupStatus = "NOT_NEEDED";
      return this.settle(this.lastNow);
    }
    this.ledgerOpened = true;
    // Lifecycle listeners and the wake timer exist before the transport.
    this.holder.run = { notify: () => this.guard(() => this.advance()) };
    if (this.signal) {
      this.abortListener = () => {
        if (this.settled) this.late.abort = inc(this.late.abort);
        else this.guard(() => this.advance());
      };
      this.signal.addEventListener("abort", this.abortListener, { once: true });
    }
    this.session.onStop(sessionStopListener(this.holder));
    this.phase = "CONNECTING";
    this.advance();
    if (this.terminal) return;
    // A synchronous factory returning a dormant transport. While external startup code runs,
    // cleanup and settlement wait, so a transport returned after termination is still disposed.
    let t: unknown;
    let factoryThrew = false;
    this.busy++;
    try {
      t = this.factory();
    } catch {
      factoryThrew = true;
    } finally {
      this.busy--;
    }
    if (factoryThrew) {
      this.terminate("TRANSPORT_FACTORY_FAILED", "THREW");
      return this.resume();
    }
    if (!hasMethods(t, ["start", "send", "ping", "pong", "close", "terminate", "dispose", "on"])) {
      this.terminate("TRANSPORT_FACTORY_FAILED", "INVALID_TRANSPORT");
      return this.resume();
    }
    this.transport = t as CpmmOwnerTransport;
    this.transportConstructed = true;
    this.resume();
    if (this.terminal) return;
    // Handlers, each with its disposer, before start().
    let registrationFailed = false;
    this.busy++;
    try {
      this.register(this.lifecycleDisposers, "error", "error", () => this.onError());
      this.register(this.lifecycleDisposers, "close", "close", (c: unknown) => this.onClose(c));
      this.register(this.intakeDisposers, "message", "message", (d: unknown) => this.onMessage(d));
      this.register(this.intakeDisposers, "ping", "ping", (p: unknown) =>
        this.onControl("ping", p),
      );
      this.register(this.intakeDisposers, "pong", "pong", (p: unknown) =>
        this.onControl("pong", p),
      );
      this.register(this.lifecycleDisposers, "open", "open", () => this.onOpen());
    } catch {
      registrationFailed = true;
    } finally {
      this.busy--;
    }
    if (registrationFailed) {
      this.disposeAll(this.intakeDisposers);
      this.disposeAll(this.lifecycleDisposers);
      this.terminate("TRANSPORT_ERROR", "HANDLER_REGISTRATION");
      return this.resume();
    }
    this.resume();
    if (this.terminal) return;
    // Reserve the started state before the external call.
    this.started = true;
    this.busy++;
    try {
      this.transport.start();
    } catch {
      this.terminate("TRANSPORT_ERROR", "START_FAILED");
    } finally {
      this.busy--;
    }
    this.resume();
  }

  /** After external startup code returns: start any deferred cleanup, then re-check. */
  private resume(): void {
    if (this.terminal && this.cleanupStatus === "NOT_STARTED" && this.busy === 0) {
      this.beginCleanup(this.readNow());
    }
    this.advance();
  }

  private register(
    into: (() => void)[],
    event: "open" | "message" | "error" | "close" | "ping" | "pong",
    late: LateKind,
    fn: (arg: unknown) => void,
  ): void {
    const t = this.transport!;
    const wrapped = (arg?: unknown): void => {
      if (this.settled) {
        this.late[late] = inc(this.late[late]);
        return;
      }
      if (!this.started) {
        this.eventsBeforeStart = inc(this.eventsBeforeStart);
        if (event === "message") {
          this.messageEvents = inc(this.messageEvents);
          this.messagesBeforeStart = inc(this.messagesBeforeStart);
        }
        this.guard(() => {
          this.terminate("TRANSPORT_ERROR", "EVENT_BEFORE_START");
          this.advance();
        });
        return;
      }
      this.guard(() => fn(arg));
    };
    const d = (t.on as (e: string, l: (arg?: unknown) => void) => unknown)(event, wrapped);
    if (typeof d !== "function") throw new Error("disposer");
    into.push(d as () => void);
  }

  private disposeAll(list: (() => void)[]): void {
    const items = list.splice(0);
    for (const d of items) {
      try {
        d();
      } catch {
        this.disposeFailures = inc(this.disposeFailures);
        this.uncertain("DISPOSE_FAILED");
      }
    }
  }

  // --- authoritative checks ---------------------------------------------------------------------

  /** Read-only: whether the collector and ledger are still exclusively ours. */
  private ownershipState(): {
    collectorOk: boolean;
    ledgerEpochOk: boolean;
    external: number;
    consistent: boolean;
  } {
    let collectorOk = true;
    if (this.collectorOpened) {
      try {
        collectorOk = this.collector.version === this.expectedCollectorVersion;
      } catch {
        collectorOk = false;
      }
    }
    let ledgerEpochOk = true;
    let external = 0;
    let consistent = true;
    if (this.ledgerOpened) {
      try {
        const eps = this.ledger.epochs();
        const last = eps[eps.length - 1];
        const c = this.ledger.counters();
        ledgerEpochOk =
          last !== undefined &&
          last.epoch === this.epoch &&
          last.state === "OPEN" &&
          c.openEpochRefused === this.ledgerOpenRefused0;
        const d = c.occurrences - this.ledgerOccurrences0;
        if (d > this.attempts) external = d - this.attempts;
        // A call still executing synchronously may not have recorded its occurrence yet.
        if (c.saturated || d < this.attempts - this.threw - this.accountCallsInProgress) {
          consistent = false;
        }
      } catch {
        ledgerEpochOk = false;
        consistent = false;
      }
    }
    return { collectorOk, ledgerEpochOk, external, consistent };
  }

  private ownershipOk(): boolean {
    const s = this.ownershipState();
    return s.collectorOk && s.ledgerEpochOk && s.external === 0 && s.consistent;
  }

  private checkOwnership(): void {
    const s = this.ownershipState();
    if (!s.collectorOk) this.collectorIntact = false;
    if (!s.ledgerEpochOk) this.ledgerEpochIntact = false;
    if (s.external > this.ledgerExternal) this.ledgerExternal = s.external;
    if (!s.consistent) {
      this.ledgerConsistent = false;
      this.uncertain("LEDGER_COUNTER_INCONSISTENT");
    }
    if ((!s.collectorOk || !s.ledgerEpochOk || s.external > 0) && !this.ownershipLost) {
      this.ownershipLost = true;
      this.uncertain("EPOCH_OWNERSHIP_LOST");
      if (!this.terminal) this.terminate("EPOCH_OWNERSHIP_LOST", "WITNESS");
      else this.abortDrain();
    }
  }

  /**
   * Whether external work may start now (no side effects). Messages skip the ownership part: the
   * collector still classifies them, and the check after the call then ends the run, so the
   * envelope is accounted as unprocessed rather than silently refused.
   */
  private admissible(now: number, checkOwnership = true): boolean {
    let stop: unknown = "UNREADABLE";
    try {
      stop = this.session.getStopReason();
    } catch {
      stop = "UNREADABLE";
    }
    return (
      !this.terminal &&
      !this.settled &&
      !this.clockInvalid &&
      stop === null &&
      this.signal?.aborted !== true &&
      this.deadlines !== null &&
      now < this.deadlines.intakeEndMs &&
      (this.acked || now < this.deadlines.ackDeadlineMs) &&
      (!checkOwnership || this.ownershipOk())
    );
  }

  private step(): void {
    if (this.settled) return;
    const now = this.readNow();
    if (this.clockInvalid && !this.terminal)
      this.terminate("OWNER_INTERNAL_ERROR", "CLOCK_INVALID");
    this.checkOwnership();
    let stop: unknown = null;
    try {
      stop = this.session.getStopReason();
    } catch {
      stop = "UNREADABLE";
    }
    if (stop !== null && !this.sessionStopSeen) {
      this.sessionStopSeen = true;
      if (this.terminal) {
        this.uncertain("SESSION_STOPPED_AFTER_TERMINAL");
        this.abortDrain();
      } else this.terminate("SESSION_STOPPED", null);
    }
    if (this.signal?.aborted && !this.cancelSeen) {
      this.cancelSeen = true;
      this.cancellation = { requestedAtMs: now, phase: this.phase };
      if (this.terminal) {
        this.uncertain("CANCELLED_AFTER_TERMINAL");
        this.abortDrain();
        this.forceTerminate();
      } else this.terminate("CANCELLED", null);
    }
    const d = this.deadlines;
    if (!this.terminal && d) {
      if (!this.acked && now >= d.ackDeadlineMs) {
        this.terminate("ACK_TIMEOUT", this.phase);
      } else if (this.phase === "OBSERVING") {
        if (this.pongDeadline !== null && now >= this.pongDeadline) {
          this.terminate("KEEPALIVE_TIMEOUT", "PONG_DEADLINE");
        } else if (now >= d.nominalEndMs) {
          this.beginUnsubscribe(now);
        } else if (this.nextPingAt !== null && now >= this.nextPingAt) {
          this.sendPing(now);
        }
      }
      if (!this.terminal && this.phase === "UNSUBSCRIBING" && now >= d.intakeEndMs) {
        this.stopIntake("INTAKE_DEADLINE");
      }
    }
    if (this.drainStatus === "PENDING" && d) {
      if (this.outstanding === 0) {
        this.drainStatus = "COMPLETED";
      } else if (now >= d.drainDeadlineMs) {
        this.drainStatus = "EXPIRED";
        this.outstandingAtDeadline = this.outstanding;
        this.drainExpired = true;
        this.uncertain("DRAIN_EXPIRED");
        this.abortGate();
      }
    }
    if (
      this.cleanupStatus === "PENDING" &&
      this.cleanupDeadline !== null &&
      now >= this.cleanupDeadline
    ) {
      this.forceTerminate();
    }
    if (this.canSettle(now)) {
      this.settle(now);
      return;
    }
    this.armWake(now);
  }

  private abortDrain(): void {
    if (this.drainStatus === "PENDING") {
      this.drainStatus = "ABORTED";
      this.outstandingAtDeadline = this.outstanding;
    }
    this.abortGate();
  }

  private cleanupResolved(): boolean {
    return this.cleanupStatus !== "NOT_STARTED" && this.cleanupStatus !== "PENDING";
  }

  /** How long aborted resolutions may take to settle before settlement counts them outstanding. */
  private abortedBound(now: number): number {
    const cleanup = this.cleanupDeadline ?? now;
    return this.terminal?.cause === "OBSERVATION_COMPLETED"
      ? Math.max(cleanup, this.deadlines?.drainDeadlineMs ?? cleanup)
      : cleanup;
  }

  private canSettle(now: number): boolean {
    if (this.busy > 0 || !this.terminal || !this.cleanupResolved()) return false;
    switch (this.drainStatus) {
      case "PENDING":
        return false;
      case "ABORTED":
        return this.outstanding === 0 || now >= this.abortedBound(now);
      default:
        return true;
    }
  }

  private armWake(now: number): void {
    const d = this.deadlines;
    if (!d) return;
    const due: number[] = [];
    if (!this.terminal) {
      if (!this.acked) due.push(d.ackDeadlineMs);
      if (this.phase === "OBSERVING") {
        due.push(d.nominalEndMs);
        if (this.nextPingAt !== null) due.push(this.nextPingAt);
        if (this.pongDeadline !== null) due.push(this.pongDeadline);
      }
      if (this.phase === "UNSUBSCRIBING") due.push(d.intakeEndMs);
    }
    if (this.drainStatus === "PENDING") due.push(d.drainDeadlineMs);
    if (this.drainStatus === "ABORTED") due.push(this.abortedBound(now));
    if (this.cleanupDeadline !== null && (this.cleanupStatus === "PENDING" || this.terminal)) {
      due.push(this.cleanupDeadline);
    }
    if (this.wakeArmed) {
      this.wakeArmed = false;
      try {
        this.timers.clearTimeout(this.wakeHandle);
      } catch {
        // A failing clearTimeout only risks an extra (harmless or late-counted) wake-up.
      }
    }
    const next = due.filter((x) => x > now);
    const target = next.length > 0 ? Math.min(...next) : due.length > 0 ? now + 1 : null;
    if (target === null) return;
    this.wakeArmed = true;
    this.wakeHandle = this.timers.setTimeout(() => {
      if (this.settled) {
        this.late.timer = inc(this.late.timer);
        return;
      }
      this.wakeArmed = false;
      this.guard(() => this.advance());
    }, target - now);
  }

  // --- transitions --------------------------------------------------------------------------------

  private terminate(cause: CpmmOwnerTerminalCause, code: string | null): void {
    if (this.terminal) return;
    const now = this.readNow();
    this.terminal = { cause, code, phase: this.phase, atMs: now };
    if (cause === "EPOCH_OWNERSHIP_LOST") {
      this.ownershipLost = true;
      this.uncertain("EPOCH_OWNERSHIP_LOST");
    }
    this.nextPingAt = null;
    this.pongDeadline = null;
    this.outstandingPing = null;
    this.drainStatus = this.outstanding > 0 ? "ABORTED" : "NOT_NEEDED";
    this.outstandingAtDeadline = this.outstanding;
    if (!this.intakeStopped && this.collectorOpened) this.stopIntake("TERMINAL");
    this.abortGate();
    this.phase = "CLEANUP";
    if (this.busy === 0) this.beginCleanup(now);
  }

  private beginUnsubscribe(now: number): void {
    this.phase = "UNSUBSCRIBING";
    this.nextPingAt = null;
    this.pongDeadline = null;
    this.outstandingPing = null;
    if (now >= this.deadlines!.intakeEndMs) {
      this.uncertain("DEADLINE_OVERRUN");
      this.stopIntake("INTAKE_DEADLINE");
      return;
    }
    this.expectedCollectorVersion = inc(this.expectedCollectorVersion);
    const bytes = this.collector.unsubscribeFrame(this.epoch, this.unsubscribeRequestId);
    if (!bytes) {
      this.expectedCollectorVersion -= 1;
      this.checkOwnership();
      this.stopIntake("INTAKE_DEADLINE");
      return;
    }
    this.checkOwnership();
    this.unsubscribe.prepared = true;
    this.sendApp(this.unsubscribe, new TextDecoder().decode(bytes), "UNSUBSCRIBE", now);
  }

  /** Stops intake once: listeners for intake are detached and the collector epoch is closed. */
  private stopIntake(trigger: "UNSUBSCRIBE_RESPONSE" | "INTAKE_DEADLINE" | "TERMINAL"): void {
    if (this.intakeStopped) return;
    this.intakeStopped = true;
    this.intakeTrigger = trigger;
    this.nextPingAt = null;
    this.pongDeadline = null;
    this.outstandingPing = null;
    this.disposeAll(this.intakeDisposers);
    // One fresh read: the truthful instant of the stop decision.
    const at = this.readNow();
    this.intakeStoppedAt = at;
    const reason =
      trigger === "TERMINAL" ? COLLECTOR_REASON[this.terminal!.cause] : ("OWNER_CLOSED" as const);
    this.closeCollector(reason, at);
    if (trigger === "TERMINAL") return;
    if (this.unsubscribe.observed !== "ACKNOWLEDGED")
      this.uncertain("UNSUBSCRIBE_NOT_ACKNOWLEDGED");
    if (!this.terminal) {
      this.terminal = {
        cause: "OBSERVATION_COMPLETED",
        code: trigger,
        phase: this.phase,
        atMs: at,
      };
    }
    this.phase = "DRAINING";
    this.drainStatus = this.outstanding > 0 ? "PENDING" : "COMPLETED";
    if (this.busy === 0) this.beginCleanup(at);
  }

  private closeCollector(reason: CpmmEpochCloseReason, at: number): void {
    if (!this.collectorOpened) return;
    let state: string | null = null;
    try {
      state = this.collector.epochReport(this.epoch)?.state ?? null;
    } catch {
      state = null;
    }
    if (state !== "OPEN") {
      this.collectorClose = { status: "ALREADY_CLOSED", reason: null, atMs: null };
      this.checkOwnership();
      return;
    }
    this.expectedCollectorVersion = inc(this.expectedCollectorVersion);
    const ok = this.collector.closeEpoch(this.epoch, reason, at);
    if (ok) {
      this.collectorClose = { status: "CLOSED", reason, atMs: at };
    } else {
      this.expectedCollectorVersion -= 1;
      this.collectorClose = { status: "REFUSED", reason, atMs: null };
      this.uncertain("COLLECTOR_CLOSE_REFUSED");
    }
    this.checkOwnership();
  }

  // --- outgoing -----------------------------------------------------------------------------------

  private sendApp(
    attempt: AttemptState,
    text: string,
    which: "SUBSCRIBE" | "UNSUBSCRIBE",
    now: number,
  ): void {
    if (this.appReserved >= MAX_APPLICATION_FRAMES || attempt.local !== "NOT_ATTEMPTED") return;
    // Reserve before the external call.
    this.appReserved++;
    attempt.reservedAtMs = now;
    attempt.local = "PENDING";
    let calls = 0;
    const done = (failed: unknown): void => {
      calls++;
      if (this.settled) {
        this.late.localCompletion = inc(this.late.localCompletion);
        return;
      }
      if (calls > 1 || attempt.local !== "PENDING") {
        this.duplicateCompletions = inc(this.duplicateCompletions);
        return;
      }
      this.guard(() => {
        attempt.local = failed === false ? "COMPLETED" : "FAILED";
        attempt.localAtMs = this.readNow();
        if (attempt.local === "FAILED") this.appFailure(which, "LOCAL_FAILURE");
        this.advance();
      });
    };
    try {
      this.transport!.send(text, done);
    } catch {
      if (attempt.local === "PENDING") {
        attempt.local = "THREW";
        attempt.localAtMs = this.readNow();
      }
      this.appFailure(which, "THREW");
    }
  }

  private appFailure(which: "SUBSCRIBE" | "UNSUBSCRIBE", code: string): void {
    this.uncertain("LOCAL_SEND_FAILED");
    if (which === "SUBSCRIBE") this.terminate("SUBSCRIBE_SEND_FAILED", code);
    else this.terminate("TRANSPORT_ERROR", `UNSUBSCRIBE_SEND_${code}`);
  }

  private sendControl(ctrl: ControlState, kind: "ping" | "pong", payload: Uint8Array): void {
    // Reserve before the external call.
    ctrl.reserved = inc(ctrl.reserved);
    ctrl.pending++;
    let calls = 0;
    let finished = false;
    const fail = (code: string) => {
      this.uncertain("LOCAL_SEND_FAILED");
      this.terminate("KEEPALIVE_SEND_FAILED", code);
    };
    const done = (failed: unknown): void => {
      calls++;
      if (this.settled) {
        this.late.localCompletion = inc(this.late.localCompletion);
        return;
      }
      if (calls > 1 || finished) {
        this.duplicateCompletions = inc(this.duplicateCompletions);
        return;
      }
      finished = true;
      this.guard(() => {
        ctrl.pending--;
        if (failed === false) ctrl.completed = inc(ctrl.completed);
        else {
          ctrl.failed = inc(ctrl.failed);
          fail(kind === "ping" ? "PING_FAILED" : "PONG_REPLY_FAILED");
        }
        this.advance();
      });
    };
    try {
      if (kind === "ping") this.transport!.ping(payload, done);
      else this.transport!.pong(payload, done);
    } catch {
      if (!finished) {
        finished = true;
        ctrl.pending--;
        ctrl.threw = inc(ctrl.threw);
      }
      fail(kind === "ping" ? "PING_THREW" : "PONG_REPLY_THREW");
    }
  }

  private sendPing(now: number): void {
    const d = this.deadlines!;
    const pongBy = safeAdd(now, this.limits.pongTimeoutMs);
    // Only if its pong deadline fits before the nominal observation end.
    if (
      pongBy === null ||
      pongBy >= d.nominalEndMs ||
      this.pings.reserved >= this.limits.maxPings
    ) {
      this.nextPingAt = null;
      return;
    }
    this.pingSeq++;
    const payload = new Uint8Array(PING_PAYLOAD_BYTES);
    new DataView(payload.buffer).setBigUint64(0, BigInt(this.pingSeq));
    this.outstandingPing = payload.slice();
    this.pongDeadline = pongBy;
    this.nextPingAt = safeAdd(now, this.limits.pingIntervalMs);
    this.sendControl(this.pings, "ping", payload);
  }

  // --- incoming -----------------------------------------------------------------------------------

  private onOpen(): void {
    this.advance();
    if (this.terminal || this.phase !== "CONNECTING") return;
    const now = this.readNow();
    if (!this.admissible(now)) {
      this.advance();
      return;
    }
    // Reserve the phase before the external call.
    this.phase = "AWAITING_ACK";
    this.openedAtMs = now;
    this.sendApp(this.subscribe, this.subscribeText, "SUBSCRIBE", now);
    this.advance();
  }

  private onError(): void {
    if (!this.terminal) this.terminate("TRANSPORT_ERROR", "ERROR_EVENT");
    this.advance();
  }

  private onClose(code: unknown): void {
    const now = this.readNow();
    if (this.closeObservedAt === null) {
      this.closeObservedAt = now;
      this.closeCode = isSafeNonNegative(code) ? code : null;
    }
    if (this.cleanupStatus === "PENDING") {
      this.cleanupStatus = this.terminateAttempted ? "SETTLED_AFTER_TERMINATE" : "SETTLED";
      this.cleanupEndedAt = now;
    }
    if (!this.terminal) {
      if (code === 1009) this.terminate("ACQUISITION_LIMIT", "TRANSPORT_PAYLOAD_LIMIT");
      else this.terminate("TRANSPORT_CLOSED", null);
    }
    this.advance();
  }

  private onMessage(data: unknown): void {
    this.messageEvents = inc(this.messageEvents);
    const now = this.readNow();
    if (this.intakeStopped || !this.admissible(now, false)) {
      this.framesAfterIntake = inc(this.framesAfterIntake);
      this.uncertain("FRAMES_AFTER_INTAKE");
      this.advance();
      return;
    }
    // Reserve, then the one collector call.
    this.passed = inc(this.passed);
    this.expectedCollectorVersion = inc(this.expectedCollectorVersion);
    const r = this.collector.acceptFrame({
      epoch: this.epoch,
      bytes: data as Uint8Array,
      receivedAtMs: now,
    });
    this.checkOwnership();
    // Always classified, so every accepted envelope is accounted even after a terminal check.
    this.onClassified(r, now);
    this.advance();
  }

  private onClassified(r: CpmmFrameResult, now: number): void {
    switch (r.disposition) {
      case "NOTIFICATION_ACCEPTED":
        this.envelopes = inc(this.envelopes);
        this.handoff(r);
        return;
      case "SUBSCRIBE_ACKNOWLEDGED":
        if (!this.acked) {
          this.acked = true;
          this.subscribe.observed = "ACKNOWLEDGED";
          if (this.phase === "AWAITING_ACK" || this.phase === "CONNECTING") {
            this.phase = "OBSERVING";
            this.nextPingAt = safeAdd(now, this.limits.pingIntervalMs);
          }
        }
        return;
      case "UNSUBSCRIBE_ACKNOWLEDGED":
      case "UNSUBSCRIBE_REJECTED":
        this.unsubscribe.observed =
          r.disposition === "UNSUBSCRIBE_ACKNOWLEDGED" ? "ACKNOWLEDGED" : "REJECTED";
        if (this.phase === "UNSUBSCRIBING") this.stopIntake("UNSUBSCRIBE_RESPONSE");
        return;
      case "SUBSCRIBE_REJECTED":
        this.subscribe.observed = "REJECTED";
        this.terminate("SUBSCRIBE_REJECTED", "REJECTED");
        return;
      case "OVERSIZE_FRAME":
      case "EPOCH_LIMIT_EXCEEDED":
        this.terminate("ACQUISITION_LIMIT", r.disposition);
        return;
      case "STALE_EPOCH":
      case "EPOCH_NOT_OPEN":
        this.ownershipLost = true;
        this.collectorIntact = false;
        this.uncertain("EPOCH_OWNERSHIP_LOST");
        this.terminate("EPOCH_OWNERSHIP_LOST", r.disposition);
        return;
      default: {
        const code = r.status === "RECORDED" ? r.code : null;
        if (code === "SUBSCRIBE_RESPONSE_SHAPE") {
          this.subscribe.observed = "MALFORMED";
          this.terminate("SUBSCRIBE_REJECTED", "MALFORMED");
          return;
        }
        if (code === "UNSUBSCRIBE_RESPONSE_SHAPE") this.unsubscribe.observed = "MALFORMED";
        // Fail fast: the epoch can no longer be collection-clean.
        this.terminate("COLLECTION_DIRTY", r.disposition);
      }
    }
  }

  private unprocessed(
    n: { frameSequence: number; signature: string; slot: number; receivedAtMs: number },
    reason: CpmmUnprocessedEnvelope["reason"],
  ): void {
    if (reason === "CAPACITY") this.unprocCapacity = inc(this.unprocCapacity);
    else if (reason === "INTAKE_STOPPED") this.unprocIntake = inc(this.unprocIntake);
    else this.unprocOwnership = inc(this.unprocOwnership);
    if (this.retained.length < this.limits.maxRetainedUnprocessed) {
      this.retained.push(
        Object.freeze({
          frameSequence: n.frameSequence,
          signature: n.signature,
          slot: n.slot,
          receivedAtMs: n.receivedAtMs,
          reason,
        }),
      );
    } else this.dropped = inc(this.dropped);
    this.uncertain("UNPROCESSED_ENVELOPES");
  }

  /** Every accepted envelope reaches the ledger or is counted as explicitly unprocessed. */
  private handoff(r: CpmmFrameResult): void {
    if (r.status !== "ACCEPTED_NOTIFICATION") return;
    const n = r.notification;
    if (this.ownershipLost || !this.ownershipOk()) {
      this.unprocessed(n, "OWNERSHIP_LOST");
      this.checkOwnership();
      return;
    }
    if (this.terminal || this.intakeStopped) return this.unprocessed(n, "INTAKE_STOPPED");
    if (this.outstanding >= this.limits.maxOutstandingResolutions) {
      this.unprocessed(n, "CAPACITY");
      this.terminate("PROCESSING_OVERFLOW", "OUTSTANDING_LIMIT");
      return;
    }
    // Reserve the slot before the external call.
    this.attempts = inc(this.attempts);
    this.outstanding++;
    let p: Promise<CpmmAccountResult>;
    this.accountCallsInProgress++;
    try {
      p = this.ledger.account(r.envelope, this.gate);
    } catch {
      this.accountCallsInProgress--;
      this.threw = inc(this.threw);
      this.outstanding--;
      this.uncertain("ACCOUNT_CALL_FAILED");
      this.checkOwnership();
      return;
    }
    this.accountCallsInProgress--;
    this.checkOwnership();
    Promise.resolve(p).then(
      (res) => this.onAccountSettled(res),
      () => this.onAccountRejected(),
    );
  }

  private onAccountSettled(res: CpmmAccountResult): void {
    if (this.settled) {
      this.late.accountSettlement = inc(this.late.accountSettlement);
      return;
    }
    this.guard(() => {
      this.outstanding--;
      switch (res.status) {
        case "RECORDED": {
          this.settledCounts.recorded = inc(this.settledCounts.recorded);
          const rec = res.record;
          this.events.recordsOwned = inc(this.events.recordsOwned);
          this.events.byDisposition[rec.disposition] = inc(
            this.events.byDisposition[rec.disposition],
          );
          this.events.total = inc(this.events.total, rec.ingestion.total);
          this.events.accepted = inc(this.events.accepted, rec.ingestion.accepted);
          this.events.rejected = inc(this.events.rejected, rec.ingestion.rejected);
          this.events.unattempted = inc(this.events.unattempted, rec.ingestion.unattempted);
          this.events.indeterminate = inc(this.events.indeterminate, rec.ingestion.indeterminate);
          break;
        }
        case "DUPLICATE":
          this.settledCounts.duplicate = inc(this.settledCounts.duplicate);
          break;
        case "INVALID":
          this.settledCounts.invalid = inc(this.settledCounts.invalid);
          break;
        default:
          this.settledCounts.capacityRefused = inc(this.settledCounts.capacityRefused);
      }
      this.advance();
    });
  }

  private onAccountRejected(): void {
    if (this.settled) {
      this.late.accountSettlement = inc(this.late.accountSettlement);
      return;
    }
    this.guard(() => {
      this.outstanding--;
      this.rejected = inc(this.rejected);
      this.uncertain("ACCOUNT_CALL_FAILED");
      this.advance();
    });
  }

  private onControl(kind: "ping" | "pong", payload: unknown): void {
    if (this.intakeStopped) {
      this.controlFramesAfterIntake = inc(this.controlFramesAfterIntake);
      this.uncertain("FRAMES_AFTER_INTAKE");
      return;
    }
    // Count (reserve) before any copy or comparison.
    this.controlFrames = inc(this.controlFrames);
    if (kind === "ping") this.pingsReceived = inc(this.pingsReceived);
    else this.pongsReceived = inc(this.pongsReceived);
    if (this.controlFrames > this.limits.maxControlFrames) {
      this.terminate("CONTROL_FRAME_LIMIT", "INCOMING_CONTROL_FRAMES");
      this.advance();
      return;
    }
    const v = boundedControlPayload(payload, this.limits.maxControlPayloadBytes);
    if (v.kind !== "OK") {
      if (kind === "pong") this.pongsUnmatched = inc(this.pongsUnmatched);
      if (v.kind === "OVERSIZE") this.terminate("CONTROL_FRAME_LIMIT", "CONTROL_PAYLOAD_OVERSIZE");
      else this.terminate("TRANSPORT_ERROR", "CONTROL_PAYLOAD_INVALID");
      this.advance();
      return;
    }
    const now = this.readNow();
    if (kind === "pong") {
      if (
        this.outstandingPing !== null &&
        this.pongDeadline !== null &&
        now < this.pongDeadline &&
        equalBytes(this.outstandingPing, v.bytes)
      ) {
        this.pongsMatched = inc(this.pongsMatched);
        this.outstandingPing = null;
        this.pongDeadline = null;
      } else {
        this.pongsUnmatched = inc(this.pongsUnmatched);
      }
    } else if (this.admissible(now)) {
      if (this.pongReplies.reserved >= this.limits.maxPongReplies) {
        this.terminate("CONTROL_FRAME_LIMIT", "PONG_REPLY_LIMIT");
      } else {
        this.sendControl(this.pongReplies, "pong", v.bytes);
      }
    }
    this.advance();
  }

  // --- cleanup and settlement --------------------------------------------------------------------

  private beginCleanup(now: number): void {
    if (this.cleanupStatus !== "NOT_STARTED") return;
    this.cleanupStartedAt = now;
    const ceiling = this.deadlines?.runCeilingMs ?? now;
    const own = safeAdd(now, this.limits.cleanupTimeoutMs) ?? ceiling;
    this.cleanupDeadline = Math.min(own, Math.max(ceiling, now));
    const t = this.transport;
    if (!t) {
      this.cleanupStatus = "NOT_NEEDED";
      this.cleanupEndedAt = now;
      return;
    }
    if (!this.started) {
      try {
        t.dispose();
        this.cleanupStatus = "DISPOSED_UNSTARTED";
      } catch {
        this.cleanupStatus = "DISPOSE_FAILED";
        this.uncertain("CLEANUP_FAILED");
      }
      this.cleanupEndedAt = this.readNow();
      return;
    }
    if (this.closeObservedAt !== null) {
      this.cleanupStatus = "SETTLED";
      this.cleanupEndedAt = now;
      return;
    }
    // The state exists before close(), which may emit `close` synchronously.
    this.cleanupStatus = "PENDING";
    try {
      t.close(1000);
    } catch {
      this.closeThrew = true;
    }
  }

  private forceTerminate(): void {
    if (this.cleanupStatus !== "PENDING" || this.terminateAttempted) return;
    this.terminateAttempted = true;
    const t = this.transport!;
    try {
      t.terminate();
    } catch {
      this.terminateThrew = true;
    }
    if (this.cleanupStatus !== "PENDING") return;
    let rs: unknown = -1;
    try {
      rs = t.readyState;
    } catch {
      rs = -1;
    }
    this.cleanupStatus = rs === 3 ? "SETTLED_AFTER_TERMINATE" : "FAILED_STILL_OPEN";
    this.cleanupEndedAt = this.readNow();
    if (this.cleanupStatus === "FAILED_STILL_OPEN") this.uncertain("CLEANUP_FAILED");
  }

  private settle(now: number): void {
    if (this.settled) return;
    if (this.cleanupStatus === "NOT_STARTED") this.cleanupStatus = "NOT_NEEDED";
    this.checkOwnership();
    for (const a of [this.subscribe, this.unsubscribe]) {
      if (a.local === "PENDING") {
        a.local = "UNRESOLVED";
        this.uncertain("LOCAL_COMPLETION_UNRESOLVED");
      }
    }
    for (const c of [this.pings, this.pongReplies]) {
      if (c.pending > 0) {
        c.unresolved = inc(c.unresolved, c.pending);
        c.pending = 0;
        this.uncertain("LOCAL_COMPLETION_UNRESOLVED");
      }
    }
    let collectorReport: CpmmCollectionEpochReport | null = null;
    if (this.collectorOpened) {
      try {
        collectorReport = this.collector.epochReport(this.epoch);
      } catch {
        collectorReport = null;
      }
    }
    this.settled = true;
    this.settledAt = now;
    // Release listeners and timers; anything invoked from here on is a late event.
    this.disposeAll(this.intakeDisposers);
    this.disposeAll(this.lifecycleDisposers);
    if (this.abortListener && this.signal) {
      this.signal.removeEventListener("abort", this.abortListener);
      this.abortListener = null;
    }
    if (this.wakeArmed) {
      this.wakeArmed = false;
      try {
        this.timers.clearTimeout(this.wakeHandle);
      } catch {
        // Counted as a late timer if it still fires.
      }
    }
    const report = this.buildReport(collectorReport);
    this.finalReport = report;
    // Release heavy run state; the session keeps only the holder and the late counters.
    this.holder.run = null;
    this.transport = null;
    this.retained = [];
    this.subscribeText = "";
    this.outstandingPing = null;
    const resolve = this.resolveRun;
    this.resolveRun = null;
    resolve?.(report);
  }

  private buildReport(collector: CpmmCollectionEpochReport | null): CpmmConnectionRunReport {
    const attempt = (a: AttemptState): CpmmOwnerAttempt => ({
      prepared: a.prepared,
      reservedAtMs: a.reservedAtMs,
      local: a.local === "PENDING" ? "UNRESOLVED" : a.local,
      localAtMs: a.localAtMs,
      observed: a.observed,
    });
    const control = (c: ControlState): CpmmControlAttempts => ({
      reserved: c.reserved,
      threw: c.threw,
      completed: c.completed,
      failed: c.failed,
      unresolved: c.unresolved,
    });
    const terminal = this.terminal ?? {
      cause: "OWNER_INTERNAL_ERROR" as const,
      code: "NO_TERMINAL",
      phase: this.phase,
      atMs: this.settledAt,
    };
    const drain = this.drainStatus === "PENDING" ? ("ABORTED" as const) : this.drainStatus;
    const cleanupStatus: CpmmOwnerCleanupStatus =
      this.cleanupStatus === "NOT_STARTED"
        ? "NOT_NEEDED"
        : this.cleanupStatus === "PENDING"
          ? "FAILED_STILL_OPEN"
          : this.cleanupStatus;
    const subscribe = attempt(this.subscribe);
    const unsubscribe = attempt(this.unsubscribe);
    const pings = control(this.pings);
    const pongReplies = control(this.pongReplies);
    const unprocessedTotal = this.unprocCapacity + this.unprocIntake + this.unprocOwnership;
    const clean =
      terminal.cause === "OBSERVATION_COMPLETED" &&
      this.intakeTrigger === "UNSUBSCRIBE_RESPONSE" &&
      unsubscribe.observed === "ACKNOWLEDGED" &&
      this.collectorClose.status === "CLOSED" &&
      collector !== null &&
      collector.collectionClean &&
      subscribe.local === "COMPLETED" &&
      unsubscribe.local === "COMPLETED" &&
      pings.completed === pings.reserved &&
      pongReplies.completed === pongReplies.reserved &&
      this.pongsMatched === pings.reserved &&
      this.pongsUnmatched === 0 &&
      this.duplicateCompletions === 0 &&
      drain === "COMPLETED" &&
      unprocessedTotal === 0 &&
      this.threw === 0 &&
      this.rejected === 0 &&
      this.outstanding === 0 &&
      cleanupStatus === "SETTLED" &&
      this.collectorIntact &&
      this.ledgerEpochIntact &&
      this.ledgerExternal === 0 &&
      this.ledgerConsistent &&
      this.eventsBeforeStart === 0 &&
      this.framesAfterIntake === 0 &&
      this.controlFramesAfterIntake === 0 &&
      this.disposeFailures === 0 &&
      this.cancellation.requestedAtMs === null &&
      !this.sessionStopSeen &&
      this.uncertainties.length === 0;
    return deepFreeze({
      binding: { ...this.binding },
      epoch: this.epoch,
      deadlines: this.deadlines ? { ...this.deadlines } : null,
      settledAtMs: this.settledAt,
      terminal: { ...terminal },
      uncertainties: [...this.uncertainties],
      intake: {
        stoppedAtMs: this.intakeStoppedAt,
        trigger: this.intakeTrigger,
        framesAfterIntake: this.framesAfterIntake,
        controlFramesAfterIntake: this.controlFramesAfterIntake,
      },
      transport: {
        constructed: this.transportConstructed,
        started: this.started,
        openedAtMs: this.openedAtMs,
        eventsBeforeStart: this.eventsBeforeStart,
        disposeFailures: this.disposeFailures,
      },
      outgoing: {
        subscribe,
        unsubscribe,
        applicationFramesReserved: this.appReserved,
        pings,
        pongReplies,
        pongsMatched: this.pongsMatched,
        pongsUnmatched: this.pongsUnmatched,
        duplicateCompletions: this.duplicateCompletions,
      },
      incoming: {
        messageEvents: this.messageEvents,
        passedToCollector: this.passed,
        messagesBeforeStart: this.messagesBeforeStart,
        pingsReceived: this.pingsReceived,
        pongsReceived: this.pongsReceived,
        controlFrames: this.controlFrames,
      },
      handoff: {
        envelopesAccepted: this.envelopes,
        unprocessed: {
          capacity: this.unprocCapacity,
          intakeStopped: this.unprocIntake,
          ownershipLost: this.unprocOwnership,
          retained: [...this.retained],
          dropped: this.dropped,
        },
        accountAttempts: this.attempts,
        accountThrew: this.threw,
        accountRejected: this.rejected,
        settled: { ...this.settledCounts },
        outstandingAtSettlement: this.outstanding,
      },
      events: {
        recordsOwned: this.events.recordsOwned,
        byDisposition: { ...this.events.byDisposition },
        total: this.events.total,
        accepted: this.events.accepted,
        rejected: this.events.rejected,
        unattempted: this.events.unattempted,
        indeterminate: this.events.indeterminate,
      },
      ownership: {
        collectorIntact: this.collectorIntact,
        ledgerEpochIntact: this.ledgerEpochIntact,
        ledgerExternalOccurrences: this.ledgerExternal,
        ledgerCountersConsistent: this.ledgerConsistent,
      },
      collector,
      collectorClose: { ...this.collectorClose },
      drain: { status: drain, outstandingAtDeadline: this.outstandingAtDeadline },
      cleanup: {
        status: cleanupStatus,
        startedAtMs: this.cleanupStartedAt,
        deadlineMs: this.cleanupDeadline,
        endedAtMs: this.cleanupEndedAt,
        closeThrew: this.closeThrew,
        terminateAttempted: this.terminateAttempted,
        terminateThrew: this.terminateThrew,
        closeCode: this.closeCode,
        closeObservedAtMs: this.closeObservedAt,
      },
      cancellation: { ...this.cancellation },
      sessionStopObserved: this.sessionStopSeen,
      connectionRunClean: clean,
      notificationCompletenessEstablished: false,
      quietWindowEstablished: false,
      qualificationEligible: false,
      replayableCaptureEstablished: false,
      ledgerAccountingAssessed: false,
    });
  }
}
