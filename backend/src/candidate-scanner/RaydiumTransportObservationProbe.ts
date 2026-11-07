/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium Transport Observation Probe
 *
 * Standalone operator tool for empirical characterization of live Solana WebSocket
 * streaming and bounded RPC reconciliation on an authentic Raydium pool context.
 *
 * PURPOSE & INVARIANTS:
 * 1. Transport Characterization Only:
 *    Measures received notifications, application payload bytes, queue telemetry,
 *    transaction retrieval decoding, and bounded signature discovery between sources.
 *    Does NOT test production completeness and does NOT run a PAPER strategy session.
 * 2. Scope & Candidate Binding:
 *    Bound exclusively to one explicitly identified reference pool (default: Raydium RAY/WSOL)
 *    and validated candidate token mint. Unsupported pool overrides are strictly rejected.
 * 3. Connection & Pacing Bounds:
 *    - Exactly one public-provider WebSocket connection; zero reconnects, retries, redirects,
 *      or automated provider fallback.
 *    - Maximum 5 minutes (300,000 ms) runtime from connect attempt to shutdown.
 *    - Message ceiling: at most 500 inbound application messages.
 *    - Payload ceiling: at most 2 MiB (2,097,152 bytes) application payload threshold;
 *      discloses any threshold-crossing overshoot independently of winning termination reason.
 *    - Queue ceiling: maximum 10 queued plus in-flight transaction jobs; halts on queue overflow.
 *    - HTTP ceiling: maximum 7 HTTP attempts total (at most 2 history queries, 5 transaction retrievals).
 *    - Provider pacing: strictly retains >= 2,500 ms spacing via GlobalResourceBudgetManager.
 *    - Spending ceiling: strictly $0.00.
 * 4. Bounded HTTP Paths:
 *    - Rejects HTTP redirects without following.
 *    - Body reading bounded by max response bytes across all paths.
 *    - Validates JSON-RPC errors and result shapes without swallowing missing results.
 * 5. Settled Shutdown & Shared Cancellation:
 *    - Single overall deadline epoch and shared AbortController.
 *    - Reconciliation time allocated strictly within overall maximum; never appended post-expiration.
 *    - Workers settled and accounting finalized before sealing evidence. Late completions discarded.
 * 6. Discrepancy & Coverage Invariants:
 *    - Reports witnessed signature discrepancies between sources with explicit comparison limits;
 *      does NOT claim true population notification loss without a full ledger dataset.
 *    - Preserves isProductionCompletenessEstablished = false permanently for this probe.
 *    - Silent notification loss is treated as a possible failure mode under evaluation.
 *    - Uses accepted enumerator before pagination and anchor witnessing.
 *    - Bundler concentration and Gate 11 remain separate and fail-closed.
 *    - Virtual wallet balance remains frozen at 7.9259 SOL.
 */

import * as fsSync from "fs";
import * as path from "path";
import * as crypto from "crypto";
import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import {
  RaydiumCandidateSubscriptionCoordinator,
  type CoordinatorMetrics,
} from "./RaydiumCandidateSubscriptionCoordinator.js";
import {
  RaydiumAmmV4TransactionSourceAdapter,
  type InjectedTransactionNotification,
  type TransactionSourceDiagnostics,
} from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import {
  ExactPoolHistoryEnumerator,
  type HistorySignatureRecord,
  type HistoryPageQueryParams,
  type HistoryPageFetcher,
  type HistoryEnumerationOutcome,
  isValidSolanaSignature,
} from "./ExactPoolHistoryEnumerator.js";
import {
  GlobalResourceBudgetManager,
  type GlobalBudgetStats,
} from "../research/prospective/GlobalResourceBudgetManager.js";
import {
  type ISolanaWebSocketTransport,
  NativeWebSocketTransport,
  DEFAULT_SOLANA_MAINNET_WSS,
} from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import {
  redactSensitiveText,
  deepRedactSensitiveObject,
} from "./SolanaTrackerBundlerCaptureTool.js";
import * as diagnostics_channel from "node:diagnostics_channel";

// ============================================================================
// Constants and Ceilings
// ============================================================================

export const DEFAULT_PROBE_DURATION_MS = 300_000; // 5 minutes
export const MAX_ALLOWED_PROBE_DURATION_MS = 300_000; // Hard ceiling: 5 minutes
export const MAX_INBOUND_MESSAGES_BUDGET = 500;
export const MAX_APPLICATION_PAYLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_QUEUE_DEPTH_LIMIT = 10;
export const MAX_HISTORY_QUERIES_LIMIT = 2;
export const MAX_TRANSACTION_RETRIEVALS_LIMIT = 5;
export const MAX_TOTAL_HTTP_ATTEMPTS = 7;
export const PROBE_MIN_PROVIDER_SPACING_MS = 2500;
export const DEFAULT_PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";
export const FROZEN_VIRTUAL_WALLET_SOL = "7.9259 SOL";

/**
 * Authentic reference Raydium AMM v4 RAY/WSOL pool context on Solana mainnet.
 */
export const DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT: TrackedRaydiumPoolContext = Object.freeze({
  poolId: "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA",
  candidateTokenMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  quoteTokenMint: "So11111111111111111111111111111111111111112", // WSOL
  baseVault: "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX",
  quoteVault: "3mEFzHsJyu2Cpjrz6zPmTzP7uoLFj9SbbecGVzzkL1mJ",
  baseMint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  quoteMint: "So11111111111111111111111111111111111111112",
  orientation: "TOKEN_BASE_SOL_QUOTE",
});

// ============================================================================
// Types & Interfaces
// ============================================================================

export type TransportProbeTerminationReason =
  | "DURATION_EXPIRED"
  | "MESSAGE_LIMIT_REACHED"
  | "PAYLOAD_LIMIT_REACHED"
  | "TRANSACTION_LIMIT_REACHED"
  | "COMPLETED"
  | "QUEUE_LIMIT_EXCEEDED"
  | "HTTP_BUDGET_EXHAUSTED"
  | "TRANSPORT_DISCONNECT"
  | "TRANSPORT_ERROR"
  | "MANUAL_CANCEL"
  | "UNKNOWN";

export type TransportProbeStatus =
  | "SUCCESS"
  | "CAP_LIMITED"
  | "LIMIT_REACHED"
  | "QUEUE_OVERFLOW"
  | "TRANSPORT_ERROR";

export interface TransportProbeConfig {
  readonly poolContext?: TrackedRaydiumPoolContext | undefined;
  readonly isLive?: boolean | undefined;
  readonly outDir?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly maxMessages?: number | undefined;
  readonly maxPayloadBytes?: number | undefined;
  readonly maxQueueDepth?: number | undefined;
  readonly maxHistoryQueries?: number | undefined;
  readonly maxTransactionRetrievals?: number | undefined;
  readonly wsUrl?: string | undefined;
  readonly rpcUrl?: string | undefined;
  readonly commitment?: "confirmed" | undefined;
  readonly signal?: AbortSignal | undefined;

  // Injected test seams
  readonly transport?: ISolanaWebSocketTransport | undefined;
  readonly fetchTransport?: typeof fetch | undefined;
  readonly historyPageFetcher?: HistoryPageFetcher | undefined;
  readonly clock?: (() => number) | undefined;
  readonly sleepFn?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly streamingDurationMs?: number | undefined;
}

export interface TransportProbeDryRunResult {
  readonly success: true;
  readonly dryRun: true;
  readonly status: "DRY_RUN";
  readonly targetPoolId: string;
  readonly candidateTokenMint: string;
  readonly plannedWsUrl: string;
  readonly plannedRpcUrl: string;
  readonly destinationDir: string;
  readonly limits: {
    readonly durationMs: number;
    readonly maxMessages: number;
    readonly maxPayloadBytes: number;
    readonly maxQueueDepth: number;
    readonly maxHistoryQueries: number;
    readonly maxTransactionRetrievals: number;
    readonly maxTotalHttpAttempts: number;
    readonly minProviderSpacingMs: number;
    readonly spendingCeiling: string;
  };
  readonly budgetStats: GlobalBudgetStats;
  readonly message: string;
}

export interface TransportProbeFailureResult {
  readonly success: false;
  readonly dryRun: boolean;
  readonly status:
    | "INVALID_INPUT"
    | "BUDGET_DENIED"
    | "DESTINATION_ALREADY_EXISTS"
    | "OPERATION_CANCELLED"
    | "EXECUTION_ERROR";
  readonly message: string;
  readonly targetDir?: string | undefined;
}

export interface TransportProbeSuccessResult {
  readonly success: boolean;
  readonly observationSuccess: boolean;
  readonly manifestSealed: boolean;
  readonly dryRun: false;
  readonly status: TransportProbeStatus;
  readonly targetDir: string;
  readonly poolId: string;
  readonly candidateTokenMint: string;
  readonly metadata: TransportProbeMetadata;
  readonly summary: TransportProbeSummary;
  readonly manifest: TransportProbeManifest;
}

export type TransportProbeResult =
  | TransportProbeDryRunResult
  | TransportProbeFailureResult
  | TransportProbeSuccessResult;

export interface TransportProbeMetadata {
  readonly probeVersion: "1.0";
  readonly poolId: string;
  readonly candidateTokenMint: string;
  readonly quoteTokenMint: string;
  readonly wsUrl: string;
  readonly rpcUrl: string;
  readonly commitment: "confirmed";
  readonly startTimeIso: string;
  readonly endTimeIso: string;
  readonly durationMs: number;
  readonly terminationReason: TransportProbeTerminationReason;
  readonly isCapTerminated: boolean;
  readonly counts: {
    readonly inboundMessagesCount: number;
    readonly applicationPayloadBytes: number;
    readonly overshootBytes: number;
    readonly peakQueueDepth: number;
    readonly queueRejectionsCount: number;
    readonly decodedSwapsCount: number;
    readonly transactionRetrievalsAttempted: number;
    readonly transactionRetrievalsSucceeded: number;
    readonly historyQueriesAttempted: number;
    readonly historySignaturesDiscovered: number;
    readonly nullBlockTimeCount: number;
  };
  readonly budgetStatus: GlobalBudgetStats;
  readonly isProductionCompletenessEstablished: false;
  readonly gate11Status: "UNAFFECTED_FAIL_CLOSED";
  readonly virtualWalletBalanceSol: "7.9259 SOL";
  readonly spendingCeiling: "$0.00";
  readonly disclaimer: string;
  readonly transportDiagnostics: TransportDiagnostics;
}

