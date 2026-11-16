#!/usr/bin/env node
/**
 * NeXusTrade — retrospective metadata check for the bounded AMM v4 creation watch 02.
 *
 * One proposed HTTP `getSignaturesForAddress` request for the reviewed AMM v4 creation-fee
 * destination (`limit: 20`, `commitment: confirmed`), bound to the sealed watch run
 * `fresh-amm-v4-watch-02` (manifest SHA-256 and exact recorded interval). Nothing else: no
 * `getTransaction`, WebSocket, pagination, retry, redirect, fallback, discovery or strategy
 * decision.
 *
 * Bounds (fixed): one request through the reviewed `PaperRequestSession`; one 10,000 ms
 * acquisition deadline (session lifetime) and a 10,000 ms request timeout; a 64 KiB decoded
 * response limit; no redirects (refused by the session) and no retries; the session's own bounded
 * cleanup when it stops. Local sealing and verification run afterwards and are overhead outside
 * those bounds.
 *
 * What it reports is an observation about the one returned page only. Block time is a
 * second-granular, validator-estimated block timestamp, not the watch's notification arrival time;
 * the seconds containing the interval endpoints are boundary-ambiguous, and null block times are
 * reported as such. No result proves complete historical coverage, a successful pool creation,
 * faithful streaming or a provider fault.
 *
 * Importing this module performs no I/O. Help and the default dry run load no configuration, read
 * no evidence, send nothing and write nothing; `--verify` reads a sealed check offline. The request
 * needs the explicit `--live` flag and remains AWAITING SEPARATE OPERATOR APPROVAL.
 *
 * Exit codes: 0 help, dry run, or a sealed (or verified) check with a valid, reproducible page and
 * no cancellation; 1 invalid input, configuration, output location or watch binding (nothing sent
 * or written), or an unexpected error; 3 sealed or verified with integrity but without a valid
 * page; 4 integrity failure; 5 sealing failed.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { parseArgs } from "node:util";
import {
  PaperRequestSession,
  type PaperRequestExchangeEvidence,
  type PaperRequestSessionLimits,
  type PaperRequestSessionTimers,
} from "../candidate-scanner/PaperRequestSession.js";
import { isValidSolanaSignature } from "../candidate-scanner/ExactPoolHistoryEnumerator.js";
import { redactSensitiveText } from "../candidate-scanner/SolanaTrackerBundlerCaptureTool.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import { loadDaemonEnvironment } from "./paper-trading-daemon.js";
import {
  PRECHECK_APPROVAL_STATUS,
  RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION,
  RPC_URL_PLACEHOLDER,
} from "./fresh-amm-v4-precheck.js";
import {
  SOLANA_ENDPOINT_ERRORS,
  resolveSolanaEndpoints,
} from "./paper-single-candidate-diagnostic.js";
import {
  credentialSecrets,
  decodeStrictUtf8,
  redactCredentialBytes,
} from "./solana-subscription-capability.js";
import { verifyWatchEvidence } from "./fresh-amm-v4-watch-evidence.js";

// ---------------------------------------------------------------------------------------------
// Fixed binding, request and limits
// ---------------------------------------------------------------------------------------------

/** The sealed watch run this check is bound to (reviewed; not configurable). */
export const RETROSPECTIVE_BINDING = Object.freeze({
  watchRun: "data/research/prechecks/fresh-amm-v4-watch-02",
  manifestSha256: "9da4be7556cdcbd4db653f0483c8c28a425b5d1aff49f8cac06e178ddb827c99",
  intervalStartMs: 1_794_829_420_030,
  intervalEndMs: 1_794_830_320_054,
  address: "7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5",
});

export const RETROSPECTIVE_LIMITS = Object.freeze({
  httpRequests: 1,
  getTransactionCalls: 0,
  webSockets: 0,
  pagination: 0,
  retries: 0,
  redirects: 0,
  pageLimit: 20,
  commitment: "confirmed",
  acquisitionDeadlineMs: 10_000,
  requestTimeoutMs: 10_000,
  maxResponseBytes: 65_536,
});

export const RETROSPECTIVE_ROOT_SEGMENTS = ["data", "research", "retrospective-checks"] as const;
export const RETROSPECTIVE_MANIFEST_KIND = "PAPER_AMM_V4_WATCH_RETROSPECTIVE_MANIFEST" as const;
export const RETROSPECTIVE_KIND = "PAPER_AMM_V4_WATCH_RETROSPECTIVE" as const;
export const RETROSPECTIVE_VERSION = 1 as const;
export const RETROSPECTIVE_FILES = Object.freeze({
  plan: "plan.json",
  retrospective: "retrospective.json",
  manifest: "evidence-manifest.json",
});
export const RETROSPECTIVE_RPC_METHOD = "getSignaturesForAddress" as const;
export const RETROSPECTIVE_RPC_PARAMS = Object.freeze([
  RETROSPECTIVE_BINDING.address,
  Object.freeze({
    limit: RETROSPECTIVE_LIMITS.pageLimit,
    commitment: RETROSPECTIVE_LIMITS.commitment,
  }),
]);

/** Statements every result carries; nothing in a result may contradict them. */
export const RETROSPECTIVE_LIMITATIONS = Object.freeze([
  "Observation about this one returned page only (newest-first, at most 20 records); not a time-filtered or complete history.",
  "blockTime is a second-granular, validator-estimated block timestamp; it is not the watch's notification arrival time.",
  "The seconds containing the interval start and end are boundary-ambiguous; null block times cannot be placed.",
  "No result proves complete historical coverage, a successful pool creation, faithful streaming or a provider fault.",
  "Address activity, including failed transactions, is not evidence of an AMM v4 initialize2 instruction.",
]);

const startSec = Math.floor(RETROSPECTIVE_BINDING.intervalStartMs / 1000);
const endSec = Math.floor(RETROSPECTIVE_BINDING.intervalEndMs / 1000);

// ---------------------------------------------------------------------------------------------
// Pure page analysis (shared by acquisition and offline verification)
// ---------------------------------------------------------------------------------------------

export type TimeClass =
  | "BEFORE_INTERVAL"
  | "BOUNDARY_START"
  | "INSIDE_INTERVAL"
  | "BOUNDARY_END"
  | "AFTER_INTERVAL"
  | "UNKNOWN_TIME";

export type PageCoverage =
  | "EMPTY_PAGE"
  | "COVERAGE_UNKNOWN"
  | "PAGE_NEWER_THAN_INTERVAL"
  | "PAGE_PARTIALLY_OVERLAPS_INTERVAL"
  | "PAGE_SPANS_INTERVAL"
  | "PAGE_OLDER_THAN_INTERVAL";

export type PageObservation =
  | "INTERVAL_RECORDS_IN_PAGE"
  | "BOUNDARY_RECORDS_ONLY"
  | "NO_INTERVAL_RECORDS_IN_PAGE"
  | "COVERAGE_INCONCLUSIVE";

