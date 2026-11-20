/**
 * Bounded exact-pool CPMM notification collector (assessment §8.38.17 item 14). Passive, isolated
 * and unwired.
 *
 * - It receives frames from a future connection owner and classifies each one exactly once. It
 *   holds no transport, sends nothing, reads no clock, owns no timer, and calls neither the
 *   adapter, the ledger, the session nor the tracker. It never makes a request.
 * - It binds one pool and mint (owner-supplied, from the adapter's `getBinding()`; not verified
 *   on-chain here), one epoch at a time, and one acknowledged subscription per epoch.
 * - Accepted notifications carry only the signature, `context.slot` and the injected host receipt
 *   time. A block time is never produced: the `logsNotification` schema has none.
 * - Raw payloads are never retained: frame records hold metadata (length, SHA-256, disposition).
 *   Raw protocol replay is therefore unavailable; the records are not a sealed capture.
 * - Nothing here establishes notification completeness, a quiet window or qualification.
 */
import { createHash } from "node:crypto";
import { isCanonicalSolanaBase58 } from "../research/pilot/RaydiumAmmParser.js";
import { isValidSolanaSignature } from "./ExactPoolHistoryEnumerator.js";
import type { CpmmNotificationEnvelope } from "./CpmmResolutionAccountingLedger.js";
import type { CpmmAdapterBinding } from "./RaydiumCpmmTransactionSourceAdapter.js";
import {
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
} from "./RaydiumCpmmSwapDecoder.js";

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

/** All injected positive safe integers. No defaults and no live values. */
export interface CpmmCollectorLimits {
  /** One frame; checked before copying, hashing or decoding. */
  readonly maxFrameBytes: number;
  /** Frames counted per epoch. */
  readonly maxEpochFrames: number;
  /** Cumulative bytes per epoch. */
  readonly maxEpochBytes: number;
  /** Frame metadata records kept, collector-wide. */
  readonly maxRetainedFrameRecords: number;
  /** Accepted-notification records kept, collector-wide. */
  readonly maxRetainedNotifications: number;
  /** Retained epoch metadata. */
  readonly maxEpochs: number;
}

export interface CpmmCollectorOptions {
  /** Owner-supplied pool and mint identity (the adapter's getBinding()). */
  readonly binding: CpmmAdapterBinding;
  readonly limits: CpmmCollectorLimits;
  /** Matches the adapter's getTransaction commitment. */
  readonly commitment: "confirmed";
}

export interface CpmmCollectorEpochOpen {
  /** Safe integer >= 0, strictly increasing; the same number the owner gives the ledger. */
  readonly epoch: number;
  /** HOST, positive safe integer. */
  readonly observationStartMs: number;
  /** Positive safe integer chosen by the owner. */
  readonly subscribeRequestId: number;
}

export type CpmmCollectorOpenResult =
  | {
      readonly status: "OPENED";
      readonly epoch: number;
      /** The exact bytes the owner sends; a fresh copy. */
      readonly subscribeFrame: Uint8Array;
    }
  | {
      /** The previously open epoch is closed anyway (SUPERSEDED), unless it was already closed. */
      readonly status: "REFUSED";
      readonly code: "EPOCH_INVALID" | "EPOCH_NOT_INCREASING" | "EPOCH_CAPACITY";
    };

export interface CpmmCollectorFrame {
  /** Captured by the owner when it attached the transport. */
  readonly epoch: number;
  /** The original message bytes; only this view's range is read. */
  readonly bytes: Uint8Array;
  /** HOST, injected; never read from a clock here. */
  readonly receivedAtMs: number;
}

export type CpmmFrameDisposition =
  // accepted
  | "SUBSCRIBE_ACKNOWLEDGED"
  | "NOTIFICATION_ACCEPTED"
  | "UNSUBSCRIBE_ACKNOWLEDGED"
  | "UNSUBSCRIBE_REJECTED"
  // not decoded
  | "FRAME_INVALID"
  | "EPOCH_NOT_OPEN"
  | "STALE_EPOCH"
  | "RECEIPT_INVALID"
  | "OVERSIZE_FRAME"
  | "EPOCH_LIMIT_EXCEEDED"
  // decoded and refused
  | "INVALID_UTF8"
  | "NOT_JSON"
  | "MALFORMED_MESSAGE"
  | "SUBSCRIBE_REJECTED"
  | "DUPLICATE_RESPONSE"
  | "MISMATCHED_RESPONSE_ID"
  | "PRE_ACK_NOTIFICATION"
  | "FOREIGN_SUBSCRIPTION"
  | "UNEXPECTED_METHOD"
  | "MALFORMED_NOTIFICATION";

export const CPMM_FRAME_DISPOSITIONS: readonly CpmmFrameDisposition[] = Object.freeze([
  "SUBSCRIBE_ACKNOWLEDGED",
  "NOTIFICATION_ACCEPTED",
  "UNSUBSCRIBE_ACKNOWLEDGED",
  "UNSUBSCRIBE_REJECTED",
  "FRAME_INVALID",
  "EPOCH_NOT_OPEN",
  "STALE_EPOCH",
  "RECEIPT_INVALID",
  "OVERSIZE_FRAME",
  "EPOCH_LIMIT_EXCEEDED",
  "INVALID_UTF8",
  "NOT_JSON",
  "MALFORMED_MESSAGE",
  "SUBSCRIBE_REJECTED",
  "DUPLICATE_RESPONSE",
  "MISMATCHED_RESPONSE_ID",
  "PRE_ACK_NOTIFICATION",
  "FOREIGN_SUBSCRIPTION",
  "UNEXPECTED_METHOD",
  "MALFORMED_NOTIFICATION",
]);

