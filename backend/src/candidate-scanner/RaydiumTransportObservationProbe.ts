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
}

export interface HistoryQueryAuditRecord {
  readonly pageIndex: number;
  readonly address: string;
  readonly limit: number;
  readonly before?: string | undefined;
  readonly requestSentAtMs: number;
  readonly responseReceivedAtMs: number;
  readonly durationMs: number;
  readonly httpStatus: number;
  readonly responseSha256: string;
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
 * Reads bytes from a ReadableStream up to maxBytes.
 * Cancels reader immediately and returns overflow if limit is exceeded.
 */
export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; totalObservedBytes: number; overflow: boolean }> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let totalObservedBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel(signal.reason);
        const err = new Error("Operation aborted");
        err.name = "AbortError";
        throw err;
      }

      const { done, value } = await reader.read();
      if (done) break;

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
          await reader.cancel(new Error("RESPONSE_TOO_LARGE"));
          return {
            bytes: Buffer.concat(chunks),
            totalObservedBytes,
            overflow: true,
          };
        }
      }
    }
  } catch (err) {
    try {
      await reader.cancel(err);
    } catch {
      // ignore
    }
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

    const resp = await underlyingFetch(input, boundedInit);

    // 2. Reject redirect status
    if (resp.type === "opaqueredirect" || (resp.status >= 300 && resp.status < 400)) {
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
    if (event === "message") {
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

        // Do not continue parsing or queueing oversized messages
        if (!isOversized) {
          listener(data);
        }
      });
    } else if (event === "open") {
      this.inner.on("open", listener);
    } else if (event === "error") {
      this.inner.on("error", listener);
    } else if (event === "close") {
      this.inner.on("close", listener);
    }
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

  const probeState = {
    terminationReason: "UNKNOWN" as TransportProbeTerminationReason,
  };

  const terminateProbe = (reason: TransportProbeTerminationReason, closeMsg?: string): void => {
    if (isProbeTerminated) return;
    isProbeTerminated = true;
    probeActive = false;
    isIntentionalClosure = true;
    if (probeState.terminationReason === "UNKNOWN") {
      probeState.terminationReason = reason;
    }
    overallAbortController.abort(new Error(closeMsg ?? reason));
    try {
      meteredTransport.close(1000, closeMsg ?? reason);
    } catch {
      // ignore
    }
    try {
      coordinator.close();
    } catch {
      // ignore
    }
  };

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
  const baseTransport: ISolanaWebSocketTransport =
    config.transport ?? new NativeWebSocketTransport(wsUrl);

  // Metered WebSocket Wrapper
  const meteredTransport = new MeteredWebSocketTransport(
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

  // Subscription Coordinator
  const coordinator = new RaydiumCandidateSubscriptionCoordinator({
    poolContext,
    adapter,
    tracker,
    transport: meteredTransport,
    commitment,
    clock,
    maxNotificationsBudget: maxMessages,
    allowSyntheticCompletenessProofs: false, // Invariant: production completeness unproven
  });

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

  // Socket Close and Error Listeners
  meteredTransport.on("close", (code, reason) => {
    if (!isIntentionalClosure && !isProbeTerminated && probeActive) {
      terminateProbe("TRANSPORT_DISCONNECT", `WebSocket closed: ${reason || code}`);
    }
  });

  meteredTransport.on("error", (err) => {
    if (!isIntentionalClosure && !isProbeTerminated && probeActive) {
      terminateProbe("TRANSPORT_ERROR", `WebSocket error: ${err.message}`);
    }
  });

  // Overall Duration Timer
  const overallTimer = setTimeout(() => {
    terminateProbe("DURATION_EXPIRED", "Probe duration expired");
  }, durationMs);

  // Drain Queue Worker Loop
  const drainWorker = async () => {
    while (!overallAbortController.signal.aborted) {
      const remainingMs = overallDeadlineEpoch - clock();
      if (remainingMs <= 0) {
        terminateProbe("DURATION_EXPIRED", "Probe duration expired");
        break;
      }

      if (adapter.getMetrics().totalDispatchedAttempts >= maxTransactionRetrievals) {
        break;
      }

      if (adapter.getPendingQueueLength() > 0) {
        try {
          const timeoutForReq = Math.min(10_000, remainingMs);
          const processRes = await adapter.processNextPending(tracker, {
            signal: overallAbortController.signal,
            overallTimeoutMs: timeoutForReq,
          });
          if (processRes) {
            sampledTransactionAudits.push(processRes.diagnostics);
            if (processRes.ok && processRes.outcome === "SUCCESS") {
              transactionRetrievalsSucceeded++;
              decodedSwapsCount += processRes.diagnostics.ingestedCount ?? 1;
            }
          }
        } catch {
          // Handled fail-closed inside adapter
        }
      } else {
        if (!isStreamingActive || !probeActive) {
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
  await Promise.race([streamingPhasePromise, drainWorker()]);

  if (streamingTimer) clearTimeout(streamingTimer);

  // End streaming observation phase
  isStreamingActive = false;

  // Close streaming coordinator if probe not already terminated by limit
  if (!isProbeTerminated && probeActive) {
    isIntentionalClosure = true;
    coordinator.close();
    meteredTransport.close(1000, "Streaming phase complete; proceeding to discovery");
  }

  // Settle any remaining queued transaction retrieval work within deadline
  await drainWorker();

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
          const records = await config.historyPageFetcher.fetchPage(params);
          for (const r of records) {
            fetchedHistoryRecords.set(r.signature, r);
          }
          return records;
        }

        const reqSent = clock();
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

        const reqReceived = clock();
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        const rawText = await resp.text();
        const responseSha256 = computeSha256(rawText);

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
          throw new Error("MALFORMED_JSON_RPC: Expected array result for getSignaturesForAddress");
        }

        const records = rpcObj.result as HistorySignatureRecord[];
        for (const r of records) {
          fetchedHistoryRecords.set(r.signature, r);
        }

        historyQueryAudits.push({
          pageIndex: historyQueriesAttempted,
          address: params.address,
          limit: params.limit,
          before: params.before,
          requestSentAtMs: reqSent,
          responseReceivedAtMs: reqReceived,
          durationMs: reqReceived - reqSent,
          httpStatus: resp.status,
          responseSha256,
          recordsDiscovered: records.length,
        });

        return records;
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
    probeState.terminationReason === "UNKNOWN" ? "DURATION_EXPIRED" : probeState.terminationReason,
  );
  clearTimeout(overallTimer);
  await Promise.allSettled([drainWorker()]);

  // 10. Accurate Accounting & Outcome Classification
  const finalTerminationReason = probeState.terminationReason;
  const isCapTerminated =
    finalTerminationReason === "MESSAGE_LIMIT_REACHED" ||
    finalTerminationReason === "PAYLOAD_LIMIT_REACHED" ||
    finalTerminationReason === "HTTP_BUDGET_EXHAUSTED";

  const isObservationSuccess =
    finalTerminationReason !== "TRANSPORT_ERROR" &&
    finalTerminationReason !== "TRANSPORT_DISCONNECT" &&
    finalTerminationReason !== "QUEUE_LIMIT_EXCEEDED";

  let finalStatus: TransportProbeStatus;
  if (
    finalTerminationReason === "TRANSPORT_ERROR" ||
    finalTerminationReason === "TRANSPORT_DISCONNECT"
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
  const totalPayloadBytes = meteredTransport.getApplicationPayloadBytes();
  const overshootBytes = Math.max(0, totalPayloadBytes - maxPayloadBytes);

  // Transaction attempt counts derived from actual dispatched diagnostics
  const transactionRetrievalsAttempted = adapter.getMetrics().totalDispatchedAttempts;

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
      inboundMessagesCount: meteredTransport.getMessageCount(),
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
      inboundMessagesCount: meteredTransport.getMessageCount(),
      maxMessagesCeiling: maxMessages,
      applicationPayloadBytes: totalPayloadBytes,
      maxPayloadBytesCeiling: maxPayloadBytes,
      overshootBytes,
      coordinatorMetrics: coordinator.getMetrics(),
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

  // 12. Write and Seal Evidence Files
  fsSync.writeFileSync(
    path.join(targetDir, "capture-metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );
  fsSync.writeFileSync(
    path.join(targetDir, "probe-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  fsSync.writeFileSync(
    path.join(targetDir, "witnessed-signatures.json"),
    JSON.stringify(witnessedEvidence, null, 2),
    "utf8",
  );

  const manifest = sealCaptureManifest(
    targetDir,
    poolContext.poolId,
    poolContext.candidateTokenMint,
    endTimeIso,
  );

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
