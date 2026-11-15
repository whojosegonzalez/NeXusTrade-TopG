/**
 * Phase 12.94-D Milestone D.3.3: AMM v4 Watched Candidate Retrieval & Pure Validation
 *
 * Implements the second offline component of the passive creation watch pipeline:
 * - Validates the discovery proof chain from the bounded WebSocket collector's retained frames
 *   before performing any HTTP dispatch (zero-send pre-check). The retained sequence must be one
 *   the reviewed collector could actually have produced: the exact reviewed subscription, its
 *   acknowledgement, only frames the collector would have survived, and the qualifying
 *   notification last, with consistent byte accounting, counters, timestamps and events.
 * - Derives the notification receipt time from the retained frame (never from summary metadata
 *   alone) and computes the validation deadline from verified evidence and the strictest
 *   applicable limit: min(receipt + 30 s, watch start + 930 s, any caller deadline).
 * - Executes at most two bounded HTTP requests (Solana RPC getTransaction + DexScreener token GET)
 *   via PaperRequestSession, strictly bounded by that deadline. The owned session is stopped and
 *   its abort listener removed on every exit.
 * - Separates pure validation / target derivation from acquisition I/O. The pure derivation
 *   enforces the same request, ordering, identity and deadline rules as acquisition, so evidence
 *   can be re-derived offline at any time.
 * - Enforces distinct timestamp semantics: transaction block time, instruction-requested open time,
 *   and DexScreener pairCreatedAt are preserved separately and never overwritten.
 * - Redacts the RPC URL from evidence records and preserves response bytes losslessly (non-UTF-8
 *   bodies are stored as base64 and never qualify as JSON).
 *
 * PROVISIONAL DISCLAIMER:
 * Candidates discovered and validated by this module are PROVISIONAL. Discovery establishes
 * authentic on-chain pool initialization and market indexing; it does NOT establish strategy
 * eligibility (LP burn, authorities, 5m transactions) or qualified trading flow.
 */

import { createHash } from "node:crypto";
import { isValidSolanaSignature } from "./ExactPoolHistoryEnumerator.js";
import {
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
  PLANNING_START_WINDOW,
  RPC_URL_PLACEHOLDER,
  evaluateInitializationExchange,
  type PrecheckExchange,
} from "../scripts/fresh-amm-v4-precheck.js";
import { WSOL_MINT } from "../research/pilot/RaydiumAmmParser.js";
import { parseDexScreenerTokenPairs } from "./DexScreenerSingleCandidateMarketParser.js";
import { SINGLE_CANDIDATE_PUBLIC_ENDPOINTS } from "../scripts/paper-single-candidate-diagnostic.js";
import {
  PaperRequestSession,
  type PaperRequestExchangeEvidence,
  type PaperRequestSessionLimits,
  type PaperRequestSessionTimers,
} from "./PaperRequestSession.js";
import {
  DEFAULT_CREATION_WATCH_LIMITS,
  type BoundedAmmV4CreationWatchResult,
} from "./BoundedAmmV4CreationWatch.js";

export const PROVISIONAL_TARGET_DISCLAIMER =
  "PROVISIONAL: candidate discovered and verified; does not establish pool creation, strategy eligibility, or qualified trading flow" as const;

/** The exact subscription frame the reviewed collector sends (request id 1, confirmed). */
export const REVIEWED_SUBSCRIPTION_REQUEST_ID = 1 as const;
export const REVIEWED_SUBSCRIPTION_PAYLOAD = JSON.stringify({
  jsonrpc: "2.0",
  id: REVIEWED_SUBSCRIPTION_REQUEST_ID,
  method: "logsSubscribe",
  params: [{ mentions: [RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION] }, { commitment: "confirmed" }],
});

/**
 * Reviewed collector policy used to judge a retained history: the collector's default limits.
 * A history exceeding them could not have come from the reviewed collector configuration.
 */
export const REVIEWED_WATCH_POLICY = Object.freeze({
  watchCeilingMs: DEFAULT_CREATION_WATCH_LIMITS.watchCeilingMs,
  ackTimeoutMs: DEFAULT_CREATION_WATCH_LIMITS.ackTimeoutMs,
  maxIncomingMessages: DEFAULT_CREATION_WATCH_LIMITS.maxIncomingMessages,
  maxPayloadBytes: DEFAULT_CREATION_WATCH_LIMITS.maxPayloadBytes,
});

/**
 * The collector records the qualifying frame, the capture time and the termination time in one
 * synchronous handler; more than this between them is inconsistent.
 */
export const MAX_CAPTURE_SKEW_MS = 1_000;

export interface WatchedDiscoveryEvidence {
  readonly signature: string;
  readonly slot: number;
  readonly subscriptionId: number;
  /** Receipt time of the qualifying notification, taken from its retained frame. */
  readonly notificationReceivedAtMs: number;
  /** Collector start time (verified against the retained frames). */
  readonly watchStartedAtMs: number;
  readonly logs: readonly string[];
}

export type WatchedDiscoveryVerificationResult =
  | { readonly ok: true; readonly discovery: WatchedDiscoveryEvidence }
  | { readonly ok: false; readonly status: string; readonly reason: string };

export type WatchCandidateOutcome =
  | "TARGET_SELECTED"
  | "TRANSACTION_NONMATCH"
  | "TRANSACTION_REQUEST_FAILED"
  | "TRANSACTION_EVIDENCE_UNAVAILABLE"
  | "MARKET_NONMATCH"
  | "MARKET_REQUEST_FAILED"
  | "MARKET_EVIDENCE_UNAVAILABLE"
  | "START_WINDOW_ALREADY_CLOSED"
  | "DISCOVERY_EVIDENCE_INVALID"
  | "DISCOVERY_TAMPERED"
  | "EXCHANGE_EVIDENCE_INVALID"
  | "VALIDATION_DEADLINE_EXPIRED"
  | "OPERATOR_CANCELLED"
  | "SESSION_STOPPED";

