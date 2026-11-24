#!/usr/bin/env node
/**
 * Bounded CPMM pool activity-page checker (`getSignaturesForAddress`, limit 20, confirmed commitment).
 *
 * Scope & safety invariants:
 * - One explicit supplied canonical 32-byte pool address (`--pool <address>`). No discovery or
 *   target substitution.
 * - Exactly one `getSignaturesForAddress` HTTP RPC request (`limit: 20`, `commitment: "confirmed"`)
 *   through the reviewed `PaperRequestSession`.
 * - Fixed bounds: 10,000 ms acquisition/request timeout, 65,536-byte (64 KiB) decoded response cap,
 *   zero transaction retrievals (`getTransaction`), zero DexScreener requests, zero WebSockets,
 *   zero pagination, zero retries, zero redirects, and zero automatic observation follow-up.
 * - Imports, `--help`, and default dry run are strictly inert: no configuration or credential is
 *   loaded, no transport is opened, nothing is sent, and nothing is written.
 * - Reports only descriptive metadata for this single page (returned count, succeeded/failed
 *   counts, null timestamps, observed time span, slot grouping, and potentially truncated full-page
 *   flag). Never certifies safe traffic rate, swaps, historical completeness, current pool
 *   identity, or qualification.
 * - `--live` seals redacted/sanitized evidence into a new exclusive-create directory under
 *   `data/research/cpmm-activity-checks/` and verifies integrity offline.
 * - `--verify <dir>` inspects a sealed bundle offline with zero credentials, keeping recorded
 *   outcomes, integrity, and computed observations strictly separate.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isValidSolanaSignature } from "../candidate-scanner/ExactPoolHistoryEnumerator.js";
import { isCanonicalSolanaBase58 } from "../candidate-scanner/LpScreeningBridge.js";
import {
  PaperRequestSession,
  type PaperRequestExchangeEvidence,
  type PaperRequestSessionLimits,
  type PaperRequestSessionTimers,
} from "../candidate-scanner/PaperRequestSession.js";
import { findWorkspaceRoot } from "../paper/CanonicalPaths.js";
import {
  EVIDENCE_SANITIZER_LIMITS,
  deriveEvidenceSecrets,
  sanitizeEvidenceBytes,
  type SanitizedEvidenceBytes,
} from "./evidence-credential-sanitizer.js";

// ---------------------------------------------------------------------------------------------
// Fixed constants, bounds and non-certifications
// ---------------------------------------------------------------------------------------------

export const ACTIVITY_CHECK_ROOT_SEGMENTS = ["data", "research", "cpmm-activity-checks"] as const;
export const ACTIVITY_CHECK_APPROVAL_STATUS =
  "PROPOSED_FOR_REVIEW_LIVE_EXECUTION_NOT_APPROVED" as const;
export const ACTIVITY_CHECK_LIVE_STATUS =
  "NOT_APPROVED: the activity check awaits independent review and separate operator approval" as const;
export const ACTIVITY_CHECK_LIVE_FLAG_MEANING =
  "--live only selects the acquiring mode; it is not, and does not record, operator approval" as const;

export const ACTIVITY_CHECK_LIMITS = Object.freeze({
  httpRequests: 1,
  getTransactionCalls: 0,
  dexScreenerCalls: 0,
  webSockets: 0,
  pagination: 0,
  retries: 0,
  redirects: 0,
  automaticObservation: false,
  pageLimit: 20,
  commitment: "confirmed",
  acquisitionDeadlineMs: 10_000,
  requestTimeoutMs: 10_000,
  maxResponseBytes: 65_536,
});

export type ActivityRecordSchemaVersion = 1;
export const ACTIVITY_CHECK_VERSION: ActivityRecordSchemaVersion = 1;
export const ACTIVITY_CHECK_SUPPORTED_VERSIONS: readonly ActivityRecordSchemaVersion[] =
  Object.freeze([1]);
export const ACTIVITY_CHECK_KIND = "CPMM_POOL_ACTIVITY_CHECK" as const;
export const ACTIVITY_CHECK_MANIFEST_KIND = "CPMM_POOL_ACTIVITY_CHECK_MANIFEST" as const;
export const ACTIVITY_CHECK_PLAN_KIND = "CPMM_POOL_ACTIVITY_CHECK_PLAN" as const;
export const ACTIVITY_CHECK_RPC_METHOD = "getSignaturesForAddress" as const;
export const ACTIVITY_CHECK_RPC_URL_PLACEHOLDER = "SOLANA_RPC_URL (redacted)" as const;
export const ACTIVITY_CHECK_FILES = Object.freeze({
  plan: "plan.json",
  activity: "activity.json",
  manifest: "evidence-manifest.json",
});

export const ACTIVITY_CHECK_REQUIRED_RECORD_FIELDS = Object.freeze([
  "blockTime",
  "confirmationStatus",
  "err",
  "memo",
  "signature",
  "slot",
]);
export const ACTIVITY_CHECK_OPTIONAL_RECORD_FIELDS = Object.freeze(["transactionIndex"]);

export const ACTIVITY_CHECK_NON_CERTIFICATIONS = Object.freeze({
  safeTrafficCertified: false,
  swapsVerified: false,
  historyCompletenessCertified: false,
  currentPoolIdentityVerified: false,
  notificationCompletenessEstablished: false,
  quietWindowEstablished: false,
  qualificationEligible: false,
  replayableCaptureEstablished: false,
  admissionEligible: false,
});

export const ACTIVITY_CHECK_LIMITATIONS = Object.freeze([
  "Observation about this single newest-first getSignaturesForAddress page only (limit 20, confirmed commitment); a full page of 20 records indicates potentially truncated history (older signatures omitted).",
  "Address activity metadata (signatures, slots, blockTime, err) is not evidence of Raydium CPMM swaps, executed amounts, or current pool/vault account identity.",
  "blockTime is a second-granular, validator-estimated block timestamp, not a WebSocket notification arrival time; null blockTime entries cannot be placed chronologically.",
  "Does not certify safe traffic rate, burst density safety, historical completeness, provider WebSocket behavior, or pool qualification.",
  "Does not perform getTransaction retrievals, DexScreener lookups, pagination, retries, WebSocket observations, or automatic follow-up runs.",
]);

export const ACTIVITY_CHECK_EXIT_CODES = Object.freeze({
  OK: 0,
  INVALID: 1,
  EVIDENCE_LIMITED: 2,
  NO_PAGE: 3,
  INTEGRITY_FAILED: 4,
  SEAL_FAILED: 5,
  CANCELLED: 6,
  CLEANUP_FAILED: 7,
});

export const ACTIVITY_CHECK_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type ActivityCheckSignal = (typeof ACTIVITY_CHECK_SIGNALS)[number];
export const ACTIVITY_CHECK_SHUTDOWN_GRACE_MS = 5_000;
export const ACTIVITY_CHECK_SHUTDOWN_FORCED_NOTICE =
  "[CPMM_POOL_ACTIVITY_CHECK_SHUTDOWN_FORCED]" as const;

export function buildActivityCheckRpcParams(poolAddress: string) {
  return [
    poolAddress,
    {
      limit: ACTIVITY_CHECK_LIMITS.pageLimit,
      commitment: ACTIVITY_CHECK_LIMITS.commitment,
    },
  ] as const;
}

// ---------------------------------------------------------------------------------------------
// Safe decoders and redaction helpers
// ---------------------------------------------------------------------------------------------

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeStrictUtf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isSafeCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function redactText(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0 || text === "") return text;
  try {
    const bytes = Buffer.from(text, "utf8");
    const sanitized = sanitizeEvidenceBytes(bytes, secrets, { partial: false, parseJson: false });
    if (sanitized.status === "WITHHELD") return "[WITHHELD_CREDENTIAL_TEXT]";
    return sanitized.stored;
  } catch {
    return "[WITHHELD_CREDENTIAL_TEXT]";
  }
}

// ---------------------------------------------------------------------------------------------
// Pure page analysis (shared by acquisition and offline verification)
// ---------------------------------------------------------------------------------------------

export interface ActivityPageRecord {
  readonly position: number;
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly succeeded: boolean;
  readonly failed: boolean;
  readonly err: unknown;
  readonly confirmationStatus: "confirmed" | "finalized";
  readonly memoPresent: boolean;
  readonly transactionIndex: number | null;
}

export interface ActivitySlotGroup {
  readonly slot: number;
  readonly count: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly blockTime: number | null;
  readonly blockTimeMixed: boolean;
}

export interface ActivityPageAnalysis {
  readonly records: readonly ActivityPageRecord[];
  readonly counts: {
    readonly returned: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly nullBlockTime: number;
    readonly knownBlockTime: number;
    readonly confirmed: number;
    readonly finalized: number;
    readonly distinctSlots: number;
    readonly maxPerSlot: number;
    readonly slotsWithMultipleSignatures: number;
  };
  readonly emptyPage: boolean;
  readonly potentiallyTruncatedHistory: boolean;
  readonly observedTimeSpan: {
    readonly newestKnownBlockTimeSec: number | null;
    readonly oldestKnownBlockTimeSec: number | null;
    readonly spanSec: number | null;
    readonly newestKnownBlockTimeIso: string | null;
    readonly oldestKnownBlockTimeIso: string | null;
    readonly blockTimeOrderAnomaly: boolean;
  };
  readonly observedSlotRange: {
    readonly newestSlot: number | null;
    readonly oldestSlot: number | null;
    readonly slotSpan: number | null;
  };
  readonly slotGrouping: readonly ActivitySlotGroup[];
  readonly nonCertifications: typeof ACTIVITY_CHECK_NON_CERTIFICATIONS;
}

export type ActivityResponseAnalysis =
  | { readonly kind: "PAGE"; readonly page: ActivityPageAnalysis }
  | { readonly kind: "RPC_ERROR"; readonly code: number; readonly message: string }
  | { readonly kind: "MALFORMED"; readonly reason: string };

/**
 * Strict inspection of the bounded `getSignaturesForAddress` response bytes:
 * fatal UTF-8, JSON-RPC 2.0 envelope matching `requestId`, either `{jsonrpc, id, result}` or
 * `{jsonrpc, id, error:{code, message[, data]}}`, at most 20 records with required fields plus
 * documented optional `transactionIndex`, canonical 64-byte signature, non-negative safe slot,
 * nullable safe blockTime, confirmed/finalized commitment, no duplicate signatures, newest-first
 * slot ordering.
 */
