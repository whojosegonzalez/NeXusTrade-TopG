/**
 * CPMM pool WebSocket transport wrapper (assessment §8.38.17 item 16). Isolated and unwired.
 *
 * - Implements the accepted owner's `CpmmOwnerTransport` over an injected `ws`-compatible client
 *   constructor. There is no value import of `ws`: the wiring layer passes the constructor.
 *   Nothing connects until `start()`, which reserves its single attempt and then constructs
 *   exactly one client with a fixed, complete option set (no automatic pongs, an exact payload
 *   ceiling, no compression, no redirects, bounded fragments, buffered chunks and timeouts).
 * - No reconnect, retry, fallback endpoint, keepalive or timer of its own. The owner keeps every
 *   deadline and every close or terminate decision; `readyState` is the client's own value.
 * - Messages and control payloads are copied byte-for-byte after bounded inspection through
 *   intrinsics captured at module load; nothing is decoded or parsed, and no getter or proxy trap
 *   of a delivered value runs.
 * - Errors become fixed categories read from safe primitive codes only. No error text, endpoint,
 *   close reason, payload or client object leaves the wrapper: not through events, thrown errors,
 *   diagnostics or inspection (every field is a private `#` field).
 * - The client keeps one permanent listener per event through a minimal relay, so a late client
 *   error is always handled; the relay is cut, and references released, on the actual close.
 */
import { types as utilTypes } from "node:util";
import type { CpmmOwnerTransport } from "./CpmmPoolConnectionOwner.js";

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

export type CpmmWsClientEvent = "open" | "message" | "error" | "close" | "ping" | "pong";

/** The subset of the `ws` client the wrapper uses. */
export interface CpmmWsClientLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string, cb: (err?: unknown) => void): void;
  ping(data: Uint8Array, mask: boolean, cb: (err?: unknown) => void): void;
  pong(data: Uint8Array, mask: boolean, cb: (err?: unknown) => void): void;
  close(code: number): void;
  terminate(): void;
  on(event: CpmmWsClientEvent, listener: (...args: unknown[]) => void): unknown;
}

/** Every client option is explicit; `@types/ws` 8.18.2 lacks the last three keys of `ws` 8.22.1. */
export interface CpmmWsClientOptions {
  readonly allowSynchronousEvents: true;
  readonly autoPong: false;
  readonly closeTimeout: number;
  readonly followRedirects: false;
  readonly handshakeTimeout: number;
  readonly maxBufferedChunks: number;
  readonly maxFragments: number;
  readonly maxPayload: number;
  readonly maxRedirects: 0;
  readonly perMessageDeflate: false;
  readonly skipUTF8Validation: false;
}

export type CpmmWsClientConstructor = new (
  address: string,
  options: CpmmWsClientOptions,
) => CpmmWsClientLike;

/** Positive integers within the receiver's signed 32-bit range and the runtime timer range. */
export interface CpmmPoolWebSocketTransportLimits {
  /** The client's `maxPayload`; equal to the collector's `maxFrameBytes` (composition check). */
  readonly maxFrameBytes: number;
  readonly maxFragments: number;
  readonly maxBufferedChunks: number;
  /** Below the owner's `ackTimeoutMs` (composition check; not visible here). */
  readonly handshakeTimeoutMs: number;
  /** At most the owner's `cleanupTimeoutMs` (composition check; not visible here). */
  readonly closeTimeoutMs: number;
}

export interface CpmmPoolWebSocketTransportOptions {
  /** Opaque and credential-bearing: a `wss:` URL without a fragment, held privately until start. */
  readonly endpoint: string;
  readonly clientConstructor: CpmmWsClientConstructor;
  readonly limits: CpmmPoolWebSocketTransportLimits;
}

export type CpmmWsLifecycle =
  | "DORMANT"
  | "STARTING"
  | "ACTIVE"
  | "START_FAILED"
  | "CLOSED"
  | "DISPOSED";

export type CpmmWsStartupFailure =
  | "CONSTRUCTOR_THREW"
  | "CONSTRUCTOR_RESULT_INVALID"
  | "LISTENER_REGISTRATION_FAILED"
  | "BINARY_TYPE_FAILED";