export interface PageRecord {
  readonly position: number;
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly failed: boolean;
  readonly err: unknown;
  readonly confirmationStatus: "confirmed" | "finalized";
  readonly memoPresent: boolean;
  readonly timeClass: TimeClass;
}

export interface PageAnalysis {
  readonly records: readonly PageRecord[];
  readonly counts: {
    readonly returned: number;
    readonly beforeInterval: number;
    readonly boundaryStart: number;
    readonly insideInterval: number;
    readonly boundaryEnd: number;
    readonly afterInterval: number;
    readonly unknownTime: number;
    readonly failedTotal: number;
    readonly failedInsideOrBoundary: number;
  };
  readonly fullPage: boolean;
  readonly newestKnownBlockTime: number | null;
  readonly oldestKnownBlockTime: number | null;
  readonly newestSlot: number | null;
  readonly oldestSlot: number | null;
  readonly blockTimeOrderAnomaly: boolean;
  readonly coverage: PageCoverage;
  readonly observation: PageObservation;
  readonly observationReasons: readonly string[];
}

export type ResponseAnalysis =
  | { readonly kind: "PAGE"; readonly page: PageAnalysis }
  | { readonly kind: "RPC_ERROR"; readonly code: number; readonly message: string }
  | { readonly kind: "MALFORMED"; readonly reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isSafeCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const RECORD_KEYS = "blockTime,confirmationStatus,err,memo,signature,slot";

export function timeClassOf(blockTime: number | null): TimeClass {
  if (blockTime === null) return "UNKNOWN_TIME";
  if (blockTime < startSec) return "BEFORE_INTERVAL";
  if (blockTime === startSec) return "BOUNDARY_START";
  if (blockTime < endSec) return "INSIDE_INTERVAL";
  if (blockTime === endSec) return "BOUNDARY_END";
  return "AFTER_INTERVAL";
}

/**
 * Strict analysis of the response body bytes: strict UTF-8, a JSON-RPC 2.0 envelope echoing the
 * request id, either exactly {jsonrpc, id, result} or {jsonrpc, id, error:{code, message[, data]}},
 * at most 20 records, each exactly {signature, slot, err, memo, blockTime, confirmationStatus} with
 * a canonical signature, a safe slot, a nullable safe block time and a confirmed or finalized
 * status; no duplicate signature; slots newest first.
 */
export function analyzeSignaturesResponse(body: Uint8Array, requestId: number): ResponseAnalysis {
  const malformed = (reason: string): ResponseAnalysis => ({ kind: "MALFORMED", reason });
  const text = decodeStrictUtf8(body);
  if (text === null) return malformed("INVALID_UTF8");
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return malformed("NOT_JSON");
  }
  if (!isRecord(m)) return malformed("NOT_AN_OBJECT");
  if (m.jsonrpc !== "2.0") return malformed("NOT_JSON_RPC_2_0");
  if (m.id !== requestId) return malformed("RESPONSE_ID_MISMATCH");
  const keys = Object.keys(m).sort().join(",");
  if (keys === "error,id,jsonrpc") {
    const e = m.error;
    if (
      !isRecord(e) ||
      !Number.isSafeInteger(e.code) ||
      typeof e.message !== "string" ||
      Object.keys(e).some((k) => k !== "code" && k !== "message" && k !== "data")
    ) {
      return malformed("ERROR_INVALID");
    }
    return { kind: "RPC_ERROR", code: e.code as number, message: e.message };
  }
  if (keys !== "id,jsonrpc,result") return malformed("RESPONSE_SHAPE_INVALID");
  if (!Array.isArray(m.result)) return malformed("RESULT_NOT_AN_ARRAY");
  if (m.result.length > RETROSPECTIVE_LIMITS.pageLimit) return malformed("TOO_MANY_RECORDS");
  const seen = new Set<string>();
  const records: PageRecord[] = [];
  let previousSlot: number | null = null;
  for (const [i, raw] of (m.result as unknown[]).entries()) {
    if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== RECORD_KEYS) {
      return malformed(`RECORD_SHAPE_INVALID:${i}`);
    }
    if (!isValidSolanaSignature(raw.signature)) return malformed(`SIGNATURE_INVALID:${i}`);
    if (!isSafeCount(raw.slot)) return malformed(`SLOT_INVALID:${i}`);
    if (raw.blockTime !== null && !isSafeCount(raw.blockTime))
      return malformed(`BLOCK_TIME_INVALID:${i}`);
    if (raw.confirmationStatus !== "confirmed" && raw.confirmationStatus !== "finalized") {
      return malformed(`CONFIRMATION_STATUS_INVALID:${i}`);
    }
    if (!(raw.err === null || typeof raw.err === "string" || isRecord(raw.err))) {
      return malformed(`ERR_INVALID:${i}`);
    }
    if (!(raw.memo === null || typeof raw.memo === "string")) return malformed(`MEMO_INVALID:${i}`);
    if (seen.has(raw.signature)) return malformed(`DUPLICATE_SIGNATURE:${i}`);
    seen.add(raw.signature);
    if (previousSlot !== null && raw.slot > previousSlot) return malformed(`NOT_NEWEST_FIRST:${i}`);
    previousSlot = raw.slot;
    const blockTime = raw.blockTime as number | null;
    records.push({
      position: i,
      signature: raw.signature,
      slot: raw.slot,
      blockTime,
      failed: raw.err !== null,
      err: raw.err,
      confirmationStatus: raw.confirmationStatus,
      memoPresent: raw.memo !== null,
      timeClass: timeClassOf(blockTime),
    });
  }
  return { kind: "PAGE", page: analyzePage(records) };
}

