/**
 * CPMM pool observation recorder (assessment §8.38.17 item 17 B): in-memory, bounded recording by
 * composition around the accepted owner, wrapper, ledger and shared session.
 *
 * - **Transport decorator** (`recordTransport`): sits between the owner and the accepted wrapper.
 *   It registers exactly one observation listener per event on the wrapper, before the owner
 *   registers anything, and records each wrapper event once. Owner registrations become real
 *   wrapper registrations (delivery, snapshot, removal and throw containment stay the wrapper's),
 *   whose shims attribute each delivery to its event record through an explicit correlation: a
 *   record lists the owner registrations live when it was dispatched, and a delivery is credited
 *   to the newest record still waiting on that registration. That is exact under nesting,
 *   removal during dispatch and events with no owner listener.
 * - **Delegating ledger** (`recordLedger`): records each `account()` call and its settlement and
 *   returns the ledger's original promise object unchanged.
 * - **Exchange observer** (`observeExchange`) and the constructor-time fan-out
 *   (`createExchangeObserverFanOut`), with the adapter's evidence recorder first.
 * - **`finish()`**: idempotent; detaches the observation listeners (closing and stopping nothing)
 *   and returns one deeply immutable snapshot of recorder-owned copies.
 *
 * The snapshot is raw, unsanitized memory-only material (`material`): it may contain credential
 * bytes from payloads or response bodies and must pass the reviewed sealer before persistence.
 * The recorder reads no clock, starts no timer, performs no I/O, reads no environment, logs
 * nothing and redacts nothing. It assigns ordinals only; every time it holds was read and
 * recorded by the component it is copied from, and absent values stay null. It makes no
 * runtime-accounting replay or qualification claim.
 */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";

import type {
  CpmmConnectionRunReport,
  CpmmOwnerTransport,
  CpmmPoolConnectionOwner,
} from "./CpmmPoolConnectionOwner.js";
import type { CpmmPoolNotificationCollector } from "./CpmmPoolNotificationCollector.js";
import type { CpmmPoolWebSocketTransport } from "./CpmmPoolWebSocketTransport.js";
import type { CpmmResolutionAccountingLedger } from "./CpmmResolutionAccountingLedger.js";
import type { PaperRequestExchangeEvidence, PaperRequestSession } from "./PaperRequestSession.js";
import { CPMM_TX_PURPOSE } from "./RaydiumCpmmTransactionSourceAdapter.js";

// ---------------------------------------------------------------------------------------------
// Captured intrinsics (caller objects are inspected without running their code where possible)
// ---------------------------------------------------------------------------------------------

const reflectApply = Reflect.apply;
const reflectOwnKeys = Reflect.ownKeys;
const getOwnDesc = Object.getOwnPropertyDescriptor;
const defineProp = Object.defineProperty;
const getProto = Object.getPrototypeOf;
const objectFreeze = Object.freeze;
const isSafeInteger = Number.isSafeInteger;
const isFiniteNumber = Number.isFinite;
const isArray = Array.isArray;
const isProxy = utilTypes.isProxy;
const isUint8Array = utilTypes.isUint8Array;
const isPromise = utilTypes.isPromise;
const ObjectProto = Object.prototype;
const promiseThen = Promise.prototype.then;
const promiseResolve = Promise.resolve;
const NativePromise = Promise;

const typedArrayProto = getProto(Uint8Array.prototype) as object;
function typedArrayGetter(name: string): (this: unknown) => unknown {
  const d = getOwnDesc(typedArrayProto, name);
  if (!d || typeof d.get !== "function") throw new Error("[CPMM_RECORDER_INIT] intrinsics");
  return d.get as (this: unknown) => unknown;
}
const taByteLength = typedArrayGetter("byteLength");
const taByteOffset = typedArrayGetter("byteOffset");
const taBuffer = typedArrayGetter("buffer");

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

/** Injected non-negative safe integers; no defaults. Record and byte allowances are separate. */
export interface CpmmObservationRecorderLimits {
  /** Wrapper-observed application messages. */
  readonly maxIncomingRecords: number;
  /** Their total retained payload bytes. */
  readonly maxIncomingPayloadBytes: number;
  /** send() calls and their completions. */
  readonly maxOutgoingRecords: number;
  readonly maxOutgoingPayloadBytes: number;
  /** ping/pong calls, their completions, and incoming ping/pong events. */
  readonly maxControlRecords: number;
  readonly maxControlPayloadBytes: number;
  /** start, open, error, close, close(), terminate, dispose, readyState, (un)registrations. */
  readonly maxLifecycleRecords: number;
  /** CPMM transaction exchanges. */
  readonly maxExchangeRecords: number;
  /** Their total retained response bytes. */
  readonly maxExchangeBodyBytes: number;
  /** account() calls and settlements. */
  readonly maxLedgerCallRecords: number;
  /** Retained failure records (the count stays exact). */
  readonly maxInstrumentationFailures: number;
  /** >= 1. Larger payloads or bodies are neither copied nor hashed (length only). */
  readonly maxPayloadBytesPerRecord: number;
  /** >= 1. Values copied from component reads at finish(), across all of them. */
  readonly maxFinishCopyNodes: number;
}

export type CpmmRecorderLayer = "TRANSPORT" | "LEDGER" | "EXCHANGE" | "FINISH";

export type CpmmRecorderFailureCode =
  | "TRANSPORT_NOT_RECORDABLE"
  | "TRANSPORT_ALREADY_RECORDED"
  | "OBSERVATION_REGISTRATION_FAILED"
  | "OBSERVATION_DETACH_FAILED"
  | "EVENT_RECORD_FAILED"
  | "CALL_RECORD_FAILED"
  | "COMPLETION_RECORD_FAILED"
  | "DELIVERY_RECORD_FAILED"
  | "DELIVERY_UNCORRELATED"
  | "CORRELATION_EVICTED"
  | "LEDGER_NOT_RECORDABLE"
  | "LEDGER_ALREADY_RECORDED"
  | "ACCOUNT_RECORD_FAILED"
  | "ACCOUNT_RESULT_NOT_PROMISE"
  | "ACCOUNT_SETTLEMENT_UNOBSERVABLE"
  | "ACCOUNT_SETTLEMENT_RECORD_FAILED"
  | "ACCOUNT_REJECTED"
  | "EXCHANGE_RECORD_FAILED"
  | "FINISH_INPUT_INVALID"
  | "FINISH_READ_FAILED"
  | "FINISH_COPY_REFUSED";

export interface CpmmRecorderFailure {
  readonly ordinal: number;
  readonly layer: CpmmRecorderLayer;
  readonly code: CpmmRecorderFailureCode;
}

/** What finish() reads, through public methods only, after the owner has settled. */
export interface CpmmObservationFinishInput {
  /** The owner's settled run report (frozen by the owner at settlement). */
  readonly report: CpmmConnectionRunReport | null;
  readonly owner: Pick<CpmmPoolConnectionOwner, "lateEvents"> | null;
  /** Read at finish(), so possibly later than the owner's freeze. */
  readonly wrapper: Pick<CpmmPoolWebSocketTransport, "diagnostics"> | null;
  readonly collector: Pick<
    CpmmPoolNotificationCollector,
    "epochReport" | "frameRecords" | "notifications" | "counters"
  > | null;
  readonly ledger: Pick<CpmmResolutionAccountingLedger, "records" | "epochs" | "counters"> | null;
  readonly session: Pick<PaperRequestSession, "getLedgerSince" | "getLedgerLength"> | null;
  /** The session ledger length before the run: the window is [start, end). */
  readonly sessionLedgerStart: number;
  /** The run's epoch, for the collector's epochReport. */
  readonly epoch: number;
  readonly fanOut: Pick<CpmmExchangeObserverFanOut, "diagnostics"> | null;
}

export interface CpmmPoolObservationRecorder {
  /** Once, inside the owner's transportFactory. Never throws; misuse returns `inner` unchanged. */
  recordTransport(inner: CpmmOwnerTransport): CpmmOwnerTransport;
  /** Once. The delegating ledger for the owner (an isolated cast; gap G5). Never throws. */
  recordLedger(ledger: CpmmResolutionAccountingLedger): CpmmResolutionAccountingLedger;
  /** One target of the session's exchange-observer fan-out. Returns undefined; never throws. */
  readonly observeExchange: (evidence: PaperRequestExchangeEvidence) => void;
  /** Idempotent: the first call builds the snapshot, later calls return the same object. */
  finish(input: CpmmObservationFinishInput): CpmmObservationSnapshot;
  /** Exact counts of activity after finish() (never part of the snapshot). */
  lateActivity(): CpmmRecorderLateActivity;
}

export interface CpmmRecorderLateActivity {
  readonly wrapperEvents: number;
  readonly ownerDeliveries: number;
  readonly transportCalls: number;
  readonly registrations: number;
  readonly completions: number;
  readonly ledgerCalls: number;
  readonly ledgerSettlements: number;
  readonly exchanges: number;
}

export type CpmmPayloadOmission = "BYTE_ALLOWANCE" | "OVERSIZE_NOT_HASHED" | "NOT_BYTES";

/** A payload as the recorder saw it. Bytes are base64 copies taken before any later mutation. */
export interface CpmmRecordedPayload {
  /** Null when not bytes, or an oversize string whose UTF-8 length was not computed. */
  readonly byteLength: number | null;
  /** SHA-256 of the original bytes; null when oversize or not bytes. */
  readonly sha256: string | null;
  readonly base64: string | null;
  readonly omitted: CpmmPayloadOmission | null;
}