/** Fixed categories; an unknown pre-open error is never claimed to be an HTTP rejection. */
export type CpmmWsErrorCategory =
  | "PAYLOAD_LIMIT"
  | "INVALID_UTF8"
  | "RECEIVER_LIMIT"
  | "PROTOCOL"
  | "NETWORK"
  | "TLS"
  | "PRE_OPEN_UNCLASSIFIED"
  | "UNCLASSIFIED"
  | "UNREADABLE";

export interface CpmmWsTransportDiagnostics {
  readonly lifecycle: CpmmWsLifecycle;
  readonly clientConstructions: number;
  readonly startupFailure: CpmmWsStartupFailure | null;
  readonly startupCleanup: "TERMINATE_CALLED" | "TERMINATE_THREW" | null;
  readonly opened: boolean;
  readonly messages: {
    readonly received: number;
    readonly delivered: number;
    readonly deliveredBytes: number;
    readonly binaryDelivered: number;
    readonly refusedPayloadLimit: number;
    readonly refusedRepresentation: number;
    readonly suppressedAfterPayloadLimit: number;
    readonly ignored: number;
  };
  readonly control: {
    readonly pingsDelivered: number;
    readonly pongsDelivered: number;
    readonly refused: number;
    readonly ignored: number;
  };
  readonly errors: Readonly<Record<CpmmWsErrorCategory, number>>;
  readonly payloadLimitLatched: boolean;
  readonly close: {
    readonly observed: boolean;
    /** The client's code if it was an integer in 1000–4999, else null. */
    readonly rawCode: number | null;
    /** What the owner received: 1009 only after a latched local refusal; a peer 1009 is null. */
    readonly deliveredCode: number | null;
  };
  readonly completions: {
    readonly completed: number;
    readonly failed: number;
    readonly duplicate: number;
    readonly doneThrew: number;
  };
  readonly callsThrew: {
    readonly send: number;
    readonly ping: number;
    readonly pong: number;
    readonly close: number;
    readonly terminate: number;
  };
  readonly ownerListenerThrew: number;
  /** Client events after the relay was cut (counted only; never delivered). */
  readonly eventsAfterRelease: number;
  /** Exceptions contained inside the relay (never propagated into the client). */
  readonly relayContained: number;
}

// ---------------------------------------------------------------------------------------------
// Captured intrinsics and helpers
// ---------------------------------------------------------------------------------------------

const INT32_MAX = 2_147_483_647;
const CONTROL_PAYLOAD_LIMIT = 125;
const ENDPOINT_MAX_LENGTH = 8_192;
const OWNER_EVENTS: readonly CpmmWsClientEvent[] = [
  "open",
  "message",
  "error",
  "close",
  "ping",
  "pong",
];
/** `error` first: a client error is handled from the first moment one can be emitted. */
const CLIENT_EVENT_ORDER: readonly CpmmWsClientEvent[] = [
  "error",
  "close",
  "open",
  "message",
  "ping",
  "pong",
];
const LIMIT_KEYS = [
  "maxFrameBytes",
  "maxFragments",
  "maxBufferedChunks",
  "handshakeTimeoutMs",
  "closeTimeoutMs",
] as const;
const OPTION_KEYS = ["endpoint", "clientConstructor", "limits"] as const;

const reflectApply = Reflect.apply;
const reflectConstruct = Reflect.construct;
const reflectOwnKeys = Reflect.ownKeys;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const isArray = Array.isArray;
const isProxy = utilTypes.isProxy;
const ArrayPrototype = Array.prototype;
const ObjectPrototype = Object.prototype;
const NativeUint8Array = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = getPrototypeOf(Uint8Array.prototype) as object;

function intrinsicGetter(proto: object, key: PropertyKey): (this: unknown) => unknown {
  const get = getOwnDescriptor(proto, key)?.get;
  if (typeof get !== "function") throw new Error("[CPMM_WS_INIT] missing intrinsic");
  return get;
}
const typedArrayName = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag);
const typedArrayBuffer = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, "buffer");
const typedArrayByteOffset = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, "byteOffset");
const typedArrayByteLength = intrinsicGetter(TYPED_ARRAY_PROTOTYPE, "byteLength");
const typedArraySet = getOwnDescriptor(TYPED_ARRAY_PROTOTYPE, "set")!.value as (
  this: Uint8Array,
  source: ArrayLike<number>,
  offset?: number,
) => void;
const arrayBufferByteLength = intrinsicGetter(ArrayBuffer.prototype, "byteLength");
const arrayBufferDetached = getOwnDescriptor(ArrayBuffer.prototype, "detached")?.get ?? null;

const isSafeNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isInt32Positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= INT32_MAX;
const inc = (v: number, d = 1): number =>
  v > Number.MAX_SAFE_INTEGER - d ? Number.MAX_SAFE_INTEGER : v + d;

function fail(code: string): Error {
  return new Error(`[CPMM_WS] ${code}`);
}
function initFail(message: string): never {
  throw new Error(`[CPMM_WS_INIT] ${message}`);
}

/** Own data properties of a plain, non-proxy object; null otherwise. No user code runs. */
function plainData(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "object" || v === null || isProxy(v) || isArray(v)) return null;
  const proto = getPrototypeOf(v);
  if (proto !== ObjectPrototype && proto !== null) return null;
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of reflectOwnKeys(v)) {
    if (typeof k !== "string") return null;
    const d = getOwnDescriptor(v, k);
    if (!d || !("value" in d)) return null;
    out[k] = d.value;
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function bufferDetached(buffer: unknown): boolean {
  if (arrayBufferDetached === null) return false;
  try {
    return reflectApply(arrayBufferDetached, buffer, []) === true;
  } catch {
    // A SharedArrayBuffer has no detached state.
    return false;
  }
}

interface Span {
  readonly buffer: ArrayBufferLike;
  readonly offset: number;
  readonly length: number;
}

/** A genuine Uint8Array (or Buffer) view read through intrinsics only; null if not genuine. */
function viewSpan(v: unknown): Span | null {
  if (typeof v !== "object" || v === null || isProxy(v)) return null;
  try {
    if (reflectApply(typedArrayName, v, []) !== "Uint8Array") return null;
    const buffer = reflectApply(typedArrayBuffer, v, []) as ArrayBufferLike;
    const offset = reflectApply(typedArrayByteOffset, v, []);
    const length = reflectApply(typedArrayByteLength, v, []);
    if (!isSafeNonNegative(offset) || !isSafeNonNegative(length)) return null;
    if (bufferDetached(buffer)) return null;
    return { buffer, offset, length };
  } catch {
    return null;
  }
}

/** One allocation of exactly `total` bytes, filled from views rebuilt from intrinsic values. */
function copySpans(spans: readonly Span[], total: number): Uint8Array {
  const out = new NativeUint8Array(total);
  let at = 0;
  for (const s of spans) {
    reflectApply(typedArraySet, out, [new NativeUint8Array(s.buffer, s.offset, s.length), at]);
    at += s.length;
  }
  return out;
}

type Converted =
  | { readonly kind: "OK"; readonly bytes: Uint8Array }
  | { readonly kind: "PAYLOAD_LIMIT" | "REPRESENTATION" };
const REPRESENTATION: Converted = Object.freeze({ kind: "REPRESENTATION" });
const PAYLOAD_LIMIT: Converted = Object.freeze({ kind: "PAYLOAD_LIMIT" });

/** Fragments are read through own data descriptors only; the bound is applied before copying. */
function convertFragments(arr: object, max: number, maxFragments: number): Converted {
  if (getPrototypeOf(arr) !== ArrayPrototype) return REPRESENTATION;
  const ld = getOwnDescriptor(arr, "length");
  if (!ld || !("value" in ld) || !isSafeNonNegative(ld.value)) return REPRESENTATION;
  const n = ld.value;
  if (n === 0 || n > maxFragments) return REPRESENTATION;
  const spans: Span[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = getOwnDescriptor(arr, String(i));
    if (!d || !("value" in d)) return REPRESENTATION;
    const s = viewSpan(d.value);
    if (!s) return REPRESENTATION;
    total += s.length;
    // Refused before any allocation and before later elements are read.
    if (total > max) return PAYLOAD_LIMIT;
    spans.push(s);
  }
  return { kind: "OK", bytes: copySpans(spans, total) };
}

/** Bounded, byte-preserving conversion of the client's message representations. */
function convertMessage(v: unknown, max: number, maxFragments: number): Converted {
  try {
    if (typeof v !== "object" || v === null || isProxy(v)) return REPRESENTATION;
    const one = viewSpan(v);
    if (one) {
      if (one.length > max) return PAYLOAD_LIMIT;
      return { kind: "OK", bytes: copySpans([one], one.length) };
    }
    if (isArray(v)) return convertFragments(v, max, maxFragments);
    let length: unknown;
    try {
      length = reflectApply(arrayBufferByteLength, v, []);
    } catch {
      return REPRESENTATION;
    }
    if (!isSafeNonNegative(length) || bufferDetached(v)) return REPRESENTATION;
    if (length > max) return PAYLOAD_LIMIT;
    return {
      kind: "OK",
      bytes: copySpans([{ buffer: v as ArrayBuffer, offset: 0, length }], length),
    };
  } catch {
    return REPRESENTATION;
  }
}

/** A genuine view of at most 125 bytes, copied; null otherwise. */
function controlCopy(v: unknown): Uint8Array | null {
  try {
    const s = viewSpan(v);
    if (!s || s.length > CONTROL_PAYLOAD_LIMIT) return null;
    return copySpans([s], s.length);
  } catch {
    return null;
  }
}

const UNREADABLE_CODE = Symbol("unreadable");

/** An own, data-valued, short string `code` only; getters and proxies are never run. */
function safeErrorCode(err: unknown): string | null | typeof UNREADABLE_CODE {
  if (typeof err !== "object" || err === null) return null;
  try {
    if (isProxy(err)) return UNREADABLE_CODE;
    const d = getOwnDescriptor(err, "code");
    if (d === undefined) return null;
    if (!("value" in d) || typeof d.value !== "string" || d.value.length > 64) {
      return UNREADABLE_CODE;
    }
    return d.value;
  } catch {
    return UNREADABLE_CODE;
  }
}

const PROTOCOL_CODES: ReadonlySet<string> = new Set([
  "WS_ERR_EXPECTED_FIN",
  "WS_ERR_EXPECTED_MASK",
  "WS_ERR_INVALID_CLOSE_CODE",
  "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH",
  "WS_ERR_INVALID_OPCODE",
  "WS_ERR_UNEXPECTED_MASK",
  "WS_ERR_UNEXPECTED_RSV_1",
  "WS_ERR_UNEXPECTED_RSV_2_3",
  "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH",
]);
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EPIPE",
]);
const TLS_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]);