function analyzePage(records: readonly PageRecord[]): PageAnalysis {
  const count = (c: TimeClass) => records.filter((r) => r.timeClass === c).length;
  const known = records.map((r) => r.blockTime).filter((t): t is number => t !== null);
  const newestKnownBlockTime = known.length > 0 ? Math.max(...known) : null;
  const oldestKnownBlockTime = known.length > 0 ? Math.min(...known) : null;
  let blockTimeOrderAnomaly = false;
  for (let i = 1; i < known.length; i++)
    if ((known[i] as number) > (known[i - 1] as number)) blockTimeOrderAnomaly = true;
  const counts = {
    returned: records.length,
    beforeInterval: count("BEFORE_INTERVAL"),
    boundaryStart: count("BOUNDARY_START"),
    insideInterval: count("INSIDE_INTERVAL"),
    boundaryEnd: count("BOUNDARY_END"),
    afterInterval: count("AFTER_INTERVAL"),
    unknownTime: count("UNKNOWN_TIME"),
    failedTotal: records.filter((r) => r.failed).length,
    failedInsideOrBoundary: records.filter(
      (r) =>
        r.failed &&
        (r.timeClass === "INSIDE_INTERVAL" ||
          r.timeClass === "BOUNDARY_START" ||
          r.timeClass === "BOUNDARY_END"),
    ).length,
  };
  const coverage: PageCoverage =
    records.length === 0
      ? "EMPTY_PAGE"
      : oldestKnownBlockTime === null || newestKnownBlockTime === null
        ? "COVERAGE_UNKNOWN"
        : oldestKnownBlockTime > endSec
          ? "PAGE_NEWER_THAN_INTERVAL"
          : newestKnownBlockTime < startSec
            ? "PAGE_OLDER_THAN_INTERVAL"
            : oldestKnownBlockTime < startSec
              ? "PAGE_SPANS_INTERVAL"
              : "PAGE_PARTIALLY_OVERLAPS_INTERVAL";
  const reasons: string[] = [];
  let observation: PageObservation;
  if (counts.insideInterval > 0) {
    observation = "INTERVAL_RECORDS_IN_PAGE";
  } else if (counts.boundaryStart + counts.boundaryEnd > 0) {
    observation = "BOUNDARY_RECORDS_ONLY";
    reasons.push("BOUNDARY_AMBIGUOUS");
  } else if (counts.unknownTime > 0) {
    observation = "COVERAGE_INCONCLUSIVE";
    reasons.push("NULL_BLOCK_TIME");
  } else if (coverage === "PAGE_SPANS_INTERVAL" || coverage === "PAGE_OLDER_THAN_INTERVAL") {
    observation = "NO_INTERVAL_RECORDS_IN_PAGE";
  } else {
    observation = "COVERAGE_INCONCLUSIVE";
    reasons.push(coverage);
  }
  if (counts.unknownTime > 0 && !reasons.includes("NULL_BLOCK_TIME"))
    reasons.push("NULL_BLOCK_TIME");
  if (blockTimeOrderAnomaly) reasons.push("BLOCK_TIME_ORDER_ANOMALY");
  if (counts.failedInsideOrBoundary > 0) reasons.push("FAILED_TRANSACTION_METADATA");
  return {
    records,
    counts,
    fullPage: records.length === RETROSPECTIVE_LIMITS.pageLimit,
    newestKnownBlockTime,
    oldestKnownBlockTime,
    newestSlot: records.length > 0 ? (records[0] as PageRecord).slot : null,
    oldestSlot: records.length > 0 ? (records[records.length - 1] as PageRecord).slot : null,
    blockTimeOrderAnomaly,
    coverage,
    observation,
    observationReasons: reasons,
  };
}

// ---------------------------------------------------------------------------------------------
// Watch binding (offline; before any configuration or request)
// ---------------------------------------------------------------------------------------------

export interface WatchBinding {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly manifestSha256: string | null;
  readonly intervalStartMs: number | null;
  readonly intervalEndMs: number | null;
}

/**
 * Binds the check to the sealed watch run: the reviewed watch verifier must report integrity and
 * the pinned manifest digest, and the recorded watch interval must equal the pinned one.
 */
export function bindWatchRun(projectRoot: string): WatchBinding {
  const dir = path.join(projectRoot, ...RETROSPECTIVE_BINDING.watchRun.split("/"));
  const problems: string[] = [];
  if (RETROSPECTIVE_BINDING.address !== RAYDIUM_AMM_V4_CREATE_POOL_FEE_DESTINATION) {
    problems.push("ADDRESS_NOT_REVIEWED_FEE_DESTINATION");
  }
  const v = verifyWatchEvidence(dir);
  if (!v.integrity.ok) problems.push("WATCH_EVIDENCE_INTEGRITY_FAILED");
  if (v.manifestSha256 !== RETROSPECTIVE_BINDING.manifestSha256)
    problems.push("WATCH_MANIFEST_MISMATCH");
  let start: number | null = null;
  let end: number | null = null;
  try {
    const w = JSON.parse(readFileSync(path.join(dir, "watch-observations.json"), "utf8")) as {
      watchResult?: { observations?: { startedAtMs?: unknown; endedAtMs?: unknown } };
    };
    const o = w.watchResult?.observations;
    start = isSafeCount(o?.startedAtMs) ? o.startedAtMs : null;
    end = isSafeCount(o?.endedAtMs) ? o.endedAtMs : null;
  } catch {
    problems.push("WATCH_OBSERVATIONS_UNREADABLE");
  }
  if (
    start !== RETROSPECTIVE_BINDING.intervalStartMs ||
    end !== RETROSPECTIVE_BINDING.intervalEndMs
  ) {
    problems.push("WATCH_INTERVAL_MISMATCH");
  }
  return {
    ok: problems.length === 0,
    problems,
    manifestSha256: v.manifestSha256,
    intervalStartMs: start,
    intervalEndMs: end,
  };
}

// ---------------------------------------------------------------------------------------------
// Acquisition (one bounded request; injected fetch, clock, timers and cancellation)
// ---------------------------------------------------------------------------------------------

export type RetrospectiveOutcome =
  | "PAGE_RECEIVED"
  | "RPC_ERROR"
  | "MALFORMED_RESPONSE"
  | "HTTP_ERROR"
  | "RESPONSE_LIMIT_EXCEEDED"
  | "DEADLINE_EXPIRED"
  | "TRANSPORT_ERROR"
  | "SESSION_STOPPED"
  | "OPERATOR_CANCELLED"
  | "NOT_DISPATCHED";

export interface RetrospectiveAcquisition {
  readonly outcome: RetrospectiveOutcome;
  readonly detail: string | null;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly endedAtMs: number;
  readonly requestId: number | null;
  readonly exchange: PaperRequestExchangeEvidence | null;
  readonly sessionStopReason: string | null;
  readonly analysis: ResponseAnalysis | null;
  readonly cancelled: boolean;
  readonly cancellationPhase: "DURING_REQUEST" | "BEFORE_SEALING" | null;
}

/** Outcome of a recorded exchange (shared by acquisition and verification). */
function outcomeOf(
  error: string | null,
  httpStatus: number | null,
  bodyState: string,
  stopReason: string | null,
  cancelled: boolean,
  analysis: ResponseAnalysis | null,
): RetrospectiveOutcome {
  if (cancelled && error !== null) return "OPERATOR_CANCELLED";
  if (error === "RESPONSE_TOO_LARGE") return "RESPONSE_LIMIT_EXCEEDED";
  if (error === "REQUEST_TIMED_OUT" || (error !== null && stopReason === "LIFETIME_EXPIRED")) {
    return "DEADLINE_EXPIRED";
  }
  if (error === "HTTP_429_RECEIVED" || error === "HTTP_REDIRECT_REJECTED") return "SESSION_STOPPED";
  if (error !== null) return error === "NETWORK_ERROR" ? "TRANSPORT_ERROR" : "SESSION_STOPPED";
  if (httpStatus !== 200) return "HTTP_ERROR";
  if (bodyState !== "COMPLETE" || analysis === null) return "MALFORMED_RESPONSE";
  return analysis.kind === "PAGE"
    ? "PAGE_RECEIVED"
    : analysis.kind === "RPC_ERROR"
      ? "RPC_ERROR"
      : "MALFORMED_RESPONSE";
}