export function analyzePoolActivityResponse(
  body: Uint8Array,
  requestId: number,
): ActivityResponseAnalysis {
  const malformed = (reason: string): ActivityResponseAnalysis => ({ kind: "MALFORMED", reason });
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
  if (m.result.length > ACTIVITY_CHECK_LIMITS.pageLimit) return malformed("TOO_MANY_RECORDS");

  const seen = new Set<string>();
  const records: ActivityPageRecord[] = [];
  let previousSlot: number | null = null;
  for (const [i, raw] of (m.result as unknown[]).entries()) {
    if (
      !isRecord(raw) ||
      ACTIVITY_CHECK_REQUIRED_RECORD_FIELDS.some((k) => !Object.hasOwn(raw, k)) ||
      Object.keys(raw).some(
        (k) =>
          !ACTIVITY_CHECK_REQUIRED_RECORD_FIELDS.includes(k) &&
          !ACTIVITY_CHECK_OPTIONAL_RECORD_FIELDS.includes(k),
      )
    ) {
      return malformed(`RECORD_SHAPE_INVALID:${i}`);
    }
    if (!isValidSolanaSignature(raw.signature)) return malformed(`SIGNATURE_INVALID:${i}`);
    if (!isSafeCount(raw.slot)) return malformed(`SLOT_INVALID:${i}`);
    if (raw.blockTime !== null && !isSafeCount(raw.blockTime)) {
      return malformed(`BLOCK_TIME_INVALID:${i}`);
    }
    if (raw.confirmationStatus !== "confirmed" && raw.confirmationStatus !== "finalized") {
      return malformed(`CONFIRMATION_STATUS_INVALID:${i}`);
    }
    if (!(raw.err === null || typeof raw.err === "string" || isRecord(raw.err))) {
      return malformed(`ERR_INVALID:${i}`);
    }
    if (!(raw.memo === null || typeof raw.memo === "string")) {
      return malformed(`MEMO_INVALID:${i}`);
    }
    const hasIndex = Object.hasOwn(raw, "transactionIndex");
    if (hasIndex && !isSafeCount(raw.transactionIndex)) {
      return malformed(`TRANSACTION_INDEX_INVALID:${i}`);
    }
    if (seen.has(raw.signature)) return malformed(`DUPLICATE_SIGNATURE:${i}`);
    seen.add(raw.signature);
    if (previousSlot !== null && raw.slot > previousSlot) return malformed(`NOT_NEWEST_FIRST:${i}`);
    previousSlot = raw.slot;
    const failed = raw.err !== null;
    records.push({
      position: i,
      signature: raw.signature,
      slot: raw.slot,
      blockTime: raw.blockTime as number | null,
      succeeded: !failed,
      failed,
      err: raw.err,
      confirmationStatus: raw.confirmationStatus,
      memoPresent: raw.memo !== null,
      transactionIndex: hasIndex ? (raw.transactionIndex as number) : null,
    });
  }
  return { kind: "PAGE", page: summarizeActivityPage(records) };
}

function summarizeActivityPage(records: readonly ActivityPageRecord[]): ActivityPageAnalysis {
  const known = records.map((r) => r.blockTime).filter((t): t is number => t !== null);
  const newestKnownBlockTimeSec = known.length > 0 ? Math.max(...known) : null;
  const oldestKnownBlockTimeSec = known.length > 0 ? Math.min(...known) : null;
  let blockTimeOrderAnomaly = false;
  for (let i = 1; i < known.length; i++) {
    if ((known[i] as number) > (known[i - 1] as number)) blockTimeOrderAnomaly = true;
  }

  const slotGrouping: ActivitySlotGroup[] = [];
  for (const r of records) {
    const last = slotGrouping.at(-1);
    if (!last || last.slot !== r.slot) {
      slotGrouping.push({
        slot: r.slot,
        count: 1,
        succeeded: r.succeeded ? 1 : 0,
        failed: r.failed ? 1 : 0,
        blockTime: r.blockTime,
        blockTimeMixed: false,
      });
    } else {
      const mixed = last.blockTimeMixed || last.blockTime !== r.blockTime;
      slotGrouping[slotGrouping.length - 1] = {
        slot: last.slot,
        count: last.count + 1,
        succeeded: last.succeeded + (r.succeeded ? 1 : 0),
        failed: last.failed + (r.failed ? 1 : 0),
        blockTime: mixed ? null : last.blockTime,
        blockTimeMixed: mixed,
      };
    }
  }

  const newestSlot = records.length > 0 ? (records[0] as ActivityPageRecord).slot : null;
  const oldestSlot = records.length > 0 ? (records.at(-1) as ActivityPageRecord).slot : null;
  const succeeded = records.filter((r) => r.succeeded).length;
  const failed = records.length - succeeded;
  const knownBlockTime = known.length;
  const nullBlockTime = records.length - knownBlockTime;
  const finalized = records.filter((r) => r.confirmationStatus === "finalized").length;
  const confirmed = records.length - finalized;
  const maxPerSlot = slotGrouping.reduce((m, g) => Math.max(m, g.count), 0);
  const slotsWithMultipleSignatures = slotGrouping.filter((g) => g.count >= 2).length;

  return {
    records,
    counts: {
      returned: records.length,
      succeeded,
      failed,
      nullBlockTime,
      knownBlockTime,
      confirmed,
      finalized,
      distinctSlots: slotGrouping.length,
      maxPerSlot,
      slotsWithMultipleSignatures,
    },
    emptyPage: records.length === 0,
    potentiallyTruncatedHistory: records.length === ACTIVITY_CHECK_LIMITS.pageLimit,
    observedTimeSpan: {
      newestKnownBlockTimeSec,
      oldestKnownBlockTimeSec,
      spanSec:
        newestKnownBlockTimeSec !== null && oldestKnownBlockTimeSec !== null
          ? newestKnownBlockTimeSec - oldestKnownBlockTimeSec
          : null,
      newestKnownBlockTimeIso:
        newestKnownBlockTimeSec !== null
          ? new Date(newestKnownBlockTimeSec * 1000).toISOString()
          : null,
      oldestKnownBlockTimeIso:
        oldestKnownBlockTimeSec !== null
          ? new Date(oldestKnownBlockTimeSec * 1000).toISOString()
          : null,
      blockTimeOrderAnomaly,
    },
    observedSlotRange: {
      newestSlot,
      oldestSlot,
      slotSpan: newestSlot !== null && oldestSlot !== null ? newestSlot - oldestSlot : null,
    },
    slotGrouping,
    nonCertifications: ACTIVITY_CHECK_NON_CERTIFICATIONS,
  };
}