function classifyError(err: unknown, opened: boolean): CpmmWsErrorCategory {
  const code = safeErrorCode(err);
  if (code === UNREADABLE_CODE) return "UNREADABLE";
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") return "PAYLOAD_LIMIT";
  if (code === "WS_ERR_INVALID_UTF8") return "INVALID_UTF8";
  if (code === "WS_ERR_TOO_MANY_BUFFERED_PARTS") return "RECEIVER_LIMIT";
  if (code !== null) {
    if (PROTOCOL_CODES.has(code)) return "PROTOCOL";
    if (NETWORK_CODES.has(code)) return "NETWORK";
    if (TLS_CODES.has(code) || code.startsWith("ERR_SSL_")) return "TLS";
  }
  return opened ? "UNCLASSIFIED" : "PRE_OPEN_UNCLASSIFIED";
}

const isCloseCode = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1000 && v <= 4999;

function validEndpoint(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > ENDPOINT_MAX_LENGTH) return false;
  if (v.includes("#")) return false;
  try {
    return new URL(v).protocol === "wss:";
  } catch {
    // The parse error (which would quote the endpoint) is discarded.
    return false;
  }
}

function clientOptions(l: CpmmPoolWebSocketTransportLimits): CpmmWsClientOptions {
  return Object.freeze({
    allowSynchronousEvents: true,
    autoPong: false,
    closeTimeout: l.closeTimeoutMs,
    followRedirects: false,
    handshakeTimeout: l.handshakeTimeoutMs,
    maxBufferedChunks: l.maxBufferedChunks,
    maxFragments: l.maxFragments,
    maxPayload: l.maxFrameBytes,
    maxRedirects: 0,
    perMessageDeflate: false,
    skipUTF8Validation: false,
  });
}

/** The client keeps only this relay after the actual close (plus its counters). */
interface Relay {
  sink: ((event: CpmmWsClientEvent, args: unknown[]) => void) | null;
  afterRelease: number;
  contained: number;
}

function relayListener(relay: Relay, event: CpmmWsClientEvent): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    const sink = relay.sink;
    if (sink === null) {
      relay.afterRelease = inc(relay.afterRelease);
      return;
    }
    try {
      sink(event, args);
    } catch {
      // Never propagated into the client: an exception here must not become a client error.
      relay.contained = inc(relay.contained);
    }
  };
}

