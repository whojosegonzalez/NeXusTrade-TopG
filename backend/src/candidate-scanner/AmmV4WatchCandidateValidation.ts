/**
 * Phase 12.94-D Milestone D.3.3: AMM v4 Watched Candidate Retrieval & Pure Validation
 *
 * Implements the second offline component of the passive creation watch pipeline:
 * - Validates the discovery proof chain from the bounded WebSocket collector's retained frames
 *   before performing any HTTP dispatch (zero-send pre-check).
 * - Executes at most two bounded HTTP requests (Solana RPC getTransaction + DexScreener token GET)
 *   via PaperRequestSession, strictly bounded by the validation deadline (min(t_notif + 30s, t_overall)).
 * - Separates pure validation / target derivation from acquisition I/O so that evidence can be
 *   re-derived offline at any time.
 * - Enforces distinct timestamp semantics: transaction block time, instruction-requested open time,
 *   and DexScreener pairCreatedAt are preserved separately and never overwritten.
 * - Strictly redacts credentials and RPC URLs from evidence records.
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
import type { BoundedAmmV4CreationWatchResult } from "./BoundedAmmV4CreationWatch.js";

export const PROVISIONAL_TARGET_DISCLAIMER =
  "PROVISIONAL: candidate discovered and verified; does not establish pool creation, strategy eligibility, or qualified trading flow" as const;

export interface WatchedDiscoveryEvidence {
  readonly signature: string;
  readonly slot: number;
  readonly subscriptionId: number;
  readonly notificationReceivedAtMs: number;
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

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Pure verification of the discovery proof chain from the collector's retained application frames.
 *
 * Enforces:
 * 1. Collector status must be NOTIFICATION_CAPTURED and notification metadata present.
 * 2. Collector teardown must have settled cleanly without cleanup failures.
 * 3. Outgoing subscription frame must be complete, use JSON-RPC 2.0 logsSubscribe, and mention the pinned fee destination.
 * 4. Acknowledgement frame must match outgoing request ID, error === null, and return safe integer subscription ID.
 * 5. First qualifying notification must match subscription ID, slot > 0, explicit err === null, and valid 64-byte Solana signature.
 * 6. Derived signature and slot must match collector notification metadata byte-for-byte.
 */