export interface TransportDiagnostics {
  /** Timestamp when WebSocket emitted 'open', or null if never connected */
  readonly connectedAtMs: number | null;
  /** Duration from probe start to connection in ms, or null if never connected */
  readonly connectDurationMs: number | null;
  /** Timestamp when subscription request was dispatched, or null */
  readonly subscriptionSentAtMs: number | null;
  /** Timestamp when subscription acknowledgement was received, or null */
  readonly subscriptionAcknowledgedAtMs: number | null;
  /** Subscription ID assigned by provider on successful acknowledgement, or null */
  readonly subscriptionId: number | null;
  /** Status of candidate pool subscription */
  readonly subscriptionStatus: "NOT_ATTEMPTED" | "PENDING" | "ACKNOWLEDGED" | "REJECTED";
  /** Sanitized error returned in subscription response, or null */
  readonly subscriptionError: string | null;
  /** Timestamp when the most recent WebSocket message was received, or null */
  readonly lastMessageReceivedAtMs: number | null;
  /** Sanitized first error message emitted by transport, or null */
  readonly firstErrorMessage: string | null;
  /** First error code if available (e.g. 'ECONNRESET', 'ETIMEDOUT', or numeric code), or null */
  readonly firstErrorCode: string | number | null;
  /** Sanitized error cause or cause chain if available, or null */
  readonly firstErrorCause: string | null;
  /** Close code from observed transport close event, or null if no close frame received */
  readonly closeCode: number | null;
  /** Sanitized close reason from observed transport close event, or null */
  readonly closeReason: string | null;
  /** True if closure or failure was initiated by upstream provider */
  readonly isUpstreamClosure: boolean;
  /** True if closure was initiated by probe shutdown (e.g. deadline expired, cap reached) */
  readonly intentionalShutdownInitiated: boolean;
  /** Local close code requested by probe shutdown, or null if no local close requested */
  readonly localCloseCode: number | null;
  /** Local close reason requested by probe shutdown, or null if no local close requested */
  readonly localCloseReason: string | null;
  /** Number of WebSocket PING frames received from server observed via diagnostics channel */
  readonly serverPingsReceivedCount: number;
  /** Timestamp of the most recent server PING frame received, or null */
  readonly lastServerPingReceivedAtMs: number | null;
  /** Number of WebSocket PONG frames received from server observed via diagnostics channel */
  readonly serverPongsReceivedCount: number;
  /** Timestamp of the most recent server PONG frame received, or null */
  readonly lastServerPongReceivedAtMs: number | null;
  /** Classification of close origin: UPSTREAM, INTENTIONAL_SHUTDOWN, UNCERTAIN, or NOT_CLOSED */
  readonly observedCloseOrigin: "UPSTREAM" | "INTENTIONAL_SHUTDOWN" | "UNCERTAIN" | "NOT_CLOSED";
}

export const DEFAULT_TRANSPORT_DIAGNOSTICS: TransportDiagnostics = Object.freeze({
  connectedAtMs: null,
  connectDurationMs: null,
  subscriptionSentAtMs: null,
  subscriptionAcknowledgedAtMs: null,
  subscriptionId: null,
  subscriptionStatus: "NOT_ATTEMPTED",
  subscriptionError: null,
  lastMessageReceivedAtMs: null,
  firstErrorMessage: null,
  firstErrorCode: null,
  firstErrorCause: null,
  closeCode: null,
  closeReason: null,
  isUpstreamClosure: false,
  intentionalShutdownInitiated: false,
  localCloseCode: null,
  localCloseReason: null,
  serverPingsReceivedCount: 0,
  lastServerPingReceivedAtMs: null,
  serverPongsReceivedCount: 0,
  lastServerPongReceivedAtMs: null,
  observedCloseOrigin: "NOT_CLOSED",
});

export interface HistoryQueryAuditRecord {
  readonly pageIndex: number;
  readonly address: string;
  readonly limit: number;
  readonly before?: string | undefined;
  readonly requestSentAtMs: number;
  readonly headersReceivedAtMs?: number | undefined;
  readonly responseReceivedAtMs: number | null;
  readonly durationMs: number;
  readonly httpStatus: number | null;
  readonly responseSha256: string | null;
  readonly recordsDiscovered: number;
  readonly error?: string | undefined;
}

export interface TransportProbeSummary {
  readonly poolId: string;
  readonly candidateTokenMint: string;
  readonly status: TransportProbeStatus;
  readonly observationSuccess: boolean;
  readonly terminationReason: TransportProbeTerminationReason;
  readonly durationMs: number;
  readonly timing: {
    readonly startTimeIso: string;
    readonly endTimeIso: string;
    readonly localDurationMs: number;
  };
  readonly queueTelemetry: {
    readonly peakQueueDepth: number;
    readonly queueLimit: number;
    readonly queueLimitExceeded: boolean;
    readonly queueRejectionsCount: number;
    readonly pendingAtShutdown: number;
  };
  readonly streamingTelemetry: {
    readonly inboundMessagesCount: number;
    readonly maxMessagesCeiling: number;
    readonly applicationPayloadBytes: number;
    readonly maxPayloadBytesCeiling: number;
    readonly overshootBytes: number;
    readonly coordinatorMetrics: CoordinatorMetrics;
  };
  readonly tradeFlowTelemetry: {
    readonly decodedSwapsCount: number;
    readonly recentBuys: number | null;
    readonly recentSells: number | null;
    readonly flowCoverageStatus: string;
    readonly isProductionCompletenessEstablished: false;
  };
  readonly reconciliationTelemetry: {
    readonly anchorWitnessed: boolean;
    readonly anchorSignature: string | null;
    readonly anchorSlot: number | null;
    readonly anchorBlockTime: number | null;
    readonly historyQueriesAttempted: number;
    readonly historyQueriesLimit: number;
    readonly historyRecordsDiscovered: number;
    readonly enumeratorOutcome: HistoryEnumerationOutcome | string;
    readonly discoveryDurationMs: number | null;
  };
  readonly historyDiscoveryTelemetry: {
    readonly anchorWitnessed: boolean;
    readonly anchorSignature: string | null;
    readonly anchorSlot: number | null;
    readonly anchorBlockTime: number | null;
    readonly historyQueriesAttempted: number;
    readonly historyQueriesLimit: number;
    readonly historyRecordsDiscovered: number;
    readonly discoveryOutcome: HistoryEnumerationOutcome | string;
    readonly discoveryDurationMs: number | null;
  };
  readonly discrepancyAnalysis: {
    readonly totalWsWitnessedSignatures: number;
    readonly totalHistoryWitnessedSignatures: number;
    readonly commonSignaturesCount: number;
    readonly wsOnlySignaturesCount: number;
    readonly historyOnlySignaturesCount: number;
    readonly unretrievedSampleSignaturesCount: number;
    readonly comparisonLimitsNotice: string;
  };
  readonly budgetAccounting: {
    readonly totalHttpRequests: number;
    readonly maxHttpAttemptsLimit: number;
    readonly enrichmentAttempts: number;
    readonly forwardReservationPreserved: boolean;
    readonly minProviderSpacingEnforcedMs: number;
  };
  readonly sampledTransactionAudits: readonly TransactionSourceDiagnostics[];
  readonly historyQueryAudits: readonly HistoryQueryAuditRecord[];
  readonly transportDiagnostics: TransportDiagnostics;
}

export interface TransportProbeManifestFileEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly byteSize: number;
}

export interface TransportProbeManifest {
  readonly manifestVersion: "1.0";
  readonly capturedAtIso: string;
  readonly poolId: string;
  readonly candidateTokenMint: string;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly files: readonly TransportProbeManifestFileEntry[];
  readonly entriesDigestSha256: string;
  readonly manifestFileSha256: string;
}

export interface WitnessedSignaturesEvidence {
  readonly poolId: string;
  readonly timestampIso: string;
  readonly wsWitnessed: readonly {
    readonly signature: string;
    readonly receivedEpochMs: number;
    readonly slot: number;
  }[];
  readonly historyWitnessed: readonly {
    readonly signature: string;
    readonly slot: number;
    readonly blockTime: number | null;
  }[];
  readonly discrepancies: {
    readonly commonSignatures: readonly string[];
    readonly wsOnlySignatures: readonly string[];
    readonly historyOnlySignatures: readonly string[];
    readonly unretrievedSampleSignaturesCount: number;
    readonly comparisonLimitsNotice: string;
  };
}

// ============================================================================
// Helper Utilities
// ============================================================================

/**
 * Resolves project root directory by traversing upwards to find the top-level package.json.
 */
export function resolveProjectRoot(): string {
  let current = process.cwd();
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(current, "package.json");
    if (fsSync.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "nexustrade-otis") {
          return current;
        }
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

export function computeSha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function serializeJsonSafe(value: unknown, indent: number = 2): string {
  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") {
        return val.toString();
      }
      return val;
    },
    indent,
  );
}

/**
 * Extracts available error code from Error or error-like object, traversing cause chains if present.
 */
export function extractErrorCode(err: unknown): string | number | null {
  if (!err || (typeof err !== "object" && typeof err !== "function")) {
    return null;
  }
  const obj = err as Record<string, unknown>;
  if (typeof obj.code === "string" || typeof obj.code === "number") {
    return obj.code;
  }
  if (typeof obj.status === "string" || typeof obj.status === "number") {
    return obj.status;
  }
  if (typeof obj.statusCode === "number") {
    return obj.statusCode;
  }
  if (obj.cause) {
    return extractErrorCode(obj.cause);
  }
  return null;
}

/**
 * Builds a bounded, sanitized error cause chain representation, preserving nested error codes and details.
 */