export interface WatchCandidateTarget {
  readonly poolId: string;
  readonly mintAddress: string;
  readonly quoteMint: string;
  readonly orientation: "CANDIDATE_BASE_WSOL_QUOTE";
  readonly initialization: {
    readonly signature: string;
    readonly slot: number;
    readonly transactionBlockTimeSec: number | null;
    readonly instructionRequestedOpenTimeSec: number | null;
    readonly feeDestination: { readonly accountIndex: 14; readonly address: string };
    readonly exchangeSeq: number;
  };
  readonly market: {
    readonly pairCreatedAtMs: number;
    readonly runnerOpenTimeSec: number;
    readonly receivedAtMs: number;
    readonly ageSecAtReceipt: number;
    readonly exchangeSeq: number;
    readonly informationalIndicators: {
      readonly note: string;
      readonly liquidityUsd: number;
      readonly marketCapUsd: number;
      readonly buys5m: number;
      readonly sells5m: number;
      readonly volume5mUsd: number;
    };
  };
  readonly startWindow: {
    readonly basis: string;
    readonly status: string;
    readonly minAgeSec: number;
    readonly maxAgeSec: number;
    readonly opensAtMs: number;
    readonly closesAtMs: number;
    readonly opensAtIso: string;
    readonly closesAtIso: string;
  };
  readonly eligibility: typeof PROVISIONAL_TARGET_DISCLAIMER;
}

export type WatchCandidateEvaluationResult =
  | {
      readonly ok: true;
      readonly outcome: "TARGET_SELECTED";
      readonly reason: null;
      readonly target: WatchCandidateTarget;
    }
  | {
      readonly ok: false;
      readonly outcome: "START_WINDOW_ALREADY_CLOSED";
      readonly reason: string;
      readonly target: WatchCandidateTarget;
    }
  | {
      readonly ok: false;
      readonly outcome: Exclude<
        WatchCandidateOutcome,
        "TARGET_SELECTED" | "START_WINDOW_ALREADY_CLOSED"
      >;
      readonly reason: string;
      readonly target: null;
    };

export interface WatchCandidateValidationLimits {
  readonly validationWindowMs: number;
  readonly overallDeadlineAtMs?: number | undefined;
  readonly maxHttpAttempts: number;
  readonly requestTimeoutMs: number;
  readonly rpcPacingMs: number;
  readonly rpcMaxResponseBytes: number;
  readonly dexscreenerPacingMs: number;
  readonly dexscreenerMaxResponseBytes: number;
}

export const DEFAULT_WATCH_VALIDATION_LIMITS: WatchCandidateValidationLimits = Object.freeze({
  validationWindowMs: 30_000,
  maxHttpAttempts: 2,
  requestTimeoutMs: 10_000,
  rpcPacingMs: 2_500,
  rpcMaxResponseBytes: 1_048_576,
  dexscreenerPacingMs: 1_000,
  dexscreenerMaxResponseBytes: 1_048_576,
});

/** Overall session deadline after watch start: the watch ceiling plus the validation headroom. */
export const OVERALL_SESSION_DEADLINE_MS =
  REVIEWED_WATCH_POLICY.watchCeilingMs + DEFAULT_WATCH_VALIDATION_LIMITS.validationWindowMs;

export interface ExecuteWatchCandidateValidationOptions {
  readonly watchResult: BoundedAmmV4CreationWatchResult;
  readonly rpcUrl: string;
  readonly fetchFn: typeof fetch;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  readonly overallDeadlineAtMs?: number | undefined;
  readonly limits?: Partial<WatchCandidateValidationLimits> | undefined;
  readonly onExchangeComplete?: ((evidence: PaperRequestExchangeEvidence) => void) | undefined;
}

export interface WatchCandidateValidationResult {
  readonly ok: boolean;
  readonly outcome: WatchCandidateOutcome;
  readonly reason: string | null;
  readonly target: WatchCandidateTarget | null;
  readonly discovery: WatchedDiscoveryEvidence | null;
  readonly httpAttempts: number;
  readonly exchanges: readonly PrecheckExchange[];
  readonly validationDeadlineAtMs: number;
  readonly completedAtMs: number;
  readonly disclaimer: typeof PROVISIONAL_TARGET_DISCLAIMER;
}

/** Deadline and request policy shared by acquisition and offline derivation. */
export interface WatchEvidenceContext {
  /** Caller deadline; the strictest of this, the limits' deadline and the evidence-derived one applies. */
  readonly overallDeadlineAtMs?: number | undefined;
  readonly limits?: Partial<WatchCandidateValidationLimits> | undefined;
}

/** Stop and refusal reason when the immutable absolute validation deadline is reached. */
const DEADLINE_STOP = "VALIDATION_DEADLINE_EXPIRED";

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const isSafeTime = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Resolves validation limits. Overrides may only tighten: the validation window, attempts,
 * timeout and response ceilings are capped at the reviewed defaults and pacing never drops below
 * them. Invalid values are refused before any I/O.
 */
export function resolveWatchValidationLimits(
  overrides?: Partial<WatchCandidateValidationLimits>,
): WatchCandidateValidationLimits {
  const d = DEFAULT_WATCH_VALIDATION_LIMITS;
  const pick = (key: keyof Omit<WatchCandidateValidationLimits, "overallDeadlineAtMs">): number => {
    const v = overrides?.[key];
    if (v === undefined) return d[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      throw new Error(`[WATCH_VALIDATION_CONFIG_INVALID] ${key} must be a positive safe integer`);
    }
    return key.endsWith("PacingMs") ? Math.max(v, d[key]) : Math.min(v, d[key]);
  };
  const overall = overrides?.overallDeadlineAtMs;
  if (overall !== undefined && !isSafeTime(overall)) {
    throw new Error("[WATCH_VALIDATION_CONFIG_INVALID] overallDeadlineAtMs must be a safe time");
  }
  return Object.freeze({
    validationWindowMs: pick("validationWindowMs"),
    maxHttpAttempts: pick("maxHttpAttempts"),
    requestTimeoutMs: pick("requestTimeoutMs"),
    rpcPacingMs: pick("rpcPacingMs"),
    rpcMaxResponseBytes: pick("rpcMaxResponseBytes"),
    dexscreenerPacingMs: pick("dexscreenerPacingMs"),
    dexscreenerMaxResponseBytes: pick("dexscreenerMaxResponseBytes"),
    ...(overall !== undefined ? { overallDeadlineAtMs: overall } : {}),
  });
}

