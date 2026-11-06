/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium Transport Observation Probe
 *
 * Standalone operator tool for empirical characterization of live Solana WebSocket
 * streaming and bounded RPC reconciliation on an authentic Raydium pool context.
 *
 * PURPOSE & INVARIANTS:
 * 1. Transport Characterization Only:
 *    Measures received notifications, application payload bytes, queue telemetry,
 *    transaction retrieval decoding, and bounded signature recovery between sources.
 *    Does NOT test production completeness and does NOT run a PAPER strategy session.
 * 2. Scope & Candidate Binding:
 *    Bound exclusively to one explicitly identified reference pool (default: Raydium RAY/WSOL)
 *    and validated candidate token mint.
 * 3. Connection & Pacing Bounds:
 *    - Exactly one public-provider WebSocket connection; zero reconnects, retries, redirects,
 *      or automated provider fallback.
 *    - Maximum 5 minutes (300,000 ms) runtime from connect attempt to shutdown.
 *    - Message ceiling: at most 500 inbound application messages.
 *    - Payload ceiling: at most 2 MiB (2,097,152 bytes) application payload threshold;
 *      discloses any threshold-crossing overshoot.
 *    - Queue ceiling: maximum 10 queued plus in-flight transaction jobs.
 *    - HTTP ceiling: maximum 7 HTTP attempts total (at most 2 history queries, 5 transaction retrievals).
 *    - Provider pacing: strictly retains >= 2,500 ms spacing via GlobalResourceBudgetManager.
 *    - Spending ceiling: strictly $0.00.
 * 4. Discrepancy & Coverage Invariants:
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
  readonly success: true;
  readonly dryRun: false;
  readonly status: "SUCCESS" | "CAP_LIMITED";
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
    readonly decodedSwapsCount: number;
    readonly transactionRetrievalsAttempted: number;
    readonly transactionRetrievalsSucceeded: number;
    readonly historyQueriesAttempted: number;
    readonly nullBlockTimeCount: number;
  };
  readonly budgetStatus: GlobalBudgetStats;
  readonly isProductionCompletenessEstablished: false;
  readonly gate11Status: "UNAFFECTED_FAIL_CLOSED";
  readonly virtualWalletBalanceSol: "7.9259 SOL";
  readonly spendingCeiling: "$0.00";
  readonly disclaimer: string;
}

export interface TransportProbeSummary {
  readonly poolId: string;
  readonly candidateTokenMint: string;
  readonly status: "SUCCESS" | "LIMIT_REACHED" | "TRANSPORT_ERROR";
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
    readonly historyQueriesAttempted: number;
    readonly historyQueriesLimit: number;
    readonly historyRecordsDiscovered: number;
    readonly enumeratorOutcome: HistoryEnumerationOutcome | string;
    readonly recoveryLatencyMs: number | null;
  };
  readonly discrepancyAnalysis: {
    readonly totalWsWitnessedSignatures: number;
    readonly totalHistoryWitnessedSignatures: number;
    readonly commonSignaturesCount: number;
    readonly wsOnlySignaturesCount: number;
    readonly historyOnlySignaturesCount: number;
    readonly comparisonLimitsNotice: string;
  };
  readonly budgetAccounting: {
    readonly totalHttpRequests: number;
    readonly maxHttpAttemptsLimit: number;
    readonly enrichmentAttempts: number;
    readonly forwardReservationPreserved: boolean;
    readonly minProviderSpacingEnforcedMs: number;
  };
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
    readonly comparisonLimitsNotice: string;
  };
}

// ============================================================================
// Metered WebSocket Transport Wrapper
// ============================================================================

export class MeteredWebSocketTransport implements ISolanaWebSocketTransport {
  private readonly inner: ISolanaWebSocketTransport;
  private messageCount = 0;
  private applicationPayloadBytes = 0;
  private readonly onMessageIntercept?:
    | ((count: number, bytes: number, byteLen: number, data: string | Buffer) => void)
    | undefined;

