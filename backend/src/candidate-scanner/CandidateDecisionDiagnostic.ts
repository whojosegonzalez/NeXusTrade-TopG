/**
 * NeXusTrade — Standalone Candidate Decision Diagnostic Runner
 *
 * Implements a strict, single-target offline acquisition and decision diagnostic:
 * - One exact target pool/mint: reference RAY/WSOL pool.
 * - Maximum 14 dispatched attempts enforced by GlobalResourceBudgetManager.
 * - Single-page history enumeration (20 records max) via ExactPoolHistoryEnumerator.
 * - Quiet-window verification with on-chain cutoff synchronization (getSlot + getBlockTime).
 * - Bounded stream observation with strict message, byte, and queue limits.
 * - Full pre-admission screening (LP burn >= 90%, explicitly observed renounced authorities).
 * - Exact spot pricing, actual marketCap required (FDV non-substitutable).
 * - Strict security evaluation reusing BuyGateTriggerService.fetchRugCheckMetrics.
 * - Isolated diagnostic artifact writing with tamper-evident SHA-256 manifests.
 * - Zero wallet operations, zero trading daemon execution, zero canonical state file writes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  RAYDIUM_AMM_V4_LAYOUT_LENGTH,
  WSOL_MINT,
  isCanonicalSolanaBase58,
  parseRaydiumAmmV4Account,
} from "../research/pilot/RaydiumAmmParser.js";
import {
  type TrackedRaydiumPoolContext,
  decodeRaydiumTransactionSwaps,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import { RaydiumCandidateSubscriptionCoordinator } from "./RaydiumCandidateSubscriptionCoordinator.js";
import { type ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import {
  MeteredWebSocketTransport,
  WsWebSocketTransport,
  createBoundedFetchTransport,
  BoundedResponseTooLargeError,
  type ISolanaKeepaliveWebSocketTransport,
  DEFAULT_KEEPALIVE_PING_INTERVAL_MS,
  DEFAULT_KEEPALIVE_MAX_PINGS,
  DEFAULT_KEEPALIVE_PONG_TIMEOUT_MS,
  DEFAULT_MAX_CONTROL_FRAMES,
  DEFAULT_MAX_CONTROL_FRAME_BYTES,
} from "./RaydiumTransportObservationProbe.js";
import {
  RaydiumAmmV4TransactionSourceAdapter,
  type ProcessNotificationResult,
  type TransactionProcessingOutcome,
} from "./RaydiumAmmV4TransactionSourceAdapter.js";
import type {
  ResolvedSignatureRecord,
  SignatureResolutionStatus,
} from "./ExactPoolTransactionResolutionBridge.js";
import {
  PAPER_FAILED_TRANSACTION_POLICY,
  canonicalJson,
  validateFailedTransactionEvidence,
} from "./ValidatedFailedTransactionEvidence.js";

/** Sealed active-window classification derived from a resolution status (one definition for sealing and replay). */
export function activeWindowResolutionClassification(
  status: unknown,
): "KNOWN_FAILED_TRANSACTION_ZERO_COMMITTED_SWAPS" | "EXECUTED_DECODED" | "UNRESOLVED" {
  return status === "RESOLVED_FAILED_TRANSACTION"
    ? "KNOWN_FAILED_TRANSACTION_ZERO_COMMITTED_SWAPS"
    : status === "RESOLVED"
      ? "EXECUTED_DECODED"
      : "UNRESOLVED";
}
import {
  RollingTradeFlowTracker,
  type StreamGap,
  type TradeEvent,
} from "./RollingTradeFlowTracker.js";
import {
  ExactPoolHistoryEnumerator,
  type HistorySignatureRecord,
  type HistoryPageQueryParams,
  type HistoryEnumerationResult,
} from "./ExactPoolHistoryEnumerator.js";
import {
  evaluateExactPoolWindowReconciliation,
  type SourceCutoffEvidence,
} from "./ExactPoolWindowReconciliationEvaluator.js";
import { PaperReconciledCandidateFlowAdapter } from "./PaperReconciledCandidateFlowAdapter.js";
import {
  type CandidateFlowProvider,
  type CandidateFlowResult,
  evaluateCandidateDecisionPoints,
  type CandidateDecisionResult,
} from "./CandidateFlowProvider.js";
import { BuyGateTriggerService } from "./BuyGateTriggerService.js";
import {
  adaptPaperBundlerSnapshot,
  type PaperBundlerExecutionContext,
} from "./PaperSolanaTrackerBundlerAdapter.js";
import { parseSolanaTrackerBundlersResponse } from "./SolanaTrackerBundlerParser.js";
import { parseSolanaRpcMintAccountResponse } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import {
  acquireRaydiumAmmV4Snapshot,
  type SnapshotAcquisitionResult,
} from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import { calculateAmmV4LpInaccessibleClaims } from "../research/pilot/RaydiumAmmLpAccounting.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import {
  deepRedactSensitiveObject,
  redactSensitiveText,
} from "./SolanaTrackerBundlerCaptureTool.js";
import { sanitizeSolanaRpcUrl } from "../research/pilot/SolanaRpcLiveObservationClient.js";
import type { WatchlistCandidateItem, TokenMintAddress } from "@nexustrade/shared";

export const CANONICAL_ZERO_ADDRESS = "11111111111111111111111111111111";

export type AuthorityStatus = "DISABLED" | "ACTIVE" | "MALFORMED" | "OMITTED";

export interface AuthorityEvaluation {
  readonly status: AuthorityStatus;
  readonly isRenounced: boolean;
  readonly isExplicitlyObserved: boolean;
  readonly rawValue: unknown;
  readonly address: string | null;
}

/**
 * Validates authority fields against the Solana RPC schema:
 * - OMITTED: Field is undefined or missing from RPC object
 * - DISABLED: Explicit literal null (authority disabled / COption::None)
 * - ACTIVE: Present canonical Solana Base58 public key (including canonical 32-byte addresses)
 * - MALFORMED: Textual placeholders ("none", "null", "undefined", ""), wrong casing, or invalid Base58
 */
export function evaluateAuthorityEvidence(info: unknown, fieldName: string): AuthorityEvaluation {
  if (info === null || typeof info !== "object" || !(fieldName in info)) {
    return {
      status: "OMITTED",
      isRenounced: false,
      isExplicitlyObserved: false,
      rawValue: undefined,
      address: null,
    };
  }
  const val = (info as Record<string, unknown>)[fieldName];
  if (val === undefined) {
    return {
      status: "OMITTED",
      isRenounced: false,
      isExplicitlyObserved: false,
      rawValue: undefined,
      address: null,
    };
  }
  if (val === null) {
    return {
      status: "DISABLED",
      isRenounced: true,
      isExplicitlyObserved: true,
      rawValue: null,
      address: null,
    };
  }
  if (typeof val === "string") {
    if (isCanonicalSolanaBase58(val)) {
      return {
        status: "ACTIVE",
        isRenounced: false,
        isExplicitlyObserved: true,
        rawValue: val,
        address: val,
      };
    }
    return {
      status: "MALFORMED",
      isRenounced: false,
      isExplicitlyObserved: false,
      rawValue: val,
      address: null,
    };
  }
  return {
    status: "MALFORMED",
    isRenounced: false,
    isExplicitlyObserved: false,
    rawValue: val,
    address: null,
  };
}

export function isRenouncedAuthority(authority: unknown, isExplicitlyObserved: boolean): boolean {
  if (!isExplicitlyObserved) return false;
  return authority === null;
}

/**
 * Returns the readyState of a WebSocket transport, checking both the direct property
 * and the underlying socket exposed via getUnderlyingSocket().
 */
export function getWebSocketTransportReadyState(transport: unknown): number | undefined {
  if (!transport || typeof transport !== "object") return undefined;
  const t = transport as {
    readyState?: number;
    getUnderlyingSocket?: () => unknown;
  };
  if (typeof t.readyState === "number") {
    return t.readyState;
  }
  if (typeof t.getUnderlyingSocket === "function") {
    const sock = t.getUnderlyingSocket() as { readyState?: number } | null | undefined;
    if (sock && typeof sock.readyState === "number") {
      return sock.readyState;
    }
  }
  return undefined;
}

export interface DiagnosticRequestRecord {
  readonly purpose: string;
  readonly provider: string;
  readonly endpoint: string;
  readonly method: string;
  readonly params?: unknown | undefined;
  readonly dispatchedAtMs: number;
  readonly completedAtMs: number;
  readonly httpStatus?: number | undefined;
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly wireDigestSha256?: string | undefined;
  readonly responseFile?: string | undefined;
  /** Body-size evidence; recorded for RUGCHECK_REPORT only. */
  readonly responseBodyMetadata?: ResponseBodyMetadata | undefined;
  /** Actual outgoing JSON-RPC id (Solana RPC requests only). */
  readonly rpcRequestId?: string | number | undefined;
  /** JSON-RPC id echoed in the parsed response, when present (Solana RPC requests only). */
  readonly rpcResponseId?: unknown;
}

/**
 * Response body size evidence. Provider-declared headers are metadata, not proof of the complete
 * decoded size (Content-Length describes the encoded transfer and may be absent or wrong).
 */
export interface ResponseBodyMetadata {
  /** Decoded-byte ceiling applied to this request. */
  readonly ceilingBytes: number;
  /** COMPLETE: entire decoded body retained. OVER_LIMIT: reading stopped at the ceiling.
   *  INCOMPLETE: body not fully read (abort, timeout, transport error). */
  readonly bodyStatus: "COMPLETE" | "OVER_LIMIT" | "INCOMPLETE";
  /** Provider-declared Content-Length header, verbatim, or null when absent. */
  readonly declaredContentLength: string | null;
  /** Provider-declared Content-Encoding header, verbatim, or null when absent. */
  readonly declaredContentEncoding: string | null;
  /** Decoded bytes retained in memory (complete body, or truncated prefix for OVER_LIMIT); null if unknown. */
  readonly retainedBytes: number | null;
  /** SHA-256 of the retained bytes (complete body or truncated prefix); null if unknown. */
  readonly retainedSha256: string | null;
  /** OVER_LIMIT only: decoded bytes counted when reading stopped — a lower bound on body size. */
  readonly observedBytesAtStopLowerBound: number | null;
}

/** Shared default decoded-response ceiling for every diagnostic HTTP purpose. */
export const DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
/** Hard cap for the opt-in RugCheck-only decoded-response ceiling (a response-byte ceiling, not process memory). */
export const DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Bound for cancelling and settling an overlapped RugCheck request before sealing. */
export const EARLY_RUGCHECK_SETTLE_BOUND_MS = 2_000;

/**
 * Validates the opt-in RugCheck diagnostic options. Throws [DIAGNOSTIC_INVALID_ARG] before any network use.
 */
export function validateRugCheckDiagnosticOptions(options: {
  readonly rugCheckMaxResponseBytes?: unknown;
  readonly overlapRugCheckWithMintPacing?: unknown;
}): void {
  const max = options.rugCheckMaxResponseBytes;
  if (
    max !== undefined &&
    (typeof max !== "number" ||
      !Number.isSafeInteger(max) ||
      max < 1 ||
      max > DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES)
  ) {
    throw new Error(
      `[DIAGNOSTIC_INVALID_ARG] rugCheckMaxResponseBytes must be an integer between 1 and ${DIAGNOSTIC_MAX_RUGCHECK_RESPONSE_BYTES} (4 MiB); received ${String(max)}`,
    );
  }
  const overlap = options.overlapRugCheckWithMintPacing;
  if (overlap !== undefined && typeof overlap !== "boolean") {
    throw new Error(
      `[DIAGNOSTIC_INVALID_ARG] overlapRugCheckWithMintPacing must be a boolean; received ${String(overlap)}`,
    );
  }
}

export interface DiagnosticRequestLedger {
  poolLayoutAttempts: number;
  priorAnchorAttempts: number;
  transactionDecodeAttempts: number;
  getSlotAttempts: number;
  getBlockTimeAttempts: number;
  historyEnumerationAttempts: number;
  exactPairAttempts: number;
  lpRefreshAttempts: number;
  candidateMintAttempts: number;
  rugCheckAttempts: number;
  solanaTrackerAttempts: number;
  totalAttempts: number;
  readonly records: DiagnosticRequestRecord[];
}

export interface CandidateDecisionDiagnosticOptions {
  readonly poolId: string;
  readonly mintAddress: string;
  readonly rpcUrl: string;
  readonly outDir?: string | undefined;
  readonly transport?: typeof fetch | undefined;
  readonly wsTransport?: ISolanaWebSocketTransport | undefined;
  readonly clock?: () => number;
  readonly sleeper?: (ms: number) => Promise<void>;
  readonly executionContext?: "PRODUCTION" | "PAPER_SIMULATION" | "BACKTEST" | undefined;
  readonly overallTimeoutMs?: number | undefined; // default 90_000 ms
  readonly requestTimeoutMs?: number | undefined; // default 10_000 ms
  readonly observationDurationMs?: number | undefined; // default 65_000 ms
  readonly isLive?: boolean | undefined;
  readonly solanaTrackerApiKey?: string | undefined;
  readonly rugCheckApiUrl?: string | undefined;
  readonly solanaTrackerApiUrl?: string | undefined;
  readonly dexScreenerApiUrl?: string | undefined;
  readonly keepalive?: boolean | undefined;
  readonly pingIntervalMs?: number | undefined;
  readonly maxPings?: number | undefined;
  readonly pongTimeoutMs?: number | undefined;
  readonly maxControlFrames?: number | undefined;
  readonly maxControlFrameBytes?: number | undefined;
  /**
   * OPT-IN: decoded-response ceiling for RUGCHECK_REPORT only (1..4 MiB). Omitted: the shared 1 MiB ceiling.
   * Every other purpose always keeps the shared 1 MiB ceiling.
   */
  readonly rugCheckMaxResponseBytes?: number | undefined;
  /**
   * OPT-IN: dispatch RUGCHECK_REPORT once validated LP evidence passes the unchanged 90% rule, overlapping
   * the provider pacing wait before CANDIDATE_MINT. May spend one RugCheck request before an authority
   * rejection; it never admits a candidate. Omitted/false: serial retrieval after pre-admission passes.
   */
  readonly overlapRugCheckWithMintPacing?: boolean | undefined;
  /**
   * OPT-IN (PAPER_SIMULATION / BACKTEST only): qualify fully reconciled ACTIVE 60-second windows whose every
   * in-window signature was resolved by the existing stream decode path. Selects the PAPER_ACTIVE_WINDOW_20_9
   * capacity profile (20 HTTP attempts, 9 retrievals, bounded pre-cutoff drain). Omitted/false: quiet-window-only
   * flow qualification under the default 14/3 profile (unchanged default).
   */
  readonly paperActiveWindowFlow?: boolean | undefined;
}

/** Maps a stream decode outcome to the resolution status the reconciliation evaluator consumes. */
function toResolutionStatus(outcome: TransactionProcessingOutcome): SignatureResolutionStatus {
  switch (outcome) {
    case "SUCCESS":
      return "RESOLVED";
    case "TRANSACTION_NOT_FOUND":
      return "TRANSACTION_UNAVAILABLE";
    case "PRE_DISPATCH_BUDGET_DENIED":
      return "BUDGET_DENIED";
    case "PRE_DISPATCH_DEADLINE_EXCEEDED":
    case "REQUEST_TIMEOUT":
      return "DEADLINE_EXCEEDED";
    case "INGEST_FAILED":
      return "FAILED_INGEST";
    case "PARTIAL_INGEST_FAILED":
      return "PARTIAL_INGEST";
    case "DUPLICATE_NOTIFICATION":
      return "DUPLICATE_UNRESOLVED";
    default:
      return "FAILED_DECODE";
  }
}

/**
 * Builds explicit per-signature resolution records from stream decode results. A record is RESOLVED only when
 * the decode succeeded AND the transaction's slot/blockTime were read from its own getTransaction response.
 * Duplicate notifications add no record (the first result for the signature stands).
 */
export function buildStreamResolutionRecords(
  streamResults: readonly ProcessNotificationResult[],
  txIdentityBySignature: ReadonlyMap<
    string,
    { readonly slot: number; readonly blockTime: number | null }
  >,
): ResolvedSignatureRecord[] {
  const records: ResolvedSignatureRecord[] = [];
  const seen = new Set<string>();
  for (const r of streamResults) {
    if (r.outcome === "DUPLICATE_NOTIFICATION" || seen.has(r.signature)) continue;
    seen.add(r.signature);
    const identity = txIdentityBySignature.get(r.signature);
    const succeeded = r.ok && r.outcome === "SUCCESS" && identity !== undefined;
    // PAPER opt-in only (the adapter emits KNOWN_FAILED_TRANSACTION solely under its explicit policy).
    const knownFailed =
      r.ok &&
      r.outcome === "KNOWN_FAILED_TRANSACTION" &&
      identity !== undefined &&
      r.diagnostics?.knownFailedTransaction !== undefined;
    records.push({
      signature: r.signature,
      slot: identity?.slot ?? -1,
      blockTime: identity?.blockTime ?? null,
      status: succeeded
        ? "RESOLVED"
        : knownFailed
          ? "RESOLVED_FAILED_TRANSACTION"
          : toResolutionStatus(
              r.outcome === "SUCCESS" || r.outcome === "KNOWN_FAILED_TRANSACTION"
                ? "MALFORMED_RESPONSE"
                : r.outcome,
            ),
      adapterOutcome: r.outcome,
      decodedEventsCount: r.diagnostics?.decodedEventsCount ?? 0,
      ingestedEventsCount: r.ingestedEventsCount,
      ...(knownFailed ? { knownFailedTransaction: r.diagnostics.knownFailedTransaction } : {}),
      ...(succeeded || knownFailed
        ? {}
        : { error: r.diagnostics?.error ?? `Stream decode outcome ${r.outcome}` }),
    });
  }
  return records;
}

/**
 * Explicit diagnostic capacity profile. Replay accepts only the exact definitions below (never arbitrary numbers
 * supplied by a capture). Default runs use DEFAULT_14_3; only the PAPER active-window opt-in selects 20/9.
 */
export interface DiagnosticCapacityProfile {
  readonly id: "DEFAULT_14_3" | "PAPER_ACTIVE_WINDOW_20_9";
  /** HTTP attempts across all providers. */
  readonly maxTotalRequests: number;
  /** TRANSACTION_DECODING retrievals, including drain retrievals. */
  readonly maxTransactionRetrievals: number;
  /** Retrievals dispatched at or after the fixed nominal observation end. */
  readonly maxDrainRetrievals: number;
  /** GET_SLOT must dispatch within this many ms of the nominal observation end (null: legacy, unbounded). */
  readonly cutoffDispatchWindowMs: number | null;
  /** Fixed nominal observation (null: configurable in default runs). */
  readonly nominalObservationMs: number | null;
  /** Fixed overall deadline (null: configurable in default runs). */
  readonly overallDeadlineMs: number | null;
  readonly queueCeiling: number;
  readonly rpcPacingMs: number;
  readonly cutoffFreshnessMs: number;
}

export const DEFAULT_CAPACITY_PROFILE: DiagnosticCapacityProfile = Object.freeze({
  id: "DEFAULT_14_3",
  maxTotalRequests: 14,
  maxTransactionRetrievals: 3,
  maxDrainRetrievals: 0,
  cutoffDispatchWindowMs: null,
  nominalObservationMs: null,
  overallDeadlineMs: null,
  queueCeiling: 10,
  rpcPacingMs: 2500,
  cutoffFreshnessMs: 15_000,
});

export const PAPER_ACTIVE_WINDOW_CAPACITY_PROFILE: DiagnosticCapacityProfile = Object.freeze({
  id: "PAPER_ACTIVE_WINDOW_20_9",
  maxTotalRequests: 20,
  maxTransactionRetrievals: 9,
  maxDrainRetrievals: 2,
  cutoffDispatchWindowMs: 5_000,
  nominalObservationMs: 65_000,
  overallDeadlineMs: 90_000,
  queueCeiling: 10,
  rpcPacingMs: 2500,
  cutoffFreshnessMs: 15_000,
});

const SUPPORTED_CAPACITY_PROFILES: readonly DiagnosticCapacityProfile[] = Object.freeze([
  DEFAULT_CAPACITY_PROFILE,
  PAPER_ACTIVE_WINDOW_CAPACITY_PROFILE,
]);

/**
 * A projected retrieval dispatch within this guard of the nominal end is treated as a drain retrieval when
 * reserving drain allowances, so pacing-sleep overshoot cannot turn it into an unreserved drain retrieval.
 */
const DRAIN_CLASSIFICATION_GUARD_MS = 250;

/** RaydiumAmmV4TransactionSourceAdapter per-operation timeout ceiling (its default overallTimeoutMs). */
const DEFAULT_ADAPTER_OPERATION_CEILING_MS = 60_000;

/** Sealed timing evidence for the bounded (20/9) observation schedule. */
export interface BoundedObservationSchedule {
  readonly nominalObservationEndMs: number;
  readonly getSlotDispatchDeadlineMs: number;
  /** TRANSACTION_DECODING dispatched at or after the nominal end. */
  readonly drainRetrievals: number;
  /** Dispatched before the nominal end, completed at or after it (no extra allowance). */
  readonly boundaryCrossingRetrievals: number;
  readonly getSlotDispatchedAtMs: number | null;
  /** TRANSACTION_DECODING dispatched at or after GET_SLOT dispatch (must be 0). */
  readonly retrievalsAfterGetSlot: number;
  readonly stopReason: string | null;
}

/** Derives schedule counts from ledger records (shared by sealing and replay). */
export function deriveBoundedScheduleCounts(
  records: readonly unknown[],
  nominalObservationEndMs: number,
): Pick<
  BoundedObservationSchedule,
  | "drainRetrievals"
  | "boundaryCrossingRetrievals"
  | "getSlotDispatchedAtMs"
  | "retrievalsAfterGetSlot"
> {
  const recs = records.filter(
    (r): r is { purpose: string; dispatchedAtMs: number; completedAtMs: number } =>
      !!r &&
      typeof r === "object" &&
      typeof (r as { purpose?: unknown }).purpose === "string" &&
      typeof (r as { dispatchedAtMs?: unknown }).dispatchedAtMs === "number" &&
      typeof (r as { completedAtMs?: unknown }).completedAtMs === "number",
  );
  const tx = recs.filter((r) => r.purpose === "TRANSACTION_DECODING");
  const getSlot = recs.find((r) => r.purpose === "GET_SLOT");
  const getSlotDispatchedAtMs = getSlot ? getSlot.dispatchedAtMs : null;
  return {
    drainRetrievals: tx.filter((r) => r.dispatchedAtMs >= nominalObservationEndMs).length,
    boundaryCrossingRetrievals: tx.filter(
      (r) =>
        r.dispatchedAtMs < nominalObservationEndMs && r.completedAtMs >= nominalObservationEndMs,
    ).length,
    getSlotDispatchedAtMs,
    retrievalsAfterGetSlot:
      getSlotDispatchedAtMs === null
        ? 0
        : tx.filter((r) => r.dispatchedAtMs >= getSlotDispatchedAtMs).length,
  };
}

export interface CandidateDecisionDiagnosticResult {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  readonly poolId: string;
  readonly mintAddress: string;
  readonly executionContext: "PRODUCTION" | "PAPER_SIMULATION" | "BACKTEST";
  readonly ledger: DiagnosticRequestLedger;
  readonly provisionalContext?: TrackedRaydiumPoolContext | undefined;
  readonly validatedIdentitiesMatch?: boolean | undefined;
  readonly candidateMarketData?:
    | {
        readonly symbol: string;
        readonly spotPriceSol: number;
        readonly spotPriceUsd: number | null;
        readonly liquidityUsd: number;
        readonly marketCapUsd: number;
        readonly fdvUsd: number | null;
        readonly assetAgeSeconds: number;
        readonly volume5mUsd: number;
        readonly buys5m: number;
        readonly sells5m: number;
        readonly buyToSellRatio: number;
        readonly priceChange1hPct?: number | undefined;
        readonly momentum5mBps?: number | undefined;
      }
    | undefined;
  readonly candidateMintAccount?:
    | {
        readonly decimals?: number | undefined;
        readonly mintAuthority?: string | null | undefined;
        readonly freezeAuthority?: string | null | undefined;
        readonly mintAuthorityStatus?: AuthorityStatus | undefined;
        readonly freezeAuthorityStatus?: AuthorityStatus | undefined;
        readonly mintAuthorityRenounced: boolean;
        readonly freezeAuthorityRenounced: boolean;
      }
    | undefined;
  readonly preAdmissionScreening?:
    | {
        readonly lpBurnPct: number | null;
        readonly lpSecurityPassed: boolean;
        readonly mintAuthorityPassed: boolean;
        readonly freezeAuthorityPassed: boolean;
        readonly passed: boolean;
        readonly rejectionReason?: string | undefined;
      }
    | undefined;
  readonly flowEvaluation?:
    | {
        readonly flowCoverage: string;
        readonly isCoverageSufficient: boolean;
        readonly recentBuys60s: number | null;
        readonly recentSells60s: number | null;
        readonly isPaperQualified?: boolean | undefined;
        readonly diagnosticReason: string;
        readonly windowStartMs?: number | undefined;
        readonly windowEndMs?: number | undefined;
      }
    | undefined;
  readonly decisionResult?: CandidateDecisionResult | undefined;
  readonly observationMetadata?:
    | {
        readonly observationStartMs: number;
        readonly observationEndMs: number;
        readonly observationDurationMs: number;
        /** null when the run stopped before the on-chain cutoff was acquired (never synthesized). */
        readonly cutoffTimestampMs: number | null;
        readonly notificationsReceived: number;
      }
    | undefined;
  readonly keepaliveMetrics?:
    | {
        readonly clientPingsSentCount: number;
        readonly matchedClientPongsCount: number;
        readonly unmatchedClientPongsCount: number;
        readonly controlFramesCount: number;
        readonly controlFramePayloadBytes: number;
      }
    | undefined;
  readonly outDir?: string | undefined;
  readonly manifestDigestSha256?: string | undefined;
  writeError?: string | undefined;
  /** Selected capacity profile (new captures; absent in historical captures = legacy 14/3 interpretation). */
  readonly capacityProfile?: DiagnosticCapacityProfile | undefined;
  /** Bounded observation timing evidence (PAPER_ACTIVE_WINDOW_20_9 runs that started observing). */
  readonly observationSchedule?: BoundedObservationSchedule | undefined;
}

interface EarlyRugCheckHandle {
  readonly controller: AbortController;
  readonly retrievedAtMs: number;
  readonly settled: Promise<
    | { readonly kind: "fulfilled"; readonly res: MeteredResponse }
    | { readonly kind: "rejected"; readonly err: unknown }
  >;
}