export type CpmmEventDelivery =
  | "OWNER_LISTENERS_REGISTERED"
  | "WRAPPER_ONLY_AFTER_OWNER_DISPOSAL"
  | "WRAPPER_ONLY_NO_OWNER_LISTENER";

export type CpmmTransportEvent = "open" | "message" | "error" | "close" | "ping" | "pong";
export type CpmmTransportMethod =
  | "start"
  | "send"
  | "ping"
  | "pong"
  | "close"
  | "terminate"
  | "dispose";

export interface CpmmRecordedEvent {
  readonly ordinal: number;
  readonly kind: "EVENT";
  readonly event: CpmmTransportEvent;
  /** 1-based count of this event kind as observed (exact, including dropped records). */
  readonly eventIndex: number;
  /** Always true: the wrapper dispatched it. */
  readonly wrapperObserved: true;
  readonly ownerRegistrationsAtDispatch: number;
  /** Owner listeners that actually received it. */
  readonly ownerDeliveries: number;
  readonly ownerListenerThrew: number;
  readonly delivery: CpmmEventDelivery;
  readonly argumentCount: number;
  /** message, ping and pong only. */
  readonly payload: CpmmRecordedPayload | null;
  /** close only: the delivered code argument; null stays null. */
  readonly closeCode: number | null | "NOT_A_CODE";
}

export interface CpmmRecordedCall {
  readonly ordinal: number;
  readonly kind: "CALL";
  readonly method: CpmmTransportMethod;
  /** Ordinal at return or throw; null while still running at finish(). */
  readonly endOrdinal: number | null;
  readonly outcome: "RETURNED" | "THREW" | "IN_PROGRESS";
  /** A fixed wrapper code (`[CPMM_WS] CODE`) when it threw; never the exception text. */
  readonly exceptionCode: string | null;
  /** send, ping and pong only. */
  readonly payload: CpmmRecordedPayload | null;
  /** close only. */
  readonly closeCodeArgument: number | "NOT_A_CODE" | null;
  /** send, ping and pong: whether a function was passed (and so wrapped for observation). */
  readonly completionObserved: boolean;
}

export interface CpmmRecordedCompletion {
  readonly ordinal: number;
  readonly kind: "COMPLETION";
  readonly method: "send" | "ping" | "pong";
  readonly callOrdinal: number;
  /** 1 for the first, more for duplicates. */
  readonly invocation: number;
  readonly failedArgument: boolean | "NOT_BOOLEAN";
  /** Whether the call had already returned or thrown (false: synchronous, inside the call). */
  readonly afterCallEnded: boolean;
  readonly doneThrew: boolean;
}

export interface CpmmRecordedReadyState {
  readonly ordinal: number;
  readonly kind: "READY_STATE";
  readonly value: number | null;
  readonly outcome: "RETURNED" | "THREW";
  readonly exceptionCode: string | null;
}

export interface CpmmRecordedRegistration {
  readonly ordinal: number;
  readonly kind: "REGISTER" | "UNREGISTER";
  readonly event: string;
  /** Recorder-assigned registration id; null when the registration was passed through. */
  readonly registration: number | null;
  readonly outcome: "RETURNED" | "THREW" | "NON_FUNCTION_DISPOSER" | "PASSED_THROUGH";
  readonly exceptionCode: string | null;
}

export type CpmmIncomingRecord = CpmmRecordedEvent;
export type CpmmOutgoingRecord = CpmmRecordedCall | CpmmRecordedCompletion;
export type CpmmControlRecord = CpmmRecordedEvent | CpmmRecordedCall | CpmmRecordedCompletion;
export type CpmmLifecycleRecord =
  | CpmmRecordedEvent
  | CpmmRecordedCall
  | CpmmRecordedReadyState
  | CpmmRecordedRegistration;

export interface CpmmRecordedAccountCall {
  readonly ordinal: number;
  readonly kind: "ACCOUNT_CALL";
  /** 1-based, exact. */
  readonly call: number;
  readonly signature: string | null;
  readonly epoch: number | null;
  /** Copied from the envelope (the owner's reading); null if absent. */
  readonly hostReceivedAtMs: number | null;
  readonly endOrdinal: number | null;
  readonly outcome: "RETURNED" | "THREW" | "IN_PROGRESS";
}

export interface CpmmRecordedAccountSettlement {
  readonly ordinal: number;
  readonly kind: "ACCOUNT_SETTLEMENT";
  readonly call: number;
  readonly outcome: "FULFILLED" | "REJECTED";
  readonly status: string | null;
  readonly occurrence: number | null;
  readonly recordSequence: number | null;
  readonly signature: string | null;
  readonly disposition: string | null;
  readonly factKind: string | null;
  readonly factCode: string | null;
  /** DUPLICATE only. */
  readonly firstSequence: number | null;
  /** INVALID and CAPACITY_REFUSED only. */
  readonly code: string | null;
}

export type CpmmLedgerCallRecord = CpmmRecordedAccountCall | CpmmRecordedAccountSettlement;

export interface CpmmRecordedExchangeEntry {
  readonly seq: number | null;
  readonly lane: string;
  readonly owner: string;
  readonly purpose: string;
  readonly requestedIdentity: string | null;
  readonly jsonRpcId: number | string | null;
  /** The session's readings, copied. */
  readonly dispatchedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly httpStatus: number | null;
  readonly bodyComplete: boolean | null;
  /** A fixed code, or UNRECOGNIZED; never free text. */
  readonly error: string | null;
}

export interface CpmmRecordedExchange {
  readonly ordinal: number;
  readonly kind: "EXCHANGE";
  /** A fixed label: the URL is never retained. */
  readonly endpoint: typeof CPMM_EXCHANGE_ENDPOINT_LABEL;
  readonly entry: CpmmRecordedExchangeEntry;
  readonly method: "GET" | "POST" | "UNRECOGNIZED";
  readonly requestBody: CpmmRecordedPayload | null;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseHeadersTruncated: boolean;
  readonly bodyState: "COMPLETE" | "PARTIAL_OVERFLOW" | "NOT_READ" | "UNRECOGNIZED";
  readonly body: CpmmRecordedPayload | null;
  readonly observedBodyBytes: number | null;
  readonly maxResponseBytes: number | null;
}

export interface CpmmCategoryRetention {
  /** Exact, including dropped records. */
  readonly observed: number;
  readonly retained: number;
  readonly dropped: number;
  readonly payloadsOmitted: number;
  readonly retainedPayloadBytes: number;
}

export type CpmmFinishSection =
  | { readonly status: "READ"; readonly value: unknown }
  | { readonly status: "NOT_SUPPLIED" }
  | { readonly status: "READ_FAILED"; readonly code: CpmmFinishReadCode };

export type CpmmFinishReadCode =
  | "THREW"
  | "INVALID_ARGUMENT"
  | "COPY_LIMIT"
  | "DEPTH_LIMIT"
  | "STRING_LIMIT"
  | "PROXY"
  | "ACCESSOR"
  | "UNSUPPORTED_VALUE";

export interface CpmmObservationSnapshot {
  readonly kind: "CPMM_POOL_OBSERVATION_RECORDING";
  readonly version: 1;
  /** Raw evidence: must be sanitized and sealed before anything persists it. */
  readonly material: "UNSANITIZED_MEMORY_ONLY";
  readonly scope: "OBSERVATION_RECORDING_ONLY";
  readonly limits: CpmmObservationRecorderLimits;
  readonly ordinalsAssigned: number;
  readonly transportRecorded: boolean;
  readonly ledgerRecorded: boolean;
  readonly observationListeners: Readonly<
    Record<CpmmTransportEvent, "ATTACHED" | "REGISTRATION_FAILED" | "NOT_ATTACHED">
  >;
  readonly incoming: readonly CpmmIncomingRecord[];
  readonly outgoing: readonly CpmmOutgoingRecord[];
  readonly control: readonly CpmmControlRecord[];
  readonly lifecycle: readonly CpmmLifecycleRecord[];
  readonly exchanges: readonly CpmmRecordedExchange[];
  readonly ledgerCalls: readonly CpmmLedgerCallRecord[];
  readonly retention: {
    readonly incoming: CpmmCategoryRetention;
    readonly outgoing: CpmmCategoryRetention;
    readonly control: CpmmCategoryRetention;
    readonly lifecycle: CpmmCategoryRetention;
    readonly exchanges: CpmmCategoryRetention;
    readonly ledgerCalls: CpmmCategoryRetention;
    /** No record dropped, no payload omitted, no failure record dropped. */
    readonly recorderRetentionComplete: boolean;
  };
  readonly otherExchanges: {
    /** Exchanges of other purposes, lanes and owners: counted, bodies never kept. */
    readonly total: number;
    readonly byKey: readonly {
      readonly lane: string;
      readonly owner: string;
      readonly purpose: string;
      readonly count: number;
    }[];
    readonly keysOverflowed: number;
  };
  readonly delegatedLedgerCalls: Readonly<Record<string, number>>;
  readonly pending: {
    readonly ownerRegistrationsLive: number;
    readonly dispatchesAwaitingOwnerDelivery: number;
    readonly transportCallsInProgress: number;
    readonly completionsAwaitingFirstCall: {
      readonly send: number;
      readonly ping: number;
      readonly pong: number;
    };
    readonly accountCallsInProgress: number;
    readonly accountSettlementsPending: number;
  };
  readonly instrumentation: {
    /** False on any failure (exact count), including an unexpected async return. */
    readonly complete: boolean;
    readonly failures: number;
    readonly retainedFailures: readonly CpmmRecorderFailure[];
    readonly droppedFailureRecords: number;
  };
  readonly components: {
    readonly report: CpmmFinishSection;
    readonly ownerLateEvents: CpmmFinishSection;
    readonly wrapperDiagnostics: CpmmFinishSection;
    readonly collectorEpochReport: CpmmFinishSection;
    readonly collectorFrameRecords: CpmmFinishSection;
    readonly collectorNotifications: CpmmFinishSection;
    readonly collectorCounters: CpmmFinishSection;
    readonly ledgerRecords: CpmmFinishSection;
    readonly ledgerEpochs: CpmmFinishSection;
    readonly ledgerCounters: CpmmFinishSection;
    readonly sessionLedgerStart: number | null;
    readonly sessionLedgerWindow: CpmmFinishSection;
    readonly sessionLedgerEndLength: CpmmFinishSection;
    readonly fanOutDiagnostics: CpmmFinishSection;
  };
}