// ---------------------------------------------------------------------------------------------
// Acquisition (one bounded request through PaperRequestSession)
// ---------------------------------------------------------------------------------------------

export type ActivityCheckOutcome =
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

export interface ActivityCheckAcquisition {
  readonly outcome: ActivityCheckOutcome;
  readonly detail: string | null;
  readonly poolAddress: string;
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly endedAtMs: number;
  readonly requestId: number | null;
  readonly exchange: PaperRequestExchangeEvidence | null;
  readonly sessionStopReason: string | null;
  readonly analysis: ActivityResponseAnalysis | null;
  readonly cancelled: boolean;
  readonly cancellationPhase: "DURING_REQUEST" | "BEFORE_SEALING" | null;
}

function outcomeOf(
  error: string | null,
  httpStatus: number | null,
  bodyState: string,
  stopReason: string | null,
  cancelled: boolean,
  analysis: ActivityResponseAnalysis | null,
  completedAfterDeadline: boolean,
): ActivityCheckOutcome {
  if (cancelled && error !== null) return "OPERATOR_CANCELLED";
  if (error === "RESPONSE_TOO_LARGE") return "RESPONSE_LIMIT_EXCEEDED";
  if (error === "REQUEST_TIMED_OUT" || (error !== null && stopReason === "LIFETIME_EXPIRED")) {
    return "DEADLINE_EXPIRED";
  }
  if (error === "HTTP_429_RECEIVED" || error === "HTTP_REDIRECT_REJECTED") return "SESSION_STOPPED";
  if (error !== null) return error === "NETWORK_ERROR" ? "TRANSPORT_ERROR" : "SESSION_STOPPED";
  if (completedAfterDeadline) return "DEADLINE_EXPIRED";
  if (httpStatus !== 200) return "HTTP_ERROR";
  if (bodyState !== "COMPLETE" || analysis === null) return "MALFORMED_RESPONSE";
  return analysis.kind === "PAGE"
    ? "PAGE_RECEIVED"
    : analysis.kind === "RPC_ERROR"
      ? "RPC_ERROR"
      : "MALFORMED_RESPONSE";
}

export async function runPoolActivityRequest(o: {
  readonly poolAddress: string;
  readonly rpcUrl: string;
  readonly fetchFn: typeof fetch;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}): Promise<ActivityCheckAcquisition> {
  const clock = o.clock ?? (() => Date.now());
  const L = ACTIVITY_CHECK_LIMITS;
  const startedAtMs = clock();
  const deadlineAtMs = startedAtMs + L.acquisitionDeadlineMs;
  const base = { poolAddress: o.poolAddress, startedAtMs, deadlineAtMs };

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
      DEXSCREENER: { maxAttempts: 0, pacingMs: 1_000, maxResponseBytes: 1 },
      RUGCHECK: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 1 },
      SOLANA_TRACKER: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 1 },
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
    await session.dispatch({
      lane: "SOLANA_RPC",
      owner: "SECURITY",
      purpose: "CPMM_POOL_ACTIVITY_CHECK",
      requestedIdentity: o.poolAddress,
      url: o.rpcUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: ACTIVITY_CHECK_RPC_METHOD,
        params: buildActivityCheckRpcParams(o.poolAddress),
      }),
      jsonRpcId: requestId,
      waitSignals: o.abortSignal ? [o.abortSignal] : undefined,
    });
  } finally {
    o.abortSignal?.removeEventListener("abort", onAbort);
    session.stop("ACTIVITY_CHECK_FINISHED");
  }

  const e = exchange as PaperRequestExchangeEvidence | null;
  const stopReason = session.getStatus().stopReason;
  const recordedStop = stopReason === "ACTIVITY_CHECK_FINISHED" ? null : stopReason;
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
      ? analyzePoolActivityResponse(e.body, requestId)
      : null;
  const cancelledDuring = cancelled && e.entry.error !== null;
  const completedAfterDeadline =
    e.entry.error === null && (e.entry.completedAtMs ?? Infinity) > deadlineAtMs;
  const outcome = outcomeOf(
    e.entry.error,
    e.entry.httpStatus,
    e.bodyState,
    recordedStop,
    cancelledDuring,
    analysis,
    completedAfterDeadline,
  );

  return {
    ...base,
    outcome,
    detail: completedAfterDeadline
      ? "COMPLETED_AFTER_DEADLINE"
      : analysis?.kind === "MALFORMED"
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
// Sanitization and sealing (exclusive create; reused credential sanitizer)
// ---------------------------------------------------------------------------------------------

export type ActivityCheckFileWriter = (
  file: string,
  content: string,
  options: { readonly encoding: "utf8"; readonly flag: "wx" },
) => void;

export type SealActivityCheckResult =
  | { readonly ok: true; readonly manifestSha256: string }
  | {
      readonly ok: false;
      readonly status: "OUTPUT_DIRECTORY_UNAVAILABLE" | "SEAL_REFUSED" | "ARTIFACT_WRITE_FAILED";
      readonly reason: string;
    };

function scrubResponseBody(
  original: Buffer | null,
  bodyState: string,
  secrets: readonly string[],
): {
  readonly state: "NOT_CAPTURED" | "ORIGINAL" | "REDACTED" | "WITHHELD";
  readonly withheldReason: string | null;
  readonly originalBytes: number | null;
  readonly originalSha256: string | null;
  readonly storedEncoding: "utf8" | "base64" | null;
  readonly storedBytes: number | null;
  readonly storedSha256: string | null;
  readonly payload: string | null;
  readonly payloadRedacted: boolean;
} {
  if (original === null) {
    return {
      state: "NOT_CAPTURED",
      withheldReason: null,
      originalBytes: null,
      originalSha256: null,
      storedEncoding: null,
      storedBytes: null,
      storedSha256: null,
      payload: null,
      payloadRedacted: false,
    };
  }
  const originalSha256 = sha256(original);
  if (secrets.length === 0) {
    const text = decodeStrictUtf8(original);
    return {
      state: "ORIGINAL",
      withheldReason: null,
      originalBytes: original.length,
      originalSha256,
      storedEncoding: text === null ? "base64" : "utf8",
      storedBytes: original.length,
      storedSha256: originalSha256,
      payload: text ?? original.toString("base64"),
      payloadRedacted: false,
    };
  }
  let sanitized: SanitizedEvidenceBytes;
  try {
    sanitized = sanitizeEvidenceBytes(original, secrets, {
      partial: bodyState === "PARTIAL_OVERFLOW",
      parseJson: bodyState === "COMPLETE",
    });
  } catch {
    return {
      state: "WITHHELD",
      withheldReason: "CREDENTIAL_MATERIAL_DETECTED",
      originalBytes: original.length,
      originalSha256,
      storedEncoding: null,
      storedBytes: null,
      storedSha256: null,
      payload: null,
      payloadRedacted: true,
    };
  }
  if (sanitized.status === "WITHHELD") {
    return {
      state: "WITHHELD",
      withheldReason: sanitized.reason,
      originalBytes: sanitized.originalBytes,
      originalSha256: sanitized.originalSha256,
      storedEncoding: null,
      storedBytes: null,
      storedSha256: null,
      payload: null,
      payloadRedacted: true,
    };
  }
  return {
    state: sanitized.redacted ? "REDACTED" : "ORIGINAL",
    withheldReason: null,
    originalBytes: sanitized.originalBytes,
    originalSha256: sanitized.originalSha256,
    storedEncoding: sanitized.encoding,
    storedBytes: sanitized.storedBytes,
    storedSha256: sanitized.storedSha256,
    payload: sanitized.stored,
    payloadRedacted: sanitized.redacted,
  };
}

export function activityCheckRecord(
  a: ActivityCheckAcquisition,
  secrets: readonly string[],
): Record<string, unknown> {
  const redact = (t: string) => redactText(t, secrets);
  const e = a.exchange;
  let response: Record<string, unknown> | null = null;
  if (e !== null) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.responseHeaders)) headers[k] = redact(v);
    const scrubbed = scrubResponseBody(e.body, e.bodyState, secrets);
    response = {
      httpStatus: e.entry.httpStatus,
      headers,
      bodyState: e.bodyState,
      observedBytes: e.observedBodyBytes,
      maxResponseBytes: e.maxResponseBytes,
      ...scrubbed,
    };
  }
  const analysis = a.analysis;
  const page = analysis?.kind === "PAGE" ? analysis.page : null;
  const newestAgeAtCheckStartSec =
    page !== null && page.observedTimeSpan.newestKnownBlockTimeSec !== null
      ? Math.floor(a.startedAtMs / 1000) - page.observedTimeSpan.newestKnownBlockTimeSec
      : null;

  return {
    kind: ACTIVITY_CHECK_KIND,
    version: ACTIVITY_CHECK_VERSION,
    poolAddress: a.poolAddress,
    limits: ACTIVITY_CHECK_LIMITS,
    limitations: ACTIVITY_CHECK_LIMITATIONS,
    nonCertifications: ACTIVITY_CHECK_NON_CERTIFICATIONS,
    request: {
      method: "POST",
      url: ACTIVITY_CHECK_RPC_URL_PLACEHOLDER,
      rpcMethod: ACTIVITY_CHECK_RPC_METHOD,
      rpcParams: buildActivityCheckRpcParams(a.poolAddress),
      jsonRpcId: a.requestId,
      dispatchedAtMs: e?.entry.dispatchedAtMs ?? null,
      completedAtMs: e?.entry.completedAtMs ?? null,
      error: e?.entry.error ? redact(e.entry.error) : null,
    },
    response,
    recorded: {
      outcome: a.outcome,
      detail: a.detail === null ? null : redact(a.detail),
      sessionStopReason: a.sessionStopReason,
      cancelled: a.cancelled,
      cancellationPhase: a.cancellationPhase,
      pageObtained: a.outcome === "PAGE_RECEIVED" && !a.cancelled,
      rpcError:
        analysis?.kind === "RPC_ERROR"
          ? { code: analysis.code, message: redact(analysis.message) }
          : null,
      newestAgeAtCheckStartSec,
      page,
    },
    startedAtMs: a.startedAtMs,
    deadlineAtMs: a.deadlineAtMs,
    endedAtMs: a.endedAtMs,
  };
}