interface MeteredResponse {
  ok: boolean;
  status: number;
  text: string;
  json: unknown | null;
  error?: string | undefined;
}

interface RecordedResponse {
  readonly index: number;
  readonly purpose: string;
  readonly rawWireBytes: Buffer;
  readonly text: string;
  readonly json: unknown | null;
  readonly wireDigestSha256: string;
  readonly ok: boolean;
  readonly httpStatus: number;
  readonly responseFile: string;
}

function safeJsonStringify(val: unknown): string {
  return JSON.stringify(
    val,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}

export class CandidateDecisionDiagnostic {
  private readonly poolId: string;
  private readonly mintAddress: string;
  private readonly rpcUrl: string;
  private readonly outDir?: string | undefined;
  private readonly transport: typeof fetch;
  private readonly rugCheckTransport: typeof fetch;
  private readonly rugCheckMaxResponseBytes: number;
  private readonly overlapRugCheckWithMintPacing: boolean;
  private pendingEarlyRugCheck: EarlyRugCheckHandle | null = null;
  /** First HTTP 429 observed on any request. Once set, no further request is dispatched. */
  private fatalDispatchStop: Error | null = null;
  /** Fatal failure of the overlapped RugCheck request; preserved as the run's original stop cause. */
  private earlyRugCheckFatalCause: Error | null = null;
  private readonly wsTransportOption?: ISolanaWebSocketTransport | undefined;
  private readonly clock: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;
  private readonly executionContext: "PRODUCTION" | "PAPER_SIMULATION" | "BACKTEST";
  private readonly overallTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly observationDurationMs: number;
  private readonly isLive: boolean;
  private readonly solanaTrackerApiKey?: string | undefined;
  private readonly rugCheckApiUrl: string;
  private readonly solanaTrackerApiUrl: string;
  private readonly dexScreenerApiUrl: string;
  private readonly keepalive: boolean;
  private readonly pingIntervalMs: number;
  private readonly maxPings: number;
  private readonly pongTimeoutMs: number;
  private readonly maxControlFrames: number;
  private readonly maxControlFrameBytes: number;

  private readonly ledger: DiagnosticRequestLedger = {
    poolLayoutAttempts: 0,
    priorAnchorAttempts: 0,
    transactionDecodeAttempts: 0,
    getSlotAttempts: 0,
    getBlockTimeAttempts: 0,
    historyEnumerationAttempts: 0,
    exactPairAttempts: 0,
    lpRefreshAttempts: 0,
    candidateMintAttempts: 0,
    rugCheckAttempts: 0,
    solanaTrackerAttempts: 0,
    totalAttempts: 0,
    records: [],
  };

  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly sensitiveTokens: string[] = [];
  private readonly recordedResponses: RecordedResponse[] = [];

  private retainedLpEvidence?: unknown;
  private retainedSourceCutoff?: SourceCutoffEvidence;
  private retainedHistoryResult?: unknown;
  private retainedCandidateMarketData?: unknown;
  private retainedCandidateMintAccount?: unknown;
  private retainedPreAdmissionScreening?: unknown;
  private retainedBundlerEvidence?: unknown;
  private retainedRugCheckEvidence?: unknown;
  private retainedProvisionalContext?: TrackedRaydiumPoolContext;
  private retainedActiveWindowEvidence?: unknown;
  /** Early-stop stream telemetry (failure paths only), sealed as evidence/stream-telemetry.json. */
  private retainedStreamTelemetry?: unknown;
  /** Captures stream state at an exception, before finally-block cleanup (set once observation is wired). */
  private streamExceptionCapture: ((reason: string) => void) | null = null;
  /** Builds observation/keepalive report fields and stream telemetry from the live observation state. */
  private streamTelemetryFinalizer:
    | (() => {
        observationMetadata?: CandidateDecisionDiagnosticResult["observationMetadata"];
        keepaliveMetrics?: CandidateDecisionDiagnosticResult["keepaliveMetrics"];
        telemetry: unknown;
      })
    | null = null;
  private readonly paperActiveWindowFlow: boolean;
  private readonly capacityProfile: DiagnosticCapacityProfile;
  /** Bounded schedule base (set at observation start in 20/9 runs). */
  private boundedScheduleBase: {
    readonly nominalObservationEndMs: number;
    readonly getSlotDispatchDeadlineMs: number;
  } | null = null;
  private boundedStopReason: string | null = null;

  constructor(options: CandidateDecisionDiagnosticOptions) {
    if (!options.poolId || !isCanonicalSolanaBase58(options.poolId)) {
      throw new Error(`[DIAGNOSTIC_INVALID_ARG] Invalid canonical poolId: ${options.poolId}`);
    }
    if (!options.mintAddress || !isCanonicalSolanaBase58(options.mintAddress)) {
      throw new Error(
        `[DIAGNOSTIC_INVALID_ARG] Invalid canonical mintAddress: ${options.mintAddress}`,
      );
    }
    if (!options.rpcUrl || options.rpcUrl.trim() === "") {
      throw new Error("[DIAGNOSTIC_INVALID_ARG] rpcUrl is required");
    }

    validateRugCheckDiagnosticOptions(options);
    if (
      options.paperActiveWindowFlow !== undefined &&
      typeof options.paperActiveWindowFlow !== "boolean"
    ) {
      throw new Error(
        `[DIAGNOSTIC_INVALID_ARG] paperActiveWindowFlow must be a boolean; received ${String(options.paperActiveWindowFlow)}`,
      );
    }
    if (
      options.paperActiveWindowFlow === true &&
      options.executionContext !== "PAPER_SIMULATION" &&
      options.executionContext !== "BACKTEST"
    ) {
      throw new Error(
        "[DIAGNOSTIC_INVALID_ARG] paperActiveWindowFlow requires executionContext PAPER_SIMULATION or BACKTEST",
      );
    }
    this.paperActiveWindowFlow = options.paperActiveWindowFlow === true;
    this.rugCheckMaxResponseBytes =
      options.rugCheckMaxResponseBytes ?? DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES;
    this.overlapRugCheckWithMintPacing = options.overlapRugCheckWithMintPacing === true;

    this.poolId = options.poolId;
    this.mintAddress = options.mintAddress;
    this.rpcUrl = options.rpcUrl;
    this.outDir = options.outDir;
    this.isLive = options.isLive ?? false;

    if (this.outDir) {
      const existingReport = path.join(this.outDir, "diagnostic-report.json");
      const existingManifest = path.join(this.outDir, "evidence-manifest.json");
      if (existsSync(existingReport) || existsSync(existingManifest)) {
        throw new Error(
          `[DIAGNOSTIC_OUTPUT_EXISTS] Target output directory already contains diagnostic artifacts: ${this.outDir}. Refusing to overwrite.`,
        );
      }
    }

    // Strict offline mode requirements: require explicitly injected transports
    this.wsTransportOption = options.wsTransport;
    if (!this.isLive) {
      if (!options.transport) {
        throw new Error("[DIAGNOSTIC_INVALID_ARG] Offline mode requires injected transport");
      }
      if (!options.wsTransport) {
        throw new Error("[DIAGNOSTIC_INVALID_ARG] Offline mode requires injected wsTransport");
      }
    }
    const baseTransport = options.transport ?? globalThis.fetch;
    this.transport = createBoundedFetchTransport(
      baseTransport,
      DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.rugCheckTransport =
      this.rugCheckMaxResponseBytes === DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES
        ? this.transport
        : createBoundedFetchTransport(baseTransport, this.rugCheckMaxResponseBytes);

    this.clock = options.clock ?? (() => Date.now());
    this.sleeper =
      options.sleeper ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.executionContext = options.executionContext ?? "PRODUCTION";
    this.overallTimeoutMs = options.overallTimeoutMs ?? 90_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.observationDurationMs = options.observationDurationMs ?? 65_000;
    this.solanaTrackerApiKey = options.solanaTrackerApiKey;
    this.rugCheckApiUrl = options.rugCheckApiUrl ?? "https://api.rugcheck.xyz";
    this.solanaTrackerApiUrl = options.solanaTrackerApiUrl ?? "https://data.solanatracker.io";
    this.dexScreenerApiUrl = options.dexScreenerApiUrl ?? "https://api.dexscreener.com";

    // Keepalive and control frame settings
    this.keepalive = options.keepalive ?? true;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_KEEPALIVE_PING_INTERVAL_MS;
    this.maxPings = options.maxPings ?? DEFAULT_KEEPALIVE_MAX_PINGS;
    this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_KEEPALIVE_PONG_TIMEOUT_MS;
    this.maxControlFrames = options.maxControlFrames ?? DEFAULT_MAX_CONTROL_FRAMES;
    this.maxControlFrameBytes = options.maxControlFrameBytes ?? DEFAULT_MAX_CONTROL_FRAME_BYTES;

    // Extract all credential tokens from RPC URL and API keys for comprehensive redaction
    const rpcSanitized = sanitizeSolanaRpcUrl(this.rpcUrl);
    for (const token of rpcSanitized.sensitiveTokens) {
      if (token && token.length > 2 && !this.sensitiveTokens.includes(token)) {
        this.sensitiveTokens.push(token);
      }
    }
    if (this.solanaTrackerApiKey && !this.sensitiveTokens.includes(this.solanaTrackerApiKey)) {
      this.sensitiveTokens.push(this.solanaTrackerApiKey);
    }

    // Capacity profile: the PAPER active-window opt-in selects 20/9 with a fixed 65 s observation and 90 s deadline;
    // every other run keeps the default 14/3.
    this.capacityProfile = this.paperActiveWindowFlow
      ? PAPER_ACTIVE_WINDOW_CAPACITY_PROFILE
      : DEFAULT_CAPACITY_PROFILE;
    if (
      this.capacityProfile.nominalObservationMs !== null &&
      this.observationDurationMs !== this.capacityProfile.nominalObservationMs
    ) {
      throw new Error(
        `[DIAGNOSTIC_INVALID_ARG] ${this.capacityProfile.id} requires observationDurationMs ${this.capacityProfile.nominalObservationMs}; received ${this.observationDurationMs}`,
      );
    }
    if (
      this.capacityProfile.overallDeadlineMs !== null &&
      this.overallTimeoutMs !== this.capacityProfile.overallDeadlineMs
    ) {
      throw new Error(
        `[DIAGNOSTIC_INVALID_ARG] ${this.capacityProfile.id} requires overallTimeoutMs ${this.capacityProfile.overallDeadlineMs}; received ${this.overallTimeoutMs}`,
      );
    }

    // Configure diagnostic budget from the selected profile (0 forward reservation, 2500 ms pacing)
    this.budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: this.capacityProfile.maxTotalRequests,
      maxEnrichmentAttempts: this.capacityProfile.maxTotalRequests,
      minReservedForwardRequests: 0,
      minProviderSpacingMs: 2500,
      clock: this.clock,
    });
  }

  public getLedger(): DiagnosticRequestLedger {
    return this.ledger;
  }

  public getBudgetManager(): GlobalResourceBudgetManager {
    return this.budgetManager;
  }

  public getCapacityProfile(): DiagnosticCapacityProfile {
    return this.capacityProfile;
  }

  /** Report fields for the selected profile and (bounded runs) the sealed observation schedule. */
  private capacityReportFields(): Pick<
    CandidateDecisionDiagnosticResult,
    "capacityProfile" | "observationSchedule"
  > {
    const base = this.boundedScheduleBase;
    return {
      capacityProfile: this.capacityProfile,
      ...(base
        ? {
            observationSchedule: {
              ...base,
              ...deriveBoundedScheduleCounts(this.ledger.records, base.nominalObservationEndMs),
              stopReason: this.boundedStopReason,
            },
          }
        : {}),
    };
  }

  /**
   * Cancellable sleeper racing wait against abort signal.
   */
  private async sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error(`[OPERATION_ABORTED] Sleep aborted: ${String(signal.reason ?? "Aborted")}`);
    }
    if (ms <= 0) return;

    if (!signal) {
      await this.sleeper(ms);
      return;
    }

    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(
          new Error(`[OPERATION_ABORTED] Sleep aborted: ${String(signal.reason ?? "Aborted")}`),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      await Promise.race([this.sleeper(ms), abortPromise]);
    } finally {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /** Refuses any dispatch once a fatal provider stop (HTTP 429) has been observed. */
  private throwIfDispatchStopped(purpose: string): void {
    const stop = this.fatalDispatchStop;
    if (stop) {
      throw new Error(
        `[DISPATCH_STOPPED] ${purpose} not dispatched after fatal stop: ${stop.message}`,
      );
    }
  }

  /**
   * Internal metered request dispatch wrapper enforcing shared budget, provider pacing,
   * deadline racing, body read timeouts, wire digest hashing before decode, and fail-closed HTTP 429 aborts.
   */
  private async dispatchMeteredRequest(params: {
    purpose:
      | "POOL_LAYOUT"
      | "PRIOR_ANCHOR"
      | "TRANSACTION_DECODING"
      | "GET_SLOT"
      | "GET_BLOCK_TIME"
      | "HISTORY_ENUMERATION"
      | "EXACT_PAIR"
      | "LP_REFRESH"
      | "CANDIDATE_MINT"
      | "RUGCHECK_REPORT"
      | "SOLANA_TRACKER_BUNDLERS";
    providerName: string;
    url: string;
    method?: string | undefined;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
    requestParams?: unknown | undefined;
    signal?: AbortSignal | undefined;
    customTimeoutMs?: number | undefined;
    skipBudgetRecording?: boolean | undefined;
    overallDeadlineMs?: number | undefined;
    rpcRequestId?: string | number | undefined;
    /** Latest permitted dispatch time, including any pacing wait (bounded cutoff dispatch). */
    latestDispatchAtMs?: number | undefined;
  }): Promise<{
    ok: boolean;
    status: number;
    text: string;
    json: unknown | null;
    error?: string | undefined;
  }> {
    const {
      purpose,
      providerName,
      url,
      method = "GET",
      headers = {},
      body,
      requestParams,
      signal,
      customTimeoutMs = this.requestTimeoutMs,
      skipBudgetRecording = false,
      overallDeadlineMs,
      rpcRequestId,
      latestDispatchAtMs,
    } = params;

    // 0. Pre-flight fatal-stop, abort and deadline checks
    this.throwIfDispatchStopped(purpose);
    if (signal?.aborted) {
      throw new Error(
        `[OPERATION_ABORTED] Signal already aborted before ${purpose}: ${String(signal.reason)}`,
      );
    }
    if (overallDeadlineMs !== undefined && this.clock() >= overallDeadlineMs) {
      throw new Error(
        `[OVERALL_DIAGNOSTIC_TIMEOUT] Overall diagnostic deadline exceeded before ${purpose}`,
      );
    }

    // 1. Budget manager admission check & pacing (if not skipped by caller)
    if (!skipBudgetRecording) {
      let check = this.budgetManager.canMakeRequest(
        providerName,
        this.clock(),
        "CANDIDATE_ENRICHMENT",
      );
      if (
        latestDispatchAtMs !== undefined &&
        this.clock() +
          (!check.allowed &&
          check.reason === "PROVIDER_PACING_NOT_MET" &&
          typeof check.waitMs === "number"
            ? check.waitMs
            : 0) >
          latestDispatchAtMs
      ) {
        throw new Error(
          `[CUTOFF_DISPATCH_WINDOW_EXCEEDED] ${purpose} cannot dispatch (including pacing) by ${latestDispatchAtMs}`,
        );
      }
      if (
        !check.allowed &&
        check.reason === "PROVIDER_PACING_NOT_MET" &&
        typeof check.waitMs === "number"
      ) {
        if (signal?.aborted) {
          throw new Error(
            `[OPERATION_ABORTED] Signal aborted before pacing for ${purpose}: ${String(signal.reason)}`,
          );
        }
        await this.sleepWithAbort(check.waitMs, signal);
        if (signal?.aborted) {
          throw new Error(
            `[OPERATION_ABORTED] Signal aborted after pacing for ${purpose}: ${String(signal.reason)}`,
          );
        }
        check = this.budgetManager.canMakeRequest(
          providerName,
          this.clock(),
          "CANDIDATE_ENRICHMENT",
        );
      }

      if (!check.allowed) {
        throw new Error(
          `[BUDGET_DENIED] ${purpose} denied by GlobalResourceBudgetManager: ${check.reason}`,
        );
      }
      if (latestDispatchAtMs !== undefined && this.clock() > latestDispatchAtMs) {
        throw new Error(
          `[CUTOFF_DISPATCH_WINDOW_EXCEEDED] ${purpose} pacing ended after the latest dispatch time ${latestDispatchAtMs}`,
        );
      }

      this.budgetManager.recordRequestAttempt(providerName, "CANDIDATE_ENRICHMENT", this.clock());
    }

    // Check fatal stop and cancellation immediately before dispatch (after any pacing wait)
    this.throwIfDispatchStopped(purpose);
    if (signal?.aborted) {
      throw new Error(
        `[OPERATION_ABORTED] Signal aborted immediately before dispatching ${purpose}: ${String(signal.reason)}`,
      );
    }
    if (overallDeadlineMs !== undefined && this.clock() >= overallDeadlineMs) {
      throw new Error(
        `[OVERALL_DIAGNOSTIC_TIMEOUT] Overall deadline exceeded immediately before dispatching ${purpose}`,
      );
    }

    // 2. Count attempt in ledger
    this.ledger.totalAttempts++;
    switch (purpose) {
      case "POOL_LAYOUT":
        this.ledger.poolLayoutAttempts++;
        break;
      case "PRIOR_ANCHOR":
        this.ledger.priorAnchorAttempts++;
        break;
      case "TRANSACTION_DECODING":
        this.ledger.transactionDecodeAttempts++;
        break;
      case "GET_SLOT":
        this.ledger.getSlotAttempts++;
        break;
      case "GET_BLOCK_TIME":
        this.ledger.getBlockTimeAttempts++;
        break;
      case "HISTORY_ENUMERATION":
        this.ledger.historyEnumerationAttempts++;
        break;
      case "EXACT_PAIR":
        this.ledger.exactPairAttempts++;
        break;
      case "LP_REFRESH":
        this.ledger.lpRefreshAttempts++;
        break;
      case "CANDIDATE_MINT":
        this.ledger.candidateMintAttempts++;
        break;
      case "RUGCHECK_REPORT":
        this.ledger.rugCheckAttempts++;
        break;
      case "SOLANA_TRACKER_BUNDLERS":
        this.ledger.solanaTrackerAttempts++;
        break;
    }

    const dispatchedAtMs = this.clock();

    // Compute effective request timeout
    const remainingOverallMs =
      overallDeadlineMs !== undefined
        ? Math.max(1, overallDeadlineMs - this.clock())
        : customTimeoutMs;
    const effectiveTimeoutMs = Math.min(customTimeoutMs, remainingOverallMs);

    const reqController = new AbortController();
    const reqTimeout = setTimeout(() => reqController.abort("REQUEST_TIMEOUT"), effectiveTimeoutMs);

    const onCallerAbort = () => {
      reqController.abort(signal?.reason ?? "CALLER_ABORTED");
    };
    if (signal) {
      if (signal.aborted) {
        onCallerAbort();
      } else {
        signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    const abortPromise = new Promise<never>((_, reject) => {
      if (reqController.signal.aborted) {
        reject(
          new Error(`[REQUEST_ABORTED] ${purpose} aborted: ${String(reqController.signal.reason)}`),
        );
        return;
      }
      reqController.signal.addEventListener(
        "abort",
        () =>
          reject(
            new Error(
              `[REQUEST_ABORTED] ${purpose} aborted: ${String(reqController.signal.reason)}`,
            ),
          ),
        { once: true },
      );
    });

    let httpStatus = 0;
    let rawText = "";
    let wireDigestSha256 = "";
    let rawWireBytes = Buffer.alloc(0);
    let ok = false;
    let errorMessage: string | undefined;
    let declaredContentLength: string | null = null;
    let declaredContentEncoding: string | null = null;
    let bodyComplete = false;
    let overflow: BoundedResponseTooLargeError | null = null;
    const isRugCheck = purpose === "RUGCHECK_REPORT";
    const ceilingBytes = isRugCheck
      ? this.rugCheckMaxResponseBytes
      : DIAGNOSTIC_DEFAULT_MAX_RESPONSE_BYTES;

    try {
      const purposeTransport = isRugCheck ? this.rugCheckTransport : this.transport;
      const fetchPromise = purposeTransport(url, {
        method,
        headers: {
          Accept: "application/json",
          ...headers,
        },
        ...(body !== undefined ? { body } : {}),
        signal: reqController.signal,
      });

      // Race headers against abort/timeout
      const res = await Promise.race([fetchPromise, abortPromise]);
      httpStatus = res.status;
      declaredContentLength = res.headers?.get?.("content-length") ?? null;
      declaredContentEncoding = res.headers?.get?.("content-encoding") ?? null;

      // Race body bytes read against abort/timeout using res.arrayBuffer()
      const arrayBufferPromise = res.arrayBuffer();
      const rawArrayBuffer = await Promise.race([arrayBufferPromise, abortPromise]);
      rawWireBytes = Buffer.from(rawArrayBuffer);
      bodyComplete = true;

      // Wire digest: SHA-256 computed on raw wire bytes BEFORE text decoding
      wireDigestSha256 = createHash("sha256").update(rawWireBytes).digest("hex");

      // Strip UTF-8 BOM if present before text parsing
      let decodedText = rawWireBytes.toString("utf8");
      if (decodedText.charCodeAt(0) === 0xfeff) {
        decodedText = decodedText.slice(1);
      }
      rawText = decodedText;

      if (!skipBudgetRecording) {
        this.budgetManager.recordResponseStatus(httpStatus);
      }

      if (httpStatus === 429) {
        errorMessage = `HTTP 429 Rate Limit encountered from ${providerName}`;
        ok = false;
      } else if (res.ok) {
        ok = true;
      } else {
        errorMessage = `HTTP ${httpStatus} error from ${providerName}`;
        ok = false;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof BoundedResponseTooLargeError) {
        overflow = err;
      }
      ok = false;
    } finally {
      clearTimeout(reqTimeout);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }

    const completedAtMs = this.clock();

    let json: unknown | null = null;
    if (rawText.trim().length > 0) {
      try {
        json = JSON.parse(rawText);
      } catch {
        json = null;
      }
    }

    const responseIndex = this.ledger.records.length + 1;
    const responseFileName = `responses/${String(responseIndex).padStart(2, "0")}-${purpose.toLowerCase().replace(/_/g, "-")}.json`;

    this.recordedResponses.push({
      index: responseIndex,
      purpose,
      rawWireBytes,
      text: rawText,
      json,
      wireDigestSha256,
      ok,
      httpStatus,
      responseFile: responseFileName,
    });

    const sanitizedEndpoint = sanitizeSolanaRpcUrl(url).sanitizedUrl;
    this.ledger.records.push({
      purpose,
      provider: providerName,
      endpoint: redactSensitiveText(sanitizedEndpoint, this.sensitiveTokens),
      method,
      ...(requestParams !== undefined
        ? { params: deepRedactSensitiveObject(requestParams, this.sensitiveTokens) }
        : {}),
      dispatchedAtMs,
      completedAtMs,
      ...(httpStatus > 0 ? { httpStatus } : {}),
      ok,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      ...(wireDigestSha256.length > 0 ? { wireDigestSha256 } : {}),
      responseFile: responseFileName,
      ...(rpcRequestId !== undefined ? { rpcRequestId } : {}),
      ...(rpcRequestId !== undefined && json !== null && typeof json === "object" && "id" in json
        ? { rpcResponseId: (json as { id?: unknown }).id }
        : {}),
      ...(isRugCheck
        ? {
            responseBodyMetadata: {
              ceilingBytes,
              bodyStatus: overflow ? "OVER_LIMIT" : bodyComplete ? "COMPLETE" : "INCOMPLETE",
              declaredContentLength,
              declaredContentEncoding,
              retainedBytes: overflow
                ? overflow.retainedBytes
                : bodyComplete
                  ? rawWireBytes.length
                  : null,
              retainedSha256: overflow
                ? overflow.retainedSha256
                : bodyComplete
                  ? wireDigestSha256
                  : null,
              observedBytesAtStopLowerBound: overflow ? overflow.observedBytesAtStop : null,
            } satisfies ResponseBodyMetadata,
          }
        : {}),
    });

    if (httpStatus === 429) {
      const rateLimitError = new Error(
        `[HTTP_429_RATE_LIMITED] ${purpose} received HTTP 429 from ${providerName}; aborting immediately.`,
      );
      this.fatalDispatchStop ??= rateLimitError;
      throw rateLimitError;
    }

    if (
      !ok &&
      errorMessage &&
      (errorMessage.includes("REQUEST_TIMEOUT") ||
        errorMessage.includes("OVERALL_DIAGNOSTIC_TIMEOUT"))
    ) {
      throw new Error(`[OPERATION_TIMEOUT] ${purpose} timed out: ${errorMessage}`);
    }

    return {
      ok,
      status: httpStatus,
      text: rawText,
      json,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    };
  }

  /**
   * Helper executing a standard Solana JSON-RPC POST call via dispatchMeteredRequest.
   */
  private async dispatchSolanaRpc(
    purpose:
      | "POOL_LAYOUT"
      | "PRIOR_ANCHOR"
      | "TRANSACTION_DECODING"
      | "GET_SLOT"
      | "GET_BLOCK_TIME"
      | "HISTORY_ENUMERATION"
      | "LP_REFRESH"
      | "CANDIDATE_MINT",
    method: string,
    params: readonly unknown[],
    signal?: AbortSignal,
    skipBudgetRecording = false,
    overallDeadlineMs?: number,
    /** Caller-owned JSON-RPC id forwarded on the wire (stream decode adapter verifies the echoed id). */
    requestId?: string | number,
    latestDispatchAtMs?: number,
  ): Promise<{
    ok: boolean;
    status: number;
    json: Record<string, unknown> | null;
    error?: string | undefined;
  }> {
    const rpcRequestId = requestId ?? `diag-${this.ledger.totalAttempts + 1}`;
    const rpcPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: rpcRequestId,
      method,
      params,
    });

    const res = await this.dispatchMeteredRequest({
      purpose,
      providerName: "SOLANA_RPC",
      url: this.rpcUrl,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rpcPayload,
      requestParams: params,
      rpcRequestId,
      signal,
      skipBudgetRecording,
      overallDeadlineMs,
      ...(latestDispatchAtMs !== undefined ? { latestDispatchAtMs } : {}),
    });

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        json: null,
        ...(res.error !== undefined ? { error: res.error } : {}),
      };
    }

    if (!res.json || typeof res.json !== "object" || Array.isArray(res.json)) {
      return {
        ok: false,
        status: res.status,
        json: null,
        error: `Malformed JSON-RPC response from ${method}`,
      };
    }

    const jsonRecord = res.json as Record<string, unknown>;
    if (jsonRecord.error) {
      return {
        ok: false,
        status: res.status,
        json: jsonRecord,
        error: `Solana RPC error: ${JSON.stringify(jsonRecord.error)}`,
      };
    }

    return { ok: true, status: res.status, json: jsonRecord };
  }

  /**
   * Executes the complete single-pool diagnostic run.
   */
  public async run(): Promise<CandidateDecisionDiagnosticResult> {
    const startedAtMs = this.clock();
    const overallDeadlineMs = startedAtMs + this.overallTimeoutMs;

    const overallController = new AbortController();
    const overallTimer = setTimeout(
      () => overallController.abort("OVERALL_DIAGNOSTIC_TIMEOUT"),
      this.overallTimeoutMs,
    );

    let coordinator: RaydiumCandidateSubscriptionCoordinator | undefined;
    let liveWsTransport: ISolanaWebSocketTransport | undefined;
    let activeWsTransport: ISolanaWebSocketTransport | undefined;

    let pingTimer: ReturnType<typeof setTimeout> | undefined;
    let pongTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let keepaliveDisposed = false;

    const cleanupKeepalive = () => {
      keepaliveDisposed = true;
      if (pingTimer) {
        clearTimeout(pingTimer);
        pingTimer = undefined;
      }
      if (pongTimeoutTimer) {
        clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = undefined;
      }
    };

    try {
      // Pre-check overall deadline
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before Phase 1",
        );
      }

      // Initialize WebSocket transport inside guarded run lifecycle
      if (this.wsTransportOption) {
        activeWsTransport = this.wsTransportOption;
      } else if (this.isLive) {
        const wsUrl = this.rpcUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
        liveWsTransport = new WsWebSocketTransport(wsUrl);
        activeWsTransport = liveWsTransport;
      } else {
        return this.finishWithFailure(
          "MISSING_TRANSPORT",
          "Offline mode requires injected wsTransport",
        );
      }

      // Explicitly check readyState if supported
      const readyState = getWebSocketTransportReadyState(activeWsTransport);
      if (readyState === 2 || readyState === 3) {
        return this.finishWithFailure(
          "WEBSOCKET_CONNECTION_CLOSED",
          "WebSocket transport is already in closing or closed state",
        );
      }
      if (readyState === 0) {
        let openResolved = false;
        let openError: Error | undefined;
        const openDeadline = Math.min(this.clock() + 5000, overallDeadlineMs);
        const onOpen = () => {
          openResolved = true;
        };
        const onError = (e: Error) => {
          openError = e;
        };
        activeWsTransport.on("open", onOpen);
        activeWsTransport.on("error", onError);
        while (
          !openResolved &&
          !openError &&
          this.clock() < openDeadline &&
          !overallController.signal.aborted
        ) {
          await this.sleepWithAbort(25, overallController.signal);
        }
        if (openError) {
          return this.finishWithFailure(
            "WEBSOCKET_CONNECTION_FAILED",
            `WebSocket failed to connect: ${openError.message}`,
          );
        }
        const currentReady = getWebSocketTransportReadyState(activeWsTransport);
        if (!openResolved && currentReady !== 1) {
          return this.finishWithFailure(
            "WEBSOCKET_CONNECTION_TIMEOUT",
            "WebSocket failed to reach open state within 5,000 ms",
          );
        }
      }

      // =========================================================================
      // PHASE 1: Pre-Observation Setup (Pool Layout & Prior Anchor)
      // =========================================================================
      // 1. Initial pool layout (Attempt 1)
      const layoutRes = await this.dispatchSolanaRpc(
        "POOL_LAYOUT",
        "getAccountInfo",
        [this.poolId, { encoding: "base64", commitment: "confirmed" }],
        overallController.signal,
        false,
        overallDeadlineMs,
      );

      if (!layoutRes.ok || !layoutRes.json) {
        return this.finishWithFailure(
          "POOL_LAYOUT_FAILED",
          `Failed to acquire initial pool layout: ${layoutRes.error ?? "Empty response"}`,
        );
      }

      const layoutVal = (layoutRes.json.result as { value?: { data?: unknown } })?.value;
      if (!layoutVal || !layoutVal.data) {
        return this.finishWithFailure(
          "POOL_ACCOUNT_NOT_FOUND",
          `Pool account ${this.poolId} not found on RPC node`,
        );
      }

      const rawData = Array.isArray(layoutVal.data) ? layoutVal.data[0] : layoutVal.data;
      if (typeof rawData !== "string") {
        return this.finishWithFailure(
          "POOL_DATA_INVALID",
          "Pool account data is not base64 encoded string",
        );
      }

      const poolBuffer = Buffer.from(rawData, "base64");
      if (poolBuffer.length !== RAYDIUM_AMM_V4_LAYOUT_LENGTH) {
        return this.finishWithFailure(
          "POOL_LAYOUT_LENGTH_MISMATCH",
          `Expected ${RAYDIUM_AMM_V4_LAYOUT_LENGTH} bytes, got ${poolBuffer.length}`,
        );
      }

      const parsedPool = parseRaydiumAmmV4Account(poolBuffer, this.poolId);
      if (!parsedPool.ok) {
        return this.finishWithFailure(
          "POOL_PARSE_FAILED",
          `Failed to parse Raydium AMM v4 layout: ${parsedPool.message}`,
        );
      }

      if (parsedPool.orientation === "NON_SOL_PAIR") {
        return this.finishWithFailure("NON_SOL_PAIR", "Pool is not paired against WSOL");
      }

      const state = parsedPool.state;
      const candidateMint =
        parsedPool.orientation === "TOKEN_BASE_SOL_QUOTE" ? state.baseMint : state.quoteMint;
      const quoteMint =
        parsedPool.orientation === "TOKEN_BASE_SOL_QUOTE" ? state.quoteMint : state.baseMint;

      if (candidateMint !== this.mintAddress) {
        return this.finishWithFailure(
          "TARGET_MINT_MISMATCH",
          `Pool token mint ${candidateMint} does not match expected target mint ${this.mintAddress}`,
        );
      }

      const provisionalContext: TrackedRaydiumPoolContext = {
        poolId: this.poolId,
        candidateTokenMint: candidateMint,
        quoteTokenMint: quoteMint,
        baseVault: state.baseVault,
        quoteVault: state.quoteVault,
        baseMint: state.baseMint,
        quoteMint: state.quoteMint,
        orientation: parsedPool.orientation,
      };

      validateTrackedPoolContext(provisionalContext);
      this.retainedProvisionalContext = provisionalContext;

      // Check deadline before attempt 2
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before prior anchor",
          { provisionalContext },
        );
      }

      // 2. Prior-anchor acquisition (Attempt 2)
      const anchorRes = await this.dispatchSolanaRpc(
        "PRIOR_ANCHOR",
        "getSignaturesForAddress",
        [this.poolId, { limit: 1 }],
        overallController.signal,
        false,
        overallDeadlineMs,
      );

      if (!anchorRes.ok || !anchorRes.json) {
        return this.finishWithFailure(
          "PRIOR_ANCHOR_FAILED",
          `Failed to acquire prior anchor signature: ${anchorRes.error ?? "Empty response"}`,
          { provisionalContext },
        );
      }

      const anchorRecords = anchorRes.json.result as Array<{ signature?: string }> | undefined;
      if (
        !Array.isArray(anchorRecords) ||
        anchorRecords.length === 0 ||
        !anchorRecords[0]?.signature
      ) {
        return this.finishWithFailure(
          "PRIOR_ANCHOR_EMPTY",
          "Initial getSignaturesForAddress query returned zero records; no anchor witnessed",
          { provisionalContext },
        );
      }

      const knownAnchorSignature = anchorRecords[0].signature;

      // =========================================================================
      // PHASE 2: Observation Window & Quiet-Stream Verification
      // =========================================================================
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before Phase 2",
          { provisionalContext },
        );
      }

      const flowTracker = new RollingTradeFlowTracker({
        poolId: this.poolId,
        tokenMint: this.mintAddress,
        clock: this.clock,
      });

      // Transaction identity (slot, blockTime) read from each getTransaction response itself.
      const txIdentityBySignature = new Map<
        string,
        { readonly slot: number; readonly blockTime: number | null }
      >();
      const streamResults: ProcessNotificationResult[] = [];

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: provisionalContext,
        rpcUrl: this.rpcUrl,
        maxPendingQueueSize: 10, // Reviewed queue ceiling of 10 enforced at ingress
        transport: async (url, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr) as {
            method?: string;
            params?: readonly unknown[];
            id?: string | number;
          };
          const res = await this.dispatchSolanaRpc(
            "TRANSACTION_DECODING",
            parsed.method ?? "getTransaction",
            parsed.params ?? [],
            overallController.signal,
            true, // skipBudgetRecording: true because adapter already records on budgetManager
            overallDeadlineMs,
            // Forward the adapter request id so the provider echo satisfies its RPC id check
            // (previously a diag-N id was substituted and every stream decode failed RPC_ID_MISMATCH).
            typeof parsed.id === "string" || typeof parsed.id === "number" ? parsed.id : undefined,
          );
          const requestedSig = parsed.params?.[0];
          const txResult = (res.json as { result?: { slot?: unknown; blockTime?: unknown } } | null)
            ?.result;
          if (
            typeof requestedSig === "string" &&
            txResult &&
            typeof txResult.slot === "number" &&
            Number.isSafeInteger(txResult.slot) &&
            (txResult.blockTime === null ||
              (typeof txResult.blockTime === "number" && Number.isSafeInteger(txResult.blockTime)))
          ) {
            txIdentityBySignature.set(requestedSig, {
              slot: txResult.slot,
              blockTime: txResult.blockTime as number | null,
            });
          }
          return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
        },
        budgetManager: this.budgetManager,
        clock: this.clock,
        sleepFn: (ms) => this.sleepWithAbort(ms, overallController.signal),
        requestPurpose: "CANDIDATE_ENRICHMENT",
        // Failed-transaction policy is applied only through the explicit PAPER active-window opt-in
        // (paperActiveWindowFlow already requires PAPER_SIMULATION or BACKTEST).
        ...(this.paperActiveWindowFlow &&
        (this.executionContext === "PAPER_SIMULATION" || this.executionContext === "BACKTEST")
          ? {
              paperFailedTransactionPolicy: {
                enabled: true as const,
                executionContext: this.executionContext,
              },
            }
          : {}),
      });

      coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: provisionalContext,
        adapter,
        tracker: flowTracker,
        clock: this.clock,
        maxNotificationsBudget: 50,
      });

      let observationStartMs = 0;
      let observationEndMs = 0;

      let streamLimitReason: string | undefined;
      let streamLimitMessage: string | undefined;

      // Early-stop telemetry: captured BEFORE coordinator cleanup so termination cannot erase it.
      // Distinct timestamps: observation loop end, explicit stream stop/close, exception capture, sealing.
      let observationStoppedAtMs: number | null = null;
      let observationLoopEndedAtMs: number | null = null;
      let terminationCapturedAtMs: number | null = null;
      let streamStateBeforeCleanup: Record<string, unknown> | null = null;
      const snapshotStreamState = (reason: string): Record<string, unknown> => ({
        capturedAtMs: this.clock(),
        reason,
        coordinatorStatus: coordinator?.getStatus() ?? null,
        coordinatorMetrics: coordinator ? { ...coordinator.getMetrics() } : null,
        pendingQueueLength: adapter.getPendingQueueLength(),
        inFlightCount: adapter.getInFlightCount(),
        activeWorkload: adapter.getActiveWorkload(),
        connectionEpoch: coordinator?.getConnectionEpoch() ?? null,
        recordedGaps: [...flowTracker.getRecordedGaps()],
      });
      const captureBeforeCleanup = (reason: string) => {
        if (observationStartMs > 0 && observationStoppedAtMs === null) {
          observationStoppedAtMs = this.clock();
        }
        if (streamStateBeforeCleanup === null) {
          streamStateBeforeCleanup = snapshotStreamState(reason);
        }
      };
      // Exception path (outer catch): records when termination was captured (after the failing request
      // settled) without treating it as an explicit stream stop; state is snapshotted before cleanup.
      this.streamExceptionCapture = (reason: string) => {
        if (terminationCapturedAtMs === null) terminationCapturedAtMs = this.clock();
        if (streamStateBeforeCleanup === null) {
          streamStateBeforeCleanup = snapshotStreamState(reason);
        }
      };

      // Keepalive state
      let clientPingsSentCount = 0;
      let matchedClientPongsCount = 0;
      let unmatchedClientPongsCount = 0;
      let missingPongDetected = false;
      let controlFramesCount = 0;
      let controlFramePayloadBytes = 0;
      let pendingPingPayload: Buffer | null = null;
      let pendingPingTimestamp: number | null = null;
      let nextPingScheduledTime = 0;
      let keepaliveSchedulerStarted = false;

      const stopWithLimit = (status: string, message: string) => {
        if (streamLimitReason) return;
        streamLimitReason = status;
        streamLimitMessage = message;
        captureBeforeCleanup(`STREAM_LIMIT:${status}`);
        cleanupKeepalive();
        coordinator?.close();
      };

      this.streamTelemetryFinalizer = () => {
        const records = this.ledger.records.filter((r) => r.purpose === "TRANSACTION_DECODING");
        const linkedSignatures = new Set<string>();
        const retrievals: Array<Record<string, unknown>> = records.map((rec) => {
          const sig =
            Array.isArray(rec.params) && typeof rec.params[0] === "string" ? rec.params[0] : null;
          if (sig !== null) linkedSignatures.add(sig);
          const streamResult =
            sig === null ? undefined : streamResults.find((r) => r.signature === sig);
          const sealed = this.recordedResponses.find((rr) => rr.responseFile === rec.responseFile);
          const tx = (sealed?.json as { result?: unknown } | null)?.result;
          const meta =
            tx !== null && typeof tx === "object" ? (tx as { meta?: unknown }).meta : undefined;
          const metaObj =
            meta !== null && typeof meta === "object" && !Array.isArray(meta)
              ? (meta as Record<string, unknown>)
              : null;
          // NONE requires an explicit err: null; PRESENT requires a well-formed reported error.
          // Missing/null/malformed metadata stays UNKNOWN.
          const hasErr = metaObj !== null && Object.prototype.hasOwnProperty.call(metaObj, "err");
          const errValue = hasErr ? metaObj.err : undefined;
          const onChainErrorStatus: "NONE" | "PRESENT" | "UNKNOWN" = !hasErr
            ? "UNKNOWN"
            : errValue === null
              ? "NONE"
              : (typeof errValue === "string" && errValue.length > 0) ||
                  (typeof errValue === "object" && !Array.isArray(errValue))
                ? "PRESENT"
                : "UNKNOWN";
          const decoded = streamResult?.diagnostics?.decodedEventsCount ?? null;
          const classification = !streamResult
            ? "NO_ADAPTER_RESULT"
            : streamResult.ok && streamResult.outcome === "SUCCESS"
              ? (decoded ?? 0) > 0
                ? "CANDIDATE_BOUND_SWAPS"
                : "NO_CANDIDATE_SWAPS"
              : streamResult.ok && streamResult.outcome === "KNOWN_FAILED_TRANSACTION"
                ? "KNOWN_FAILED_TRANSACTION_ZERO_SWAPS"
                : onChainErrorStatus === "PRESENT"
                  ? "ONCHAIN_FAILED"
                  : "RETRIEVAL_OR_DECODE_FAILED";
          return {
            signature: sig,
            responseFile: rec.responseFile ?? null,
            rpcRequestId: rec.rpcRequestId ?? null,
            rpcResponseId: rec.rpcResponseId ?? null,
            httpStatus: rec.httpStatus ?? null,
            requestOk: rec.ok,
            adapterOutcome: streamResult?.outcome ?? null,
            adapterOk: streamResult?.ok ?? null,
            decodedEventsCount: decoded,
            ingestedEventsCount: streamResult?.ingestedEventsCount ?? null,
            slot: sig === null ? null : (txIdentityBySignature.get(sig)?.slot ?? null),
            blockTime: sig === null ? null : (txIdentityBySignature.get(sig)?.blockTime ?? null),
            onChainErrorStatus,
            onChainError: onChainErrorStatus === "PRESENT" ? errValue : null,
            classification,
            error: streamResult?.diagnostics?.error ?? rec.error ?? null,
          };
        });
        for (const r of streamResults) {
          if (linkedSignatures.has(r.signature)) continue;
          retrievals.push({
            signature: r.signature,
            responseFile: null,
            adapterOutcome: r.outcome,
            adapterOk: r.ok,
            decodedEventsCount: r.diagnostics?.decodedEventsCount ?? null,
            ingestedEventsCount: r.ingestedEventsCount,
            classification: "NOT_DISPATCHED",
            error: r.diagnostics?.error ?? null,
          });
        }
        // Observation end: cutoff acquisition, else the completed observation loop, else an explicit
        // early stream stop, else (observation interrupted by an exception) the exception capture time.
        const endBasis =
          observationStartMs <= 0
            ? null
            : observationEndMs > 0
              ? "CUTOFF_ACQUISITION"
              : observationLoopEndedAtMs !== null
                ? "OBSERVATION_LOOP_END"
                : observationStoppedAtMs !== null
                  ? "EARLY_STOP"
                  : terminationCapturedAtMs !== null
                    ? "INTERRUPTED_BY_EXCEPTION"
                    : null;
        const observationEnd =
          endBasis === "CUTOFF_ACQUISITION"
            ? observationEndMs
            : endBasis === "OBSERVATION_LOOP_END"
              ? observationLoopEndedAtMs
              : endBasis === "EARLY_STOP"
                ? observationStoppedAtMs
                : endBasis === "INTERRUPTED_BY_EXCEPTION"
                  ? terminationCapturedAtMs
                  : null;
        const stagesNotReached = [
          ["SOURCE_CUTOFF", this.retainedSourceCutoff],
          ["HISTORY_ENUMERATION", this.retainedHistoryResult],
          ["EXACT_PAIR_MARKET_DATA", this.retainedCandidateMarketData],
          ["LP_SCREENING", this.retainedLpEvidence],
          ["CANDIDATE_MINT", this.retainedCandidateMintAccount],
          ["RUGCHECK", this.retainedRugCheckEvidence],
          ["SOLANA_TRACKER", this.retainedBundlerEvidence],
        ]
          .filter(([, evidence]) => evidence === undefined)
          .map(([stage]) => stage as string);
        const keepaliveMetrics = {
          clientPingsSentCount,
          matchedClientPongsCount,
          unmatchedClientPongsCount,
          controlFramesCount,
          controlFramePayloadBytes,
        };
        const notifications = coordinator?.getMetrics().totalNotificationsReceived ?? null;
        return {
          ...(observationStartMs > 0 && observationEnd !== null && notifications !== null
            ? {
                observationMetadata: {
                  observationStartMs,
                  observationEndMs: observationEnd,
                  observationDurationMs: Math.max(0, observationEnd - observationStartMs),
                  cutoffTimestampMs: this.retainedSourceCutoff?.cutoffTimestampMs ?? null,
                  notificationsReceived: notifications,
                },
              }
            : {}),
          ...(observationStartMs > 0 ? { keepaliveMetrics } : {}),
          telemetry: {
            schema: "STREAM_TELEMETRY_V1",
            stopReason: streamLimitReason ?? this.boundedStopReason ?? null,
            capacityProfile: this.capacityProfile.id,
            observation: {
              startMs: observationStartMs > 0 ? observationStartMs : null,
              endMs: observationEnd,
              endBasis,
              loopEndedAtMs: observationLoopEndedAtMs,
              streamStoppedAtMs: observationStoppedAtMs,
              terminationCapturedAtMs,
              sealedAtMs: this.clock(),
            },
            stateBeforeCleanup:
              streamStateBeforeCleanup ?? snapshotStreamState("AT_SEAL_NO_PRIOR_CLEANUP"),
            keepalive: {
              ...keepaliveMetrics,
              schedulerStarted: keepaliveSchedulerStarted,
              missingPongDetected,
            },
            transactionRetrievalCap: this.capacityProfile.maxTransactionRetrievals,
            transactionDecodeAttempts: this.ledger.transactionDecodeAttempts,
            transactionRetrievals: retrievals,
            stagesNotReached,
            note: "Recorded at termination from live state; stages not reached are unavailable and never synthesized.",
          },
        };
      };

      const sendPing = () => {
        if (keepaliveDisposed || clientPingsSentCount >= this.maxPings) return;
        if (pendingPingPayload !== null) return; // Single pending ping

        if (pingTimer) {
          clearTimeout(pingTimer);
          pingTimer = undefined;
        }

        const now = this.clock();
        clientPingsSentCount++;
        controlFramesCount++;
        nextPingScheduledTime = now + this.pingIntervalMs;

        const pingPayload = Buffer.alloc(8);
        pingPayload.writeBigInt64BE(BigInt(now));
        pendingPingPayload = pingPayload;
        pendingPingTimestamp = now;
        controlFramePayloadBytes += pingPayload.length;

        if (
          controlFramesCount > this.maxControlFrames ||
          controlFramePayloadBytes > this.maxControlFrameBytes
        ) {
          stopWithLimit(
            "CONTROL_FRAME_LIMIT_EXCEEDED",
            `Control frame limit exceeded: ${controlFramesCount} frames, ${controlFramePayloadBytes} bytes`,
          );
          return;
        }

        try {
          meteredWs.ping(pingPayload);
        } catch (err) {
          stopWithLimit(
            "TRANSPORT_ERROR",
            `Failed to send ping: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }

        if (pongTimeoutTimer) {
          clearTimeout(pongTimeoutTimer);
        }
        pongTimeoutTimer = setTimeout(() => {
          if (keepaliveDisposed) return;
          missingPongDetected = true;
          stopWithLimit(
            "KEEPALIVE_PONG_TIMEOUT",
            `Missing WebSocket keepalive PONG: no response received within ${this.pongTimeoutMs} ms`,
          );
        }, this.pongTimeoutMs);
      };

      const checkKeepalive = (now: number) => {
        if (keepaliveDisposed || !this.keepalive) return;
        if (pendingPingPayload !== null && pendingPingTimestamp !== null) {
          if (now - pendingPingTimestamp >= this.pongTimeoutMs) {
            missingPongDetected = true;
            stopWithLimit(
              "KEEPALIVE_PONG_TIMEOUT",
              `Missing WebSocket keepalive PONG: no response received within ${this.pongTimeoutMs} ms`,
            );
            return;
          }
        }
        if (
          pendingPingPayload === null &&
          clientPingsSentCount < this.maxPings &&
          nextPingScheduledTime > 0 &&
          now >= nextPingScheduledTime
        ) {
          sendPing();
        }
      };

      const checkQueueLimit = () => {
        if (
          adapter.getPendingQueueLength() >= 10 ||
          adapter.getActiveWorkload() >= 10 ||
          (coordinator?.getMetrics().totalQueueOverflows ?? 0) > 0
        ) {
          stopWithLimit(
            "STREAM_QUEUE_LIMIT_EXCEEDED",
            `WebSocket pending queue exceeded ceiling of 10 notifications (queue length: ${adapter.getPendingQueueLength()})`,
          );
        }
      };

      // Wrap transport with MeteredWebSocketTransport enforcing 1MB max payload bytes
      const meteredWs = new MeteredWebSocketTransport(
        activeWsTransport,
        1024 * 1024,
        (count, bytes, byteLen, data, isOversized) => {
          if (isOversized) {
            stopWithLimit(
              "STREAM_BYTE_LIMIT_EXCEEDED",
              `WebSocket stream exceeded 1MB payload limit (${bytes} bytes received)`,
            );
          } else if (count > 50) {
            stopWithLimit(
              "STREAM_MESSAGE_LIMIT_EXCEEDED",
              `WebSocket stream exceeded message limit of 50 (received ${count})`,
            );
          }
        },
      );

      meteredWs.on("message", () => {
        checkQueueLimit();
      });

      const startKeepaliveScheduler = () => {
        if (keepaliveDisposed || !this.keepalive || keepaliveSchedulerStarted) return;
        keepaliveSchedulerStarted = true;
        nextPingScheduledTime = this.clock() + this.pingIntervalMs;
        if (clientPingsSentCount < this.maxPings && !pingTimer) {
          pingTimer = setTimeout(sendPing, this.pingIntervalMs);
        }
      };

      if (this.keepalive) {
        meteredWs.on("open", () => {
          startKeepaliveScheduler();
        });

        // Initialize keepalive reliably when the socket is already open
        const initialReady = getWebSocketTransportReadyState(activeWsTransport);
        if (initialReady === 1) {
          startKeepaliveScheduler();
        }

        meteredWs.on("ping", (payload: Buffer) => {
          if (keepaliveDisposed) return;
          const payloadBytes = payload ? payload.length : 0;
          // Inbound server PING + automatic client PONG response = 2 control frames
          controlFramesCount += 2;
          controlFramePayloadBytes += payloadBytes * 2;

          if (
            controlFramesCount > this.maxControlFrames ||
            controlFramePayloadBytes > this.maxControlFrameBytes
          ) {
            stopWithLimit(
              "CONTROL_FRAME_LIMIT_EXCEEDED",
              `Control frame limit exceeded: ${controlFramesCount} frames, ${controlFramePayloadBytes} bytes`,
            );
          }
        });

        meteredWs.on("pong", (payload: Buffer) => {
          if (keepaliveDisposed) return;
          controlFramesCount++;
          const payloadBytes = payload ? payload.length : 0;
          controlFramePayloadBytes += payloadBytes;

          if (
            controlFramesCount > this.maxControlFrames ||
            controlFramePayloadBytes > this.maxControlFrameBytes
          ) {
            stopWithLimit(
              "CONTROL_FRAME_LIMIT_EXCEEDED",
              `Control frame limit exceeded: ${controlFramesCount} frames, ${controlFramePayloadBytes} bytes`,
            );
            return;
          }

          const isExactMatch =
            pendingPingPayload !== null &&
            Buffer.isBuffer(payload) &&
            payload.length === pendingPingPayload.length &&
            payload.equals(pendingPingPayload);

          if (!isExactMatch) {
            unmatchedClientPongsCount++;
            return;
          }

          matchedClientPongsCount++;
          if (pongTimeoutTimer) {
            clearTimeout(pongTimeoutTimer);
            pongTimeoutTimer = undefined;
          }
          pendingPingPayload = null;
          pendingPingTimestamp = null;
          nextPingScheduledTime = this.clock() + this.pingIntervalMs;

          if (clientPingsSentCount < this.maxPings && !keepaliveDisposed) {
            if (pingTimer) clearTimeout(pingTimer);
            pingTimer = setTimeout(sendPing, this.pingIntervalMs);
          }
        });
      }

      coordinator.attachTransport(meteredWs);
      coordinator.sendSubscriptionRequest();

      // Await subscription acknowledgement
      const subDeadline = this.clock() + 5000;
      while (
        coordinator.getStatus() !== "SUBSCRIBED" &&
        this.clock() < subDeadline &&
        !overallController.signal.aborted
      ) {
        if (streamLimitReason) break;
        checkQueueLimit();
        if (streamLimitReason) break;
        await this.sleepWithAbort(50, overallController.signal);
      }
      if (streamLimitReason) {
        cleanupKeepalive();
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          streamLimitReason,
          streamLimitMessage ?? `Observation stopped: ${streamLimitReason}`,
          { provisionalContext },
        );
      }
      if (coordinator.getStatus() !== "SUBSCRIBED") {
        cleanupKeepalive();
        return this.finishWithFailure(
          "SUBSCRIPTION_ACK_TIMEOUT",
          "WebSocket subscription request was not acknowledged within 5,000 ms",
          { provisionalContext },
        );
      }
      observationStartMs = this.clock();

      // Process incoming stream messages up to observation duration or limits
      const targetEnd = observationStartMs + this.observationDurationMs;

      // Bounded schedule (PAPER_ACTIVE_WINDOW_20_9): fixed nominal end, GET_SLOT dispatch deadline, at most
      // maxDrainRetrievals retrievals at/after the nominal end, and no retrieval after GET_SLOT.
      const profile = this.capacityProfile;
      const bounded = profile.cutoffDispatchWindowMs !== null;
      const nominalObservationEndMs = targetEnd;
      const getSlotDispatchDeadlineMs = targetEnd + (profile.cutoffDispatchWindowMs ?? 0);
      if (bounded) {
        this.boundedScheduleBase = { nominalObservationEndMs, getSlotDispatchDeadlineMs };
      }
      let boundedStop: { status: string; message: string } | null = null;
      let drainRetrievalsReserved = 0;
      // Conservative projected next Solana RPC dispatch: last recorded Solana dispatch + pacing.
      const projectedSolanaDispatchMs = (now: number): number => {
        let last = -Infinity;
        for (const rec of this.ledger.records) {
          if (rec.provider === "SOLANA_RPC" && rec.dispatchedAtMs > last) last = rec.dispatchedAtMs;
        }
        return Math.max(now, last + profile.rpcPacingMs);
      };
      const retrievalGate = ():
        | { readonly allowed: true; readonly drain: boolean }
        | { readonly allowed: false; readonly status: string; readonly reason: string } => {
        const now = this.clock();
        if (this.ledger.transactionDecodeAttempts >= profile.maxTransactionRetrievals) {
          return {
            allowed: false,
            status: "TRANSACTION_RETRIEVAL_BUDGET_EXHAUSTED",
            reason: `all ${profile.maxTransactionRetrievals} transaction retrievals used with notifications still pending`,
          };
        }
        const projected = projectedSolanaDispatchMs(now);
        // Reserve GET_SLOT pacing: the retrieval's own pacing wait plus one pacing interval must fit.
        if (projected + profile.rpcPacingMs > getSlotDispatchDeadlineMs) {
          return {
            allowed: false,
            status: "PRE_CUTOFF_BACKLOG_REMAINING",
            reason: `a retrieval projected at ${projected} leaves no GET_SLOT pacing slot before ${getSlotDispatchDeadlineMs}`,
          };
        }
        const drain = projected >= nominalObservationEndMs - DRAIN_CLASSIFICATION_GUARD_MS;
        if (drain && drainRetrievalsReserved >= profile.maxDrainRetrievals) {
          return {
            allowed: false,
            status: "PRE_CUTOFF_BACKLOG_REMAINING",
            reason: `drain allowance of ${profile.maxDrainRetrievals} retrievals used`,
          };
        }
        return { allowed: true, drain };
      };
      /** One bounded retrieval; returns a stop cause when timing or drain evidence is violated. */
      const boundedRetrieve = async (
        drain: boolean,
      ): Promise<{ status: string; message: string } | null> => {
        if (drain) drainRetrievalsReserved++;
        const remaining = getSlotDispatchDeadlineMs - this.clock();
        const streamResult = await coordinator!.processNextPending({
          signal: overallController.signal,
          // In-flight work (pacing wait, request, ingestion) is bounded by the GET_SLOT dispatch deadline.
          overallTimeoutMs: Math.max(1, Math.min(DEFAULT_ADAPTER_OPERATION_CEILING_MS, remaining)),
        });
        if (streamResult) streamResults.push(streamResult);
        const counts = deriveBoundedScheduleCounts(this.ledger.records, nominalObservationEndMs);
        if (counts.drainRetrievals > profile.maxDrainRetrievals) {
          return {
            status: "PRE_CUTOFF_DRAIN_LIMIT_EXCEEDED",
            message: `${counts.drainRetrievals} retrievals dispatched at or after the nominal observation end (limit ${profile.maxDrainRetrievals})`,
          };
        }
        if (this.clock() > getSlotDispatchDeadlineMs) {
          return {
            status: "CUTOFF_DISPATCH_WINDOW_EXCEEDED",
            message: `retrieval work ended at ${this.clock()}, after the GET_SLOT dispatch deadline ${getSlotDispatchDeadlineMs}`,
          };
        }
        return null;
      };
      while (
        this.clock() < targetEnd &&
        !overallController.signal.aborted &&
        this.clock() < overallDeadlineMs
      ) {
        if (streamLimitReason) {
          break;
        }
        if (this.keepalive) checkKeepalive(this.clock());
        if (streamLimitReason) {
          break;
        }
        checkQueueLimit();
        if (streamLimitReason) {
          break;
        }

        const step = Math.min(1000, Math.max(50, targetEnd - this.clock()));
        await this.sleepWithAbort(step, overallController.signal);

        if (this.keepalive) checkKeepalive(this.clock());
        if (streamLimitReason) {
          break;
        }
        checkQueueLimit();
        if (streamLimitReason) {
          break;
        }

        if (bounded) {
          // Bounded profile: observation-phase retrievals only; drain retrievals wait for the drain phase.
          while (adapter.getPendingQueueLength() > 0 && !boundedStop) {
            if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) break;
            const gate = retrievalGate();
            if (!gate.allowed) {
              if (gate.status === "TRANSACTION_RETRIEVAL_BUDGET_EXHAUSTED") {
                boundedStop = { status: gate.status, message: gate.reason };
              }
              break;
            }
            if (gate.drain) break;
            boundedStop = await boundedRetrieve(false);
          }
          if (boundedStop) break;
          continue;
        }

        // Drain any pending transaction decodes (up to the default 3 attempts total)
        while (
          adapter.getPendingQueueLength() > 0 &&
          this.ledger.transactionDecodeAttempts < profile.maxTransactionRetrievals
        ) {
          if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) break;
          const streamResult = await coordinator.processNextPending({
            signal: overallController.signal,
          });
          if (streamResult) streamResults.push(streamResult);
        }
      }
      if (!streamLimitReason && !boundedStop && observationStartMs > 0) {
        observationLoopEndedAtMs = this.clock();
      }

      // Bounded pre-cutoff drain: resolve the remaining backlog within the drain allowance, then wait for the
      // GET_SLOT pacing slot with an empty backlog. GET_SLOT must dispatch by its deadline; never with backlog.
      while (bounded && !boundedStop && !streamLimitReason) {
        if (this.keepalive) checkKeepalive(this.clock());
        checkQueueLimit();
        if (streamLimitReason) break;
        if (overallController.signal.aborted || this.clock() >= overallDeadlineMs) break;
        const now = this.clock();
        const pacingWaitMs = projectedSolanaDispatchMs(now) - now;
        if (now + pacingWaitMs > getSlotDispatchDeadlineMs) {
          boundedStop = {
            status: "CUTOFF_DISPATCH_WINDOW_EXCEEDED",
            message: `GET_SLOT cannot dispatch (including pacing) by ${getSlotDispatchDeadlineMs}`,
          };
          break;
        }
        if (adapter.getPendingQueueLength() === 0 && adapter.getInFlightCount() === 0) {
          if (pacingWaitMs <= 0) break; // backlog empty and pacing satisfied: dispatch GET_SLOT now
          await this.sleepWithAbort(pacingWaitMs, overallController.signal);
          continue; // re-check for notifications that arrived during the pacing wait
        }
        const gate = retrievalGate();
        if (!gate.allowed) {
          boundedStop = {
            status: gate.status,
            message: `${adapter.getPendingQueueLength()} notification(s) unresolved before cutoff: ${gate.reason}`,
          };
          break;
        }
        boundedStop = await boundedRetrieve(gate.drain);
      }
      if (boundedStop) {
        this.boundedStopReason = boundedStop.status;
        cleanupKeepalive();
        captureBeforeCleanup(`BOUNDED_STOP:${boundedStop.status}`);
        coordinator.close();
        return this.finishWithFailureSettled(boundedStop.status, boundedStop.message, {
          provisionalContext,
        });
      }

      if (this.keepalive) checkKeepalive(this.clock());

      // Prompt stop on stream limit breach without proceeding to cutoff requests
      if (streamLimitReason) {
        cleanupKeepalive();
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          streamLimitReason,
          streamLimitMessage ?? `Observation stopped: ${streamLimitReason}`,
          { provisionalContext },
        );
      }

      const notificationsReceived = coordinator.getMetrics().totalNotificationsReceived;

      // 3. Acquire on-chain cutoff (getSlot + getBlockTime) WHILE observation is STILL active
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        cleanupKeepalive();
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before cutoff acquisition",
          { provisionalContext },
        );
      }

      const slotRes = await this.dispatchSolanaRpc(
        "GET_SLOT",
        "getSlot",
        [{ commitment: "confirmed" }],
        overallController.signal,
        false,
        overallDeadlineMs,
        undefined,
        bounded ? getSlotDispatchDeadlineMs : undefined,
      );

      if (this.keepalive) checkKeepalive(this.clock());
      checkQueueLimit();
      if (streamLimitReason) {
        cleanupKeepalive();
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          streamLimitReason,
          streamLimitMessage ?? `Observation stopped: ${streamLimitReason}`,
          { provisionalContext },
        );
      }

      if (!slotRes.ok || !slotRes.json || typeof slotRes.json.result !== "number") {
        cleanupKeepalive();
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          "CUTOFF_GET_SLOT_FAILED",
          `Failed to acquire cutoff slot: ${slotRes.error ?? "Invalid result"}`,
          { provisionalContext },
        );
      }

      const cutoffSlot = slotRes.json.result;

      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        cleanupKeepalive();
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before getBlockTime",
          { provisionalContext },
        );
      }

      const blockTimeRes = await this.dispatchSolanaRpc(
        "GET_BLOCK_TIME",
        "getBlockTime",
        [cutoffSlot],
        overallController.signal,
        false,
        overallDeadlineMs,
      );

      if (this.keepalive) checkKeepalive(this.clock());
      checkQueueLimit();
      if (streamLimitReason) {
        cleanupKeepalive();
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          streamLimitReason,
          streamLimitMessage ?? `Observation stopped: ${streamLimitReason}`,
          { provisionalContext },
        );
      }

      if (!blockTimeRes.ok || !blockTimeRes.json || typeof blockTimeRes.json.result !== "number") {
        cleanupKeepalive();
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          "CUTOFF_GET_BLOCK_TIME_FAILED",
          `Failed to acquire blockTime for slot ${cutoffSlot}: ${blockTimeRes.error ?? "Invalid result"}`,
          { provisionalContext },
        );
      }

      const cutoffTimestampSec = blockTimeRes.json.result;
      const cutoffTimestampMs = cutoffTimestampSec * 1000;
      const retrievedAtMs = this.clock();
      observationEndMs = this.clock();

      if (this.keepalive) checkKeepalive(this.clock());
      cleanupKeepalive();

      const sourceCutoff: SourceCutoffEvidence = {
        sourceMethod: "getBlockTime",
        responseField: "result",
        commitment: "confirmed",
        provenance: "ON_CHAIN_BLOCK_TIME",
        slot: cutoffSlot,
        cutoffTimestampMs,
        retrievedAtMs,
        responsePayload: blockTimeRes.json,
        requestContext: { slot: cutoffSlot },
      };
      this.retainedSourceCutoff = sourceCutoff;

      // Validate observation window inequalities
      if (observationStartMs > cutoffTimestampMs - 60_000) {
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          "WARM_UP_INSUFFICIENT",
          `Observation started at ${observationStartMs} ms, after window start ${cutoffTimestampMs - 60_000} ms`,
          { provisionalContext },
        );
      }

      if (observationEndMs < cutoffTimestampMs) {
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          "CUTOFF_OBSERVATION_GAP",
          `Observation ended at ${observationEndMs} ms, before cutoff ${cutoffTimestampMs} ms`,
          { provisionalContext },
        );
      }

      // 4. Exact-pool history enumeration via accepted enumerator (1 page <= 20 records)
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        captureBeforeCleanup("EARLY_TERMINATION");
        coordinator.close();
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before history enumeration",
          { provisionalContext },
        );
      }

      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: provisionalContext,
        knownAnchorSignature,
        pageSize: 20,
        maxPages: 1,
        maxRetainedRecords: 20,
        operationDeadlineMs: Math.max(1000, overallDeadlineMs - this.clock()),
        budgetManager: this.budgetManager,
        clock: this.clock,
        sleepFn: (ms, sig) => this.sleepWithAbort(ms, sig ?? overallController.signal),
        signal: overallController.signal,
        lifecycleTarget: coordinator,
        pageFetcher: async (params: HistoryPageQueryParams) => {
          const rpcConfig: Record<string, unknown> = {
            limit: params.limit,
          };
          if (params.before) {
            rpcConfig.before = params.before;
          }
          if (params.commitment) {
            rpcConfig.commitment = params.commitment;
          }
          const res = await this.dispatchSolanaRpc(
            "HISTORY_ENUMERATION",
            "getSignaturesForAddress",
            [params.address, rpcConfig],
            params.signal ?? overallController.signal,
            true, // skipBudgetRecording: true because enumerator records on budgetManager
            overallDeadlineMs,
          );
          if (!res.ok || !res.json || !Array.isArray(res.json.result)) {
            throw new Error(res.error ?? "Failed to fetch signatures page");
          }
          return res.json.result as HistorySignatureRecord[];
        },
      });

      const historyResult = await enumerator.enumerate();
      this.retainedHistoryResult = historyResult;
      captureBeforeCleanup("OBSERVATION_COMPLETE");
      coordinator.close();

      // 5. Evaluate Window Reconciliation
      // OPT-IN active-window inputs: explicit per-signature stream resolutions, backlog, and policy.
      const streamResolutionRecords = this.paperActiveWindowFlow
        ? buildStreamResolutionRecords(streamResults, txIdentityBySignature)
        : [];
      const reconResult = evaluateExactPoolWindowReconciliation({
        poolContext: provisionalContext,
        sourceCutoff,
        knownAnchorSignature,
        historyResult,
        tracker: flowTracker,
        expectedConnectionEpoch: coordinator.getConnectionEpoch(),
        observationStartMs,
        observationEndMs,
        decisionTimestampMs: this.clock(),
        maxAllowedEvidenceAgeMs: 15_000,
        budgetManager: this.budgetManager,
        paperQuietStreamPolicy: {
          enabled: true,
          executionContext: this.executionContext,
        },
        ...(this.paperActiveWindowFlow
          ? {
              resolvedSignatures: streamResolutionRecords,
              hasActiveBacklog: adapter.getActiveWorkload() > 0,
              paperActiveWindowPolicy: {
                enabled: true,
                executionContext: this.executionContext,
              },
            }
          : {}),
      });

      if (this.paperActiveWindowFlow) {
        // Each transaction response is sealed once under responses/; this evidence links signatures to it.
        this.retainedActiveWindowEvidence = {
          policy: "PAPER_ACTIVE_WINDOW",
          capacityProfile: this.capacityProfile.id,
          failedTransactionPolicy: PAPER_FAILED_TRANSACTION_POLICY,
          executionContext: this.executionContext,
          expectedConnectionEpoch: coordinator.getConnectionEpoch(),
          recordedGaps: flowTracker.getRecordedGaps(),
          pendingWorkloadAtEvaluation: adapter.getActiveWorkload(),
          transactionDecodeAttempts: this.ledger.transactionDecodeAttempts,
          resolutions: streamResolutionRecords.map((r) => ({
            ...r,
            classification: activeWindowResolutionClassification(r.status),
            responseFile:
              this.ledger.records.find(
                (rec) =>
                  rec.purpose === "TRANSACTION_DECODING" &&
                  Array.isArray(rec.params) &&
                  rec.params[0] === r.signature,
              )?.responseFile ?? null,
          })),
          reconciliation: {
            status: reconResult.status,
            diagnosticReason: reconResult.diagnosticReason,
            paperActiveWindowQualified: reconResult.paperActiveWindowQualified === true,
            windowSignaturesCount: reconResult.underlyingOutcomes.windowSignaturesCount,
            providerAssumptions: reconResult.providerAssumptions,
            unresolvedUncertainties: reconResult.unresolvedUncertainties,
            isProductionCompletenessEstablished: false,
          },
          note: "Derived records only; replay re-decodes the sealed getTransaction responses, re-derives failed-transaction eligibility from the raw response under the sealed policy, and does not trust these counts, labels, or flags.",
        };
      }

      const paperAdapter = new PaperReconciledCandidateFlowAdapter();
      const keepaliveSatisfied =
        !this.keepalive ||
        (keepaliveSchedulerStarted &&
          !missingPongDetected &&
          pendingPingPayload === null &&
          (this.observationDurationMs < this.pingIntervalMs ||
            (clientPingsSentCount >= 1 && matchedClientPongsCount === clientPingsSentCount)));

      const isActiveQualified =
        this.paperActiveWindowFlow &&
        notificationsReceived > 0 &&
        !streamLimitReason &&
        adapter.getActiveWorkload() === 0 &&
        keepaliveSatisfied &&
        reconResult.status === "RECONCILED" &&
        reconResult.paperActiveWindowQualified === true &&
        (this.executionContext === "PAPER_SIMULATION" || this.executionContext === "BACKTEST");

      const isQuietQualified =
        notificationsReceived === 0 &&
        !streamLimitReason &&
        adapter.getPendingQueueLength() === 0 &&
        keepaliveSatisfied &&
        reconResult.status === "RECONCILED" &&
        reconResult.paperQuietStreamQualified === true &&
        (this.executionContext === "PAPER_SIMULATION" || this.executionContext === "BACKTEST");

      let flowResult: CandidateFlowResult;
      if (isQuietQualified || isActiveQualified) {
        flowResult = paperAdapter.convertCandidateFlow(
          reconResult,
          { poolAddress: this.poolId, tokenMint: this.mintAddress },
          this.clock(),
          {
            executionContext: this.executionContext as "PAPER_SIMULATION" | "BACKTEST",
            maxAllowedEvidenceAgeMs: 15_000,
            ...(isActiveQualified ? { allowActiveWindowQualification: true } : {}),
          },
        );
      } else {
        flowResult = Object.freeze({
          poolAddress: this.poolId,
          tokenMint: this.mintAddress,
          recentBuys60s: null,
          recentSells60s: null,
          flowCoverage: "COLLECTION_GAP",
          isCoverageSufficient: false,
          diagnosticReason:
            this.executionContext === "PRODUCTION"
              ? "PAPER_QUALIFIED_EVIDENCE_REJECTED_IN_PRODUCTION"
              : notificationsReceived > 0
                ? this.paperActiveWindowFlow
                  ? `ACTIVE_WINDOW_UNQUALIFIED: ${reconResult.status}: ${reconResult.diagnosticReason}`
                  : "NON_QUIET_STREAM_UNVERIFIED_COMPLETENESS"
                : streamLimitReason
                  ? streamLimitReason
                  : !keepaliveSatisfied
                    ? "MISSING_PONG_QUIET_WINDOW_UNQUALIFIED"
                    : `RECONCILIATION_UNQUALIFIED: ${reconResult.status}`,
          evaluationTimestampMs: this.clock(),
        });
      }

      // =========================================================================
      // PHASE 3: Fresh Candidate Evidence Acquisition (within 15s of Cutoff)
      // =========================================================================
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before Phase 3",
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      if (this.clock() - cutoffTimestampMs > 15_000) {
        return this.finishWithFailure(
          "STALE_DATA",
          `Cutoff age (${this.clock() - cutoffTimestampMs} ms) exceeds 15,000 ms limit before decision evaluation`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      // 6. Exact-Pair Market Data (DexScreener)
      const marketRetrievedAtMs = this.clock();
      const pairUrl = `${this.dexScreenerApiUrl}/latest/dex/pairs/solana/${this.poolId}`;
      const pairRes = await this.dispatchMeteredRequest({
        purpose: "EXACT_PAIR",
        providerName: "DEXSCREENER",
        url: pairUrl,
        signal: overallController.signal,
        skipBudgetRecording: false,
        overallDeadlineMs,
      });

      if (!pairRes.ok || !pairRes.json) {
        return this.finishWithFailure(
          "EXACT_PAIR_FETCH_FAILED",
          `Failed to acquire exact-pair market data: ${pairRes.error ?? "Empty response"}`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      const pairPayload = pairRes.json as {
        pairs?: Array<{
          chainId?: string;
          dexId?: string;
          pairAddress?: string;
          baseToken?: { address?: string; symbol?: string };
          quoteToken?: { address?: string; symbol?: string };
          priceNative?: string;
          priceUsd?: string;
          liquidity?: { usd?: number };
          marketCap?: number;
          fdv?: number;
          volume?: { m5?: number };
          txns?: { m5?: { buys?: number; sells?: number } };
          pairCreatedAt?: number;
          priceChange?: { m5?: number; h1?: number };
        }>;
      };

      const pairsArr = pairPayload.pairs;
      if (!Array.isArray(pairsArr) || pairsArr.length === 0 || !pairsArr[0]) {
        return this.finishWithFailure(
          "NO_DEX_PAIR_FOUND",
          "No matching pair found in DexScreener payload",
          {
            provisionalContext,
            flowEvaluation: flowResult,
          },
        );
      }

      const pair = pairsArr[0];

      // Validate exact chain, DEX, pool, and token orientation
      if (
        pair.chainId !== "solana" ||
        pair.dexId !== "raydium" ||
        pair.pairAddress !== this.poolId
      ) {
        return this.finishWithFailure(
          "PAIR_METADATA_MISMATCH",
          `DexScreener pair metadata mismatch: chain=${String(pair.chainId)}, dex=${String(pair.dexId)}, address=${String(pair.pairAddress)}`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      const isBaseCandidate =
        pair.baseToken?.address === this.mintAddress && pair.quoteToken?.address === WSOL_MINT;
      const isQuoteCandidate =
        pair.quoteToken?.address === this.mintAddress && pair.baseToken?.address === WSOL_MINT;

      if (!isBaseCandidate && !isQuoteCandidate) {
        return this.finishWithFailure(
          "INVALID_WSOL_ORIENTATION",
          `DexScreener pair is not WSOL-paired with candidate mint: base=${String(pair.baseToken?.address)}, quote=${String(pair.quoteToken?.address)}`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      const rawPriceNative = Number(pair.priceNative);
      if (!Number.isFinite(rawPriceNative) || rawPriceNative <= 0) {
        return this.finishWithFailure(
          "INVALID_SPOT_PRICE",
          `Invalid priceNative: ${String(pair.priceNative)}`,
          {
            provisionalContext,
            flowEvaluation: flowResult,
          },
        );
      }

      const spotPriceSol = isBaseCandidate ? rawPriceNative : 1 / rawPriceNative;
      let spotPriceUsd: number | null = null;
      if (isBaseCandidate) {
        if (
          typeof pair.priceUsd === "string" &&
          Number.isFinite(Number(pair.priceUsd)) &&
          Number(pair.priceUsd) > 0
        ) {
          spotPriceUsd = Number(pair.priceUsd);
        }
      } else if (isQuoteCandidate) {
        if (
          typeof pair.priceUsd === "string" &&
          Number.isFinite(Number(pair.priceUsd)) &&
          Number(pair.priceUsd) > 0 &&
          rawPriceNative > 0
        ) {
          spotPriceUsd = Number(pair.priceUsd) / rawPriceNative;
        }
      }

      // Actual marketCap required; FDV recorded separately without substituting
      if (
        typeof pair.marketCap !== "number" ||
        !Number.isFinite(pair.marketCap) ||
        pair.marketCap <= 0
      ) {
        return this.finishWithFailure(
          "INCOMPLETE_MARKET_INPUTS",
          `Actual marketCap is missing or invalid (got: ${String(pair.marketCap)}). FDV (${String(pair.fdv)}) cannot substitute.`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      const marketCapUsd = pair.marketCap;
      const fdvUsd = typeof pair.fdv === "number" && Number.isFinite(pair.fdv) ? pair.fdv : null;

      if (
        typeof pair.liquidity?.usd !== "number" ||
        !Number.isFinite(pair.liquidity.usd) ||
        pair.liquidity.usd <= 0
      ) {
        return this.finishWithFailure(
          "INCOMPLETE_MARKET_INPUTS",
          "Missing or non-finite liquidity.usd",
          {
            provisionalContext,
            flowEvaluation: flowResult,
          },
        );
      }
      const liquidityUsd = pair.liquidity.usd;

      if (
        typeof pair.pairCreatedAt !== "number" ||
        !Number.isFinite(pair.pairCreatedAt) ||
        pair.pairCreatedAt <= 0
      ) {
        return this.finishWithFailure(
          "INCOMPLETE_MARKET_INPUTS",
          "Missing or non-finite pairCreatedAt timestamp",
          {
            provisionalContext,
            flowEvaluation: flowResult,
          },
        );
      }
      const assetAgeSeconds = Math.max(0, Math.floor((this.clock() - pair.pairCreatedAt) / 1000));

      // Missing required volume/count fields must not become zero
      if (
        typeof pair.volume?.m5 !== "number" ||
        !Number.isFinite(pair.volume.m5) ||
        pair.volume.m5 < 0
      ) {
        return this.finishWithFailure(
          "INCOMPLETE_MARKET_INPUTS",
          `Missing or non-finite volume.m5: ${String(pair.volume?.m5)}`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }
      const volume5mUsd = pair.volume.m5;

      if (
        typeof pair.txns?.m5?.buys !== "number" ||
        !Number.isSafeInteger(pair.txns.m5.buys) ||
        pair.txns.m5.buys < 0
      ) {
        return this.finishWithFailure(
          "INCOMPLETE_MARKET_INPUTS",
          `Missing or invalid txns.m5.buys: ${String(pair.txns?.m5?.buys)}`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }
      const buys5m = pair.txns.m5.buys;

      if (
        typeof pair.txns?.m5?.sells !== "number" ||
        !Number.isSafeInteger(pair.txns.m5.sells) ||
        pair.txns.m5.sells < 0
      ) {
        return this.finishWithFailure(
          "INCOMPLETE_MARKET_INPUTS",
          `Missing or invalid txns.m5.sells: ${String(pair.txns?.m5?.sells)}`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }
      const sells5m = pair.txns.m5.sells;
      const buyToSellRatio = sells5m > 0 ? buys5m / sells5m : buys5m;
      const symbol =
        pair.baseToken?.address === this.mintAddress
          ? (pair.baseToken.symbol ?? "UNKNOWN")
          : (pair.quoteToken?.symbol ?? "UNKNOWN");

      const priceChange1hPct =
        typeof pair.priceChange?.h1 === "number" && Number.isFinite(pair.priceChange.h1)
          ? pair.priceChange.h1
          : undefined;

      const momentum5mBps =
        typeof pair.priceChange?.m5 === "number" && Number.isFinite(pair.priceChange.m5)
          ? Math.round(pair.priceChange.m5 * 100)
          : undefined;

      const candidateMarketData = {
        symbol,
        spotPriceSol,
        spotPriceUsd,
        liquidityUsd,
        marketCapUsd,
        fdvUsd,
        assetAgeSeconds,
        volume5mUsd,
        buys5m,
        sells5m,
        buyToSellRatio,
        priceChange1hPct,
        momentum5mBps,
      };
      this.retainedCandidateMarketData = { candidateMarketData, rawPair: pair };

      // 7. Fresh Validated LP Acquisition (2 RPC Requests via acquireRaydiumAmmV4Snapshot)
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before LP refresh",
          { provisionalContext, candidateMarketData, flowEvaluation: flowResult },
        );
      }

      const lpResult: SnapshotAcquisitionResult = await acquireRaydiumAmmV4Snapshot({
        poolId: this.poolId,
        expectedTokenMint: this.mintAddress,
        rpcUrl: this.rpcUrl,
        clock: () => new Date(this.clock()),
        sleeper: this.sleeper,
        fetch: async (input, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr) as { method?: string; params?: readonly unknown[] };
          const res = await this.dispatchSolanaRpc(
            "LP_REFRESH",
            parsed.method ?? "getAccountInfo",
            parsed.params ?? [],
            overallController.signal,
            false,
            overallDeadlineMs,
          );
          return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
        },
      });

      if (!lpResult.ok || !lpResult.evidence?.validationResult?.ok) {
        return this.finishWithFailure(
          "LP_ACQUISITION_FAILED",
          `Validated LP acquisition failed: ${lpResult.evidence?.failureReason ?? "Validation failure"}`,
          { provisionalContext, candidateMarketData, flowEvaluation: flowResult },
        );
      }

      const lpEvidence = lpResult.evidence;
      const validationResult = lpEvidence.validationResult;
      if (!validationResult || !validationResult.ok) {
        return this.finishWithFailure(
          "LP_ACQUISITION_FAILED",
          "Snapshot validation result is not successful",
          { provisionalContext, candidateMarketData, flowEvaluation: flowResult },
        );
      }

      // Validate provisional setup context against fresh validated LP context
      const validatedIdentities = lpEvidence.discoveredIdentities;
      if (!validatedIdentities) {
        return this.finishWithFailure(
          "PROVISIONAL_CONTEXT_MISMATCH",
          "No identities discovered in LP evidence",
          {
            provisionalContext,
            validatedIdentitiesMatch: false,
            candidateMarketData,
            flowEvaluation: flowResult,
          },
        );
      }
      const identitiesMatch =
        validatedIdentities.poolId === provisionalContext.poolId &&
        validatedIdentities.baseVault === provisionalContext.baseVault &&
        validatedIdentities.quoteVault === provisionalContext.quoteVault;

      if (!identitiesMatch) {
        return this.finishWithFailure(
          "PROVISIONAL_CONTEXT_MISMATCH",
          "Provisional setup identities contradict fresh validated LP evidence.",
          {
            provisionalContext,
            validatedIdentitiesMatch: false,
            candidateMarketData,
            flowEvaluation: flowResult,
          },
        );
      }

      this.retainedLpEvidence = lpEvidence;
      const lpBurnPct = validationResult.accounting.displayInaccessiblePct;
      // Unchanged 90% rule on validated LP evidence (single source for overlap gating and pre-admission).
      const lpEvidencePassesNinetyPercentRule =
        validationResult.accounting.meetsNinetyPercentThreshold &&
        typeof lpBurnPct === "number" &&
        lpBurnPct >= 90.0;

      // OPT-IN: overlap RugCheck retrieval with the provider pacing wait before CANDIDATE_MINT.
      // Never admits a candidate; may spend one RugCheck request before an authority rejection.
      if (this.overlapRugCheckWithMintPacing && lpEvidencePassesNinetyPercentRule) {
        this.pendingEarlyRugCheck = this.startEarlyRugCheck(
          overallController.signal,
          overallDeadlineMs,
          (cause) => {
            // A fatal overlapped failure (HTTP 429, request timeout, deadline) stops the supervising run
            // promptly, including a CANDIDATE_MINT request still waiting for pacing.
            this.earlyRugCheckFatalCause ??= cause;
            overallController.abort(cause);
          },
        );
      }

      // 8. Candidate Token Mint Account (Decimals & Authorities)
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return await this.finishWithFailureSettled(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before mint account query",
          {
            provisionalContext,
            validatedIdentitiesMatch: true,
            candidateMarketData,
            flowEvaluation: flowResult,
          },
        );
      }

      const mintRetrievedAtMs = this.clock();
      const mintRes = await this.dispatchSolanaRpc(
        "CANDIDATE_MINT",
        "getAccountInfo",
        [this.mintAddress, { encoding: "jsonParsed", commitment: "confirmed" }],
        overallController.signal,
        false,
        overallDeadlineMs,
      );

      if (!mintRes.ok || !mintRes.json) {
        return await this.finishWithFailureSettled(
          "CANDIDATE_MINT_FETCH_FAILED",
          `Failed to acquire candidate token mint account: ${mintRes.error ?? "Empty response"}`,
          {
            provisionalContext,
            validatedIdentitiesMatch: true,
            candidateMarketData,
            flowEvaluation: flowResult,
          },
        );
      }

      const parsedMintRes = parseSolanaRpcMintAccountResponse(
        mintRes.json,
        this.mintAddress as TokenMintAddress,
        new Date(this.clock()),
        "JSON_PARSED",
      );

      if (!parsedMintRes.ok) {
        return await this.finishWithFailureSettled(
          "CANDIDATE_MINT_PARSE_FAILED",
          `Candidate mint account parsing failed: ${parsedMintRes.message}`,
          {
            provisionalContext,
            validatedIdentitiesMatch: true,
            candidateMarketData,
            flowEvaluation: flowResult,
          },
        );
      }

      // Explicit authority observation checks: validate against Solana RPC schema
      const rawMintVal = (
        mintRes.json.result as {
          value?: { data?: { parsed?: { info?: Record<string, unknown> } } };
        }
      )?.value;
      const rawInfo = rawMintVal?.data?.parsed?.info;

      const mintEval = evaluateAuthorityEvidence(rawInfo, "mintAuthority");
      const freezeEval = evaluateAuthorityEvidence(rawInfo, "freezeAuthority");

      const candidateMintAccount = {
        decimals: typeof rawInfo?.decimals === "number" ? rawInfo.decimals : undefined,
        mintAuthority: mintEval.address,
        freezeAuthority: freezeEval.address,
        mintAuthorityStatus: mintEval.status,
        freezeAuthorityStatus: freezeEval.status,
        mintAuthorityRenounced: mintEval.isRenounced,
        freezeAuthorityRenounced: freezeEval.isRenounced,
      };
      this.retainedCandidateMintAccount = { candidateMintAccount, rawMintResponse: mintRes.json };

      // =========================================================================
      // PHASE 4: Pre-Admission Screening (LP & Authorities Preconditions)
      // =========================================================================
      const lpSecurityPassed = lpEvidencePassesNinetyPercentRule;
      const mintAuthorityPassed = mintEval.status === "DISABLED";
      const freezeAuthorityPassed = freezeEval.status === "DISABLED";
      const preAdmissionPassed = lpSecurityPassed && mintAuthorityPassed && freezeAuthorityPassed;

      let preAdmissionRejectionReason: string | undefined;
      if (!lpSecurityPassed) {
        preAdmissionRejectionReason = "REJECTED_UNLOCKED_LP_RISK";
      } else if (!freezeAuthorityPassed) {
        if (freezeEval.status === "OMITTED") {
          preAdmissionRejectionReason = "REJECTED_UNKNOWN_FREEZE_AUTHORITY";
        } else if (freezeEval.status === "MALFORMED") {
          preAdmissionRejectionReason = "REJECTED_MALFORMED_FREEZE_AUTHORITY";
        } else {
          preAdmissionRejectionReason = "REJECTED_ACTIVE_FREEZE_AUTHORITY";
        }
      } else if (!mintAuthorityPassed) {
        if (mintEval.status === "OMITTED") {
          preAdmissionRejectionReason = "REJECTED_UNKNOWN_MINT_AUTHORITY";
        } else if (mintEval.status === "MALFORMED") {
          preAdmissionRejectionReason = "REJECTED_MALFORMED_MINT_AUTHORITY";
        } else {
          preAdmissionRejectionReason = "REJECTED_ACTIVE_MINT_AUTHORITY";
        }
      }

      const preAdmissionScreening = {
        lpBurnPct,
        lpSecurityPassed,
        mintAuthorityPassed,
        freezeAuthorityPassed,
        passed: preAdmissionPassed,
        rejectionReason: preAdmissionRejectionReason,
      };
      this.retainedPreAdmissionScreening = preAdmissionScreening;

      if (!preAdmissionPassed) {
        return await this.finishWithFailureSettled(
          "PRE_ADMISSION_REJECTED",
          `Pre-admission screening failed: ${preAdmissionRejectionReason}`,
          {
            provisionalContext,
            validatedIdentitiesMatch: true,
            candidateMarketData,
            candidateMintAccount,
            preAdmissionScreening,
            flowEvaluation: flowResult,
          },
        );
      }

      // =========================================================================
      // PHASE 5: Security Reports (RugCheck & Solana Tracker Bundler Proxy)
      // =========================================================================
      // 9. RugCheck report (serial by default; consumed from the overlapped request when opted in)
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return await this.finishWithFailureSettled(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before RugCheck query",
          {
            provisionalContext,
            validatedIdentitiesMatch: true,
            candidateMarketData,
            candidateMintAccount,
            preAdmissionScreening,
            flowEvaluation: flowResult,
          },
        );
      }

      let rugCheckRetrievedAtMs: number;
      let rcRes: MeteredResponse;
      const earlyRugCheck = this.pendingEarlyRugCheck;
      if (earlyRugCheck) {
        // Bounded by the per-request timeout and overall deadline enforced inside the dispatch.
        const outcome = await earlyRugCheck.settled;
        this.pendingEarlyRugCheck = null;
        if (outcome.kind === "rejected") {
          throw outcome.err;
        }
        rugCheckRetrievedAtMs = earlyRugCheck.retrievedAtMs;
        rcRes = outcome.res;
      } else {
        rugCheckRetrievedAtMs = this.clock();
        rcRes = await this.dispatchRugCheckReport(overallController.signal, overallDeadlineMs);
      }

      // Metrics only from a complete, successfully parsed body via the shared strict validator.
      // Over-limit, truncated, malformed, or failed responses remain unavailable (null).
      const validatedRugCheck =
        rcRes.ok && rcRes.json !== null
          ? BuyGateTriggerService.validateRugCheckReportPayload(rcRes.json)
          : null;
      let rugMetrics: {
        rugScore?: number;
        hasDangerRisk?: boolean;
        bundlerPct?: number;
        top10HolderPct?: number;
        holdersCount?: number;
      } | null = null;
      if (validatedRugCheck) {
        rugMetrics = {
          ...(validatedRugCheck.rugScore !== undefined
            ? { rugScore: validatedRugCheck.rugScore }
            : {}),
          ...(validatedRugCheck.hasDangerRisk !== undefined
            ? { hasDangerRisk: validatedRugCheck.hasDangerRisk }
            : {}),
          ...(validatedRugCheck.top10HolderPct !== undefined
            ? { top10HolderPct: validatedRugCheck.top10HolderPct }
            : {}),
          ...(validatedRugCheck.holdersCount !== undefined
            ? { holdersCount: validatedRugCheck.holdersCount }
            : {}),
        };
      }
      const rcRecord = this.ledger.records.find((r) => r.purpose === "RUGCHECK_REPORT");
      // The complete sanitized response is sealed once (responseFile); derived evidence references it.
      this.retainedRugCheckEvidence = {
        rugMetrics,
        validationStatus: !rcRes.ok
          ? "REQUEST_NOT_OK"
          : rcRes.json === null
            ? "RESPONSE_NOT_JSON"
            : rugMetrics
              ? "AVAILABLE"
              : "VALIDATION_REJECTED",
        responseFile: rcRecord?.responseFile ?? null,
        wireDigestSha256: rcRecord?.wireDigestSha256 ?? null,
        responseBodyMetadata: rcRecord?.responseBodyMetadata ?? null,
        retrievalMode: earlyRugCheck
          ? "OVERLAPPED_WITH_CANDIDATE_MINT_PACING"
          : "SERIAL_AFTER_PRE_ADMISSION",
        retrievedAtMs: rugCheckRetrievedAtMs,
        payload: "NOT_DUPLICATED: complete sanitized response is sealed only in responseFile",
      };

      // 10. Solana Tracker Bundler Proxy
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before bundler query",
          {
            provisionalContext,
            validatedIdentitiesMatch: true,
            candidateMarketData,
            candidateMintAccount,
            preAdmissionScreening,
            flowEvaluation: flowResult,
          },
        );
      }

      const bundlerRetrievedAtMs = this.clock();
      const stUrl = `${this.solanaTrackerApiUrl}/tokens/${encodeURIComponent(this.mintAddress)}/bundlers`;
      const stHeaders: Record<string, string> = {};
      if (this.solanaTrackerApiKey) {
        stHeaders["x-api-key"] = this.solanaTrackerApiKey;
      }

      const stRes = await this.dispatchMeteredRequest({
        purpose: "SOLANA_TRACKER_BUNDLERS",
        providerName: "SOLANA_TRACKER",
        url: stUrl,
        headers: stHeaders,
        signal: overallController.signal,
        skipBudgetRecording: false,
        overallDeadlineMs,
      });

      if (stRes.ok && stRes.json) {
        const parsedBundler = parseSolanaTrackerBundlersResponse(stRes.json, {
          requestedMint: this.mintAddress,
          localRetrievedAtMs: bundlerRetrievedAtMs,
        });
        if (parsedBundler.success) {
          // Do not coerce PRODUCTION into PAPER_SIMULATION
          const adapted = adaptPaperBundlerSnapshot({
            targetMint: this.mintAddress,
            snapshot: parsedBundler.data,
            evaluationTimeMs: this.clock(),
            executionContext: this.executionContext as PaperBundlerExecutionContext,
            maxAllowedRetrievalAgeMs: 15_000,
          });
          if (adapted.success && adapted.bundlerPct !== undefined) {
            rugMetrics = {
              ...rugMetrics,
              bundlerPct: adapted.bundlerPct,
            };
          }
          this.retainedBundlerEvidence = {
            bundlerSnapshot: parsedBundler.data,
            adaptedBundler: adapted,
            rawBundler: stRes.json,
          };
        }
      }

      // =========================================================================
      // PHASE 6: Final Freshness Recheck & Decision Point Evaluation
      // =========================================================================
      const decisionTimeMs = this.clock();
      const maxAgeMs = 15_000;

      // Recheck source cutoff age
      if (decisionTimeMs - sourceCutoff.cutoffTimestampMs > maxAgeMs) {
        return this.finishWithFailure(
          "STALE_DATA",
          `Cutoff age (${decisionTimeMs - sourceCutoff.cutoffTimestampMs} ms) exceeds ${maxAgeMs} ms at decision timestamp`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      // Recheck LP evidence retrieval age
      const lpRetrievedMs = lpEvidence.retrievedAtIso
        ? Date.parse(lpEvidence.retrievedAtIso)
        : startedAtMs;
      if (decisionTimeMs - lpRetrievedMs > maxAgeMs) {
        return this.finishWithFailure(
          "STALE_DATA",
          `LP evidence age (${decisionTimeMs - lpRetrievedMs} ms) exceeds ${maxAgeMs} ms at decision timestamp`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      // Recheck market data retrieval age
      if (decisionTimeMs - marketRetrievedAtMs > maxAgeMs) {
        return this.finishWithFailure(
          "STALE_DATA",
          `Market data age (${decisionTimeMs - marketRetrievedAtMs} ms) exceeds ${maxAgeMs} ms at decision timestamp`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      // Recheck mint account retrieval age
      if (decisionTimeMs - mintRetrievedAtMs > maxAgeMs) {
        return this.finishWithFailure(
          "STALE_DATA",
          `Mint account age (${decisionTimeMs - mintRetrievedAtMs} ms) exceeds ${maxAgeMs} ms at decision timestamp`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      // Recheck RugCheck retrieval age
      if (decisionTimeMs - rugCheckRetrievedAtMs > maxAgeMs) {
        return this.finishWithFailure(
          "STALE_DATA",
          `RugCheck evidence age (${decisionTimeMs - rugCheckRetrievedAtMs} ms) exceeds ${maxAgeMs} ms at decision timestamp`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      // Recheck Solana Tracker retrieval age
      if (decisionTimeMs - bundlerRetrievedAtMs > maxAgeMs) {
        return this.finishWithFailure(
          "STALE_DATA",
          `Bundler evidence age (${decisionTimeMs - bundlerRetrievedAtMs} ms) exceeds ${maxAgeMs} ms at decision timestamp`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      const watchlistCandidate: WatchlistCandidateItem = {
        poolId: this.poolId,
        mintAddress: this.mintAddress,
        symbol: candidateMarketData.symbol,
        liquidityUsd: candidateMarketData.liquidityUsd,
        marketCapUsd: candidateMarketData.marketCapUsd,
        lmcRatio: candidateMarketData.liquidityUsd / candidateMarketData.marketCapUsd,
        lpBurnPct,
        assetAgeSeconds: candidateMarketData.assetAgeSeconds,
        volume5mUsd: candidateMarketData.volume5mUsd,
        buys5m: candidateMarketData.buys5m,
        sells5m: candidateMarketData.sells5m,
        buyToSellRatio: candidateMarketData.buyToSellRatio,
        status: "WATCHING",
        discoveredAt: new Date(startedAtMs).toISOString(),
        lastEvaluatedAt: new Date(decisionTimeMs).toISOString(),
      };

      const immutableFlowProvider: CandidateFlowProvider = {
        getCandidateFlow: (target, evalMs) => {
          if (
            (isQuietQualified || isActiveQualified) &&
            (this.executionContext === "PAPER_SIMULATION" || this.executionContext === "BACKTEST")
          ) {
            return paperAdapter.convertCandidateFlow(reconResult, target, evalMs, {
              executionContext: this.executionContext,
              maxAllowedEvidenceAgeMs: 15_000,
              ...(isActiveQualified ? { allowActiveWindowQualification: true } : {}),
            });
          }
          return {
            ...flowResult,
            evaluationTimestampMs: evalMs,
          };
        },
      };

      const decisionResult = evaluateCandidateDecisionPoints({
        candidate: watchlistCandidate,
        baseSpotInfo: {
          spotPriceSol: candidateMarketData.spotPriceSol,
          spotPriceUsd: candidateMarketData.spotPriceUsd,
          liquidityUsd: candidateMarketData.liquidityUsd,
          momentum5mBps: candidateMarketData.momentum5mBps,
          priceChange1hPct: candidateMarketData.priceChange1hPct,
        },
        rugMetrics,
        flowProvider: immutableFlowProvider,
        currentNowMs: decisionTimeMs,
        requireVerifiedHolders: true,
        executionContext: this.executionContext,
      });

      return this.finishWithSuccess({
        provisionalContext,
        validatedIdentitiesMatch: true,
        candidateMarketData,
        candidateMintAccount,
        preAdmissionScreening,
        flowEvaluation: decisionResult.flowResult,
        decisionResult,
        observationMetadata:
          observationStartMs > 0
            ? {
                observationStartMs,
                observationEndMs,
                observationDurationMs:
                  observationEndMs > observationStartMs
                    ? observationEndMs - observationStartMs
                    : this.observationDurationMs,
                cutoffTimestampMs,
                notificationsReceived,
              }
            : undefined,
        keepaliveMetrics: {
          clientPingsSentCount,
          matchedClientPongsCount,
          unmatchedClientPongsCount,
          controlFramesCount,
          controlFramePayloadBytes,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        this.streamExceptionCapture?.(`EXCEPTION:${msg.slice(0, 120)}`);
      } catch {
        // telemetry capture must never mask the original failure
      }
      const isTimeout =
        overallController.signal.aborted ||
        this.clock() >= overallDeadlineMs ||
        msg.includes("OVERALL_DIAGNOSTIC_TIMEOUT") ||
        msg.includes("REQUEST_TIMEOUT");
      const isCutoffWindow = msg.includes("[CUTOFF_DISPATCH_WINDOW_EXCEEDED]");
      if (isCutoffWindow) this.boundedStopReason = "CUTOFF_DISPATCH_WINDOW_EXCEEDED";
      return await this.finishWithFailureSettled(
        isCutoffWindow
          ? "CUTOFF_DISPATCH_WINDOW_EXCEEDED"
          : isTimeout
            ? "OVERALL_DIAGNOSTIC_TIMEOUT"
            : "UNHANDLED_EXCEPTION",
        msg,
      );
    } finally {
      cleanupKeepalive();
      clearTimeout(overallTimer);
      if (coordinator) {
        try {
          coordinator.close();
        } catch {
          // ignore cleanup error
        }
      }
      if (activeWsTransport) {
        try {
          const keepalive = activeWsTransport as Partial<ISolanaKeepaliveWebSocketTransport>;
          if (typeof keepalive.terminate === "function") {
            keepalive.terminate();
          } else if (typeof activeWsTransport.close === "function") {
            activeWsTransport.close();
          }
        } catch {
          // ignore cleanup error
        }
      }
      if (liveWsTransport && liveWsTransport !== activeWsTransport) {
        try {
          liveWsTransport.close();
        } catch {
          // ignore cleanup error
        }
      }
    }
  }

  /**
   * Starts the opt-in overlapped RugCheck request with its own abort controller linked to the overall signal.
   * Rejections are captured immediately so no unhandled rejection can escape.
   */
  private startEarlyRugCheck(
    overallSignal: AbortSignal,
    overallDeadlineMs: number,
    stopRun: (cause: Error) => void,
  ): EarlyRugCheckHandle {
    const controller = new AbortController();
    const onOverallAbort = () => controller.abort(overallSignal.reason ?? "OVERALL_ABORTED");
    if (overallSignal.aborted) {
      onOverallAbort();
    } else {
      overallSignal.addEventListener("abort", onOverallAbort, { once: true });
    }
    const retrievedAtMs = this.clock();
    const settled = this.dispatchRugCheckReport(controller.signal, overallDeadlineMs)
      .then(
        (res) => ({ kind: "fulfilled" as const, res }),
        (err: unknown) => {
          // Cancellation initiated by the run, or a run already stopped, is not a new cause.
          // Ordinary unavailable data (HTTP errors, over-limit, invalid bodies) fulfils, not rejects.
          if (!controller.signal.aborted && !overallSignal.aborted) {
            stopRun(err instanceof Error ? err : new Error(String(err)));
          }
          return { kind: "rejected" as const, err };
        },
      )
      .finally(() => overallSignal.removeEventListener("abort", onOverallAbort));
    return { controller, retrievedAtMs, settled };
  }

  /** Single RUGCHECK_REPORT dispatch (one request per provider purpose; no retries). */
  private async dispatchRugCheckReport(
    signal: AbortSignal,
    overallDeadlineMs: number,
  ): Promise<MeteredResponse> {
    if (this.ledger.rugCheckAttempts > 0) {
      throw new Error("[RUGCHECK_SINGLE_REQUEST_VIOLATION] RUGCHECK_REPORT already dispatched");
    }
    const rcUrl = `${this.rugCheckApiUrl}/v1/tokens/${encodeURIComponent(this.mintAddress)}/report`;
    return this.dispatchMeteredRequest({
      purpose: "RUGCHECK_REPORT",
      providerName: "RUGCHECK",
      url: rcUrl,
      signal,
      skipBudgetRecording: false,
      overallDeadlineMs,
    });
  }

  /**
   * Cancels any overlapped RugCheck request and waits (bounded) for it to settle, so that its attempt is
   * recorded exactly once and no work remains pending when evidence is sealed. Returns false if the bound elapsed.
   */
  private async cancelAndSettleEarlyRugCheck(reason: string): Promise<boolean> {
    const handle = this.pendingEarlyRugCheck;
    if (!handle) return true;
    handle.controller.abort(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settledInBound = await Promise.race([
      handle.settled.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), EARLY_RUGCHECK_SETTLE_BOUND_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    this.pendingEarlyRugCheck = null;
    return settledInBound;
  }

  /** Terminal failure that first cancels and settles any overlapped RugCheck request. */
  private async finishWithFailureSettled(
    status: string,
    message: string,
    partialData?: Partial<CandidateDecisionDiagnosticResult>,
  ): Promise<CandidateDecisionDiagnosticResult> {
    const settled = await this.cancelAndSettleEarlyRugCheck(`TERMINATED_${status}`);
    if (!settled) {
      return this.finishWithFailure(
        "EARLY_RUGCHECK_UNSETTLED",
        `${message}; overlapped RugCheck request did not settle within ${EARLY_RUGCHECK_SETTLE_BOUND_MS} ms after cancellation`,
        partialData,
      );
    }
    const cause = this.earlyRugCheckFatalCause;
    if (cause) {
      // Same status mapping as a serial RugCheck failure (HTTP 429 -> UNHANDLED_EXCEPTION; timeouts ->
      // OVERALL_DIAGNOSTIC_TIMEOUT), with the original cause message first.
      const causeIsTimeout =
        cause.message.includes("OVERALL_DIAGNOSTIC_TIMEOUT") ||
        cause.message.includes("REQUEST_TIMEOUT");
      return this.finishWithFailure(
        causeIsTimeout ? "OVERALL_DIAGNOSTIC_TIMEOUT" : "UNHANDLED_EXCEPTION",
        message === cause.message
          ? cause.message
          : `${cause.message} [overlapped RUGCHECK_REPORT stopped the run; superseded ${status}: ${message}]`,
        partialData,
      );
    }
    return this.finishWithFailure(status, message, partialData);
  }

  private finishWithFailure(
    status: string,
    message: string,
    partialData?: Partial<CandidateDecisionDiagnosticResult>,
  ): CandidateDecisionDiagnosticResult {
    let finalized: ReturnType<NonNullable<typeof this.streamTelemetryFinalizer>> | null = null;
    try {
      finalized = this.streamTelemetryFinalizer?.() ?? null;
    } catch {
      finalized = null;
    }
    if (finalized) this.retainedStreamTelemetry = finalized.telemetry;
    const result: CandidateDecisionDiagnosticResult = {
      ok: false,
      status,
      message,
      poolId: this.poolId,
      mintAddress: this.mintAddress,
      executionContext: this.executionContext,
      ledger: this.ledger,
      ...(this.outDir !== undefined ? { outDir: this.outDir } : {}),
      ...(finalized?.observationMetadata
        ? { observationMetadata: finalized.observationMetadata }
        : {}),
      ...(finalized?.keepaliveMetrics ? { keepaliveMetrics: finalized.keepaliveMetrics } : {}),
      ...this.capacityReportFields(),
      ...partialData,
    };
    try {
      this.writeDiagnosticArtifacts(result);
    } catch (writeErr) {
      result.writeError = writeErr instanceof Error ? writeErr.message : String(writeErr);
    }
    return result;
  }

  private finishWithSuccess(
    data: Omit<
      CandidateDecisionDiagnosticResult,
      "ok" | "status" | "message" | "poolId" | "mintAddress" | "executionContext" | "ledger"
    >,
  ): CandidateDecisionDiagnosticResult {
    const outcome = data.decisionResult?.outcome ?? "UNKNOWN";
    const result: CandidateDecisionDiagnosticResult = {
      ok: true,
      status: outcome,
      message: `Diagnostic completed successfully with decision outcome: ${outcome}`,
      poolId: this.poolId,
      mintAddress: this.mintAddress,
      executionContext: this.executionContext,
      ledger: this.ledger,
      ...(this.outDir !== undefined ? { outDir: this.outDir } : {}),
      ...this.capacityReportFields(),
      ...data,
    };
    try {
      this.writeDiagnosticArtifacts(result);
      return result;
    } catch (writeErr) {
      return {
        ok: false,
        status: "ARTIFACT_WRITE_FAILED",
        message: writeErr instanceof Error ? writeErr.message : String(writeErr),
        poolId: this.poolId,
        mintAddress: this.mintAddress,
        executionContext: this.executionContext,
        ledger: this.ledger,
        ...(this.outDir !== undefined ? { outDir: this.outDir } : {}),
        ...data,
      };
    }
  }

  private writeDiagnosticArtifacts(result: CandidateDecisionDiagnosticResult): void {
    if (this.pendingEarlyRugCheck !== null) {
      throw new Error(
        "[EARLY_RUGCHECK_PENDING] Refusing to seal evidence while an overlapped RugCheck request is unsettled",
      );
    }
    const targetDir =
      this.outDir ??
      path.resolve(
        process.cwd(),
        "data",
        "research",
        "diagnostics",
        `diagnostic-${this.poolId.slice(0, 8)}-${this.clock()}`,
      );

    if (existsSync(targetDir)) {
      // Refuse overwriting an existing diagnostic
      const existingReport = path.join(targetDir, "diagnostic-report.json");
      const existingManifest = path.join(targetDir, "evidence-manifest.json");
      if (existsSync(existingReport) || existsSync(existingManifest)) {
        throw new Error(
          `[DIAGNOSTIC_OUTPUT_EXISTS] Target output directory already contains diagnostic artifacts: ${targetDir}. Refusing to overwrite.`,
        );
      }
    } else {
      mkdirSync(targetDir, { recursive: true });
    }

    const evidenceDir = path.join(targetDir, "evidence");
    const responsesDir = path.join(targetDir, "responses");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(responsesDir, { recursive: true });

    const manifestFiles: Array<{
      path: string;
      category: "REPORT" | "EVIDENCE" | "RESPONSE";
      sha256: string;
      bytes: number;
    }> = [];

    const writeSanitizedFile = (
      relPath: string,
      category: "REPORT" | "EVIDENCE" | "RESPONSE",
      data: unknown,
    ): { sha256: string; bytes: number } => {
      const sanitized = deepRedactSensitiveObject(data, this.sensitiveTokens);
      const content = typeof sanitized === "string" ? sanitized : safeJsonStringify(sanitized);
      const fullPath = path.join(targetDir, relPath);
      mkdirSync(path.dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
      const buf = Buffer.from(content, "utf8");
      const sha256 = createHash("sha256").update(buf).digest("hex");
      manifestFiles.push({
        path: relPath.replace(/\\/g, "/"),
        category,
        sha256,
        bytes: buf.length,
      });
      return { sha256, bytes: buf.length };
    };

    // 1. Write sealed response files
    for (const resp of this.recordedResponses) {
      writeSanitizedFile(resp.responseFile, "RESPONSE", resp.json ?? resp.text);
    }

    // 2. Write sealed evidence files
    if (this.retainedProvisionalContext) {
      writeSanitizedFile(
        "evidence/provisional-context.json",
        "EVIDENCE",
        this.retainedProvisionalContext,
      );
    }
    if (this.retainedSourceCutoff) {
      writeSanitizedFile("evidence/cutoff-evidence.json", "EVIDENCE", this.retainedSourceCutoff);
    }
    if (this.retainedHistoryResult) {
      writeSanitizedFile("evidence/history-evidence.json", "EVIDENCE", this.retainedHistoryResult);
    }
    if (this.retainedLpEvidence) {
      writeSanitizedFile("evidence/lp-evidence.json", "EVIDENCE", this.retainedLpEvidence);
    }
    if (this.retainedCandidateMarketData) {
      writeSanitizedFile("evidence/market-data.json", "EVIDENCE", this.retainedCandidateMarketData);
    }
    if (this.retainedCandidateMintAccount) {
      writeSanitizedFile(
        "evidence/mint-account.json",
        "EVIDENCE",
        this.retainedCandidateMintAccount,
      );
    }
    if (this.retainedPreAdmissionScreening) {
      writeSanitizedFile(
        "evidence/pre-admission.json",
        "EVIDENCE",
        this.retainedPreAdmissionScreening,
      );
    }
    if (this.retainedRugCheckEvidence) {
      writeSanitizedFile(
        "evidence/rugcheck-report.json",
        "EVIDENCE",
        this.retainedRugCheckEvidence,
      );
    }
    if (this.retainedStreamTelemetry) {
      writeSanitizedFile(
        "evidence/stream-telemetry.json",
        "EVIDENCE",
        this.retainedStreamTelemetry,
      );
    }
    if (this.retainedActiveWindowEvidence) {
      writeSanitizedFile(
        "evidence/active-window-evidence.json",
        "EVIDENCE",
        this.retainedActiveWindowEvidence,
      );
    }
    if (this.retainedBundlerEvidence) {
      writeSanitizedFile(
        "evidence/bundler-provenance.json",
        "EVIDENCE",
        this.retainedBundlerEvidence,
      );
    }
    if (result.flowEvaluation) {
      writeSanitizedFile("evidence/flow-evaluation.json", "EVIDENCE", result.flowEvaluation);
    }
    if (result.decisionResult) {
      writeSanitizedFile("evidence/decision-result.json", "EVIDENCE", result.decisionResult);
    }

    // 3. Write diagnostic-report.json
    const reportFileMeta = writeSanitizedFile("diagnostic-report.json", "REPORT", result);

    // 4. Write evidence-manifest.json
    const manifestEntries = this.ledger.records.map((r) => ({
      purpose: r.purpose,
      provider: r.provider,
      endpoint: r.endpoint,
      method: r.method,
      ...(r.params !== undefined ? { params: r.params } : {}),
      dispatchedAtMs: r.dispatchedAtMs,
      completedAtMs: r.completedAtMs,
      durationMs: r.completedAtMs - r.dispatchedAtMs,
      ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
      ok: r.ok,
      ...(r.error !== undefined
        ? { error: redactSensitiveText(r.error, this.sensitiveTokens) }
        : {}),
      ...(r.wireDigestSha256 !== undefined ? { wireDigestSha256: r.wireDigestSha256 } : {}),
      ...(r.responseFile !== undefined ? { responseFile: r.responseFile.replace(/\\/g, "/") } : {}),
    }));

    const manifest = {
      poolId: this.poolId,
      mintAddress: this.mintAddress,
      generatedAtIso: new Date(this.clock()).toISOString(),
      reportFile: {
        path: "diagnostic-report.json",
        sha256: reportFileMeta.sha256,
        bytes: reportFileMeta.bytes,
      },
      files: manifestFiles,
      requests: manifestEntries,
    };

    const sanitizedManifest = deepRedactSensitiveObject(manifest, this.sensitiveTokens);
    const manifestJson = safeJsonStringify(sanitizedManifest);
    const manifestPath = path.join(targetDir, "evidence-manifest.json");
    writeFileSync(manifestPath, manifestJson, "utf8");

    const manifestDigest = createHash("sha256")
      .update(Buffer.from(manifestJson, "utf8"))
      .digest("hex");
    (result as { manifestDigestSha256?: string }).manifestDigestSha256 = manifestDigest;
  }
}

export interface ReplayVerificationItem {
  readonly path: string;
  readonly expectedBytes: number;
  readonly actualBytes: number;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  readonly valid: boolean;
}

/**
 * How the replay treated the sealed capture after integrity verification.
 * - DECISION_REEVALUATED: the sealed report recorded a completed decision; the decision was
 *   re-evaluated offline at the recorded decision timestamp.
 * - RECORDED_TERMINATION_PRESERVED: the sealed report recorded a terminal failure (e.g. STALE_DATA)
 *   before any decision; that termination is returned unchanged and no Buy Gate decision is evaluated.
 */
export type CandidateDecisionReplayMode = "DECISION_REEVALUATED" | "RECORDED_TERMINATION_PRESERVED";

export interface CandidateDecisionReplayObservationAudit {
  /** RECORDED when the sealed report carries observationMetadata; otherwise every observation field is null. */
  readonly observationMetadataStatus: "RECORDED" | "NOT_RECORDED_IN_SEALED_REPORT";
  readonly observationStartMs: number | null;
  readonly observationEndMs: number | null;
  readonly observationDurationMs: number | null;
  readonly notificationsReceived: number | null;
  /** Source cutoff from the verified cutoff evidence file, or null when unusable. */
  readonly cutoffTimestampMs: number | null;
  /** Connection epoch recorded in the verified history evidence, or null when not recorded. */
  readonly historyConnectionEpoch: number | null;
  /** Connection epoch recorded on the flow evaluation, or null when not recorded. */
  readonly flowConnectionEpoch: number | null;
  readonly keepaliveMetricsStatus: "RECORDED" | "NOT_RECORDED_IN_SEALED_REPORT";
  readonly keepaliveStats: CandidateDecisionDiagnosticResult["keepaliveMetrics"] | null;
}

export interface CandidateDecisionReplayGapAudit {
  readonly flowCoverage: string | null;
  readonly isCoverageSufficient: boolean | null;
  readonly diagnosticReason: string | null;
  readonly historyOutcome: string | null;
  /**
   * Rows returned by the HISTORY_ENUMERATION RPC page(s), counted from verified sealed response
   * files. Includes rows at or older than the anchor. Null when not derivable from verified evidence.
   */
  readonly historyEnumerationRowsReturned: number | null;
  readonly historyEnumerationRowsBasis: string;
  /**
   * Signatures newer than the witnessed prior anchor (history evidence `discoveredSignatures`).
   * Null unless the history outcome is ANCHOR_WITNESSED with a well-formed list.
   */
  readonly newSignaturesSinceAnchor: number | null;
}

export interface CandidateDecisionReplayPreAdmission {
  readonly lpBurnPct: number | null;
  readonly lpSecurityPassed: boolean;
  readonly mintAuthorityStatus: AuthorityStatus;
  readonly freezeAuthorityStatus: AuthorityStatus;
  readonly passed: boolean;
  readonly rejectionReason: string | null;
}

export interface CandidateDecisionReplayRugCheck {
  /**
   * AVAILABLE: metrics recomputed from a verified, complete sealed response.
   * NOT_DISPATCHED / REQUEST_NOT_OK / RESPONSE_NOT_VERIFIED / RESPONSE_NOT_JSON / VALIDATION_REJECTED:
   * metrics unavailable (never derived from truncated or unverified bodies).
   */
  readonly status:
    | "AVAILABLE"
    | "NOT_DISPATCHED"
    | "REQUEST_NOT_OK"
    | "RESPONSE_NOT_VERIFIED"
    | "RESPONSE_NOT_JSON"
    | "VALIDATION_REJECTED";
  readonly responseFile: string | null;
  readonly metrics: RugCheckMetrics | null;
}

type RugCheckMetrics = {
  rugScore?: number;
  hasDangerRisk?: boolean;
  bundlerPct?: number;
  top10HolderPct?: number;
  holdersCount?: number;
};

/**
 * Recomputes RugCheck metrics from the verified sealed RUGCHECK_REPORT response using the same strict
 * validator as live retrieval. Uses only the verified report ledger and verified response files.
 */
function recomputeRugCheckFromSealedResponse(
  evidenceDir: string,
  report: { ledger?: { records?: unknown } } | null | undefined,
  verifiedFilesSet: ReadonlySet<string>,
): CandidateDecisionReplayRugCheck {
  const records = Array.isArray(report?.ledger?.records) ? report.ledger.records : [];
  const rcRecords = records.filter(
    (r): r is { ok?: unknown; responseFile?: unknown } =>
      !!r && typeof r === "object" && (r as { purpose?: unknown }).purpose === "RUGCHECK_REPORT",
  );
  if (rcRecords.length === 0) {
    return { status: "NOT_DISPATCHED", responseFile: null, metrics: null };
  }
  // One request per provider purpose: more than one record is not a valid capture shape.
  const rec = rcRecords.length === 1 ? rcRecords[0] : undefined;
  const responseFile =
    typeof rec?.responseFile === "string" ? rec.responseFile.replace(/\\/g, "/") : null;
  if (!rec || rec.ok !== true) {
    return { status: "REQUEST_NOT_OK", responseFile, metrics: null };
  }
  if (responseFile === null || !verifiedFilesSet.has(responseFile)) {
    return { status: "RESPONSE_NOT_VERIFIED", responseFile, metrics: null };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path.join(evidenceDir, responseFile), "utf8"));
  } catch {
    return { status: "RESPONSE_NOT_JSON", responseFile, metrics: null };
  }
  const metrics = BuyGateTriggerService.validateRugCheckReportPayload(payload);
  return metrics
    ? { status: "AVAILABLE", responseFile, metrics }
    : { status: "VALIDATION_REJECTED", responseFile, metrics: null };
}

function rugMetricsEqual(a: RugCheckMetrics | null, b: RugCheckMetrics | null): boolean {
  if (a === null || b === null) return a === b;
  const keys: Array<keyof RugCheckMetrics> = [
    "rugScore",
    "hasDangerRisk",
    "bundlerPct",
    "top10HolderPct",
    "holdersCount",
  ];
  return keys.every((k) => a[k] === b[k]);
}

export interface CandidateDecisionReplayActiveWindow {
  readonly reconciliationStatus: string;
  readonly diagnosticReason: string;
  readonly recentBuys60s: number | null;
  readonly recentSells60s: number | null;
  readonly windowSignaturesCount: number | null;
  readonly redecodedTransactions: number;
  /** Sealed failed-transaction policy honoured by this replay (null: legacy capture, original interpretation). */
  readonly failedTransactionPolicy: string | null;
  /** Failed transactions re-validated from raw responses as zero committed swaps under the sealed policy. */
  readonly knownFailedTransactions: number;
  readonly flow: CandidateFlowResult;
}

/**
 * Recomputes PAPER active-window flow from raw sealed evidence only: re-decodes every verified sealed
 * TRANSACTION_DECODING response with the existing decoder, rebuilds explicit resolution records and
 * candidate-bound events, re-runs the reconciliation evaluator under the PAPER active-window policy, and
 * converts through the PAPER adapter at the recorded decision time. Saved counts and flags are not used.
 */
function recomputeActiveWindowFlowFromSealedEvidence(params: {
  evidenceDir: string;
  report: Record<string, unknown> & {
    ledger?: { records?: unknown };
    observationMetadata?: { observationStartMs?: unknown; observationEndMs?: unknown } | null;
    executionContext?: unknown;
  };
  verifiedFilesSet: ReadonlySet<string>;
  sourceCutoff: SourceCutoffEvidence;
  historyEvidence: unknown;
  activeEvidence: {
    expectedConnectionEpoch?: unknown;
    recordedGaps?: unknown;
    pendingWorkloadAtEvaluation?: unknown;
    failedTransactionPolicy?: unknown;
    resolutions?: unknown;
  };
  originalEvaluationTimestampMs: number;
  conversionTimestampMs: number;
  poolId: string;
  mintAddress: string;
  /** Validated capacity profile budget (legacy captures: 14). */
  maxTotalRequests: number;
}): { ok: true; value: CandidateDecisionReplayActiveWindow } | { ok: false; reason: string } {
  const executionContext = params.report.executionContext;
  if (executionContext !== "PAPER_SIMULATION" && executionContext !== "BACKTEST") {
    return {
      ok: false,
      reason: "Active-window replay requires a PAPER_SIMULATION or BACKTEST capture",
    };
  }
  const contextRel = "evidence/provisional-context.json";
  if (!params.verifiedFilesSet.has(contextRel)) {
    return { ok: false, reason: `Verified ${contextRel} is required for active-window replay` };
  }
  const poolContext = JSON.parse(
    readFileSync(path.join(params.evidenceDir, contextRel), "utf8"),
  ) as TrackedRaydiumPoolContext;
  if (
    poolContext.poolId !== params.poolId ||
    poolContext.candidateTokenMint !== params.mintAddress
  ) {
    return { ok: false, reason: "Provisional context identity does not match the capture" };
  }
  const obsStart = params.report.observationMetadata?.observationStartMs;
  const obsEnd = params.report.observationMetadata?.observationEndMs;
  if (asPositiveSafeInteger(obsStart) === null || asPositiveSafeInteger(obsEnd) === null) {
    return {
      ok: false,
      reason: "Recorded observation metadata is required for active-window replay",
    };
  }
  // Failed-transaction policy: absent = legacy capture (original interpretation preserved); only the exact
  // supported identifier is honoured; anything else fails closed.
  const sealedFailedTxPolicy = params.activeEvidence.failedTransactionPolicy;
  if (
    sealedFailedTxPolicy !== undefined &&
    sealedFailedTxPolicy !== PAPER_FAILED_TRANSACTION_POLICY
  ) {
    return {
      ok: false,
      reason: `Unsupported sealed failed-transaction policy '${String(sealedFailedTxPolicy)}'`,
    };
  }
  const failedTxPolicyEnabled = sealedFailedTxPolicy === PAPER_FAILED_TRANSACTION_POLICY;
  const expectedEpoch = asNonNegativeSafeInteger(params.activeEvidence.expectedConnectionEpoch);
  const pendingWorkload = asNonNegativeSafeInteger(
    params.activeEvidence.pendingWorkloadAtEvaluation,
  );
  if (
    expectedEpoch === null ||
    pendingWorkload === null ||
    !Array.isArray(params.activeEvidence.recordedGaps)
  ) {
    return {
      ok: false,
      reason: "Sealed active-window metadata (epoch, workload, recorded gaps) is incomplete",
    };
  }

  const records = Array.isArray(params.report.ledger?.records) ? params.report.ledger.records : [];
  const decodeRecords = records.filter(
    (
      r,
    ): r is {
      ok?: unknown;
      responseFile?: unknown;
      params?: unknown;
      completedAtMs?: unknown;
      rpcRequestId?: unknown;
      rpcResponseId?: unknown;
    } =>
      !!r &&
      typeof r === "object" &&
      (r as { purpose?: unknown }).purpose === "TRANSACTION_DECODING",
  );
  const resolutions: ResolvedSignatureRecord[] = [];
  const trades: TradeEvent[] = [];
  const responseFileBySignature = new Map<string, string | null>();
  let redecoded = 0;
  let knownFailedTransactions = 0;
  for (const rec of decodeRecords) {
    const sig =
      Array.isArray(rec.params) && typeof rec.params[0] === "string" ? rec.params[0] : null;
    if (sig === null) {
      return {
        ok: false,
        reason: "Sealed TRANSACTION_DECODING record lacks its requested signature",
      };
    }
    if (resolutions.some((r) => r.signature === sig)) continue; // first record for a signature stands
    const responseFile =
      typeof rec.responseFile === "string" ? rec.responseFile.replace(/\\/g, "/") : null;
    responseFileBySignature.set(sig, responseFile);
    const unavailable = (status: SignatureResolutionStatus, error: string) =>
      resolutions.push({
        signature: sig,
        slot: -1,
        blockTime: null,
        status,
        decodedEventsCount: 0,
        ingestedEventsCount: 0,
        error,
      });
    if (rec.ok !== true || responseFile === null || !params.verifiedFilesSet.has(responseFile)) {
      unavailable(
        "TRANSACTION_UNAVAILABLE",
        "Sealed transaction response unavailable or unverified",
      );
      continue;
    }
    let payload: {
      jsonrpc?: unknown;
      id?: unknown;
      error?: unknown;
      result?: { slot?: unknown; blockTime?: unknown };
    } | null;
    try {
      payload = JSON.parse(readFileSync(path.join(params.evidenceDir, responseFile), "utf8"));
    } catch {
      unavailable("FAILED_DECODE", "Sealed transaction response is not valid JSON");
      continue;
    }
    const tx = payload?.result;
    const slot = asNonNegativeSafeInteger(tx?.slot);
    const blockTime = tx?.blockTime === null ? null : asNonNegativeSafeInteger(tx?.blockTime);
    const receiptMs = asPositiveSafeInteger(rec.completedAtMs);
    if (
      !tx ||
      slot === null ||
      (tx.blockTime !== null && blockTime === null) ||
      receiptMs === null
    ) {
      unavailable("FAILED_DECODE", "Sealed transaction response lacks a valid slot/blockTime");
      continue;
    }
    const decoded = decodeRaydiumTransactionSwaps(tx, poolContext, {
      clock: () => receiptMs,
      receiptTimestampMs: receiptMs,
    });
    redecoded++;
    if (!decoded.ok && decoded.reason === "TRANSACTION_FAILED" && failedTxPolicyEnabled) {
      // Re-derive eligibility from the raw response: verified JSON-RPC envelope (version, echoed request id,
      // no error) plus full failed-transaction validation. Saved counts and labels are not trusted.
      const envelopeVerified =
        payload?.jsonrpc === "2.0" &&
        (payload.error === undefined || payload.error === null) &&
        (typeof rec.rpcRequestId === "number" || typeof rec.rpcRequestId === "string") &&
        payload.id === rec.rpcRequestId &&
        rec.rpcResponseId === payload.id;
      const validated = envelopeVerified
        ? validateFailedTransactionEvidence({ payload: tx, expectedSignature: sig, poolContext })
        : ({
            ok: false,
            reason: "JSON-RPC envelope (version, echoed request id, error) not verified",
          } as const);
      if (validated.ok) {
        resolutions.push({
          signature: sig,
          slot,
          blockTime,
          status: "RESOLVED_FAILED_TRANSACTION",
          adapterOutcome: "KNOWN_FAILED_TRANSACTION",
          decodedEventsCount: 0,
          ingestedEventsCount: 0,
          knownFailedTransaction: validated.value,
        });
        knownFailedTransactions++;
      } else {
        unavailable("FAILED_DECODE", `Failed transaction not accepted: ${validated.reason}`);
      }
      continue;
    }
    if (!decoded.ok || decoded.signature !== sig) {
      unavailable("FAILED_DECODE", decoded.ok ? "Decoded signature mismatch" : decoded.message);
      continue;
    }
    resolutions.push({
      signature: sig,
      slot,
      blockTime,
      status: "RESOLVED",
      adapterOutcome: "SUCCESS",
      decodedEventsCount: decoded.events.length,
      ingestedEventsCount: decoded.events.length,
    });
    trades.push(...decoded.events);
  }

  if (failedTxPolicyEnabled) {
    // Every substantive sealed resolution field (status, classification, response link, adapter outcome,
    // identity, event counts, policy and error evidence) must agree with its raw-response re-derivation for each
    // signature either side claims as resolved. Contradictions are rejected, never ignored.
    const sealedResolutions = params.activeEvidence.resolutions;
    if (!Array.isArray(sealedResolutions)) {
      return {
        ok: false,
        reason:
          "Sealed resolution classifications are required under the failed-transaction policy",
      };
    }
    const resolvedClasses = new Set<string>(["RESOLVED", "RESOLVED_FAILED_TRANSACTION"]);
    const sealedBySig = new Map<string, Record<string, unknown>>();
    for (const entry of sealedResolutions as unknown[]) {
      const e = entry as Record<string, unknown> | null;
      if (
        !e ||
        typeof e !== "object" ||
        Array.isArray(e) ||
        typeof e.signature !== "string" ||
        sealedBySig.has(e.signature)
      ) {
        return { ok: false, reason: "Sealed resolution records are malformed or duplicated" };
      }
      // Each sealed classification must match its own status, and failure evidence appears only on a known
      // failed transaction (checked for every record, resolved or not).
      if (e.classification !== activeWindowResolutionClassification(e.status)) {
        return {
          ok: false,
          reason: `Sealed classification for '${e.signature}' (${String(e.classification)}) contradicts its status (${String(e.status)})`,
        };
      }
      if (
        (e.status === "RESOLVED_FAILED_TRANSACTION") !==
        (e.knownFailedTransaction !== undefined && e.knownFailedTransaction !== null)
      ) {
        return {
          ok: false,
          reason: `Sealed failure evidence for '${e.signature}' is inconsistent with its status (${String(e.status)})`,
        };
      }
      sealedBySig.set(e.signature, e);
    }
    for (const r of resolutions) {
      const sealed = sealedBySig.get(r.signature);
      const sealedStatus = sealed?.status;
      if (!resolvedClasses.has(r.status) && !resolvedClasses.has(String(sealedStatus))) continue;
      if (!sealed || sealedStatus !== r.status) {
        return {
          ok: false,
          reason: `Sealed resolution classification for '${r.signature}' (${String(sealedStatus)}) contradicts re-derivation from the raw response (${r.status})`,
        };
      }
      const sealedFile =
        typeof sealed.responseFile === "string" ? sealed.responseFile.replace(/\\/g, "/") : null;
      if (sealedFile !== (responseFileBySignature.get(r.signature) ?? null)) {
        return {
          ok: false,
          reason: `Sealed resolution for '${r.signature}' is not linked to its sealed transaction response`,
        };
      }
      const fieldChecks: ReadonlyArray<readonly [string, unknown, unknown]> = [
        ["adapterOutcome", sealed.adapterOutcome, r.adapterOutcome],
        ["slot", sealed.slot, r.slot],
        ["blockTime", sealed.blockTime, r.blockTime],
        ["decodedEventsCount", sealed.decodedEventsCount, r.decodedEventsCount],
        ["ingestedEventsCount", sealed.ingestedEventsCount, r.ingestedEventsCount],
      ];
      for (const [field, sealedValue, derivedValue] of fieldChecks) {
        if (sealedValue !== derivedValue) {
          return {
            ok: false,
            reason: `Sealed ${field} for '${r.signature}' (${String(sealedValue)}) contradicts re-derivation from the raw response (${String(derivedValue)})`,
          };
        }
      }
      if (
        r.status === "RESOLVED_FAILED_TRANSACTION" &&
        canonicalJson(sealed.knownFailedTransaction) !== canonicalJson(r.knownFailedTransaction)
      ) {
        return {
          ok: false,
          reason: `Sealed failure evidence for '${r.signature}' (policy, identity, or on-chain error) does not match the raw transaction response`,
        };
      }
    }
    for (const [sig, sealed] of sealedBySig) {
      if (
        resolvedClasses.has(String(sealed.status)) &&
        !resolutions.some((r) => r.signature === sig)
      ) {
        return {
          ok: false,
          reason: `Sealed resolved record '${sig}' has no sealed transaction retrieval`,
        };
      }
    }
  }

  const recon = evaluateExactPoolWindowReconciliation({
    poolContext,
    sourceCutoff: params.sourceCutoff,
    historyResult: params.historyEvidence as HistoryEnumerationResult,
    expectedConnectionEpoch: expectedEpoch,
    observationStartMs: obsStart as number,
    observationEndMs: obsEnd as number,
    decisionTimestampMs: params.originalEvaluationTimestampMs,
    maxAllowedEvidenceAgeMs: 15_000,
    recordedGaps: params.activeEvidence.recordedGaps as StreamGap[],
    hasActiveBacklog: pendingWorkload > 0,
    resolvedSignatures: resolutions,
    trades,
    budgetManager: new GlobalResourceBudgetManager({
      maxTotalRequests: params.maxTotalRequests,
      maxEnrichmentAttempts: params.maxTotalRequests,
      minReservedForwardRequests: 0,
      minProviderSpacingMs: 2500,
      clock: () => params.originalEvaluationTimestampMs,
    }),
    paperActiveWindowPolicy: { enabled: true, executionContext },
  });
  const flow = new PaperReconciledCandidateFlowAdapter().convertCandidateFlow(
    recon,
    { poolAddress: params.poolId, tokenMint: params.mintAddress },
    params.conversionTimestampMs,
    { executionContext, maxAllowedEvidenceAgeMs: 15_000, allowActiveWindowQualification: true },
  );
  return {
    ok: true,
    value: {
      reconciliationStatus: recon.status,
      diagnosticReason: recon.diagnosticReason,
      recentBuys60s: flow.recentBuys60s,
      recentSells60s: flow.recentSells60s,
      windowSignaturesCount: recon.underlyingOutcomes.windowSignaturesCount,
      redecodedTransactions: redecoded,
      failedTransactionPolicy: failedTxPolicyEnabled ? PAPER_FAILED_TRANSACTION_POLICY : null,
      knownFailedTransactions,
      flow,
    },
  };
}

/** Normalized qualification/count summary of one sealed flow record (timestamps excluded). */
export interface SealedFlowRecordSummary {
  readonly qualificationKind: "QUIET_WINDOW" | "ACTIVE_WINDOW" | "UNQUALIFIED" | "INVALID";
  readonly flowCoverage: string | null;
  readonly isCoverageSufficient: boolean;
  readonly recentBuys60s: number | null;
  readonly recentSells60s: number | null;
}

function summarizeSealedFlowRecord(rec: unknown): SealedFlowRecordSummary {
  const r = (rec && typeof rec === "object" ? rec : {}) as {
    isPaperQualified?: unknown;
    paperQualificationContext?: { qualificationKind?: unknown } | null;
    flowCoverage?: unknown;
    isCoverageSufficient?: unknown;
    recentBuys60s?: unknown;
    recentSells60s?: unknown;
  };
  const kindLabel = r.paperQualificationContext?.qualificationKind;
  let qualificationKind: SealedFlowRecordSummary["qualificationKind"];
  if (r.isPaperQualified === true) {
    qualificationKind =
      kindLabel === undefined || kindLabel === "QUIET_WINDOW" // legacy quiet contexts carry no kind
        ? "QUIET_WINDOW"
        : kindLabel === "ACTIVE_WINDOW"
          ? "ACTIVE_WINDOW"
          : "INVALID";
  } else {
    qualificationKind =
      r.paperQualificationContext === undefined || r.paperQualificationContext === null
        ? "UNQUALIFIED"
        : "INVALID";
  }
  const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
  return {
    qualificationKind,
    flowCoverage: typeof r.flowCoverage === "string" ? r.flowCoverage : null,
    isCoverageSufficient: r.isCoverageSufficient === true,
    recentBuys60s: count(r.recentBuys60s),
    recentSells60s: count(r.recentSells60s),
  };
}

/** Raw window activity derived only from sealed history, cutoff, observation, and transaction records. */
export interface RawWindowActivity {
  readonly inWindowSignatures: number | null;
  readonly discoveredSinceAnchor: number | null;
  readonly notificationsReceived: number | null;
  readonly transactionDecodeRecords: number;
}

function deriveRawWindowActivity(
  report: {
    ledger?: { records?: unknown };
    observationMetadata?: { notificationsReceived?: unknown } | null;
  },
  historyEvidence: unknown,
  sourceCutoff: unknown,
): RawWindowActivity {
  const discovered = (historyEvidence as { discoveredSignatures?: unknown } | null)
    ?.discoveredSignatures;
  const cutoffMs = (sourceCutoff as { cutoffTimestampMs?: unknown } | null)?.cutoffTimestampMs;
  let inWindowSignatures: number | null = null;
  if (Array.isArray(discovered) && typeof cutoffMs === "number" && Number.isFinite(cutoffMs)) {
    inWindowSignatures = 0;
    for (const rec of discovered) {
      const blockTime = (rec as { blockTime?: unknown } | null)?.blockTime;
      if (typeof blockTime !== "number" || !Number.isFinite(blockTime)) {
        inWindowSignatures = null; // ambiguous timestamp: unknown, never zero
        break;
      }
      const ms = blockTime * 1000;
      if (ms >= cutoffMs - 60_000 && ms <= cutoffMs) inWindowSignatures++;
    }
  }
  const records = Array.isArray(report.ledger?.records) ? report.ledger.records : [];
  return {
    inWindowSignatures,
    discoveredSinceAnchor: Array.isArray(discovered) ? discovered.length : null,
    notificationsReceived: asNonNegativeSafeInteger(
      report.observationMetadata?.notificationsReceived,
    ),
    transactionDecodeRecords: records.filter(
      (r) =>
        !!r &&
        typeof r === "object" &&
        (r as { purpose?: unknown }).purpose === "TRANSACTION_DECODING",
    ).length,
  };
}

export interface CandidateDecisionReplayResult {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  readonly poolId: string;
  readonly mintAddress: string;
  readonly verifiedFilesCount: number;
  readonly fileVerifications: ReplayVerificationItem[];
  /** True only once manifest coverage, file hashes/sizes, and required evidence have all verified. */
  readonly integrityVerified?: boolean | undefined;
  readonly replayMode?: CandidateDecisionReplayMode | undefined;
  /** Terminal status/message exactly as recorded in the sealed report (RECORDED_TERMINATION_PRESERVED only). */
  readonly recordedTermination?:
    | { readonly status: string; readonly message: string | null }
    | undefined;
  /** Decision outcome recorded in the sealed report (DECISION_REEVALUATED only). */
  readonly recordedDecision?:
    | {
        readonly outcome: string;
        readonly rejectionReason: string | null;
        readonly decisionTimestampMs: number;
      }
    | undefined;
  /** Whether the offline re-evaluation reproduced the recorded outcome and rejection reason. */
  readonly matchesRecordedDecision?: boolean | undefined;
  /** Pre-admission screening recomputed from raw LP and mint evidence (strategy qualification, not integrity). */
  readonly recomputedPreAdmission?: CandidateDecisionReplayPreAdmission | undefined;
  /** RugCheck metrics recomputed from the verified sealed response with the shared strict validator. */
  readonly recomputedRugCheck?: CandidateDecisionReplayRugCheck | undefined;
  /** Active-window flow recomputed by re-decoding sealed getTransaction responses (ACTIVE_WINDOW captures only). */
  readonly recomputedActiveWindowFlow?: CandidateDecisionReplayActiveWindow | undefined;
  /** Claimed flow qualification vs raw sealed window activity (completed-decision replays). */
  readonly flowQualificationCheck?:
    | { readonly claimed: SealedFlowRecordSummary | null; readonly rawActivity: RawWindowActivity }
    | undefined;
  readonly decisionResult?: CandidateDecisionResult | undefined;
  readonly auditMetadata?:
    | {
        readonly requests?: readonly unknown[] | undefined;
        readonly observation?: CandidateDecisionReplayObservationAudit | undefined;
        readonly gapMetadata?: CandidateDecisionReplayGapAudit | undefined;
        /** Inputs the replay had to supply that were not sealed; never consumed as observed evidence. */
        readonly syntheticReplayContext?:
          | Readonly<Record<string, { readonly value: string; readonly reason: string }>>
          | undefined;
      }
    | undefined;
}

const REPLAY_MAX_CUTOFF_AGE_MS = 15_000;

/**
 * Validates the sealed capacity profile and (bounded profile) observation-schedule evidence. Captures without a
 * profile keep their historical interpretation (legacy 14/3). Only exact supported profiles are accepted; ledger
 * totals and retrieval counts must respect the selected ceilings; drain and cutoff timing is re-derived from the
 * ledger and must match the sealed schedule.
 */
function validateSealedCapacityEvidence(
  report: Record<string, unknown>,
  activeEvidence: Record<string, unknown> | null,
): { ok: true; profile: DiagnosticCapacityProfile | null } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const sealedProfile = report.capacityProfile;
  if (sealedProfile === undefined) {
    if (report.observationSchedule !== undefined) {
      return fail("observation schedule sealed without a capacity profile");
    }
    if (activeEvidence && activeEvidence.capacityProfile !== undefined) {
      return fail("active-window evidence names a capacity profile the report does not seal");
    }
    return { ok: true, profile: null };
  }
  const profile = SUPPORTED_CAPACITY_PROFILES.find(
    (p) => canonicalJson(p) === canonicalJson(sealedProfile),
  );
  if (!profile) return fail("sealed capacity profile is unsupported or internally inconsistent");
  const bounded = profile.cutoffDispatchWindowMs !== null;
  if (
    bounded &&
    report.executionContext !== "PAPER_SIMULATION" &&
    report.executionContext !== "BACKTEST"
  ) {
    return fail(`${profile.id} requires a PAPER_SIMULATION or BACKTEST capture`);
  }
  if (activeEvidence) {
    if (activeEvidence.capacityProfile !== profile.id) {
      return fail(
        `active-window evidence profile (${String(activeEvidence.capacityProfile)}) contradicts the report (${profile.id})`,
      );
    }
    if (!bounded)
      return fail("active-window evidence requires the PAPER_ACTIVE_WINDOW_20_9 profile");
  }

  // Ledger totals and retrieval counts against the selected ceilings.
  const ledger = report.ledger as
    | { records?: unknown; totalAttempts?: unknown; transactionDecodeAttempts?: unknown }
    | undefined;
  const records = Array.isArray(ledger?.records) ? (ledger.records as unknown[]) : null;
  if (!records) return fail("sealed ledger has no records array");
  const purposeOf = (r: unknown) =>
    r && typeof r === "object" ? (r as { purpose?: unknown }).purpose : undefined;
  const txCount = records.filter((r) => purposeOf(r) === "TRANSACTION_DECODING").length;
  if (
    ledger?.totalAttempts !== records.length ||
    records.length > profile.maxTotalRequests ||
    ledger?.transactionDecodeAttempts !== txCount ||
    txCount > profile.maxTransactionRetrievals
  ) {
    return fail(
      `ledger totals (${String(ledger?.totalAttempts)} attempts, ${records.length} records, ${txCount} retrievals) contradict or exceed ${profile.id} (${profile.maxTotalRequests}/${profile.maxTransactionRetrievals})`,
    );
  }

  const schedule = report.observationSchedule as Record<string, unknown> | undefined;
  if (!bounded) {
    return schedule === undefined
      ? { ok: true, profile }
      : fail("observation schedule sealed under an unbounded profile");
  }
  const hasObservationWork = records.some(
    (r) => purposeOf(r) === "TRANSACTION_DECODING" || purposeOf(r) === "GET_SLOT",
  );
  if (schedule === undefined) {
    return hasObservationWork
      ? fail("bounded capture with retrievals or a cutoff lacks its observation schedule")
      : { ok: true, profile };
  }
  const obsStart = (report.observationMetadata as { observationStartMs?: unknown } | undefined)
    ?.observationStartMs;
  const nominalEnd = schedule.nominalObservationEndMs;
  if (
    asPositiveSafeInteger(obsStart) === null ||
    nominalEnd !== (obsStart as number) + (profile.nominalObservationMs as number) ||
    schedule.getSlotDispatchDeadlineMs !==
      (nominalEnd as number) + (profile.cutoffDispatchWindowMs as number)
  ) {
    return fail(
      "observation schedule does not match the observation start and the profile windows",
    );
  }
  const derived = deriveBoundedScheduleCounts(records, nominalEnd as number);
  for (const key of Object.keys(derived) as Array<keyof typeof derived>) {
    if (schedule[key] !== derived[key]) {
      return fail(
        `sealed ${key} (${String(schedule[key])}) contradicts the ledger (${String(derived[key])})`,
      );
    }
  }
  if (derived.drainRetrievals > profile.maxDrainRetrievals) {
    return fail(`${derived.drainRetrievals} drain retrievals exceed ${profile.maxDrainRetrievals}`);
  }
  if (derived.retrievalsAfterGetSlot !== 0) {
    return fail("a transaction retrieval was dispatched at or after GET_SLOT");
  }
  if (
    derived.getSlotDispatchedAtMs !== null &&
    derived.getSlotDispatchedAtMs > (schedule.getSlotDispatchDeadlineMs as number)
  ) {
    return fail("GET_SLOT dispatched after its deadline");
  }
  const stopReason = schedule.stopReason;
  if (stopReason !== null && (typeof stopReason !== "string" || report.status !== stopReason)) {
    return fail("sealed schedule stop reason contradicts the recorded status");
  }
  if (stopReason !== null && derived.getSlotDispatchedAtMs !== null) {
    return fail("a bounded stop is recorded although GET_SLOT was dispatched");
  }
  return { ok: true, profile };
}

function asNonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function asPositiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Counts rows returned by HISTORY_ENUMERATION requests using only the verified sealed report
 * ledger and verified response files. Returns null with a basis label when not derivable.
 */
function countHistoryEnumerationRows(
  evidenceDir: string,
  report: { ledger?: { records?: unknown } } | null | undefined,
  verifiedFilesSet: ReadonlySet<string>,
): { rows: number | null; basis: string } {
  const records = report?.ledger?.records;
  if (!Array.isArray(records)) {
    return { rows: null, basis: "UNAVAILABLE: sealed report ledger has no records array" };
  }
  const enumerationRecords = records.filter(
    (r): r is { ok?: unknown; responseFile?: unknown } =>
      !!r &&
      typeof r === "object" &&
      (r as { purpose?: unknown }).purpose === "HISTORY_ENUMERATION",
  );
  if (enumerationRecords.length === 0) {
    return { rows: null, basis: "UNAVAILABLE: no HISTORY_ENUMERATION request recorded" };
  }
  let total = 0;
  const files: string[] = [];
  for (const rec of enumerationRecords) {
    if (rec.ok !== true || typeof rec.responseFile !== "string") {
      return { rows: null, basis: "UNAVAILABLE: HISTORY_ENUMERATION request did not succeed" };
    }
    const relPath = rec.responseFile.replace(/\\/g, "/");
    if (!verifiedFilesSet.has(relPath)) {
      return { rows: null, basis: `UNAVAILABLE: response file not verified: ${relPath}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path.join(evidenceDir, relPath), "utf8"));
    } catch {
      return { rows: null, basis: `UNAVAILABLE: response file is not valid JSON: ${relPath}` };
    }
    const result = (parsed as { result?: unknown } | null)?.result;
    if (!Array.isArray(result)) {
      return { rows: null, basis: `UNAVAILABLE: response has no result array: ${relPath}` };
    }
    total += result.length;
    files.push(relPath);
  }
  return { rows: total, basis: `VERIFIED_RESPONSE_FILES: ${files.join(", ")}` };
}