/** The label stored in place of the dispatched URL. */
export const CPMM_EXCHANGE_ENDPOINT_LABEL = "SESSION_RPC_ENDPOINT_NOT_RETAINED" as const;

export const CPMM_OBSERVATION_RECORDER_LIMIT_KEYS: readonly (keyof CpmmObservationRecorderLimits)[] =
  objectFreeze([
    "maxIncomingRecords",
    "maxIncomingPayloadBytes",
    "maxOutgoingRecords",
    "maxOutgoingPayloadBytes",
    "maxControlRecords",
    "maxControlPayloadBytes",
    "maxLifecycleRecords",
    "maxExchangeRecords",
    "maxExchangeBodyBytes",
    "maxLedgerCallRecords",
    "maxInstrumentationFailures",
    "maxPayloadBytesPerRecord",
    "maxFinishCopyNodes",
  ] as const);

const POSITIVE_LIMITS: readonly string[] = ["maxPayloadBytesPerRecord", "maxFinishCopyNodes"];

const EVENTS: readonly CpmmTransportEvent[] = objectFreeze([
  "open",
  "message",
  "error",
  "close",
  "ping",
  "pong",
] as const);

/** The accepted wrapper's fixed codes (`[CPMM_WS] CODE`). */
const WRAPPER_CODES: ReadonlySet<string> = new Set([
  "ALREADY_STARTED",
  "CLOSE_THREW",
  "DISPOSED",
  "INVALID_ARGUMENT",
  "NOT_OPEN",
  "NOT_STARTED",
  "PING_THREW",
  "PONG_THREW",
  "SEND_THREW",
  "STARTED_USE_CLOSE",
  "START_FAILED",
  "STATE_UNREADABLE",
  "TERMINATE_THREW",
]);
const WRAPPER_CODE_PATTERN = /^\[CPMM_WS\] ([A-Z_]{1,40})$/;
const FIXED_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

const MAX_IDENTITY_CHARS = 128;
const MAX_JSONRPC_ID_CHARS = 64;
const MAX_HEADERS = 32;
const MAX_HEADER_NAME_CHARS = 64;
const MAX_HEADER_VALUE_CHARS = 512;
const MAX_OTHER_EXCHANGE_KEYS = 64;
const MAX_OPEN_DISPATCHES = 256;
const MAX_COPY_DEPTH = 32;
const MAX_COPY_STRING_CHARS = 4096;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function initFail(message: string): never {
  throw new Error(`[CPMM_RECORDER_INIT] ${message}`);
}

const isObjectLike = (v: unknown): v is object =>
  (typeof v === "object" && v !== null) || typeof v === "function";

/** An own data property, read without running caller code; undefined otherwise. */
function readOwn(o: unknown, key: string): unknown {
  if (!isObjectLike(o) || isProxy(o)) return undefined;
  const d = getOwnDesc(o, key);
  if (d === undefined || !("value" in d)) return undefined;
  return d.value;
}

function readPlainRecord(o: unknown): Record<string, unknown> | null {
  if (typeof o !== "object" || o === null || isProxy(o) || isArray(o)) return null;
  const proto = getProto(o) as unknown;
  if (proto !== ObjectProto && proto !== null) return null;
  return o as Record<string, unknown>;
}

const safeIntOrNull = (v: unknown): number | null =>
  typeof v === "number" && isSafeInteger(v) ? v : null;
const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && isFiniteNumber(v) ? v : null;
const labelOf = (v: unknown): string =>
  typeof v === "string" && LABEL_PATTERN.test(v) ? v : "UNRECOGNIZED";
const fixedCodeOrNull = (v: unknown): string | null =>
  typeof v === "string" && FIXED_CODE_PATTERN.test(v) ? v : null;
const boundedStringOrNull = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;

/** The fixed wrapper code of a thrown value; never retains the value or its text. */
function exceptionCodeOf(e: unknown): string {
  if (!isObjectLike(e) || isProxy(e)) return "NON_ERROR_THROWN";
  const message = readOwn(e, "message");
  if (typeof message !== "string") return "UNRECOGNIZED_EXCEPTION";
  const m = WRAPPER_CODE_PATTERN.exec(message);
  return m !== null && WRAPPER_CODES.has(m[1]!) ? m[1]! : "UNRECOGNIZED_EXCEPTION";
}

/** A fresh copy of a Uint8Array's bytes (through captured getters), or null. */
function copyBytes(v: unknown): Uint8Array | null {
  if (!isObjectLike(v) || isProxy(v) || !isUint8Array(v)) return null;
  const buffer = reflectApply(taBuffer, v, []) as ArrayBufferLike;
  const offset = reflectApply(taByteOffset, v, []) as number;
  const length = reflectApply(taByteLength, v, []) as number;
  const out = new Uint8Array(length);
  out.set(new Uint8Array(buffer, offset, length));
  return out;
}