/**
 * The validation deadline from verified evidence and the strictest applicable limit:
 * min(receipt + window, watch start + 930 s, limits' deadline, caller deadline).
 */
export function computeWatchValidationDeadline(
  discovery: WatchedDiscoveryEvidence,
  context: WatchEvidenceContext = {},
): number {
  const limits = resolveWatchValidationLimits(context.limits);
  if (context.overallDeadlineAtMs !== undefined && !isSafeTime(context.overallDeadlineAtMs)) {
    throw new Error("[WATCH_VALIDATION_CONFIG_INVALID] overallDeadlineAtMs must be a safe time");
  }
  const candidates = [
    discovery.notificationReceivedAtMs + limits.validationWindowMs,
    discovery.watchStartedAtMs + OVERALL_SESSION_DEADLINE_MS,
  ];
  if (limits.overallDeadlineAtMs !== undefined) candidates.push(limits.overallDeadlineAtMs);
  if (context.overallDeadlineAtMs !== undefined) candidates.push(context.overallDeadlineAtMs);
  return Math.min(...candidates);
}

type PostAckClass =
  | { readonly kind: "TERMINATES"; readonly why: string }
  | { readonly kind: "IGNORED" }
  | { readonly kind: "REJECTED" }
  | { readonly kind: "FAILED" }
  | {
      readonly kind: "QUALIFYING";
      readonly signature: string;
      readonly slot: number;
      readonly logs: readonly string[];
    };

/** Mirrors the reviewed collector's post-acknowledgement message handling, without side effects. */
function classifyPostAckFrame(payload: string, subscriptionId: number): PostAckClass {
  let msg: unknown;
  try {
    msg = JSON.parse(payload);
  } catch {
    return { kind: "TERMINATES", why: "invalid JSON" };
  }
  if (!isRecord(msg)) return { kind: "TERMINATES", why: "not a JSON object" };
  if (msg.jsonrpc !== "2.0") return { kind: "TERMINATES", why: "jsonrpc is not 2.0" };
  if (msg.method !== "logsNotification") return { kind: "IGNORED" };
  if (!isRecord(msg.params)) return { kind: "TERMINATES", why: "params is not an object" };
  if (msg.params.subscription !== subscriptionId) return { kind: "REJECTED" };
  const result = msg.params.result;
  if (!isRecord(result)) return { kind: "TERMINATES", why: "params.result is not an object" };
  const slot = isRecord(result.context) ? result.context.slot : undefined;
  if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot <= 0) {
    return { kind: "REJECTED" };
  }
  if (!isRecord(result.value))
    return { kind: "TERMINATES", why: "params.result.value is not an object" };
  const value = result.value;
  if (!("err" in value) || value.err !== null) return { kind: "FAILED" };
  if (!isValidSolanaSignature(value.signature)) return { kind: "REJECTED" };
  return {
    kind: "QUALIFYING",
    signature: value.signature,
    slot,
    logs: Array.isArray(value.logs)
      ? value.logs.filter((l: unknown): l is string => typeof l === "string")
      : [],
  };
}

/**
 * Pure verification of the discovery proof chain from the collector's retained application frames.
 *
 * The retained history must be one the reviewed collector could have produced and still captured:
 * 1. Status NOTIFICATION_CAPTURED (matching the observations), notification present, teardown
 *    settled without failure.
 * 2. Exactly one OUTGOING frame, first, byte-identical to the reviewed subscription payload.
 * 3. The next frame is the acknowledgement (id 1, jsonrpc 2.0, no error, positive safe integer
 *    result), received before the acknowledgement deadline.
 * 4. Every later frame but the last is one the collector survives without capturing (ignored,
 *    rejected or failed notifications); the last frame is the first qualifying notification.
 * 5. Every frame is complete (an overflow frame terminates the collector), its byte length is the
 *    UTF-8 length of its payload, and timestamps are non-decreasing within the watch interval.
 * 6. Counters (messages, payload bytes, rejected and failed notifications), subscription id,
 *    notification metadata (signature, slot, logs, receipt time) and the capture and termination
 *    events agree with what the frames imply.
 * 7. With `nowMs`, no recorded time lies in the future.
 *
 * The receipt time is the qualifying frame's timestamp.
 */