export function formatErrorCauseChain(
  cause: unknown,
  depth = 0,
  maxDepth = 5,
  secrets: readonly string[] = [],
): string | null {
  if (cause === null || cause === undefined || depth >= maxDepth) {
    return null;
  }

  let formatted: string;
  let nextCause: unknown = undefined;

  if (cause instanceof Error) {
    const errObj = cause as Error & { code?: unknown; cause?: unknown };
    const codePart = errObj.code !== undefined ? ` [code: ${String(errObj.code)}]` : "";
    const namePart = errObj.name && errObj.name !== "Error" ? `${errObj.name}: ` : "";
    formatted = `${namePart}${errObj.message}${codePart}`;
    nextCause = errObj.cause;
  } else if (typeof cause === "object") {
    const sanitized = deepRedactSensitiveObject(cause, secrets);
    const obj = cause as Record<string, unknown>;
    nextCause = obj.cause;
    try {
      formatted = JSON.stringify(sanitized);
    } catch {
      formatted = String(cause);
    }
  } else {
    formatted = String(cause);
  }

  const sanitizedCurrent = redactSensitiveText(formatted, secrets);

  if (nextCause !== undefined && nextCause !== null && depth + 1 < maxDepth) {
    const child = formatErrorCauseChain(nextCause, depth + 1, maxDepth, secrets);
    if (child) {
      return `${sanitizedCurrent} -> ${child}`;
    }
  }

  return sanitizedCurrent;
}

