/**
 * Raydium CPMM transaction source adapter (assessment §8.38.17 item 12; offline-tested only).
 *
 * One notification for one verified CPMM pool becomes at most one `getTransaction` request through
 * the shared `PaperRequestSession`, strict evidence and envelope checks, and the accepted pure
 * decoder. The result is a deep-frozen fact; ingestion into a `RollingTradeFlowTracker` is a
 * separate, optional step.
 *
 * - Requests: one POST per reserved signature (lane SOLANA_RPC, owner FLOW, purpose
 *   CPMM_GET_TRANSACTION, the signature as requested identity, a session-unique JSON-RPC id). The
 *   session alone paces, counts, bounds and stops; this module has no clock, timer, budget or
 *   network access of its own and never stops the session.
 * - Evidence: response bytes come only from the session's exchange observer, bound to the returned
 *   ledger entry and the exact request; the session's decoded response string is never used.
 * - Retention: only unchanged, credential-free, valid UTF-8 JSON bodies are stored; everything else
 *   is withheld with counts, a SHA-256 digest and a fixed reason. Facts keep fixed codes only.
 * - Reservations are permanent per instance: no eviction, release or retry.
 *
 * Not wired anywhere: no provider, bridge, admission or failed-transaction policy uses it.
 */

import { createHash } from "node:crypto";
import { isValidSolanaSignature } from "./ExactPoolHistoryEnumerator.js";
import {
  PaperRequestSession,
  type PaperRequestExchange,
  type PaperRequestExchangeEvidence,
  type PaperRequestLedgerEntry,
} from "./PaperRequestSession.js";
import type { RaydiumCpmmPoolStateSuccess } from "./RaydiumCpmmPoolStateAdapter.js";
import {
  MAX_BLOCK_TIME_SEC,
  decodeRaydiumCpmmTransactionSwaps,
  type DecodeRaydiumCpmmTransactionResult,
} from "./RaydiumCpmmSwapDecoder.js";
import type { RollingTradeFlowTracker, TradeEvent } from "./RollingTradeFlowTracker.js";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const CPMM_TX_PURPOSE = "CPMM_GET_TRANSACTION" as const;
export const CPMM_TX_LANE = "SOLANA_RPC" as const;
export const CPMM_TX_OWNER = "FLOW" as const;
/** Credential material: a configured secret or any prefix of at least this many characters. */
export const CPMM_CREDENTIAL_PREFIX_CHARS = 8;
/** Shortest configured secret accepted (shorter secrets are refused at construction). */
export const CPMM_MIN_SECRET_CHARS = 6;
const MAX_SECRETS = 64;
const MAX_SECRET_CHARS = 4096;
/** Decoding rounds (backslash escapes, then percent-encoding) before a scan is inconclusive. */
const MAX_DECODE_ROUNDS = 4;

/** getTransaction parameters (fixed). */
export const CPMM_GET_TRANSACTION_CONFIG = Object.freeze({
  encoding: "json",
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
} as const);

/** Session refusal codes recognised for requests that were never dispatched. */
const SESSION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "REQUEST_SESSION_NOT_OPEN",
  "REQUEST_SESSION_STOPPED",
  "LIFETIME_EXPIRED",
  "CALLER_CANCELLED",
  "HTTP_ATTEMPT_CEILING_REACHED",
  "SOLANA_RPC_ATTEMPT_CEILING_REACHED",
  "BUDGET_MANAGER_DENIED",
  "CALLER_REFUSAL",
]);
/** Session exchange errors that are transport failures (kept, never relabelled as late). */
const SESSION_TRANSPORT_ERRORS: ReadonlySet<string> = new Set([
  "HTTP_429_RECEIVED",
  "HTTP_REDIRECT_REJECTED",
  "REQUEST_TIMED_OUT",
  "NETWORK_ERROR",
  "RESPONSE_TOO_LARGE",
]);
/** Session stop reasons recognised; any other stop text is recorded as a fixed fallback. */
const SESSION_STOP_CODES: ReadonlySet<string> = new Set([
  "SESSION_STOP_REQUESTED",
  "LIFETIME_EXPIRED",
  "HTTP_ATTEMPT_CEILING_REACHED",
  "BUDGET_MANAGER_DENIED",
  "HTTP_429_RECEIVED",
  "HTTP_REDIRECT_REJECTED",
]);
const UNRECOGNIZED_SESSION_CODE = "UNRECOGNIZED_SESSION_CODE";
const CALLER_REFUSAL = "CALLER_REFUSAL";

/** Decoder detail codes retained verbatim; locations match DECODER_LOCATION; others are replaced. */
const DECODER_DETAIL_CODES: ReadonlySet<string> = new Set([
  "ACCOUNT_KEYS",
  "INNER",
  "LOG_BYTES",
  "LOG_LINES",
  "TOP_LEVEL",
  "LOGS",
  "SIGNATURES",
  "DUPLICATE",
  "HEADER",
  "KEY",
  "LEGACY_LOADED",
  "LEGACY_LOOKUPS",
  "V0_LOADED",
  "V0_LOOKUPS",
  "GROUP",
  "ACCOUNT_KEY_NOT_STRING",
  "VERSION_MISSING",
  "PAYER_NOT_MESSAGE_SIGNER",
  "SWAP_FRAME_SHAPE_INVALID",
  "TRANSFER_BINDING_INVALID",
  "AMOUNT_PARAMETER_MISMATCH",
  "USER_ACCOUNT_INVALID",
  "LOG_TRACE_MISMATCH",
  "EVENT_MISMATCH",
  "FAILED_LOG_IN_SUCCESSFUL_TRANSACTION",
]);
const DECODER_LOCATION = /^instruction \d{1,6}(?: (?:inner|position) \d{1,6})?$/;
const FIXED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const TRACKER_REASONS: ReadonlySet<string> = new Set([
  "INVALID_EVENT_OBJECT",
  "MISSING_EVENT_ID",
  "INVALID_SIGNATURE",
  "INVALID_SWAP_INDEX",
  "INVALID_INSTRUCTION_INDEX",
  "IDENTITY_MISMATCH_POOL",
  "IDENTITY_MISMATCH_MINT",
  "INVALID_SIDE",
  "INVALID_TIMESTAMP",
  "INVALID_RECEIPT_TIMESTAMP",
  "FUTURE_DATED_RECEIPT_TIMESTAMP",
  "CONTRADICTORY_TIMESTAMPS",
  "INVALID_SLOT",
  "INVALID_PROVENANCE",
  "FUTURE_DATED_TIMESTAMP",
  "DUPLICATE_EVENT",
  "CAPACITY_EXCEEDED",
]);

