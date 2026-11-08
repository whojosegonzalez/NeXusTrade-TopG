/**
 * NeXusTrade — Offline Single-Target Acquisition & Decision Diagnostic
 *
 * Standalone diagnostic pipeline executing an exact-pool, no-trade acquisition and gate
 * evaluation workflow strictly bounded to at most 14 dispatched attempts.
 *
 * OPERATIONAL & ARCHITECTURAL INVARIANTS:
 * 1. Fixed Request Ceiling & Ledger:
 *    - Hard-capped at 14 total dispatched attempts across all providers.
 *    - Quiet path consumes at most 11 attempts.
 *    - Paced at >= 2,500 ms per provider; zero forward-quote reservation.
 *    - Immediate fail-closed abort on any HTTP 429 response.
 * 2. Observation Window Inequalities:
 *    - observationStartMs <= cutoffTimestampMs - 60,000 ms
 *    - observationEndMs >= cutoffTimestampMs
 *    - decisionTimestampMs - cutoffTimestampMs <= 15,000 ms
 * 3. Real Candidate-Token & Market Inputs:
 *    - Candidate-token mint account parsed via SolanaRpcMintAccountParser (decimals, authorities).
 *    - Strict actual marketCap check (FDV recorded separately, no FDV proxy).
 *    - Exact chain, DEX, pool, candidate mint, and WSOL orientation validation.
 *    - Provisional setup context validated against fresh LP evidence.
 * 4. Pre-Admission LP Precondition & Approved Decision Boundaries:
 *    - LP burn >= 90% and renounced authorities strictly enforced BEFORE Buy Gates.
 *    - Forward executionContext to evaluateCandidateDecisionPoints (PAPER_SIMULATION).
 *    - Quiet-window adapter qualification only; active/unverified flow remains UNAVAILABLE.
 *    - A single Retest evaluation arms first tick; never claims completed entry.
 * 5. Standalone Output Isolation:
 *    - Zero writes to canonical wallet, settlement journal, past sessions, or telemetry.
 *    - Writes diagnostic-report.json and evidence-manifest.json to dedicated output directory.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  parseRaydiumAmmV4Account,
  WSOL_MINT,
  isCanonicalSolanaBase58,
  RAYDIUM_AMM_V4_LAYOUT_LENGTH,
  RAYDIUM_AMM_V4_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";
import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import { type RaydiumPairOrientation } from "../research/pilot/PilotTypes.js";
import { RaydiumCandidateSubscriptionCoordinator } from "./RaydiumCandidateSubscriptionCoordinator.js";
import { type ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import { RaydiumAmmV4TransactionSourceAdapter } from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import {
  type HistorySignatureRecord,
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
import { adaptPaperBundlerSnapshot } from "./PaperSolanaTrackerBundlerAdapter.js";
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
import type { WatchlistCandidateItem, TokenMintAddress } from "@nexustrade/shared";

const RENOUNCED_AUTHORITY_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "null",
  "none",
  "",
]);

export function isRenouncedAuthority(authority: string | null | undefined): boolean {
  if (authority === null || authority === undefined) return true;
  const trimmed = authority.trim();
  if (!trimmed) return true;
  return RENOUNCED_AUTHORITY_ADDRESSES.has(trimmed.toLowerCase());
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
      }
    | undefined;
  readonly decisionResult?: CandidateDecisionResult | undefined;
  readonly outDir?: string | undefined;
  readonly manifestDigestSha256?: string | undefined;
}

export class CandidateDecisionDiagnostic {
  private readonly poolId: string;
  private readonly mintAddress: string;
  private readonly rpcUrl: string;
  private readonly outDir?: string | undefined;
  private readonly transport: typeof fetch;
  private readonly wsTransport?: ISolanaWebSocketTransport | undefined;
  private readonly clock: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;
  private readonly executionContext: "PRODUCTION" | "PAPER_SIMULATION" | "BACKTEST";
  private readonly overallTimeoutMs: number;
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
    this.transport = options.transport ?? globalThis.fetch;
    this.wsTransport = options.wsTransport;
    this.clock = options.clock ?? (() => Date.now());
    this.sleeper =
      options.sleeper ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.executionContext = options.executionContext ?? "PRODUCTION";
    this.overallTimeoutMs = options.overallTimeoutMs ?? 90_000;
    this.observationDurationMs = options.observationDurationMs ?? 65_000;
    this.isLive = options.isLive ?? false;
    this.solanaTrackerApiKey = options.solanaTrackerApiKey;
    this.rugCheckApiUrl = options.rugCheckApiUrl ?? "https://api.rugcheck.xyz";
    this.solanaTrackerApiUrl = options.solanaTrackerApiUrl ?? "https://data.solanatracker.io";
    this.dexScreenerApiUrl = options.dexScreenerApiUrl ?? "https://api.dexscreener.com";

    if (this.solanaTrackerApiKey) {
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

  /**
   * Internal metered request dispatch wrapper enforcing shared budget, provider pacing,
   * attempt counting, 429 fail-closed abort, and cryptographic wire recording.
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
      customTimeoutMs = 10_000,
    } = params;

    // 1. Budget manager admission check & pacing
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
      await this.sleeper(check.waitMs);
      check = this.budgetManager.canMakeRequest(providerName, this.clock(), "CANDIDATE_ENRICHMENT");
    }

    if (!check.allowed) {
      throw new Error(
        `[BUDGET_DENIED] ${purpose} denied by GlobalResourceBudgetManager: ${check.reason}`,
      );
    }

    // 2. Count attempt in ledger and record in budget manager
    this.ledger.totalAttempts++;
    this.budgetManager.recordRequestAttempt(providerName, "CANDIDATE_ENRICHMENT", this.clock());
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("REQUEST_TIMEOUT"), customTimeoutMs);
    if (signal) {
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }

    let httpStatus = 0;
    let rawText = "";
    let wireDigestSha256 = "";
    let ok = false;
    let errorMessage: string | undefined;

    try {
      const res = await this.transport(url, {
        method,
        headers: {
          Accept: "application/json",
          ...headers,
        },
        ...(body !== undefined ? { body } : {}),
        signal: controller.signal,
      });

      httpStatus = res.status;
      rawText = await res.text();
      wireDigestSha256 = createHash("sha256").update(Buffer.from(rawText, "utf8")).digest("hex");

      this.budgetManager.recordResponseStatus(httpStatus);
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
      clearTimeout(timeout);
    }

    const completedAtMs = this.clock();

    this.ledger.records.push({
      purpose,
      provider: providerName,
      endpoint: redactSensitiveText(url, this.sensitiveTokens),
      method,
      dispatchedAtMs,
      completedAtMs,
      httpStatus: httpStatus > 0 ? httpStatus : undefined,
      ok,
      error: errorMessage,
      wireDigestSha256: wireDigestSha256.length > 0 ? wireDigestSha256 : undefined,
    });

    if (httpStatus === 429) {
      throw new Error(
        `[HTTP_429_RATE_LIMITED] ${purpose} received HTTP 429 from ${providerName}; aborting immediately.`,
      );
    }

    let json: unknown | null = null;
    if (rawText.trim().length > 0) {
      try {
        json = JSON.parse(rawText);
      } catch {
        json = null;
      }
    }

    return { ok, status: httpStatus, text: rawText, json, error: errorMessage };
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
    });

    if (!res.ok) {
      return { ok: false, status: res.status, json: null, error: res.error };
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
        error: `RPC error: ${JSON.stringify(jsonRecord.error)}`,
      };
    }

    return { ok: true, status: res.status, json: jsonRecord };
  }

  /**
   * Executes the complete single-pool diagnostic run.
   */
  public async run(): Promise<CandidateDecisionDiagnosticResult> {
    const startedAtMs = this.clock();

    const overallController = new AbortController();
    const overallTimer = setTimeout(
      () => overallController.abort("OVERALL_DIAGNOSTIC_TIMEOUT"),
      this.overallTimeoutMs,
    );

    try {
      // =========================================================================
      // PHASE 1: Pre-Observation Setup (Pool Layout & Prior Anchor)
      // =========================================================================
      // 1. Initial pool layout (Attempt 1)
      const layoutRes = await this.dispatchSolanaRpc(
        "POOL_LAYOUT",
        "getAccountInfo",
        [this.poolId, { encoding: "base64", commitment: "confirmed" }],
        overallController.signal,
      );

      if (!layoutRes.ok || !layoutRes.json) {
        return this.finishWithFailure(
          "POOL_LAYOUT_FAILED",
          `Failed to acquire initial pool layout: ${layoutRes.error ?? "Empty response"}`,
        );
      }

      const layoutVal = (layoutRes.json.result as Record<string, unknown> | undefined)?.value as
        | Record<string, unknown>
        | null
        | undefined;

      if (!layoutVal) {
        return this.finishWithFailure(
          "POOL_ACCOUNT_NOT_FOUND",
          `Pool account '${this.poolId}' not found on-chain.`,
        );
      }

      if (layoutVal.owner !== RAYDIUM_AMM_V4_PROGRAM_ID) {
        return this.finishWithFailure(
          "INVALID_POOL_OWNER",
          `Pool account owner mismatch: expected ${RAYDIUM_AMM_V4_PROGRAM_ID}, got ${layoutVal.owner}`,
        );
      }

      const layoutDataArr = layoutVal.data;
      if (
        !Array.isArray(layoutDataArr) ||
        layoutDataArr.length < 2 ||
        layoutDataArr[1] !== "base64"
      ) {
        return this.finishWithFailure("INVALID_POOL_DATA_FORMAT", "Pool data is not valid Base64");
      }

      const poolBuffer = Buffer.from(layoutDataArr[0] as string, "base64");
      if (poolBuffer.length !== RAYDIUM_AMM_V4_LAYOUT_LENGTH) {
        return this.finishWithFailure(
          "INVALID_POOL_LAYOUT_LENGTH",
          `Pool layout length mismatch: expected ${RAYDIUM_AMM_V4_LAYOUT_LENGTH}, received ${poolBuffer.length}`,
        );
      }

      const parsedPool = parseRaydiumAmmV4Account(
        poolBuffer,
        this.poolId,
        RAYDIUM_AMM_V4_PROGRAM_ID,
      );
      if (!parsedPool.ok) {
        return this.finishWithFailure(
          "POOL_LAYOUT_PARSE_FAILED",
          `Pool layout parse error: ${parsedPool.message}`,
        );
      }

      const poolState = parsedPool.state;
      const isBaseSol = poolState.baseMint === WSOL_MINT;
      const isQuoteSol = poolState.quoteMint === WSOL_MINT;

      if (!isBaseSol && !isQuoteSol) {
        return this.finishWithFailure(
          "NOT_WSOL_PAIRED",
          `Pool is not paired with WSOL (${WSOL_MINT}): base=${poolState.baseMint}, quote=${poolState.quoteMint}`,
        );
      }

      const detectedTokenMint = isBaseSol ? poolState.quoteMint : poolState.baseMint;
      if (detectedTokenMint !== this.mintAddress) {
        return this.finishWithFailure(
          "TARGET_MINT_MISMATCH",
          `Detected candidate token mint '${detectedTokenMint}' does not match expected mint '${this.mintAddress}'`,
        );
      }

      const orientation: RaydiumPairOrientation = isBaseSol
        ? "SOL_BASE_TOKEN_QUOTE"
        : "TOKEN_BASE_SOL_QUOTE";
      const candidateTokenMint = detectedTokenMint;
      const quoteTokenMint = WSOL_MINT;

      const provisionalContext: TrackedRaydiumPoolContext = {
        poolId: this.poolId,
        candidateTokenMint,
        quoteTokenMint,
        baseVault: poolState.baseVault,
        quoteVault: poolState.quoteVault,
        baseMint: poolState.baseMint,
        quoteMint: poolState.quoteMint,
        orientation,
      };
      validateTrackedPoolContext(provisionalContext);

      // 2. Prior Anchor Acquisition (Attempt 2)
      const anchorRes = await this.dispatchSolanaRpc(
        "PRIOR_ANCHOR",
        "getSignaturesForAddress",
        [this.poolId, { limit: 1 }],
        overallController.signal,
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
      const flowTracker = new RollingTradeFlowTracker({
        poolId: this.poolId,
        tokenMint: this.mintAddress,
        clock: this.clock,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: provisionalContext,
        rpcUrl: this.rpcUrl,
        transport: async (url, init) => {
          // Transaction decodes routed through metered dispatch
          const bodyStr = typeof init?.body === "string" ? init.body : "";
          const parsed = JSON.parse(bodyStr) as { method?: string; params?: readonly unknown[] };
          const res = await this.dispatchSolanaRpc(
            "TRANSACTION_DECODING",
            parsed.method ?? "getTransaction",
            parsed.params ?? [],
            overallController.signal,
          );
          return new Response(JSON.stringify(res.json ?? {}), { status: res.status });
        },
        budgetManager: this.budgetManager,
        clock: this.clock,
        sleepFn: this.sleeper,
        requestPurpose: "CANDIDATE_ENRICHMENT",
      });

      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: provisionalContext,
        adapter,
        tracker: flowTracker,
        clock: this.clock,
      });

      let observationStartMs = 0;
      let observationEndMs = 0;
      let notificationsReceived = 0;

      if (this.wsTransport) {
        coordinator.attachTransport(this.wsTransport);
        coordinator.sendSubscriptionRequest();

        // Await subscription acknowledgement
        const subDeadline = this.clock() + 5000;
        while (coordinator.getStatus() !== "SUBSCRIBED" && this.clock() < subDeadline) {
          await this.sleeper(50);
        }
        if (coordinator.getStatus() !== "SUBSCRIBED") {
          return this.finishWithFailure(
            "SUBSCRIPTION_ACK_TIMEOUT",
            "WebSocket subscription request was not acknowledged within 5,000 ms",
            { provisionalContext },
          );
        }
        observationStartMs = this.clock();

        // Process incoming messages up to 50 max / 1MB max / observation duration
        const targetEnd = observationStartMs + this.observationDurationMs;
        while (this.clock() < targetEnd && !overallController.signal.aborted) {
          const step = Math.min(1000, Math.max(50, targetEnd - this.clock()));
          await this.sleeper(step);
          // Drain any pending transaction decodes (up to 3 max attempts total)
          while (adapter.getPendingQueueLength() > 0 && this.ledger.transactionDecodeAttempts < 3) {
            await coordinator.processNextPending({ signal: overallController.signal });
          }
        }
      } else {
        // Without active socket transport, record synthetic observation span for testing
        observationStartMs = this.clock();
        await this.sleeper(this.observationDurationMs);
      }

      notificationsReceived = coordinator.getMetrics().totalNotificationsReceived;

      // 3. Acquire on-chain cutoff (getSlot + getBlockTime) WHILE observation is STILL active
      const slotRes = await this.dispatchSolanaRpc(
        "GET_SLOT",
        "getSlot",
        [{ commitment: "confirmed" }],
        overallController.signal,
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

      const blockTimeRes = await this.dispatchSolanaRpc(
        "GET_BLOCK_TIME",
        "getBlockTime",
        [cutoffSlot],
        overallController.signal,
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

      // Now close WebSocket cleanly
      coordinator.close();

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
          "INCOMPLETE_OBSERVATION",
          `Observation ended at ${observationEndMs} ms, before source cutoff ${cutoffTimestampMs} ms`,
          { provisionalContext },
        );
      }

      // 4. History Enumeration (Attempt: 1 page of 20 records)
      let historyRecords: HistorySignatureRecord[] = [];
      const historyRes = await this.dispatchSolanaRpc(
        "HISTORY_ENUMERATION",
        "getSignaturesForAddress",
        [this.poolId, { limit: 20 }],
        overallController.signal,
      );

      if (historyRes.ok && historyRes.json && Array.isArray(historyRes.json.result)) {
        historyRecords = (
          historyRes.json.result as Array<{
            signature?: string;
            slot?: number;
            err?: unknown;
            blockTime?: number;
          }>
        ).map((r) => ({
          signature: r.signature ?? "",
          slot: r.slot ?? 0,
          err: r.err ?? null,
          blockTime: typeof r.blockTime === "number" ? r.blockTime : null,
        }));
      }

      const anchorIndex = historyRecords.findIndex((r) => r.signature === knownAnchorSignature);
      const anchorRecord = anchorIndex !== -1 ? historyRecords[anchorIndex] : undefined;
      const discoveredSinceAnchor =
        anchorIndex !== -1 ? historyRecords.slice(0, anchorIndex) : historyRecords;

      const historyResult: HistoryEnumerationResult = {
        outcome: anchorIndex !== -1 ? "ANCHOR_WITNESSED" : "ANCHOR_NOT_FOUND",
        candidatePoolId: this.poolId,
        connectionEpoch: coordinator.getConnectionEpoch(),
        anchorWitnessed: anchorIndex !== -1,
        knownAnchorSignature,
        anchorRecord,
        frozenTargetSignature: historyRecords[0]?.signature ?? knownAnchorSignature,
        discoveredSignatures: discoveredSinceAnchor,
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

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

      // Flow qualification outcome
      let flowResult: CandidateFlowResult;
      if (
        notificationsReceived === 0 &&
        reconResult.status === "RECONCILED" &&
        reconResult.paperQuietStreamQualified === true &&
        (this.executionContext === "PAPER_SIMULATION" || this.executionContext === "BACKTEST")
      ) {
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
                : `RECONCILIATION_UNQUALIFIED: ${reconResult.status}`,
          evaluationTimestampMs: this.clock(),
        });
      }

      // =========================================================================
      // PHASE 3: Fresh Candidate Evidence Acquisition (within 15s of Cutoff)
      // =========================================================================
      // Enforce decision freshness boundary: decisionTime - cutoffTimestampMs <= 15,000 ms
      if (this.clock() - cutoffTimestampMs > 15_000) {
        return this.finishWithFailure(
          "STALE_DATA",
          `Cutoff age (${this.clock() - cutoffTimestampMs} ms) exceeds 15,000 ms limit before decision evaluation`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      // 6. Exact-Pair Market Data (DexScreener)
      const pairUrl = `${this.dexScreenerApiUrl}/latest/dex/pairs/solana/${this.poolId}`;
      const pairRes = await this.dispatchMeteredRequest({
        purpose: "EXACT_PAIR",
        providerName: "DEXSCREENER",
        url: pairUrl,
        signal: overallController.signal,
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
          priceChange?: { h1?: number };
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
          `DexScreener pair metadata mismatch: chain=${pair.chainId}, dex=${pair.dexId}, address=${pair.pairAddress}`,
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
          `DexScreener pair is not WSOL-paired with candidate mint: base=${pair.baseToken?.address}, quote=${pair.quoteToken?.address}`,
          { provisionalContext, flowEvaluation: flowResult },
        );
      }

      const rawPriceNative = Number(pair.priceNative);
      if (!Number.isFinite(rawPriceNative) || rawPriceNative <= 0) {
        return this.finishWithFailure(
          "INVALID_SPOT_PRICE",
          `Invalid priceNative: ${pair.priceNative}`,
          {
            provisionalContext,
            flowEvaluation: flowResult,
          },
        );
      }

      const spotPriceSol = isBaseCandidate ? rawPriceNative : 1 / rawPriceNative;
      const spotPriceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;

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

      // Validate other non-nullable candidate fields
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

      const volume5mUsd =
        typeof pair.volume?.m5 === "number" && Number.isFinite(pair.volume.m5) ? pair.volume.m5 : 0;
      const buys5m =
        typeof pair.txns?.m5?.buys === "number" && Number.isSafeInteger(pair.txns.m5.buys)
          ? pair.txns.m5.buys
          : 0;
      const sells5m =
        typeof pair.txns?.m5?.sells === "number" && Number.isSafeInteger(pair.txns.m5.sells)
          ? pair.txns.m5.sells
          : 0;
      const buyToSellRatio = sells5m > 0 ? buys5m / sells5m : buys5m;
      const symbol =
        pair.baseToken?.address === this.mintAddress
          ? (pair.baseToken.symbol ?? "UNKNOWN")
          : (pair.quoteToken?.symbol ?? "UNKNOWN");

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
      };

      // 7. Fresh Validated LP Acquisition (2 RPC Requests via acquireRaydiumAmmV4Snapshot)
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
          `Provisional setup identities contradict fresh validated LP evidence.`,
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
      const mintRes = await this.dispatchSolanaRpc(
        "CANDIDATE_MINT",
        "getAccountInfo",
        [this.mintAddress, { encoding: "jsonParsed", commitment: "confirmed" }],
        overallController.signal,
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

      const mintData = parsedMintRes.data;
      const mintAuthorityRenounced = isRenouncedAuthority(mintData.mintAuthority);
      const freezeAuthorityRenounced = isRenouncedAuthority(mintData.freezeAuthority);

      const candidateMintAccount = {
        decimals: mintData.decimals,
        mintAuthority: mintData.mintAuthority,
        freezeAuthority: mintData.freezeAuthority,
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
      const mintAuthorityPassed = mintAuthorityRenounced;
      const freezeAuthorityPassed = freezeAuthorityRenounced;
      const preAdmissionPassed = lpSecurityPassed && mintAuthorityPassed && freezeAuthorityPassed;

      let preAdmissionRejectionReason: string | undefined;
      if (!lpSecurityPassed) preAdmissionRejectionReason = "REJECTED_UNLOCKED_LP_RISK";
      else if (!freezeAuthorityPassed)
        preAdmissionRejectionReason = "REJECTED_ACTIVE_FREEZE_AUTHORITY";
      else if (!mintAuthorityPassed) preAdmissionRejectionReason = "REJECTED_ACTIVE_MINT_AUTHORITY";

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
      const rcUrl = `${this.rugCheckApiUrl}/v1/tokens/${encodeURIComponent(this.mintAddress)}/report`;
      const rcRes = await this.dispatchMeteredRequest({
        purpose: "RUGCHECK_REPORT",
        providerName: "RUGCHECK",
        url: rcUrl,
        signal: overallController.signal,
      });

      let rugMetrics: {
        rugScore?: number;
        hasDangerRisk?: boolean;
        bundlerPct?: number;
        top10HolderPct?: number;
        holdersCount?: number;
      } | null = null;

      if (rcRes.ok && rcRes.json) {
        const rcData = rcRes.json as {
          score?: number;
          risks?: Array<{ level?: string }>;
          totalHolders?: number;
          topHolders?: Array<{ pct?: number }>;
        };
        if (typeof rcData.score === "number" && Number.isFinite(rcData.score)) {
          let hasDangerRisk = false;
          if (Array.isArray(rcData.risks)) {
            hasDangerRisk = rcData.risks.some(
              (r) => r && typeof r.level === "string" && r.level.trim().toLowerCase() === "danger",
            );
          }
          let top10HolderPct: number | undefined;
          if (Array.isArray(rcData.topHolders)) {
            let sumRaw = 0;
            let valid = true;
            for (const h of rcData.topHolders.slice(0, 10)) {
              if (typeof h?.pct !== "number" || !Number.isFinite(h.pct) || h.pct < 0) {
                valid = false;
                break;
              }
              sumRaw += h.pct;
            }
            if (valid && sumRaw <= 100.0001) {
              top10HolderPct = Math.min(1.0, Math.max(0.0, sumRaw / 100));
            }
          }
          const holdersCount =
            typeof rcData.totalHolders === "number" &&
            Number.isSafeInteger(rcData.totalHolders) &&
            rcData.totalHolders >= 0
              ? rcData.totalHolders
              : undefined;

          rugMetrics = {
            rugScore: rcData.score,
            hasDangerRisk,
            ...(top10HolderPct !== undefined ? { top10HolderPct } : {}),
            ...(holdersCount !== undefined ? { holdersCount } : {}),
          };
        }
      }

      // 10. Solana Tracker Bundler Proxy
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
      });

      if (stRes.ok && stRes.json) {
        const parsedBundler = parseSolanaTrackerBundlersResponse(stRes.json, {
          requestedMint: this.mintAddress,
          localRetrievedAtMs: this.clock(),
        });
        if (parsedBundler.success) {
          const adapted = adaptPaperBundlerSnapshot({
            targetMint: this.mintAddress,
            snapshot: parsedBundler.data,
            evaluationTimeMs: this.clock(),
            executionContext:
              this.executionContext === "PRODUCTION" ? "PAPER_SIMULATION" : this.executionContext,
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
      // PHASE 6: Buy Gates (1-12) & Retest Gate Decision
      // =========================================================================
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
        lastEvaluatedAt: new Date(this.clock()).toISOString(),
      };

      const immutableFlowProvider: CandidateFlowProvider = {
        getCandidateFlow: (target, evalMs) => {
          if (
            notificationsReceived === 0 &&
            reconResult.status === "RECONCILED" &&
            reconResult.paperQuietStreamQualified === true &&
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
          momentum5mBps: 0,
          priceChange1hPct: 0,
        },
        rugMetrics,
        flowProvider: immutableFlowProvider,
        currentNowMs: this.clock(),
        requireVerifiedHolders: true,
        executionContext: this.executionContext,
      });

      return this.finishWithSuccess({
        provisionalContext,
        validatedIdentitiesMatch: true,
        candidateMarketData,
        candidateMintAccount,
        preAdmissionScreening,
        flowEvaluation: flowResult,
        decisionResult,
      });
    } catch (err) {
      return this.finishWithFailure(
        "UNHANDLED_EXCEPTION",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(overallTimer);
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
      ...partialData,
    };
    this.writeDiagnosticArtifacts(result);
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
      ...data,
    };
    this.writeDiagnosticArtifacts(result);
    return result;
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

    try {
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }

      // Redact any credentials from report and manifest
      const sanitizedReport = deepRedactSensitiveObject(result, this.sensitiveTokens);
      const reportJson = JSON.stringify(sanitizedReport, null, 2);
      writeFileSync(path.join(targetDir, "diagnostic-report.json"), reportJson, "utf8");

      const manifestEntries = this.ledger.records.map((r) => ({
        purpose: r.purpose,
        provider: r.provider,
        endpoint: r.endpoint,
        method: r.method,
        dispatchedAtMs: r.dispatchedAtMs,
        completedAtMs: r.completedAtMs,
        status: r.httpStatus,
        ok: r.ok,
        wireDigestSha256: r.wireDigestSha256 ?? null,
      }));

      const manifestObj = {
        generatedAtIso: new Date(this.clock()).toISOString(),
        poolId: this.poolId,
        mintAddress: this.mintAddress,
        totalRequestsDispatched: this.ledger.totalAttempts,
        records: manifestEntries,
      };

      const sanitizedManifest = deepRedactSensitiveObject(manifestObj, this.sensitiveTokens);
      const manifestJson = JSON.stringify(sanitizedManifest, null, 2);
      writeFileSync(path.join(targetDir, "evidence-manifest.json"), manifestJson, "utf8");

      (result as { outDir?: string }).outDir = targetDir;
      (result as { manifestDigestSha256?: string }).manifestDigestSha256 = createHash("sha256")
        .update(Buffer.from(manifestJson, "utf8"))
        .digest("hex");
    } catch (writeErr) {
      console.warn(
        "[CandidateDecisionDiagnostic] Failed to write diagnostic output artifacts:",
        writeErr,
      );
    }
  }
}