export async function runRetrospectiveRequest(o: {
  readonly rpcUrl: string;
  readonly fetchFn: typeof fetch;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}): Promise<RetrospectiveAcquisition> {
  const clock = o.clock ?? (() => Date.now());
  const L = RETROSPECTIVE_LIMITS;
  const startedAtMs = clock();
  const deadlineAtMs = startedAtMs + L.acquisitionDeadlineMs;
  const base = { startedAtMs, deadlineAtMs };
  if (o.abortSignal?.aborted) {
    return {
      ...base,
      outcome: "OPERATOR_CANCELLED",
      detail: "Operator cancellation before dispatch",
      endedAtMs: clock(),
      requestId: null,
      exchange: null,
      sessionStopReason: null,
      analysis: null,
      cancelled: true,
      cancellationPhase: "DURING_REQUEST",
    };
  }
  const limits: PaperRequestSessionLimits = {
    lifetimeMs: L.acquisitionDeadlineMs,
    maxHttpAttempts: L.httpRequests,
    requestTimeoutMs: L.requestTimeoutMs,
    lanes: {
      SOLANA_RPC: { maxAttempts: 1, pacingMs: 2_500, maxResponseBytes: L.maxResponseBytes },
      DEXSCREENER: { maxAttempts: 0, pacingMs: 1_000, maxResponseBytes: 1_048_576 },
      RUGCHECK: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 1_048_576 },
      SOLANA_TRACKER: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 1_048_576 },
    },
  };
  let exchange: PaperRequestExchangeEvidence | null = null;
  const session = new PaperRequestSession({
    executionContext: "PAPER_SIMULATION",
    fetchFn: o.fetchFn,
    limits,
    clock: o.clock,
    timers: o.timers,
    onExchangeComplete: (e) => {
      exchange = e;
    },
  });
  let cancelled = false;
  const onAbort = () => {
    cancelled = true;
    session.stop("CALLER_CANCELLED");
  };
  o.abortSignal?.addEventListener("abort", onAbort, { once: true });
  session.open();
  const requestId = session.nextJsonRpcId();
  try {
    const r = await session.dispatch({
      lane: "SOLANA_RPC",
      owner: "SECURITY",
      purpose: "RETROSPECTIVE_SIGNATURES",
      requestedIdentity: RETROSPECTIVE_BINDING.address,
      url: o.rpcUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: RETROSPECTIVE_RPC_METHOD,
        params: RETROSPECTIVE_RPC_PARAMS,
      }),
      jsonRpcId: requestId,
      waitSignals: o.abortSignal ? [o.abortSignal] : undefined,
    });
    void r;
  } finally {
    o.abortSignal?.removeEventListener("abort", onAbort);
    session.stop("RETROSPECTIVE_FINISHED");
  }
  const e = exchange as PaperRequestExchangeEvidence | null;
  const stopReason = session.getStatus().stopReason;
  const recordedStop = stopReason === "RETROSPECTIVE_FINISHED" ? null : stopReason;
  if (e === null) {
    return {
      ...base,
      outcome: cancelled ? "OPERATOR_CANCELLED" : "NOT_DISPATCHED",
      detail: recordedStop,
      endedAtMs: clock(),
      requestId,
      exchange: null,
      sessionStopReason: recordedStop,
      analysis: null,
      cancelled,
      cancellationPhase: cancelled ? "DURING_REQUEST" : null,
    };
  }
  const analysis =
    e.entry.error === null &&
    e.entry.httpStatus === 200 &&
    e.bodyState === "COMPLETE" &&
    e.body !== null
      ? analyzeSignaturesResponse(e.body, requestId)
      : null;
  const cancelledDuring = cancelled && e.entry.error !== null;
  const outcome = outcomeOf(
    e.entry.error,
    e.entry.httpStatus,
    e.bodyState,
    recordedStop,
    cancelledDuring,
    analysis,
  );
  return {
    ...base,
    outcome,
    detail:
      analysis?.kind === "MALFORMED"
        ? analysis.reason
        : analysis?.kind === "RPC_ERROR"
          ? `JSON-RPC error ${analysis.code}`
          : e.entry.error,
    endedAtMs: clock(),
    requestId,
    exchange: e,
    sessionStopReason: recordedStop,
    analysis,
    cancelled,
    cancellationPhase: cancelled ? "DURING_REQUEST" : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Sealing (exclusive create; reviewed byte-level and text redaction)
// ---------------------------------------------------------------------------------------------

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

export type RetrospectiveFileWriter = (
  file: string,
  content: string,
  options: { readonly encoding: "utf8"; readonly flag: "wx" },
) => void;

export type SealRetrospectiveResult =
  | { readonly ok: true; readonly manifestSha256: string }
  | {
      readonly ok: false;
      readonly status: "OUTPUT_DIRECTORY_UNAVAILABLE" | "SEAL_REFUSED" | "ARTIFACT_WRITE_FAILED";
      readonly reason: string;
    };

/** The sealed record: what was requested, what came back, and what this page shows. */
export function retrospectiveRecord(
  a: RetrospectiveAcquisition,
  binding: WatchBinding,
  secrets: readonly string[],
): Record<string, unknown> {
  const redact = (t: string) => redactSensitiveText(t, secrets);
  const e = a.exchange;
  let response: Record<string, unknown> | null = null;
  if (e !== null) {
    const original = e.body;
    let stored: Buffer | null = null;
    let text: string | null = null;
    if (original !== null) {
      stored = redactCredentialBytes(original, secrets);
      text = decodeStrictUtf8(stored);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.responseHeaders)) headers[k] = redact(v);
    response = {
      httpStatus: e.entry.httpStatus,
      headers,
      bodyState: e.bodyState,
      observedBytes: e.observedBodyBytes,
      maxResponseBytes: e.maxResponseBytes,
      originalBytes: original?.length ?? null,
      originalSha256: original === null ? null : sha256(original),
      storedEncoding: stored === null ? null : text === null ? "base64" : "utf8",
      storedBytes: stored?.length ?? null,
      storedSha256: stored === null ? null : sha256(stored),
      payload: stored === null ? null : (text ?? stored.toString("base64")),
      payloadRedacted: stored !== null && original !== null && !stored.equals(original),
    };
  }
  const analysis = a.analysis;
  return {
    kind: RETROSPECTIVE_KIND,
    version: RETROSPECTIVE_VERSION,
    binding: RETROSPECTIVE_BINDING,
    bindingCheck: binding,
    limits: RETROSPECTIVE_LIMITS,
    limitations: RETROSPECTIVE_LIMITATIONS,
    request: {
      method: "POST",
      url: RPC_URL_PLACEHOLDER,
      rpcMethod: RETROSPECTIVE_RPC_METHOD,
      rpcParams: RETROSPECTIVE_RPC_PARAMS,
      jsonRpcId: a.requestId,
      dispatchedAtMs: e?.entry.dispatchedAtMs ?? null,
      completedAtMs: e?.entry.completedAtMs ?? null,
      error: e?.entry.error ?? null,
    },
    response,
    outcome: a.outcome,
    detail: a.detail === null ? null : redact(a.detail),
    sessionStopReason: a.sessionStopReason,
    startedAtMs: a.startedAtMs,
    deadlineAtMs: a.deadlineAtMs,
    endedAtMs: a.endedAtMs,
    cancelled: a.cancelled,
    cancellationPhase: a.cancellationPhase,
    rpcError:
      analysis?.kind === "RPC_ERROR"
        ? { code: analysis.code, message: redact(analysis.message) }
        : null,
    page: analysis?.kind === "PAGE" ? analysis.page : null,
    pageObtained: a.outcome === "PAGE_RECEIVED" && !a.cancelled,
  };
}