/** Dispositions that never make an epoch dirty by themselves. */
const NON_BLOCKING: ReadonlySet<CpmmFrameDisposition> = new Set([
  "SUBSCRIBE_ACKNOWLEDGED",
  "NOTIFICATION_ACCEPTED", // unless the notification claims a transaction error (see below)
  "UNSUBSCRIBE_ACKNOWLEDGED",
  "UNSUBSCRIBE_REJECTED",
]);

export interface CpmmCollectedNotification {
  /** Collector-wide order of acceptance. */
  readonly sequence: number;
  readonly frameSequence: number;
  readonly epoch: number;
  readonly subscriptionId: number;
  readonly signature: string;
  /** params.result.context.slot: a source claim the adapter later compares. */
  readonly slot: number;
  /** HOST, injected. */
  readonly receivedAtMs: number;
  /** value.err === null, or not; the error content is never retained. */
  readonly notifiedTransactionError: "NULL" | "PRESENT";
  readonly frameSha256: string;
}

export interface CpmmFrameRecord {
  readonly sequence: number;
  /** Null when unattributed. */
  readonly epoch: number | null;
  /** Null when the frame envelope or receipt was invalid. */
  readonly receivedAtMs: number | null;
  readonly byteLength: number;
  /** SHA-256 of the original bytes; null when the frame was not hashed. */
  readonly sha256: string | null;
  readonly disposition: CpmmFrameDisposition;
  readonly blocking: boolean;
  readonly code: string | null;
}

export type CpmmFrameResult =
  | {
      readonly status: "ACCEPTED_NOTIFICATION";
      readonly frameSequence: number;
      readonly epoch: number;
      readonly disposition: "NOTIFICATION_ACCEPTED";
      /** True when the notification claims a transaction error (validation pending). */
      readonly blocking: boolean;
      readonly notification: CpmmCollectedNotification;
      /** Always returned, even when the notification record is not retained. */
      readonly envelope: CpmmNotificationEnvelope;
      readonly recordRetained: boolean;
    }
  | {
      readonly status: "RECORDED";
      readonly frameSequence: number;
      readonly epoch: number | null;
      readonly disposition: Exclude<CpmmFrameDisposition, "NOTIFICATION_ACCEPTED">;
      readonly blocking: boolean;
      readonly code: string | null;
    };

export type CpmmEpochCloseReason =
  | "OWNER_CLOSED"
  | "TRANSPORT_CLOSED"
  | "TRANSPORT_ERROR"
  | "CANCELLED"
  | "ACK_TIMEOUT"
  | "KEEPALIVE_TIMEOUT"
  | "LIMIT_EXCEEDED"
  | "SUPERSEDED";

const CLOSE_REASONS: ReadonlySet<string> = new Set([
  "OWNER_CLOSED",
  "TRANSPORT_CLOSED",
  "TRANSPORT_ERROR",
  "CANCELLED",
  "ACK_TIMEOUT",
  "KEEPALIVE_TIMEOUT",
  "LIMIT_EXCEEDED",
  "SUPERSEDED",
]);

export interface CpmmMetadataRetention {
  readonly frameRecordsRetained: number;
  readonly frameRecordsDropped: number;
  readonly notificationRecordsRetained: number;
  readonly notificationRecordsDropped: number;
  /** True only when nothing was dropped; independent of collectionClean. */
  readonly complete: boolean;
  /** Raw payloads are never retained; raw protocol replay is unavailable. */
  readonly rawPayloadRetained: false;
  readonly replayableCaptureEstablished: false;
}

export interface CpmmCollectionEpochReport {
  readonly binding: CpmmAdapterBinding;
  readonly epoch: number;
  readonly observationStartMs: number;
  readonly state: "OPEN" | "CLOSED";
  readonly subscription: "AWAITING_ACK" | "ACKNOWLEDGED" | "REJECTED" | "MALFORMED_RESPONSE";
  readonly subscribeRequestId: number;
  readonly subscriptionId: number | null;
  readonly acknowledgedAtMs: number | null;
  readonly unsubscribe: {
    /**
     * BUILT_UNOBSERVED: the request bytes were prepared; whether the owner sent them is unknown.
     * ACKNOWLEDGED and REJECTED come only from an observed response to that request ID.
     */
    readonly status: "NOT_BUILT" | "BUILT_UNOBSERVED" | "ACKNOWLEDGED" | "REJECTED";
    readonly requestId: number | null;
  };
  /**
   * Null while open, and null when the close instant is unknown: an epoch superseded by an invalid
   * open, or by one whose observation start precedes this epoch's start or latest valid receipt.
   */
  readonly closedAtMs: number | null;
  /** The first close reason; never replaced. */
  readonly closeReason: CpmmEpochCloseReason | null;
  readonly frames: number;
  readonly bytes: number;
  readonly byDisposition: Readonly<Record<CpmmFrameDisposition, number>>;
  readonly notificationsAccepted: number;
  readonly notificationsWithTransactionError: number;
  readonly blockingFrames: number;
  /** Sticky once an acquisition limit was breached. */
  readonly acquisitionLimitLatched: boolean;
  /**
   * Collection only; never completeness. False while awaiting the subscribe acknowledgement (not
   * yet clean); a valid first acknowledgement may make it true. Every other false term is sticky
   * uncertainty that is never cleared: a blocking frame, a transaction-error claim, a rejected or
   * malformed subscribe response, an acquisition limit, an abnormal close, an unattributed frame
   * or counter saturation.
   */
  readonly collectionClean: boolean;
  readonly metadataRetention: CpmmMetadataRetention;
  readonly notificationCompletenessEstablished: false;
  readonly quietWindowEstablished: false;
  readonly qualificationEligible: false;
}