  constructor(
    inner: ISolanaWebSocketTransport,
    onMessageIntercept?:
      | ((count: number, bytes: number, byteLen: number, data: string | Buffer) => void)
      | undefined,
  ) {
    this.inner = inner;
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
        this.onMessageIntercept?.(this.messageCount, this.applicationPayloadBytes, byteLen, data);
        listener(data);
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

function computeSha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function sanitizeDestinationDirName(timestampIso: string, poolId: string): string {
  const safeTimestamp = timestampIso.replace(/:/g, "-");
  const safePoolId = poolId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeTimestamp}_${safePoolId}`;
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

  // 1. Validate Candidate Pool Context
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
  const maxHistoryQueries = config.maxHistoryQueries ?? MAX_HISTORY_QUERIES_LIMIT;
  const maxTransactionRetrievals =
    config.maxTransactionRetrievals ?? MAX_TRANSACTION_RETRIEVALS_LIMIT;

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

  // 4. Resolve Target Destination Directory
  const startTime = clock();
  const startTimeIso = new Date(startTime).toISOString();
  const defaultDir = path.join(
    resolveProjectRoot(),
    "data",
    "research",
    "captures",
    "transport-probe",
    sanitizeDestinationDirName(startTimeIso, poolContext.poolId),
  );
  const targetDir = config.outDir ? path.resolve(config.outDir) : defaultDir;

  // 5. DRY-RUN MODE: Zero network execution
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

  // 6. LIVE EXECUTION MODE: Pre-dispatch Atomic Directory Reservation
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

  // 7. Initialize Components
  const tracker = new RollingTradeFlowTracker({
    poolId: poolContext.poolId,
    tokenMint: poolContext.candidateTokenMint,
    clock,
  });

  let transactionRetrievalsAttempted = 0;
  let transactionRetrievalsSucceeded = 0;
  let nullBlockTimeCount = 0;
  let decodedSwapsCount = 0;

  // Create or adapt injected fetch transport for getTransaction
  const customFetch =
    config.fetchTransport ??
    (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return globalThis.fetch(input, init);
    });

  // Adapter wraps HTTP getTransaction with pacing and budget accounting
  const adapter = new RaydiumAmmV4TransactionSourceAdapter({
    poolContext,
    rpcUrl,
    budgetManager: budget,
    transport: customFetch,
    pacingMs: PROBE_MIN_PROVIDER_SPACING_MS,
    maxPendingQueueSize: maxQueueDepth,
    commitment: "confirmed",
    tracker,
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
  const probeState = {
    terminationReason: "UNKNOWN" as TransportProbeTerminationReason,
  };
  let overshootBytes = 0;
  let probeActive = true;

  // Set up Underlying WebSocket Transport
  const baseTransport: ISolanaWebSocketTransport =
    config.transport ?? new NativeWebSocketTransport(wsUrl);

  // Metered WebSocket Wrapper
  const meteredTransport = new MeteredWebSocketTransport(baseTransport, (count, bytes) => {
    // Check message count ceiling
    if (count >= maxMessages && probeActive) {
      probeActive = false;
      probeState.terminationReason = "MESSAGE_LIMIT_REACHED";
      meteredTransport.close(1000, "Inbound message budget reached");
    }
    // Check payload bytes ceiling
    if (bytes >= maxPayloadBytes && probeActive) {
      probeActive = false;
      probeState.terminationReason = "PAYLOAD_LIMIT_REACHED";
      overshootBytes = Math.max(0, bytes - maxPayloadBytes);
      meteredTransport.close(1000, "Application payload byte budget reached");
    }
  });

  // Set up Subscription Coordinator
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

    const currentWorkload = adapter.getActiveWorkload();
    if (currentWorkload > peakQueueDepth) {
      peakQueueDepth = currentWorkload;
    }
    if (currentWorkload > maxQueueDepth) {
      queueLimitExceeded = true;
    }

    return originalEnqueue(notif);
  };

  // Execution Timer Promise
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timerId = setTimeout(() => {
      if (probeActive) {
        probeActive = false;
        probeState.terminationReason = "DURATION_EXPIRED";
        meteredTransport.close(1000, "Probe duration expired");
      }
      resolve();
    }, durationMs);
  });

  // Transport Close Promise
  const closePromise = new Promise<void>((resolve) => {
    meteredTransport.on("close", () => {
      if (probeActive) {
        probeActive = false;
        if (probeState.terminationReason === "UNKNOWN") {
          probeState.terminationReason = "TRANSPORT_DISCONNECT";
        }
      }
      resolve();
    });
    meteredTransport.on("error", () => {
      if (probeActive) {
        probeActive = false;
        if (probeState.terminationReason === "UNKNOWN") {
          probeState.terminationReason = "TRANSPORT_ERROR";
        }
      }
      resolve();
    });
  });

  // Drainer Loop: Processes up to maxTransactionRetrievals notifications
  const drainQueueLoop = async () => {
    while (probeActive || adapter.getPendingQueueLength() > 0) {
      if (!probeActive && adapter.getPendingQueueLength() === 0) break;
      if (transactionRetrievalsAttempted >= maxTransactionRetrievals) break;

      if (adapter.getPendingQueueLength() > 0) {
        transactionRetrievalsAttempted++;
        try {
          const processRes = await adapter.processNextPending(tracker);
          if (processRes && processRes.outcome === "SUCCESS") {
            transactionRetrievalsSucceeded++;
            decodedSwapsCount += processRes.diagnostics.ingestedCount ?? 1;
          }
        } catch {
          // Handled fail-closed inside adapter
        }
      } else {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };

  // Execute observation phase
  await Promise.race([Promise.all([drainQueueLoop(), timeoutPromise]), closePromise]);

  if (timerId) {
    clearTimeout(timerId);
  }

  // Gracefully close coordinator/transport
  coordinator.close();

  // 8. Bounded History Reconciliation Phase (At shutdown)
  // Queries at most 2 history pages using ExactPoolHistoryEnumerator
  let historyQueriesAttempted = 0;
  let historyRecordsDiscovered = 0;
  let enumeratorOutcome: HistoryEnumerationOutcome | string = "NO_ANCHOR_WITNESSED";
  let anchorWitnessed = false;
  let anchorSignature: string | null = null;
  const historyWitnessedList: { signature: string; slot: number; blockTime: number | null }[] = [];
  const historyWitnessedSignatures = new Set<string>();

  // Use earliest witnessed WS signature as anchor if available
  if (wsWitnessedList.length > 0) {
    anchorSignature = wsWitnessedList[0]!.signature;

    const pageFetcher: HistoryPageFetcher = {
      fetchPage: async (
        params: HistoryPageQueryParams,
      ): Promise<readonly HistorySignatureRecord[]> => {
        if (historyQueriesAttempted >= maxHistoryQueries) {
          throw new Error(`[PROBE_CEILING] Max history queries (${maxHistoryQueries}) reached`);
        }
        historyQueriesAttempted++;

        // If custom injected historyPageFetcher is provided, use it
        if (config.historyPageFetcher) {
          return config.historyPageFetcher.fetchPage(params);
        }

        // Live JSON-RPC getSignaturesForAddress dispatch
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

        const fetchInit: RequestInit = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          ...(params.signal ? { signal: params.signal } : {}),
        };
        const resp = await customFetch(rpcUrl, fetchInit);

        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        const json = (await resp.json()) as { result?: HistorySignatureRecord[] };
        return json.result ?? [];
      },
    };

    const enumerator = new ExactPoolHistoryEnumerator({
      poolContext,
      knownAnchorSignature: anchorSignature,
      pageFetcher,
      budgetManager: budget,
      pageSize: 20,
      maxPages: maxHistoryQueries,
      clock,
    });

    try {
      const enumRes = await enumerator.enumerate();
      enumeratorOutcome = enumRes.error ? `${enumRes.outcome}: ${enumRes.error}` : enumRes.outcome;
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

      // If anchor was witnessed in the on-chain history pages, include it in history signatures
      if (
        enumRes.anchorWitnessed &&
        anchorSignature &&
        !historyWitnessedSignatures.has(anchorSignature)
      ) {
        historyWitnessedSignatures.add(anchorSignature);
        historyWitnessedList.push({
          signature: anchorSignature,
          slot: 0,
          blockTime: null,
        });
      }
    } catch (err: unknown) {
      enumeratorOutcome = `FETCH_ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // 9. Discrepancy Analysis (Explicitly bounded to witnessed data)
  const commonSignatures = wsWitnessedList
    .map((r) => r.signature)
    .filter((sig) => historyWitnessedSignatures.has(sig));
  const wsOnlySignatures = wsWitnessedList
    .map((r) => r.signature)
    .filter((sig) => !historyWitnessedSignatures.has(sig));
  const historyOnlySignatures = historyWitnessedList
    .map((r) => r.signature)
    .filter((sig) => !wsWitnessedSignatures.has(sig));

  const comparisonNotice =
    "Discrepancies represent differences between signatures actually witnessed through the single live WebSocket stream and up to 2 bounded history RPC pages. This does NOT represent a true total network notification-loss percentage, as history pagination was bounded and on-chain activity may precede or succeed the observation window.";

  const endTime = clock();
  const endTimeIso = new Date(endTime).toISOString();
  const actualDurationMs = endTime - startTime;

  // 10. Construct Evidence Artifacts
  const finalTerminationReason = probeState.terminationReason;
  const isCapTerminated =
    finalTerminationReason === "MESSAGE_LIMIT_REACHED" ||
    finalTerminationReason === "PAYLOAD_LIMIT_REACHED" ||
    finalTerminationReason === "HTTP_BUDGET_EXHAUSTED";

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
      applicationPayloadBytes: meteredTransport.getApplicationPayloadBytes(),
      overshootBytes,
      peakQueueDepth,
      decodedSwapsCount,
      transactionRetrievalsAttempted,
      transactionRetrievalsSucceeded,
      historyQueriesAttempted,
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
    status: isCapTerminated ? "LIMIT_REACHED" : "SUCCESS",
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
      pendingAtShutdown: adapter.getPendingQueueLength(),
    },
    streamingTelemetry: {
      inboundMessagesCount: meteredTransport.getMessageCount(),
      maxMessagesCeiling: maxMessages,
      applicationPayloadBytes: meteredTransport.getApplicationPayloadBytes(),
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
      historyQueriesAttempted,
      historyQueriesLimit: maxHistoryQueries,
      historyRecordsDiscovered,
      enumeratorOutcome,
      recoveryLatencyMs: actualDurationMs,
    },
    discrepancyAnalysis: {
      totalWsWitnessedSignatures: wsWitnessedList.length,
      totalHistoryWitnessedSignatures: historyWitnessedList.length,
      commonSignaturesCount: commonSignatures.length,
      wsOnlySignaturesCount: wsOnlySignatures.length,
      historyOnlySignaturesCount: historyOnlySignatures.length,
      comparisonLimitsNotice: comparisonNotice,
    },
    budgetAccounting: {
      totalHttpRequests: budget.getStats().totalRequests,
      maxHttpAttemptsLimit: MAX_TOTAL_HTTP_ATTEMPTS,
      enrichmentAttempts: budget.getStats().enrichmentRequests,
      forwardReservationPreserved: true,
      minProviderSpacingEnforcedMs: PROBE_MIN_PROVIDER_SPACING_MS,
    },
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
      comparisonLimitsNotice: comparisonNotice,
    },
  });

  // 11. Write Sealed Files to Target Directory
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

  // Seal cryptographic manifest
  const manifest = sealCaptureManifest(
    targetDir,
    poolContext.poolId,
    poolContext.candidateTokenMint,
    endTimeIso,
  );

  return {
    success: true,
    dryRun: false,
    status: isCapTerminated ? "CAP_LIMITED" : "SUCCESS",
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
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("--duration-ms must be a positive integer");
      }
      durationMs = parsed;
    } else if (arg === "--max-messages") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --max-messages");
      }
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("--max-messages must be a positive integer");
      }
      maxMessages = parsed;
    } else if (arg === "--max-bytes") {
      const next = argv[++i];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing argument value for --max-bytes");
      }
      const parsed = Number(next);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error("--max-bytes must be a positive integer");
      }
      maxPayloadBytes = parsed;
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
    help,
  };
}