export function validateWatchedDiscoveryEvidence(
  watchResult: BoundedAmmV4CreationWatchResult,
  options: { readonly nowMs?: number | undefined } = {},
): WatchedDiscoveryVerificationResult {
  const invalid = (reason: string): WatchedDiscoveryVerificationResult => ({
    ok: false,
    status: "DISCOVERY_EVIDENCE_INVALID",
    reason,
  });
  const tampered = (reason: string): WatchedDiscoveryVerificationResult => ({
    ok: false,
    status: "DISCOVERY_TAMPERED",
    reason,
  });

  if (watchResult.status !== "NOTIFICATION_CAPTURED") {
    return invalid(`Collector status was ${watchResult.status}, expected NOTIFICATION_CAPTURED`);
  }
  const notification = watchResult.notification;
  if (notification === null) return invalid("Collector notification data was null");
  const obs = watchResult.observations;
  if (obs.terminationStatus !== watchResult.status) {
    return tampered("Observation termination status does not match the result status");
  }
  if (!obs.cleanupSettled) return invalid("Collector teardown did not settle within bounds");
  if (obs.cleanupFailed) {
    return invalid(
      `Collector teardown failed: ${obs.cleanupFailureReason ?? "unknown cleanup failure"}`,
    );
  }

  // Chronology of the watch itself.
  if (
    !isSafeTime(obs.startedAtMs) ||
    !isSafeTime(obs.endedAtMs) ||
    obs.endedAtMs < obs.startedAtMs
  ) {
    return invalid("Watch start/end times are invalid or out of order");
  }
  if (obs.durationMs !== obs.endedAtMs - obs.startedAtMs) {
    return tampered("Watch duration does not equal end minus start");
  }
  if (options.nowMs !== undefined && obs.endedAtMs > options.nowMs) {
    return invalid("Watch end time lies in the future");
  }

  const frames = obs.applicationFrames;
  if (!Array.isArray(frames) || frames.length < 3) {
    return invalid(
      "Retained frames cannot contain a subscription, acknowledgement and notification",
    );
  }

  // Every frame: complete, faithful byte accounting, ordered within the watch interval.
  let previousTs = obs.startedAtMs;
  for (const [i, f] of frames.entries()) {
    if (!f.isComplete || typeof f.payload !== "string" || f.overflow === true) {
      return invalid(
        `Frame #${i} is incomplete or overflowed; the collector would have terminated`,
      );
    }
    if (f.direction !== "INCOMING" && f.direction !== "OUTGOING") {
      return invalid(`Frame #${i} has an invalid direction`);
    }
    if (f.byteLength !== Buffer.byteLength(f.payload, "utf8")) {
      return invalid(`Frame #${i} byte length does not match its retained payload`);
    }
    if (!isSafeTime(f.timestampMs) || f.timestampMs < previousTs) {
      return invalid(`Frame #${i} timestamp is invalid or out of order`);
    }
    if (
      f.timestampMs > obs.endedAtMs ||
      f.timestampMs >= obs.startedAtMs + REVIEWED_WATCH_POLICY.watchCeilingMs
    ) {
      return invalid(`Frame #${i} timestamp lies outside the watch interval`);
    }
    previousTs = f.timestampMs;
  }

  // 1. Exactly one outgoing frame, first, with the exact reviewed subscription policy.
  if (
    frames.filter((f) => f.direction === "OUTGOING").length !== 1 ||
    frames[0]!.direction !== "OUTGOING"
  ) {
    return invalid("Expected exactly one outgoing subscription frame, first in the history");
  }
  if (frames[0]!.payload !== REVIEWED_SUBSCRIPTION_PAYLOAD) {
    return tampered(
      `Outgoing subscription frame differs from the reviewed policy (mentions only ${RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION}, commitment confirmed)`,
    );
  }

  // 2. The acknowledgement must be the next frame (anything else would have terminated the collector).
  const ackFrame = frames[1]!;
  let ack: unknown;
  try {
    ack = JSON.parse(ackFrame.payload as string);
  } catch {
    return invalid("Acknowledgement frame is not valid JSON");
  }
  if (
    !isRecord(ack) ||
    ack.jsonrpc !== "2.0" ||
    ack.id !== REVIEWED_SUBSCRIPTION_REQUEST_ID ||
    (ack.error !== undefined && ack.error !== null) ||
    typeof ack.result !== "number" ||
    !Number.isSafeInteger(ack.result) ||
    ack.result <= 0
  ) {
    return invalid("Frame after the subscription is not a valid acknowledgement");
  }
  if (ackFrame.timestampMs >= obs.startedAtMs + REVIEWED_WATCH_POLICY.ackTimeoutMs) {
    return invalid("Acknowledgement arrived after the acknowledgement deadline");
  }
  const subscriptionId = ack.result;
  if (obs.subscriptionId !== subscriptionId) {
    return tampered(
      `Derived subscription ID (${subscriptionId}) does not match collector observation metadata (${String(obs.subscriptionId)})`,
    );
  }

  // 3. Intermediate frames must be survivable; the last frame must be the qualifying notification.
  let rejected = 0;
  let failed = 0;
  for (let i = 2; i < frames.length - 1; i++) {
    const c = classifyPostAckFrame(frames[i]!.payload as string, subscriptionId);
    if (c.kind === "TERMINATES") {
      return invalid(`Frame #${i} would have terminated the collector (${c.why})`);
    }
    if (c.kind === "QUALIFYING") {
      return invalid(`Frame #${i} would already have been captured; later frames are impossible`);
    }
    if (c.kind === "REJECTED") rejected++;
    if (c.kind === "FAILED") failed++;
  }
  const lastFrame = frames[frames.length - 1]!;
  const last = classifyPostAckFrame(lastFrame.payload as string, subscriptionId);
  if (last.kind !== "QUALIFYING") {
    return invalid("Last retained frame is not a qualifying creation notification");
  }

  // 4. Counters and byte accounting.
  const incoming = frames.filter((f) => f.direction === "INCOMING");
  const incomingBytes = incoming.reduce((n, f) => n + f.byteLength, 0);
  if (
    obs.messagesReceivedCount !== incoming.length ||
    obs.payloadBytesReceived !== incomingBytes ||
    obs.rejectedNotificationsCount !== rejected ||
    obs.failedNotificationsCount !== failed
  ) {
    return tampered("Collector counters do not match the retained frames");
  }
  if (
    incoming.length > REVIEWED_WATCH_POLICY.maxIncomingMessages ||
    incomingBytes > REVIEWED_WATCH_POLICY.maxPayloadBytes
  ) {
    return invalid("Retained frames exceed the reviewed collector ceilings");
  }

  // 5. Notification metadata, with the receipt time taken from the retained frame.
  const receivedAtMs = lastFrame.timestampMs;
  if (notification.signature !== last.signature) {
    return tampered(
      `Derived signature (${last.signature}) does not match collector notification signature (${notification.signature})`,
    );
  }
  if (notification.slot !== last.slot) {
    return tampered(
      `Derived slot (${last.slot}) does not match collector notification slot (${notification.slot})`,
    );
  }
  if (JSON.stringify(notification.logs) !== JSON.stringify(last.logs)) {
    return tampered("Collector notification logs do not match the retained frame");
  }
  if (
    !isSafeTime(notification.receivedAtMs) ||
    notification.receivedAtMs < receivedAtMs ||
    notification.receivedAtMs > obs.endedAtMs ||
    obs.endedAtMs - receivedAtMs > MAX_CAPTURE_SKEW_MS
  ) {
    return tampered(
      "Notification receipt time is inconsistent with its retained frame and the termination time",
    );
  }

  // 6. Capture and termination events must agree with the evidence.
  const events = Array.isArray(obs.events) ? obs.events : [];
  const qualifying = events.filter((e) => e.type === "NOTIFICATION_QUALIFYING");
  const terminated = events.filter((e) => e.type === "WATCH_TERMINATED");
  const q = qualifying[0]?.details;
  const t = terminated[0]?.details;
  if (
    qualifying.length !== 1 ||
    terminated.length !== 1 ||
    q?.signature !== notification.signature ||
    q?.slot !== notification.slot ||
    q?.receivedAtMs !== notification.receivedAtMs ||
    t?.status !== "NOTIFICATION_CAPTURED" ||
    t?.endedAtMs !== obs.endedAtMs
  ) {
    return tampered("Capture or termination events do not match the evidence");
  }

  return {
    ok: true,
    discovery: Object.freeze({
      signature: last.signature,
      slot: last.slot,
      subscriptionId,
      notificationReceivedAtMs: receivedAtMs,
      watchStartedAtMs: obs.startedAtMs,
      logs: Object.freeze([...last.logs]),
    }),
  };
}