interface ListenerEntry {
  readonly fn: (...args: unknown[]) => void;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface Counters {
  clientConstructions: number;
  messages: Mutable<CpmmWsTransportDiagnostics["messages"]>;
  control: Mutable<CpmmWsTransportDiagnostics["control"]>;
  errors: Record<CpmmWsErrorCategory, number>;
  close: CpmmWsTransportDiagnostics["close"];
  completions: Mutable<CpmmWsTransportDiagnostics["completions"]>;
  callsThrew: Mutable<CpmmWsTransportDiagnostics["callsThrew"]>;
  ownerListenerThrew: number;
}

function newCounters(): Counters {
  return {
    clientConstructions: 0,
    messages: {
      received: 0,
      delivered: 0,
      deliveredBytes: 0,
      binaryDelivered: 0,
      refusedPayloadLimit: 0,
      refusedRepresentation: 0,
      suppressedAfterPayloadLimit: 0,
      ignored: 0,
    },
    control: { pingsDelivered: 0, pongsDelivered: 0, refused: 0, ignored: 0 },
    errors: {
      PAYLOAD_LIMIT: 0,
      INVALID_UTF8: 0,
      RECEIVER_LIMIT: 0,
      PROTOCOL: 0,
      NETWORK: 0,
      TLS: 0,
      PRE_OPEN_UNCLASSIFIED: 0,
      UNCLASSIFIED: 0,
      UNREADABLE: 0,
    },
    close: { observed: false, rawCode: null, deliveredCode: null },
    completions: { completed: 0, failed: 0, duplicate: 0, doneThrew: 0 },
    callsThrew: { send: 0, ping: 0, pong: 0, close: 0, terminate: 0 },
    ownerListenerThrew: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------------------------

export class CpmmPoolWebSocketTransport implements CpmmOwnerTransport {
  /** The wrapper's copy of the endpoint: cleared at start() or dispose(). */
  #endpoint: string | null;
  readonly #ctor: CpmmWsClientConstructor;
  readonly #limits: CpmmPoolWebSocketTransportLimits;
  #lifecycle: CpmmWsLifecycle = "DORMANT";
  #client: CpmmWsClientLike | null = null;
  #relay: Relay | null = null;
  #opened = false;
  #payloadLatched = false;
  #startupFailure: CpmmWsStartupFailure | null = null;
  #startupCleanup: CpmmWsTransportDiagnostics["startupCleanup"] = null;
  readonly #counters: Counters = newCounters();
  readonly #listeners: Record<CpmmWsClientEvent, Set<ListenerEntry>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
    ping: new Set(),
    pong: new Set(),
  };

  constructor(options: CpmmPoolWebSocketTransportOptions) {
    const o = plainData(options);
    if (!o) initFail("options must be a plain object of data");
    const keys = Object.keys(o);
    if (keys.length !== OPTION_KEYS.length || !OPTION_KEYS.every((k) => k in o)) {
      initFail(`options must be exactly ${OPTION_KEYS.join(", ")}`);
    }
    if (!validEndpoint(o.endpoint)) initFail("endpoint must be a wss: URL without a fragment");
    if (typeof o.clientConstructor !== "function" || isProxy(o.clientConstructor)) {
      initFail("clientConstructor must be a constructor");
    }
    const l = plainData(o.limits);
    if (!l || Object.keys(l).length !== LIMIT_KEYS.length || !LIMIT_KEYS.every((k) => k in l)) {
      initFail(`limits must be exactly ${LIMIT_KEYS.join(", ")}`);
    }
    for (const k of LIMIT_KEYS) {
      if (!isInt32Positive(l[k])) initFail(`${k} must be an integer in 1..${INT32_MAX}`);
    }
    // Copies only: the original options object is not retained.
    this.#endpoint = o.endpoint;
    this.#ctor = o.clientConstructor as CpmmWsClientConstructor;
    this.#limits = Object.freeze({
      maxFrameBytes: l.maxFrameBytes as number,
      maxFragments: l.maxFragments as number,
      maxBufferedChunks: l.maxBufferedChunks as number,
      handshakeTimeoutMs: l.handshakeTimeoutMs as number,
      closeTimeoutMs: l.closeTimeoutMs as number,
    });
  }

  // --- owner interface ---------------------------------------------------------------------------