function sanitizeDestinationDirName(timestampIso: string, poolId: string): string {
  const safeTimestamp = timestampIso.replace(/:/g, "-");
  const safePoolId = poolId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeTimestamp}_${safePoolId}`;
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("Operation aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", abortHandler);
      resolve();
    }, ms);

    const abortHandler = () => {
      clearTimeout(timer);
      const err = new Error("Operation aborted");
      err.name = "AbortError";
      reject(err);
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

/**
 * Safely cancels a stream or reader with an explicit timeout bound.
 * Prevents hanging indefinitely if cancel() never settles.
 */
export async function boundedCancel(
  target: { cancel: (reason?: unknown) => Promise<unknown> },
  reason?: unknown,
  timeoutMs = 1000,
): Promise<void> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    const cancelPromise = Promise.resolve(target.cancel(reason)).then(
      () => {},
      () => {},
    );
    await Promise.race([cancelPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
  } catch {
    // ignore
  }
}

/**
 * Reads bytes from a ReadableStream up to maxBytes.
 * Cancels reader immediately and returns overflow if limit is exceeded.
 */
export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; totalObservedBytes: number; overflow: boolean }> {
  if (signal?.aborted) {
    const err = new Error("Operation aborted");
    err.name = "AbortError";
    await boundedCancel(stream, signal.reason, 500);
    throw err;
  }

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let totalObservedBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        throw err;
      }

      let cancelAbortListener: (() => void) | undefined;
      let readResult: ReadableStreamReadResult<Uint8Array>;

      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            const err = new Error("Operation aborted");
            err.name = "AbortError";
            reject(err);
            return;
          }
          const handler = () => {
            const err = new Error("Operation aborted");
            err.name = "AbortError";
            reject(err);
          };
          signal.addEventListener("abort", handler, { once: true });
          cancelAbortListener = () => signal.removeEventListener("abort", handler);
        });
        abortPromise.catch(() => {});

        try {
          readResult = await Promise.race([reader.read(), abortPromise]);
        } finally {
          cancelAbortListener?.();
        }
      } else {
        readResult = await reader.read();
      }

      const { done, value } = readResult;

      if (done) {
        if (signal?.aborted) {
          const err = new Error("Operation aborted");
          err.name = "AbortError";
          throw err;
        }
        break;
      }

      if (value && value.byteLength > 0) {
        totalObservedBytes += value.byteLength;
        const remainingCapacity = maxBytes - retainedBytes;
        if (remainingCapacity > 0) {
          const toCopy = Math.min(value.byteLength, remainingCapacity);
          const chunk = Buffer.alloc(toCopy);
          chunk.set(value.subarray(0, toCopy));
          chunks.push(chunk);
          retainedBytes += toCopy;
        }

        if (totalObservedBytes > maxBytes) {
          await boundedCancel(reader, new Error("RESPONSE_TOO_LARGE"), 500);
          return {
            bytes: Buffer.concat(chunks),
            totalObservedBytes,
            overflow: true,
          };
        }
      }
    }
  } catch (err) {
    await boundedCancel(reader, err, 500);
    throw err;
  }

  return {
    bytes: Buffer.concat(chunks),
    totalObservedBytes,
    overflow: false,
  };
}

/**
 * Wraps an underlying fetch function with redirect rejection and body-size limits.
 */
export function createBoundedFetchTransport(
  underlyingFetch: typeof fetch = globalThis.fetch,
  maxBytes: number = MAX_APPLICATION_PAYLOAD_BYTES,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // 1. Force redirect: "manual" to reject automated follow-ups
    const boundedInit: RequestInit = {
      ...init,
      redirect: "manual",
    };

    // Race header fetch against init.signal to guarantee prompt cancellation
    let cancelFetchAbortListener: (() => void) | undefined;
    const fetchAbortPromise = new Promise<never>((_, reject) => {
      if (init?.signal?.aborted) {
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
      const handler = () => {
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        reject(err);
      };
      init?.signal?.addEventListener("abort", handler, { once: true });
      cancelFetchAbortListener = () => init?.signal?.removeEventListener("abort", handler);
    });
    fetchAbortPromise.catch(() => {});

    const fetchPromise = underlyingFetch(input, boundedInit);
    fetchPromise.then(
      async (lateResp) => {
        if (init?.signal?.aborted && lateResp.body) {
          await boundedCancel(lateResp.body, new Error("Operation aborted"), 500);
        }
      },
      () => {},
    );

    let resp: Response;
    try {
      resp = await (init?.signal ? Promise.race([fetchPromise, fetchAbortPromise]) : fetchPromise);
    } finally {
      cancelFetchAbortListener?.();
    }

    // 2. Reject redirect status
    if (resp.type === "opaqueredirect" || (resp.status >= 300 && resp.status < 400)) {
      if (resp.body) {
        await boundedCancel(resp.body, new Error("HTTP_REDIRECT_REJECTED"), 500);
      }
      throw new Error(`HTTP_REDIRECT_REJECTED: Redirect status ${resp.status} is prohibited`);
    }

    // 3. Wrap response to bound body reading
    let cachedBuffer: Buffer | null = null;

    const getBoundedBuffer = async (): Promise<Buffer> => {
      if (cachedBuffer !== null) return cachedBuffer;
      if (!resp.body) {
        cachedBuffer = Buffer.alloc(0);
        return cachedBuffer;
      }

      const streamRes = await readBoundedStream(resp.body, maxBytes, init?.signal ?? undefined);
      if (streamRes.overflow) {
        throw new Error(
          `RESPONSE_TOO_LARGE: Response body (${streamRes.totalObservedBytes} bytes) exceeded maximum allowed limit of ${maxBytes} bytes`,
        );
      }
      cachedBuffer = streamRes.bytes;
      return cachedBuffer;
    };

    return new Proxy(resp, {
      get(target, prop) {
        if (prop === "text") {
          return async () => {
            if (resp.body) {
              const buf = await getBoundedBuffer();
              return buf.toString("utf8");
            }
            return target.text();
          };
        }
        if (prop === "json") {
          return async () => {
            if (resp.body) {
              const buf = await getBoundedBuffer();
              return JSON.parse(buf.toString("utf8"));
            }
            return target.json();
          };
        }
        if (prop === "arrayBuffer") {
          return async () => {
            if (resp.body) {
              const buf = await getBoundedBuffer();
              return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            }
            return target.arrayBuffer();
          };
        }
        const val = Reflect.get(target, prop, target);
        if (typeof val === "function") {
          return val.bind(target);
        }
        return val;
      },
    });
  };
}

// ============================================================================
// Metered WebSocket Transport Wrapper
// ============================================================================

export class MeteredWebSocketTransport implements ISolanaWebSocketTransport {
  private readonly inner: ISolanaWebSocketTransport;
  private messageCount = 0;
  private applicationPayloadBytes = 0;
  private readonly maxPayloadBytes?: number | undefined;
  private readonly onMessageIntercept?:
    | ((
        count: number,
        bytes: number,
        byteLen: number,
        data: string | Buffer,
        isOversized: boolean,
      ) => void)
    | undefined;

  private readonly listeners: {
    open: (() => void)[];
    message: ((data: string | Buffer) => void)[];
    error: ((err: Error) => void)[];
    close: ((code: number, reason: string) => void)[];
  } = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  constructor(
    inner: ISolanaWebSocketTransport,
    maxPayloadBytes?: number | undefined,
    onMessageIntercept?:
      | ((
          count: number,
          bytes: number,
          byteLen: number,
          data: string | Buffer,
          isOversized: boolean,
        ) => void)
      | undefined,
  ) {
    this.inner = inner;
    this.maxPayloadBytes = maxPayloadBytes;
    this.onMessageIntercept = onMessageIntercept;

    // Attach single ingress listeners on underlying transport
    this.inner.on("open", () => {
      for (const listener of [...this.listeners.open]) {
        listener();
      }
    });

    this.inner.on("message", (data: string | Buffer) => {
      this.messageCount++;
      const byteLen = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.length;
      this.applicationPayloadBytes += byteLen;
      const isOversized =
        this.maxPayloadBytes !== undefined && this.applicationPayloadBytes > this.maxPayloadBytes;

      this.onMessageIntercept?.(
        this.messageCount,
        this.applicationPayloadBytes,
        byteLen,
        data,
        isOversized,
      );

      // Distribute to all registered consumer listeners only if not oversized
      if (!isOversized) {
        for (const listener of [...this.listeners.message]) {
          listener(data);
        }
      }
    });

    this.inner.on("error", (err: Error) => {
      for (const listener of [...this.listeners.error]) {
        listener(err);
      }
    });

    this.inner.on("close", (code: number, reason: string) => {
      for (const listener of [...this.listeners.close]) {
        listener(code, reason);
      }
    });
  }

  public getMessageCount(): number {
    return this.messageCount;
  }

  public getApplicationPayloadBytes(): number {
    return this.applicationPayloadBytes;
  }

  public send(data: string): void {
    this.inner.send(data);
  }

  public close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }

  public on(event: "open", listener: () => void): void;
  public on(event: "message", listener: (data: string | Buffer) => void): void;
  public on(event: "error", listener: (err: Error) => void): void;
  public on(event: "close", listener: (code: number, reason: string) => void): void;
  public on(
    event: "open" | "message" | "error" | "close",
    listener: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): void {
    this.listeners[event].push(listener);
  }
}

function sealCaptureManifest(
  targetDir: string,
  poolId: string,
  candidateTokenMint: string,
  capturedAtIso: string,
): TransportProbeManifest {
  const fileNames = fsSync
    .readdirSync(targetDir)
    .filter((f) => f !== "capture-manifest.json" && !f.startsWith("."));
  const entries: TransportProbeManifestFileEntry[] = [];
  let totalBytes = 0;

  for (const filename of fileNames) {
    const filePath = path.join(targetDir, filename);
    const content = fsSync.readFileSync(filePath);
    entries.push({
      filename,
      sha256: computeSha256(content),
      byteSize: content.length,
    });
    totalBytes += content.length;
  }

  entries.sort((a, b) => a.filename.localeCompare(b.filename));

  const manifestPayload = entries.map((f) => `${f.filename}:${f.sha256}`).join("\n");
  const entriesDigestSha256 = computeSha256(manifestPayload);

  const manifestPath = path.join(targetDir, "capture-manifest.json");
  const manifestDataOnDisk = {
    manifestVersion: "1.0",
    capturedAtIso,
    poolId,
    candidateTokenMint,
    totalFiles: entries.length,
    totalBytes,
    files: entries,
    entriesDigestSha256,
  };

  fsSync.writeFileSync(manifestPath, JSON.stringify(manifestDataOnDisk, null, 2), {
    encoding: "utf8",
    flag: "wx",
  });

  const writtenManifestBytes = fsSync.readFileSync(manifestPath);
  const manifestFileSha256 = computeSha256(writtenManifestBytes);

  return {
    manifestVersion: "1.0",
    capturedAtIso,
    poolId,
    candidateTokenMint,
    totalFiles: entries.length,
    totalBytes,
    files: entries,
    entriesDigestSha256,
    manifestFileSha256,
  };
}

// ============================================================================
// Core Probe Runner Implementation
// ============================================================================

/**
 * Executes a bounded transport observation probe.
 */
export async function executeTransportObservationProbe(
  config: TransportProbeConfig,
): Promise<TransportProbeResult> {
  const clock = config.clock ?? (() => Date.now());
  const isLive = config.isLive === true;

  // 1. Validate Candidate Pool Context (Strictly bound to reference RAY/WSOL)
  const poolContext = config.poolContext ?? DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT;
  try {
    validateTrackedPoolContext(poolContext);
  } catch (err: unknown) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid poolContext: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (poolContext.poolId !== DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Unsupported pool: '${poolContext.poolId}'. This probe is strictly bound to the reference RAY/WSOL pool (${DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId}).`,
    };
  }

  // 2. Validate Operational Ceilings and Durations
  const durationMs = config.durationMs ?? DEFAULT_PROBE_DURATION_MS;
  if (
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_ALLOWED_PROBE_DURATION_MS
  ) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid durationMs: expected integer 1..${MAX_ALLOWED_PROBE_DURATION_MS}, received ${String(durationMs)}`,
    };
  }

  const maxMessages = config.maxMessages ?? MAX_INBOUND_MESSAGES_BUDGET;
  if (
    typeof maxMessages !== "number" ||
    !Number.isSafeInteger(maxMessages) ||
    maxMessages <= 0 ||
    maxMessages > MAX_INBOUND_MESSAGES_BUDGET
  ) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid maxMessages: expected integer 1..${MAX_INBOUND_MESSAGES_BUDGET}, received ${String(maxMessages)}`,
    };
  }

  const maxPayloadBytes = config.maxPayloadBytes ?? MAX_APPLICATION_PAYLOAD_BYTES;
  if (
    typeof maxPayloadBytes !== "number" ||
    !Number.isSafeInteger(maxPayloadBytes) ||
    maxPayloadBytes <= 0 ||
    maxPayloadBytes > MAX_APPLICATION_PAYLOAD_BYTES
  ) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid maxPayloadBytes: expected integer 1..${MAX_APPLICATION_PAYLOAD_BYTES}, received ${String(maxPayloadBytes)}`,
    };
  }

  const maxQueueDepth = config.maxQueueDepth ?? MAX_QUEUE_DEPTH_LIMIT;
  if (
    typeof maxQueueDepth !== "number" ||
    !Number.isSafeInteger(maxQueueDepth) ||
    maxQueueDepth <= 0 ||
    maxQueueDepth > MAX_QUEUE_DEPTH_LIMIT
  ) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid maxQueueDepth: expected integer 1..${MAX_QUEUE_DEPTH_LIMIT}, received ${String(maxQueueDepth)}`,
    };
  }

  const maxHistoryQueries = config.maxHistoryQueries ?? MAX_HISTORY_QUERIES_LIMIT;
  if (
    typeof maxHistoryQueries !== "number" ||
    !Number.isSafeInteger(maxHistoryQueries) ||
    maxHistoryQueries <= 0 ||
    maxHistoryQueries > MAX_HISTORY_QUERIES_LIMIT
  ) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid maxHistoryQueries: expected integer 1..${MAX_HISTORY_QUERIES_LIMIT}, received ${String(maxHistoryQueries)}`,
    };
  }

  const maxTransactionRetrievals =
    config.maxTransactionRetrievals ?? MAX_TRANSACTION_RETRIEVALS_LIMIT;
  if (
    typeof maxTransactionRetrievals !== "number" ||
    !Number.isSafeInteger(maxTransactionRetrievals) ||
    maxTransactionRetrievals <= 0 ||
    maxTransactionRetrievals > MAX_TRANSACTION_RETRIEVALS_LIMIT
  ) {
    return {
      success: false,
      dryRun: !isLive,
      status: "INVALID_INPUT",
      message: `Invalid maxTransactionRetrievals: expected integer 1..${MAX_TRANSACTION_RETRIEVALS_LIMIT}, received ${String(maxTransactionRetrievals)}`,
    };
  }

  // Output Directory Boundary Enforcement
  const projectRoot = resolveProjectRoot();
  const baseCapturesDir = path.resolve(
    projectRoot,
    "data",
    "research",
    "captures",
    "transport-probe",
  );

  const startTime = clock();
  const startTimeIso = new Date(startTime).toISOString();
  const defaultDir = path.join(
    baseCapturesDir,
    sanitizeDestinationDirName(startTimeIso, poolContext.poolId),
  );

  let targetDir = defaultDir;
  if (config.outDir) {
    const resolvedOutDir = path.resolve(config.outDir);
    const rel = path.relative(baseCapturesDir, resolvedOutDir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        success: false,
        dryRun: !isLive,
        status: "INVALID_INPUT",
        message: `Invalid outDir: destination directory '${config.outDir}' must reside within the documented captures directory '${baseCapturesDir}'`,
      };
    }
    targetDir = resolvedOutDir;
  }

  const wsUrl = config.wsUrl ?? DEFAULT_SOLANA_MAINNET_WSS;
  const rpcUrl = config.rpcUrl ?? DEFAULT_PUBLIC_RPC_URL;
  const commitment = "confirmed";

  // 3. Configure Resource Budget Manager:
  // Preserves maxEnrichmentAttempts = 7, minReservedForwardRequests = 4, and maxTotalRequests = 11,
  // ensuring exactly 11 - 4 = 7 enrichment requests before reservation denial.
  const budget = new GlobalResourceBudgetManager({
    maxTotalRequests: 11,
    maxEnrichmentAttempts: 7,
    minReservedForwardRequests: 4,
    minProviderSpacingMs: PROBE_MIN_PROVIDER_SPACING_MS,
    clock,
  });

  // 4. DRY-RUN MODE: Zero network execution
  if (!isLive) {
    return {
      success: true,
      dryRun: true,
      status: "DRY_RUN",
      targetPoolId: poolContext.poolId,
      candidateTokenMint: poolContext.candidateTokenMint,
      plannedWsUrl: wsUrl,
      plannedRpcUrl: rpcUrl,
      destinationDir: targetDir,
      limits: {
        durationMs,
        maxMessages,
        maxPayloadBytes,
        maxQueueDepth,
        maxHistoryQueries,
        maxTransactionRetrievals,
        maxTotalHttpAttempts: MAX_TOTAL_HTTP_ATTEMPTS,
        minProviderSpacingMs: PROBE_MIN_PROVIDER_SPACING_MS,
        spendingCeiling: "$0.00",
      },
      budgetStats: budget.getStats(),
      message: "Dry-run plan validation succeeded. Zero network requests or sockets opened.",
    };
  }

  // 4.5. Pre-dispatch cancellation check before ANY resource allocation or network setup
  if (config.signal?.aborted) {
    return {
      success: false,
      dryRun: !isLive,
      status: "OPERATION_CANCELLED",
      message: "Operation cancelled before execution: caller signal already aborted",
    };
  }

  // 5. LIVE EXECUTION MODE: Pre-dispatch Atomic Directory Reservation
  try {
    fsSync.mkdirSync(path.dirname(targetDir), { recursive: true });
    fsSync.mkdirSync(targetDir, { recursive: false });
  } catch (err: unknown) {
    return {
      success: false,
      dryRun: false,
      status: "DESTINATION_ALREADY_EXISTS",
      message: `Failed to create exclusive target destination directory '${targetDir}': ${err instanceof Error ? err.message : String(err)}`,
      targetDir,
    };
  }

  // 6. Unified Deadline, Shared Cancellation & Settle Architecture
  const overallDeadlineEpoch = startTime + durationMs;
  const overallAbortController = new AbortController();
  let isProbeTerminated = false;
  let isIntentionalClosure = false;
  let isStreamingActive = true;
  let probeActive = true;

  let meteredTransport: MeteredWebSocketTransport | undefined;
  let coordinator: RaydiumCandidateSubscriptionCoordinator | undefined;
  let removeCallerSignalListener: (() => void) | undefined;
  let cleanupDiagnosticsChannel: (() => void) | undefined;

  const transportDiagnostics = {
    connectedAtMs: null as number | null,
    connectDurationMs: null as number | null,
    subscriptionSentAtMs: null as number | null,
    subscriptionAcknowledgedAtMs: null as number | null,
    subscriptionId: null as number | null,
    subscriptionStatus: "NOT_ATTEMPTED" as
      | "NOT_ATTEMPTED"
      | "PENDING"
      | "ACKNOWLEDGED"
      | "REJECTED",
    subscriptionError: null as string | null,
    lastMessageReceivedAtMs: null as number | null,
    firstErrorMessage: null as string | null,
    firstErrorCode: null as string | number | null,
    firstErrorCause: null as string | null,
    closeCode: null as number | null,
    closeReason: null as string | null,
    isUpstreamClosure: false,
    intentionalShutdownInitiated: false,
    localCloseCode: null as number | null,
    localCloseReason: null as string | null,
    serverPingsReceivedCount: 0,
    lastServerPingReceivedAtMs: null as number | null,
    serverPongsReceivedCount: 0,
    lastServerPongReceivedAtMs: null as number | null,
    observedCloseOrigin: "NOT_CLOSED" as
      | "UPSTREAM"
      | "INTENTIONAL_SHUTDOWN"
      | "UNCERTAIN"
      | "NOT_CLOSED",
  };

  const probeState = {
    terminationReason: "UNKNOWN" as TransportProbeTerminationReason,
  };

  const terminateProbe = (reason: TransportProbeTerminationReason, closeMsg?: string): void => {
    if (isProbeTerminated) return;
    isProbeTerminated = true;
    probeActive = false;
    isIntentionalClosure = true;
    if (reason !== "TRANSPORT_ERROR" && reason !== "TRANSPORT_DISCONNECT") {
      transportDiagnostics.intentionalShutdownInitiated = true;
    }
    const sanitizedCloseMsg = closeMsg ? redactSensitiveText(closeMsg) : undefined;
    transportDiagnostics.localCloseCode = 1000;
    transportDiagnostics.localCloseReason = sanitizedCloseMsg ?? reason;
    if (probeState.terminationReason === "UNKNOWN") {
      probeState.terminationReason = reason;
    }
    overallAbortController.abort(new Error(sanitizedCloseMsg ?? reason));
    try {
      meteredTransport?.close(1000, sanitizedCloseMsg ?? reason);
    } catch {
      // ignore
    }
    try {
      coordinator?.close();
    } catch {
      // ignore
    }
    try {
      cleanupDiagnosticsChannel?.();
    } catch {
      // ignore
    }
  };

  if (config.signal) {
    if (config.signal.aborted) {
      terminateProbe("MANUAL_CANCEL", "Probe cancelled by caller signal");
    } else {
      const callerAbortHandler = () => {
        terminateProbe("MANUAL_CANCEL", "Probe cancelled by caller signal");
      };
      config.signal.addEventListener("abort", callerAbortHandler, { once: true });
      removeCallerSignalListener = () => {
        config.signal?.removeEventListener("abort", callerAbortHandler);
      };
    }
  }

  // 7. Bounded HTTP Transport Wrapper
  const boundedFetch = createBoundedFetchTransport(
    config.fetchTransport ?? globalThis.fetch,
    maxPayloadBytes,
  );

  // 8. Components Setup
  const sleepFn =
    config.sleepFn ??
    (async (ms: number, signal?: AbortSignal) => {
      await sleepWithSignal(ms, signal);
    });

  const tracker = new RollingTradeFlowTracker({
    poolId: poolContext.poolId,
    tokenMint: poolContext.candidateTokenMint,
    clock,
  });

  const adapter = new RaydiumAmmV4TransactionSourceAdapter({
    poolContext,
    rpcUrl,
    budgetManager: budget,
    transport: boundedFetch,
    pacingMs: PROBE_MIN_PROVIDER_SPACING_MS,
    maxPendingQueueSize: maxQueueDepth,
    commitment: "confirmed",
    maxSupportedTransactionVersion: 1,
    tracker,
    sleepFn: (ms) => sleepFn(ms),
    clock,
  });

  // Track witnessed signatures
  interface WsSignatureRecord {
    readonly signature: string;
    readonly receivedEpochMs: number;
    readonly slot: number;
  }
  const wsWitnessedList: WsSignatureRecord[] = [];
  const wsWitnessedSignatures = new Set<string>();

  let peakQueueDepth = 0;
  let queueLimitExceeded = false;
  let queueRejectionsCount = 0;
  let transactionRetrievalsSucceeded = 0;
  let decodedSwapsCount = 0;
  let nullBlockTimeCount = 0;
  const sampledTransactionAudits: TransactionSourceDiagnostics[] = [];
  const historyQueryAudits: HistoryQueryAuditRecord[] = [];

  // Underlying WebSocket Transport
  let baseTransport: ISolanaWebSocketTransport | undefined;
  if (!isProbeTerminated && !overallAbortController.signal.aborted) {
    baseTransport = config.transport ?? new NativeWebSocketTransport(wsUrl);

    let underlyingWs: unknown = undefined;
    if (
      baseTransport &&
      "getUnderlyingSocket" in baseTransport &&
      typeof (baseTransport as { getUnderlyingSocket?: unknown }).getUnderlyingSocket === "function"
    ) {
      underlyingWs = (
        baseTransport as { getUnderlyingSocket: () => unknown }
      ).getUnderlyingSocket();
    }

    if (underlyingWs && typeof diagnostics_channel !== "undefined") {
      try {
        const pingChannel = diagnostics_channel.channel("undici:websocket:ping");
        const pongChannel = diagnostics_channel.channel("undici:websocket:pong");

        const onPing = (msg: unknown) => {
          if (
            msg &&
            typeof msg === "object" &&
            (msg as { websocket?: unknown }).websocket === underlyingWs
          ) {
            transportDiagnostics.serverPingsReceivedCount++;
            transportDiagnostics.lastServerPingReceivedAtMs = clock();
          }
        };

        const onPong = (msg: unknown) => {
          if (
            msg &&
            typeof msg === "object" &&
            (msg as { websocket?: unknown }).websocket === underlyingWs
          ) {
            transportDiagnostics.serverPongsReceivedCount++;
            transportDiagnostics.lastServerPongReceivedAtMs = clock();
          }
        };

        pingChannel.subscribe(onPing);
        pongChannel.subscribe(onPong);

        cleanupDiagnosticsChannel = () => {
          try {
            pingChannel.unsubscribe(onPing);
          } catch {
            // ignore
          }
          try {
            pongChannel.unsubscribe(onPong);
          } catch {
            // ignore
          }
        };
      } catch {
        // ignore diagnostics channel errors
      }
    }

    meteredTransport = new MeteredWebSocketTransport(
      baseTransport,
      maxPayloadBytes,
      (count, bytes, _byteLen, _data, isOversized) => {
        if (isOversized && probeActive) {
          terminateProbe("PAYLOAD_LIMIT_REACHED", "Application payload byte budget reached");
        }
        if (count >= maxMessages && probeActive) {
          terminateProbe("MESSAGE_LIMIT_REACHED", "Inbound message budget reached");
        }
      },
    );

    coordinator = new RaydiumCandidateSubscriptionCoordinator({
      poolContext,
      adapter,
      tracker,
      transport: meteredTransport,
      commitment,
      clock,
      maxNotificationsBudget: maxMessages,
      allowSyntheticCompletenessProofs: false, // Invariant: production completeness unproven
    });

    meteredTransport.on("open", () => {
      if (transportDiagnostics.connectedAtMs === null) {
        const now = clock();
        transportDiagnostics.connectedAtMs = now;
        transportDiagnostics.connectDurationMs = now - startTime;
        transportDiagnostics.subscriptionStatus = "PENDING";
        transportDiagnostics.subscriptionSentAtMs = now;
      }
    });

    meteredTransport.on("message", (data: string | Buffer) => {
      transportDiagnostics.lastMessageReceivedAtMs = clock();
      try {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const parsed = JSON.parse(text) as { id?: unknown; result?: unknown; error?: unknown };
        if (parsed && typeof parsed === "object") {
          const reqId = coordinator?.getCoverageDiagnostic().activeSubscriptionId ?? 1;
          if (parsed.id === 1 || parsed.id === reqId) {
            if (typeof parsed.result === "number") {
              transportDiagnostics.subscriptionAcknowledgedAtMs = clock();
              transportDiagnostics.subscriptionId = parsed.result;
              transportDiagnostics.subscriptionStatus = "ACKNOWLEDGED";
            } else if (parsed.error !== undefined && parsed.error !== null) {
              transportDiagnostics.subscriptionStatus = "REJECTED";
              const sanitizedErrorObj = deepRedactSensitiveObject(parsed.error);
              const errStr =
                typeof sanitizedErrorObj === "object"
                  ? JSON.stringify(sanitizedErrorObj)
                  : String(sanitizedErrorObj);
              transportDiagnostics.subscriptionError = redactSensitiveText(errStr);
            }
          }
        }
      } catch {
        // ignore JSON parse error in message interceptor
      }
    });

    meteredTransport.on("close", (code, reason) => {
      // 1. Always record the observed close code and reason if not yet recorded
      if (transportDiagnostics.closeCode === null) {
        transportDiagnostics.closeCode = code;
        transportDiagnostics.closeReason = reason ? redactSensitiveText(reason) : null;
      }

      // 2. Classify close origin
      if (transportDiagnostics.firstErrorMessage !== null) {
        // An upstream transport error preceded this close event (e.g. Undici TypeError followed by close 1006)
        transportDiagnostics.isUpstreamClosure = true;
        transportDiagnostics.observedCloseOrigin = "UPSTREAM";
      } else if (transportDiagnostics.localCloseCode === null) {
        // A genuine upstream close event occurred before any local shutdown request
        transportDiagnostics.isUpstreamClosure = true;
        transportDiagnostics.observedCloseOrigin = "UPSTREAM";
        if (!isProbeTerminated && probeActive) {
          terminateProbe("TRANSPORT_DISCONNECT", `WebSocket closed: ${reason || code}`);
        }
      } else {
        // Local shutdown was requested before this close event
        if (code === 1000) {
          transportDiagnostics.isUpstreamClosure = false;
          transportDiagnostics.intentionalShutdownInitiated = true;
          transportDiagnostics.observedCloseOrigin = "INTENTIONAL_SHUTDOWN";
        } else {
          // Local shutdown requested 1000, but transport observed an abnormal close code (e.g. 1006)
          transportDiagnostics.observedCloseOrigin = "UNCERTAIN";
        }
      }
    });

    meteredTransport.on("error", (err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errCode = extractErrorCode(err);
      const errCause =
        err instanceof Error && "cause" in err && (err as { cause?: unknown }).cause
          ? formatErrorCauseChain((err as { cause?: unknown }).cause)
          : null;

      if (transportDiagnostics.firstErrorMessage === null) {
        transportDiagnostics.firstErrorMessage = redactSensitiveText(errMsg);
        transportDiagnostics.firstErrorCode = errCode;
        transportDiagnostics.firstErrorCause = errCause;
      }
      if (!isIntentionalClosure && !isProbeTerminated && probeActive) {
        transportDiagnostics.isUpstreamClosure = true;
        terminateProbe(
          "TRANSPORT_ERROR",
          `WebSocket error: ${transportDiagnostics.firstErrorMessage}`,
        );
      }
    });
  }

  // Intercept incoming notifications to record WS signatures and track queue depth
  const originalEnqueue = adapter.enqueueNotification.bind(adapter);
  adapter.enqueueNotification = (notif: InjectedTransactionNotification) => {
    if (!probeActive || isProbeTerminated) {
      return {
        ok: false,
        signature: notif.signature,
        queued: false,
        reason: "QUEUE_OVERFLOW",
      };
    }

    if (isValidSolanaSignature(notif.signature)) {
      if (!wsWitnessedSignatures.has(notif.signature)) {
        wsWitnessedSignatures.add(notif.signature);
        wsWitnessedList.push({
          signature: notif.signature,
          receivedEpochMs: notif.receivedAtMs ?? clock(),
          slot: notif.slot ?? 0,
        });
      }
    }

    const enqueueRes = originalEnqueue(notif);

    if (!enqueueRes.ok && enqueueRes.reason === "QUEUE_OVERFLOW") {
      queueLimitExceeded = true;
      queueRejectionsCount++;
      terminateProbe("QUEUE_LIMIT_EXCEEDED", "Queue overflow: max queue depth exceeded");
    } else if (enqueueRes.ok && enqueueRes.queued) {
      const activeWorkload = adapter.getActiveWorkload();
      if (activeWorkload > peakQueueDepth) {
        peakQueueDepth = activeWorkload;
      }
    }

    return enqueueRes;
  };

  // Overall Duration Timer
  const overallTimer = setTimeout(() => {
    terminateProbe("DURATION_EXPIRED", "Probe duration expired");
  }, durationMs);

  // Drain Queue Worker Loop
  let transactionRetrievalsReserved = 0;
  const drainWorker = async () => {
    while (!overallAbortController.signal.aborted) {
      const remainingMs = overallDeadlineEpoch - clock();
      if (remainingMs <= 0) {
        terminateProbe("DURATION_EXPIRED", "Probe duration expired");
        break;
      }

      if (transactionRetrievalsReserved >= maxTransactionRetrievals) {
        if (probeActive && !isProbeTerminated) {
          terminateProbe("TRANSACTION_LIMIT_REACHED", "Transaction retrieval ceiling reached");
        }
        break;
      }

      if (adapter.getPendingQueueLength() > 0) {
        if (transactionRetrievalsReserved >= maxTransactionRetrievals) {
          if (probeActive && !isProbeTerminated) {
            terminateProbe("TRANSACTION_LIMIT_REACHED", "Transaction retrieval ceiling reached");
          }
          break;
        }
        transactionRetrievalsReserved++;

        try {
          const timeoutForReq = Math.min(10_000, remainingMs);
          const processRes = await adapter.processNextPending(tracker, {
            signal: overallAbortController.signal,
            overallTimeoutMs: timeoutForReq,
          });
          if (processRes) {
            const isCancelled =
              !probeActive || isProbeTerminated || overallAbortController.signal.aborted;
            if (isCancelled) {
              // Discard late payload ingestion; retain cancellation audit record
              sampledTransactionAudits.push({
                signature: processRes.diagnostics.signature,
                httpAttempts: processRes.diagnostics.httpAttempts,
                httpStatus: processRes.diagnostics.httpStatus ?? null,
                durationMs: processRes.diagnostics.durationMs,
                outcome: "REQUEST_TIMEOUT",
                decodedEventsCount: 0,
                ingestedCount: 0,
                endpointUrl: processRes.diagnostics.endpointUrl,
                requestSentAtMs: processRes.diagnostics.requestSentAtMs,
                responseReceivedAtMs: null,
                responseSha256: null,
                isCompletePayload: false,
                error: "Operation cancelled before attempt finalization",
              });
            } else {
              sampledTransactionAudits.push(processRes.diagnostics);
              if (processRes.ok && processRes.outcome === "SUCCESS") {
                transactionRetrievalsSucceeded++;
                decodedSwapsCount += processRes.diagnostics.ingestedCount ?? 1;
              }
            }
          }
        } catch {
          // Handled fail-closed inside adapter
        }

        if (transactionRetrievalsReserved >= maxTransactionRetrievals) {
          if (probeActive && !isProbeTerminated) {
            terminateProbe("TRANSACTION_LIMIT_REACHED", "Transaction retrieval ceiling reached");
          }
          break;
        }
      } else {
        if (!isStreamingActive || !probeActive || isProbeTerminated) {
          // Streaming has ended and queue is drained
          break;
        }
        try {
          await sleepFn(25, overallAbortController.signal);
        } catch {
          break;
        }
      }
    }
  };

  const drainWorkerPromise = drainWorker();

  // Allocate streaming duration within overall maximum
  const reconciliationReservationMs = Math.min(10_000, Math.floor(durationMs * 0.2));
  const streamingDurationMs =
    config.streamingDurationMs ?? Math.max(1, durationMs - reconciliationReservationMs);

  let streamingTimer: ReturnType<typeof setTimeout> | undefined;
  const streamingPhasePromise = new Promise<void>((resolve) => {
    streamingTimer = setTimeout(() => {
      resolve();
    }, streamingDurationMs);
    overallAbortController.signal.addEventListener("abort", () => resolve(), { once: true });
  });

  // Race streaming phase against drain worker
  await Promise.race([streamingPhasePromise, drainWorkerPromise]);

  if (streamingTimer) clearTimeout(streamingTimer);

  // End streaming observation phase
  isStreamingActive = false;

  // Close streaming coordinator if probe not already terminated by limit
  if (!isProbeTerminated && probeActive) {
    isIntentionalClosure = true;
    transportDiagnostics.intentionalShutdownInitiated = true;
    transportDiagnostics.localCloseCode = 1000;
    transportDiagnostics.localCloseReason = "Streaming phase complete; proceeding to discovery";
    coordinator?.close();
    meteredTransport?.close(1000, "Streaming phase complete; proceeding to discovery");
  }

  // Settle any remaining queued transaction retrieval work within deadline
  await drainWorkerPromise;

  // 9. Bounded History Discovery Phase (Strictly within overall deadline)
  let historyQueriesAttempted = 0;
  let historyRecordsDiscovered = 0;
  let historyDiscoveryOutcome: HistoryEnumerationOutcome | string = "NOT_ATTEMPTED";
  let historyDiscoveryDurationMs: number | null = null;
  let anchorWitnessed = false;
  let anchorSignature: string | null = null;
  let anchorSlot: number | null = null;
  let anchorBlockTime: number | null = null;
  const historyWitnessedList: { signature: string; slot: number; blockTime: number | null }[] = [];
  const historyWitnessedSignatures = new Set<string>();
  const fetchedHistoryRecords = new Map<string, HistorySignatureRecord>();

  const remainingForDiscovery = overallDeadlineEpoch - clock();
  const canRunDiscovery =
    remainingForDiscovery > 10 &&
    !overallAbortController.signal.aborted &&
    probeState.terminationReason !== "TRANSPORT_ERROR" &&
    probeState.terminationReason !== "TRANSPORT_DISCONNECT" &&
    probeState.terminationReason !== "DURATION_EXPIRED" &&
    probeState.terminationReason !== "QUEUE_LIMIT_EXCEEDED" &&
    wsWitnessedList.length > 0;

  if (canRunDiscovery) {
    anchorSignature = wsWitnessedList[0]!.signature;
    anchorSlot = wsWitnessedList[0]!.slot;
    const discoveryStartTime = clock();

    const pageFetcher: HistoryPageFetcher = {
      fetchPage: async (
        params: HistoryPageQueryParams,
      ): Promise<readonly HistorySignatureRecord[]> => {
        if (historyQueriesAttempted >= maxHistoryQueries) {
          throw new Error(`[PROBE_CEILING] Max history queries (${maxHistoryQueries}) reached`);
        }
        historyQueriesAttempted++;

        if (config.historyPageFetcher) {
          const reqSent = clock();
          let recordsDiscovered = 0;
          let auditError: string | undefined;
          try {
            const records = await config.historyPageFetcher.fetchPage(params);
            recordsDiscovered = records.length;
            for (const r of records) {
              fetchedHistoryRecords.set(r.signature, r);
            }
            return records;
          } catch (err: unknown) {
            auditError = err instanceof Error ? err.message : String(err);
            throw err;
          } finally {
            const reqEnd = clock();
            historyQueryAudits.push({
              pageIndex: historyQueriesAttempted,
              address: params.address,
              limit: params.limit,
              ...(params.before ? { before: params.before } : {}),
              requestSentAtMs: reqSent,
              headersReceivedAtMs: reqEnd,
              responseReceivedAtMs: reqEnd,
              durationMs: reqEnd - reqSent,
              httpStatus: auditError ? null : 200,
              responseSha256: null,
              recordsDiscovered,
              ...(auditError ? { error: auditError } : {}),
            });
          }
        }

        const reqSent = clock();
        let headersReceivedAtMs: number | undefined;
        let responseReceivedAtMs: number | null = null;
        let httpStatus: number | null = null;
        let responseSha256: string | null = null;
        let recordsDiscovered = 0;
        let auditError: string | undefined;

        try {
          const body = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getSignaturesForAddress",
            params: [
              params.address,
              {
                limit: params.limit,
                before: params.before,
                commitment: "confirmed",
              },
            ],
          });

          const resp = await boundedFetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            ...(params.signal ? { signal: params.signal } : {}),
          });

          headersReceivedAtMs = clock();
          httpStatus = resp.status;

          if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
          }

          const rawText = await resp.text();
          responseReceivedAtMs = clock();
          responseSha256 = computeSha256(rawText);

          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rawText);
          } catch {
            throw new Error("MALFORMED_JSON_RPC: Response is not valid JSON");
          }

          if (!parsedJson || typeof parsedJson !== "object") {
            throw new Error("MALFORMED_JSON_RPC: Response is not a JSON object");
          }

          const rpcObj = parsedJson as {
            jsonrpc?: unknown;
            error?: { code?: unknown; message?: unknown };
            result?: unknown;
          };

          if (rpcObj.error) {
            const msg =
              typeof rpcObj.error === "object" ? rpcObj.error.message : String(rpcObj.error);
            throw new Error(`JSON_RPC_ERROR: ${String(msg)}`);
          }

          if (!Array.isArray(rpcObj.result)) {
            throw new Error(
              "MALFORMED_JSON_RPC: Expected array result for getSignaturesForAddress",
            );
          }

          const records = rpcObj.result as HistorySignatureRecord[];
          recordsDiscovered = records.length;
          for (const r of records) {
            fetchedHistoryRecords.set(r.signature, r);
          }

          return records;
        } catch (err: unknown) {
          auditError = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          const durationEnd = responseReceivedAtMs ?? headersReceivedAtMs ?? clock();
          historyQueryAudits.push({
            pageIndex: historyQueriesAttempted,
            address: params.address,
            limit: params.limit,
            ...(params.before ? { before: params.before } : {}),
            requestSentAtMs: reqSent,
            ...(headersReceivedAtMs !== undefined ? { headersReceivedAtMs } : {}),
            responseReceivedAtMs,
            durationMs: durationEnd - reqSent,
            httpStatus,
            responseSha256,
            recordsDiscovered,
            ...(auditError ? { error: auditError } : {}),
          });
        }
      },
    };

    const enumerator = new ExactPoolHistoryEnumerator({
      poolContext,
      knownAnchorSignature: anchorSignature,
      pageFetcher,
      budgetManager: budget,
      pageSize: 20,
      maxPages: maxHistoryQueries,
      operationDeadlineMs: Math.max(1, remainingForDiscovery),
      signal: overallAbortController.signal,
      sleepFn,
      clock,
    });

    try {
      const enumRes = await enumerator.enumerate();
      historyDiscoveryDurationMs = clock() - discoveryStartTime;
      historyDiscoveryOutcome = enumRes.error
        ? `${enumRes.outcome}: ${enumRes.error}`
        : enumRes.outcome;
      anchorWitnessed = enumRes.anchorWitnessed;
      historyRecordsDiscovered = enumRes.discoveredSignatures.length;

      for (const rec of enumRes.discoveredSignatures) {
        if (rec.blockTime === null) {
          nullBlockTimeCount++;
        }
        if (!historyWitnessedSignatures.has(rec.signature)) {
          historyWitnessedSignatures.add(rec.signature);
          historyWitnessedList.push({
            signature: rec.signature,
            slot: rec.slot,
            blockTime: rec.blockTime,
          });
        }
      }

      // If anchor was witnessed, preserve its real observed slot and blockTime
      if (enumRes.anchorWitnessed && anchorSignature) {
        const anchorRec = fetchedHistoryRecords.get(anchorSignature);
        if (anchorRec) {
          anchorSlot = anchorRec.slot;
          anchorBlockTime = anchorRec.blockTime;
        }
        if (!historyWitnessedSignatures.has(anchorSignature)) {
          historyWitnessedSignatures.add(anchorSignature);
          historyWitnessedList.push({
            signature: anchorSignature,
            slot: anchorSlot ?? wsWitnessedList[0]!.slot,
            blockTime: anchorBlockTime,
          });
        }
      }
    } catch (err: unknown) {
      historyDiscoveryDurationMs = clock() - discoveryStartTime;
      historyDiscoveryOutcome = `FETCH_ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    if (clock() >= overallDeadlineEpoch) {
      historyDiscoveryOutcome = "OPERATION_DEADLINE_EXCEEDED";
    } else if (overallAbortController.signal.aborted) {
      historyDiscoveryOutcome = "OPERATION_CANCELLED";
    }
  }

  // Ensure Probe Termination and Settle Workers
  terminateProbe(
    probeState.terminationReason === "UNKNOWN"
      ? clock() >= overallDeadlineEpoch
        ? "DURATION_EXPIRED"
        : "COMPLETED"
      : probeState.terminationReason,
  );
  clearTimeout(overallTimer);
  await drainWorkerPromise;

  // 10. Accurate Accounting & Outcome Classification
  const finalTerminationReason = probeState.terminationReason;
  const isCapTerminated =
    finalTerminationReason === "MESSAGE_LIMIT_REACHED" ||
    finalTerminationReason === "PAYLOAD_LIMIT_REACHED" ||
    finalTerminationReason === "HTTP_BUDGET_EXHAUSTED" ||
    finalTerminationReason === "TRANSACTION_LIMIT_REACHED";

  const isObservationSuccess =
    finalTerminationReason !== "TRANSPORT_ERROR" &&
    finalTerminationReason !== "TRANSPORT_DISCONNECT" &&
    finalTerminationReason !== "QUEUE_LIMIT_EXCEEDED" &&
    finalTerminationReason !== "MANUAL_CANCEL";

  let finalStatus: TransportProbeStatus;
  if (
    finalTerminationReason === "TRANSPORT_ERROR" ||
    finalTerminationReason === "TRANSPORT_DISCONNECT" ||
    finalTerminationReason === "MANUAL_CANCEL"
  ) {
    finalStatus = "TRANSPORT_ERROR";
  } else if (finalTerminationReason === "QUEUE_LIMIT_EXCEEDED") {
    finalStatus = "QUEUE_OVERFLOW";
  } else if (isCapTerminated) {
    finalStatus = "CAP_LIMITED";
  } else {
    finalStatus = "SUCCESS";
  }

  // Overshoot Bytes: calculated independently of winning termination reason
  const totalPayloadBytes = meteredTransport?.getApplicationPayloadBytes() ?? 0;
  const overshootBytes = Math.max(0, totalPayloadBytes - maxPayloadBytes);

  // Transaction attempt counts derived from actual dispatched diagnostics
  const transactionRetrievalsAttempted = adapter.getMetrics().totalDispatchedAttempts;

  // Reconcile sampledTransactionAudits with totalDispatchedAttempts
  while (sampledTransactionAudits.length < transactionRetrievalsAttempted) {
    const missingIndex = sampledTransactionAudits.length;
    sampledTransactionAudits.push({
      signature: `dispatched-attempt-${missingIndex + 1}`,
      httpAttempts: 1,
      httpStatus: null,
      durationMs: 0,
      outcome: "REQUEST_TIMEOUT",
      decodedEventsCount: 0,
      ingestedCount: 0,
      endpointUrl: rpcUrl,
      requestSentAtMs: startTime,
      responseReceivedAtMs: null,
      responseSha256: null,
      isCompletePayload: false,
      error: "Dispatched attempt cancelled or timed out in flight",
    });
  }

  // Discrepancy Analysis (Explicitly bounded to witnessed data)
  const commonSignatures = wsWitnessedList
    .map((r) => r.signature)
    .filter((sig) => historyWitnessedSignatures.has(sig));
  const wsOnlySignatures = wsWitnessedList
    .map((r) => r.signature)
    .filter((sig) => !historyWitnessedSignatures.has(sig));
  const historyOnlySignatures = historyWitnessedList
    .map((r) => r.signature)
    .filter((sig) => !wsWitnessedSignatures.has(sig));

  const unretrievedSampleSignaturesCount = Math.max(
    0,
    wsWitnessedList.length - transactionRetrievalsAttempted,
  );

  const comparisonNotice =
    "Discrepancies represent differences between signatures actually witnessed through the single live WebSocket stream and up to 2 bounded history RPC pages. Signatures observed by WebSocket but not retrieved in the 5 sampled transactions are unretrieved sample signatures, not lost transactions. This does NOT represent a true total network notification-loss percentage.";

  const endTime = clock();
  const endTimeIso = new Date(endTime).toISOString();
  const actualDurationMs = endTime - startTime;

  if (coordinator) {
    const diag = coordinator.getCoverageDiagnostic();
    if (diag.activeSubscriptionId !== null && transportDiagnostics.subscriptionId === null) {
      transportDiagnostics.subscriptionId = diag.activeSubscriptionId;
      transportDiagnostics.subscriptionStatus = "ACKNOWLEDGED";
    }
  }

  const frozenTransportDiagnostics: TransportDiagnostics = Object.freeze({
    ...transportDiagnostics,
  });

  // 11. Construct Metadata & Summary Evidence Artifacts
  const metadata: TransportProbeMetadata = Object.freeze({
    probeVersion: "1.0",
    poolId: poolContext.poolId,
    candidateTokenMint: poolContext.candidateTokenMint,
    quoteTokenMint: poolContext.quoteTokenMint,
    wsUrl,
    rpcUrl,
    commitment: "confirmed",
    startTimeIso,
    endTimeIso,
    durationMs: actualDurationMs,
    terminationReason: finalTerminationReason,
    isCapTerminated,
    counts: {
      inboundMessagesCount: meteredTransport?.getMessageCount() ?? 0,
      applicationPayloadBytes: totalPayloadBytes,
      overshootBytes,
      peakQueueDepth,
      queueRejectionsCount,
      decodedSwapsCount,
      transactionRetrievalsAttempted,
      transactionRetrievalsSucceeded,
      historyQueriesAttempted,
      historySignaturesDiscovered: historyRecordsDiscovered,
      nullBlockTimeCount,
    },
    budgetStatus: budget.getStats(),
    isProductionCompletenessEstablished: false as const,
    gate11Status: "UNAFFECTED_FAIL_CLOSED" as const,
    virtualWalletBalanceSol: FROZEN_VIRTUAL_WALLET_SOL as "7.9259 SOL",
    spendingCeiling: "$0.00" as const,
    disclaimer:
      "Transport characterization evidence only. Production rolling-flow completeness remains unverified and unavailable.",
    transportDiagnostics: frozenTransportDiagnostics,
  });

  const flowEval = tracker.evaluateWindow(endTime);

  const summary: TransportProbeSummary = Object.freeze({
    poolId: poolContext.poolId,
    candidateTokenMint: poolContext.candidateTokenMint,
    status: finalStatus,
    observationSuccess: isObservationSuccess,
    terminationReason: finalTerminationReason,
    durationMs: actualDurationMs,
    timing: {
      startTimeIso,
      endTimeIso,
      localDurationMs: actualDurationMs,
    },
    queueTelemetry: {
      peakQueueDepth,
      queueLimit: maxQueueDepth,
      queueLimitExceeded,
      queueRejectionsCount,
      pendingAtShutdown: adapter.getPendingQueueLength(),
    },
    streamingTelemetry: {
      inboundMessagesCount: meteredTransport?.getMessageCount() ?? 0,
      maxMessagesCeiling: maxMessages,
      applicationPayloadBytes: totalPayloadBytes,
      maxPayloadBytesCeiling: maxPayloadBytes,
      overshootBytes,
      coordinatorMetrics: coordinator?.getMetrics() ?? {
        totalNotificationsReceived: 0,
        totalNotificationsRouted: 0,
        totalDuplicatesSkipped: 0,
        totalQueueOverflows: 0,
        totalUnrelatedDropped: 0,
        totalMalformedFramesDropped: 0,
        totalStaleEpochMessagesDropped: 0,
        totalDisconnectGapsRecorded: 0,
        totalCoverageAdvancesAttempted: 0,
        totalCoverageAdvancesSucceeded: 0,
        totalCoverageAdvancesRejected: 0,
      },
    },
    tradeFlowTelemetry: {
      decodedSwapsCount,
      recentBuys: flowEval.recentBuys60s,
      recentSells: flowEval.recentSells60s,
      flowCoverageStatus: flowEval.coverage,
      isProductionCompletenessEstablished: false as const,
    },
    reconciliationTelemetry: {
      anchorWitnessed,
      anchorSignature,
      anchorSlot,
      anchorBlockTime,
      historyQueriesAttempted,
      historyQueriesLimit: maxHistoryQueries,
      historyRecordsDiscovered,
      enumeratorOutcome: historyDiscoveryOutcome,
      discoveryDurationMs: historyDiscoveryDurationMs,
    },
    historyDiscoveryTelemetry: {
      anchorWitnessed,
      anchorSignature,
      anchorSlot,
      anchorBlockTime,
      historyQueriesAttempted,
      historyQueriesLimit: maxHistoryQueries,
      historyRecordsDiscovered,
      discoveryOutcome: historyDiscoveryOutcome,
      discoveryDurationMs: historyDiscoveryDurationMs,
    },
    discrepancyAnalysis: {
      totalWsWitnessedSignatures: wsWitnessedList.length,
      totalHistoryWitnessedSignatures: historyWitnessedList.length,
      commonSignaturesCount: commonSignatures.length,
      wsOnlySignaturesCount: wsOnlySignatures.length,
      historyOnlySignaturesCount: historyOnlySignatures.length,
      unretrievedSampleSignaturesCount,
      comparisonLimitsNotice: comparisonNotice,
    },
    budgetAccounting: {
      totalHttpRequests: budget.getStats().totalRequests,
      maxHttpAttemptsLimit: MAX_TOTAL_HTTP_ATTEMPTS,
      enrichmentAttempts: budget.getStats().enrichmentRequests,
      forwardReservationPreserved: true,
      minProviderSpacingEnforcedMs: PROBE_MIN_PROVIDER_SPACING_MS,
    },
    sampledTransactionAudits,
    historyQueryAudits,
    transportDiagnostics: frozenTransportDiagnostics,
  });

  const witnessedEvidence: WitnessedSignaturesEvidence = Object.freeze({
    poolId: poolContext.poolId,
    timestampIso: endTimeIso,
    wsWitnessed: wsWitnessedList,
    historyWitnessed: historyWitnessedList,
    discrepancies: {
      commonSignatures,
      wsOnlySignatures,
      historyOnlySignatures,
      unretrievedSampleSignaturesCount,
      comparisonLimitsNotice: comparisonNotice,
    },
  });

  // Freeze telemetry and audit arrays to prevent any post-finalization mutations
  Object.freeze(sampledTransactionAudits);
  for (const item of sampledTransactionAudits) {
    Object.freeze(item);
  }
  Object.freeze(historyQueryAudits);
  for (const item of historyQueryAudits) {
    Object.freeze(item);
  }
  Object.freeze(wsWitnessedList);
  Object.freeze(historyWitnessedList);

  // 12. Write and Seal Evidence Files
  fsSync.writeFileSync(
    path.join(targetDir, "capture-metadata.json"),
    serializeJsonSafe(metadata, 2),
    "utf8",
  );
  fsSync.writeFileSync(
    path.join(targetDir, "probe-summary.json"),
    serializeJsonSafe(summary, 2),
    "utf8",
  );
  fsSync.writeFileSync(
    path.join(targetDir, "witnessed-signatures.json"),
    serializeJsonSafe(witnessedEvidence, 2),
    "utf8",
  );
  fsSync.writeFileSync(
    path.join(targetDir, "sampled-transactions.json"),
    serializeJsonSafe(sampledTransactionAudits, 2),
    "utf8",
  );

  const manifest = sealCaptureManifest(
    targetDir,
    poolContext.poolId,
    poolContext.candidateTokenMint,
    endTimeIso,
  );

  removeCallerSignalListener?.();
  cleanupDiagnosticsChannel?.();

  return {
    success: isObservationSuccess,
    observationSuccess: isObservationSuccess,
    manifestSealed: true,
    dryRun: false,
    status: finalStatus,
    targetDir,
    poolId: poolContext.poolId,
    candidateTokenMint: poolContext.candidateTokenMint,
    metadata,
    summary,
    manifest,
  };
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