function byteLengthOf(v: unknown): number | null {
  if (!isObjectLike(v) || isProxy(v) || !isUint8Array(v)) return null;
  return reflectApply(taByteLength, v, []) as number;
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const base64Of = (b: Uint8Array): string =>
  Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    objectFreeze(v);
    for (const k of reflectOwnKeys(v)) deepFreeze((v as Record<PropertyKey, unknown>)[k]);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Retention categories
// ---------------------------------------------------------------------------------------------

class Category<R extends object> {
  public observed = 0;
  public retained = 0;
  public dropped = 0;
  public payloadsOmitted = 0;
  public retainedPayloadBytes = 0;
  public readonly records: R[] = [];

  constructor(
    private readonly maxRecords: number,
    private readonly maxPayloadBytes: number,
  ) {}

  /** Counts the occurrence; true when a record may be retained. */
  public admit(): boolean {
    this.observed++;
    if (this.retained < this.maxRecords) {
      this.retained++;
      return true;
    }
    this.dropped++;
    return false;
  }

  public tryReserveBytes(n: number): boolean {
    if (this.retainedPayloadBytes + n > this.maxPayloadBytes) return false;
    this.retainedPayloadBytes += n;
    return true;
  }

  public stats(): CpmmCategoryRetention {
    return {
      observed: this.observed,
      retained: this.retained,
      dropped: this.dropped,
      payloadsOmitted: this.payloadsOmitted,
      retainedPayloadBytes: this.retainedPayloadBytes,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Internal mutable records (copied into the frozen snapshot at finish)
// ---------------------------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Registration {
  readonly id: number;
  readonly event: CpmmTransportEvent;
  live: boolean;
}

/** One wrapper dispatch still waiting on owner registrations that were live when it began. */
interface Dispatch {
  readonly event: CpmmTransportEvent;
  readonly pending: Set<Registration>;
  readonly record: Mutable<CpmmRecordedEvent> | null;
}

interface CallState {
  readonly ordinal: number;
  readonly method: "send" | "ping" | "pong";
  ended: boolean;
  completions: number;
}

interface AccountState {
  readonly call: number;
  readonly record: Mutable<CpmmRecordedAccountCall> | null;
  settled: boolean;
}

class CopyRefusal {
  constructor(public readonly code: CpmmFinishReadCode) {}
}

// ---------------------------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------------------------

class ObservationRecorder implements CpmmPoolObservationRecorder {
  private readonly limits: CpmmObservationRecorderLimits;
  private ordinal = 0;

  private readonly incoming: Category<CpmmIncomingRecord>;
  private readonly outgoing: Category<CpmmOutgoingRecord>;
  private readonly control: Category<CpmmControlRecord>;
  private readonly lifecycle: Category<CpmmLifecycleRecord>;
  private readonly exchanges: Category<CpmmRecordedExchange>;
  private readonly ledgerCalls: Category<CpmmLedgerCallRecord>;

  private failures = 0;
  private readonly retainedFailures: CpmmRecorderFailure[] = [];
  private droppedFailureRecords = 0;

  // Transport
  private transportRecorded = false;
  private readonly observationState: Record<
    CpmmTransportEvent,
    "ATTACHED" | "REGISTRATION_FAILED" | "NOT_ATTACHED"
  > = {
    open: "NOT_ATTACHED",
    message: "NOT_ATTACHED",
    error: "NOT_ATTACHED",
    close: "NOT_ATTACHED",
    ping: "NOT_ATTACHED",
    pong: "NOT_ATTACHED",
  };
  private readonly observationDisposers: (() => unknown)[] = [];
  private readonly eventCounts: Record<CpmmTransportEvent, number> = {
    open: 0,
    message: 0,
    error: 0,
    close: 0,
    ping: 0,
    pong: 0,
  };
  private readonly liveRegistrations: Record<CpmmTransportEvent, Set<Registration>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
    ping: new Set(),
    pong: new Set(),
  };
  private readonly everDisposed: Record<CpmmTransportEvent, boolean> = {
    open: false,
    message: false,
    error: false,
    close: false,
    ping: false,
    pong: false,
  };
  private nextRegistrationId = 0;
  private readonly openDispatches: Dispatch[] = [];
  private transportCallsInProgress = 0;
  private readonly shimmedCalls = { send: 0, ping: 0, pong: 0 };
  private readonly firstCompletions = { send: 0, ping: 0, pong: 0 };

  // Ledger
  private ledgerRecorded = false;
  private accountCalls = 0;
  private accountCallsInProgress = 0;
  private accountSettlementsPending = 0;
  private readonly delegated: Record<string, number> = {
    getBinding: 0,
    openEpoch: 0,
    epochs: 0,
    counters: 0,
    records: 0,
    summarize: 0,
    version: 0,
  };

  // Exchanges
  private otherExchangeTotal = 0;
  private readonly otherExchanges = new Map<
    string,
    { lane: string; owner: string; purpose: string; count: number }
  >();
  private otherKeysOverflowed = 0;

  // Finish
  private finished = false;
  private finishing = false;
  private snapshot: CpmmObservationSnapshot | null = null;
  private readonly late: Mutable<CpmmRecorderLateActivity> = {
    wrapperEvents: 0,
    ownerDeliveries: 0,
    transportCalls: 0,
    registrations: 0,
    completions: 0,
    ledgerCalls: 0,
    ledgerSettlements: 0,
    exchanges: 0,
  };

  public readonly observeExchange: (evidence: PaperRequestExchangeEvidence) => void;

  constructor(limits: CpmmObservationRecorderLimits) {
    this.limits = limits;
    this.incoming = new Category(limits.maxIncomingRecords, limits.maxIncomingPayloadBytes);
    this.outgoing = new Category(limits.maxOutgoingRecords, limits.maxOutgoingPayloadBytes);
    this.control = new Category(limits.maxControlRecords, limits.maxControlPayloadBytes);
    this.lifecycle = new Category(limits.maxLifecycleRecords, 0);
    this.exchanges = new Category(limits.maxExchangeRecords, limits.maxExchangeBodyBytes);
    this.ledgerCalls = new Category(limits.maxLedgerCallRecords, 0);
    this.observeExchange = (evidence: PaperRequestExchangeEvidence): void => {
      try {
        this.onExchange(evidence);
      } catch {
        this.fail("EXCHANGE", "EXCHANGE_RECORD_FAILED");
      }
    };
  }

  // --- bookkeeping ------------------------------------------------------------------------------

  private nextOrdinal(): number {
    return ++this.ordinal;
  }

  /** Never throws. */
  private fail(layer: CpmmRecorderLayer, code: CpmmRecorderFailureCode): void {
    try {
      this.failures++;
      if (this.retainedFailures.length < this.limits.maxInstrumentationFailures) {
        this.retainedFailures.push({ ordinal: this.nextOrdinal(), layer, code });
      } else {
        this.droppedFailureRecords++;
      }
    } catch {
      // Nothing further can be recorded; the count above is already exact.
    }
  }

  /** Bytes: copied and hashed up to the per-record size, retained within the allowance. */
  private captureBytes(v: unknown, category: Category<object>): CpmmRecordedPayload {
    const length = byteLengthOf(v);
    if (length === null) {
      category.payloadsOmitted++;
      return { byteLength: null, sha256: null, base64: null, omitted: "NOT_BYTES" };
    }
    if (length > this.limits.maxPayloadBytesPerRecord) {
      category.payloadsOmitted++;
      return { byteLength: length, sha256: null, base64: null, omitted: "OVERSIZE_NOT_HASHED" };
    }
    const copy = copyBytes(v)!;
    return this.retainCopy(copy, category);
  }

  /** `useAllowance` false: bounded per record only (request bodies; not response bytes). */
  private captureText(
    v: unknown,
    category: Category<object>,
    useAllowance = true,
  ): CpmmRecordedPayload {
    if (typeof v !== "string") {
      category.payloadsOmitted++;
      return { byteLength: null, sha256: null, base64: null, omitted: "NOT_BYTES" };
    }
    // UTF-8 is never shorter than the UTF-16 length: an oversize string is not encoded at all.
    if (v.length > this.limits.maxPayloadBytesPerRecord) {
      category.payloadsOmitted++;
      return { byteLength: null, sha256: null, base64: null, omitted: "OVERSIZE_NOT_HASHED" };
    }
    const bytes = Buffer.from(v, "utf8");
    if (bytes.length > this.limits.maxPayloadBytesPerRecord) {
      category.payloadsOmitted++;
      return {
        byteLength: bytes.length,
        sha256: null,
        base64: null,
        omitted: "OVERSIZE_NOT_HASHED",
      };
    }
    return this.retainCopy(new Uint8Array(bytes), category, useAllowance);
  }

  private retainCopy(
    copy: Uint8Array,
    category: Category<object>,
    useAllowance = true,
  ): CpmmRecordedPayload {
    const sha256 = sha256Hex(copy);
    if (useAllowance && !category.tryReserveBytes(copy.length)) {
      category.payloadsOmitted++;
      return { byteLength: copy.length, sha256, base64: null, omitted: "BYTE_ALLOWANCE" };
    }
    return { byteLength: copy.length, sha256, base64: base64Of(copy), omitted: null };
  }

  private categoryOfEvent(event: CpmmTransportEvent): Category<object> {
    if (event === "message") return this.incoming;
    if (event === "ping" || event === "pong") return this.control;
    return this.lifecycle;
  }

  private categoryOfMethod(method: CpmmTransportMethod): Category<object> {
    if (method === "send") return this.outgoing;
    if (method === "ping" || method === "pong") return this.control;
    return this.lifecycle;
  }

  // --- transport decorator ----------------------------------------------------------------------

  public recordTransport(inner: CpmmOwnerTransport): CpmmOwnerTransport {
    if (this.finished || this.transportRecorded) {
      this.fail("TRANSPORT", "TRANSPORT_ALREADY_RECORDED");
      return inner;
    }
    const target = inner as unknown as Record<string, (...a: unknown[]) => unknown>;
    const methods = ["start", "send", "ping", "pong", "close", "terminate", "dispose", "on"];
    if (
      !isObjectLike(target) ||
      isProxy(target) ||
      !methods.every((m) => typeof target[m] === "function")
    ) {
      this.fail("TRANSPORT", "TRANSPORT_NOT_RECORDABLE");
      return inner;
    }
    this.transportRecorded = true;
    // One observation listener per event, before the owner registers anything.
    for (const event of EVENTS) {
      const observer = (...args: unknown[]): void => {
        try {
          this.onWrapperEvent(event, args);
        } catch {
          this.fail("TRANSPORT", "EVENT_RECORD_FAILED");
        }
      };
      try {
        const d = target["on"]!(event, observer);
        if (typeof d === "function") {
          this.observationDisposers.push(d as () => unknown);
          this.observationState[event] = "ATTACHED";
        } else {
          this.observationState[event] = "REGISTRATION_FAILED";
          this.fail("TRANSPORT", "OBSERVATION_REGISTRATION_FAILED");
        }
      } catch {
        this.observationState[event] = "REGISTRATION_FAILED";
        this.fail("TRANSPORT", "OBSERVATION_REGISTRATION_FAILED");
      }
    }
    return this.decorate(inner);
  }

  private decorate(inner: CpmmOwnerTransport): CpmmOwnerTransport {
    const target = inner as unknown as Record<string, (...a: unknown[]) => unknown>;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the decorator's methods need it
    const rec = this;
    const decorator = {
      get readyState(): number {
        return rec.readReadyState(inner);
      },
      start: (...a: unknown[]): unknown => rec.call(target, "start", a),
      send: (...a: unknown[]): unknown => rec.call(target, "send", a),
      ping: (...a: unknown[]): unknown => rec.call(target, "ping", a),
      pong: (...a: unknown[]): unknown => rec.call(target, "pong", a),
      close: (...a: unknown[]): unknown => rec.call(target, "close", a),
      terminate: (...a: unknown[]): unknown => rec.call(target, "terminate", a),
      dispose: (...a: unknown[]): unknown => rec.call(target, "dispose", a),
      on: (...a: unknown[]): unknown => rec.register(target, a),
    };
    return objectFreeze(decorator) as unknown as CpmmOwnerTransport;
  }

  private readReadyState(inner: CpmmOwnerTransport): number {
    if (this.finished) {
      this.late.transportCalls++;
      return inner.readyState;
    }
    let ordinal = 0;
    let admitted = false;
    try {
      ordinal = this.nextOrdinal();
      admitted = this.lifecycle.admit();
    } catch {
      this.fail("TRANSPORT", "CALL_RECORD_FAILED");
    }
    let value: number;
    try {
      value = inner.readyState;
    } catch (e) {
      if (admitted) {
        this.pushLifecycle({
          ordinal,
          kind: "READY_STATE",
          value: null,
          outcome: "THREW",
          exceptionCode: this.safeCode(e),
        });
      }
      throw e;
    }
    if (admitted) {
      this.pushLifecycle({
        ordinal,
        kind: "READY_STATE",
        value: safeIntOrNull(value),
        outcome: "RETURNED",
        exceptionCode: null,
      });
    }
    return value;
  }

  private pushLifecycle(r: CpmmLifecycleRecord): void {
    try {
      this.lifecycle.records.push(r);
    } catch {
      this.fail("TRANSPORT", "CALL_RECORD_FAILED");
    }
  }

  private safeCode(e: unknown): string {
    try {
      return exceptionCodeOf(e);
    } catch {
      return "UNRECOGNIZED_EXCEPTION";
    }
  }

  /** One owner call: recorded, then delegated with the original arguments (or a done shim). */
  private call(
    target: Record<string, (...a: unknown[]) => unknown>,
    method: CpmmTransportMethod,
    args: unknown[],
  ): unknown {
    if (this.finished) {
      this.late.transportCalls++;
      return target[method]!(...args);
    }
    let callArgs = args;
    let record: Mutable<CpmmRecordedCall> | null = null;
    let state: CallState | null = null;
    try {
      const ordinal = this.nextOrdinal();
      const category = this.categoryOfMethod(method);
      const admitted = category.admit();
      const completing = method === "send" || method === "ping" || method === "pong";
      const done = completing ? args[1] : undefined;
      const completionObserved = completing && typeof done === "function";
      if (admitted) {
        record = {
          ordinal,
          kind: "CALL",
          method,
          endOrdinal: null,
          outcome: "IN_PROGRESS",
          exceptionCode: null,
          payload:
            method === "send"
              ? this.captureText(args[0], category)
              : method === "ping" || method === "pong"
                ? this.captureBytes(args[0], category)
                : null,
          closeCodeArgument:
            method === "close"
              ? typeof args[0] === "number" && isSafeInteger(args[0])
                ? args[0]
                : "NOT_A_CODE"
              : null,
          completionObserved,
        };
        category.records.push(record);
      }
      if (completionObserved) {
        const m = method as "send" | "ping" | "pong";
        state = { ordinal, method: m, ended: false, completions: 0 };
        this.shimmedCalls[m]++;
        callArgs = [...args];
        callArgs[1] = this.completionShim(state, done as (...a: unknown[]) => unknown);
      }
    } catch {
      this.fail("TRANSPORT", "CALL_RECORD_FAILED");
    }
    this.transportCallsInProgress++;
    let result: unknown;
    try {
      result = target[method]!(...callArgs);
    } catch (e) {
      this.transportCallsInProgress--;
      this.endCall(record, state, "THREW", e);
      throw e;
    }
    this.transportCallsInProgress--;
    this.endCall(record, state, "RETURNED", undefined);
    return result;
  }

  /** After finish() the snapshot is fixed: a call still running then stays IN_PROGRESS there. */
  private endCall(
    record: Mutable<CpmmRecordedCall> | null,
    state: CallState | null,
    outcome: "RETURNED" | "THREW",
    e: unknown,
  ): void {
    try {
      if (state !== null) state.ended = true;
      if (this.finished) return;
      const end = this.nextOrdinal();
      if (record !== null) {
        record.endOrdinal = end;
        record.outcome = outcome;
        record.exceptionCode = outcome === "THREW" ? this.safeCode(e) : null;
      }
    } catch {
      this.fail("TRANSPORT", "CALL_RECORD_FAILED");
    }
  }

  private completionShim(
    state: CallState,
    done: (...a: unknown[]) => unknown,
  ): (...a: unknown[]) => unknown {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the shim keeps its caller's this
    const rec = this;
    const shim = function (this: unknown, ...a: unknown[]): unknown {
      let completion: Mutable<CpmmRecordedCompletion> | null = null;
      try {
        completion = rec.onCompletion(state, a);
      } catch {
        rec.fail("TRANSPORT", "COMPLETION_RECORD_FAILED");
      }
      try {
        return reflectApply(done, this, a);
      } catch (e) {
        if (completion !== null) completion.doneThrew = true;
        throw e;
      }
    };
    return shim;
  }

  private onCompletion(state: CallState, a: unknown[]): Mutable<CpmmRecordedCompletion> | null {
    state.completions++;
    if (state.completions === 1) this.firstCompletions[state.method]++;
    if (this.finished) {
      this.late.completions++;
      return null;
    }
    const ordinal = this.nextOrdinal();
    const category = this.categoryOfMethod(state.method);
    if (!category.admit()) return null;
    const failed = a[0];
    const completion: Mutable<CpmmRecordedCompletion> = {
      ordinal,
      kind: "COMPLETION",
      method: state.method,
      callOrdinal: state.ordinal,
      invocation: state.completions,
      failedArgument: typeof failed === "boolean" ? failed : "NOT_BOOLEAN",
      afterCallEnded: state.ended,
      doneThrew: false,
    };
    category.records.push(completion);
    return completion;
  }

  /** on(event, listener): a real wrapper registration whose shim reports each delivery. */
  private register(target: Record<string, (...a: unknown[]) => unknown>, args: unknown[]): unknown {
    const event = args[0];
    const listener = args[1];
    const known = typeof event === "string" && (EVENTS as readonly string[]).includes(event);
    if (this.finished || !known || typeof listener !== "function") {
      if (this.finished) this.late.registrations++;
      else this.recordRegistration("REGISTER", event, null, "PASSED_THROUGH", null);
      return target["on"]!(...args);
    }
    const ev = event as CpmmTransportEvent;
    const reg: Registration = { id: ++this.nextRegistrationId, event: ev, live: false };
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the shim keeps its caller's this
    const rec = this;
    const fn = listener as (...a: unknown[]) => unknown;
    const shim = function (this: unknown, ...a: unknown[]): unknown {
      let dispatch: Dispatch | null = null;
      try {
        dispatch = rec.attribute(reg);
      } catch {
        rec.fail("TRANSPORT", "DELIVERY_RECORD_FAILED");
      }
      try {
        return reflectApply(fn, this, a);
      } catch (e) {
        if (dispatch !== null && dispatch.record !== null) dispatch.record.ownerListenerThrew++;
        throw e;
      }
    };
    const callArgs = [...args];
    callArgs[1] = shim;
    let innerDisposer: unknown;
    try {
      innerDisposer = target["on"]!(...callArgs);
    } catch (e) {
      this.recordRegistration("REGISTER", ev, reg.id, "THREW", e);
      throw e;
    }
    if (typeof innerDisposer !== "function") {
      this.recordRegistration("REGISTER", ev, reg.id, "NON_FUNCTION_DISPOSER", null);
      return innerDisposer;
    }
    reg.live = true;
    this.liveRegistrations[ev].add(reg);
    this.recordRegistration("REGISTER", ev, reg.id, "RETURNED", null);
    const d = innerDisposer as (...a: unknown[]) => unknown;
    return function (this: unknown, ...a: unknown[]): unknown {
      let r: unknown;
      try {
        r = reflectApply(d, this, a);
      } catch (e) {
        rec.recordRegistration("UNREGISTER", ev, reg.id, "THREW", e);
        throw e;
      }
      rec.unregister(reg);
      return r;
    };
  }

  private recordRegistration(
    kind: "REGISTER" | "UNREGISTER",
    event: unknown,
    registration: number | null,
    outcome: CpmmRecordedRegistration["outcome"],
    e: unknown,
  ): void {
    if (this.finished) {
      this.late.registrations++;
      return;
    }
    try {
      const ordinal = this.nextOrdinal();
      if (!this.lifecycle.admit()) return;
      this.lifecycle.records.push({
        ordinal,
        kind,
        event: labelOf(event),
        registration,
        outcome,
        exceptionCode: outcome === "THREW" ? this.safeCode(e) : null,
      });
    } catch {
      this.fail("TRANSPORT", "CALL_RECORD_FAILED");
    }
  }

  private unregister(reg: Registration): void {
    try {
      if (reg.live) {
        reg.live = false;
        this.liveRegistrations[reg.event].delete(reg);
        this.everDisposed[reg.event] = true;
        for (let i = this.openDispatches.length - 1; i >= 0; i--) {
          const d = this.openDispatches[i]!;
          if (d.pending.delete(reg) && d.pending.size === 0) this.openDispatches.splice(i, 1);
        }
      }
      this.recordRegistration("UNREGISTER", reg.event, reg.id, "RETURNED", null);
    } catch {
      this.fail("TRANSPORT", "CALL_RECORD_FAILED");
    }
  }

  /** The observation listener's body: each wrapper event recorded exactly once. */
  private onWrapperEvent(event: CpmmTransportEvent, args: unknown[]): void {
    if (this.finished) {
      this.late.wrapperEvents++;
      return;
    }
    const ordinal = this.nextOrdinal();
    this.eventCounts[event]++;
    const pending = new Set(this.liveRegistrations[event]);
    const category = this.categoryOfEvent(event);
    let record: Mutable<CpmmRecordedEvent> | null = null;
    if (category.admit()) {
      record = {
        ordinal,
        kind: "EVENT",
        event,
        eventIndex: this.eventCounts[event],
        wrapperObserved: true,
        ownerRegistrationsAtDispatch: pending.size,
        ownerDeliveries: 0,
        ownerListenerThrew: 0,
        delivery:
          pending.size > 0
            ? "OWNER_LISTENERS_REGISTERED"
            : this.everDisposed[event]
              ? "WRAPPER_ONLY_AFTER_OWNER_DISPOSAL"
              : "WRAPPER_ONLY_NO_OWNER_LISTENER",
        argumentCount: args.length,
        payload:
          event === "message" || event === "ping" || event === "pong"
            ? this.captureBytes(args[0], category)
            : null,
        closeCode:
          event !== "close"
            ? null
            : args[0] === null
              ? null
              : typeof args[0] === "number" && isSafeInteger(args[0])
                ? args[0]
                : "NOT_A_CODE",
      };
      category.records.push(record);
    }
    if (pending.size > 0) {
      this.openDispatches.push({ event, pending, record });
      if (this.openDispatches.length > MAX_OPEN_DISPATCHES) {
        this.openDispatches.shift();
        this.fail("TRANSPORT", "CORRELATION_EVICTED");
      }
    }
  }

  /** Credits a delivery to the newest dispatch still waiting on this registration. */
  private attribute(reg: Registration): Dispatch | null {
    if (this.finished) {
      this.late.ownerDeliveries++;
      return null;
    }
    for (let i = this.openDispatches.length - 1; i >= 0; i--) {
      const d = this.openDispatches[i]!;
      if (d.event === reg.event && d.pending.delete(reg)) {
        if (d.record !== null) d.record.ownerDeliveries++;
        if (d.pending.size === 0) this.openDispatches.splice(i, 1);
        return d;
      }
    }
    this.fail("TRANSPORT", "DELIVERY_UNCORRELATED");
    return null;
  }

  // --- delegating ledger ------------------------------------------------------------------------

  public recordLedger(ledger: CpmmResolutionAccountingLedger): CpmmResolutionAccountingLedger {
    if (this.finished || this.ledgerRecorded) {
      this.fail("LEDGER", "LEDGER_ALREADY_RECORDED");
      return ledger;
    }
    const methods = ["getBinding", "openEpoch", "account", "epochs", "counters", "records"];
    if (
      !isObjectLike(ledger) ||
      isProxy(ledger) ||
      !methods.every((m) => typeof (ledger as unknown as Record<string, unknown>)[m] === "function")
    ) {
      this.fail("LEDGER", "LEDGER_NOT_RECORDABLE");
      return ledger;
    }
    this.ledgerRecorded = true;
    const target = ledger as unknown as Record<string, (...a: unknown[]) => unknown>;
    const forward =
      (name: string) =>
      (...a: unknown[]): unknown => {
        this.delegated[name] = (this.delegated[name] ?? 0) + 1;
        return target[name]!(...a);
      };
    const counts = this.delegated;
    const delegating = {
      get version(): unknown {
        counts["version"] = (counts["version"] ?? 0) + 1;
        return (ledger as unknown as { version: unknown }).version;
      },
      getBinding: forward("getBinding"),
      openEpoch: forward("openEpoch"),
      epochs: forward("epochs"),
      counters: forward("counters"),
      records: forward("records"),
      summarize: forward("summarize"),
      account: (...a: unknown[]): unknown => this.account(target, a),
    };
    return asOwnerLedger(objectFreeze(delegating));
  }

  private account(target: Record<string, (...a: unknown[]) => unknown>, args: unknown[]): unknown {
    if (this.finished) {
      this.late.ledgerCalls++;
      return target["account"]!(...args);
    }
    let state: AccountState | null = null;
    try {
      state = this.onAccountCall(args[0]);
    } catch {
      this.fail("LEDGER", "ACCOUNT_RECORD_FAILED");
    }
    this.accountCallsInProgress++;
    let p: unknown;
    try {
      p = target["account"]!(...args);
    } catch (e) {
      this.accountCallsInProgress--;
      this.endAccountCall(state, "THREW");
      throw e;
    }
    this.accountCallsInProgress--;
    this.endAccountCall(state, "RETURNED");
    if (state !== null) this.observeSettlement(state, p);
    return p;
  }

  private onAccountCall(envelope: unknown): AccountState {
    const call = ++this.accountCalls;
    const ordinal = this.nextOrdinal();
    let record: Mutable<CpmmRecordedAccountCall> | null = null;
    if (this.ledgerCalls.admit()) {
      const notification = readOwn(envelope, "notification");
      record = {
        ordinal,
        kind: "ACCOUNT_CALL",
        call,
        signature: boundedStringOrNull(readOwn(notification, "signature"), MAX_IDENTITY_CHARS),
        epoch: safeIntOrNull(readOwn(envelope, "epoch")),
        hostReceivedAtMs: finiteOrNull(readOwn(envelope, "hostReceivedAtMs")),
        endOrdinal: null,
        outcome: "IN_PROGRESS",
      };
      this.ledgerCalls.records.push(record);
    }
    return { call, record, settled: false };
  }

  private endAccountCall(state: AccountState | null, outcome: "RETURNED" | "THREW"): void {
    try {
      if (this.finished) return;
      const end = this.nextOrdinal();
      if (state?.record) {
        state.record.endOrdinal = end;
        state.record.outcome = outcome;
      }
    } catch {
      this.fail("LEDGER", "ACCOUNT_RECORD_FAILED");
    }
  }

  /** A separate observation of the original promise; its handlers never throw. */
  private observeSettlement(state: AccountState, p: unknown): void {
    if (!isObjectLike(p) || isProxy(p) || !isPromise(p)) {
      this.fail("LEDGER", "ACCOUNT_RESULT_NOT_PROMISE");
      return;
    }
    this.accountSettlementsPending++;
    const onFulfilled = (res: unknown): void => {
      try {
        this.onSettlement(state, "FULFILLED", res);
      } catch {
        this.fail("LEDGER", "ACCOUNT_SETTLEMENT_RECORD_FAILED");
      }
    };
    const onRejected = (): void => {
      try {
        this.onSettlement(state, "REJECTED", undefined);
      } catch {
        this.fail("LEDGER", "ACCOUNT_SETTLEMENT_RECORD_FAILED");
      }
    };
    try {
      reflectApply(promiseThen, p, [onFulfilled, onRejected]);
    } catch {
      this.accountSettlementsPending--;
      this.fail("LEDGER", "ACCOUNT_SETTLEMENT_UNOBSERVABLE");
    }
  }

  private onSettlement(state: AccountState, outcome: "FULFILLED" | "REJECTED", res: unknown): void {
    if (state.settled) return;
    state.settled = true;
    if (this.finished) {
      this.late.ledgerSettlements++;
      return;
    }
    this.accountSettlementsPending--;
    const ordinal = this.nextOrdinal();
    if (outcome === "REJECTED") this.fail("LEDGER", "ACCOUNT_REJECTED");
    if (!this.ledgerCalls.admit()) return;
    const record = readOwn(res, "record");
    const status = fixedCodeOrNull(readOwn(res, "status"));
    this.ledgerCalls.records.push({
      ordinal,
      kind: "ACCOUNT_SETTLEMENT",
      call: state.call,
      outcome,
      status,
      occurrence: safeIntOrNull(readOwn(res, "occurrence")),
      recordSequence: safeIntOrNull(readOwn(record, "sequence")),
      signature: boundedStringOrNull(readOwn(record, "signature"), MAX_IDENTITY_CHARS),
      disposition: fixedCodeOrNull(readOwn(record, "disposition")),
      factKind: fixedCodeOrNull(readOwn(record, "factKind")),
      factCode: fixedCodeOrNull(readOwn(record, "factCode")),
      firstSequence: safeIntOrNull(readOwn(res, "firstSequence")),
      code: fixedCodeOrNull(readOwn(res, "code")),
    });
  }

  // --- exchanges --------------------------------------------------------------------------------

  private onExchange(evidence: unknown): void {
    if (this.finished) {
      this.late.exchanges++;
      return;
    }
    const entry = readOwn(evidence, "entry");
    const lane = labelOf(readOwn(entry, "lane"));
    const owner = labelOf(readOwn(entry, "owner"));
    const purpose = labelOf(readOwn(entry, "purpose"));
    if (purpose !== CPMM_TX_PURPOSE) {
      this.otherExchangeTotal++;
      const key = `${lane}|${owner}|${purpose}`;
      const existing = this.otherExchanges.get(key);
      if (existing !== undefined) existing.count++;
      else if (this.otherExchanges.size < MAX_OTHER_EXCHANGE_KEYS) {
        this.otherExchanges.set(key, { lane, owner, purpose, count: 1 });
      } else this.otherKeysOverflowed++;
      return;
    }
    const ordinal = this.nextOrdinal();
    if (!this.exchanges.admit()) return;
    const jsonRpcId = readOwn(entry, "jsonRpcId");
    const errorValue = readOwn(entry, "error");
    const bodyComplete = readOwn(entry, "bodyComplete");
    const method = readOwn(evidence, "method");
    const bodyState = readOwn(evidence, "bodyState");
    const requestBody = readOwn(evidence, "requestBody");
    const body = readOwn(evidence, "body");
    const headers = this.copyHeaders(readOwn(evidence, "responseHeaders"));
    this.exchanges.records.push({
      ordinal,
      kind: "EXCHANGE",
      endpoint: CPMM_EXCHANGE_ENDPOINT_LABEL,
      entry: {
        seq: safeIntOrNull(readOwn(entry, "seq")),
        lane,
        owner,
        purpose,
        requestedIdentity: boundedStringOrNull(
          readOwn(entry, "requestedIdentity"),
          MAX_IDENTITY_CHARS,
        ),
        jsonRpcId:
          typeof jsonRpcId === "number"
            ? safeIntOrNull(jsonRpcId)
            : boundedStringOrNull(jsonRpcId, MAX_JSONRPC_ID_CHARS),
        dispatchedAtMs: finiteOrNull(readOwn(entry, "dispatchedAtMs")),
        completedAtMs: finiteOrNull(readOwn(entry, "completedAtMs")),
        httpStatus: safeIntOrNull(readOwn(entry, "httpStatus")),
        bodyComplete: typeof bodyComplete === "boolean" ? bodyComplete : null,
        error: errorValue === null ? null : (fixedCodeOrNull(errorValue) ?? "UNRECOGNIZED"),
      },
      method: method === "GET" || method === "POST" ? method : "UNRECOGNIZED",
      requestBody:
        requestBody === null ? null : this.captureText(requestBody, this.exchanges, false),
      responseHeaders: headers.headers,
      responseHeadersTruncated: headers.truncated,
      bodyState:
        bodyState === "COMPLETE" || bodyState === "PARTIAL_OVERFLOW" || bodyState === "NOT_READ"
          ? bodyState
          : "UNRECOGNIZED",
      body: body === null || body === undefined ? null : this.captureBytes(body, this.exchanges),
      observedBodyBytes: safeIntOrNull(readOwn(evidence, "observedBodyBytes")),
      maxResponseBytes: safeIntOrNull(readOwn(evidence, "maxResponseBytes")),
    });
  }

  private copyHeaders(v: unknown): { headers: Record<string, string>; truncated: boolean } {
    const out: Record<string, string> = {};
    const o = readPlainRecord(v);
    if (o === null) return { headers: out, truncated: v !== undefined && v !== null };
    let truncated = false;
    let n = 0;
    for (const key of reflectOwnKeys(o)) {
      if (typeof key !== "string") {
        truncated = true;
        continue;
      }
      const d = getOwnDesc(o, key);
      const value = d !== undefined && "value" in d ? (d.value as unknown) : undefined;
      if (
        n >= MAX_HEADERS ||
        key.length > MAX_HEADER_NAME_CHARS ||
        typeof value !== "string" ||
        value.length > MAX_HEADER_VALUE_CHARS
      ) {
        truncated = true;
        continue;
      }
      defineProp(out, key, { value, enumerable: true, writable: true, configurable: true });
      n++;
    }
    return { headers: out, truncated };
  }

  // --- finish -----------------------------------------------------------------------------------

  public lateActivity(): CpmmRecorderLateActivity {
    return objectFreeze({ ...this.late });
  }

  public finish(input: CpmmObservationFinishInput): CpmmObservationSnapshot {
    if (this.snapshot !== null) return this.snapshot;
    if (this.finishing) throw new Error("[CPMM_RECORDER] FINISH_REENTERED");
    this.finishing = true;
    // Recording ends here: later callbacks keep their behaviour and are only counted.
    this.finished = true;
    for (const d of this.observationDisposers) {
      try {
        d();
      } catch {
        this.fail("TRANSPORT", "OBSERVATION_DETACH_FAILED");
      }
    }
    const components = this.readComponents(input);
    const otherByKey = [...this.otherExchanges.values()].map((e) => ({ ...e }));
    const retentionComplete =
      [
        this.incoming,
        this.outgoing,
        this.control,
        this.lifecycle,
        this.exchanges,
        this.ledgerCalls,
      ].every((c) => c.dropped === 0 && c.payloadsOmitted === 0) &&
      this.droppedFailureRecords === 0;
    const snapshot: CpmmObservationSnapshot = {
      kind: "CPMM_POOL_OBSERVATION_RECORDING",
      version: 1,
      material: "UNSANITIZED_MEMORY_ONLY",
      scope: "OBSERVATION_RECORDING_ONLY",
      limits: { ...this.limits },
      ordinalsAssigned: this.ordinal,
      transportRecorded: this.transportRecorded,
      ledgerRecorded: this.ledgerRecorded,
      observationListeners: { ...this.observationState },
      incoming: this.incoming.records.map(copyRecord),
      outgoing: this.outgoing.records.map(copyRecord),
      control: this.control.records.map(copyRecord),
      lifecycle: this.lifecycle.records.map(copyRecord),
      exchanges: this.exchanges.records.map(copyRecord),
      ledgerCalls: this.ledgerCalls.records.map(copyRecord),
      retention: {
        incoming: this.incoming.stats(),
        outgoing: this.outgoing.stats(),
        control: this.control.stats(),
        lifecycle: this.lifecycle.stats(),
        exchanges: this.exchanges.stats(),
        ledgerCalls: this.ledgerCalls.stats(),
        recorderRetentionComplete: retentionComplete,
      },
      otherExchanges: {
        total: this.otherExchangeTotal,
        byKey: otherByKey,
        keysOverflowed: this.otherKeysOverflowed,
      },
      delegatedLedgerCalls: { ...this.delegated },
      pending: {
        ownerRegistrationsLive: EVENTS.reduce((n, e) => n + this.liveRegistrations[e].size, 0),
        dispatchesAwaitingOwnerDelivery: this.openDispatches.length,
        transportCallsInProgress: this.transportCallsInProgress,
        completionsAwaitingFirstCall: {
          send: this.shimmedCalls.send - this.firstCompletions.send,
          ping: this.shimmedCalls.ping - this.firstCompletions.ping,
          pong: this.shimmedCalls.pong - this.firstCompletions.pong,
        },
        accountCallsInProgress: this.accountCallsInProgress,
        accountSettlementsPending: this.accountSettlementsPending,
      },
      instrumentation: {
        complete: this.failures === 0,
        failures: this.failures,
        retainedFailures: this.retainedFailures.map((f) => ({ ...f })),
        droppedFailureRecords: this.droppedFailureRecords,
      },
      components,
    };
    this.snapshot = deepFreeze(snapshot);
    // Correlation state is no longer needed; later deliveries are only counted.
    this.openDispatches.length = 0;
    this.finishing = false;
    return this.snapshot;
  }

  private readComponents(input: unknown): CpmmObservationSnapshot["components"] {
    const budget = { nodes: this.limits.maxFinishCopyNodes };
    const valid = readPlainRecord(input) !== null;
    if (!valid) this.fail("FINISH", "FINISH_INPUT_INVALID");
    const field = (k: string): unknown => (valid ? readOwn(input, k) : undefined);
    const read = (holder: unknown, method: string, args: unknown[]): CpmmFinishSection => {
      if (holder === null || holder === undefined) return { status: "NOT_SUPPLIED" };
      let value: unknown;
      try {
        const fn = (holder as Record<string, unknown>)[method];
        if (typeof fn !== "function") {
          this.fail("FINISH", "FINISH_READ_FAILED");
          return { status: "READ_FAILED", code: "INVALID_ARGUMENT" };
        }
        value = reflectApply(fn as (...a: unknown[]) => unknown, holder, args);
      } catch {
        this.fail("FINISH", "FINISH_READ_FAILED");
        return { status: "READ_FAILED", code: "THREW" };
      }
      return this.copySection(value, budget);
    };
    const epoch = safeIntOrNull(field("epoch"));
    const start = safeIntOrNull(field("sessionLedgerStart"));
    const collector = field("collector");
    const ledger = field("ledger");
    const session = field("session");
    const report = field("report");
    const window: CpmmFinishSection =
      session === null || session === undefined
        ? { status: "NOT_SUPPLIED" }
        : start === null || start < 0
          ? (this.fail("FINISH", "FINISH_READ_FAILED"),
            { status: "READ_FAILED", code: "INVALID_ARGUMENT" })
          : read(session, "getLedgerSince", [start]);
    return {
      report:
        report === null || report === undefined
          ? { status: "NOT_SUPPLIED" }
          : this.copySection(report, budget),
      ownerLateEvents: read(field("owner"), "lateEvents", []),
      wrapperDiagnostics: read(field("wrapper"), "diagnostics", []),
      collectorEpochReport:
        collector === null || collector === undefined
          ? { status: "NOT_SUPPLIED" }
          : epoch === null
            ? (this.fail("FINISH", "FINISH_READ_FAILED"),
              { status: "READ_FAILED", code: "INVALID_ARGUMENT" })
            : read(collector, "epochReport", [epoch]),
      collectorFrameRecords: read(collector, "frameRecords", []),
      collectorNotifications: read(collector, "notifications", []),
      collectorCounters: read(collector, "counters", []),
      ledgerRecords: read(ledger, "records", []),
      ledgerEpochs: read(ledger, "epochs", []),
      ledgerCounters: read(ledger, "counters", []),
      sessionLedgerStart: start,
      sessionLedgerWindow: window,
      sessionLedgerEndLength: read(session, "getLedgerLength", []),
      fanOutDiagnostics: read(field("fanOut"), "diagnostics", []),
    };
  }

  private copySection(value: unknown, budget: { nodes: number }): CpmmFinishSection {
    try {
      return { status: "READ", value: copyData(value, budget, 0) };
    } catch (e) {
      this.fail("FINISH", "FINISH_COPY_REFUSED");
      return { status: "READ_FAILED", code: e instanceof CopyRefusal ? e.code : "THREW" };
    }
  }
}

/** Records are recorder-owned; the snapshot gets shallow copies (payloads are plain data). */
function copyRecord<R extends object>(r: R): R {
  const out = { ...r } as Record<string, unknown>;
  for (const k of ["payload", "body", "requestBody", "entry", "responseHeaders"]) {
    const v = out[k];
    if (typeof v === "object" && v !== null) out[k] = { ...(v as object) };
  }
  return out as R;
}

/**
 * Plain data only: primitives, arrays and plain objects through own data properties, bounded in
 * nodes, depth and string length. Never runs a getter or proxy trap; never freezes the source.
 */
function copyData(v: unknown, budget: { nodes: number }, depth: number): unknown {
  if (--budget.nodes < 0) throw new CopyRefusal("COPY_LIMIT");
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.length > MAX_COPY_STRING_CHARS) throw new CopyRefusal("STRING_LIMIT");
    return v;
  }
  if (typeof v !== "object") throw new CopyRefusal("UNSUPPORTED_VALUE");
  if (isProxy(v)) throw new CopyRefusal("PROXY");
  if (depth >= MAX_COPY_DEPTH) throw new CopyRefusal("DEPTH_LIMIT");
  if (isArray(v)) {
    const len = getOwnDesc(v, "length")!.value as number;
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) {
      const d = getOwnDesc(v, String(i));
      if (d !== undefined && !("value" in d)) throw new CopyRefusal("ACCESSOR");
      out.push(copyData(d?.value, budget, depth + 1));
    }
    return out;
  }
  const proto = getProto(v) as unknown;
  if (proto !== ObjectProto && proto !== null) throw new CopyRefusal("UNSUPPORTED_VALUE");
  const out: Record<string, unknown> = {};
  for (const key of reflectOwnKeys(v)) {
    if (typeof key !== "string") throw new CopyRefusal("UNSUPPORTED_VALUE");
    const d = getOwnDesc(v, key)!;
    if (!("value" in d)) throw new CopyRefusal("ACCESSOR");
    if (!d.enumerable) continue;
    defineProp(out, key, {
      value: copyData(d.value, budget, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Gap G5: the owner's option type names the concrete ledger class, while the owner itself checks
 * only the methods it calls. This is the single, explicit cast of the delegating ledger.
 */
function asOwnerLedger(delegating: object): CpmmResolutionAccountingLedger {
  return delegating as unknown as CpmmResolutionAccountingLedger;
}

function readLimits(v: unknown): CpmmObservationRecorderLimits {
  const o = readPlainRecord(v);
  if (o === null) initFail("limits must be a plain object of data");
  const keys = reflectOwnKeys(o);
  if (
    keys.length !== CPMM_OBSERVATION_RECORDER_LIMIT_KEYS.length ||
    !CPMM_OBSERVATION_RECORDER_LIMIT_KEYS.every((k) => keys.includes(k))
  ) {
    initFail("limits must have exactly the recorder limit keys");
  }
  const out: Record<string, number> = {};
  for (const k of CPMM_OBSERVATION_RECORDER_LIMIT_KEYS) {
    const value = readOwn(o, k);
    const min = POSITIVE_LIMITS.includes(k) ? 1 : 0;
    if (typeof value !== "number" || !isSafeInteger(value) || value < min) {
      initFail(`limits.${k} must be a safe integer >= ${min}`);
    }
    out[k] = value;
  }
  return objectFreeze(out) as unknown as CpmmObservationRecorderLimits;
}

export function createCpmmPoolObservationRecorder(options: {
  readonly limits: CpmmObservationRecorderLimits;
}): CpmmPoolObservationRecorder {
  const o = readPlainRecord(options);
  if (o === null) initFail("options must be a plain object of data");
  const keys = reflectOwnKeys(o);
  if (keys.length !== 1 || keys[0] !== "limits") initFail("options must have exactly limits");
  return new ObservationRecorder(readLimits(readOwn(o, "limits")));
}

// ---------------------------------------------------------------------------------------------
// Exchange-observer fan-out
// ---------------------------------------------------------------------------------------------

export type CpmmFanOutFailureCode =
  | "THREW"
  | "UNEXPECTED_RETURN"
  | "REJECTED"
  | "UNOBSERVABLE_RETURN";

export interface CpmmExchangeFanOutDiagnostics {
  /** False as soon as any observer threw or returned anything (even before a rejection). */
  readonly instrumentationComplete: boolean;
  readonly invocations: number;
  readonly observers: readonly {
    readonly label: string;
    readonly calls: number;
    readonly threw: number;
    readonly unexpectedReturns: number;
    readonly rejected: number;
    readonly unobservableReturns: number;
    /** The fan-out invocation of the first failure; null when none. */
    readonly firstFailureInvocation: number | null;
  }[];
  readonly failures: number;
  readonly retainedFailures: readonly {
    readonly invocation: number;
    readonly observer: string;
    readonly code: CpmmFanOutFailureCode;
  }[];
  readonly droppedFailureRecords: number;
}

export interface CpmmExchangeObserverFanOut {
  /** The function given to the session: synchronous, returns undefined, never throws. */
  readonly observe: (evidence: PaperRequestExchangeEvidence) => void;
  diagnostics(): CpmmExchangeFanOutDiagnostics;
}

function fanOutInitFail(message: string): never {
  throw new Error(`[CPMM_FANOUT_INIT] ${message}`);
}

interface FanOutObserverState {
  readonly label: string;
  readonly observe: (e: PaperRequestExchangeEvidence) => unknown;
  calls: number;
  threw: number;
  unexpectedReturns: number;
  rejected: number;
  unobservableReturns: number;
  firstFailureInvocation: number | null;
}

/**
 * Constructor-time fan-out for the session's single exchange observer, in fixed order (the
 * adapter's evidence recorder first, by the caller's ordering). Each observer runs in its own
 * try; a returned value is an instrumentation failure at once, and a returned thenable gets a
 * rejection handler that only counts, so no rejection is ever unhandled and nothing waits.
 */
export function createExchangeObserverFanOut(options: {
  readonly observers: readonly {
    readonly label: string;
    readonly observe: (e: PaperRequestExchangeEvidence) => void;
  }[];
  readonly maxRetainedFailures: number;
}): CpmmExchangeObserverFanOut {
  const fail = fanOutInitFail;
  const o = readPlainRecord(options);
  if (o === null) fanOutInitFail("options must be a plain object of data");
  const keys = reflectOwnKeys(o);
  if (keys.length !== 2 || !keys.includes("observers") || !keys.includes("maxRetainedFailures")) {
    fail("options must have exactly observers and maxRetainedFailures");
  }
  const maxRetained = readOwn(o, "maxRetainedFailures");
  if (typeof maxRetained !== "number" || !isSafeInteger(maxRetained) || maxRetained < 0) {
    fail("maxRetainedFailures must be a non-negative safe integer");
  }
  const list = readOwn(o, "observers");
  if (!isObjectLike(list) || isProxy(list) || !isArray(list)) fail("observers must be an array");
  const length = getOwnDesc(list as unknown[], "length")!.value as number;
  if (length < 1) fail("observers must not be empty");
  const states: FanOutObserverState[] = [];
  for (let i = 0; i < length; i++) {
    const item = readPlainRecord(readOwn(list, String(i)));
    const label = readOwn(item, "label");
    const observe = readOwn(item, "observe");
    if (item === null || typeof label !== "string" || !LABEL_PATTERN.test(label)) {
      fail(`observers[${i}].label must be a fixed label`);
    }
    if (typeof observe !== "function") fail(`observers[${i}].observe must be a function`);
    if (states.some((s) => s.label === label)) fail(`observers[${i}].label is duplicated`);
    states.push({
      label: label as string,
      observe: observe as (e: PaperRequestExchangeEvidence) => unknown,
      calls: 0,
      threw: 0,
      unexpectedReturns: 0,
      rejected: 0,
      unobservableReturns: 0,
      firstFailureInvocation: null,
    });
  }
  let invocations = 0;
  let failures = 0;
  let dropped = 0;
  const retained: { invocation: number; observer: string; code: CpmmFanOutFailureCode }[] = [];
  const record = (s: FanOutObserverState, invocation: number, code: CpmmFanOutFailureCode) => {
    failures++;
    if (s.firstFailureInvocation === null) s.firstFailureInvocation = invocation;
    if (retained.length < (maxRetained as number)) {
      retained.push({ invocation, observer: s.label, code });
    } else dropped++;
  };
  const observe = (evidence: PaperRequestExchangeEvidence): void => {
    try {
      const invocation = ++invocations;
      for (const s of states) {
        s.calls++;
        let ret: unknown;
        try {
          ret = reflectApply(s.observe, undefined, [evidence]);
        } catch {
          s.threw++;
          record(s, invocation, "THREW");
          continue;
        }
        if (ret === undefined) continue;
        s.unexpectedReturns++;
        record(s, invocation, "UNEXPECTED_RETURN");
        if (!isObjectLike(ret)) continue;
        // Adopt without waiting: a rejection (including a throwing `then`) is only counted.
        try {
          const adopted = reflectApply(promiseResolve, NativePromise, [ret]) as Promise<unknown>;
          reflectApply(promiseThen, adopted, [
            undefined,
            () => {
              try {
                s.rejected++;
                record(s, invocation, "REJECTED");
              } catch {
                // Counting only.
              }
            },
          ]);
        } catch {
          s.unobservableReturns++;
          record(s, invocation, "UNOBSERVABLE_RETURN");
        }
      }
    } catch {
      // The fan-out never throws into the session.
    }
    return undefined;
  };
  const diagnostics = (): CpmmExchangeFanOutDiagnostics =>
    deepFreeze({
      instrumentationComplete: failures === 0,
      invocations,
      observers: states.map((s) => ({
        label: s.label,
        calls: s.calls,
        threw: s.threw,
        unexpectedReturns: s.unexpectedReturns,
        rejected: s.rejected,
        unobservableReturns: s.unobservableReturns,
        firstFailureInvocation: s.firstFailureInvocation,
      })),
      failures,
      retainedFailures: retained.map((f) => ({ ...f })),
      droppedFailureRecords: dropped,
    });
  return objectFreeze({ observe, diagnostics });
}