export interface CpmmCollectorCounters {
  readonly frames: number;
  readonly bytes: number;
  readonly unattributedFrames: number;
  readonly openEpochRefused: number;
  readonly notificationsAccepted: number;
  readonly metadataRetention: CpmmMetadataRetention;
  readonly saturated: boolean;
}

/** Saturating increment: exact up to Number.MAX_SAFE_INTEGER, then stuck and flagged. */
export function cpmmCollectorSaturatingAdd(
  value: number,
  delta = 1,
): { readonly value: number; readonly saturated: boolean } {
  return value > Number.MAX_SAFE_INTEGER - delta
    ? { value: Number.MAX_SAFE_INTEGER, saturated: true }
    : { value: value + delta, saturated: false };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Addresses that are programs, sysvars or well-known mints: never an exact CPMM pool or candidate. */
const DEGENERATE_ADDRESSES: ReadonlySet<string> = new Set([
  "11111111111111111111111111111111", // system program (all-zero key)
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_AUTHORITY,
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4 program
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token program
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // memo program
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  WSOL_MINT,
]);

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Own string-keyed data properties into a null-prototype record (no accessors, no setters). */
function readDataRecord(v: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(v)) return null;
  const out = Object.create(null) as Record<string, unknown>;
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== "string") return null;
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d)) return null;
    Object.defineProperty(out, k, {
      value: d.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return out;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function exactKeys(r: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(r);
  return own.length === keys.length && keys.every((k) => hasOwn(r, k));
}

const isSafeNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isSafePositive = (v: unknown): v is number => isSafeNonNegative(v) && v >= 1;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// Intrinsics captured at module load. Validation reads internal slots through these, never through
// properties of the supplied object, which a caller can shadow (an own `byteLength`) or a proxy
// can fabricate (a `get` trap or a custom iterator).
const NativeUint8Array = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
function intrinsicGetter(key: PropertyKey): (this: unknown) => unknown {
  const get = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, key)?.get;
  if (typeof get !== "function")
    throw new Error(`[CPMM_COLLECTOR_INIT] missing intrinsic ${String(key)}`);
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

/**
 * A genuine Uint8Array (including Buffer) as a fixed-length view of exactly its current range, or
 * null. Never throws and never invokes a property, trap or iterator of the supplied object:
 * - `%TypedArray%.prototype[@@toStringTag]` returns "Uint8Array" only for an object with the
 *   [[TypedArrayName]] internal slot, so proxies, DataViews, other element types and objects that
 *   merely inherit from Uint8Array.prototype are refused without running any trap.
 * - The buffer, offset and length come from the intrinsic getters (internal slots); a shadowing
 *   own property is ignored.
 * - The returned view has an explicit length, so a length-tracking view over a resizable or
 *   growable buffer cannot widen the range that was checked against the limits.
 */
function byteView(v: unknown): { readonly view: Uint8Array; readonly length: number } | null {
  try {
    if (Reflect.apply(typedArrayName, v, []) !== "Uint8Array") return null;
    const buffer = Reflect.apply(typedArrayBuffer, v, []) as ArrayBufferLike;
    const offset = Reflect.apply(typedArrayByteOffset, v, []);
    const length = Reflect.apply(typedArrayByteLength, v, []);
    if (!isSafeNonNegative(offset) || !isSafeNonNegative(length)) return null;
    return { view: new NativeUint8Array(buffer, offset, length), length };
  } catch {
    return null;
  }
}

/** One copy of exactly the validated range (internal slots only; no species or iterator). */
function copyRange(view: Uint8Array, length: number): Uint8Array {
  const copy = new NativeUint8Array(length);
  Reflect.apply(typedArraySet, copy, [view]);
  return copy;
}

/** Strict UTF-8: null for any invalid sequence (never replacement characters). */
function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function isRpcError(v: unknown): boolean {
  const e = readDataRecord(v);
  if (!e) return false;
  if (Object.keys(e).some((k) => k !== "code" && k !== "message" && k !== "data")) return false;
  return (
    typeof e.code === "number" && Number.isSafeInteger(e.code) && typeof e.message === "string"
  );
}

// ---------------------------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------------------------

interface EpochState {
  readonly epoch: number;
  readonly observationStartMs: number;
  readonly subscribeRequestId: number;
  readonly subscribeFrameText: string;
  closed: boolean;
  closedAtMs: number | null;
  closeReason: CpmmEpochCloseReason | null;
  subscription: CpmmCollectionEpochReport["subscription"];
  subscribeResponseSeen: boolean;
  subscriptionId: number | null;
  acknowledgedAtMs: number | null;
  unsubscribeStatus: CpmmCollectionEpochReport["unsubscribe"]["status"];
  unsubscribeRequestId: number | null;
  unsubscribeResponseSeen: boolean;
  frames: number;
  bytes: number;
  lastReceiptMs: number | null;
  readonly byDisposition: Record<CpmmFrameDisposition, number>;
  notificationsAccepted: number;
  notificationsWithTransactionError: number;
  blockingFrames: number;
  acquisitionLimitLatched: boolean;
  frameRecordsRetained: number;
  frameRecordsDropped: number;
  notificationRecordsRetained: number;
  notificationRecordsDropped: number;
}

type Classified =
  | {
      kind: "RECORD";
      disposition: Exclude<CpmmFrameDisposition, "NOTIFICATION_ACCEPTED">;
      code: string | null;
    }
  | {
      kind: "NOTIFICATION";
      signature: string;
      slot: number;
      subscriptionId: number;
      err: "NULL" | "PRESENT";
    };

const record = (
  disposition: Exclude<CpmmFrameDisposition, "NOTIFICATION_ACCEPTED">,
  code: string | null = null,
): Classified => ({ kind: "RECORD", disposition, code });

// ---------------------------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------------------------

export class CpmmPoolNotificationCollector {
  private readonly binding: CpmmAdapterBinding;
  private readonly limits: CpmmCollectorLimits;

  private readonly epochMap = new Map<number, EpochState>();
  private openEpochNumber: number | null = null;
  private newestEpoch: number | null = null;

  private readonly frameRecordList: CpmmFrameRecord[] = [];
  private readonly notificationList: CpmmCollectedNotification[] = [];

  private versionValue = 0;
  private frameCount = 0;
  private byteCount = 0;
  private unattributed = 0;
  private openEpochRefused = 0;
  private notificationsAccepted = 0;
  private frameRecordsDropped = 0;
  private notificationRecordsDropped = 0;
  private saturated = false;

  constructor(options: CpmmCollectorOptions) {
    const fail = (msg: string): never => {
      throw new Error(`[CPMM_COLLECTOR_INIT] ${msg}`);
    };
    const o = readDataRecord(options);
    if (!o) throw new Error("[CPMM_COLLECTOR_INIT] options must be a plain object of data");
    if (!exactKeys(o, ["binding", "limits", "commitment"])) {
      fail("options must have exactly binding, limits and commitment");
    }
    if (o.commitment !== "confirmed") fail("commitment must be confirmed");
    const b = readDataRecord(o.binding);
    if (!b || !exactKeys(b, ["poolAddress", "candidateMint"])) {
      fail("binding must be exactly { poolAddress, candidateMint }");
    }
    const pool = b!.poolAddress;
    const mint = b!.candidateMint;
    if (!isCanonicalSolanaBase58(pool) || !isCanonicalSolanaBase58(mint)) {
      fail("binding addresses must be canonical base58 public keys");
    }
    if (pool === mint) fail("pool and mint must differ");
    if (DEGENERATE_ADDRESSES.has(pool as string) || DEGENERATE_ADDRESSES.has(mint as string)) {
      fail("binding must not be a program-wide or well-known address");
    }
    const l = readDataRecord(o.limits);
    const limitKeys = [
      "maxFrameBytes",
      "maxEpochFrames",
      "maxEpochBytes",
      "maxRetainedFrameRecords",
      "maxRetainedNotifications",
      "maxEpochs",
    ] as const;
    if (!l || !exactKeys(l, limitKeys)) fail(`limits must be exactly ${limitKeys.join(", ")}`);
    for (const k of limitKeys) {
      if (!isSafePositive(l![k])) fail(`${k} must be a positive safe integer`);
    }
    this.binding = Object.freeze({ poolAddress: pool as string, candidateMint: mint as string });
    this.limits = Object.freeze(
      Object.fromEntries(limitKeys.map((k) => [k, l![k] as number])),
    ) as unknown as CpmmCollectorLimits;
  }

  public get version(): number {
    return this.versionValue;
  }

  /** The owner-supplied binding as a new frozen copy. Read-only: never changes `version`. */
  public getBinding(): CpmmAdapterBinding {
    return Object.freeze({
      poolAddress: this.binding.poolAddress,
      candidateMint: this.binding.candidateMint,
    });
  }

  private add(value: number, delta = 1): number {
    const r = cpmmCollectorSaturatingAdd(value, delta);
    if (r.saturated) this.saturated = true;
    return r.value;
  }

  private bumpVersion(): void {
    this.versionValue = this.add(this.versionValue);
  }

  private subscribeFrameText(requestId: number): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "logsSubscribe",
      params: [{ mentions: [this.binding.poolAddress] }, { commitment: "confirmed" }],
    });
  }

  // --- epochs ---------------------------------------------------------------------------------------

  /** Closes the open epoch (SUPERSEDED, unless already closed) on every call, opened or refused. */
  public openEpoch(open: CpmmCollectorEpochOpen): CpmmCollectorOpenResult {
    this.bumpVersion();
    let r: Record<string, unknown> | null = null;
    try {
      r = readDataRecord(open);
    } catch {
      r = null;
    }
    const valid =
      r !== null &&
      exactKeys(r, ["epoch", "observationStartMs", "subscribeRequestId"]) &&
      isSafeNonNegative(r.epoch) &&
      isSafePositive(r.observationStartMs) &&
      isSafePositive(r.subscribeRequestId);
    const previous =
      this.openEpochNumber === null ? undefined : this.epochMap.get(this.openEpochNumber);
    if (previous && !previous.closed) {
      previous.closed = true;
      previous.closeReason = "SUPERSEDED";
      // The new observation start is the close instant only when it is chronologically possible;
      // otherwise the instant is unknown (null), never fabricated earlier than known receipts.
      const start = valid ? (r!.observationStartMs as number) : null;
      previous.closedAtMs = start !== null && this.closeTimeValid(previous, start) ? start : null;
    }
    this.openEpochNumber = null;
    const refuse = (
      code: "EPOCH_INVALID" | "EPOCH_NOT_INCREASING" | "EPOCH_CAPACITY",
    ): CpmmCollectorOpenResult => {
      this.openEpochRefused = this.add(this.openEpochRefused);
      return Object.freeze({ status: "REFUSED", code });
    };
    if (!valid) return refuse("EPOCH_INVALID");
    const n = r!.epoch as number;
    if (this.newestEpoch !== null && n <= this.newestEpoch) return refuse("EPOCH_NOT_INCREASING");
    if (this.epochMap.size >= this.limits.maxEpochs) return refuse("EPOCH_CAPACITY");
    const requestId = r!.subscribeRequestId as number;
    const text = this.subscribeFrameText(requestId);
    this.epochMap.set(n, {
      epoch: n,
      observationStartMs: r!.observationStartMs as number,
      subscribeRequestId: requestId,
      subscribeFrameText: text,
      closed: false,
      closedAtMs: null,
      closeReason: null,
      subscription: "AWAITING_ACK",
      subscribeResponseSeen: false,
      subscriptionId: null,
      acknowledgedAtMs: null,
      unsubscribeStatus: "NOT_BUILT",
      unsubscribeRequestId: null,
      unsubscribeResponseSeen: false,
      frames: 0,
      bytes: 0,
      lastReceiptMs: null,
      byDisposition: Object.fromEntries(CPMM_FRAME_DISPOSITIONS.map((d) => [d, 0])) as Record<
        CpmmFrameDisposition,
        number
      >,
      notificationsAccepted: 0,
      notificationsWithTransactionError: 0,
      blockingFrames: 0,
      acquisitionLimitLatched: false,
      frameRecordsRetained: 0,
      frameRecordsDropped: 0,
      notificationRecordsRetained: 0,
      notificationRecordsDropped: 0,
    });
    this.openEpochNumber = n;
    this.newestEpoch = n;
    return Object.freeze({ status: "OPENED", epoch: n, subscribeFrame: encodeUtf8(text) });
  }

  /** A close instant is never before observation start or the latest valid frame receipt. */
  private closeTimeValid(ep: EpochState, atMs: number): boolean {
    return atMs >= ep.observationStartMs && (ep.lastReceiptMs === null || atMs >= ep.lastReceiptMs);
  }

  /**
   * Records the first close of an epoch. A closed epoch is never reopened, and its first reason
   * is never replaced: a repeated or later close (including OWNER_CLOSED) returns false. A close
   * time before observation start or the latest valid frame receipt (equality is allowed) is
   * refused. Every refusal returns false and changes neither state nor version.
   */
  public closeEpoch(epoch: number, reason: CpmmEpochCloseReason, atMs: number): boolean {
    if (
      !isSafeNonNegative(epoch) ||
      !CLOSE_REASONS.has(reason as string) ||
      !isSafePositive(atMs)
    ) {
      return false;
    }
    const ep = this.epochMap.get(epoch);
    if (!ep || ep.closed || !this.closeTimeValid(ep, atMs)) return false;
    this.bumpVersion();
    ep.closed = true;
    ep.closeReason = reason;
    ep.closedAtMs = atMs;
    if (this.openEpochNumber === epoch) this.openEpochNumber = null;
    return true;
  }

  /**
   * Builds the one logsUnsubscribe request of an open, acknowledged epoch (a fresh copy), or null.
   * At most one per epoch.
   */
  public unsubscribeFrame(epoch: number, requestId: number): Uint8Array | null {
    const ep = isSafeNonNegative(epoch) ? this.epochMap.get(epoch) : undefined;
    if (
      !ep ||
      ep.closed ||
      ep.subscription !== "ACKNOWLEDGED" ||
      ep.subscriptionId === null ||
      ep.unsubscribeStatus !== "NOT_BUILT" ||
      !isSafePositive(requestId) ||
      requestId === ep.subscribeRequestId
    ) {
      return null;
    }
    this.bumpVersion();
    // Built only: the collector cannot attest that the owner sent these bytes.
    ep.unsubscribeStatus = "BUILT_UNOBSERVED";
    ep.unsubscribeRequestId = requestId;
    return encodeUtf8(
      JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "logsUnsubscribe",
        params: [ep.subscriptionId],
      }),
    );
  }

  // --- frames ---------------------------------------------------------------------------------------

  /** Classifies one frame. Synchronous; never throws. */
  public acceptFrame(frame: CpmmCollectorFrame): CpmmFrameResult {
    try {
      return this.acceptFrameInner(frame);
    } catch {
      // Defensive: still one counted, unattributed, blocking frame.
      return this.finish(null, null, 0, null, record("FRAME_INVALID", "PROCESSING_EXCEPTION"));
    }
  }

  private acceptFrameInner(frame: CpmmCollectorFrame): CpmmFrameResult {
    // 1. Envelope and byte view, before reading any payload.
    let f: Record<string, unknown> | null = null;
    try {
      f = readDataRecord(frame);
    } catch {
      f = null;
    }
    const bv = f ? byteView(f.bytes) : null;
    if (
      !f ||
      !exactKeys(f, ["epoch", "bytes", "receivedAtMs"]) ||
      !bv ||
      !isSafeNonNegative(f.epoch)
    ) {
      return this.finish(
        null,
        null,
        bv?.length ?? 0,
        null,
        record("FRAME_INVALID", "FRAME_ENVELOPE"),
      );
    }
    const length = bv.length;
    // 2. Epoch.
    const ep = this.epochMap.get(f.epoch);
    if (!ep) return this.finish(null, null, length, null, record("EPOCH_NOT_OPEN"));
    if (ep.closed || this.openEpochNumber !== ep.epoch) {
      return this.finish(ep, null, length, null, record("STALE_EPOCH"));
    }
    // 3. Acquisition limits (latched), before copying, hashing or decoding.
    if (ep.acquisitionLimitLatched) {
      return this.finish(ep, null, length, null, record("EPOCH_LIMIT_EXCEEDED", "LATCHED"));
    }
    if (length > this.limits.maxFrameBytes) {
      ep.acquisitionLimitLatched = true;
      return this.finish(ep, null, length, null, record("OVERSIZE_FRAME"));
    }
    if (ep.frames + 1 > this.limits.maxEpochFrames) {
      ep.acquisitionLimitLatched = true;
      return this.finish(ep, null, length, null, record("EPOCH_LIMIT_EXCEEDED", "FRAMES"));
    }
    if (ep.bytes + length > this.limits.maxEpochBytes) {
      ep.acquisitionLimitLatched = true;
      return this.finish(ep, null, length, null, record("EPOCH_LIMIT_EXCEEDED", "BYTES"));
    }
    // 4. Receipt.
    const at = f.receivedAtMs;
    if (
      !isSafePositive(at) ||
      at < ep.observationStartMs ||
      (ep.lastReceiptMs !== null && at < ep.lastReceiptMs)
    ) {
      return this.finish(ep, null, length, null, record("RECEIPT_INVALID"));
    }
    ep.lastReceiptMs = at;
    // 5. One copy of exactly the validated range; hash and decode the copy only.
    const copy = copyRange(bv.view, length);
    const sha256 = createHash("sha256").update(copy).digest("hex");
    const classified = this.classify(ep, copy, at);
    return this.finish(ep, at, length, sha256, classified);
  }

  private classify(ep: EpochState, bytes: Uint8Array, at: number): Classified {
    const text = decodeStrictUtf8(bytes);
    if (text === null) return record("INVALID_UTF8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return record("NOT_JSON");
    }
    const m = readDataRecord(parsed);
    if (!m) return record("MALFORMED_MESSAGE", "NOT_AN_OBJECT");
    if (m.jsonrpc !== "2.0") return record("MALFORMED_MESSAGE", "JSONRPC_VERSION");
    if (hasOwn(m, "id")) return this.classifyResponse(ep, m, at);
    if (!hasOwn(m, "method")) return record("MALFORMED_MESSAGE", "NO_ID_OR_METHOD");
    if (m.method !== "logsNotification") return record("UNEXPECTED_METHOD");
    return this.classifyNotification(ep, m);
  }

  private classifyResponse(ep: EpochState, m: Record<string, unknown>, at: number): Classified {
    if (hasOwn(m, "method")) return record("MALFORMED_MESSAGE", "REQUEST_FROM_SERVER");
    const isResult = exactKeys(m, ["jsonrpc", "id", "result"]);
    const isError = exactKeys(m, ["jsonrpc", "id", "error"]) && isRpcError(m.error);
    if (m.id === ep.subscribeRequestId) {
      if (ep.subscribeResponseSeen) return record("DUPLICATE_RESPONSE", "SUBSCRIBE");
      ep.subscribeResponseSeen = true;
      if (isResult && isSafeNonNegative(m.result)) {
        ep.subscription = "ACKNOWLEDGED";
        ep.subscriptionId = m.result;
        ep.acknowledgedAtMs = at;
        return record("SUBSCRIBE_ACKNOWLEDGED");
      }
      if (isError) {
        ep.subscription = "REJECTED";
        return record("SUBSCRIBE_REJECTED");
      }
      ep.subscription = "MALFORMED_RESPONSE";
      return record("MALFORMED_MESSAGE", "SUBSCRIBE_RESPONSE_SHAPE");
    }
    if (ep.unsubscribeRequestId !== null && m.id === ep.unsubscribeRequestId) {
      if (ep.unsubscribeResponseSeen) return record("DUPLICATE_RESPONSE", "UNSUBSCRIBE");
      ep.unsubscribeResponseSeen = true;
      if (isResult && m.result === true) {
        ep.unsubscribeStatus = "ACKNOWLEDGED";
        return record("UNSUBSCRIBE_ACKNOWLEDGED");
      }
      if ((isResult && m.result === false) || isError) {
        ep.unsubscribeStatus = "REJECTED";
        return record("UNSUBSCRIBE_REJECTED");
      }
      return record("MALFORMED_MESSAGE", "UNSUBSCRIBE_RESPONSE_SHAPE");
    }
    return record("MISMATCHED_RESPONSE_ID");
  }

  private classifyNotification(ep: EpochState, m: Record<string, unknown>): Classified {
    if (ep.subscription !== "ACKNOWLEDGED" || ep.subscriptionId === null) {
      return record("PRE_ACK_NOTIFICATION");
    }
    const bad = (code: string) => record("MALFORMED_NOTIFICATION", code);
    if (!exactKeys(m, ["jsonrpc", "method", "params"])) return bad("ENVELOPE_KEYS");
    const params = readDataRecord(m.params);
    if (!params || !exactKeys(params, ["subscription", "result"])) return bad("PARAMS_KEYS");
    if (!isSafeNonNegative(params.subscription)) return bad("SUBSCRIPTION_INVALID");
    if (params.subscription !== ep.subscriptionId) return record("FOREIGN_SUBSCRIPTION");
    const result = readDataRecord(params.result);
    if (!result || !exactKeys(result, ["context", "value"])) return bad("RESULT_KEYS");
    const context = readDataRecord(result.context);
    if (!context || !hasOwn(context, "slot")) return bad("CONTEXT_KEYS");
    for (const k of Object.keys(context)) {
      if (k !== "slot" && k !== "apiVersion") return bad("CONTEXT_KEYS");
    }
    if (hasOwn(context, "apiVersion") && typeof context.apiVersion !== "string") {
      return bad("API_VERSION_INVALID");
    }
    if (!isSafeNonNegative(context.slot)) return bad("SLOT_INVALID");
    const value = readDataRecord(result.value);
    if (!value || !exactKeys(value, ["signature", "err", "logs"])) return bad("VALUE_KEYS");
    if (!isValidSolanaSignature(value.signature)) return bad("SIGNATURE_INVALID");
    const logs = value.logs;
    if (logs !== null && !(Array.isArray(logs) && logs.every((l) => typeof l === "string"))) {
      return bad("LOGS_INVALID");
    }
    return {
      kind: "NOTIFICATION",
      signature: value.signature as string,
      slot: context.slot,
      subscriptionId: ep.subscriptionId,
      err: value.err === null ? "NULL" : "PRESENT",
    };
  }

  /** Counts, records and returns one frame's single disposition. */
  private finish(
    ep: EpochState | null,
    at: number | null,
    length: number,
    sha256: string | null,
    c: Classified,
  ): CpmmFrameResult {
    this.bumpVersion();
    this.frameCount = this.add(this.frameCount);
    this.byteCount = this.add(this.byteCount, length);
    const disposition: CpmmFrameDisposition =
      c.kind === "NOTIFICATION" ? "NOTIFICATION_ACCEPTED" : c.disposition;
    // A transaction-error claim is forwarded but keeps the epoch dirty until validated.
    const blocking =
      c.kind === "NOTIFICATION" ? c.err === "PRESENT" : !NON_BLOCKING.has(disposition);
    if (ep) {
      ep.frames = this.add(ep.frames);
      ep.bytes = this.add(ep.bytes, length);
      ep.byDisposition[disposition] = this.add(ep.byDisposition[disposition]);
      if (blocking) ep.blockingFrames = this.add(ep.blockingFrames);
    } else {
      this.unattributed = this.add(this.unattributed);
    }
    const frameSequence = this.frameCount;
    const code = c.kind === "RECORD" ? c.code : null;
    const frameRecord: CpmmFrameRecord = {
      sequence: frameSequence,
      epoch: ep ? ep.epoch : null,
      receivedAtMs: at,
      byteLength: length,
      sha256,
      disposition,
      blocking,
      code,
    };
    if (this.frameRecordList.length < this.limits.maxRetainedFrameRecords) {
      this.frameRecordList.push(deepFreeze(frameRecord));
      if (ep) ep.frameRecordsRetained = this.add(ep.frameRecordsRetained);
    } else {
      this.frameRecordsDropped = this.add(this.frameRecordsDropped);
      if (ep) ep.frameRecordsDropped = this.add(ep.frameRecordsDropped);
    }
    if (c.kind === "RECORD" || !ep || at === null || sha256 === null) {
      return deepFreeze({
        status: "RECORDED",
        frameSequence,
        epoch: ep ? ep.epoch : null,
        disposition: disposition as Exclude<CpmmFrameDisposition, "NOTIFICATION_ACCEPTED">,
        blocking,
        code,
      });
    }
    ep.notificationsAccepted = this.add(ep.notificationsAccepted);
    if (c.err === "PRESENT") {
      ep.notificationsWithTransactionError = this.add(ep.notificationsWithTransactionError);
    }
    this.notificationsAccepted = this.add(this.notificationsAccepted);
    const notification: CpmmCollectedNotification = {
      sequence: this.notificationsAccepted,
      frameSequence,
      epoch: ep.epoch,
      subscriptionId: c.subscriptionId,
      signature: c.signature,
      slot: c.slot,
      receivedAtMs: at,
      notifiedTransactionError: c.err,
      frameSha256: sha256,
    };
    const recordRetained = this.notificationList.length < this.limits.maxRetainedNotifications;
    if (recordRetained) {
      this.notificationList.push(deepFreeze({ ...notification }));
      ep.notificationRecordsRetained = this.add(ep.notificationRecordsRetained);
    } else {
      this.notificationRecordsDropped = this.add(this.notificationRecordsDropped);
      ep.notificationRecordsDropped = this.add(ep.notificationRecordsDropped);
    }
    return deepFreeze({
      status: "ACCEPTED_NOTIFICATION",
      frameSequence,
      epoch: ep.epoch,
      disposition: "NOTIFICATION_ACCEPTED",
      blocking,
      notification,
      // Signature, slot and the injected receipt only: never a block time.
      envelope: {
        notification: { signature: c.signature, slot: c.slot, receivedAtMs: at },
        epoch: ep.epoch,
        hostReceivedAtMs: at,
      },
      recordRetained,
    });
  }

  // --- reports --------------------------------------------------------------------------------------

  private retention(
    frameRetained: number,
    frameDropped: number,
    notificationRetained: number,
    notificationDropped: number,
  ): CpmmMetadataRetention {
    return {
      frameRecordsRetained: frameRetained,
      frameRecordsDropped: frameDropped,
      notificationRecordsRetained: notificationRetained,
      notificationRecordsDropped: notificationDropped,
      complete: frameDropped === 0 && notificationDropped === 0,
      rawPayloadRetained: false,
      replayableCaptureEstablished: false,
    };
  }

  public epochReport(epoch: number): CpmmCollectionEpochReport | null {
    const ep = isSafeNonNegative(epoch) ? this.epochMap.get(epoch) : undefined;
    if (!ep) return null;
    // AWAITING_ACK is the only false term that can later become true (by a valid first
    // acknowledgement). Every other false term is sticky, so uncertainty is never cleared.
    const collectionClean =
      ep.subscription === "ACKNOWLEDGED" &&
      ep.blockingFrames === 0 &&
      ep.notificationsWithTransactionError === 0 &&
      !ep.acquisitionLimitLatched &&
      (!ep.closed || ep.closeReason === "OWNER_CLOSED") &&
      this.unattributed === 0 &&
      !this.saturated;
    return deepFreeze({
      binding: { ...this.binding },
      epoch: ep.epoch,
      observationStartMs: ep.observationStartMs,
      state: ep.closed ? "CLOSED" : "OPEN",
      subscription: ep.subscription,
      subscribeRequestId: ep.subscribeRequestId,
      subscriptionId: ep.subscriptionId,
      acknowledgedAtMs: ep.acknowledgedAtMs,
      unsubscribe: { status: ep.unsubscribeStatus, requestId: ep.unsubscribeRequestId },
      closedAtMs: ep.closedAtMs,
      closeReason: ep.closeReason,
      frames: ep.frames,
      bytes: ep.bytes,
      byDisposition: { ...ep.byDisposition },
      notificationsAccepted: ep.notificationsAccepted,
      notificationsWithTransactionError: ep.notificationsWithTransactionError,
      blockingFrames: ep.blockingFrames,
      acquisitionLimitLatched: ep.acquisitionLimitLatched,
      collectionClean,
      metadataRetention: this.retention(
        ep.frameRecordsRetained,
        ep.frameRecordsDropped,
        ep.notificationRecordsRetained,
        ep.notificationRecordsDropped,
      ),
      notificationCompletenessEstablished: false,
      quietWindowEstablished: false,
      qualificationEligible: false,
    });
  }

  public notifications(): readonly CpmmCollectedNotification[] {
    return Object.freeze(this.notificationList.map((n) => Object.freeze({ ...n })));
  }

  public frameRecords(): readonly CpmmFrameRecord[] {
    return Object.freeze(this.frameRecordList.map((r) => Object.freeze({ ...r })));
  }

  public counters(): CpmmCollectorCounters {
    return deepFreeze({
      frames: this.frameCount,
      bytes: this.byteCount,
      unattributedFrames: this.unattributed,
      openEpochRefused: this.openEpochRefused,
      notificationsAccepted: this.notificationsAccepted,
      metadataRetention: this.retention(
        this.frameRecordList.length,
        this.frameRecordsDropped,
        this.notificationList.length,
        this.notificationRecordsDropped,
      ),
      saturated: this.saturated,
    });
  }
}