export interface TransportProbeCliArgs {
  readonly pool?: string | undefined;
  readonly isLive: boolean;
  readonly dryRun: boolean;
  readonly outDir?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly maxMessages?: number | undefined;
  readonly maxPayloadBytes?: number | undefined;
  readonly maxQueueDepth?: number | undefined;
  readonly maxHistoryQueries?: number | undefined;
  readonly maxTransactionRetrievals?: number | undefined;
  readonly help?: boolean | undefined;
}

export function parseTransportProbeArgs(argv: readonly string[]): TransportProbeCliArgs {
  let pool: string | undefined;
  let isLive = false;
  let dryRun = false;
  let outDir: string | undefined;
  let durationMs: number | undefined;
  let maxMessages: number | undefined;
  let maxPayloadBytes: number | undefined;
  let maxQueueDepth: number | undefined;
  let maxHistoryQueries: number | undefined;
  let maxTransactionRetrievals: number | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--live") {
      isLive = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--pool") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --pool");
      }
      pool = next.trim();
      if (pool !== DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId) {
        throw new Error(
          `Unsupported pool '${pool}'. This transport observation probe is strictly bound to the reference RAY/WSOL pool (${DEFAULT_REFERENCE_RAY_WSOL_POOL_CONTEXT.poolId}).`,
        );
      }
    } else if (arg === "--out-dir") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --out-dir");
      }
      outDir = next.trim();
    } else if (arg === "--duration-ms") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --duration-ms");
      }
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_ALLOWED_PROBE_DURATION_MS) {
        throw new Error(
          `--duration-ms must be an integer between 1 and ${MAX_ALLOWED_PROBE_DURATION_MS}`,
        );
      }
      durationMs = parsed;
    } else if (arg === "--max-messages") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --max-messages");
      }
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_INBOUND_MESSAGES_BUDGET) {
        throw new Error(
          `--max-messages must be an integer between 1 and ${MAX_INBOUND_MESSAGES_BUDGET}`,
        );
      }
      maxMessages = parsed;
    } else if (arg === "--max-bytes") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --max-bytes");
      }
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_APPLICATION_PAYLOAD_BYTES) {
        throw new Error(
          `--max-bytes must be an integer between 1 and ${MAX_APPLICATION_PAYLOAD_BYTES}`,
        );
      }
      maxPayloadBytes = parsed;
    } else if (arg === "--max-queue-depth") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --max-queue-depth");
      }
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_QUEUE_DEPTH_LIMIT) {
        throw new Error(
          `--max-queue-depth must be an integer between 1 and ${MAX_QUEUE_DEPTH_LIMIT}`,
        );
      }
      maxQueueDepth = parsed;
    } else if (arg === "--max-history-queries") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --max-history-queries");
      }
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_HISTORY_QUERIES_LIMIT) {
        throw new Error(
          `--max-history-queries must be an integer between 1 and ${MAX_HISTORY_QUERIES_LIMIT}`,
        );
      }
      maxHistoryQueries = parsed;
    } else if (arg === "--max-tx-retrievals") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --max-tx-retrievals");
      }
      const parsed = Number(next);
      if (
        !Number.isSafeInteger(parsed) ||
        parsed <= 0 ||
        parsed > MAX_TRANSACTION_RETRIEVALS_LIMIT
      ) {
        throw new Error(
          `--max-tx-retrievals must be an integer between 1 and ${MAX_TRANSACTION_RETRIEVALS_LIMIT}`,
        );
      }
      maxTransactionRetrievals = parsed;
    } else {
      throw new Error(`Unrecognized argument: '${arg}'`);
    }
  }

  return {
    pool,
    isLive: isLive && !dryRun,
    dryRun: dryRun || !isLive,
    outDir,
    durationMs,
    maxMessages,
    maxPayloadBytes,
    maxQueueDepth,
    maxHistoryQueries,
    maxTransactionRetrievals,
    help,
  };
}