export function validateWatchedDiscoveryEvidence(
  watchResult: BoundedAmmV4CreationWatchResult,
): WatchedDiscoveryVerificationResult {
  if (watchResult.status !== "NOTIFICATION_CAPTURED") {
    return {
      ok: false,
      status: "DISCOVERY_EVIDENCE_INVALID",
      reason: `Collector status was ${watchResult.status}, expected NOTIFICATION_CAPTURED`,
    };
  }

  if (watchResult.notification === null) {
    return {
      ok: false,
      status: "DISCOVERY_EVIDENCE_INVALID",
      reason: "Collector notification data was null",
    };
  }

  if (!watchResult.observations.cleanupSettled) {
    return {
      ok: false,
      status: "DISCOVERY_EVIDENCE_INVALID",
      reason: "Collector teardown did not settle within bounds",
    };
  }

  if (watchResult.observations.cleanupFailed) {
    return {
      ok: false,
      status: "DISCOVERY_EVIDENCE_INVALID",
      reason: `Collector teardown failed: ${watchResult.observations.cleanupFailureReason ?? "unknown cleanup failure"}`,
    };
  }

  const frames = watchResult.observations.applicationFrames;
  if (!Array.isArray(frames) || frames.length === 0) {
    return {
      ok: false,
      status: "DISCOVERY_EVIDENCE_INVALID",
      reason: "No application frames retained in collector observations",
    };
  }

  // 1. Locate and validate outgoing subscription frame
  let subRequestId: number | null = null;
  let outgoingFrameIndex = -1;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.direction === "OUTGOING") {
      if (!f.isComplete || typeof f.payload !== "string") {
        return {
          ok: false,
          status: "DISCOVERY_EVIDENCE_INVALID",
          reason: "Outgoing subscription frame is incomplete or lacks string payload",
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.payload);
      } catch {
        return {
          ok: false,
          status: "DISCOVERY_EVIDENCE_INVALID",
          reason: "Outgoing subscription frame is not valid JSON",
        };
      }
      if (
        !isRecord(parsed) ||
        parsed.jsonrpc !== "2.0" ||
        parsed.method !== "logsSubscribe" ||
        typeof parsed.id !== "number" ||
        !Number.isSafeInteger(parsed.id) ||
        parsed.id <= 0
      ) {
        return {
          ok: false,
          status: "DISCOVERY_EVIDENCE_INVALID",
          reason: "Outgoing subscription frame violates JSON-RPC 2.0 logsSubscribe schema",
        };
      }
      if (!Array.isArray(parsed.params) || !isRecord(parsed.params[0])) {
        return {
          ok: false,
          status: "DISCOVERY_EVIDENCE_INVALID",
          reason: "Outgoing subscription frame missing filter parameters",
        };
      }
      const mentions = parsed.params[0].mentions;
      if (
        !Array.isArray(mentions) ||
        !mentions.includes(RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION)
      ) {
        return {
          ok: false,
          status: "DISCOVERY_TAMPERED",
          reason: `Outgoing subscription frame does not mention pinned fee destination ${RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION}`,
        };
      }
      subRequestId = parsed.id;
      outgoingFrameIndex = i;
      break;
    }
  }

  if (subRequestId === null || outgoingFrameIndex === -1) {
    return {
      ok: false,
      status: "DISCOVERY_EVIDENCE_INVALID",
      reason: "No outgoing logsSubscribe frame observed in application frames",
    };
  }

  // 2. Locate and validate subscription acknowledgement
  let derivedSubId: number | null = null;
  let ackFrameIndex = -1;
  for (let i = outgoingFrameIndex + 1; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.direction === "INCOMING") {
      if (!f.isComplete || typeof f.payload !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.payload);
      } catch {
        continue;
      }
      if (isRecord(parsed) && parsed.id === subRequestId) {
        if (parsed.jsonrpc !== "2.0") {
          return {
            ok: false,
            status: "DISCOVERY_EVIDENCE_INVALID",
            reason: "Subscription acknowledgement frame jsonrpc is not 2.0",
          };
        }
        if (parsed.error !== undefined && parsed.error !== null) {
          return {
            ok: false,
            status: "DISCOVERY_EVIDENCE_INVALID",
            reason: "Subscription acknowledgement frame contains error",
          };
        }
        if (
          typeof parsed.result !== "number" ||
          !Number.isSafeInteger(parsed.result) ||
          parsed.result <= 0
        ) {
          return {
            ok: false,
            status: "DISCOVERY_EVIDENCE_INVALID",
            reason: "Subscription acknowledgement result is not a positive safe integer",
          };
        }
        derivedSubId = parsed.result;
        ackFrameIndex = i;
        break;
      }
    }
  }

  if (derivedSubId === null || ackFrameIndex === -1) {
    return {
      ok: false,
      status: "DISCOVERY_EVIDENCE_INVALID",
      reason: "No subscription acknowledgement frame matching request ID observed",
    };
  }

  if (watchResult.observations.subscriptionId !== derivedSubId) {
    return {
      ok: false,
      status: "DISCOVERY_TAMPERED",
      reason: `Derived subscription ID (${derivedSubId}) does not match collector observation metadata (${watchResult.observations.subscriptionId})`,
    };
  }

  // 3. Locate first qualifying notification frame
  let qualifyingSig: string | null = null;
  let qualifyingSlot: number | null = null;
  let qualifyingLogs: readonly string[] = [];

  for (let i = ackFrameIndex + 1; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.direction === "INCOMING") {
      if (!f.isComplete || typeof f.payload !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(f.payload);
      } catch {
        continue;
      }
      if (
        !isRecord(parsed) ||
        parsed.jsonrpc !== "2.0" ||
        parsed.method !== "logsNotification" ||
        !isRecord(parsed.params) ||
        parsed.params.subscription !== derivedSubId ||
        !isRecord(parsed.params.result)
      ) {
        continue;
      }
      const res = parsed.params.result;
      if (
        !isRecord(res.context) ||
        typeof res.context.slot !== "number" ||
        !Number.isSafeInteger(res.context.slot) ||
        res.context.slot <= 0
      ) {
        continue;
      }
      if (!isRecord(res.value)) {
        continue;
      }
      // Strict err === null check: must have explicit 'err' property that is strictly null
      if (!("err" in res.value) || res.value.err !== null) {
        continue;
      }
      if (typeof res.value.signature !== "string" || !isValidSolanaSignature(res.value.signature)) {
        continue;
      }

      qualifyingSig = res.value.signature;
      qualifyingSlot = res.context.slot;
      qualifyingLogs = Array.isArray(res.value.logs)
        ? res.value.logs.filter((l): l is string => typeof l === "string")
        : [];
      break;
    }
  }

  if (qualifyingSig === null || qualifyingSlot === null) {
    return {
      ok: false,
      status: "DISCOVERY_EVIDENCE_INVALID",
      reason: "No qualifying creation notification observed in retained application frames",
    };
  }

  // 4. Cross-check against collector notification metadata
  if (watchResult.notification.signature !== qualifyingSig) {
    return {
      ok: false,
      status: "DISCOVERY_TAMPERED",
      reason: `Derived signature (${qualifyingSig}) does not match collector notification signature (${watchResult.notification.signature})`,
    };
  }

  if (watchResult.notification.slot !== qualifyingSlot) {
    return {
      ok: false,
      status: "DISCOVERY_TAMPERED",
      reason: `Derived slot (${qualifyingSlot}) does not match collector notification slot (${watchResult.notification.slot})`,
    };
  }

  return {
    ok: true,
    discovery: {
      signature: qualifyingSig,
      slot: qualifyingSlot,
      subscriptionId: derivedSubId,
      notificationReceivedAtMs: watchResult.notification.receivedAtMs,
      logs: Object.freeze([...qualifyingLogs]),
    },
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
 * Pure evaluation and candidate target derivation from verified discovery evidence and recorded HTTP exchanges.
 *
 * Performs zero I/O, zero network, zero timer state, and zero filesystem writes.
 * Re-derives the complete target and validates the planning start window.
 */
export function evaluateWatchCandidateEvidence(
  discovery: WatchedDiscoveryEvidence,
  exchanges: readonly PrecheckExchange[],
): WatchCandidateEvaluationResult {
  const txExchange = exchanges.find((e) => e.purpose === "PRECHECK_TRANSACTION");
  if (!txExchange) {
    return {
      ok: false,
      outcome: "TRANSACTION_EVIDENCE_UNAVAILABLE",
      reason: "PRECHECK_TRANSACTION exchange not found in evidence",
      target: null,
    };
  }

  const txEval = evaluateInitializationExchange(txExchange, {
    signature: discovery.signature,
    slot: discovery.slot,
  });

  if (!txEval.ok) {
    return {
      ok: false,
      outcome: mapTxStatusToOutcome(txEval.status),
      reason: txEval.status,
      target: null,
    };
  }

  const init = txEval.init;
  const marketExchange = exchanges.find((e) => e.purpose === "PRECHECK_MARKET");
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
    return {
      ok: false,
      outcome: "MARKET_NONMATCH",
      reason: "Market exchange URL does not match candidate mint endpoint",
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

  const receivedAtMs = marketExchange.completedAtMs ?? marketExchange.dispatchedAtMs;
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
 * Transforms PaperRequestSession exchange evidence into a PrecheckExchange record,
 * ensuring RPC URLs are redacted and response payloads are accurately preserved.
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
  const rawBodyText = e.body === null ? null : e.body.toString("utf8");

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
      bodyEncoding: e.body !== null ? "utf8" : null,
      bodyRedacted: false,
      reproducesReceivedDigest: e.body !== null,
      body: rawBodyText,
    },
  };
}

