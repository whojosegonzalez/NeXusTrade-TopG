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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  RAYDIUM_AMM_V4_LAYOUT_LENGTH,
  WSOL_MINT,
  isCanonicalSolanaBase58,
  parseRaydiumAmmV4Account,
} from "../research/pilot/RaydiumAmmParser.js";
import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import { RaydiumCandidateSubscriptionCoordinator } from "./RaydiumCandidateSubscriptionCoordinator.js";
import { type ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import {
  MeteredWebSocketTransport,
  WsWebSocketTransport,
} from "./RaydiumTransportObservationProbe.js";
import { RaydiumAmmV4TransactionSourceAdapter } from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import {
  ExactPoolHistoryEnumerator,
  type HistorySignatureRecord,
  type HistoryPageQueryParams,
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
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import {
  deepRedactSensitiveObject,
  redactSensitiveText,
} from "./SolanaTrackerBundlerCaptureTool.js";
import { sanitizeSolanaRpcUrl } from "../research/pilot/SolanaRpcLiveObservationClient.js";
import type { WatchlistCandidateItem, TokenMintAddress } from "@nexustrade/shared";

const RENOUNCED_AUTHORITY_ADDRESSES = new Set(["11111111111111111111111111111111", "null", "none"]);

export function isRenouncedAuthority(authority: unknown, isExplicitlyObserved: boolean): boolean {
  if (!isExplicitlyObserved) return false;
  if (authority === null) return true;
  if (typeof authority === "string") {
    const trimmed = authority.trim();
    if (!trimmed) return false;
    return RENOUNCED_AUTHORITY_ADDRESSES.has(trimmed.toLowerCase());
  }
  return false;
}

export interface DiagnosticRequestRecord {
  readonly purpose: string;
  readonly provider: string;
  readonly endpoint: string;
  readonly method: string;
  readonly dispatchedAtMs: number;
  readonly completedAtMs: number;
  readonly httpStatus?: number | undefined;
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly wireDigestSha256?: string | undefined;
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
  readonly outDir?: string | undefined;
  readonly manifestDigestSha256?: string | undefined;
  writeError?: string | undefined;
}

export class CandidateDecisionDiagnostic {
  private readonly poolId: string;
  private readonly mintAddress: string;
  private readonly rpcUrl: string;
  private readonly outDir?: string | undefined;
  private readonly transport: typeof fetch;
  private readonly wsTransport: ISolanaWebSocketTransport;
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
    if (!this.isLive) {
      if (!options.transport) {
        throw new Error("[DIAGNOSTIC_INVALID_ARG] Offline mode requires injected transport");
      }
      if (!options.wsTransport) {
        throw new Error("[DIAGNOSTIC_INVALID_ARG] Offline mode requires injected wsTransport");
      }
      this.transport = options.transport;
      this.wsTransport = options.wsTransport;
    } else {
      this.transport = options.transport ?? globalThis.fetch;
      if (options.wsTransport) {
        this.wsTransport = options.wsTransport;
      } else {
        const wsUrl = this.rpcUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
        this.wsTransport = new WsWebSocketTransport(wsUrl);
      }
    }

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

    // Configure diagnostic budget: max 14 attempts total, max 14 enrichment, 0 forward reservation, 2500ms pacing
    this.budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 14,
      maxEnrichmentAttempts: 14,
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

  /**
   * Internal metered request dispatch wrapper enforcing shared budget, provider pacing,
   * deadline racing, body read timeouts, and fail-closed HTTP 429 aborts.
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
    signal?: AbortSignal | undefined;
    customTimeoutMs?: number | undefined;
    skipBudgetRecording?: boolean | undefined;
    overallDeadlineMs?: number | undefined;
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
      signal,
      customTimeoutMs = this.requestTimeoutMs,
      skipBudgetRecording = false,
      overallDeadlineMs,
    } = params;

    // 0. Pre-flight abort and deadline checks
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

      this.budgetManager.recordRequestAttempt(providerName, "CANDIDATE_ENRICHMENT", this.clock());
    }

    // Check cancellation immediately before dispatch
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
    let ok = false;
    let errorMessage: string | undefined;

    try {
      const fetchPromise = this.transport(url, {
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

      // Race body text read against abort/timeout
      const textPromise = res.text();
      rawText = await Promise.race([textPromise, abortPromise]);
      wireDigestSha256 = createHash("sha256").update(Buffer.from(rawText, "utf8")).digest("hex");

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
      ok = false;
    } finally {
      clearTimeout(reqTimeout);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    }

    const completedAtMs = this.clock();

    const sanitizedEndpoint = sanitizeSolanaRpcUrl(url).sanitizedUrl;
    this.ledger.records.push({
      purpose,
      provider: providerName,
      endpoint: redactSensitiveText(sanitizedEndpoint, this.sensitiveTokens),
      method,
      dispatchedAtMs,
      completedAtMs,
      ...(httpStatus > 0 ? { httpStatus } : {}),
      ok,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      ...(wireDigestSha256.length > 0 ? { wireDigestSha256 } : {}),
    });

    if (httpStatus === 429) {
      throw new Error(
        `[HTTP_429_RATE_LIMITED] ${purpose} received HTTP 429 from ${providerName}; aborting immediately.`,
      );
    }

    if (
      !ok &&
      errorMessage &&
      (errorMessage.includes("REQUEST_TIMEOUT") ||
        errorMessage.includes("OVERALL_DIAGNOSTIC_TIMEOUT"))
    ) {
      throw new Error(`[OPERATION_TIMEOUT] ${purpose} timed out: ${errorMessage}`);
    }

    let json: unknown | null = null;
    if (rawText.trim().length > 0) {
      try {
        json = JSON.parse(rawText);
      } catch {
        json = null;
      }
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
  ): Promise<{
    ok: boolean;
    status: number;
    json: Record<string, unknown> | null;
    error?: string | undefined;
  }> {
    const rpcPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: `diag-${this.ledger.totalAttempts + 1}`,
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
      signal,
      skipBudgetRecording,
      overallDeadlineMs,
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

    try {
      // Pre-check overall deadline
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
          "OVERALL_DIAGNOSTIC_TIMEOUT",
          "Overall diagnostic deadline exceeded before Phase 1",
        );
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

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: provisionalContext,
        rpcUrl: this.rpcUrl,
        transport: async (url, init) => {
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr) as { method?: string; params?: readonly unknown[] };
          const res = await this.dispatchSolanaRpc(
            "TRANSACTION_DECODING",
            parsed.method ?? "getTransaction",
            parsed.params ?? [],
            overallController.signal,
            true, // skipBudgetRecording: true because adapter already records on budgetManager
            overallDeadlineMs,
          );
          return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
        },
        budgetManager: this.budgetManager,
        clock: this.clock,
        sleepFn: (ms) => this.sleepWithAbort(ms, overallController.signal),
        requestPurpose: "CANDIDATE_ENRICHMENT",
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
      let isStreamLimitExceeded = false;

      // Wrap transport with MeteredWebSocketTransport enforcing 1MB max payload bytes
      const meteredWs = new MeteredWebSocketTransport(
        this.wsTransport,
        1024 * 1024,
        (count, bytes, byteLen, data, isOversized) => {
          if (count > 50 || isOversized) {
            isStreamLimitExceeded = true;
          }
        },
      );

      coordinator.attachTransport(meteredWs);
      coordinator.sendSubscriptionRequest();

      // Await subscription acknowledgement
      const subDeadline = this.clock() + 5000;
      while (
        coordinator.getStatus() !== "SUBSCRIBED" &&
        this.clock() < subDeadline &&
        !overallController.signal.aborted
      ) {
        await this.sleepWithAbort(50, overallController.signal);
      }
      if (coordinator.getStatus() !== "SUBSCRIBED") {
        return this.finishWithFailure(
          "SUBSCRIPTION_ACK_TIMEOUT",
          "WebSocket subscription request was not acknowledged within 5,000 ms",
          { provisionalContext },
        );
      }
      observationStartMs = this.clock();

      // Process incoming stream messages up to observation duration or limits
      const targetEnd = observationStartMs + this.observationDurationMs;
      while (
        this.clock() < targetEnd &&
        !overallController.signal.aborted &&
        this.clock() < overallDeadlineMs
      ) {
        if (isStreamLimitExceeded) {
          coordinator.close();
          break;
        }
        if (adapter.getPendingQueueLength() > 50) {
          coordinator.close();
          break;
        }
        const step = Math.min(1000, Math.max(50, targetEnd - this.clock()));
        await this.sleepWithAbort(step, overallController.signal);

        // Drain any pending transaction decodes (up to 3 max attempts total)
        while (adapter.getPendingQueueLength() > 0 && this.ledger.transactionDecodeAttempts < 3) {
          if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) break;
          await coordinator.processNextPending({ signal: overallController.signal });
        }
      }

      const notificationsReceived = coordinator.getMetrics().totalNotificationsReceived;

      // 3. Acquire on-chain cutoff (getSlot + getBlockTime) WHILE observation is STILL active
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
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
      );

      if (!slotRes.ok || !slotRes.json || typeof slotRes.json.result !== "number") {
        coordinator.close();
        return this.finishWithFailure(
          "CUTOFF_GET_SLOT_FAILED",
          `Failed to acquire cutoff slot: ${slotRes.error ?? "Invalid result"}`,
          { provisionalContext },
        );
      }

      const cutoffSlot = slotRes.json.result;

      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
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

      if (!blockTimeRes.ok || !blockTimeRes.json || typeof blockTimeRes.json.result !== "number") {
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

      // Validate observation window inequalities
      if (observationStartMs > cutoffTimestampMs - 60_000) {
        return this.finishWithFailure(
          "WARM_UP_INSUFFICIENT",
          `Observation started at ${observationStartMs} ms, after window start ${cutoffTimestampMs - 60_000} ms`,
          { provisionalContext },
        );
      }

      if (observationEndMs < cutoffTimestampMs) {
        return this.finishWithFailure(
          "CUTOFF_OBSERVATION_GAP",
          `Observation ended at ${observationEndMs} ms, before cutoff ${cutoffTimestampMs} ms`,
          { provisionalContext },
        );
      }

      // 4. Exact-pool history enumeration via accepted enumerator (1 page <= 20 records)
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
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
      coordinator.close();

      // 5. Evaluate Window Reconciliation
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
      });

      const paperAdapter = new PaperReconciledCandidateFlowAdapter();
      const isQuietQualified =
        notificationsReceived === 0 &&
        !isStreamLimitExceeded &&
        adapter.getPendingQueueLength() === 0 &&
        reconResult.status === "RECONCILED" &&
        reconResult.paperQuietStreamQualified === true &&
        (this.executionContext === "PAPER_SIMULATION" || this.executionContext === "BACKTEST");

      let flowResult: CandidateFlowResult;
      if (isQuietQualified) {
        flowResult = paperAdapter.convertCandidateFlow(
          reconResult,
          { poolAddress: this.poolId, tokenMint: this.mintAddress },
          this.clock(),
          { executionContext: this.executionContext, maxAllowedEvidenceAgeMs: 15_000 },
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
                ? "NON_QUIET_STREAM_UNVERIFIED_COMPLETENESS"
                : isStreamLimitExceeded
                  ? "STREAM_LIMIT_EXCEEDED"
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

      const lpBurnPct = validationResult.accounting.displayInaccessiblePct;

      // 8. Candidate Token Mint Account (Decimals & Authorities)
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
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
        return this.finishWithFailure(
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
        return this.finishWithFailure(
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

      // Explicit authority observation checks: missing/omitted fields remain unknown
      const rawMintVal = (
        mintRes.json.result as {
          value?: { data?: { parsed?: { info?: Record<string, unknown> } } };
        }
      )?.value;
      const rawInfo = rawMintVal?.data?.parsed?.info;

      const mintAuthObserved =
        rawInfo &&
        typeof rawInfo === "object" &&
        "mintAuthority" in rawInfo &&
        rawInfo.mintAuthority !== undefined;
      const freezeAuthObserved =
        rawInfo &&
        typeof rawInfo === "object" &&
        "freezeAuthority" in rawInfo &&
        rawInfo.freezeAuthority !== undefined;

      const mintAuthorityRenounced = isRenouncedAuthority(
        rawInfo?.mintAuthority,
        Boolean(mintAuthObserved),
      );
      const freezeAuthorityRenounced = isRenouncedAuthority(
        rawInfo?.freezeAuthority,
        Boolean(freezeAuthObserved),
      );

      const candidateMintAccount = {
        decimals: typeof rawInfo?.decimals === "number" ? rawInfo.decimals : undefined,
        mintAuthority: mintAuthObserved ? (rawInfo.mintAuthority as string | null) : undefined,
        freezeAuthority: freezeAuthObserved
          ? (rawInfo.freezeAuthority as string | null)
          : undefined,
        mintAuthorityRenounced,
        freezeAuthorityRenounced,
      };

      // =========================================================================
      // PHASE 4: Pre-Admission Screening (LP & Authorities Preconditions)
      // =========================================================================
      const lpSecurityPassed =
        validationResult.accounting.meetsNinetyPercentThreshold &&
        typeof lpBurnPct === "number" &&
        lpBurnPct >= 90.0;
      const mintAuthorityPassed = Boolean(mintAuthObserved && mintAuthorityRenounced);
      const freezeAuthorityPassed = Boolean(freezeAuthObserved && freezeAuthorityRenounced);
      const preAdmissionPassed = lpSecurityPassed && mintAuthorityPassed && freezeAuthorityPassed;

      let preAdmissionRejectionReason: string | undefined;
      if (!lpSecurityPassed) preAdmissionRejectionReason = "REJECTED_UNLOCKED_LP_RISK";
      else if (!freezeAuthorityPassed)
        preAdmissionRejectionReason = !freezeAuthObserved
          ? "REJECTED_UNKNOWN_FREEZE_AUTHORITY"
          : "REJECTED_ACTIVE_FREEZE_AUTHORITY";
      else if (!mintAuthorityPassed)
        preAdmissionRejectionReason = !mintAuthObserved
          ? "REJECTED_UNKNOWN_MINT_AUTHORITY"
          : "REJECTED_ACTIVE_MINT_AUTHORITY";

      const preAdmissionScreening = {
        lpBurnPct,
        lpSecurityPassed,
        mintAuthorityPassed,
        freezeAuthorityPassed,
        passed: preAdmissionPassed,
        rejectionReason: preAdmissionRejectionReason,
      };

      if (!preAdmissionPassed) {
        return this.finishWithFailure(
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
      // 9. RugCheck report
      if (this.clock() >= overallDeadlineMs || overallController.signal.aborted) {
        return this.finishWithFailure(
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

      const rugCheckRetrievedAtMs = this.clock();
      const rcUrl = `${this.rugCheckApiUrl}/v1/tokens/${encodeURIComponent(this.mintAddress)}/report`;
      const rcRes = await this.dispatchMeteredRequest({
        purpose: "RUGCHECK_REPORT",
        providerName: "RUGCHECK",
        url: rcUrl,
        signal: overallController.signal,
        skipBudgetRecording: false,
        overallDeadlineMs,
      });

      let rugMetrics: {
        rugScore?: number;
        hasDangerRisk?: boolean;
        bundlerPct?: number;
        top10HolderPct?: number;
        holdersCount?: number;
      } | null = null;

      if (rcRes.ok && rcRes.text) {
        // Reuse accepted strict RugCheck validation without another provider request
        const validatedRugCheck = await BuyGateTriggerService.fetchRugCheckMetrics(
          this.mintAddress,
          async () =>
            new Response(rcRes.text, {
              status: rcRes.status,
              headers: { "Content-Type": "application/json" },
            }),
        );
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
      }

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
            isQuietQualified &&
            (this.executionContext === "PAPER_SIMULATION" || this.executionContext === "BACKTEST")
          ) {
            return paperAdapter.convertCandidateFlow(reconResult, target, evalMs, {
              executionContext: this.executionContext,
              maxAllowedEvidenceAgeMs: 15_000,
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
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        overallController.signal.aborted ||
        this.clock() >= overallDeadlineMs ||
        msg.includes("OVERALL_DIAGNOSTIC_TIMEOUT") ||
        msg.includes("REQUEST_TIMEOUT");
      return this.finishWithFailure(
        isTimeout ? "OVERALL_DIAGNOSTIC_TIMEOUT" : "UNHANDLED_EXCEPTION",
        msg,
      );
    } finally {
      clearTimeout(overallTimer);
      if (coordinator) {
        try {
          coordinator.close();
        } catch {
          // ignore cleanup error
        }
      }
      if (this.wsTransport) {
        try {
          this.wsTransport.close();
        } catch {
          // ignore cleanup error
        }
      }
    }
  }

  private finishWithFailure(
    status: string,
    message: string,
    partialData?: Partial<CandidateDecisionDiagnosticResult>,
  ): CandidateDecisionDiagnosticResult {
    const result: CandidateDecisionDiagnosticResult = {
      ok: false,
      status,
      message,
      poolId: this.poolId,
      mintAddress: this.mintAddress,
      executionContext: this.executionContext,
      ledger: this.ledger,
      ...(this.outDir !== undefined ? { outDir: this.outDir } : {}),
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

    // Redact sensitive tokens from report and manifest
    const sanitizedReport = deepRedactSensitiveObject(result, this.sensitiveTokens);
    const reportJson = JSON.stringify(sanitizedReport, null, 2);
    const reportPath = path.join(targetDir, "diagnostic-report.json");
    writeFileSync(reportPath, reportJson, "utf8");

    const reportDigest = createHash("sha256").update(Buffer.from(reportJson, "utf8")).digest("hex");
    const reportBytes = Buffer.byteLength(reportJson, "utf8");

    const manifestEntries = this.ledger.records.map((r) => ({
      purpose: r.purpose,
      provider: r.provider,
      endpoint: r.endpoint,
      method: r.method,
      dispatchedAtMs: r.dispatchedAtMs,
      completedAtMs: r.completedAtMs,
      durationMs: r.completedAtMs - r.dispatchedAtMs,
      ...(r.httpStatus !== undefined ? { httpStatus: r.httpStatus } : {}),
      ok: r.ok,
      ...(r.error !== undefined
        ? { error: redactSensitiveText(r.error, this.sensitiveTokens) }
        : {}),
      ...(r.wireDigestSha256 !== undefined ? { wireDigestSha256: r.wireDigestSha256 } : {}),
    }));

    const manifest = {
      poolId: this.poolId,
      mintAddress: this.mintAddress,
      generatedAtIso: new Date(this.clock()).toISOString(),
      reportFile: {
        path: "diagnostic-report.json",
        sha256: reportDigest,
        bytes: reportBytes,
      },
      requests: manifestEntries,
    };

    const sanitizedManifest = deepRedactSensitiveObject(manifest, this.sensitiveTokens);
    const manifestJson = JSON.stringify(sanitizedManifest, null, 2);
    const manifestPath = path.join(targetDir, "evidence-manifest.json");
    writeFileSync(manifestPath, manifestJson, "utf8");
  }
}