// ---------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------

/** One notification. Data properties only; unknown keys are refused. */
export interface CpmmTransactionNotification {
  /** Canonical base58 signature of 64 bytes. */
  readonly signature: string;
  /** Safe integer >= 0. */
  readonly slot: number;
  /** Host receipt time: a positive safe integer of milliseconds (no clock fallback). */
  readonly receivedAtMs: number;
  /** Integer seconds, if the source reported one; then the response must agree. */
  readonly blockTime?: number | null | undefined;
}

export interface CpmmLifecycleGate {
  /** Caller cancellation. */
  readonly signal?: AbortSignal | undefined;
  /** Lifecycle refusal. Any non-null result refuses; the value itself is never retained. */
  readonly refusal?: (() => string | null) | undefined;
}

export type CpmmEvidenceTake =
  | { readonly status: "PRESENT"; readonly evidence: PaperRequestExchangeEvidence }
  | { readonly status: "NOT_RECORDED" | "ALREADY_TAKEN" | "DUPLICATED" };

/** Session-scoped exchange evidence: `observe` is the session's `onExchangeComplete`. */
export interface CpmmExchangeEvidenceRecorder {
  readonly observe: (evidence: PaperRequestExchangeEvidence) => void;
  /** Binds the recorder to exactly one session; a second call throws. */
  bind(session: PaperRequestSession): void;
  readonly boundSession: PaperRequestSession | null;
  /** Removes and returns the evidence for a ledger sequence number. */
  take(seq: number): CpmmEvidenceTake;
  /** Evidence dropped because the recorder was full or the evidence was unreadable. */
  readonly droppedCount: number;
}

export interface CpmmTransactionSourceOptions {
  readonly pool: RaydiumCpmmPoolStateSuccess;
  /** Opened by its owner; the adapter never opens or stops it. */
  readonly session: PaperRequestSession;
  /** Bound to `session`, else construction fails. */
  readonly evidence: CpmmExchangeEvidenceRecorder;
  /** Dispatch URL only; never retained in a fact. Must be one of `secrets`. */
  readonly rpcUrl: string;
  /** The configured endpoints' credential values (printable ASCII, at least 6 characters). */
  readonly secrets: readonly string[];
  readonly maxTrackedSignatures: number;
  /** Must not exceed the session's SOLANA_RPC lane limit. */
  readonly maxResponseBytes: number;
}

export type CpmmWithheldReason =
  | "PARTIAL_BODY"
  | "INVALID_UTF8"
  | "UNPARSABLE_JSON"
  | "CREDENTIAL_MATERIAL"
  | "CREDENTIAL_SCAN_INCONCLUSIVE";

/**
 * The retained body. STORED: the exact original text (unchanged bytes). WITHHELD: no payload.
 * NONE: the session read no body. UNVERIFIED: the evidence was missing or did not match.
 */
export interface CpmmRetainedBody {
  readonly state: "STORED" | "WITHHELD" | "NONE" | "UNVERIFIED";
  readonly payload: string | null;
  /** Decoded bytes the session observed (exceeds `retainedBytes` on overflow). */
  readonly observedBytes: number | null;
  /** Bytes the session retained. */
  readonly retainedBytes: number | null;
  /** SHA-256 of the retained bytes (for STORED, also of `payload`). */
  readonly sha256: string | null;
  readonly withheldReason: CpmmWithheldReason | null;
}

export type CpmmEvidenceStatus = "VERIFIED" | "MISSING" | "MISMATCH";

/** The dispatched request: the genuine ledger outcome plus the evidence verification status. */
export interface CpmmRetainedExchange {
  readonly seq: number | null;
  readonly lane: typeof CPMM_TX_LANE;
  readonly owner: typeof CPMM_TX_OWNER;
  readonly purpose: typeof CPMM_TX_PURPOSE;
  readonly requestedIdentity: string;
  readonly jsonRpcId: number;
  readonly method: "POST";
  /** Canonical request JSON; contains no credential. */
  readonly requestBody: string;
  readonly dispatchedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly httpStatus: number | null;
  readonly bodyComplete: boolean;
  /** Fixed session error code, if any. */
  readonly sessionError: string | null;
  readonly evidence: CpmmEvidenceStatus;
  /** Fixed reason when the evidence is not VERIFIED. */
  readonly evidenceDetail: string | null;
  readonly bodyState: "COMPLETE" | "PARTIAL_OVERFLOW" | "NOT_READ" | "UNVERIFIED";
  readonly maxResponseBytes: number;
  readonly body: CpmmRetainedBody;
}

export type CpmmResolutionKind =
  | "RESOLVED_SWAPS"
  | "RESOLVED_NO_TARGET_SWAP"
  | "RECORDED_FAILED_TRANSACTION"
  | "UNRESOLVED"
  | "EVIDENCE_NOT_REPLAYABLE"
  | "INVALID_NOTIFICATION"
  | "INVALID_GATE"
  | "DUPLICATE_NOTIFICATION"
  | "TRACKING_CAPACITY_REACHED"
  | "REQUEST_REFUSED"
  | "CANCELLED_IN_FLIGHT"
  | "SESSION_STOPPED_IN_FLIGHT"
  | "TRANSPORT_FAILED"
  | "HTTP_ERROR"
  | "EVIDENCE_MISSING"
  | "EVIDENCE_MISMATCH"
  | "LATE_RESPONSE"
  | "MALFORMED_RESPONSE"
  | "RPC_ERROR"
  | "TRANSACTION_NOT_FOUND"
  | "SIGNATURE_MISMATCH"
  | "METADATA_CONTRADICTION";

export type CpmmLifecycleCause =
  | "SESSION_NOT_OPEN"
  | "SESSION_STOPPED"
  | "ABSOLUTE_DEADLINE"
  | "CALLER_CANCELLED"
  | "LIFECYCLE_REFUSED"
  | "LIFECYCLE_CHECK_FAILED";

/** A check of session-owned state (and the caller's gate) at one moment. */
export interface CpmmLifecycleCheck {
  readonly atMs: number | null;
  readonly sessionState: "NOT_OPEN" | "OPEN" | "STOPPED" | null;
  readonly sessionStopReason: string | null;
  readonly deadlineMs: number | null;
  readonly callerCancelled: boolean;
  readonly callerRefusal: typeof CALLER_REFUSAL | null;
  readonly passed: boolean;
  readonly cause: CpmmLifecycleCause | null;
}