/** The JSON body of a completed text exchange, or the reason it cannot be used. */
function usableJson(
  ex: PrecheckExchange,
): { ok: true; json: unknown } | { ok: false; failure: string; kind: "REQUEST" | "EVIDENCE" } {
  if (ex.error !== null) return { ok: false, failure: ex.error, kind: "REQUEST" };
  if (ex.httpStatus !== 200) {
    return { ok: false, failure: `HTTP_${String(ex.httpStatus)}`, kind: "REQUEST" };
  }
  if (ex.response.bodyState !== "COMPLETE" || ex.response.body === null) {
    return { ok: false, failure: "BODY_INCOMPLETE", kind: "EVIDENCE" };
  }
  if (ex.response.bodyEncoding !== "utf8") {
    return { ok: false, failure: "BODY_NOT_TEXT", kind: "EVIDENCE" };
  }
  if (ex.response.bodyRedacted) return { ok: false, failure: "BODY_REDACTED", kind: "EVIDENCE" };
  try {
    return { ok: true, json: JSON.parse(ex.response.body) };
  } catch {
    return { ok: false, failure: "BODY_NOT_JSON", kind: "EVIDENCE" };
  }
}

function mapTxStatusToOutcome(
  status: string,
): "TRANSACTION_REQUEST_FAILED" | "TRANSACTION_EVIDENCE_UNAVAILABLE" | "TRANSACTION_NONMATCH" {
  if (status.startsWith("REQUEST_FAILED")) return "TRANSACTION_REQUEST_FAILED";
  if (status.startsWith("EVIDENCE_UNAVAILABLE")) return "TRANSACTION_EVIDENCE_UNAVAILABLE";
  return "TRANSACTION_NONMATCH";
}

/**
 * Request policy shared by acquisition and offline derivation. Returns a reason when the recorded
 * exchanges could not have come from a compliant acquisition, otherwise null.
 */
function exchangePolicyViolation(
  discovery: WatchedDiscoveryEvidence,
  exchanges: readonly PrecheckExchange[],
  validationDeadlineAtMs: number,
  maxHttpAttempts: number,
  requestTimeoutMs: number,
): string | null {
  if (exchanges.length > maxHttpAttempts) return "REQUEST_BOUND_EXCEEDED";
  for (const [i, ex] of exchanges.entries()) {
    if (ex.seq !== i + 1) return "EXCHANGE_SEQUENCE_INVALID";
    if (!isSafeTime(ex.dispatchedAtMs) || ex.dispatchedAtMs < discovery.notificationReceivedAtMs) {
      return `EXCHANGE_${ex.seq}_DISPATCHED_BEFORE_NOTIFICATION`;
    }
    if (
      ex.completedAtMs === null ||
      !isSafeTime(ex.completedAtMs) ||
      ex.completedAtMs < ex.dispatchedAtMs
    ) {
      return `EXCHANGE_${ex.seq}_COMPLETION_INVALID`;
    }
    // The per-request timeout bounds every exchange; a longer one is not a compliant record, and
    // a timeout or cancellation record never qualifies (its error makes it a request failure).
    if (ex.completedAtMs - ex.dispatchedAtMs > requestTimeoutMs) {
      return `EXCHANGE_${ex.seq}_EXCEEDED_REQUEST_TIMEOUT`;
    }
    if (ex.completedAtMs > validationDeadlineAtMs) {
      return `EXCHANGE_${ex.seq}_AFTER_VALIDATION_DEADLINE`;
    }
  }
  const tx = exchanges[0];
  if (tx) {
    const params = tx.request.rpcParams;
    if (
      tx.purpose !== "PRECHECK_TRANSACTION" ||
      tx.lane !== "SOLANA_RPC" ||
      tx.request.method !== "POST" ||
      tx.request.url !== RPC_URL_PLACEHOLDER ||
      tx.request.rpcMethod !== "getTransaction" ||
      !Array.isArray(params) ||
      params[0] !== discovery.signature
    ) {
      return "TRANSACTION_REQUEST_IDENTITY_INVALID";
    }
  }
  const market = exchanges[1];
  if (market) {
    if (
      market.purpose !== "PRECHECK_MARKET" ||
      market.lane !== "DEXSCREENER" ||
      market.request.method !== "GET"
    ) {
      return "MARKET_REQUEST_IDENTITY_INVALID";
    }
    if (market.dispatchedAtMs < (tx?.completedAtMs ?? Number.POSITIVE_INFINITY)) {
      return "MARKET_REQUEST_BEFORE_TRANSACTION_COMPLETED";
    }
  }
  return null;
}

/** A request cut off at the validation deadline. */
const abortedAtDeadline = (ex: PrecheckExchange, deadline: number) =>
  (ex.error === "REQUEST_ABORTED" || ex.error === "REQUEST_TIMED_OUT") &&
  ex.completedAtMs === deadline;

/**
 * Pure evaluation and candidate target derivation from verified discovery evidence and recorded
 * HTTP exchanges. Zero I/O, network, timer state or filesystem writes.
 *
 * Enforces the same rules as acquisition: at most the allowed number of exchanges, contiguous
 * sequence numbers in dispatch order, the transaction request first and only then the market
 * request, request identities (method, redacted RPC URL, requested signature, market endpoint),
 * chronology from the notification receipt, and completion no later than the validation deadline
 * derived from the verified evidence. A market request after a non-qualifying transaction is
 * impossible for a compliant acquisition and is rejected.
 */