/**
 * Replays and reconstructs a CandidateDecision solely from sealed evidence files offline.
 * Verifies all file integrity hashes against evidence-manifest.json before evaluation.
 */
export function replayCandidateDecisionFromSealedEvidence(
  evidenceDir: string,
): CandidateDecisionReplayResult {
  const manifestPath = path.join(evidenceDir, "evidence-manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      status: "MANIFEST_NOT_FOUND",
      message: `Manifest file not found: ${manifestPath}`,
      poolId: "",
      mintAddress: "",
      verifiedFilesCount: 0,
      fileVerifications: [],
    };
  }

  const manifestContent = readFileSync(manifestPath, "utf8");
  let manifest: {
    poolId?: string;
    mintAddress?: string;
    reportFile?: { path: string; bytes: number; sha256: string };
    files?: Array<{ path: string; bytes: number; sha256: string }>;
    requests?: unknown[];
  } | null = null;
  try {
    manifest = JSON.parse(manifestContent);
  } catch (parseErr) {
    return {
      ok: false,
      status: "INVALID_MANIFEST_SCHEMA",
      message: `Manifest JSON parsing failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      poolId: "",
      mintAddress: "",
      verifiedFilesCount: 0,
      fileVerifications: [],
    };
  }

  const poolId = typeof manifest?.poolId === "string" ? manifest.poolId : "";
  const mintAddress = typeof manifest?.mintAddress === "string" ? manifest.mintAddress : "";

  // Validate manifest schema: files array must be non-empty and well-formed
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    return {
      ok: false,
      status: "INVALID_MANIFEST_SCHEMA",
      message: "Manifest schema invalid: files array must be non-empty",
      poolId,
      mintAddress,
      verifiedFilesCount: 0,
      fileVerifications: [],
    };
  }

  // Check duplicate paths and validate entry structures
  const seenPaths = new Set<string>();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      typeof entry.bytes !== "number" ||
      typeof entry.sha256 !== "string"
    ) {
      return {
        ok: false,
        status: "INVALID_MANIFEST_SCHEMA",
        message: `Manifest entry is malformed: ${JSON.stringify(entry)}`,
        poolId,
        mintAddress,
        verifiedFilesCount: 0,
        fileVerifications: [],
      };
    }
    const normPath = entry.path.replace(/\\/g, "/");
    if (seenPaths.has(normPath)) {
      return {
        ok: false,
        status: "DUPLICATE_MANIFEST_ENTRY",
        message: `Duplicate file path in manifest: ${normPath}`,
        poolId,
        mintAddress,
        verifiedFilesCount: 0,
        fileVerifications: [],
      };
    }
    seenPaths.add(normPath);
  }

  // Ensure all required evidence files are present in manifest.files
  const requiredFiles = [
    "diagnostic-report.json",
    "evidence/lp-evidence.json",
    "evidence/cutoff-evidence.json",
    "evidence/history-evidence.json",
    "evidence/market-data.json",
    "evidence/mint-account.json",
  ];
  for (const reqFile of requiredFiles) {
    if (!seenPaths.has(reqFile)) {
      return {
        ok: false,
        status: "INCOMPLETE_MANIFEST_COVERAGE",
        message: `Required evidence file missing from manifest: ${reqFile}`,
        poolId,
        mintAddress,
        verifiedFilesCount: 0,
        fileVerifications: [],
      };
    }
  }

  // Ensure all files present on disk are covered by manifest.files (fail-closed if unlisted file exists)
  const scanDirForUnlistedFiles = (dir: string, baseRel: string): string | null => {
    if (!existsSync(dir)) return null;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === ".DS_Store" ||
        entry.name === "Thumbs.db" ||
        entry.name === "desktop.ini"
      ) {
        continue;
      }
      const relPath = baseRel
        ? `${baseRel}/${entry.name}`.replace(/\\/g, "/")
        : entry.name.replace(/\\/g, "/");

      if (entry.isDirectory()) {
        const unlisted = scanDirForUnlistedFiles(path.join(dir, entry.name), relPath);
        if (unlisted) return unlisted;
      } else if (entry.isFile()) {
        if (relPath === "evidence-manifest.json") {
          continue; // Manifest itself indexes the directory
        }
        if (!seenPaths.has(relPath)) {
          return relPath;
        }
      }
    }
    return null;
  };

  const unlistedFile = scanDirForUnlistedFiles(evidenceDir, "");
  if (unlistedFile) {
    return {
      ok: false,
      status: "INCOMPLETE_MANIFEST_COVERAGE",
      message: `Evidence file present on disk but missing from manifest: ${unlistedFile}`,
      poolId,
      mintAddress,
      verifiedFilesCount: 0,
      fileVerifications: [],
    };
  }

  const fileVerifications: ReplayVerificationItem[] = [];

  // Verify all files listed in manifest
  for (const entry of manifest.files) {
    const fullPath = path.join(evidenceDir, entry.path);
    if (!existsSync(fullPath)) {
      return {
        ok: false,
        status: "SEALED_FILE_MISSING",
        message: `Sealed evidence file missing: ${entry.path}`,
        poolId,
        mintAddress,
        verifiedFilesCount: fileVerifications.length,
        fileVerifications,
      };
    }
    const fileBytes = readFileSync(fullPath);
    const actualSha256 = createHash("sha256").update(fileBytes).digest("hex");
    const valid = actualSha256 === entry.sha256 && fileBytes.length === entry.bytes;
    fileVerifications.push({
      path: entry.path,
      expectedBytes: entry.bytes,
      actualBytes: fileBytes.length,
      expectedSha256: entry.sha256,
      actualSha256,
      valid,
    });
    if (!valid) {
      return {
        ok: false,
        status: "EVIDENCE_INTEGRITY_MISMATCH",
        message: `SHA-256 or byte length mismatch for sealed file ${entry.path}`,
        poolId,
        mintAddress,
        verifiedFilesCount: fileVerifications.length,
        fileVerifications,
      };
    }
  }

  // If manifest specifies reportFile separately, verify it as well
  if (manifest.reportFile) {
    const reportPath = path.join(evidenceDir, manifest.reportFile.path);
    if (!existsSync(reportPath)) {
      return {
        ok: false,
        status: "SEALED_FILE_MISSING",
        message: `Report file missing: ${manifest.reportFile.path}`,
        poolId,
        mintAddress,
        verifiedFilesCount: fileVerifications.length,
        fileVerifications,
      };
    }
    const reportBytes = readFileSync(reportPath);
    const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
    if (
      reportSha256 !== manifest.reportFile.sha256 ||
      reportBytes.length !== manifest.reportFile.bytes
    ) {
      return {
        ok: false,
        status: "EVIDENCE_INTEGRITY_MISMATCH",
        message: `SHA-256 or byte length mismatch for report file: ${manifest.reportFile.path}`,
        poolId,
        mintAddress,
        verifiedFilesCount: fileVerifications.length,
        fileVerifications,
      };
    }
  }

  const verifiedFilesSet = new Set(
    fileVerifications.filter((v) => v.valid).map((v) => v.path.replace(/\\/g, "/")),
  );

  for (const reqFile of requiredFiles) {
    if (!verifiedFilesSet.has(reqFile)) {
      return {
        ok: false,
        status: "EVIDENCE_INTEGRITY_MISMATCH",
        message: `Required evidence file failed verification: ${reqFile}`,
        poolId,
        mintAddress,
        verifiedFilesCount: fileVerifications.length,
        fileVerifications,
      };
    }
  }

  // Load sealed evidence files
  const reportPath = path.join(evidenceDir, "diagnostic-report.json");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));

  const capacityActiveRel = "evidence/active-window-evidence.json";
  const capacityCheck = validateSealedCapacityEvidence(
    report as Record<string, unknown>,
    verifiedFilesSet.has(capacityActiveRel)
      ? (JSON.parse(readFileSync(path.join(evidenceDir, capacityActiveRel), "utf8")) as Record<
          string,
          unknown
        >)
      : null,
  );
  if (!capacityCheck.ok) {
    return {
      ok: false,
      status: "REPLAY_CAPACITY_EVIDENCE_INVALID",
      message: `Capacity profile evidence rejected: ${capacityCheck.reason}`,
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
    };
  }
  const replayMaxTotalRequests =
    capacityCheck.profile?.maxTotalRequests ?? DEFAULT_CAPACITY_PROFILE.maxTotalRequests;

  const lpEvidencePath = path.join(evidenceDir, "evidence", "lp-evidence.json");
  const cutoffEvidencePath = path.join(evidenceDir, "evidence", "cutoff-evidence.json");
  const historyEvidencePath = path.join(evidenceDir, "evidence", "history-evidence.json");
  const marketDataPath = path.join(evidenceDir, "evidence", "market-data.json");
  const mintAccountPath = path.join(evidenceDir, "evidence", "mint-account.json");
  const bundlerPath = path.join(evidenceDir, "evidence", "bundler-provenance.json");
  const rugCheckPath = path.join(evidenceDir, "evidence", "rugcheck-report.json");

  const lpEvidence = JSON.parse(readFileSync(lpEvidencePath, "utf8"));
  const sourceCutoff = JSON.parse(readFileSync(cutoffEvidencePath, "utf8"));
  const historyEvidence = JSON.parse(readFileSync(historyEvidencePath, "utf8"));
  const marketDataEvidence = JSON.parse(readFileSync(marketDataPath, "utf8"));
  const mintAccountEvidence = JSON.parse(readFileSync(mintAccountPath, "utf8"));

  // Verify identities match between provisional context and LP evidence
  const validatedIdentities = lpEvidence.discoveredIdentities;
  if (!validatedIdentities || validatedIdentities.poolId !== poolId) {
    return {
      ok: false,
      status: "REPLAY_IDENTITY_MISMATCH",
      message: "LP evidence identity does not match candidate poolId",
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
    };
  }

  // Recompute pre-admission screening from raw evidence (NOT saved derived flags)
  const poolState = lpEvidence.validationResult?.diagnostics?.poolState;
  const lpMintState = lpEvidence.validationResult?.diagnostics?.lpMintState;
  if (
    !poolState ||
    !lpMintState ||
    poolState.lpReserve === undefined ||
    lpMintState.supply === undefined
  ) {
    return {
      ok: false,
      status: "REPLAY_LP_EVIDENCE_INVALID",
      message: "Missing raw poolState or lpMintState in LP evidence for replay recalculation",
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
    };
  }

  const recomputedLpAccounting = calculateAmmV4LpInaccessibleClaims(
    BigInt(poolState.lpReserve),
    BigInt(lpMintState.supply),
  );

  if (!recomputedLpAccounting.ok) {
    return {
      ok: false,
      status: "REPLAY_LP_EVIDENCE_INVALID",
      message: `LP claim calculation rejected [${recomputedLpAccounting.category}]: ${recomputedLpAccounting.message}`,
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
    };
  }

  const lpBurnPct = recomputedLpAccounting.displayInaccessiblePct;
  const lpSecurityPassed =
    recomputedLpAccounting.meetsNinetyPercentThreshold &&
    typeof lpBurnPct === "number" &&
    lpBurnPct >= 90.0;

  // Recompute mint and freeze authorities using parseSolanaRpcMintAccountResponse and evaluateAuthorityEvidence
  const rawMintResponse = mintAccountEvidence.rawMintResponse;
  if (!rawMintResponse) {
    return {
      ok: false,
      status: "REPLAY_MINT_EVIDENCE_INVALID",
      message: "Missing rawMintResponse in mint account evidence for replay validation",
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
    };
  }

  const parsedMintRes = parseSolanaRpcMintAccountResponse(
    rawMintResponse,
    mintAddress as TokenMintAddress,
    new Date(0),
    "JSON_PARSED",
  );

  if (!parsedMintRes.ok) {
    return {
      ok: false,
      status: "REPLAY_MINT_EVIDENCE_INVALID",
      message: `Candidate mint account parsing failed: ${parsedMintRes.message}`,
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
    };
  }

  const rawMintVal = (
    rawMintResponse.result as {
      value?: { data?: { parsed?: { info?: Record<string, unknown> } } };
    }
  )?.value;
  const rawInfo = rawMintVal?.data?.parsed?.info;

  const mintEval = evaluateAuthorityEvidence(rawInfo, "mintAuthority");
  const freezeEval = evaluateAuthorityEvidence(rawInfo, "freezeAuthority");

  const mintAuthorityPassed = mintEval.status === "DISABLED";
  const freezeAuthorityPassed = freezeEval.status === "DISABLED";

  // Strategy qualification is recomputed here but applied only after the recorded outcome is known:
  // valid below-threshold evidence is a legitimate recorded rejection, not corrupted evidence.
  let preAdmissionRejectionReason: string | null = null;
  if (!lpSecurityPassed || !mintAuthorityPassed || !freezeAuthorityPassed) {
    preAdmissionRejectionReason = "REJECTED_UNKNOWN";
    if (!lpSecurityPassed) {
      preAdmissionRejectionReason = "REJECTED_UNLOCKED_LP_RISK";
    } else if (!freezeAuthorityPassed) {
      if (freezeEval.status === "OMITTED") {
        preAdmissionRejectionReason = "REJECTED_UNKNOWN_FREEZE_AUTHORITY";
      } else if (freezeEval.status === "MALFORMED") {
        preAdmissionRejectionReason = "REJECTED_MALFORMED_FREEZE_AUTHORITY";
      } else {
        preAdmissionRejectionReason = "REJECTED_ACTIVE_FREEZE_AUTHORITY";
      }
    } else if (!mintAuthorityPassed) {
      if (mintEval.status === "OMITTED") {
        preAdmissionRejectionReason = "REJECTED_UNKNOWN_MINT_AUTHORITY";
      } else if (mintEval.status === "MALFORMED") {
        preAdmissionRejectionReason = "REJECTED_MALFORMED_MINT_AUTHORITY";
      } else {
        preAdmissionRejectionReason = "REJECTED_ACTIVE_MINT_AUTHORITY";
      }
    }
  }
  const recomputedPreAdmission: CandidateDecisionReplayPreAdmission = {
    lpBurnPct: typeof lpBurnPct === "number" ? lpBurnPct : null,
    lpSecurityPassed,
    mintAuthorityStatus: mintEval.status,
    freezeAuthorityStatus: freezeEval.status,
    passed: preAdmissionRejectionReason === null,
    rejectionReason: preAdmissionRejectionReason,
  };

  const flowRelPath = "evidence/flow-evaluation.json";
  const flowPath = path.join(evidenceDir, flowRelPath);
  const flowEvaluation = verifiedFilesSet.has(flowRelPath)
    ? JSON.parse(readFileSync(flowPath, "utf8"))
    : report.flowEvaluation;

  // Audit metadata is derived only from verified sealed evidence. Anything not recorded stays null.
  const observationMetadata = report.observationMetadata as
    | Record<string, unknown>
    | null
    | undefined;
  const hasObservationMetadata = !!observationMetadata && typeof observationMetadata === "object";
  const keepaliveMetrics = report.keepaliveMetrics as
    | CandidateDecisionDiagnosticResult["keepaliveMetrics"]
    | null
    | undefined;
  const hasKeepaliveMetrics = !!keepaliveMetrics && typeof keepaliveMetrics === "object";
  const historyRows = countHistoryEnumerationRows(evidenceDir, report, verifiedFilesSet);
  const historyDiscovered = historyEvidence?.discoveredSignatures;

  const auditMetadata: NonNullable<CandidateDecisionReplayResult["auditMetadata"]> = {
    requests: manifest.requests ?? [],
    observation: {
      observationMetadataStatus: hasObservationMetadata
        ? "RECORDED"
        : "NOT_RECORDED_IN_SEALED_REPORT",
      observationStartMs: asPositiveSafeInteger(observationMetadata?.observationStartMs),
      observationEndMs: asPositiveSafeInteger(observationMetadata?.observationEndMs),
      observationDurationMs: asNonNegativeSafeInteger(observationMetadata?.observationDurationMs),
      notificationsReceived: asNonNegativeSafeInteger(observationMetadata?.notificationsReceived),
      cutoffTimestampMs: asPositiveSafeInteger(sourceCutoff?.cutoffTimestampMs),
      historyConnectionEpoch: asNonNegativeSafeInteger(historyEvidence?.connectionEpoch),
      flowConnectionEpoch: asNonNegativeSafeInteger(flowEvaluation?.connectionEpoch),
      keepaliveMetricsStatus: hasKeepaliveMetrics ? "RECORDED" : "NOT_RECORDED_IN_SEALED_REPORT",
      keepaliveStats: hasKeepaliveMetrics ? keepaliveMetrics : null,
    },
    gapMetadata: {
      flowCoverage:
        typeof flowEvaluation?.flowCoverage === "string" ? flowEvaluation.flowCoverage : null,
      isCoverageSufficient:
        typeof flowEvaluation?.isCoverageSufficient === "boolean"
          ? flowEvaluation.isCoverageSufficient
          : null,
      diagnosticReason:
        typeof flowEvaluation?.diagnosticReason === "string"
          ? flowEvaluation.diagnosticReason
          : null,
      historyOutcome: typeof historyEvidence?.outcome === "string" ? historyEvidence.outcome : null,
      historyEnumerationRowsReturned: historyRows.rows,
      historyEnumerationRowsBasis: historyRows.basis,
      newSignaturesSinceAnchor:
        historyEvidence?.outcome === "ANCHOR_WITNESSED" && Array.isArray(historyDiscovered)
          ? historyDiscovered.length
          : null,
    },
  };

  // =========================================================================
  // Historical outcome: integrity verification above is separate from decision replay.
  // =========================================================================
  if (typeof report.ok !== "boolean" || typeof report.status !== "string" || !report.status) {
    return {
      ok: false,
      status: "REPLAY_RECORDED_OUTCOME_UNKNOWN",
      message:
        "Sealed report does not record a boolean ok and non-empty status; no decision replayed",
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
      auditMetadata,
    };
  }

  if (report.ok === false) {
    // A capture that terminated before a recorded decision keeps its termination outcome.
    // No Buy Gate decision is evaluated, and earlier snapshot timestamps are not reused.
    // The recorded pre-admission result (when present) must agree with the raw recomputation.
    const recordedScreening = report.preAdmissionScreening as
      | { passed?: unknown; rejectionReason?: unknown }
      | null
      | undefined;
    const recordedPassed =
      typeof recordedScreening?.passed === "boolean" ? recordedScreening.passed : null;
    const recordedReason =
      typeof recordedScreening?.rejectionReason === "string"
        ? recordedScreening.rejectionReason
        : null;
    const requiresRecordedScreening = report.status === "PRE_ADMISSION_REJECTED";
    const screeningContradicted =
      (requiresRecordedScreening && (recordedPassed !== false || recordedReason === null)) ||
      (recordedPassed !== null &&
        (recordedPassed !== recomputedPreAdmission.passed ||
          (!recordedPassed && recordedReason !== recomputedPreAdmission.rejectionReason)));
    if (screeningContradicted) {
      return {
        ok: false,
        status: "REPLAY_PRE_ADMISSION_MISMATCH",
        message: `Recorded pre-admission result (passed=${String(recordedPassed)}, reason=${String(recordedReason)}) contradicts raw recomputation (passed=${String(recomputedPreAdmission.passed)}, reason=${String(recomputedPreAdmission.rejectionReason)}); recorded termination not accepted`,
        poolId,
        mintAddress,
        verifiedFilesCount: fileVerifications.length,
        fileVerifications,
        integrityVerified: true,
        recomputedPreAdmission,
        auditMetadata,
      };
    }

    const recordedMessage = typeof report.message === "string" ? report.message : null;
    return {
      recomputedPreAdmission,
      ok: false,
      status: report.status,
      message: `Sealed capture terminated with ${report.status}; recorded termination preserved and no decision re-evaluated${recordedMessage ? ` (recorded: ${recordedMessage})` : ""}`,
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
      replayMode: "RECORDED_TERMINATION_PRESERVED",
      recordedTermination: { status: report.status, message: recordedMessage },
      auditMetadata,
    };
  }

  // A completed decision requires pre-admission to pass on raw recomputation.
  if (!recomputedPreAdmission.passed) {
    return {
      ok: false,
      status: "REPLAY_PRE_ADMISSION_FAILED",
      message: `Pre-admission criteria not met during offline replay: ${String(recomputedPreAdmission.rejectionReason)}`,
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
      recomputedPreAdmission,
      auditMetadata,
    };
  }

  const recordedDecision = report.decisionResult as
    | {
        outcome?: unknown;
        rejectionReason?: unknown;
        flowResult?: { evaluationTimestampMs?: unknown };
      }
    | null
    | undefined;
  const recordedDecisionTimeMs = asPositiveSafeInteger(
    recordedDecision?.flowResult?.evaluationTimestampMs,
  );
  if (
    !recordedDecision ||
    typeof recordedDecision.outcome !== "string" ||
    recordedDecision.outcome !== report.status ||
    recordedDecisionTimeMs === null
  ) {
    return {
      ok: false,
      status: "REPLAY_RECORDED_DECISION_INCOMPLETE",
      message:
        "Sealed report records success but lacks a consistent decision outcome and decision timestamp; no decision replayed",
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
      auditMetadata,
    };
  }

  // The flow snapshot consumed by replay must be the one evaluated at the recorded decision time.
  if (flowEvaluation?.evaluationTimestampMs !== recordedDecisionTimeMs) {
    return {
      ok: false,
      status: "REPLAY_DECISION_TIME_MISMATCH",
      message: `Flow evaluation timestamp (${String(flowEvaluation?.evaluationTimestampMs)}) does not match recorded decision timestamp (${recordedDecisionTimeMs})`,
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
      auditMetadata,
    };
  }

  // Freshness recheck at the recorded decision time against the unchanged 15,000 ms ceiling.
  const replayCutoffMs = auditMetadata.observation?.cutoffTimestampMs ?? null;
  if (
    replayCutoffMs === null ||
    recordedDecisionTimeMs < replayCutoffMs ||
    recordedDecisionTimeMs - replayCutoffMs > REPLAY_MAX_CUTOFF_AGE_MS
  ) {
    return {
      ok: false,
      status: "REPLAY_STALE_DATA",
      message:
        replayCutoffMs === null
          ? "Verified cutoff evidence lacks a usable cutoff timestamp; decision not replayed"
          : `Cutoff age (${recordedDecisionTimeMs - replayCutoffMs} ms) at recorded decision time is outside 0..${REPLAY_MAX_CUTOFF_AGE_MS} ms; decision not replayed`,
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
      auditMetadata,
    };
  }

  // =========================================================================
  // Flow qualification consistency. The verification path is selected from RAW sealed evidence
  // (history, cutoff, observation, transaction records), never from a saved qualification label.
  // =========================================================================
  const flowRecordSummaries = [
    verifiedFilesSet.has(flowRelPath) ? flowEvaluation : undefined,
    report.flowEvaluation,
    report.decisionResult?.flowResult,
  ]
    .filter((rec) => rec !== undefined)
    .map((rec) => summarizeSealedFlowRecord(rec));
  const flowRecordKeys = new Set(flowRecordSummaries.map((sum) => JSON.stringify(sum)));
  const claimed = flowRecordSummaries[0] ?? null;
  const rawActivity = deriveRawWindowActivity(report, historyEvidence, sourceCutoff);
  const failFlow = (
    status: string,
    message: string,
    extra: Partial<CandidateDecisionReplayResult> = {},
  ) =>
    ({
      ok: false,
      status,
      message,
      poolId,
      mintAddress,
      verifiedFilesCount: fileVerifications.length,
      fileVerifications,
      integrityVerified: true,
      recomputedPreAdmission,
      flowQualificationCheck: { claimed, rawActivity },
      auditMetadata,
      ...extra,
    }) satisfies CandidateDecisionReplayResult;

  if (claimed === null || flowRecordKeys.size !== 1) {
    return failFlow(
      "REPLAY_FLOW_RECORDS_INCONSISTENT",
      `Sealed flow records (flow-evaluation, report flow, decision flow) disagree on qualification or counts: ${[...flowRecordKeys].join(" | ")}`,
    );
  }

  const activeRel = "evidence/active-window-evidence.json";
  const recomputeActive = (originalEvaluationTimestampMs: number) =>
    verifiedFilesSet.has(activeRel)
      ? recomputeActiveWindowFlowFromSealedEvidence({
          evidenceDir,
          report,
          verifiedFilesSet,
          sourceCutoff,
          historyEvidence,
          activeEvidence: JSON.parse(readFileSync(path.join(evidenceDir, activeRel), "utf8")),
          originalEvaluationTimestampMs,
          conversionTimestampMs: recordedDecisionTimeMs,
          poolId,
          mintAddress,
          maxTotalRequests: replayMaxTotalRequests,
        })
      : ({ ok: false, reason: `Verified ${activeRel} is required` } as const);

  let replayFlow: unknown = flowEvaluation;
  let recomputedActiveWindowFlow: CandidateDecisionReplayActiveWindow | undefined;
  const rawShowsActivity =
    (rawActivity.inWindowSignatures ?? 0) > 0 ||
    (rawActivity.discoveredSinceAnchor ?? 0) > 0 ||
    (rawActivity.notificationsReceived ?? 0) > 0 ||
    rawActivity.transactionDecodeRecords > 0;

  if (claimed.qualificationKind === "QUIET_WINDOW") {
    // Quiet claims (including legacy contexts without a kind) must be verified 0/0 and contradicted by
    // no raw activity: no in-window or post-anchor signatures, no notifications, no transaction retrievals.
    const quietConsistent =
      claimed.recentBuys60s === 0 &&
      claimed.recentSells60s === 0 &&
      claimed.isCoverageSufficient &&
      rawActivity.inWindowSignatures === 0 &&
      rawActivity.discoveredSinceAnchor === 0 &&
      rawActivity.transactionDecodeRecords === 0 &&
      (rawActivity.notificationsReceived === null || rawActivity.notificationsReceived === 0);
    if (!quietConsistent) {
      return failFlow(
        "REPLAY_FLOW_QUALIFICATION_CONTRADICTED",
        `Quiet-window claim (buys=${String(claimed.recentBuys60s)}, sells=${String(claimed.recentSells60s)}) is contradicted or unverifiable from raw evidence (in-window=${String(rawActivity.inWindowSignatures)}, since-anchor=${String(rawActivity.discoveredSinceAnchor)}, notifications=${String(rawActivity.notificationsReceived)}, decodes=${rawActivity.transactionDecodeRecords})`,
      );
    }
  } else if (claimed.qualificationKind === "ACTIVE_WINDOW") {
    const originalEvalMs = asPositiveSafeInteger(
      flowEvaluation?.paperQualificationContext?.originalEvaluationTimestampMs,
    );
    if ((rawActivity.inWindowSignatures ?? 0) < 1 || originalEvalMs === null) {
      return failFlow(
        "REPLAY_FLOW_QUALIFICATION_CONTRADICTED",
        `Active-window claim requires >= 1 in-window signature in sealed history and an original evaluation time (in-window=${String(rawActivity.inWindowSignatures)})`,
      );
    }
    const recomputed = recomputeActive(originalEvalMs);
    if (!recomputed.ok) {
      return failFlow(
        "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
        `Active-window flow could not be recomputed from sealed evidence: ${recomputed.reason}`,
      );
    }
    recomputedActiveWindowFlow = recomputed.value;
    if (
      recomputed.value.flow.isCoverageSufficient !== true ||
      recomputed.value.recentBuys60s !== claimed.recentBuys60s ||
      recomputed.value.recentSells60s !== claimed.recentSells60s
    ) {
      return failFlow(
        "REPLAY_ACTIVE_WINDOW_MISMATCH",
        `Re-decoded active-window flow (${recomputed.value.reconciliationStatus}, buys=${String(recomputed.value.recentBuys60s)}, sells=${String(recomputed.value.recentSells60s)}) does not reproduce the recorded flow (buys=${String(claimed.recentBuys60s)}, sells=${String(claimed.recentSells60s)})`,
        { recomputedActiveWindowFlow },
      );
    }
    replayFlow = recomputed.value.flow;
  } else {
    // Unqualified claim: must carry no sufficient coverage or counts. If raw evidence shows in-window activity
    // and the active-window option sealed its evidence, re-decode: an active window that would qualify cannot
    // be presented as unavailable (unless the recorded keepalive shows the live run could not qualify).
    if (
      claimed.qualificationKind !== "UNQUALIFIED" ||
      claimed.isCoverageSufficient ||
      claimed.recentBuys60s !== null ||
      claimed.recentSells60s !== null
    ) {
      return failFlow(
        "REPLAY_FLOW_QUALIFICATION_CONTRADICTED",
        `Flow claims coverage or counts without a PAPER qualification (${JSON.stringify(claimed)})`,
      );
    }
    if (
      rawShowsActivity &&
      (rawActivity.inWindowSignatures ?? 0) > 0 &&
      verifiedFilesSet.has(activeRel)
    ) {
      const recomputed = recomputeActive(recordedDecisionTimeMs);
      if (!recomputed.ok) {
        return failFlow(
          "REPLAY_ACTIVE_WINDOW_EVIDENCE_INVALID",
          `Active-window evidence present but not recomputable: ${recomputed.reason}`,
        );
      }
      recomputedActiveWindowFlow = recomputed.value;
      const keepalive = report.keepaliveMetrics as
        | {
            clientPingsSentCount?: unknown;
            matchedClientPongsCount?: unknown;
            unmatchedClientPongsCount?: unknown;
          }
        | undefined;
      const keepaliveSatisfiedAsRecorded =
        !!keepalive &&
        keepalive.clientPingsSentCount === keepalive.matchedClientPongsCount &&
        keepalive.unmatchedClientPongsCount === 0;
      if (recomputed.value.flow.isCoverageSufficient === true && keepaliveSatisfiedAsRecorded) {
        return failFlow(
          "REPLAY_FLOW_QUALIFICATION_CONTRADICTED",
          `Raw evidence re-decodes to a qualifying active window (buys=${String(recomputed.value.recentBuys60s)}, sells=${String(recomputed.value.recentSells60s)}) but the sealed flow claims it unavailable`,
          { recomputedActiveWindowFlow },
        );
      }
    }
  }

  // Replay candidate decision points
  const candidateMarketData = marketDataEvidence.candidateMarketData;
  const decisionNowMs = recordedDecisionTimeMs;
  const decisionNowIso = new Date(decisionNowMs).toISOString();

  const watchlistCandidate: WatchlistCandidateItem = {
    poolId,
    mintAddress,
    symbol: candidateMarketData.symbol,
    liquidityUsd: candidateMarketData.liquidityUsd,
    marketCapUsd: candidateMarketData.marketCapUsd,
    lmcRatio: candidateMarketData.liquidityUsd / candidateMarketData.marketCapUsd,
    lpBurnPct,
    assetAgeSeconds: candidateMarketData.assetAgeSeconds,
    volume5mUsd: candidateMarketData.volume5mUsd,
    buys5m: candidateMarketData.buys5m,
    sells5m: candidateMarketData.sells5m,
    buyToSellRatio: candidateMarketData.buyToSellRatio,
    status: "WATCHING",
    // Non-semantic synthetic value; labeled in auditMetadata.syntheticReplayContext.
    discoveredAt: decisionNowIso,
    lastEvaluatedAt: decisionNowIso,
  };

  // RugCheck metrics are recomputed from the verified sealed response with the shared strict validator.
  // Derived evidence, when sealed, must agree with the recomputation.
  const recomputedRugCheck = recomputeRugCheckFromSealedResponse(
    evidenceDir,
    report,
    verifiedFilesSet,
  );
  const rugCheckRelPath = "evidence/rugcheck-report.json";
  if (verifiedFilesSet.has(rugCheckRelPath)) {
    const rcData = JSON.parse(readFileSync(rugCheckPath, "utf8")) as {
      rugMetrics?: RugCheckMetrics | null;
    };
    const storedMetrics = rcData.rugMetrics ?? null;
    if (!rugMetricsEqual(storedMetrics, recomputedRugCheck.metrics)) {
      return {
        ok: false,
        status: "REPLAY_RUGCHECK_EVIDENCE_MISMATCH",
        message: `Sealed derived RugCheck metrics disagree with recomputation from ${recomputedRugCheck.responseFile ?? "no response"} (${recomputedRugCheck.status}); decision not replayed`,
        poolId,
        mintAddress,
        verifiedFilesCount: fileVerifications.length,
        fileVerifications,
        integrityVerified: true,
        recomputedPreAdmission,
        recomputedRugCheck,
        auditMetadata,
      };
    }
  }

  let rugMetrics: RugCheckMetrics | null = recomputedRugCheck.metrics
    ? { ...recomputedRugCheck.metrics }
    : null;
  const bundlerRelPath = "evidence/bundler-provenance.json";
  if (verifiedFilesSet.has(bundlerRelPath)) {
    const bundlerData = JSON.parse(readFileSync(bundlerPath, "utf8"));
    if (bundlerData.adaptedBundler?.bundlerPct !== undefined) {
      rugMetrics = {
        ...rugMetrics,
        bundlerPct: bundlerData.adaptedBundler.bundlerPct,
      };
    }
  }

  const flowProvider: CandidateFlowProvider = {
    getCandidateFlow: () => replayFlow as CandidateFlowResult,
  };

  const decisionResult = evaluateCandidateDecisionPoints({
    candidate: watchlistCandidate,
    baseSpotInfo: {
      spotPriceSol: candidateMarketData.spotPriceSol,
      spotPriceUsd: candidateMarketData.spotPriceUsd,
      liquidityUsd: candidateMarketData.liquidityUsd,
      momentum5mBps: candidateMarketData.momentum5mBps,
      priceChange1hPct: candidateMarketData.priceChange1hPct,
    },
    rugMetrics,
    flowProvider,
    currentNowMs: decisionNowMs,
    requireVerifiedHolders: true,
    executionContext: report.executionContext,
  });

  const recordedRejectionReason =
    typeof recordedDecision.rejectionReason === "string" ? recordedDecision.rejectionReason : null;
  const replayedRejectionReason =
    typeof decisionResult.rejectionReason === "string" ? decisionResult.rejectionReason : null;

  return {
    ok: true,
    status: decisionResult.outcome,
    message: `Replay completed successfully with outcome: ${decisionResult.outcome}`,
    poolId,
    mintAddress,
    verifiedFilesCount: fileVerifications.length,
    fileVerifications,
    integrityVerified: true,
    replayMode: "DECISION_REEVALUATED",
    recordedDecision: {
      outcome: recordedDecision.outcome,
      rejectionReason: recordedRejectionReason,
      decisionTimestampMs: recordedDecisionTimeMs,
    },
    matchesRecordedDecision:
      decisionResult.outcome === recordedDecision.outcome &&
      replayedRejectionReason === recordedRejectionReason,
    recomputedPreAdmission,
    recomputedRugCheck,
    ...(recomputedActiveWindowFlow ? { recomputedActiveWindowFlow } : {}),
    flowQualificationCheck: { claimed, rawActivity },
    decisionResult,
    auditMetadata: {
      ...auditMetadata,
      syntheticReplayContext: {
        discoveredAt: {
          value: decisionNowIso,
          reason:
            "NON_SEMANTIC_SYNTHETIC: WatchlistCandidateItem requires discoveredAt; the original run start was not sealed, so the recorded decision time is supplied. Decision evaluation does not consume discoveredAt; this is not an observed discovery time.",
        },
      },
    },
  };
}