export type CpmmReplay = "DECODER_REPLAYABLE" | "NOT_REPLAYABLE" | "NOT_DECODED";

export interface CpmmResolutionFact {
  readonly kind: CpmmResolutionKind;
  /** Fixed code only (session, adapter or decoder). */
  readonly code: string | null;
  /** Fixed detail code only. */
  readonly detail: string | null;
  readonly notification: CpmmTransactionNotification | null;
  readonly exchange: CpmmRetainedExchange | null;
  readonly postAwaitCheck: CpmmLifecycleCheck | null;
  /** JSON-RPC error code; the message is never retained. */
  readonly rpcErrorCode: number | null;
  readonly decoder: {
    readonly status: DecodeRaydiumCpmmTransactionResult["status"];
    readonly reason: string | null;
    readonly detail: string | null;
  } | null;
  /** Non-empty only for RESOLVED_SWAPS. */
  readonly events: readonly TradeEvent[];
  readonly replay: CpmmReplay;
  /** True only for RESOLVED_SWAPS decoded from a STORED body. */
  readonly ingestible: boolean;
}

export type CpmmIngestionStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "NONE_ACCEPTED"
  | "REFUSED_BEFORE_START"
  | "NOT_INGESTIBLE";

export interface CpmmIngestionResult {
  readonly status: CpmmIngestionStatus;
  readonly code:
    | "FOREIGN_FACT"
    | "FACT_NOT_INGESTIBLE"
    | "INVALID_GATE"
    | "TRACKER_IDENTITY_MISMATCH"
    | "LIFECYCLE_STOPPED"
    | null;
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  /** accepted + rejected + unattempted === total */
  readonly unattempted: number;
  readonly rejections: readonly { readonly eventId: string; readonly reason: string }[];
  /** The failed check that stopped ingestion, if any. */
  readonly stopCheck: CpmmLifecycleCheck | null;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isBytes = (v: unknown): v is Uint8Array => v instanceof Uint8Array;
const isSafeNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}

/**
 * Own data properties of a plain record, or null if any is an accessor or a symbol key. The copy
 * has a null prototype and is filled with defineProperty, so an own `__proto__` key stays an
 * ordinary visible key (never a prototype setter) and nothing can be inherited.
 */
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

function stopCode(reason: string | null): string | null {
  if (reason === null) return null;
  return SESSION_STOP_CODES.has(reason) ? reason : UNRECOGNIZED_SESSION_CODE;
}

function decoderDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  if (DECODER_DETAIL_CODES.has(detail) || DECODER_LOCATION.test(detail)) return detail;
  return "UNRECOGNIZED_DECODER_DETAIL";
}

// --- Credential-material scan (withhold on detection or uncertainty; never redact) -------------

const unescapeBackslash = (s: string) =>
  s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, "/");
const percentDecode = (s: string) =>
  s.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** "FOUND", "INCONCLUSIVE" (escapes nested beyond the bound) or "CLEAN". */
function scanString(s: string, needles: readonly string[]): "FOUND" | "INCONCLUSIVE" | "CLEAN" {
  let cur = s;
  for (let round = 0; ; round++) {
    const lower = cur.toLowerCase();
    if (needles.some((n) => lower.includes(n))) return "FOUND";
    const next = percentDecode(unescapeBackslash(cur));
    if (next === cur) return "CLEAN";
    if (round + 1 >= MAX_DECODE_ROUNDS) return "INCONCLUSIVE";
    cur = next;
  }
}

/**
 * Scans the raw bytes and every parsed key and string value. Traversal is iterative with an
 * explicit work list (no recursion and no argument spreading), so array and object size are
 * bounded only by the response limit. Any failure while scanning is INCONCLUSIVE (withheld).
 */
function scanCredentialMaterial(
  raw: Buffer,
  parsed: unknown,
  needles: readonly string[],
): "FOUND" | "INCONCLUSIVE" | "CLEAN" {
  try {
    return scanAll(raw, parsed, needles);
  } catch {
    return "INCONCLUSIVE";
  }
}