function fileContainsDetectableSecret(text: string, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  for (const s of secrets) {
    if (s.length >= EVIDENCE_SANITIZER_LIMITS.minSuppliedSecretChars && text.includes(s)) {
      return true;
    }
  }
  try {
    const res = sanitizeEvidenceBytes(Buffer.from(text, "utf8"), secrets, {
      partial: false,
      parseJson: false,
    });
    return res.status === "WITHHELD" || res.redacted;
  } catch {
    return true;
  }
}

export function sealActivityCheckEvidence(input: {
  readonly outDir: string;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly record: Readonly<Record<string, unknown>>;
  readonly secrets: readonly string[];
  readonly writeFile?: ActivityCheckFileWriter | undefined;
}): SealActivityCheckResult {
  const redact = (t: string) => redactText(t, input.secrets);
  const contents: [string, string][] = [
    [ACTIVITY_CHECK_FILES.plan, JSON.stringify(input.plan, null, 2) + "\n"],
    [ACTIVITY_CHECK_FILES.activity, JSON.stringify(input.record, null, 2) + "\n"],
  ];

  for (const [name, text] of contents) {
    if (fileContainsDetectableSecret(text, input.secrets)) {
      return {
        ok: false,
        status: "SEAL_REFUSED",
        reason: `a credential would be persisted in ${name}`,
      };
    }
  }
  const response = input.record.response;
  if (
    isRecord(response) &&
    typeof response.payload === "string" &&
    response.storedEncoding === "base64" &&
    input.secrets.length > 0
  ) {
    const bytes = Buffer.from(response.payload, "base64");
    try {
      const check = sanitizeEvidenceBytes(bytes, input.secrets, {
        partial: false,
        parseJson: false,
      });
      if (check.status === "WITHHELD" || check.redacted) {
        return {
          ok: false,
          status: "SEAL_REFUSED",
          reason: "a credential would be persisted in the stored response",
        };
      }
    } catch {
      return {
        ok: false,
        status: "SEAL_REFUSED",
        reason: "a credential would be persisted in the stored response",
      };
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
  const rec = input.record.recorded as Record<string, unknown>;
  try {
    const files = contents.map(([name, text]) => {
      write(path.join(input.outDir, name), text, { encoding: "utf8", flag: "wx" });
      return { path: name, sha256: sha256(text), bytes: Buffer.byteLength(text, "utf8") };
    });
    const manifest =
      JSON.stringify(
        {
          kind: ACTIVITY_CHECK_MANIFEST_KIND,
          version: ACTIVITY_CHECK_VERSION,
          recordedOutcome: rec.outcome,
          recordedPageObtained: rec.pageObtained,
          files,
        },
        null,
        2,
      ) + "\n";
    write(path.join(input.outDir, ACTIVITY_CHECK_FILES.manifest), manifest, {
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
// Offline verification (strictly separates integrity, recorded outcomes and computed observations)
// ---------------------------------------------------------------------------------------------

export type ReanalysisStatus =
  | "REPRODUCED"
  | "UNAVAILABLE_REDACTED"
  | "UNAVAILABLE_WITHHELD"
  | "NOT_APPLICABLE"
  | "MISMATCH";

export interface ActivityCheckVerification {
  readonly integrity: { readonly ok: boolean; readonly problems: readonly string[] };
  readonly recorded: {
    readonly outcome: ActivityCheckOutcome | null;
    readonly pageObtained: boolean;
    readonly counts: ActivityPageAnalysis["counts"] | null;
    readonly potentiallyTruncatedHistory: boolean | null;
  } | null;
  readonly computed: {
    readonly reanalysisStatus: ReanalysisStatus;
    readonly outcome: ActivityCheckOutcome | null;
    readonly pageObtained: boolean;
    readonly page: ActivityPageAnalysis | null;
    readonly newestAgeAtCheckStartSec: number | null;
    readonly rpcError: { readonly code: number; readonly message: string } | null;
  } | null;
  readonly manifestSha256: string | null;
  readonly recordVersion: ActivityRecordSchemaVersion | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const PLAN_OUT_DIR = new RegExp(
  `^${ACTIVITY_CHECK_ROOT_SEGMENTS.join("/")}/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`,
);
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

export function verifyActivityCheckEvidence(dir: string): ActivityCheckVerification {
  const problems: string[] = [];
  let manifestSha256: string | null = null;
  let recordedSummary: ActivityCheckVerification["recorded"] = null;
  const fail = (
    reanalysisStatus: ReanalysisStatus = "NOT_APPLICABLE",
  ): ActivityCheckVerification => ({
    integrity: { ok: false, problems: [...problems] },
    recorded: recordedSummary,
    computed:
      recordedSummary === null
        ? null
        : {
            reanalysisStatus,
            outcome: null,
            pageObtained: false,
            page: null,
            newestAgeAtCheckStartSec: null,
            rpcError: null,
          },
    manifestSha256,
    recordVersion: null,
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
      const bytes = readFileSync(path.join(dir, ACTIVITY_CHECK_FILES.manifest));
      manifestSha256 = sha256(bytes);
      manifest = JSON.parse(bytes.toString("utf8"));
    } catch {
      problems.push("MANIFEST_MISSING_OR_INVALID");
      return fail();
    }

    const expected: readonly string[] = [ACTIVITY_CHECK_FILES.plan, ACTIVITY_CHECK_FILES.activity];
    if (
      !isRecord(manifest) ||
      manifest.kind !== ACTIVITY_CHECK_MANIFEST_KIND ||
      !ACTIVITY_CHECK_SUPPORTED_VERSIONS.includes(
        manifest.version as ActivityRecordSchemaVersion,
      ) ||
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
      else if (name !== ACTIVITY_CHECK_FILES.manifest && !expected.includes(name)) {
        problems.push(`UNLISTED:${name}`);
      }
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
      if (sha256(bytes) !== f.sha256 || bytes.length !== f.bytes) {
        problems.push(`MODIFIED:${String(f.path)}`);
      } else {
        files.set(f.path as string, bytes);
      }
    }
    if (problems.length > 0) return fail();

    let plan: unknown;
    let r: unknown;
    try {
      plan = JSON.parse((files.get(ACTIVITY_CHECK_FILES.plan) as Buffer).toString("utf8"));
      r = JSON.parse((files.get(ACTIVITY_CHECK_FILES.activity) as Buffer).toString("utf8"));
    } catch {
      problems.push("EVIDENCE_NOT_JSON");
      return fail();
    }

    if (!isRecord(r) || r.kind !== ACTIVITY_CHECK_KIND || r.version !== manifest.version) {
      problems.push("RECORD_KIND_INVALID");
      return fail();
    }

    const schemaVersion = r.version as ActivityRecordSchemaVersion;
    if (typeof r.poolAddress !== "string" || !isSolanaAddress(r.poolAddress)) {
      problems.push("POOL_ADDRESS_INVALID");
      return fail();
    }
    const poolAddress = r.poolAddress;

    if (
      !isRecord(plan) ||
      typeof plan.outDir !== "string" ||
      !PLAN_OUT_DIR.test(plan.outDir) ||
      !same(plan, buildActivityCheckPlan({ poolAddress, outDir: plan.outDir, mode: "LIVE" }))
    ) {
      problems.push("PLAN_INVALID");
    }

    if (!same(r.limits, ACTIVITY_CHECK_LIMITS)) problems.push("LIMITS_MISMATCH");
    if (!same(r.limitations, ACTIVITY_CHECK_LIMITATIONS)) problems.push("LIMITATIONS_MISMATCH");
    if (!same(r.nonCertifications, ACTIVITY_CHECK_NON_CERTIFICATIONS)) {
      problems.push("NON_CERTIFICATIONS_MISMATCH");
    }

    const rec = isRecord(r.recorded) ? r.recorded : null;
    if (rec === null || typeof rec.outcome !== "string" || !OUTCOMES.includes(rec.outcome)) {
      problems.push("RECORDED_OUTCOME_INVALID");
      return fail();
    }
    const recOutcome = rec.outcome as ActivityCheckOutcome;
    const recPageObj = isRecord(rec.page) ? (rec.page as unknown as ActivityPageAnalysis) : null;
    recordedSummary = {
      outcome: recOutcome,
      pageObtained: rec.pageObtained === true,
      counts: recPageObj?.counts ?? null,
      potentiallyTruncatedHistory:
        typeof recPageObj?.potentiallyTruncatedHistory === "boolean"
          ? recPageObj.potentiallyTruncatedHistory
          : null,
    };

    if (
      manifest.recordedOutcome !== recOutcome ||
      manifest.recordedPageObtained !== rec.pageObtained
    ) {
      problems.push("MANIFEST_SUMMARY_MISMATCH");
    }

    const req = isRecord(r.request) ? r.request : null;
    if (
      req === null ||
      req.method !== "POST" ||
      req.url !== ACTIVITY_CHECK_RPC_URL_PLACEHOLDER ||
      req.rpcMethod !== ACTIVITY_CHECK_RPC_METHOD ||
      !same(req.rpcParams, buildActivityCheckRpcParams(poolAddress))
    ) {
      problems.push("REQUEST_INVALID");
      return fail();
    }

    const started = r.startedAtMs;
    if (
      !isSafeCount(started) ||
      r.deadlineAtMs !== started + ACTIVITY_CHECK_LIMITS.acquisitionDeadlineMs ||
      !isSafeCount(r.endedAtMs) ||
      r.endedAtMs < started
    ) {
      problems.push("TIMES_INVALID");
      return fail();
    }

    const cancelled = rec.cancelled;
    const phase = rec.cancellationPhase;
    if (
      typeof cancelled !== "boolean" ||
      (cancelled ? phase !== "DURING_REQUEST" && phase !== "BEFORE_SEALING" : phase !== null)
    ) {
      problems.push("CANCELLATION_RECORD_INVALID");
    }

    const resp = r.response;
    let analysis: ActivityResponseAnalysis | null = null;
    let computedOutcome: ActivityCheckOutcome | null = null;
    let reanalysisStatus: ReanalysisStatus = "NOT_APPLICABLE";
    let redacted = false;
    let withheld = false;

    if (resp === null) {
      if (recOutcome !== "OPERATOR_CANCELLED" && recOutcome !== "NOT_DISPATCHED") {
        problems.push("OUTCOME_NOT_REPRODUCED");
      }
      if (recOutcome === "OPERATOR_CANCELLED" && cancelled !== true) {
        problems.push("OUTCOME_NOT_REPRODUCED");
      }
      if (req.dispatchedAtMs !== null || req.completedAtMs !== null) {
        problems.push("REQUEST_TIMES_INVALID");
      }
      computedOutcome = recOutcome;
      reanalysisStatus = "REPRODUCED";
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
        return fail();
      }
      if (req.dispatchedAtMs >= (r.deadlineAtMs as number)) {
        problems.push("DISPATCH_AFTER_DEADLINE");
      }
      if (resp.maxResponseBytes !== ACTIVITY_CHECK_LIMITS.maxResponseBytes) {
        problems.push("RESPONSE_LIMIT_MISMATCH");
      }

      const error = req.error === null ? null : String(req.error);
      const httpStatus = resp.httpStatus === null ? null : Number(resp.httpStatus);
      const bodyState = String(resp.bodyState);
      const respState = String(resp.state);
      const observed = resp.observedBytes;
      let stored: Buffer | null = null;

      if (respState === "NOT_CAPTURED") {
        if (
          resp.payload !== null ||
          resp.storedEncoding !== null ||
          resp.storedBytes !== null ||
          resp.storedSha256 !== null ||
          resp.originalBytes !== null ||
          resp.originalSha256 !== null ||
          resp.payloadRedacted !== false ||
          resp.withheldReason !== null
        ) {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
        }
      } else if (respState === "WITHHELD") {
        withheld = true;
        if (
          resp.payload !== null ||
          resp.storedEncoding !== null ||
          resp.storedBytes !== null ||
          resp.storedSha256 !== null ||
          !isSafeCount(resp.originalBytes) ||
          resp.originalBytes > ACTIVITY_CHECK_LIMITS.maxResponseBytes ||
          typeof resp.originalSha256 !== "string" ||
          !HEX64.test(resp.originalSha256) ||
          resp.payloadRedacted !== true ||
          typeof resp.withheldReason !== "string"
        ) {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
        }
      } else if (respState === "ORIGINAL" || respState === "REDACTED") {
        if (typeof resp.payload !== "string" || resp.withheldReason !== null) {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
          return fail();
        }
        if (resp.storedEncoding === "utf8") {
          stored = Buffer.from(resp.payload, "utf8");
        } else if (resp.storedEncoding === "base64") {
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
          resp.originalBytes > ACTIVITY_CHECK_LIMITS.maxResponseBytes ||
          typeof resp.originalSha256 !== "string" ||
          !HEX64.test(resp.originalSha256) ||
          typeof resp.payloadRedacted !== "boolean" ||
          resp.payloadRedacted !== (respState === "REDACTED")
        ) {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
        } else if (respState === "ORIGINAL") {
          if (stored.length !== resp.originalBytes || resp.storedSha256 !== resp.originalSha256) {
            problems.push("RESPONSE_ACCOUNTING_INVALID");
          }
        } else if (resp.storedSha256 === resp.originalSha256) {
          problems.push("RESPONSE_ACCOUNTING_INVALID");
        }
        redacted = respState === "REDACTED";
      } else {
        problems.push("RESPONSE_ACCOUNTING_INVALID");
        return fail();
      }

      const statusValid = httpStatus === null || Number.isSafeInteger(httpStatus);
      const accountingValid =
        statusValid &&
        (bodyState === "COMPLETE"
          ? error === null &&
            httpStatus !== null &&
            (respState === "WITHHELD" || stored !== null) &&
            isSafeCount(observed) &&
            observed === resp.originalBytes
          : bodyState === "PARTIAL_OVERFLOW"
            ? error === "RESPONSE_TOO_LARGE" &&
              httpStatus !== null &&
              (respState === "WITHHELD" || stored !== null) &&
              resp.originalBytes === ACTIVITY_CHECK_LIMITS.maxResponseBytes &&
              isSafeCount(observed) &&
              observed > ACTIVITY_CHECK_LIMITS.maxResponseBytes
            : bodyState === "NOT_READ"
              ? error !== null && respState === "NOT_CAPTURED" && observed === null
              : false);
      if (!accountingValid) {
        problems.push("RESPONSE_ACCOUNTING_INVALID");
        return fail();
      }

      const completedAfterDeadline =
        error === null && (req.completedAtMs as number) > (r.deadlineAtMs as number);
      if (
        error === null &&
        httpStatus === 200 &&
        bodyState === "COMPLETE" &&
        stored !== null &&
        !redacted &&
        !withheld
      ) {
        analysis = analyzePoolActivityResponse(stored, req.jsonRpcId as number);
      }

      const cancelledDuring = cancelled === true && phase === "DURING_REQUEST" && error !== null;
      const timelyComplete200 =
        error === null && httpStatus === 200 && bodyState === "COMPLETE" && !completedAfterDeadline;
      if (timelyComplete200 && withheld) {
        reanalysisStatus = "UNAVAILABLE_WITHHELD";
        computedOutcome = null;
      } else if (timelyComplete200 && redacted) {
        reanalysisStatus = "UNAVAILABLE_REDACTED";
        computedOutcome = null;
      } else {
        const derived = outcomeOf(
          error,
          httpStatus,
          bodyState,
          rec.sessionStopReason === null ? null : String(rec.sessionStopReason),
          cancelledDuring,
          analysis,
          completedAfterDeadline,
        );
        computedOutcome = derived;
        reanalysisStatus = derived === recOutcome ? "REPRODUCED" : "MISMATCH";
        if (derived !== recOutcome) problems.push("OUTCOME_NOT_REPRODUCED");
      }
    }

    const expectedPage = analysis?.kind === "PAGE" ? analysis.page : null;
    if (!redacted && !withheld && !same(rec.page, expectedPage)) {
      problems.push("PAGE_NOT_REPRODUCED");
    }
    if ((redacted || withheld) && rec.page !== null && recOutcome !== "PAGE_RECEIVED") {
      problems.push("PAGE_NOT_REPRODUCED");
    }
    const expectedAge =
      expectedPage !== null && expectedPage.observedTimeSpan.newestKnownBlockTimeSec !== null
        ? Math.floor(started / 1000) - expectedPage.observedTimeSpan.newestKnownBlockTimeSec
        : null;
    if (!redacted && !withheld && rec.newestAgeAtCheckStartSec !== expectedAge) {
      problems.push("AGE_NOT_REPRODUCED");
    }
    if (analysis?.kind === "RPC_ERROR") {
      if (!isRecord(rec.rpcError) || rec.rpcError.code !== analysis.code) {
        problems.push("RPC_ERROR_NOT_REPRODUCED");
      }
    } else if (!redacted && !withheld && rec.rpcError !== null) {
      problems.push("RPC_ERROR_NOT_REPRODUCED");
    }

    const expectedRecordedObtained = recOutcome === "PAGE_RECEIVED" && cancelled === false;
    if (rec.pageObtained !== expectedRecordedObtained) {
      problems.push("PAGE_OBTAINED_MISMATCH");
    }

    if (problems.length > 0)
      return fail(reanalysisStatus === "MISMATCH" ? "MISMATCH" : reanalysisStatus);

    return {
      integrity: { ok: true, problems: [] },
      recorded: recordedSummary,
      computed: {
        reanalysisStatus,
        outcome: computedOutcome,
        pageObtained:
          expectedRecordedObtained && reanalysisStatus === "REPRODUCED" && expectedPage !== null,
        page: expectedPage,
        newestAgeAtCheckStartSec: expectedAge,
        rpcError:
          analysis?.kind === "RPC_ERROR"
            ? { code: analysis.code, message: analysis.message }
            : null,
      },
      manifestSha256,
      recordVersion: schemaVersion,
    };
  } catch {
    problems.push("EVIDENCE_RECORD_MALFORMED");
    return fail();
  }
}

// ---------------------------------------------------------------------------------------------
// Address validation, arguments, plans and CLI
// ---------------------------------------------------------------------------------------------

const RUN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A canonical base58 encoding of exactly 32 bytes. */
export function isSolanaAddress(s: string): boolean {
  if (!isCanonicalSolanaBase58(s) || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BASE58.indexOf(c));
  let bytes = 0;
  for (; n > 0n; n >>= 8n) bytes++;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return zeros + bytes === 32;
}

export const ACTIVITY_CHECK_USAGE = [
  "Usage: cpmm-pool-activity-check [--help] | --pool <address> --out-dir <dir> [--live] | --verify <dir>",
  "  --help            Print this usage and plan (nothing loaded, opened, sent or written).",
  "  --pool <address>  Explicit canonical 32-byte pool address (no discovery or substitution).",
  "  --out-dir <dir>   New directory directly inside data/research/cpmm-activity-checks/ (default: dry run).",
  "  --live            One getSignaturesForAddress request (limit 20, confirmed; separate approval required).",
  "  --verify <dir>    Read-only offline evidence verification (no configuration or credentials).",
  "Exit codes: 0 page obtained/verified or informational, 1 invalid input/config/setup, 2 limited (redacted/withheld),",
  "            3 no valid page obtained, 4 integrity failure, 5 seal failure, 6 cancelled, 7 listener cleanup failure.",
].join("\n");

export function buildActivityCheckPlan(input: {
  readonly poolAddress: string;
  readonly outDir: string;
  readonly mode: "DRY_RUN" | "LIVE";
}) {
  return {
    kind: ACTIVITY_CHECK_PLAN_KIND,
    version: ACTIVITY_CHECK_VERSION,
    executionContext: "PAPER_RESEARCH_ACTIVITY_CHECK_ONLY",
    mode: input.mode,
    approval: ACTIVITY_CHECK_APPROVAL_STATUS,
    liveExecution: ACTIVITY_CHECK_LIVE_STATUS,
    liveFlag: ACTIVITY_CHECK_LIVE_FLAG_MEANING,
    poolAddress: input.poolAddress,
    outDir: input.outDir,
    endpoint: "SOLANA_RPC_URL: required, https, no fragment (configuration; never printed)",
    request: {
      method: "POST",
      rpcMethod: ACTIVITY_CHECK_RPC_METHOD,
      rpcParams: buildActivityCheckRpcParams(input.poolAddress),
    },
    limits: ACTIVITY_CHECK_LIMITS,
    limitations: ACTIVITY_CHECK_LIMITATIONS,
    nonCertifications: ACTIVITY_CHECK_NON_CERTIFICATIONS,
    sequence: [
      "Validate CLI flags, canonical 32-byte pool address, and new output directory before loading configuration",
      "Load environment inside --live and resolve https SOLANA_RPC_URL without fragment (no WebSocket needed)",
      "Send at most one getSignaturesForAddress request (limit 20, confirmed) with 10 s deadline and 64 KiB cap",
      "Parse strict JSON-RPC envelope and compute descriptive page metadata without certifying traffic or swaps",
      "Sanitize credentials, seal exclusively into --out-dir, and verify integrity offline (no retries or follow-ups)",
    ],
  };
}

const trustedRefusals = new WeakSet<Error>();
function refusal(message: string): Error {
  const err = new Error(message);
  trustedRefusals.add(err);
  return Object.freeze(err);
}
const cliError = (message: string) => refusal(`[CLI_INVALID_ARG] ${message}`);

export const ACTIVITY_CHECK_CONFIG_ERRORS = Object.freeze({
  configurationLoad:
    "[CONFIGURATION_LOAD_FAILED] the configuration loader failed; its error text is withheld",
  rpcMissing: "[MISSING_CONFIGURATION] SOLANA_RPC_URL is required for --live",
  rpcHttps: "[INVALID_CONFIGURATION] SOLANA_RPC_URL must use https without a fragment for --live",
  secretsInvalid:
    "[INVALID_CONFIGURATION] endpoint credentials contain unsupported or malformed percent-encoding",
  signalInstall:
    "[SIGNAL_INSTALL_FAILED] a signal listener could not be installed; the run did not start",
});

export const printableActivityCheckError = (err: unknown): string =>
  err instanceof Error && trustedRefusals.has(err) ? err.message : "[UNEXPECTED_ERROR]";

export interface ActivityCheckSignalSource {
  on(signal: ActivityCheckSignal, listener: () => void): unknown;
  removeListener(signal: ActivityCheckSignal, listener: () => void): unknown;
}

export interface ActivityCheckCliDeps {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly loadEnvironment?: (() => void | Promise<void>) | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly clock?: (() => number) | undefined;
  readonly timers?: PaperRequestSessionTimers | undefined;
  readonly projectRoot?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly signals?: ActivityCheckSignalSource | undefined;
  readonly log?: ((line: string) => void) | undefined;
  readonly writeFile?: ActivityCheckFileWriter | undefined;
}

export interface ActivityCheckRunResult {
  readonly mode: "HELP" | "DRY_RUN" | "LIVE" | "VERIFY";
  readonly exitCode: number;
  readonly planDigestSha256?: string | undefined;
  readonly outDir?: string | undefined;
  readonly acquisition?: ActivityCheckAcquisition | undefined;
  readonly record?: Readonly<Record<string, unknown>> | undefined;
  readonly seal?: SealActivityCheckResult | undefined;
  readonly verification?: ActivityCheckVerification | undefined;
  readonly signalCleanupFailures?: readonly string[] | undefined;
}

type ParsedCli =
  | { readonly mode: "HELP" }
  | { readonly mode: "VERIFY"; readonly verifyDir: string }
  | {
      readonly mode: "DRY_RUN" | "LIVE";
      readonly poolAddress: string;
      readonly outDir: string;
    };

function parseActivityCli(rawArgs: readonly string[]): ParsedCli {
  let values: Record<string, string | boolean | undefined>;
  let tokens: readonly { kind: string; name?: string }[] = [];
  try {
    ({ values, tokens = [] } = parseArgs({
      args: [...rawArgs],
      options: {
        help: { type: "boolean" },
        live: { type: "boolean" },
        pool: { type: "string" },
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
    return { mode: "HELP" };
  }

  if (values.verify !== undefined) {
    if (seen.size > 1) {
      throw cliError("--verify cannot be combined with --live, --pool or --out-dir");
    }
    const verifyDir = String(values.verify);
    if (verifyDir === "") throw cliError("--verify requires a directory path");
    return { mode: "VERIFY", verifyDir };
  }

  const poolAddress = values.pool;
  const outDir = values["out-dir"];
  if (typeof poolAddress !== "string" || poolAddress === "" || !isSolanaAddress(poolAddress)) {
    throw cliError("--pool must be a canonical base58 32-byte address");
  }
  if (typeof outDir !== "string" || outDir === "") {
    throw cliError(
      "--out-dir is required (a new directory inside data/research/cpmm-activity-checks/)",
    );
  }
  return { mode: values.live === true ? "LIVE" : "DRY_RUN", poolAddress, outDir };
}

const rel = (projectRoot: string, p: string): string => {
  const r = path.relative(projectRoot, p);
  return (r === "" || r.startsWith("..") || path.isAbsolute(r) ? p : r).replace(/\\/g, "/");
};

const defaultTimers: PaperRequestSessionTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function loadConfiguredEnvironment(): Promise<void> {
  (await import("./paper-trading-daemon.js")).loadDaemonEnvironment();
}

export function activityVerifyExitCode(v: ActivityCheckVerification): number {
  const X = ACTIVITY_CHECK_EXIT_CODES;
  if (!v.integrity.ok) return X.INTEGRITY_FAILED;
  const rec = v.recorded;
  const comp = v.computed;
  if (!rec || !comp) return X.INTEGRITY_FAILED;
  if (rec.outcome === "OPERATOR_CANCELLED") return X.CANCELLED;
  if (
    rec.outcome === "PAGE_RECEIVED" &&
    (comp.reanalysisStatus === "UNAVAILABLE_REDACTED" ||
      comp.reanalysisStatus === "UNAVAILABLE_WITHHELD")
  ) {
    return X.EVIDENCE_LIMITED;
  }
  if (comp.reanalysisStatus === "MISMATCH") return X.INTEGRITY_FAILED;
  if (comp.pageObtained && rec.pageObtained) return X.OK;
  return X.NO_PAGE;
}

export function activityLiveExitCode(
  v: ActivityCheckVerification | null,
  seal: SealActivityCheckResult,
  cancelled: boolean,
  signalCleanupFailures: readonly string[],
): number {
  const X = ACTIVITY_CHECK_EXIT_CODES;
  let code: number;
  if (!seal.ok) code = X.SEAL_FAILED;
  else if (v === null || !v.integrity.ok) code = X.INTEGRITY_FAILED;
  else if (cancelled) code = X.CANCELLED;
  else code = activityVerifyExitCode(v);

  if (signalCleanupFailures.length === 0) return code;
  return code === X.OK || code === X.EVIDENCE_LIMITED ? X.CLEANUP_FAILED : code;
}

export async function runCpmmPoolActivityCheckCli(
  rawArgs: readonly string[],
  deps: ActivityCheckCliDeps = {},
): Promise<ActivityCheckRunResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const parsed = parseActivityCli(rawArgs);
  const X = ACTIVITY_CHECK_EXIT_CODES;

  if (parsed.mode === "HELP") {
    const planJson = JSON.stringify(
      buildActivityCheckPlan({
        poolAddress: "<pool address>",
        outDir: `${ACTIVITY_CHECK_ROOT_SEGMENTS.join("/")}/<run name>`,
        mode: "DRY_RUN",
      }),
    );
    log(ACTIVITY_CHECK_USAGE);
    log("[HELP] No configuration loaded, no transport opened, nothing sent, nothing written.");
    log(planJson);
    return { mode: "HELP", exitCode: X.OK, planDigestSha256: sha256(planJson) };
  }

  const projectRoot = path.resolve(deps.projectRoot ?? findWorkspaceRoot());
  const root = path.join(projectRoot, ...ACTIVITY_CHECK_ROOT_SEGMENTS);

  if (parsed.mode === "VERIFY") {
    const verifyPath = path.resolve(projectRoot, parsed.verifyDir);
    const v = verifyActivityCheckEvidence(verifyPath);
    log("[VERIFY] Offline and read-only: no configuration or credential loaded, nothing written.");
    log(
      `[VERIFY] Integrity: ${v.integrity.ok ? "OK" : `FAILED (${v.integrity.problems.join(", ")})`}`,
    );
    log(
      `[VERIFY] Recorded outcome: ${v.recorded?.outcome ?? "UNKNOWN"}; recorded page obtained: ${v.recorded?.pageObtained ? "yes" : "no"}`,
    );
    log(
      `[VERIFY] Computed reanalysis: ${v.computed?.reanalysisStatus ?? "UNKNOWN"}; computed outcome: ${v.computed?.outcome ?? "UNAVAILABLE"}`,
    );
    if (v.computed?.page) {
      const p = v.computed.page;
      log(
        `[VERIFY] Page metadata: returned=${p.counts.returned} succeeded=${p.counts.succeeded} failed=${p.counts.failed} nullBlockTime=${p.counts.nullBlockTime} truncatedHistory=${p.potentiallyTruncatedHistory ? "POTENTIALLY_TRUNCATED" : "no"}`,
      );
    }
    log(
      `[VERIFY] Non-certifications (all false): ${Object.keys(ACTIVITY_CHECK_NON_CERTIFICATIONS).join(", ")}`,
    );
    return {
      mode: "VERIFY",
      exitCode: activityVerifyExitCode(v),
      verification: v,
    };
  }

  const outDir = path.resolve(projectRoot, parsed.outDir);
  if (path.dirname(outDir) !== root || !RUN_NAME.test(path.basename(outDir))) {
    throw cliError(
      `--out-dir must name a new run directory directly inside ${ACTIVITY_CHECK_ROOT_SEGMENTS.join("/")}/`,
    );
  }
  const outRel = rel(projectRoot, outDir);
  if (existsSync(outDir)) {
    throw refusal(`[OUTPUT_EXISTS] ${outRel} already exists; refusing to overwrite`);
  }

  const plan = buildActivityCheckPlan({
    poolAddress: parsed.poolAddress,
    outDir: outRel,
    mode: parsed.mode,
  });
  const planJson = JSON.stringify(plan);
  const planDigestSha256 = sha256(planJson);

  if (parsed.mode === "DRY_RUN") {
    log("[DRY_RUN] No configuration loaded, no transport opened, nothing sent, nothing written.");
    log(`[DRY_RUN] Approval status: ${ACTIVITY_CHECK_APPROVAL_STATUS}`);
    log(`[DRY_RUN] Live execution: ${ACTIVITY_CHECK_LIVE_STATUS}`);
    log(`[DRY_RUN] Plan digest (sha256): ${planDigestSha256}`);
    log(planJson);
    return { mode: "DRY_RUN", exitCode: X.OK, planDigestSha256, outDir: outRel };
  }

  // --live path: configuration is loaded only after argument and exclusive-output checks pass.
  const C = ACTIVITY_CHECK_CONFIG_ERRORS;
  try {
    await (deps.loadEnvironment ?? loadConfiguredEnvironment)();
  } catch {
    throw refusal(C.configurationLoad);
  }
  const env = deps.env ?? process.env;
  const { resolveSolanaEndpoints } = await import("./paper-single-candidate-diagnostic.js");
  const endpoints = resolveSolanaEndpoints(env);
  const rpcUrlRaw = env.SOLANA_RPC_URL ?? "";
  if (rpcUrlRaw === "") throw refusal(C.rpcMissing);
  if (
    !endpoints.ok &&
    endpoints.error === "[INVALID_CONFIGURATION] SOLANA_RPC_URL is required and must be http/https"
  ) {
    throw refusal(C.rpcHttps);
  }
  let parsedRpc: URL;
  try {
    parsedRpc = new URL(rpcUrlRaw);
  } catch {
    throw refusal(C.rpcHttps);
  }
  if (parsedRpc.protocol !== "https:" || rpcUrlRaw.includes("#")) {
    throw refusal(C.rpcHttps);
  }

  let secrets: readonly string[];
  try {
    const urls = [
      rpcUrlRaw,
      ...(typeof env.SOLANA_WS_URL === "string" && env.SOLANA_WS_URL !== ""
        ? [env.SOLANA_WS_URL]
        : []),
    ];
    secrets = deriveEvidenceSecrets(urls, []);
  } catch {
    throw refusal(C.secretsInvalid);
  }

  log(`[LIVE] ${ACTIVITY_CHECK_LIVE_FLAG_MEANING}`);
  log(`[LIVE] Plan digest (sha256): ${planDigestSha256}`);

  const signals = deps.signals ?? process;
  const controller = new AbortController();
  const externalSignal = deps.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let listening = true;
  const listeners = new Map(
    ACTIVITY_CHECK_SIGNALS.map((s) => [
      s,
      () => {
        if (!listening || controller.signal.aborted) return;
        log(`[LIVE] ${s} received: cancelling request; sealing partial record`);
        controller.abort();
      },
    ]),
  );
  const attempted: ActivityCheckSignal[] = [];
  const signalCleanupFailures: string[] = [];
  let installFailed = false;
  let acquisition: ActivityCheckAcquisition | null = null;

  try {
    try {
      for (const s of ACTIVITY_CHECK_SIGNALS) {
        attempted.push(s);
        signals.on(s, listeners.get(s)!);
      }
    } catch {
      installFailed = true;
    }

    if (!installFailed) {
      acquisition = await runPoolActivityRequest({
        poolAddress: parsed.poolAddress,
        rpcUrl: rpcUrlRaw,
        fetchFn: deps.fetchFn ?? globalThis.fetch,
        clock: deps.clock,
        timers: deps.timers ?? defaultTimers,
        abortSignal: controller.signal,
      });
    }
  } finally {
    listening = false;
    externalSignal?.removeEventListener("abort", onExternalAbort);
    for (const s of attempted) {
      try {
        signals.removeListener(s, listeners.get(s)!);
      } catch {
        signalCleanupFailures.push(`SIGNAL_REMOVE_FAILED:${s}`);
      }
    }
  }

  if (installFailed || acquisition === null) {
    throw refusal(
      signalCleanupFailures.length === 0
        ? C.signalInstall
        : `${C.signalInstall}; listener cleanup failed: ${signalCleanupFailures.join(", ")}`,
    );
  }

  const finalAcquisition: ActivityCheckAcquisition =
    controller.signal.aborted && !acquisition.cancelled
      ? { ...acquisition, cancelled: true, cancellationPhase: "BEFORE_SEALING" }
      : acquisition;

  const redactedDetail = finalAcquisition.detail
    ? redactText(finalAcquisition.detail, secrets)
    : null;
  log(`[LIVE] Outcome: ${finalAcquisition.outcome}${redactedDetail ? ` (${redactedDetail})` : ""}`);

  const record = activityCheckRecord(finalAcquisition, secrets);
  const seal = sealActivityCheckEvidence({
    outDir,
    plan,
    record,
    secrets,
    writeFile: deps.writeFile,
  });

  if (!seal.ok) {
    log(`[LIVE] Sealing FAILED: ${seal.status} (${redactText(seal.reason, secrets)})`);
    return {
      mode: "LIVE",
      exitCode: activityLiveExitCode(null, seal, finalAcquisition.cancelled, signalCleanupFailures),
      planDigestSha256,
      outDir: outRel,
      acquisition: finalAcquisition,
      record,
      seal,
      signalCleanupFailures,
    };
  }

  const verification = verifyActivityCheckEvidence(outDir);
  const exitCode = activityLiveExitCode(
    verification,
    seal,
    finalAcquisition.cancelled,
    signalCleanupFailures,
  );
  log(`[LIVE] Evidence sealed: ${outRel} (manifest sha256 ${seal.manifestSha256})`);
  log(
    `[LIVE] Offline verification: ${verification.integrity.ok ? "OK" : `FAILED (${verification.integrity.problems.join(", ")})`}; reanalysis ${verification.computed?.reanalysisStatus ?? "UNKNOWN"}`,
  );
  if (verification.computed?.page) {
    const p = verification.computed.page;
    log(
      `[LIVE] Page metadata: returned=${p.counts.returned} succeeded=${p.counts.succeeded} failed=${p.counts.failed} nullBlockTime=${p.counts.nullBlockTime} truncatedHistory=${p.potentiallyTruncatedHistory ? "POTENTIALLY_TRUNCATED" : "no"}`,
    );
  }
  if (signalCleanupFailures.length > 0) {
    log(`[LIVE] Signal cleanup failures: ${signalCleanupFailures.join(", ")}`);
  }
  log(`[LIVE] Exit code ${exitCode}. No retries, WebSockets or follow-up observation.`);

  return {
    mode: "LIVE",
    exitCode,
    planDigestSha256,
    outDir: outRel,
    acquisition: finalAcquisition,
    record,
    seal,
    verification,
    signalCleanupFailures,
  };
}

export function settleCpmmActivityCheckProcess(
  exitCode: number,
  graceMs: number = ACTIVITY_CHECK_SHUTDOWN_GRACE_MS,
): void {
  process.exitCode = exitCode;
  const backstop = setTimeout(() => {
    console.error(ACTIVITY_CHECK_SHUTDOWN_FORCED_NOTICE, `after ${graceMs} ms`);
    process.exit(exitCode);
  }, graceMs);
  backstop.unref();
}

function fileIdentity(file: string): string | null {
  try {
    return realpathSync.native(path.resolve(file));
  } catch {
    return null;
  }
}

export function isCpmmActivityCheckMainModule(
  entryArg: string | undefined,
  moduleUrl: string,
): boolean {
  if (entryArg === undefined || entryArg === "") return false;
  const entry = fileIdentity(entryArg);
  return entry !== null && entry === fileIdentity(fileURLToPath(moduleUrl));
}

if (isCpmmActivityCheckMainModule(process.argv[1], import.meta.url)) {
  runCpmmPoolActivityCheckCli(process.argv.slice(2))
    .then((r) => settleCpmmActivityCheckProcess(r.exitCode))
    .catch((err: unknown) => {
      console.error("[CPMM_POOL_ACTIVITY_CHECK_ERROR]", printableActivityCheckError(err));
      settleCpmmActivityCheckProcess(ACTIVITY_CHECK_EXIT_CODES.INVALID);
    });
}