export function sealRetrospectiveEvidence(input: {
  readonly outDir: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly record: Readonly<Record<string, unknown>>;
  readonly secrets: readonly string[];
  readonly writeFile?: RetrospectiveFileWriter | undefined;
}): SealRetrospectiveResult {
  const redact = (t: string) => redactSensitiveText(t, input.secrets);
  const contents: [string, string][] = [
    [RETROSPECTIVE_FILES.plan, JSON.stringify(input.plan, null, 2) + "\n"],
    [RETROSPECTIVE_FILES.retrospective, JSON.stringify(input.record, null, 2) + "\n"],
  ];
  for (const [name, text] of contents) {
    for (const s of input.secrets) {
      if (s.length >= 4 && text.includes(s)) {
        return {
          ok: false,
          status: "SEAL_REFUSED",
          reason: `a credential would be persisted in ${name}`,
        };
      }
    }
  }
  const response = input.record.response;
  if (
    isRecord(response) &&
    typeof response.payload === "string" &&
    response.storedEncoding === "base64"
  ) {
    const bytes = Buffer.from(response.payload, "base64");
    for (const s of input.secrets) {
      if (s.length >= 4 && bytes.includes(Buffer.from(s, "utf8"))) {
        return {
          ok: false,
          status: "SEAL_REFUSED",
          reason: "a credential would be persisted in the stored response",
        };
      }
    }
  }
  try {
    mkdirSync(path.dirname(input.outDir), { recursive: true });
    mkdirSync(input.outDir);
  } catch (err) {
    return {
      ok: false,
      status: "OUTPUT_DIRECTORY_UNAVAILABLE",
      reason: redact(err instanceof Error ? err.message : String(err)),
    };
  }
  const write = input.writeFile ?? ((f, c, opts) => writeFileSync(f, c, opts));
  try {
    const files = contents.map(([name, text]) => {
      write(path.join(input.outDir, name), text, { encoding: "utf8", flag: "wx" });
      return { path: name, sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") };
    });
    const manifest =
      JSON.stringify(
        {
          kind: RETROSPECTIVE_MANIFEST_KIND,
          version: RETROSPECTIVE_VERSION,
          outcome: input.record.outcome,
          pageObtained: input.record.pageObtained,
          files,
        },
        null,
        2,
      ) + "\n";
    write(path.join(input.outDir, RETROSPECTIVE_FILES.manifest), manifest, {
      encoding: "utf8",
      flag: "wx",
    });
    return { ok: true, manifestSha256: sha256(manifest) };
  } catch (err) {
    return {
      ok: false,
      status: "ARTIFACT_WRITE_FAILED",
      reason: redact(err instanceof Error ? err.message : String(err)),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Offline verification
// ---------------------------------------------------------------------------------------------

export interface RetrospectiveVerification {
  readonly integrity: { readonly ok: boolean; readonly problems: readonly string[] };
  readonly outcome: RetrospectiveOutcome | null;
  /** A valid page re-derived exactly from the sealed bytes, with no cancellation. */
  readonly pageObtained: boolean;
  readonly observation: PageObservation | null;
  readonly manifestSha256: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const OUTCOMES: readonly string[] = [
  "PAGE_RECEIVED",
  "RPC_ERROR",
  "MALFORMED_RESPONSE",
  "HTTP_ERROR",
  "RESPONSE_LIMIT_EXCEEDED",
  "DEADLINE_EXPIRED",
  "TRANSPORT_ERROR",
  "SESSION_STOPPED",
  "OPERATOR_CANCELLED",
  "NOT_DISPATCHED",
];

export function verifyRetrospectiveEvidence(dir: string): RetrospectiveVerification {
  const problems: string[] = [];
  let manifestSha256: string | null = null;
  const fail = (): RetrospectiveVerification => ({
    integrity: { ok: false, problems: [...problems] },
    outcome: null,
    pageObtained: false,
    observation: null,
    manifestSha256,
  });
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  try {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) problems.push("OUTPUT_DIRECTORY_INVALID");
    } catch {
      problems.push("OUTPUT_DIRECTORY_MISSING");
    }
    if (problems.length > 0) return fail();
    let manifest: unknown;
    try {
      const bytes = readFileSync(path.join(dir, RETROSPECTIVE_FILES.manifest));
      manifestSha256 = sha256(bytes);
      manifest = JSON.parse(bytes.toString("utf8"));
    } catch {
      problems.push("MANIFEST_MISSING_OR_INVALID");
      return fail();
    }
    const expected: readonly string[] = [
      RETROSPECTIVE_FILES.plan,
      RETROSPECTIVE_FILES.retrospective,
    ];
    if (
      !isRecord(manifest) ||
      manifest.kind !== RETROSPECTIVE_MANIFEST_KIND ||
      manifest.version !== RETROSPECTIVE_VERSION ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== expected.length ||
      (manifest.files as unknown[]).some(
        (f, i) =>
          !isRecord(f) ||
          f.path !== expected[i] ||
          typeof f.sha256 !== "string" ||
          !HEX64.test(f.sha256) ||
          !isSafeCount(f.bytes),
      )
    ) {
      problems.push("MANIFEST_INVALID");
      return fail();
    }
    for (const name of readdirSync(dir)) {
      const st = lstatSync(path.join(dir, name));
      if (st.isSymbolicLink() || !st.isFile()) problems.push(`UNEXPECTED_ENTRY:${name}`);
      else if (name !== RETROSPECTIVE_FILES.manifest && !expected.includes(name))
        problems.push(`UNLISTED:${name}`);
    }
    const files = new Map<string, Buffer>();
    for (const f of manifest.files as Record<string, unknown>[]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(path.join(dir, f.path as string));
      } catch {
        problems.push(`MISSING:${String(f.path)}`);
        continue;
      }
      if (sha256(bytes) !== f.sha256 || bytes.length !== f.bytes)
        problems.push(`MODIFIED:${String(f.path)}`);
      else files.set(f.path as string, bytes);
    }
    if (problems.length > 0) return fail();
    let r: unknown;
    try {
      JSON.parse((files.get(RETROSPECTIVE_FILES.plan) as Buffer).toString("utf8"));
      r = JSON.parse((files.get(RETROSPECTIVE_FILES.retrospective) as Buffer).toString("utf8"));
    } catch {
      problems.push("EVIDENCE_NOT_JSON");
      return fail();
    }
    if (!isRecord(r) || r.kind !== RETROSPECTIVE_KIND || r.version !== RETROSPECTIVE_VERSION) {
      problems.push("RECORD_KIND_INVALID");
      return fail();
    }
    // Fixed binding, limits, statements and request.
    if (!same(r.binding, RETROSPECTIVE_BINDING)) problems.push("BINDING_MISMATCH");
    const bc = isRecord(r.bindingCheck) ? r.bindingCheck : null;
    if (
      bc === null ||
      bc.ok !== true ||
      !same(bc.problems, []) ||
      bc.manifestSha256 !== RETROSPECTIVE_BINDING.manifestSha256 ||
      bc.intervalStartMs !== RETROSPECTIVE_BINDING.intervalStartMs ||
      bc.intervalEndMs !== RETROSPECTIVE_BINDING.intervalEndMs
    ) {
      problems.push("BINDING_CHECK_INVALID");
    }
    if (!same(r.limits, RETROSPECTIVE_LIMITS)) problems.push("LIMITS_MISMATCH");
    if (!same(r.limitations, RETROSPECTIVE_LIMITATIONS)) problems.push("LIMITATIONS_MISMATCH");
    const outcome = r.outcome;
    if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) {
      problems.push("OUTCOME_INVALID");
      return fail();
    }
    if (manifest.outcome !== outcome || manifest.pageObtained !== r.pageObtained) {
      problems.push("MANIFEST_SUMMARY_MISMATCH");
    }
    const req = isRecord(r.request) ? r.request : null;
    if (
      req === null ||
      req.method !== "POST" ||
      req.url !== RPC_URL_PLACEHOLDER ||
      req.rpcMethod !== RETROSPECTIVE_RPC_METHOD ||
      !same(req.rpcParams, RETROSPECTIVE_RPC_PARAMS)
    ) {
      problems.push("REQUEST_INVALID");
      return fail();
    }
    // Times.
    const started = r.startedAtMs;
    if (
      !isSafeCount(started) ||
      r.deadlineAtMs !== started + RETROSPECTIVE_LIMITS.acquisitionDeadlineMs ||
      !isSafeCount(r.endedAtMs) ||
      r.endedAtMs < started
    ) {
      problems.push("TIMES_INVALID");
      return fail();
    }
    const cancelled = r.cancelled;
    const phase = r.cancellationPhase;
    if (
      typeof cancelled !== "boolean" ||
      (cancelled ? phase !== "DURING_REQUEST" && phase !== "BEFORE_SEALING" : phase !== null)
    ) {
      problems.push("CANCELLATION_RECORD_INVALID");
    }
    // The response bytes and the outcome they produce.
    const resp = r.response;
    let analysis: ResponseAnalysis | null = null;
    let redacted = false;
    if (resp === null) {
      if (outcome !== "OPERATOR_CANCELLED" && outcome !== "NOT_DISPATCHED")
        problems.push("OUTCOME_NOT_REPRODUCED");
      if (outcome === "OPERATOR_CANCELLED" && cancelled !== true)
        problems.push("OUTCOME_NOT_REPRODUCED");
      if (req.dispatchedAtMs !== null || req.completedAtMs !== null)
        problems.push("REQUEST_TIMES_INVALID");
    } else {
      if (!isRecord(resp)) {
        problems.push("RESPONSE_INVALID");
        return fail();
      }
      if (
        !isSafeCount(req.dispatchedAtMs) ||
        !isSafeCount(req.completedAtMs) ||
        req.dispatchedAtMs < started ||
        req.completedAtMs < req.dispatchedAtMs ||
        req.completedAtMs > (r.endedAtMs as number) ||
        !Number.isSafeInteger(req.jsonRpcId)
      ) {
        problems.push("REQUEST_TIMES_INVALID");
      }
      if (resp.maxResponseBytes !== RETROSPECTIVE_LIMITS.maxResponseBytes)
        problems.push("RESPONSE_LIMIT_MISMATCH");
      let stored: Buffer | null = null;
      if (resp.payload === null) {
        if (
          resp.storedEncoding !== null ||
          resp.storedBytes !== null ||
          resp.storedSha256 !== null ||
          resp.originalBytes !== null ||
          resp.originalSha256 !== null ||
          resp.payloadRedacted !== false
        ) {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
        }
      } else {
        if (typeof resp.payload !== "string") {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
          return fail();
        }
        if (resp.storedEncoding === "utf8") stored = Buffer.from(resp.payload, "utf8");
        else if (resp.storedEncoding === "base64") {
          stored = Buffer.from(resp.payload, "base64");
          if (stored.toString("base64") !== resp.payload || decodeStrictUtf8(stored) !== null) {
            problems.push("RESPONSE_ACCOUNTING_INVALID");
          }
        } else {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
          return fail();
        }
        if (
          resp.storedBytes !== stored.length ||
          resp.storedSha256 !== sha256(stored) ||
          !isSafeCount(resp.originalBytes) ||
          resp.originalBytes > RETROSPECTIVE_LIMITS.maxResponseBytes ||
          typeof resp.originalSha256 !== "string" ||
          !HEX64.test(resp.originalSha256) ||
          typeof resp.payloadRedacted !== "boolean"
        ) {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
        } else if (resp.payloadRedacted === false) {
          if (stored.length !== resp.originalBytes || resp.storedSha256 !== resp.originalSha256) {
            problems.push("RESPONSE_ACCOUNTING_INVALID");
          }
        } else if (resp.storedSha256 === resp.originalSha256) {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
        }
        redacted = resp.payloadRedacted === true;
      }
      const error = req.error === null ? null : String(req.error);
      const httpStatus = resp.httpStatus === null ? null : Number(resp.httpStatus);
      const bodyState = String(resp.bodyState);
      if (
        error === null &&
        httpStatus === 200 &&
        bodyState === "COMPLETE" &&
        stored !== null &&
        !redacted
      ) {
        analysis = analyzeSignaturesResponse(stored, req.jsonRpcId as number);
      }
      const cancelledDuring = cancelled === true && phase === "DURING_REQUEST" && error !== null;
      const reproducible = !(
        error === null &&
        httpStatus === 200 &&
        bodyState === "COMPLETE" &&
        redacted
      );
      if (reproducible) {
        const derived = outcomeOf(
          error,
          httpStatus,
          bodyState,
          r.sessionStopReason === null ? null : String(r.sessionStopReason),
          cancelledDuring,
          analysis,
        );
        if (derived !== outcome) problems.push("OUTCOME_NOT_REPRODUCED");
      }
    }
    // The page and the RPC error must be exactly what the bytes produce.
    const expectedPage = analysis?.kind === "PAGE" ? analysis.page : null;
    if (!redacted && !same(r.page, expectedPage)) problems.push("PAGE_NOT_REPRODUCED");
    if (redacted && r.page !== null && outcome !== "PAGE_RECEIVED")
      problems.push("PAGE_NOT_REPRODUCED");
    if (analysis?.kind === "RPC_ERROR") {
      if (!isRecord(r.rpcError) || r.rpcError.code !== analysis.code)
        problems.push("RPC_ERROR_NOT_REPRODUCED");
    } else if (!redacted && r.rpcError !== null) {
      problems.push("RPC_ERROR_NOT_REPRODUCED");
    }
    const expectedObtained = outcome === "PAGE_RECEIVED" && cancelled === false;
    if (r.pageObtained !== expectedObtained) problems.push("PAGE_OBTAINED_MISMATCH");
    if (problems.length > 0) return fail();
    return {
      integrity: { ok: true, problems: [] },
      outcome: outcome as RetrospectiveOutcome,
      // A redacted page cannot be re-derived exactly, so it is never reported as obtained.
      pageObtained: expectedObtained && !redacted && expectedPage !== null,
      observation: !redacted && expectedPage !== null ? expectedPage.observation : null,
      manifestSha256,
    };
  } catch {
    problems.push("EVIDENCE_RECORD_MALFORMED");
    return fail();
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export const RETROSPECTIVE_EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID: 1,
  NO_PAGE: 3,
  INTEGRITY_FAILED: 4,
  SEAL_FAILED: 5,
});

export const RETROSPECTIVE_USAGE = [
  "Usage: amm-v4-watch-retrospective [--help] | --out-dir <dir> [--live] | --verify <dir>",
  "  --help            Print this usage and the plan (nothing loaded, read, sent or written).",
  "  --out-dir <dir>   A new directory directly inside data/research/retrospective-checks/ (default: dry run).",
  "  --live            One getSignaturesForAddress request (separate approval required).",
  "  --verify <dir>    Verify a sealed check offline (no configuration, no network).",
  "Exit codes: 0 page obtained or informational, 1 invalid input or error, 3 no valid page,",
  "            4 integrity failure, 5 sealing failed.",
].join("\n");

export function buildRetrospectivePlan(outDirRelative: string, mode: "DRY_RUN" | "LIVE") {
  return {
    kind: "PAPER_AMM_V4_WATCH_RETROSPECTIVE_PLAN",
    mode,
    approval: PRECHECK_APPROVAL_STATUS,
    outDir: outDirRelative,
    endpoint: "SOLANA_RPC_URL (configuration; never printed)",
    binding: RETROSPECTIVE_BINDING,
    request: { rpcMethod: RETROSPECTIVE_RPC_METHOD, rpcParams: RETROSPECTIVE_RPC_PARAMS },
    limits: RETROSPECTIVE_LIMITS,
    limitations: RETROSPECTIVE_LIMITATIONS,
    sequence: [
      "Validate the new output directory, then bind to the sealed watch 02 (reviewed verifier, pinned manifest digest and interval) before any configuration",
      "Load SOLANA_RPC_URL and send one getSignaturesForAddress request (10 s deadline, 64 KiB, no redirect, no retry)",
      "Validate the envelope, id and records strictly; classify each record's block time against the interval",
      "Recheck cancellation, then seal into a new directory and verify offline (overhead outside the bounds)",
    ],
  };
}

export interface RetrospectiveDeps {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly loadEnvironment?: (() => void) | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly projectRoot?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** Offline tests only: replaces the watch-02 binding check (the real one reads sealed evidence). */
  readonly bindWatch?: ((projectRoot: string) => WatchBinding) | undefined;
  /** Offline tests only: replaces the exclusive writer (to force a write failure). */
  readonly writeFile?: RetrospectiveFileWriter | undefined;
}

export interface RetrospectiveRunResult {
  readonly mode: "HELP" | "DRY_RUN" | "LIVE" | "VERIFY";
  readonly exitCode: number;
  readonly planDigestSha256?: string | undefined;
  readonly outDir?: string | undefined;
  readonly acquisition?: RetrospectiveAcquisition | undefined;
  readonly record?: Readonly<Record<string, unknown>> | undefined;
  readonly seal?: SealRetrospectiveResult | undefined;
  readonly verification?: RetrospectiveVerification | undefined;
}

const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const cliError = (message: string) => new Error(`[CLI_INVALID_ARG] ${message}`);
const OWN_ERROR_CODES = new Set([
  "CLI_INVALID_ARG",
  "OUTPUT_EXISTS",
  "MISSING_CONFIGURATION",
  "WATCH_BINDING_FAILED",
]);
const errorCode = (err: unknown) =>
  /^\[([A-Z0-9_]+)\]/.exec(err instanceof Error ? err.message : "")?.[1] ?? "UNEXPECTED_ERROR";
/** Errors raised here carry fixed text only; anything else prints its code. */
export const printableRetrospectiveError = (err: unknown): string =>
  OWN_ERROR_CODES.has(errorCode(err)) && err instanceof Error ? err.message : `[${errorCode(err)}]`;

export async function runRetrospectiveCheck(
  rawArgs: readonly string[],
  deps: RetrospectiveDeps = {},
): Promise<RetrospectiveRunResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let values: Record<string, string | boolean | undefined>;
  let tokens: readonly { kind: string; name?: string }[] = [];
  try {
    ({ values, tokens = [] } = parseArgs({
      args: [...rawArgs],
      options: {
        help: { type: "boolean" },
        live: { type: "boolean" },
        "out-dir": { type: "string" },
        verify: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    }));
  } catch (err) {
    throw cliError(err instanceof Error ? err.message : String(err));
  }
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.kind !== "option" || t.name === undefined) continue;
    if (seen.has(t.name)) throw cliError(`--${t.name} may be given only once`);
    seen.add(t.name);
  }
  if (values.help === true) {
    if (seen.size > 1) throw cliError("--help cannot be combined with other options");
    const planJson = JSON.stringify(
      buildRetrospectivePlan(
        "<new directory inside data/research/retrospective-checks/>",
        "DRY_RUN",
      ),
    );
    log(RETROSPECTIVE_USAGE);
    log("[HELP] No configuration loaded, no evidence read, nothing sent or written.");
    log(planJson);
    return {
      mode: "HELP",
      exitCode: RETROSPECTIVE_EXIT_CODES.OK,
      planDigestSha256: sha256(planJson),
    };
  }
  const projectRoot = path.resolve(deps.projectRoot ?? findWorkspaceRoot());
  const root = path.join(projectRoot, ...RETROSPECTIVE_ROOT_SEGMENTS);
  if (values.verify !== undefined) {
    if (values.live === true || values["out-dir"] !== undefined) {
      throw cliError("--verify cannot be combined with --live or --out-dir");
    }
    const dir = path.resolve(projectRoot, String(values.verify));
    if (values.verify === "" || path.dirname(dir) !== root) {
      throw cliError(
        `--verify must name a run directly inside ${RETROSPECTIVE_ROOT_SEGMENTS.join("/")}/`,
      );
    }
    const v = verifyRetrospectiveEvidence(dir);
    log(
      `[VERIFY] Integrity: ${v.integrity.ok ? "OK" : `FAILED (${v.integrity.problems.join(", ")})`}`,
    );
    log(`[VERIFY] Outcome: ${v.outcome ?? "UNKNOWN"}`);
    log(`[VERIFY] Page: ${v.pageObtained ? `OBTAINED (${v.observation})` : "NOT OBTAINED"}`);
    return {
      mode: "VERIFY",
      exitCode: !v.integrity.ok
        ? RETROSPECTIVE_EXIT_CODES.INTEGRITY_FAILED
        : v.pageObtained
          ? RETROSPECTIVE_EXIT_CODES.OK
          : RETROSPECTIVE_EXIT_CODES.NO_PAGE,
      verification: v,
    };
  }
  const rawOut = typeof values["out-dir"] === "string" ? values["out-dir"] : "";
  if (rawOut === "") throw cliError("--out-dir is required (a new directory)");
  const outDir = path.resolve(projectRoot, rawOut);
  if (path.dirname(outDir) !== root || !RUN_NAME.test(path.basename(outDir))) {
    throw cliError(
      `--out-dir must be a new directory directly inside ${RETROSPECTIVE_ROOT_SEGMENTS.join("/")}/ (letters, digits, '.', '_', '-')`,
    );
  }
  const rel = path.relative(projectRoot, outDir).replace(/\\/g, "/");
  if (existsSync(outDir))
    throw new Error(`[OUTPUT_EXISTS] ${rel} already exists; refusing to overwrite`);
  const mode = values.live === true ? "LIVE" : "DRY_RUN";
  const plan = buildRetrospectivePlan(rel, mode);
  const planJson = JSON.stringify(plan);
  const planDigestSha256 = sha256(planJson);
  if (mode === "DRY_RUN") {
    log("[DRY_RUN] No configuration loaded, no evidence read, nothing sent or written.");
    log(`[DRY_RUN] Live execution: ${PRECHECK_APPROVAL_STATUS}`);
    log(`[DRY_RUN] Plan digest (sha256): ${planDigestSha256}`);
    log(planJson);
    return { mode, exitCode: RETROSPECTIVE_EXIT_CODES.OK, planDigestSha256 };
  }

  // Explicit live path. The watch binding is checked first (offline), then configuration.
  const binding = (deps.bindWatch ?? bindWatchRun)(projectRoot);
  if (!binding.ok) {
    throw new Error(
      `[WATCH_BINDING_FAILED] the sealed watch run does not match the pinned binding (${binding.problems.join(", ")})`,
    );
  }
  (deps.loadEnvironment ?? loadDaemonEnvironment)();
  const env = deps.env ?? process.env;
  const endpoints = resolveSolanaEndpoints(env);
  // Only the HTTP endpoint is used; a WebSocket configuration problem does not block this check.
  if (!endpoints.ok && endpoints.error === SOLANA_ENDPOINT_ERRORS.rpc)
    throw new Error(endpoints.error);
  const rpcUrl = env.SOLANA_RPC_URL as string;
  const secrets = credentialSecrets([rpcUrl, env.SOLANA_WS_URL ?? ""].filter((s) => s !== ""));
  const redact = (t: string) => redactSensitiveText(t, secrets);
  log(`[LIVE] ${PRECHECK_APPROVAL_STATUS}`);
  log(`[LIVE] Plan digest (sha256): ${planDigestSha256}`);
  const acquired = await runRetrospectiveRequest({
    rpcUrl,
    fetchFn: deps.fetchFn ?? globalThis.fetch,
    clock: deps.clock,
    timers: deps.timers,
    abortSignal: deps.signal,
  });
  log(
    `[LIVE] Outcome: ${acquired.outcome}${acquired.detail ? ` (${redact(acquired.detail)})` : ""}`,
  );
  // Cancellation is rechecked after the callbacks above, immediately before sealing.
  const acquisition: RetrospectiveAcquisition =
    deps.signal?.aborted === true && !acquired.cancelled
      ? { ...acquired, cancelled: true, cancellationPhase: "BEFORE_SEALING" }
      : acquired;
  const record = retrospectiveRecord(acquisition, binding, secrets);
  const seal = sealRetrospectiveEvidence({
    outDir,
    plan,
    record,
    secrets,
    writeFile: deps.writeFile,
  });
  if (!seal.ok) {
    log(`[LIVE] Sealing FAILED: ${seal.status} (no rerun)`);
    return {
      mode,
      exitCode: RETROSPECTIVE_EXIT_CODES.SEAL_FAILED,
      planDigestSha256,
      outDir: rel,
      acquisition,
      record,
      seal,
    };
  }
  const verification = verifyRetrospectiveEvidence(outDir);
  log(`[LIVE] Evidence sealed: ${rel} (manifest sha256 ${seal.manifestSha256})`);
  log(
    `[LIVE] Integrity: ${verification.integrity.ok ? "OK" : "FAILED"}; page ${verification.pageObtained ? `OBTAINED (${verification.observation})` : "NOT OBTAINED"}`,
  );
  return {
    mode,
    exitCode: !verification.integrity.ok
      ? RETROSPECTIVE_EXIT_CODES.INTEGRITY_FAILED
      : verification.pageObtained
        ? RETROSPECTIVE_EXIT_CODES.OK
        : RETROSPECTIVE_EXIT_CODES.NO_PAGE,
    planDigestSha256,
    outDir: rel,
    acquisition,
    record,
    seal,
    verification,
  };
}

if (process.argv[1] && process.argv[1].endsWith("amm-v4-watch-retrospective.ts")) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  runRetrospectiveCheck(process.argv.slice(2), { signal: controller.signal })
    .then((r) => {
      process.removeListener("SIGINT", onSignal);
      process.exit(r.exitCode);
    })
    .catch((err: unknown) => {
      process.removeListener("SIGINT", onSignal);
      console.error("[AMM_V4_WATCH_RETROSPECTIVE_ERROR]", printableRetrospectiveError(err));
      process.exit(RETROSPECTIVE_EXIT_CODES.INVALID);
    });
}