function scanAll(
  raw: Buffer,
  parsed: unknown,
  needles: readonly string[],
): "FOUND" | "INCONCLUSIVE" | "CLEAN" {
  let worst: "FOUND" | "INCONCLUSIVE" | "CLEAN" = scanString(raw.toString("latin1"), needles);
  if (worst === "FOUND") return worst;
  const check = (s: string): boolean => {
    const r = scanString(s, needles);
    if (r === "INCONCLUSIVE") worst = r;
    return r === "FOUND";
  };
  const work: unknown[] = [parsed];
  while (work.length > 0) {
    const v = work.pop();
    if (typeof v === "string") {
      if (check(v)) return "FOUND";
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) work.push(v[i]);
    } else if (v !== null && typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (check(k)) return "FOUND";
        work.push((v as Record<string, unknown>)[k]);
      }
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------
// Evidence recorder
// ---------------------------------------------------------------------------------------------

export function createCpmmExchangeEvidenceRecorder(limits: {
  readonly maxPendingEvidence: number;
}): CpmmExchangeEvidenceRecorder {
  const l = readDataRecord(limits);
  if (!l || Object.keys(l).some((k) => k !== "maxPendingEvidence")) {
    throw new Error("[CPMM_EVIDENCE_RECORDER_INIT] limits must be { maxPendingEvidence }");
  }
  const max = l.maxPendingEvidence;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) {
    throw new Error("[CPMM_EVIDENCE_RECORDER_INIT] maxPendingEvidence must be a positive integer");
  }
  const pending = new Map<number, PaperRequestExchangeEvidence>();
  const taken = new Set<number>();
  const duplicated = new Set<number>();
  let dropped = 0;
  let bound: PaperRequestSession | null = null;

  const observe = (e: PaperRequestExchangeEvidence): void => {
    try {
      if (!e || typeof e !== "object" || !e.entry || typeof e.entry !== "object") return;
      if (e.entry.purpose !== CPMM_TX_PURPOSE) return;
      const seq = e.entry.seq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
        dropped++;
        return;
      }
      if (pending.has(seq) || taken.has(seq) || duplicated.has(seq)) {
        pending.delete(seq);
        duplicated.add(seq);
        return;
      }
      if (pending.size >= max) {
        dropped++;
        return;
      }
      // The recorder keeps its own copy of the bytes; the session's Buffer is never retained.
      pending.set(
        seq,
        Object.freeze({
          ...e,
          entry: Object.freeze({ ...e.entry }),
          body: isBytes(e.body) ? Buffer.from(e.body) : e.body,
        }),
      );
    } catch {
      dropped++;
    }
  };

  return {
    observe,
    bind(session: PaperRequestSession): void {
      if (bound !== null) throw new Error("[CPMM_EVIDENCE_RECORDER] already bound to a session");
      if (!(session instanceof PaperRequestSession)) {
        throw new Error("[CPMM_EVIDENCE_RECORDER] bind requires a PaperRequestSession");
      }
      bound = session;
    },
    get boundSession() {
      return bound;
    },
    take(seq: number): CpmmEvidenceTake {
      if (duplicated.has(seq)) return { status: "DUPLICATED" };
      if (taken.has(seq)) return { status: "ALREADY_TAKEN" };
      const e = pending.get(seq);
      if (!e) return { status: "NOT_RECORDED" };
      pending.delete(seq);
      taken.add(seq);
      return { status: "PRESENT", evidence: e };
    },
    get droppedCount() {
      return dropped;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------------

interface ValidNotification {
  readonly signature: string;
  readonly slot: number;
  readonly receivedAtMs: number;
  readonly blockTime?: number | null;
}

type BodyOutcome =
  | { readonly body: CpmmRetainedBody; readonly parsed?: undefined }
  | { readonly body: CpmmRetainedBody; readonly parsed: unknown };

const NOTIFICATION_KEYS: ReadonlySet<string> = new Set([
  "signature",
  "slot",
  "receivedAtMs",
  "blockTime",
]);
const OPTION_KEYS: ReadonlySet<string> = new Set([
  "pool",
  "session",
  "evidence",
  "rpcUrl",
  "secrets",
  "maxTrackedSignatures",
  "maxResponseBytes",
]);
const ENTRY_FIELDS = [
  ["seq", "ENTRY_SEQ"],
  ["lane", "ENTRY_LANE"],
  ["owner", "ENTRY_OWNER"],
  ["purpose", "ENTRY_PURPOSE"],
  ["requestedIdentity", "ENTRY_REQUESTED_IDENTITY"],
  ["jsonRpcId", "ENTRY_JSON_RPC_ID"],
  ["dispatchedAtMs", "ENTRY_DISPATCHED_AT"],
  ["completedAtMs", "ENTRY_COMPLETED_AT"],
  ["httpStatus", "ENTRY_HTTP_STATUS"],
  ["bodyComplete", "ENTRY_BODY_COMPLETE"],
  ["error", "ENTRY_ERROR"],
] as const satisfies readonly (readonly [keyof PaperRequestLedgerEntry, string])[];

const UNVERIFIED_BODY: CpmmRetainedBody = Object.freeze({
  state: "UNVERIFIED",
  payload: null,
  observedBytes: null,
  retainedBytes: null,
  sha256: null,
  withheldReason: null,
});

export class RaydiumCpmmTransactionSourceAdapter {
  private readonly pool: RaydiumCpmmPoolStateSuccess;
  private readonly session: PaperRequestSession;
  private readonly recorder: CpmmExchangeEvidenceRecorder;
  private readonly rpcUrl: string;
  private readonly needles: readonly string[];
  private readonly maxTrackedSignatures: number;
  private readonly maxResponseBytes: number;
  private readonly reserved = new Set<string>();
  private readonly produced = new WeakSet<object>();

  constructor(options: CpmmTransactionSourceOptions) {
    const fail = (msg: string): never => {
      throw new Error(`[CPMM_TX_SOURCE_INIT] ${msg}`);
    };
    const o = readDataRecord(options);
    if (!o) throw new Error("[CPMM_TX_SOURCE_INIT] options must be a plain object of data");
    for (const k of Object.keys(o)) if (!OPTION_KEYS.has(k)) fail(`unsupported option ${k}`);
    if (!(o.session instanceof PaperRequestSession)) fail("session must be a PaperRequestSession");
    const session = o.session as PaperRequestSession;
    const rec = o.evidence as CpmmExchangeEvidenceRecorder | undefined;
    if (
      !rec ||
      typeof rec !== "object" ||
      typeof rec.take !== "function" ||
      typeof rec.observe !== "function"
    ) {
      fail("evidence must be a CPMM exchange evidence recorder");
    }
    if (rec!.boundSession !== session) fail("evidence recorder is not bound to this session");
    // The decoder validates options, then the pool, then the payload: a null payload therefore
    // reports INVALID_POOL_CONTEXT exactly when the pool context is unusable.
    const probe = decodeRaydiumCpmmTransactionSwaps(null, o.pool as RaydiumCpmmPoolStateSuccess, {
      receiptTimestampMs: 1,
    });
    if (probe.status !== "UNRESOLVED_EVIDENCE" || probe.reason !== "INVALID_PAYLOAD") {
      fail("pool must be a verified CPMM pool context");
    }
    const secrets = o.secrets;
    if (!Array.isArray(secrets) || secrets.length < 1 || secrets.length > MAX_SECRETS) {
      fail(`secrets must be an array of 1..${MAX_SECRETS} strings`);
    }
    for (const s of secrets as unknown[]) {
      if (
        typeof s !== "string" ||
        s.length < CPMM_MIN_SECRET_CHARS ||
        s.length > MAX_SECRET_CHARS ||
        !/^[\x21-\x7e]+$/.test(s)
      ) {
        fail(`each secret must be printable ASCII of ${CPMM_MIN_SECRET_CHARS}+ characters`);
      }
    }
    const rpcUrl = o.rpcUrl;
    if (typeof rpcUrl !== "string" || !(secrets as string[]).includes(rpcUrl)) {
      fail("rpcUrl must be a string listed in secrets");
    }
    let protocol = "";
    try {
      protocol = new URL(rpcUrl as string).protocol;
    } catch {
      fail("rpcUrl must be an absolute URL");
    }
    if (protocol !== "https:" && protocol !== "http:") fail("rpcUrl must be http(s)");
    const maxTracked = o.maxTrackedSignatures;
    if (typeof maxTracked !== "number" || !Number.isSafeInteger(maxTracked) || maxTracked < 1) {
      fail("maxTrackedSignatures must be a positive safe integer");
    }
    const maxBytes = o.maxResponseBytes;
    if (
      typeof maxBytes !== "number" ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > session.limits.lanes[CPMM_TX_LANE].maxResponseBytes
    ) {
      fail("maxResponseBytes must be a positive integer within the session's SOLANA_RPC limit");
    }
    this.pool = o.pool as RaydiumCpmmPoolStateSuccess;
    this.session = session;
    this.recorder = rec!;
    this.rpcUrl = rpcUrl as string;
    this.needles = Object.freeze([
      ...new Set(
        (secrets as string[]).map((s) => s.slice(0, CPMM_CREDENTIAL_PREFIX_CHARS).toLowerCase()),
      ),
    ]);
    this.maxTrackedSignatures = maxTracked as number;
    this.maxResponseBytes = maxBytes as number;
  }

  /** Signatures reserved so far (permanent for this instance). */
  public get reservedSignatureCount(): number {
    return this.reserved.size;
  }

  // --- resolve ---------------------------------------------------------------------------------

  public async resolve(
    notification: unknown,
    gate?: CpmmLifecycleGate,
  ): Promise<CpmmResolutionFact> {
    // 1. Notification and gate (nothing reserved yet).
    const n = validateNotification(notification);
    if (typeof n === "string") return this.fact({ kind: "INVALID_NOTIFICATION", code: n });
    const g = validateGate(gate);
    if (g === null)
      return this.fact({ kind: "INVALID_GATE", code: "INVALID_GATE", notification: n });
    // 2. Reservation: synchronous, before the first await, permanent.
    if (this.reserved.has(n.signature)) {
      return this.fact({
        kind: "DUPLICATE_NOTIFICATION",
        code: "DUPLICATE_SIGNATURE",
        notification: n,
      });
    }
    if (this.reserved.size >= this.maxTrackedSignatures) {
      return this.fact({
        kind: "TRACKING_CAPACITY_REACHED",
        code: "TRACKING_CAPACITY_REACHED",
        notification: n,
      });
    }
    this.reserved.add(n.signature);
    // 3. Pre-dispatch cancellation.
    if (g.signal?.aborted) {
      return this.fact({ kind: "REQUEST_REFUSED", code: "CALLER_CANCELLED", notification: n });
    }
    // 4. Dispatch: one POST through the session, which paces, counts, bounds and stops.
    const id = this.session.nextJsonRpcId();
    const requestBody = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "getTransaction",
      params: [n.signature, CPMM_GET_TRANSACTION_CONFIG],
    });
    const signals: readonly AbortSignal[] = g.signal ? [g.signal] : [];
    let exchange: PaperRequestExchange;
    try {
      exchange = await this.session.dispatch({
        lane: CPMM_TX_LANE,
        owner: CPMM_TX_OWNER,
        purpose: CPMM_TX_PURPOSE,
        requestedIdentity: n.signature,
        url: this.rpcUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        jsonRpcId: id,
        refusal: () => callerRefusal(g),
        waitSignals: signals,
        linkSignals: () => signals,
        maxResponseBytes: this.maxResponseBytes,
      });
    } catch {
      return this.fact({ kind: "TRANSPORT_FAILED", code: "DISPATCH_EXCEPTION", notification: n });
    }
    // 5. Not dispatched: the session's (or the caller's fixed) refusal code.
    if (!exchange || exchange.dispatched !== true) {
      const code =
        typeof exchange?.error === "string" && SESSION_REFUSAL_CODES.has(exchange.error)
          ? exchange.error
          : UNRECOGNIZED_SESSION_CODE;
      return this.fact({ kind: "REQUEST_REFUSED", code, notification: n });
    }
    // Evidence for every dispatched exchange, taken immediately and copied before use.
    const retained = this.retainExchange(exchange, n.signature, id, requestBody);
    const ex = retained.exchange;
    const base = { notification: n, exchange: ex };
    const unverified = ex.evidence === "VERIFIED" ? null : `EVIDENCE_${ex.evidence}`;
    // 6. Session errors keep their own code (never relabelled as late).
    if (typeof exchange.error === "string") {
      if (exchange.error === "REQUEST_ABORTED") {
        if (g.signal?.aborted) {
          return this.fact({
            ...base,
            kind: "CANCELLED_IN_FLIGHT",
            code: "CALLER_CANCELLED",
            detail: unverified,
          });
        }
        return this.fact({
          ...base,
          kind: "SESSION_STOPPED_IN_FLIGHT",
          code: stopCode(this.session.getStopReason()) ?? "REQUEST_ABORTED",
          detail: unverified,
        });
      }
      return this.fact({
        ...base,
        kind: "TRANSPORT_FAILED",
        code: SESSION_TRANSPORT_ERRORS.has(exchange.error)
          ? exchange.error
          : UNRECOGNIZED_SESSION_CODE,
        detail: unverified,
      });
    }
    // 7. HTTP status.
    if (exchange.status !== 200) {
      const s = exchange.status;
      const code =
        typeof s === "number" && Number.isInteger(s) && s >= 100 && s <= 599
          ? `HTTP_STATUS_${s}`
          : "HTTP_STATUS_INVALID";
      return this.fact({ ...base, kind: "HTTP_ERROR", code, detail: unverified });
    }
    // 8. Evidence.
    if (ex.evidence !== "VERIFIED") {
      return this.fact({
        ...base,
        kind: ex.evidence === "MISSING" ? "EVIDENCE_MISSING" : "EVIDENCE_MISMATCH",
        code: ex.evidenceDetail,
      });
    }
    // 9. Authoritative post-await check of session-owned state and the caller's gate.
    const check = this.lifecycleCheck(g);
    if (!check.passed) {
      return this.fact({
        ...base,
        kind: "LATE_RESPONSE",
        code: check.cause,
        postAwaitCheck: check,
      });
    }
    const withCheck = { ...base, postAwaitCheck: check };
    // 10. Body, envelope, binding and cross-checks, then the decoder.
    const body = ex.body;
    if (body.state !== "STORED" || retained.parsed === undefined) {
      if (
        body.withheldReason === "CREDENTIAL_MATERIAL" ||
        body.withheldReason === "CREDENTIAL_SCAN_INCONCLUSIVE"
      ) {
        return this.fact({
          ...withCheck,
          kind: "EVIDENCE_NOT_REPLAYABLE",
          code: body.withheldReason,
          replay: "NOT_REPLAYABLE",
        });
      }
      return this.fact({
        ...withCheck,
        kind: "MALFORMED_RESPONSE",
        code: body.withheldReason ?? "BODY_NOT_STORED",
      });
    }
    return this.classifyResponse(retained.parsed, n, id, withCheck);
  }

  private classifyResponse(
    parsed: unknown,
    n: ValidNotification,
    id: number,
    base: {
      notification: ValidNotification;
      exchange: CpmmRetainedExchange;
      postAwaitCheck: CpmmLifecycleCheck;
    },
  ): CpmmResolutionFact {
    const malformed = (code: string) => this.fact({ ...base, kind: "MALFORMED_RESPONSE", code });
    if (!isPlainRecord(parsed)) return malformed("ENVELOPE_NOT_OBJECT");
    for (const k of Object.keys(parsed)) {
      if (k !== "jsonrpc" && k !== "id" && k !== "result" && k !== "error") {
        return malformed("ENVELOPE_EXTRA_KEY");
      }
    }
    if (parsed.jsonrpc !== "2.0") return malformed("JSONRPC_VERSION");
    if (!hasOwn(parsed, "id")) return malformed("ID_MISSING");
    if (parsed.id !== id) return malformed("ID_MISMATCH");
    const hasResult = hasOwn(parsed, "result");
    const hasError = hasOwn(parsed, "error");
    if (hasResult && hasError) return malformed("RESULT_AND_ERROR");
    if (!hasResult && !hasError) return malformed("NO_RESULT_OR_ERROR");
    if (hasError) {
      const e = parsed.error;
      if (
        !isPlainRecord(e) ||
        Object.keys(e).some((k) => k !== "code" && k !== "message" && k !== "data") ||
        typeof e.code !== "number" ||
        !Number.isSafeInteger(e.code) ||
        typeof e.message !== "string"
      ) {
        return malformed("ERROR_OBJECT_INVALID");
      }
      return this.fact({
        ...base,
        kind: "RPC_ERROR",
        code: "JSON_RPC_ERROR",
        rpcErrorCode: e.code,
      });
    }
    const result = parsed.result;
    if (result === null) {
      return this.fact({ ...base, kind: "TRANSACTION_NOT_FOUND", code: "RESULT_NULL" });
    }
    if (!isPlainRecord(result)) return malformed("RESULT_NOT_OBJECT");
    const tx = result.transaction;
    const sig0 =
      isPlainRecord(tx) && Array.isArray(tx.signatures) ? (tx.signatures[0] as unknown) : undefined;
    if (typeof sig0 !== "string") {
      return this.fact({ ...base, kind: "SIGNATURE_MISMATCH", code: "SIGNATURE_MISSING" });
    }
    if (sig0 !== n.signature) {
      return this.fact({ ...base, kind: "SIGNATURE_MISMATCH", code: "SIGNATURE_DIFFERENT" });
    }
    const contradiction = (code: string) =>
      this.fact({ ...base, kind: "METADATA_CONTRADICTION", code });
    if (!isSafeNonNegative(result.slot)) return contradiction("SLOT_INVALID");
    if (result.slot !== n.slot) return contradiction("SLOT_MISMATCH");
    if (typeof n.blockTime === "number") {
      const bt = result.blockTime;
      if (typeof bt !== "number" || !Number.isSafeInteger(bt)) {
        return contradiction("BLOCK_TIME_UNAVAILABLE");
      }
      if (bt !== n.blockTime) return contradiction("BLOCK_TIME_MISMATCH");
    }
    const d = decodeRaydiumCpmmTransactionSwaps(result, this.pool, {
      receiptTimestampMs: n.receivedAtMs,
    });
    const decoder =
      d.status === "UNRESOLVED_EVIDENCE"
        ? { status: d.status, reason: d.reason, detail: decoderDetail(d.detail) }
        : { status: d.status, reason: null, detail: null };
    const decoded = { ...base, decoder, replay: "DECODER_REPLAYABLE" as const };
    switch (d.status) {
      case "SWAP_DECODED":
        return this.fact({ ...decoded, kind: "RESOLVED_SWAPS", events: d.events });
      case "NO_MATCHING_SWAPS":
        return this.fact({ ...decoded, kind: "RESOLVED_NO_TARGET_SWAP" });
      case "TRANSACTION_FAILED":
        return this.fact({ ...decoded, kind: "RECORDED_FAILED_TRANSACTION" });
      default:
        return this.fact({
          ...decoded,
          kind: "UNRESOLVED",
          code: FIXED_CODE.test(d.reason) ? d.reason : "UNRECOGNIZED_DECODER_REASON",
          detail: decoder.detail,
        });
    }
  }

  // --- evidence binding and retention ---------------------------------------------------------

  private retainExchange(
    exchange: PaperRequestExchange,
    signature: string,
    id: number,
    requestBody: string,
  ): { exchange: CpmmRetainedExchange; parsed?: unknown } {
    const entry = exchange.entry;
    const num = (v: unknown) => (isSafeNonNegative(v) ? v : null);
    const sessionError =
      typeof exchange.error === "string"
        ? SESSION_TRANSPORT_ERRORS.has(exchange.error) || exchange.error === "REQUEST_ABORTED"
          ? exchange.error
          : UNRECOGNIZED_SESSION_CODE
        : null;
    const shell = {
      seq: num(entry?.seq),
      lane: CPMM_TX_LANE,
      owner: CPMM_TX_OWNER,
      purpose: CPMM_TX_PURPOSE,
      requestedIdentity: signature,
      jsonRpcId: id,
      method: "POST" as const,
      requestBody,
      dispatchedAtMs: num(entry?.dispatchedAtMs),
      completedAtMs: num(entry?.completedAtMs),
      httpStatus: num(entry?.httpStatus),
      bodyComplete: entry?.bodyComplete === true,
      sessionError,
      maxResponseBytes: this.maxResponseBytes,
    };
    const unverified = (evidence: "MISSING" | "MISMATCH", detail: string) => ({
      exchange: {
        ...shell,
        evidence,
        evidenceDetail: detail,
        bodyState: "UNVERIFIED" as const,
        body: UNVERIFIED_BODY,
      },
    });
    if (!entry || typeof entry !== "object" || !isSafeNonNegative(entry.seq)) {
      return unverified("MISMATCH", "LEDGER_ENTRY_INVALID");
    }
    const t = this.recorder.take(entry.seq);
    if (t.status !== "PRESENT") {
      return t.status === "DUPLICATED"
        ? unverified("MISMATCH", "DUPLICATE_EVIDENCE")
        : unverified("MISSING", t.status === "ALREADY_TAKEN" ? "ALREADY_TAKEN" : "NOT_RECORDED");
    }
    const ev = t.evidence;
    if (!ev || typeof ev !== "object" || !ev.entry || typeof ev.entry !== "object") {
      return unverified("MISMATCH", "EVIDENCE_SHAPE");
    }
    // Copy before use: nothing below reads the recorder's Buffer again.
    const copy = isBytes(ev.body) ? Buffer.from(ev.body) : null;
    const mismatch = this.bindingMismatch(ev, entry, exchange, copy, signature, id, requestBody);
    if (mismatch !== null) return unverified("MISMATCH", mismatch);
    const outcome = this.retainBody(ev.bodyState, copy, ev.observedBodyBytes);
    return {
      exchange: {
        ...shell,
        evidence: "VERIFIED",
        evidenceDetail: null,
        bodyState: ev.bodyState,
        body: outcome.body,
      },
      ...(outcome.parsed !== undefined ? { parsed: outcome.parsed } : {}),
    };
  }

  /** The first field that differs from the returned ledger entry or the exact request. */
  private bindingMismatch(
    ev: PaperRequestExchangeEvidence,
    entry: PaperRequestLedgerEntry,
    exchange: PaperRequestExchange,
    copy: Buffer | null,
    signature: string,
    id: number,
    requestBody: string,
  ): string | null {
    for (const [field, code] of ENTRY_FIELDS) {
      if (!Object.is(ev.entry[field], entry[field])) return code;
    }
    if (entry.lane !== CPMM_TX_LANE) return "LANE";
    if (entry.owner !== CPMM_TX_OWNER) return "OWNER";
    if (entry.purpose !== CPMM_TX_PURPOSE) return "PURPOSE";
    if (entry.requestedIdentity !== signature) return "REQUESTED_IDENTITY";
    if (entry.jsonRpcId !== id) return "JSON_RPC_ID";
    if (ev.method !== "POST") return "METHOD";
    if (ev.requestBody !== requestBody) return "REQUEST_BODY";
    if (ev.maxResponseBytes !== this.maxResponseBytes) return "MAX_RESPONSE_BYTES";
    if (exchange.bodyComplete !== entry.bodyComplete) return "EXCHANGE_BODY_COMPLETE";
    if ((exchange.error ?? null) !== entry.error) return "EXCHANGE_ERROR";
    if ((exchange.status ?? null) !== entry.httpStatus) return "EXCHANGE_STATUS";
    const obs = ev.observedBodyBytes;
    const max = this.maxResponseBytes;
    switch (ev.bodyState) {
      case "COMPLETE":
        return copy !== null &&
          obs === copy.length &&
          copy.length <= max &&
          entry.bodyComplete === true &&
          entry.error === null
          ? null
          : "BODY_ACCOUNTING";
      case "PARTIAL_OVERFLOW":
        return copy !== null &&
          isSafeNonNegative(obs) &&
          obs > max &&
          copy.length <= max &&
          entry.bodyComplete === false &&
          entry.error === "RESPONSE_TOO_LARGE"
          ? null
          : "BODY_ACCOUNTING";
      case "NOT_READ":
        return ev.body === null && obs === null && entry.bodyComplete === false
          ? null
          : "BODY_ACCOUNTING";
      default:
        return "BODY_STATE";
    }
  }

  /** Stores only unchanged, credential-free, valid UTF-8 JSON; withholds everything else. */
  private retainBody(
    state: PaperRequestExchangeEvidence["bodyState"],
    copy: Buffer | null,
    observed: number | null,
  ): BodyOutcome {
    if (state === "NOT_READ" || copy === null) {
      return {
        body: Object.freeze({
          state: "NONE",
          payload: null,
          observedBytes: null,
          retainedBytes: null,
          sha256: null,
          withheldReason: null,
        }),
      };
    }
    const withheld = (reason: CpmmWithheldReason): BodyOutcome => ({
      body: Object.freeze({
        state: "WITHHELD",
        payload: null,
        observedBytes: observed,
        retainedBytes: copy.length,
        sha256: sha256Hex(copy),
        withheldReason: reason,
      }),
    });
    if (state !== "COMPLETE") return withheld("PARTIAL_BODY");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(copy);
    } catch {
      return withheld("INVALID_UTF8");
    }
    if (!Buffer.from(text, "utf8").equals(copy)) return withheld("INVALID_UTF8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return withheld("UNPARSABLE_JSON");
    }
    const scan = scanCredentialMaterial(copy, parsed, this.needles);
    if (scan === "FOUND") return withheld("CREDENTIAL_MATERIAL");
    if (scan === "INCONCLUSIVE") return withheld("CREDENTIAL_SCAN_INCONCLUSIVE");
    return {
      body: Object.freeze({
        state: "STORED",
        payload: text,
        observedBytes: observed,
        retainedBytes: copy.length,
        sha256: sha256Hex(copy),
        withheldReason: null,
      }),
      parsed,
    };
  }

  // --- lifecycle --------------------------------------------------------------------------------

  /**
   * Session-owned time, state and deadline (also when the clock passed it before its timer fired).
   * The caller's callback runs exactly once and FIRST; every authoritative value (time, session
   * state, stop reason, deadline and cancellation) is read afterwards, so whatever the callback
   * did (cancel, stop the session, move the clock) is observed by this same check.
   */
  private lifecycleCheck(g: ValidGate): CpmmLifecycleCheck {
    try {
      const refusal = callerRefusal(g);
      const atMs = this.session.now();
      const open = this.session.isOpen();
      const stopReason = this.session.getStopReason();
      const deadlineMs = this.session.getDeadlineMs();
      const callerCancelled = g.signal?.aborted === true;
      const sessionState = open ? "OPEN" : stopReason !== null ? "STOPPED" : "NOT_OPEN";
      const cause: CpmmLifecycleCause | null =
        sessionState === "STOPPED"
          ? "SESSION_STOPPED"
          : sessionState === "NOT_OPEN" || deadlineMs === null
            ? "SESSION_NOT_OPEN"
            : !(typeof atMs === "number" && atMs < deadlineMs)
              ? "ABSOLUTE_DEADLINE"
              : callerCancelled
                ? "CALLER_CANCELLED"
                : refusal !== null
                  ? "LIFECYCLE_REFUSED"
                  : null;
      return Object.freeze({
        atMs: typeof atMs === "number" && Number.isFinite(atMs) ? atMs : null,
        sessionState,
        sessionStopReason: stopCode(stopReason),
        deadlineMs,
        callerCancelled,
        callerRefusal: refusal,
        passed: cause === null,
        cause,
      });
    } catch {
      return Object.freeze({
        atMs: null,
        sessionState: null,
        sessionStopReason: null,
        deadlineMs: null,
        callerCancelled: false,
        callerRefusal: null,
        passed: false,
        cause: "LIFECYCLE_CHECK_FAILED",
      });
    }
  }

  // --- ingestion -------------------------------------------------------------------------------

  public ingest(
    fact: CpmmResolutionFact,
    tracker: RollingTradeFlowTracker,
    gate?: CpmmLifecycleGate,
  ): CpmmIngestionResult {
    const result = (
      status: CpmmIngestionStatus,
      code: CpmmIngestionResult["code"],
      total: number,
      accepted = 0,
      rejected = 0,
      rejections: { eventId: string; reason: string }[] = [],
      stopCheck: CpmmLifecycleCheck | null = null,
    ): CpmmIngestionResult =>
      deepFreeze({
        status,
        code,
        total,
        accepted,
        rejected,
        unattempted: total - accepted - rejected,
        rejections,
        stopCheck,
      });
    if (!fact || typeof fact !== "object" || !this.produced.has(fact)) {
      return result("NOT_INGESTIBLE", "FOREIGN_FACT", 0);
    }
    if (fact.ingestible !== true) return result("NOT_INGESTIBLE", "FACT_NOT_INGESTIBLE", 0);
    const events = fact.events;
    const total = events.length;
    const g = validateGate(gate);
    if (g === null) return result("REFUSED_BEFORE_START", "INVALID_GATE", total);
    let identityOk = false;
    try {
      identityOk =
        tracker.getPoolId() === this.pool.poolAddress &&
        tracker.getTokenMint() === this.pool.candidateMint;
    } catch {
      identityOk = false;
    }
    if (!identityOk) return result("REFUSED_BEFORE_START", "TRACKER_IDENTITY_MISMATCH", total);
    let accepted = 0;
    let rejected = 0;
    const rejections: { eventId: string; reason: string }[] = [];
    for (const event of events) {
      // The lifecycle is re-checked before every event, including the first.
      const check = this.lifecycleCheck(g);
      if (!check.passed) {
        const status =
          accepted + rejected === 0 ? "REFUSED_BEFORE_START" : summary(accepted, total);
        return result(status, "LIFECYCLE_STOPPED", total, accepted, rejected, rejections, check);
      }
      let reason: string | null;
      try {
        const r = tracker.ingestTrade(event);
        reason = r.ok
          ? null
          : TRACKER_REASONS.has(r.reason)
            ? r.reason
            : "UNRECOGNIZED_TRACKER_CODE";
      } catch {
        reason = "TRACKER_EXCEPTION";
      }
      if (reason === null) accepted++;
      else {
        rejected++;
        rejections.push({ eventId: event.eventId, reason });
      }
    }
    return result(summary(accepted, total), null, total, accepted, rejected, rejections);
  }

  // --- facts -------------------------------------------------------------------------------------

  private fact(f: {
    kind: CpmmResolutionKind;
    code?: string | null;
    detail?: string | null;
    notification?: ValidNotification | null;
    exchange?: CpmmRetainedExchange | null;
    postAwaitCheck?: CpmmLifecycleCheck | null;
    rpcErrorCode?: number | null;
    decoder?: CpmmResolutionFact["decoder"];
    events?: readonly TradeEvent[];
    replay?: CpmmReplay;
  }): CpmmResolutionFact {
    const events = f.kind === "RESOLVED_SWAPS" ? (f.events ?? []) : [];
    const replay = f.replay ?? "NOT_DECODED";
    const out: CpmmResolutionFact = deepFreeze({
      kind: f.kind,
      code: f.code ?? null,
      detail: f.detail ?? null,
      notification: f.notification ? { ...f.notification } : null,
      exchange: f.exchange ?? null,
      postAwaitCheck: f.postAwaitCheck ?? null,
      rpcErrorCode: f.rpcErrorCode ?? null,
      decoder: f.decoder ?? null,
      events: [...events],
      replay,
      ingestible:
        f.kind === "RESOLVED_SWAPS" && replay === "DECODER_REPLAYABLE" && events.length > 0,
    });
    this.produced.add(out);
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

interface ValidGate {
  readonly signal?: AbortSignal;
  readonly refusal?: () => unknown;
}

function summary(accepted: number, total: number): CpmmIngestionStatus {
  return accepted === total ? "COMPLETE" : accepted === 0 ? "NONE_ACCEPTED" : "PARTIAL";
}

/** Any non-null, non-undefined refusal (or a throwing callback) is the fixed CALLER_REFUSAL. */
function callerRefusal(g: ValidGate): typeof CALLER_REFUSAL | null {
  if (!g.refusal) return null;
  try {
    const r = g.refusal();
    return r === null || r === undefined ? null : CALLER_REFUSAL;
  } catch {
    return CALLER_REFUSAL;
  }
}

function validateGate(gate: unknown): ValidGate | null {
  if (gate === undefined) return {};
  const r = readDataRecord(gate);
  if (!r) return null;
  for (const k of Object.keys(r)) if (k !== "signal" && k !== "refusal") return null;
  if (r.signal !== undefined && !(r.signal instanceof AbortSignal)) return null;
  if (r.refusal !== undefined && typeof r.refusal !== "function") return null;
  return {
    ...(r.signal !== undefined ? { signal: r.signal as AbortSignal } : {}),
    ...(r.refusal !== undefined ? { refusal: r.refusal as () => unknown } : {}),
  };
}

/** A validated copy, or a fixed refusal code. */
function validateNotification(v: unknown): ValidNotification | string {
  let r: Record<string, unknown> | null;
  try {
    r = readDataRecord(v);
  } catch {
    return "NOTIFICATION_UNREADABLE";
  }
  if (!r) return "NOTIFICATION_NOT_PLAIN_DATA";
  for (const k of Object.keys(r)) if (!NOTIFICATION_KEYS.has(k)) return "UNKNOWN_KEY";
  if (!isValidSolanaSignature(r.signature)) return "SIGNATURE_INVALID";
  if (!isSafeNonNegative(r.slot)) return "SLOT_INVALID";
  if (!hasOwn(r, "receivedAtMs")) return "RECEIVED_AT_MISSING";
  if (!isSafeNonNegative(r.receivedAtMs) || r.receivedAtMs < 1) return "RECEIVED_AT_INVALID";
  const bt = r.blockTime;
  if (
    bt !== undefined &&
    bt !== null &&
    !(typeof bt === "number" && Number.isSafeInteger(bt) && bt > 0 && bt <= MAX_BLOCK_TIME_SEC)
  ) {
    return "BLOCK_TIME_INVALID";
  }
  return {
    signature: r.signature as string,
    slot: r.slot as number,
    receivedAtMs: r.receivedAtMs as number,
    ...(bt !== undefined ? { blockTime: bt as number | null } : {}),
  };
}