export function evaluateWatchCandidateEvidence(
  discovery: WatchedDiscoveryEvidence,
  exchanges: readonly PrecheckExchange[],
  context: WatchEvidenceContext = {},
): WatchCandidateEvaluationResult {
  const limits = resolveWatchValidationLimits(context.limits);
  const deadline = computeWatchValidationDeadline(discovery, context);
  const invalid = (reason: string): WatchCandidateEvaluationResult => ({
    ok: false,
    outcome: "EXCHANGE_EVIDENCE_INVALID",
    reason,
    target: null,
  });

  const violation = exchangePolicyViolation(
    discovery,
    exchanges,
    deadline,
    limits.maxHttpAttempts,
    limits.requestTimeoutMs,
  );
  if (violation !== null) return invalid(violation);

  const txExchange = exchanges[0];
  if (!txExchange) {
    return {
      ok: false,
      outcome: "TRANSACTION_EVIDENCE_UNAVAILABLE",
      reason: "PRECHECK_TRANSACTION exchange not found in evidence",
      target: null,
    };
  }
  if (abortedAtDeadline(txExchange, deadline)) {
    return {
      ok: false,
      outcome: "VALIDATION_DEADLINE_EXPIRED",
      reason: `TRANSACTION_${txExchange.error ?? "ABORTED"}_AT_DEADLINE`,
      target: null,
    };
  }

  const txEval = evaluateInitializationExchange(txExchange, {
    signature: discovery.signature,
    slot: discovery.slot,
  });

  if (!txEval.ok) {
    if (exchanges.length > 1) return invalid("MARKET_REQUEST_WITHOUT_QUALIFIED_TRANSACTION");
    return {
      ok: false,
      outcome: mapTxStatusToOutcome(txEval.status),
      reason: txEval.status,
      target: null,
    };
  }

  const init = txEval.init;
  const marketExchange = exchanges[1];
  if (!marketExchange) {
    return {
      ok: false,
      outcome: "MARKET_EVIDENCE_UNAVAILABLE",
      reason: "PRECHECK_MARKET exchange not found in evidence",
      target: null,
    };
  }

  const expectedMarketUrl = SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(init.mintAddress);
  if (marketExchange.request.url !== expectedMarketUrl) {
    return invalid("MARKET_REQUEST_NOT_FOR_DECODED_MINT");
  }
  if (abortedAtDeadline(marketExchange, deadline)) {
    return {
      ok: false,
      outcome: "VALIDATION_DEADLINE_EXPIRED",
      reason: `MARKET_${marketExchange.error ?? "ABORTED"}_AT_DEADLINE`,
      target: null,
    };
  }

  const marketBody = usableJson(marketExchange);
  if (!marketBody.ok) {
    const outcome =
      marketBody.kind === "REQUEST" ? "MARKET_REQUEST_FAILED" : "MARKET_EVIDENCE_UNAVAILABLE";
    return {
      ok: false,
      outcome,
      reason: marketBody.failure,
      target: null,
    };
  }

  const receivedAtMs = marketExchange.completedAtMs as number;
  const parsed = parseDexScreenerTokenPairs(
    marketBody.json,
    { poolId: init.poolId, mintAddress: init.mintAddress },
    receivedAtMs,
  );

  if (!parsed.ok) {
    return {
      ok: false,
      outcome: "MARKET_NONMATCH",
      reason: parsed.reason,
      target: null,
    };
  }

  const pairCreatedAtMs = parsed.provenance.creation.pairCreatedAtMs;
  const runnerOpenTimeSec = parsed.pool.openTimeSec;
  const opensAtMs = (runnerOpenTimeSec + PLANNING_START_WINDOW.minAgeSec) * 1000;
  const closesAtMs = (runnerOpenTimeSec + PLANNING_START_WINDOW.maxAgeSec) * 1000;
  const p = parsed.pool;

  const target: WatchCandidateTarget = {
    poolId: init.poolId,
    mintAddress: init.mintAddress,
    quoteMint: WSOL_MINT,
    orientation: "CANDIDATE_BASE_WSOL_QUOTE",
    initialization: {
      signature: init.signature,
      slot: init.slot,
      transactionBlockTimeSec: init.transactionBlockTimeSec,
      instructionRequestedOpenTimeSec: init.instructionRequestedOpenTimeSec,
      feeDestination: { accountIndex: 14, address: RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION },
      exchangeSeq: txExchange.seq,
    },
    market: {
      pairCreatedAtMs,
      runnerOpenTimeSec,
      receivedAtMs,
      ageSecAtReceipt: Math.floor(receivedAtMs / 1000) - runnerOpenTimeSec,
      exchangeSeq: marketExchange.seq,
      informationalIndicators: {
        note: "Informational only; the runner's scanner and gates decide at runtime.",
        liquidityUsd: p.liquidityUsd,
        marketCapUsd: p.marketCapUsd,
        buys5m: p.buys5m,
        sells5m: p.sells5m,
        volume5mUsd: p.volume5mUsd,
      },
    },
    startWindow: {
      basis: PLANNING_START_WINDOW.basis,
      status: PLANNING_START_WINDOW.status,
      minAgeSec: PLANNING_START_WINDOW.minAgeSec,
      maxAgeSec: PLANNING_START_WINDOW.maxAgeSec,
      opensAtMs,
      closesAtMs,
      opensAtIso: new Date(opensAtMs).toISOString(),
      closesAtIso: new Date(closesAtMs).toISOString(),
    },
    eligibility: PROVISIONAL_TARGET_DISCLAIMER,
  };

  if (receivedAtMs > closesAtMs) {
    return {
      ok: false,
      outcome: "START_WINDOW_ALREADY_CLOSED",
      reason: "PAIR_CREATED_AT_AGE_BEYOND_WINDOW",
      target,
    };
  }

  return {
    ok: true,
    outcome: "TARGET_SELECTED",
    reason: null,
    target,
  };
}

/**
 * Transforms PaperRequestSession exchange evidence into a PrecheckExchange record. The RPC URL is
 * redacted. Response bytes are preserved losslessly: valid UTF-8 is stored as text, anything else
 * as base64 (which never qualifies as JSON). The digest covers the original retained bytes (the
 * retained prefix only for a partial body), and the stored form always decodes back to them.
 */