  /** 0 while dormant (the owner interface has no dormant value); otherwise the truthful state. */
  public get readyState(): number {
    switch (this.#lifecycle) {
      case "DORMANT":
        return 0;
      case "CLOSED":
      case "DISPOSED":
        return 3;
      default:
        break;
    }
    const client = this.#client;
    // STARTING before the constructor returned, or a constructor that never produced a client.
    if (client === null) return this.#lifecycle === "STARTING" ? 0 : 3;
    let v: unknown;
    try {
      v = client.readyState;
    } catch {
      throw fail("STATE_UNREADABLE");
    }
    if (v !== 0 && v !== 1 && v !== 2 && v !== 3) throw fail("STATE_UNREADABLE");
    return v;
  }

  /** One time. The attempt is reserved before the constructor runs; a failure is final. */
  public start(): void {
    if (this.#lifecycle === "DISPOSED") throw fail("DISPOSED");
    if (this.#lifecycle !== "DORMANT") throw fail("ALREADY_STARTED");
    this.#lifecycle = "STARTING";
    const endpoint = this.#endpoint as string;
    this.#endpoint = null;
    this.#counters.clientConstructions = 1;
    let client: unknown;
    try {
      client = reflectConstruct(this.#ctor, [endpoint, clientOptions(this.#limits)]);
    } catch {
      // The original exception (which may quote the endpoint) is discarded.
      throw this.#startFailed("CONSTRUCTOR_THREW");
    }
    if (typeof client !== "object" || client === null || isProxy(client)) {
      throw this.#startFailed("CONSTRUCTOR_RESULT_INVALID");
    }
    this.#client = client as CpmmWsClientLike;
    const relay: Relay = {
      sink: (event, args) => this.#onClient(event, args),
      afterRelease: 0,
      contained: 0,
    };
    this.#relay = relay;
    for (const event of CLIENT_EVENT_ORDER) {
      try {
        (client as CpmmWsClientLike).on(event, relayListener(relay, event));
      } catch {
        throw this.#setupFailed("LISTENER_REGISTRATION_FAILED");
      }
    }
    try {
      (client as CpmmWsClientLike).binaryType = "nodebuffer";
    } catch {
      throw this.#setupFailed("BINARY_TYPE_FAILED");
    }
    // A close observed during setup keeps CLOSED.
    if (this.#lifecycle === "STARTING") this.#lifecycle = "ACTIVE";
  }

  public send(data: string, done: (failed: boolean) => void): void {
    if (typeof data !== "string" || typeof done !== "function") throw fail("INVALID_ARGUMENT");
    const client = this.#openClient();
    const cb = this.#completion(done);
    try {
      client.send(data, cb);
    } catch {
      this.#counters.callsThrew.send = inc(this.#counters.callsThrew.send);
      throw fail("SEND_THREW");
    }
  }

  public ping(payload: Uint8Array, done: (failed: boolean) => void): void {
    this.#control("ping", payload, done);
  }

  public pong(payload: Uint8Array, done: (failed: boolean) => void): void {
    this.#control("pong", payload, done);
  }

  /** Passes the code only (no reason). A no-op once the client has closed. */
  public close(code: 1000): void {
    if (code !== 1000) throw fail("INVALID_ARGUMENT");
    const client = this.#startedClient();
    if (client === null) return;
    try {
      client.close(1000);
    } catch {
      this.#counters.callsThrew.close = inc(this.#counters.callsThrew.close);
      throw fail("CLOSE_THREW");
    }
  }

  /** Passes through; never reports CLOSED early (with `ws`, CLOSING until the socket closes). */
  public terminate(): void {
    const client = this.#startedClient();
    if (client === null) return;
    try {
      client.terminate();
    } catch {
      this.#counters.callsThrew.terminate = inc(this.#counters.callsThrew.terminate);
      throw fail("TERMINATE_THREW");
    }
  }

  /** Releases a never-started wrapper; refused once startup has begun. */
  public dispose(): void {
    if (this.#lifecycle === "DISPOSED") return;
    if (this.#lifecycle !== "DORMANT") throw fail("STARTED_USE_CLOSE");
    this.#endpoint = null;
    this.#releaseListeners();
    this.#lifecycle = "DISPOSED";
  }

  public on(event: "open", listener: () => void): () => void;
  public on(event: "message", listener: (data: unknown) => void): () => void;
  public on(event: "error", listener: () => void): () => void;
  public on(event: "close", listener: (code: unknown) => void): () => void;
  public on(event: "ping", listener: (payload: unknown) => void): () => void;
  public on(event: "pong", listener: (payload: unknown) => void): () => void;
  public on(event: string, listener: (...args: never[]) => void): () => void {
    if (!OWNER_EVENTS.includes(event as CpmmWsClientEvent) || typeof listener !== "function") {
      throw fail("INVALID_ARGUMENT");
    }
    // Nothing can be delivered any more: the listener is not retained.
    if (this.#lifecycle === "CLOSED" || this.#lifecycle === "DISPOSED") return () => undefined;
    const set = this.#listeners[event as CpmmWsClientEvent];
    const entry: ListenerEntry = { fn: listener as (...args: unknown[]) => void };
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  /** Fixed codes and counters only. */
  public diagnostics(): CpmmWsTransportDiagnostics {
    const c = this.#counters;
    return deepFreeze({
      lifecycle: this.#lifecycle,
      clientConstructions: c.clientConstructions,
      startupFailure: this.#startupFailure,
      startupCleanup: this.#startupCleanup,
      opened: this.#opened,
      messages: { ...c.messages },
      control: { ...c.control },
      errors: { ...c.errors },
      payloadLimitLatched: this.#payloadLatched,
      close: { ...c.close },
      completions: { ...c.completions },
      callsThrew: { ...c.callsThrew },
      ownerListenerThrew: c.ownerListenerThrew,
      eventsAfterRelease: this.#relay?.afterRelease ?? 0,
      relayContained: this.#relay?.contained ?? 0,
    });
  }

  // --- startup failures --------------------------------------------------------------------------

  /** No client exists: nothing to clean up; the state is truthfully closed. */
  #startFailed(kind: CpmmWsStartupFailure): Error {
    this.#startupFailure = kind;
    this.#lifecycle = "START_FAILED";
    return fail("START_FAILED");
  }

  /** A client exists: best-effort terminate, and the truthful state until its close is seen. */
  #setupFailed(kind: CpmmWsStartupFailure): Error {
    this.#startupFailure = kind;
    if (this.#lifecycle === "STARTING") this.#lifecycle = "START_FAILED";
    const client = this.#client;
    if (client !== null) {
      try {
        client.terminate();
        this.#startupCleanup = "TERMINATE_CALLED";
      } catch {
        this.#startupCleanup = "TERMINATE_THREW";
      }
    }
    return fail("START_FAILED");
  }

  // --- outgoing -----------------------------------------------------------------------------------

  /** The client, if startup has begun and it has not closed; refuses before start(). */
  #startedClient(): CpmmWsClientLike | null {
    if (this.#lifecycle === "DORMANT") throw fail("NOT_STARTED");
    if (this.#lifecycle === "DISPOSED") throw fail("DISPOSED");
    return this.#client;
  }

  #openClient(): CpmmWsClientLike {
    if (this.#lifecycle === "DORMANT") throw fail("NOT_STARTED");
    const client = this.#client;
    if (client === null || (this.#lifecycle !== "ACTIVE" && this.#lifecycle !== "STARTING")) {
      throw fail("NOT_OPEN");
    }
    let state: unknown;
    try {
      state = client.readyState;
    } catch {
      throw fail("STATE_UNREADABLE");
    }
    if (state !== 1) throw fail("NOT_OPEN");
    return client;
  }

  #control(kind: "ping" | "pong", payload: unknown, done: (failed: boolean) => void): void {
    if (typeof done !== "function") throw fail("INVALID_ARGUMENT");
    // Copied before the call: later mutation by the caller cannot change the sent bytes.
    const copy = controlCopy(payload);
    if (copy === null) throw fail("INVALID_ARGUMENT");
    const client = this.#openClient();
    const cb = this.#completion(done);
    try {
      if (kind === "ping") client.ping(copy, true, cb);
      else client.pong(copy, true, cb);
    } catch {
      this.#counters.callsThrew[kind] = inc(this.#counters.callsThrew[kind]);
      throw fail(kind === "ping" ? "PING_THREW" : "PONG_THREW");
    }
  }

  /**
   * Every client callback is forwarded (the owner counts duplicates). The error argument is only
   * compared with null and undefined; it is never inspected.
   */
  #completion(done: (failed: boolean) => void): (err?: unknown) => void {
    const c = this.#counters.completions;
    let calls = 0;
    return (err?: unknown): void => {
      calls++;
      const failed = !(err === undefined || err === null);
      if (calls > 1) c.duplicate = inc(c.duplicate);
      else if (failed) c.failed = inc(c.failed);
      else c.completed = inc(c.completed);
      try {
        done(failed);
      } catch {
        c.doneThrew = inc(c.doneThrew);
      }
    };
  }

  // --- incoming -----------------------------------------------------------------------------------

  #onClient(event: CpmmWsClientEvent, args: unknown[]): void {
    if (event === "error") return this.#onClientError(args[0]);
    if (event === "close") return this.#onClientClose(args[0]);
    const forwarding = this.#lifecycle === "ACTIVE" || this.#lifecycle === "STARTING";
    const c = this.#counters;
    if (event === "open") {
      if (!forwarding) return;
      this.#opened = true;
      this.#dispatch("open", []);
      return;
    }
    if (event === "message") {
      c.messages.received = inc(c.messages.received);
      if (!forwarding) {
        c.messages.ignored = inc(c.messages.ignored);
        return;
      }
      // After a known local payload refusal, no application message is delivered.
      if (this.#payloadLatched) {
        c.messages.suppressedAfterPayloadLimit = inc(c.messages.suppressedAfterPayloadLimit);
        return;
      }
      const r = convertMessage(args[0], this.#limits.maxFrameBytes, this.#limits.maxFragments);
      if (r.kind !== "OK") {
        if (r.kind === "PAYLOAD_LIMIT") {
          c.messages.refusedPayloadLimit = inc(c.messages.refusedPayloadLimit);
        } else c.messages.refusedRepresentation = inc(c.messages.refusedRepresentation);
        // A wrapper-side refusal is a generic transport error for the owner.
        this.#dispatch("error", []);
        return;
      }
      c.messages.delivered = inc(c.messages.delivered);
      c.messages.deliveredBytes = inc(c.messages.deliveredBytes, r.bytes.length);
      if (args[1] === true) c.messages.binaryDelivered = inc(c.messages.binaryDelivered);
      this.#dispatch("message", [r.bytes]);
      return;
    }
    // ping or pong
    if (!forwarding) {
      c.control.ignored = inc(c.control.ignored);
      return;
    }
    const copy = controlCopy(args[0]);
    if (copy === null) {
      c.control.refused = inc(c.control.refused);
      this.#dispatch("error", []);
      return;
    }
    if (event === "ping") c.control.pingsDelivered = inc(c.control.pingsDelivered);
    else c.control.pongsDelivered = inc(c.control.pongsDelivered);
    this.#dispatch(event, [copy]);
  }

  #onClientError(err: unknown): void {
    const category = classifyError(err, this.#opened);
    const e = this.#counters.errors;
    e[category] = inc(e[category]);
    if (category === "PAYLOAD_LIMIT") {
      // Suppressed: the actual close is reported to the owner as 1009.
      this.#payloadLatched = true;
      return;
    }
    if (this.#lifecycle === "CLOSED" || this.#lifecycle === "DISPOSED") return;
    this.#dispatch("error", []);
  }

  /** The actual close: references are released first, then the owner is told once. */
  #onClientClose(code: unknown): void {
    const raw = isCloseCode(code) ? code : null;
    const delivered = this.#payloadLatched ? 1009 : raw === 1009 ? null : raw;
    this.#counters.close = { observed: true, rawCode: raw, deliveredCode: delivered };
    this.#lifecycle = "CLOSED";
    this.#client = null;
    if (this.#relay !== null) this.#relay.sink = null;
    this.#dispatch("close", [delivered]);
    this.#releaseListeners();
  }

  /** Snapshot dispatch; a listener removed during the dispatch is skipped; throws are contained. */
  #dispatch(event: CpmmWsClientEvent, args: readonly unknown[]): void {
    const set = this.#listeners[event];
    for (const entry of [...set]) {
      if (!set.has(entry)) continue;
      try {
        reflectApply(entry.fn, undefined, args);
      } catch {
        this.#counters.ownerListenerThrew = inc(this.#counters.ownerListenerThrew);
      }
    }
  }

  #releaseListeners(): void {
    for (const event of OWNER_EVENTS) this.#listeners[event].clear();
  }
}