/**
 * Executes watched candidate validation:
 * 1. Pre-send discovery verification: re-derives signature, slot, and subscription binding from retained frames.
 *    Any failure terminates immediately with zero HTTP requests.
 * 2. Absolute validation deadline check: computes min(t_notif + 30s, t_overall). If clock has already elapsed,
 *    terminates immediately with zero HTTP requests.
 * 3. Bounded HTTP dispatch via PaperRequestSession:
 *    - Request 1: getTransaction for derived signature.
 *    - Request 2: ONLY if Request 1 evaluates to a valid Raydium AMM v4 initialization, DexScreener token GET.
 * 4. Pure target evaluation and return of in-memory provisional result.
 */
export async function executeWatchCandidateValidation(
  options: ExecuteWatchCandidateValidationOptions,
): Promise<WatchCandidateValidationResult> {
  const clock = options.clock ?? (() => Date.now());
  const limits: WatchCandidateValidationLimits = {
    ...DEFAULT_WATCH_VALIDATION_LIMITS,
    ...options.limits,
  };

  // 1. Pre-send discovery verification
  const verification = validateWatchedDiscoveryEvidence(options.watchResult);
  if (!verification.ok) {
    const outcome: WatchCandidateOutcome =
      verification.status === "DISCOVERY_TAMPERED"
        ? "DISCOVERY_TAMPERED"
        : "DISCOVERY_EVIDENCE_INVALID";
    return {
      ok: false,
      outcome,
      reason: verification.reason,
      target: null,
      discovery: null,
      httpAttempts: 0,
      exchanges: [],
      validationDeadlineAtMs: 0,
      completedAtMs: clock(),
      disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
    };
  }

  const discovery = verification.discovery;

  // 2. Absolute validation deadline check
  const notifTime = discovery.notificationReceivedAtMs;
  const overallDeadline =
    limits.overallDeadlineAtMs ??
    options.overallDeadlineAtMs ??
    options.watchResult.observations.startedAtMs + 930_000;
  const validationDeadlineAtMs = Math.min(notifTime + limits.validationWindowMs, overallDeadline);

  const nowMs = clock();
  if (nowMs >= validationDeadlineAtMs) {
    return {
      ok: false,
      outcome: "VALIDATION_DEADLINE_EXPIRED",
      reason:
        "Validation deadline expired after watch cleanup settled before HTTP dispatch could begin",
      target: null,
      discovery,
      httpAttempts: 0,
      exchanges: [],
      validationDeadlineAtMs,
      completedAtMs: nowMs,
      disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
    };
  }

  // 3. Setup bounded PaperRequestSession
  const remainingLifetimeMs = Math.max(1, validationDeadlineAtMs - nowMs);
  const sessionLimits: PaperRequestSessionLimits = {
    lifetimeMs: remainingLifetimeMs,
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
      RUGCHECK: {
        maxAttempts: 0,
        pacingMs: 5_000,
        maxResponseBytes: 1_048_576,
      },
      SOLANA_TRACKER: {
        maxAttempts: 0,
        pacingMs: 5_000,
        maxResponseBytes: 1_048_576,
      },
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
      const rec = precheckExchangeFromEvidence(e);
      recordedExchanges.push(rec);
      options.onExchangeComplete?.(e);
    },
  });

  session.open();

  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      session.stop("CALLER_CANCELLED");
    } else {
      options.abortSignal.addEventListener("abort", () => session.stop("CALLER_CANCELLED"), {
        once: true,
      });
    }
  }

  // 4. Request 1: PRECHECK_TRANSACTION
  const txRpcId = session.nextJsonRpcId();
  const txDispatchResult = await session.dispatch({
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
  });

  const sessionStatusAfterTx = session.getStatus();
  if (!txDispatchResult.dispatched) {
    const stopReason = sessionStatusAfterTx.stopReason;
    const errorMsg = txDispatchResult.error ?? stopReason ?? "NOT_DISPATCHED";
    const isCancelled =
      options.abortSignal?.aborted ||
      stopReason === "CALLER_CANCELLED" ||
      errorMsg === "CALLER_CANCELLED";
    const outcome: WatchCandidateOutcome = isCancelled
      ? "OPERATOR_CANCELLED"
      : errorMsg === "REQUEST_SESSION_STOPPED"
        ? "SESSION_STOPPED"
        : "TRANSACTION_REQUEST_FAILED";
    return {
      ok: false,
      outcome,
      reason: isCancelled ? "OPERATOR_CANCELLED" : errorMsg,
      target: null,
      discovery,
      httpAttempts: sessionStatusAfterTx.httpAttempts,
      exchanges: [...recordedExchanges],
      validationDeadlineAtMs,
      completedAtMs: clock(),
      disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
    };
  }

  const txExchange = recordedExchanges.find((e) => e.purpose === "PRECHECK_TRANSACTION");
  if (!txExchange) {
    return {
      ok: false,
      outcome: "TRANSACTION_EVIDENCE_UNAVAILABLE",
      reason: "Transaction exchange record missing after dispatch",
      target: null,
      discovery,
      httpAttempts: sessionStatusAfterTx.httpAttempts,
      exchanges: [...recordedExchanges],
      validationDeadlineAtMs,
      completedAtMs: clock(),
      disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
    };
  }

  // Evaluate transaction initialization before deciding whether to send Request 2
  const txEval = evaluateInitializationExchange(txExchange, {
    signature: discovery.signature,
    slot: discovery.slot,
  });

  if (!txEval.ok) {
    // Transaction did not qualify: halt immediately with exactly 1 HTTP send. Zero DexScreener calls.
    return {
      ok: false,
      outcome: mapTxStatusToOutcome(txEval.status),
      reason: txEval.status,
      target: null,
      discovery,
      httpAttempts: sessionStatusAfterTx.httpAttempts,
      exchanges: [...recordedExchanges],
      validationDeadlineAtMs,
      completedAtMs: clock(),
      disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
    };
  }

  const init = txEval.init;

  // 5. Request 2: PRECHECK_MARKET (only reached when transaction is a valid AMM v4 initialization)
  const marketUrl = SINGLE_CANDIDATE_PUBLIC_ENDPOINTS.marketUrlFor(init.mintAddress);
  const marketDispatchResult = await session.dispatch({
    lane: "DEXSCREENER",
    owner: "SPOT",
    purpose: "PRECHECK_MARKET",
    requestedIdentity: init.mintAddress,
    url: marketUrl,
    method: "GET",
    headers: { Accept: "application/json" },
    waitSignals: options.abortSignal ? [options.abortSignal] : undefined,
  });

  const sessionStatusAfterMarket = session.getStatus();
  if (!marketDispatchResult.dispatched) {
    const stopReason = sessionStatusAfterMarket.stopReason;
    const errorMsg = marketDispatchResult.error ?? stopReason ?? "NOT_DISPATCHED";
    const isCancelled =
      options.abortSignal?.aborted ||
      stopReason === "CALLER_CANCELLED" ||
      errorMsg === "CALLER_CANCELLED";
    const outcome: WatchCandidateOutcome = isCancelled
      ? "OPERATOR_CANCELLED"
      : errorMsg === "REQUEST_SESSION_STOPPED"
        ? "SESSION_STOPPED"
        : "MARKET_REQUEST_FAILED";
    return {
      ok: false,
      outcome,
      reason: isCancelled ? "OPERATOR_CANCELLED" : errorMsg,
      target: null,
      discovery,
      httpAttempts: sessionStatusAfterMarket.httpAttempts,
      exchanges: [...recordedExchanges],
      validationDeadlineAtMs,
      completedAtMs: clock(),
      disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
    };
  }

  // 6. Delegate to pure evaluation function
  const evaluation = evaluateWatchCandidateEvidence(discovery, recordedExchanges);

  return {
    ok: evaluation.ok,
    outcome: evaluation.outcome,
    reason: evaluation.reason,
    target: evaluation.target,
    discovery,
    httpAttempts: sessionStatusAfterMarket.httpAttempts,
    exchanges: [...recordedExchanges],
    validationDeadlineAtMs,
    completedAtMs: clock(),
    disclaimer: PROVISIONAL_TARGET_DISCLAIMER,
  };
}