export function precheckExchangeFromEvidence(
  e: PaperRequestExchangeEvidence,
  options?: { readonly rpcUrlPlaceholder?: string } | undefined,
): PrecheckExchange {
  let rpcMethod: string | null = null;
  let rpcParams: unknown = null;
  if (e.requestBody !== null) {
    try {
      const parsed = JSON.parse(e.requestBody) as {
        jsonrpc?: unknown;
        method?: unknown;
        params?: unknown;
      };
      if (parsed.jsonrpc === "2.0") {
        rpcMethod = typeof parsed.method === "string" ? parsed.method : null;
        rpcParams = parsed.params ?? null;
      }
    } catch {
      // Non-JSON-RPC body
    }
  }

  const isSolanaRpc = e.entry.lane === "SOLANA_RPC";
  const urlPlaceholder = options?.rpcUrlPlaceholder ?? RPC_URL_PLACEHOLDER;
  const safeUrl = isSolanaRpc ? urlPlaceholder : e.url;

  let body: string | null = null;
  let bodyEncoding: "utf8" | "base64" | null = null;
  if (e.body !== null) {
    const text = e.body.toString("utf8");
    if (Buffer.from(text, "utf8").equals(e.body)) {
      body = text;
      bodyEncoding = "utf8";
    } else {
      body = e.body.toString("base64");
      bodyEncoding = "base64";
    }
  }

  return {
    seq: e.entry.seq,
    purpose: e.entry.purpose,
    lane: e.entry.lane,
    jsonRpcId: e.entry.jsonRpcId,
    request: {
      method: e.method,
      url: safeUrl,
      headersRecorded: false,
      rpcMethod,
      rpcParams,
    },
    dispatchedAtMs: e.entry.dispatchedAtMs,
    completedAtMs: e.entry.completedAtMs,
    httpStatus: e.entry.httpStatus,
    error: e.entry.error,
    response: {
      headers: e.responseHeaders,
      bodyState: e.bodyState,
      completeEvidence: e.bodyState === "COMPLETE",
      retainedBytes: e.body?.length ?? null,
      observedBytes: e.observedBodyBytes,
      maxResponseBytes: e.maxResponseBytes,
      receivedBytesSha256: e.body === null ? null : sha256(e.body),
      receivedDigestScope:
        e.body === null
          ? null
          : e.bodyState === "COMPLETE"
            ? "ORIGINAL_COMPLETE_BODY_BYTES"
            : "ORIGINAL_RETAINED_PREFIX_BYTES_ONLY",
      bodyEncoding,
      storedBytes: e.body?.length ?? null,
      bodyRedacted: false,
      reproducesReceivedDigest: e.body !== null,
      body,
    },
  };
}

/**
 * Executes watched candidate validation:
 * 1. Pre-send discovery verification against the current clock (no future timestamps); any
 *    failure terminates with zero HTTP requests.
 * 2. Validation deadline from verified evidence and the strictest applicable limit; if already
 *    elapsed, or the operator has already cancelled, nothing is sent.
 * 3. Bounded HTTP dispatch via an owned PaperRequestSession (getTransaction, then the market GET
 *    only after a qualifying initialization). The session is stopped and its abort listener
 *    removed on every exit.
 * 4. The result comes from the same pure derivation used offline, except for operator
 *    cancellation, which is classified from the abort signal while keeping request evidence.
 */
export async function executeWatchCandidateValidation(
  options: ExecuteWatchCandidateValidationOptions,
): Promise<WatchCandidateValidationResult> {
  const clock = options.clock ?? (() => Date.now());
  const limits = resolveWatchValidationLimits(options.limits);
  const context: WatchEvidenceContext = {
    limits: options.limits,
    overallDeadlineAtMs: options.overallDeadlineAtMs,
  };

  const startNowMs = clock();
  const base = (
    discovery: WatchedDiscoveryEvidence | null,
    validationDeadlineAtMs: number,
    exchanges: readonly PrecheckExchange[],
    httpAttempts: number,
  ) => ({
    discovery,
    validationDeadlineAtMs,
    exchanges: [...exchanges],
    httpAttempts,
    completedAtMs: clock(),
    disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
  });

  // 1. Pre-send discovery verification (receipt time from the retained frame; nothing future).
  const verification = validateWatchedDiscoveryEvidence(options.watchResult, { nowMs: startNowMs });
  if (!verification.ok) {
    return {
      ok: false,
      outcome:
        verification.status === "DISCOVERY_TAMPERED"
          ? "DISCOVERY_TAMPERED"
          : "DISCOVERY_EVIDENCE_INVALID",
      reason: verification.reason,
      target: null,
      ...base(null, 0, [], 0),
    };
  }
  const discovery = verification.discovery;

  // 2. Deadline from verified evidence and the strictest applicable limit.
  const validationDeadlineAtMs = computeWatchValidationDeadline(discovery, context);
  const expiredBeforeDispatch = (): WatchCandidateValidationResult => ({
    ok: false,
    outcome: "VALIDATION_DEADLINE_EXPIRED",
    reason: "Validation deadline expired before HTTP dispatch could begin",
    target: null,
    ...base(discovery, validationDeadlineAtMs, [], 0),
  });
  // A fresh clock after verification: verification time counts against the absolute deadline.
  if (clock() >= validationDeadlineAtMs) return expiredBeforeDispatch();
  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      outcome: "OPERATOR_CANCELLED",
      reason: "OPERATOR_CANCELLED: aborted before dispatch",
      target: null,
      ...base(discovery, validationDeadlineAtMs, [], 0),
    };
  }

  // 3. Owned, bounded request session. The absolute deadline is immutable: its remaining time is
  //    re-read here, every dispatch admission re-checks it (refusal guard), and an owned guard
  //    timer stops the session (aborting in-flight work) when it is reached.
  const remainingMs = validationDeadlineAtMs - clock();
  if (remainingMs <= 0) return expiredBeforeDispatch();
  const sessionLimits: PaperRequestSessionLimits = {
    lifetimeMs: remainingMs,
    maxHttpAttempts: limits.maxHttpAttempts,
    requestTimeoutMs: limits.requestTimeoutMs,
    lanes: {
      SOLANA_RPC: {
        maxAttempts: 1,
        pacingMs: limits.rpcPacingMs,
        maxResponseBytes: limits.rpcMaxResponseBytes,
      },
      DEXSCREENER: {
        maxAttempts: 1,
        pacingMs: limits.dexscreenerPacingMs,
        maxResponseBytes: limits.dexscreenerMaxResponseBytes,
      },
      RUGCHECK: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 1_048_576 },
      SOLANA_TRACKER: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 1_048_576 },
    },
  };

  const recordedExchanges: PrecheckExchange[] = [];
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn: options.fetchFn,
    limits: sessionLimits,
    clock: options.clock,
    timers: options.timers,
    onExchangeComplete: (e) => {
      recordedExchanges.push(precheckExchangeFromEvidence(e));
      options.onExchangeComplete?.(e);
    },
  });
  const onAbort = () => session.stop("CALLER_CANCELLED");
  options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  session.open();
  const guardTimers: PaperRequestSessionTimers = options.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const deadlineGuard = guardTimers.setTimeout(
    () => session.stop(DEADLINE_STOP),
    Math.max(0, validationDeadlineAtMs - clock()),
  );
  /** Admission guard: no request is counted or sent at or after the absolute deadline. */
  const deadlineRefusal = () => (clock() >= validationDeadlineAtMs ? DEADLINE_STOP : null);

  const httpAttempts = () => session.getStatus().httpAttempts;
  const finish = (
    outcome: WatchCandidateOutcome,
    reason: string | null,
    target: WatchCandidateTarget | null,
  ): WatchCandidateValidationResult => ({
    ok: outcome === "TARGET_SELECTED",
    outcome,
    reason,
    target,
    ...base(discovery, validationDeadlineAtMs, recordedExchanges, httpAttempts()),
  });
  const fromPure = (): WatchCandidateValidationResult => {
    const evaluation = evaluateWatchCandidateEvidence(discovery, recordedExchanges, context);
    return finish(evaluation.outcome, evaluation.reason, evaluation.target);
  };
  /** The absolute deadline stopped the session or refused or cut off this request. */
  const deadlineReached = (error: string | null | undefined): boolean => {
    const stopReason = session.getStatus().stopReason;
    return (
      stopReason === DEADLINE_STOP ||
      stopReason === "LIFETIME_EXPIRED" ||
      error === DEADLINE_STOP ||
      error === "LIFETIME_EXPIRED"
    );
  };
  /** Failure classification for a request that did not produce usable evidence. */
  const interrupted = (
    error: string | undefined,
    requestFailure: WatchCandidateOutcome,
  ): WatchCandidateValidationResult | null => {
    if (options.abortSignal?.aborted) {
      return finish("OPERATOR_CANCELLED", `OPERATOR_CANCELLED: ${error ?? "NOT_DISPATCHED"}`, null);
    }
    if (deadlineReached(error)) {
      return finish("VALIDATION_DEADLINE_EXPIRED", error ?? DEADLINE_STOP, null);
    }
    if (error === "REQUEST_SESSION_STOPPED") return finish("SESSION_STOPPED", error, null);
    return error === undefined ? null : finish(requestFailure, error, null);
  };

  try {
    // Request 1: the initialization transaction.
    const txRpcId = session.nextJsonRpcId();
    const tx = await session.dispatch({
      lane: "SOLANA_RPC",
      owner: "SECURITY",
      purpose: "PRECHECK_TRANSACTION",
      requestedIdentity: discovery.signature,
      url: options.rpcUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: txRpcId,
        method: "getTransaction",
        params: [
          discovery.signature,
          { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
        ],
      }),
      jsonRpcId: txRpcId,
      waitSignals: options.abortSignal ? [options.abortSignal] : undefined,
      refusal: deadlineRefusal,
    });
    if (!tx.dispatched) {
      return (
        interrupted(tx.error ?? "NOT_DISPATCHED", "TRANSACTION_REQUEST_FAILED") ??
        finish("TRANSACTION_REQUEST_FAILED", "NOT_DISPATCHED", null)
      );
    }
    if (options.abortSignal?.aborted || deadlineReached(tx.error)) {
      const cut = interrupted(
        tx.error ?? "INTERRUPTED_AFTER_RESPONSE",
        "TRANSACTION_REQUEST_FAILED",
      );
      if (cut) return cut;
    }

    const txExchange = recordedExchanges[0];
    if (!txExchange) {
      return finish(
        "TRANSACTION_EVIDENCE_UNAVAILABLE",
        "Transaction exchange record missing after dispatch",
        null,
      );
    }
    const txEval = evaluateInitializationExchange(txExchange, {
      signature: discovery.signature,
      slot: discovery.slot,
    });
    // Not a qualifying initialization: exactly one request; the result comes from the pure rules.
    if (!txEval.ok) return fromPure();

    // Request 2: the market check, only after a qualifying initialization.
    const market = await session.dispatch({
      lane: "DEXSCREENER",
      owner: "SPOT",
      purpose: "PRECHECK_MARKET",
      requestedIdentity: txEval.init.mintAddress,
      url: SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(txEval.init.mintAddress),
      method: "GET",
      headers: { Accept: "application/json" },
      waitSignals: options.abortSignal ? [options.abortSignal] : undefined,
      refusal: deadlineRefusal,
    });
    if (!market.dispatched) {
      return (
        interrupted(market.error ?? "NOT_DISPATCHED", "MARKET_REQUEST_FAILED") ??
        finish("MARKET_REQUEST_FAILED", "NOT_DISPATCHED", null)
      );
    }
    if (options.abortSignal?.aborted || deadlineReached(market.error)) {
      const cut = interrupted(
        market.error ?? "INTERRUPTED_AFTER_RESPONSE",
        "MARKET_REQUEST_FAILED",
      );
      if (cut) return cut;
    }
    return fromPure();
  } finally {
    // Unconditional cleanup: no timer or listener outlives the call (first stop cause is kept).
    options.abortSignal?.removeEventListener("abort", onAbort);
    guardTimers.clearTimeout(deadlineGuard);
    session.stop("WATCH_VALIDATION_FINISHED");
  }
}
