/**
 * Phase 12.94-D Milestone D.2.4: Solana RPC Live Observation Client
 *
 * Implements strictly allowlisted, read-only Solana JSON-RPC observation calls.
 * Enforces Raydium AMM v4 on-chain ownership, SPL Token vault verification,
 * slot-coherence tracking, and fail-closed rate-limit handling.
 *
 * Security & Integrity:
 * - Only allowlists 'getAccountInfo' and 'getMultipleAccounts'.
 * - Throws immediately on any forbidden method (e.g. sendTransaction, simulateTransaction).
 * - Zero wallet keys, zero signing, zero trading daemon dependencies.
 * - Enforces per-request outbound budget at the transport boundary (D24F-05).
 * - Injectable transport for 100% offline deterministic testing.
 */

import crypto from "node:crypto";
import {
  parseSolanaRpcPoolAccountResponse,
  parseSolanaRpcMultipleVaultsResponse,
  type SolanaRpcPoolResult,
  type SolanaRpcVaultsResult,
} from "./SolanaRpcResponseAdapter.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  computeReserveAccounting,
  isCanonicalSolanaBase58,
} from "./RaydiumAmmParser.js";
import {
  RAYDIUM_CPMM_PROGRAM_ID,
  parseRaydiumCpmmAccount,
  parseCpmmVaultAccount,
  computeCpmmReserveAccounting,
} from "./RaydiumCpmmParser.js";
import type {
  CpmmVerificationTier,
  D23ObservationRecord,
  D23ReserveAccounting,
  D28CpmmReserveAccounting,
} from "./PilotTypes.js";

export const DEFAULT_SOLANA_MAINNET_RPC = "https://api.mainnet-beta.solana.com";
export const ALLOWLISTED_RPC_METHODS = new Set(["getAccountInfo", "getMultipleAccounts"]);

export interface SanitizedRpcEndpointInfo {
  readonly rawUrl: string;
  readonly sanitizedUrl: string;
  readonly host: string;
  readonly endpointFingerprint: string;
  readonly sensitiveTokens: readonly string[];
}

/**
 * Sanitizes credential-bearing components (tokens, passwords, API keys) from RPC endpoint URLs
 * while preserving network transport fidelity and research provenance (B1-EVIDENCE-02 / B1-PREFLIGHT-01).
 */
export function sanitizeSolanaRpcUrl(rawUrl: string): SanitizedRpcEndpointInfo {
  const hash = crypto.createHash("sha256").update(rawUrl).digest("hex");
  const endpointFingerprint = `sha256:${hash.slice(0, 16)}`;
  const sensitiveTokens: string[] = [];

  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;

    // 1. Sanitize userinfo credentials (user:password@)
    if (parsed.username) {
      if (parsed.username !== "[REDACTED]" && parsed.username.length > 0) {
        sensitiveTokens.push(parsed.username);
      }
      parsed.username = "[REDACTED]";
    }
    if (parsed.password) {
      if (parsed.password !== "[REDACTED]" && parsed.password.length > 0) {
        sensitiveTokens.push(parsed.password);
      }
      parsed.password = "[REDACTED]";
    }

    // 2. Sanitize sensitive or secret-bearing query parameter values
    const sensitiveParamKeys = new Set([
      "api-key",
      "apikey",
      "api_key",
      "token",
      "auth",
      "authorization",
      "key",
      "secret",
      "dkey",
      "access_token",
      "password",
    ]);

    for (const [key, val] of Array.from(parsed.searchParams.entries())) {
      const lower = key.toLowerCase();
      if (
        sensitiveParamKeys.has(lower) ||
        lower.includes("key") ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("auth") ||
        val.length >= 10
      ) {
        if (val && val !== "[REDACTED]" && val.length > 2) {
          sensitiveTokens.push(val);
        }
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }

    // 3. Sanitize path segments containing high-entropy tokens or API keys
    const standardSegments = new Set([
      "",
      "v1",
      "v2",
      "solana",
      "rpc",
      "mainnet",
      "devnet",
      "testnet",
    ]);
    const segments = parsed.pathname.split("/");
    const sanitizedSegments = segments.map((seg, idx) => {
      if (idx === 0 && seg === "") return "";
      if (standardSegments.has(seg.toLowerCase())) return seg;
      const prevSeg = idx > 0 ? (segments[idx - 1] ?? "").toLowerCase() : "";
      if (
        prevSeg === "v1" ||
        prevSeg === "v2" ||
        seg.length >= 12 ||
        /^[0-9a-fA-F-]{16,}$/.test(seg) ||
        /^[A-Za-z0-9_-]{16,}$/.test(seg)
      ) {
        if (seg && seg !== "[REDACTED]" && seg.length > 2) {
          sensitiveTokens.push(seg);
        }
        return "[REDACTED]";
      }
      return seg;
    });
    parsed.pathname = sanitizedSegments.join("/");

    let sanitizedUrl = parsed.toString();
    // Normalize URL-encoded bracket placeholders into clean canonical literal tokens
    sanitizedUrl = sanitizedUrl.split("%5BREDACTED%5D").join("[REDACTED]");
    if (!rawUrl.endsWith("/") && sanitizedUrl.endsWith("/")) {
      sanitizedUrl = sanitizedUrl.slice(0, -1);
    }

    const uniqueTokens = Array.from(new Set(sensitiveTokens)).filter((t) => t.length > 0);
    uniqueTokens.sort((a, b) => b.length - a.length);

    return {
      rawUrl,
      sanitizedUrl,
      host,
      endpointFingerprint,
      sensitiveTokens: uniqueTokens,
    };
  } catch {
    return {
      rawUrl,
      sanitizedUrl: "[MALFORMED_URL_REDACTED]",
      host: "unknown",
      endpointFingerprint,
      sensitiveTokens: [],
    };
  }
}

export interface ISolanaRpcTransport {
  post(url: string, body: Record<string, unknown>, init?: RequestInit): Promise<unknown>;
}

/**
 * Standard Solana JSON-RPC HTTP transport using native fetch with AbortSignal support (B2-READY-01).
 */
export function createDefaultSolanaRpcTransport(options?: {
  readonly onRateLimit?: ((retryAfterEpochMs: number) => void) | undefined;
}): ISolanaRpcTransport {
  return {
    post: async (url: string, body: Record<string, unknown>, init?: RequestInit) => {
      const res = await globalThis.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        ...init,
      });
      if (res.status === 429) {
        const retryHeader = res.headers?.get?.("retry-after");
        const secs = retryHeader ? parseInt(retryHeader, 10) : 10;
        const retryUntil = Date.now() + (Number.isFinite(secs) ? secs : 10) * 1000;
        options?.onRateLimit?.(retryUntil);
        throw new Error(`[RPC_RATE_LIMIT_429] Solana RPC responded with 429 Too Many Requests`);
      }
      if (!res.ok) {
        throw new Error(`[RPC_HTTP_ERROR] Solana RPC HTTP status ${res.status}`);
      }
      return await res.json();
    },
  };
}

export interface RawRpcInteractionRecord {
  readonly request: {
    readonly jsonrpc: "2.0";
    readonly id: string | number;
    readonly method: string;
    readonly params: unknown[];
    readonly endpoint: string;
    readonly endpointFingerprint?: string | undefined;
    readonly timestampIso: string;
    readonly timestampEpochMs: number;
  };
  readonly response: Record<string, unknown> | null;
  readonly timing: {
    readonly elapsedMs: number;
    readonly payloadSizeBytes: number;
  };
  readonly error?: string | undefined;
}

export interface CpmmRawSnapshotBundle {
  readonly poolAccountRpc: RawRpcInteractionRecord;
  readonly vaultAccountsRpc: RawRpcInteractionRecord | null;
  readonly requestedPoolAddress: string;
  readonly requestedVault0Address?: string | undefined;
  readonly requestedVault1Address?: string | undefined;
  readonly totalRpcCalls: number;
  readonly maxRpcCallsBudget: number;
}

export interface SolanaRpcClientOptions {
  readonly rpcUrl?: string | undefined;
  readonly httpTimeoutMs?: number | undefined;
  readonly maxRequestsPerMinute?: number | undefined;
  readonly maxRequestsBudget?: number | undefined;
  readonly commitment?: "confirmed" | "processed" | "finalized" | undefined;
  readonly transport?: ISolanaRpcTransport | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
}

export interface SolanaRpcObservationDiagnostics {
  readonly totalCalls: number;
  readonly successfulCalls: number;
  readonly failedCalls: number;
  readonly rateLimitsEncountered: number;
  readonly timeoutsEncountered: number;
  readonly poolsObserved: number;
  readonly poolsSuccessful: number;
  readonly poolsFailed: number;
  readonly slotDiscrepancies: number;
  readonly methodsCalled: Record<string, number>;
  readonly lastCallEpochMs: number;
}

export interface ObservedPoolStateResult {
  readonly ok: boolean;
  readonly observation: D23ObservationRecord | null;
  readonly poolSlot: number | null;
  readonly vaultSlot: number | null;
  readonly slotDiscrepancy: boolean;
  readonly reserveAccounting: D23ReserveAccounting | null;
  readonly error?: string | undefined;
}

export interface RaydiumPoolVerificationReport {
  readonly poolAddress: string;
  readonly rpcUrl: string;
  readonly endpointFingerprint?: string | undefined;
  readonly endpointHost?: string | undefined;
  readonly verificationStatus:
    | "VERIFIED_RAYDIUM_AMM_V4"
    | "UNAUTHORIZED_PROGRAM_ID"
    | "NULL_ACCOUNT"
    | "MALFORMED_POOL_DATA"
    | "VAULT_VERIFICATION_FAILED"
    | "RATE_LIMITED_429"
    | "RPC_ERROR";
  readonly verified: boolean;
  readonly onChainSlot: number | null;
  readonly poolSlot: number | null;
  readonly vaultSlot: number | null;
  readonly slotDiscrepancy: boolean;
  readonly programOwner: string | null;
  readonly baseMint: string | null;
  readonly quoteMint: string | null;
  readonly baseVault: string | null;
  readonly quoteVault: string | null;
  readonly baseDecimals: number | null;
  readonly quoteDecimals: number | null;
  readonly reserveAccounting: D23ReserveAccounting | null;
  readonly hostElapsedMs: number;
  readonly missingFields: readonly string[];
  readonly error?: string | undefined;
}

export interface CpmmPoolVerificationReport {
  readonly poolAddress: string;
  readonly rpcUrl: string;
  readonly endpointFingerprint?: string | undefined;
  readonly endpointHost?: string | undefined;
  readonly verificationStatus:
    | "VERIFIED_RAYDIUM_CPMM"
    | "SLOT_PROVENANCE_UNAVAILABLE"
    | "SLOT_DISCREPANT"
    | "UNAUTHORIZED_PROGRAM_ID"
    | "NULL_ACCOUNT"
    | "MALFORMED_POOL_DATA"
    | "VAULT_VERIFICATION_FAILED"
    | "RATE_LIMITED_429"
    | "RPC_ERROR";
  readonly verified: boolean;
  readonly verificationTier?: CpmmVerificationTier | undefined;
  readonly onChainSlot: number | null;
  readonly poolSlot: number | null;
  readonly vault0Slot: number | null;
  readonly vault1Slot: number | null;
  readonly slotDiscrepancy: boolean;
  /** Independently decoded pool-state activation / swap-unlock time in seconds (BREADY-01/02) */
  readonly decodedPoolStateActivationTimeSec?: number | bigint | null | undefined;
  readonly programOwner?: string | undefined;
  readonly token0Mint?: string | undefined;
  readonly token1Mint?: string | undefined;
  readonly token0Vault?: string | undefined;
  readonly token1Vault?: string | undefined;
  readonly token0Decimals?: number | undefined;
  readonly token1Decimals?: number | undefined;
  readonly cpmmReserveAccounting?: D28CpmmReserveAccounting | null | undefined;
  readonly spotPriceSol?: number | null | undefined;
  readonly spotPrice0Per1?: number | null | undefined;
  readonly hostElapsedMs?: number | undefined;
  readonly error?: string | undefined;
  /** Requested on-chain commitment level (e.g. 'confirmed') (B1-FINAL-03) */
  readonly requestedCommitment?: string | undefined;
  /** Raw JSON-RPC responses and timing metadata captured during verification (B1-PREP-01) */
  readonly rawCaptureBundle?: CpmmRawSnapshotBundle | undefined;
}

export class SolanaRpcLiveObservationClient {
  private readonly rawRpcUrl: string;
  private readonly sanitizedRpcUrl: string;
  private readonly endpointHost: string;
  private readonly endpointFingerprint: string;
  private readonly sensitiveTokens: readonly string[];
  private readonly httpTimeoutMs: number;
  private readonly maxRequestsPerMinute: number;
  private readonly maxRequestsBudget?: number | undefined;
  private readonly commitment: "confirmed" | "processed" | "finalized";
  private readonly transport: ISolanaRpcTransport;
  private readonly onLog?: ((message: string) => void) | undefined;

  private requestTimestamps: number[] = [];
  private retryAfterUntilEpochMs = 0;

  // Telemetry counters
  private totalCalls = 0;
  private successfulCalls = 0;
  private failedCalls = 0;
  private rateLimitsEncountered = 0;
  private timeoutsEncountered = 0;
  private poolsObserved = 0;
  private poolsSuccessful = 0;
  private poolsFailed = 0;
  private slotDiscrepancies = 0;
  private readonly methodsCalled: Record<string, number> = {};
  private lastCallEpochMs = 0;

  constructor(options?: SolanaRpcClientOptions) {
    const rawUrl = options?.rpcUrl ?? DEFAULT_SOLANA_MAINNET_RPC;
    const sanitized = sanitizeSolanaRpcUrl(rawUrl);
    this.rawRpcUrl = rawUrl;
    this.sanitizedRpcUrl = sanitized.sanitizedUrl;
    this.endpointHost = sanitized.host;
    this.endpointFingerprint = sanitized.endpointFingerprint;
    this.sensitiveTokens = sanitized.sensitiveTokens;
    this.httpTimeoutMs = options?.httpTimeoutMs ?? 5_000;
    this.maxRequestsPerMinute = options?.maxRequestsPerMinute ?? 60;
    this.maxRequestsBudget = options?.maxRequestsBudget;
    this.commitment = options?.commitment ?? "confirmed";
    this.transport =
      options?.transport ??
      createDefaultSolanaRpcTransport({
        onRateLimit: (retryUntil) => {
          this.retryAfterUntilEpochMs = retryUntil;
        },
      });
    this.onLog = options?.onLog;
  }

  public getRpcUrl(): string {
    return this.sanitizedRpcUrl;
  }

  public getRawRpcUrl(): string {
    return this.rawRpcUrl;
  }

  public getEndpointHost(): string {
    return this.endpointHost;
  }

  public getEndpointFingerprint(): string {
    return this.endpointFingerprint;
  }

  /**
   * Sanitizes any text string (error message, stack trace, diagnostic log) to guarantee that
   * credential-bearing URLs, API keys, passwords, and tokens never leak into persisted evidence (B1-PREFLIGHT-01).
   */
  public sanitizeErrorMessage(text: string): string {
    if (!text) return text;
    let sanitized = text;

    // 1. Direct replacement of raw RPC URL with sanitized URL
    if (this.rawRpcUrl && this.rawRpcUrl !== this.sanitizedRpcUrl) {
      sanitized = sanitized.split(this.rawRpcUrl).join(this.sanitizedRpcUrl);
    }

    // 2. Direct replacement of any collected sensitive credential tokens
    for (const token of this.sensitiveTokens) {
      if (token && token.length > 0) {
        sanitized = sanitized.split(token).join("[REDACTED]");
        const encoded = encodeURIComponent(token);
        if (encoded !== token) {
          sanitized = sanitized.split(encoded).join("[REDACTED]");
        }
      }
    }

    // 3. Redact any embedded URLs matching credential patterns
    sanitized = sanitized.replace(/https?:\/\/[^\s"'<>)]+/g, (matchedUrl) => {
      return sanitizeSolanaRpcUrl(matchedUrl).sanitizedUrl;
    });

    return sanitized;
  }

  public getDiagnostics(): SolanaRpcObservationDiagnostics {
    return {
      totalCalls: this.totalCalls,
      successfulCalls: this.successfulCalls,
      failedCalls: this.failedCalls,
      rateLimitsEncountered: this.rateLimitsEncountered,
      timeoutsEncountered: this.timeoutsEncountered,
      poolsObserved: this.poolsObserved,
      poolsSuccessful: this.poolsSuccessful,
      poolsFailed: this.poolsFailed,
      slotDiscrepancies: this.slotDiscrepancies,
      methodsCalled: { ...this.methodsCalled },
      lastCallEpochMs: this.lastCallEpochMs,
    };
  }

  /**
   * Performs an on-chain observation of a Raydium AMM v4 pool and its underlying vaults.
   * Enforces program owner verification and slot-coherence tracking.
   */
  public async observeRaydiumPool(params: {
    poolAddress: string;
    targetMint: string;
    flowMetrics?:
      | {
          volume5mUsd: number | null;
          buys5m: number | null;
          sells5m: number | null;
          netBuyerVolumeUsd: number | null;
        }
      | undefined;
    compositeId: {
      decisionEventId: string;
      sessionId: string;
      generationId: string;
      mintAddress: string;
      poolId: string;
    };
  }): Promise<ObservedPoolStateResult> {
    this.poolsObserved++;
    this.onLog?.(`Observing Raydium pool ${params.poolAddress} for mint ${params.targetMint}...`);
    const now = Date.now();
    if (now < this.retryAfterUntilEpochMs) {
      this.poolsFailed++;
      const errMsg = `[RPC_THROTTLED] Solana RPC rate-limited until ${new Date(this.retryAfterUntilEpochMs).toISOString()}`;
      this.onLog?.(`${errMsg}`);
      return {
        ok: false,
        observation: null,
        poolSlot: null,
        vaultSlot: null,
        slotDiscrepancy: false,
        reserveAccounting: null,
        error: errMsg,
      };
    }

    const requestEpochMs = Date.now();

    try {
      // 1. Fetch Pool Account Info
      const poolPayload = await this.executeRpcCall("getAccountInfo", [
        params.poolAddress,
        { encoding: "base64", commitment: "confirmed" },
      ]);

      const poolResult: SolanaRpcPoolResult = parseSolanaRpcPoolAccountResponse(
        poolPayload,
        params.poolAddress,
      );

      if (!poolResult.ok || !poolResult.poolState) {
        this.poolsFailed++;
        const errMsg = poolResult.error ?? "Failed to decode Raydium pool account";
        this.onLog?.(`Pool ${params.poolAddress} account decode failed: ${errMsg}`);
        return {
          ok: false,
          observation: null,
          poolSlot: poolResult.slot,
          vaultSlot: null,
          slotDiscrepancy: false,
          reserveAccounting: null,
          error: errMsg,
        };
      }

      const poolState = poolResult.poolState;
      if (poolState.programId !== RAYDIUM_AMM_V4_PROGRAM_ID) {
        this.poolsFailed++;
        const errMsg = `[UNAUTHORIZED_PROGRAM_ID] Pool program ID '${poolState.programId}' is not Raydium AMM v4`;
        this.onLog?.(`Pool ${params.poolAddress} owner check failed: ${errMsg}`);
        return {
          ok: false,
          observation: null,
          poolSlot: poolResult.slot,
          vaultSlot: null,
          slotDiscrepancy: false,
          reserveAccounting: null,
          error: errMsg,
        };
      }

      // 2. Fetch Vault Accounts Info
      const vaultsPayload = await this.executeRpcCall("getMultipleAccounts", [
        [poolState.baseVault, poolState.quoteVault],
        { encoding: "base64", commitment: "confirmed" },
      ]);

      const vaultsResult: SolanaRpcVaultsResult = parseSolanaRpcMultipleVaultsResponse(
        vaultsPayload,
        [poolState.baseVault, poolState.quoteVault],
        [poolState.baseMint, poolState.quoteMint],
      );

      if (!vaultsResult.ok || !vaultsResult.balances) {
        this.poolsFailed++;
        const errMsg = vaultsResult.error ?? "Failed to decode pool vault balances";
        this.onLog?.(`Pool ${params.poolAddress} vaults decode failed: ${errMsg}`);
        return {
          ok: false,
          observation: null,
          poolSlot: poolResult.slot,
          vaultSlot: vaultsResult.slot,
          slotDiscrepancy: false,
          reserveAccounting: null,
          error: errMsg,
        };
      }

      const balances = vaultsResult.balances;
      const reserveAccounting = computeReserveAccounting(
        poolState,
        balances.baseVaultRaw,
        balances.quoteVaultRaw,
        "VAULT_ONLY_PROXY",
      );

      const receiptEpochMs = Date.now();
      const hostMonotonicElapsedMs = receiptEpochMs - requestEpochMs;

      const slotDiscrepancy = Boolean(
        poolResult.slot !== null &&
        vaultsResult.slot !== null &&
        Math.abs(poolResult.slot - vaultsResult.slot) > 2,
      );

      const observation: D23ObservationRecord = {
        observationId: `obs-rpc-${params.poolAddress.slice(0, 8)}-${receiptEpochMs}`,
        compositeId: params.compositeId,
        requestEpochMs,
        receiptEpochMs,
        sourceReportedTimeMs: null, // Nullable: Solana RPC getAccountInfo does not attest block timestamp
        hostMonotonicElapsedMs,
        onChainSlot: vaultsResult.slot ?? poolResult.slot,
        slotDiscrepancy,
        provenance: "D23_OBSERVATIONAL_SCREENING",
        providerIdentity: `solana_rpc:${this.endpointHost}`,
        actualResponsePoolId: params.poolAddress,
        isMatchingPool: true,
        reserveAccounting,
        flowMetrics: params.flowMetrics ?? {
          volume5mUsd: null,
          buys5m: null,
          sells5m: null,
          netBuyerVolumeUsd: null,
        },
        missingFields: ["sourceTimestampMs"],
      };

      this.poolsSuccessful++;
      if (slotDiscrepancy) {
        this.slotDiscrepancies++;
      }
      this.onLog?.(
        `Pool ${params.poolAddress} observed successfully (slot: ${vaultsResult.slot ?? poolResult.slot}, slotDiscrepancy: ${slotDiscrepancy})`,
      );

      return {
        ok: true,
        observation,
        poolSlot: poolResult.slot,
        vaultSlot: vaultsResult.slot,
        slotDiscrepancy,
        reserveAccounting,
      };
    } catch (err) {
      this.poolsFailed++;
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = this.sanitizeErrorMessage(rawErrMsg);
      this.onLog?.(`Pool ${params.poolAddress} observation failed: ${errMsg}`);
      return {
        ok: false,
        observation: null,
        poolSlot: null,
        vaultSlot: null,
        slotDiscrepancy: false,
        reserveAccounting: null,
        error: errMsg,
      };
    }
  }

  /**
   * Performs an independent on-chain verification of a Raydium AMM v4 pool address.
   * Validates account existence, program ownership, SPL token vaults, and reserve accounting.
   * Returns a structured diagnostic report without modifying canonical research datasets.
   */
  public async verifyPoolAccount(poolAddress: string): Promise<RaydiumPoolVerificationReport> {
    const requestEpochMs = Date.now();
    this.poolsObserved++;
    this.onLog?.(`Verifying pool ${poolAddress} on-chain via Solana RPC...`);

    if (!isCanonicalSolanaBase58(poolAddress)) {
      this.poolsFailed++;
      return {
        poolAddress,
        rpcUrl: this.sanitizedRpcUrl,
        endpointFingerprint: this.endpointFingerprint,
        endpointHost: this.endpointHost,
        verificationStatus: "MALFORMED_POOL_DATA",
        verified: false,
        onChainSlot: null,
        poolSlot: null,
        vaultSlot: null,
        slotDiscrepancy: false,
        programOwner: null,
        baseMint: null,
        quoteMint: null,
        baseVault: null,
        quoteVault: null,
        baseDecimals: null,
        quoteDecimals: null,
        reserveAccounting: null,
        hostElapsedMs: Date.now() - requestEpochMs,
        missingFields: ["sourceTimestampMs"],
        error: `Invalid Solana base58 pool address format: '${poolAddress}'`,
      };
    }

    if (Date.now() < this.retryAfterUntilEpochMs) {
      this.poolsFailed++;
      const errMsg = `[RPC_THROTTLED] Solana RPC rate-limited until ${new Date(this.retryAfterUntilEpochMs).toISOString()}`;
      return {
        poolAddress,
        rpcUrl: this.sanitizedRpcUrl,
        endpointFingerprint: this.endpointFingerprint,
        endpointHost: this.endpointHost,
        verificationStatus: "RATE_LIMITED_429",
        verified: false,
        onChainSlot: null,
        poolSlot: null,
        vaultSlot: null,
        slotDiscrepancy: false,
        programOwner: null,
        baseMint: null,
        quoteMint: null,
        baseVault: null,
        quoteVault: null,
        baseDecimals: null,
        quoteDecimals: null,
        reserveAccounting: null,
        hostElapsedMs: Date.now() - requestEpochMs,
        missingFields: ["sourceTimestampMs"],
        error: errMsg,
      };
    }

    try {
      // 1. Fetch Pool Account Info
      const poolPayload = await this.executeRpcCall("getAccountInfo", [
        poolAddress,
        { encoding: "base64", commitment: "confirmed" },
      ]);

      const poolResult: SolanaRpcPoolResult = parseSolanaRpcPoolAccountResponse(
        poolPayload,
        poolAddress,
      );

      if (!poolResult.ok || !poolResult.poolState) {
        this.poolsFailed++;
        const errLower = (poolResult.error ?? "").toLowerCase();
        const rawOwner =
          typeof (poolPayload as Record<string, unknown> | null)?.result === "object" &&
          (poolPayload as { result?: { value?: { owner?: unknown } } })?.result?.value &&
          typeof (poolPayload as { result: { value: { owner?: unknown } } }).result.value.owner ===
            "string"
            ? (poolPayload as { result: { value: { owner: string } } }).result.value.owner
            : null;
        const isUnauthorized = errLower.includes("unauthorized");
        const status =
          errLower.includes("null") || errLower.includes("missing")
            ? "NULL_ACCOUNT"
            : isUnauthorized
              ? "UNAUTHORIZED_PROGRAM_ID"
              : "MALFORMED_POOL_DATA";
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          verificationStatus: status,
          verified: false,
          onChainSlot: poolResult.slot,
          poolSlot: poolResult.slot,
          vaultSlot: null,
          slotDiscrepancy: false,
          programOwner: isUnauthorized ? rawOwner : null,
          baseMint: null,
          quoteMint: null,
          baseVault: null,
          quoteVault: null,
          baseDecimals: null,
          quoteDecimals: null,
          reserveAccounting: null,
          hostElapsedMs: Date.now() - requestEpochMs,
          missingFields: ["sourceTimestampMs"],
          error: poolResult.error ?? "Failed to decode pool account",
        };
      }

      const poolState = poolResult.poolState;
      if (poolState.programId !== RAYDIUM_AMM_V4_PROGRAM_ID) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          verificationStatus: "UNAUTHORIZED_PROGRAM_ID",
          verified: false,
          onChainSlot: poolResult.slot,
          poolSlot: poolResult.slot,
          vaultSlot: null,
          slotDiscrepancy: false,
          programOwner: poolState.programId,
          baseMint: poolState.baseMint,
          quoteMint: poolState.quoteMint,
          baseVault: poolState.baseVault,
          quoteVault: poolState.quoteVault,
          baseDecimals: Number(poolState.baseDecimal),
          quoteDecimals: Number(poolState.quoteDecimal),
          reserveAccounting: null,
          hostElapsedMs: Date.now() - requestEpochMs,
          missingFields: ["sourceTimestampMs"],
          error: `[UNAUTHORIZED_PROGRAM_ID] Pool program ID '${poolState.programId}' is not canonical Raydium AMM v4 (${RAYDIUM_AMM_V4_PROGRAM_ID})`,
        };
      }

      // 2. Fetch Vault Accounts Info
      const vaultsPayload = await this.executeRpcCall("getMultipleAccounts", [
        [poolState.baseVault, poolState.quoteVault],
        { encoding: "base64", commitment: "confirmed" },
      ]);

      const vaultsResult: SolanaRpcVaultsResult = parseSolanaRpcMultipleVaultsResponse(
        vaultsPayload,
        [poolState.baseVault, poolState.quoteVault],
        [poolState.baseMint, poolState.quoteMint],
      );

      if (!vaultsResult.ok || !vaultsResult.balances) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          verificationStatus: "VAULT_VERIFICATION_FAILED",
          verified: false,
          onChainSlot: poolResult.slot,
          poolSlot: poolResult.slot,
          vaultSlot: vaultsResult.slot,
          slotDiscrepancy: false,
          programOwner: poolState.programId,
          baseMint: poolState.baseMint,
          quoteMint: poolState.quoteMint,
          baseVault: poolState.baseVault,
          quoteVault: poolState.quoteVault,
          baseDecimals: Number(poolState.baseDecimal),
          quoteDecimals: Number(poolState.quoteDecimal),
          reserveAccounting: null,
          hostElapsedMs: Date.now() - requestEpochMs,
          missingFields: ["sourceTimestampMs"],
          error: vaultsResult.error ?? "Failed to decode vault accounts",
        };
      }

      const balances = vaultsResult.balances;
      const reserveAccounting = computeReserveAccounting(
        poolState,
        balances.baseVaultRaw,
        balances.quoteVaultRaw,
        "VAULT_ONLY_PROXY",
      );

      const slotDiscrepancy = Boolean(
        poolResult.slot !== null &&
        vaultsResult.slot !== null &&
        Math.abs(poolResult.slot - vaultsResult.slot) > 2,
      );

      this.poolsSuccessful++;
      if (slotDiscrepancy) {
        this.slotDiscrepancies++;
      }

      return {
        poolAddress,
        rpcUrl: this.sanitizedRpcUrl,
        endpointFingerprint: this.endpointFingerprint,
        endpointHost: this.endpointHost,
        verificationStatus: "VERIFIED_RAYDIUM_AMM_V4",
        verified: true,
        onChainSlot: vaultsResult.slot ?? poolResult.slot,
        poolSlot: poolResult.slot,
        vaultSlot: vaultsResult.slot,
        slotDiscrepancy,
        programOwner: poolState.programId,
        baseMint: poolState.baseMint,
        quoteMint: poolState.quoteMint,
        baseVault: poolState.baseVault,
        quoteVault: poolState.quoteVault,
        baseDecimals: Number(poolState.baseDecimal),
        quoteDecimals: Number(poolState.quoteDecimal),
        reserveAccounting,
        hostElapsedMs: Date.now() - requestEpochMs,
        missingFields: ["sourceTimestampMs"],
      };
    } catch (err: unknown) {
      this.poolsFailed++;
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = this.sanitizeErrorMessage(rawErrMsg);
      const is429 = errMsg.includes("429");
      const isTimeout =
        errMsg.includes("timeout") || (err instanceof Error && err.name === "AbortError");
      const status = is429 ? "RATE_LIMITED_429" : isTimeout ? "RPC_ERROR" : "RPC_ERROR";
      this.onLog?.(`Failed to verify AMM v4 pool ${poolAddress}: ${errMsg}`);
      return {
        poolAddress,
        rpcUrl: this.sanitizedRpcUrl,
        endpointFingerprint: this.endpointFingerprint,
        endpointHost: this.endpointHost,
        verificationStatus: status,
        verified: false,
        onChainSlot: null,
        poolSlot: null,
        vaultSlot: null,
        slotDiscrepancy: false,
        programOwner: null,
        baseMint: null,
        quoteMint: null,
        baseVault: null,
        quoteVault: null,
        baseDecimals: null,
        quoteDecimals: null,
        reserveAccounting: null,
        hostElapsedMs: Date.now() - requestEpochMs,
        missingFields: ["sourceTimestampMs"],
        error: errMsg,
      };
    }
  }

  /**
   * Performs an independent on-chain verification of a Raydium CPMM pool and its vaults (D29-H3).
   * Validates CPMM program owner, authority PDA, token mints, vault ownership, and effective reserves.
   */
  public async verifyCpmmPoolAccount(poolAddress: string): Promise<CpmmPoolVerificationReport> {
    const requestEpochMs = Date.now();
    this.poolsObserved++;

    let callsExecuted = 0;
    let poolRecord: RawRpcInteractionRecord | null = null;
    let vaultsRecord: RawRpcInteractionRecord | null = null;

    const buildCaptureBundle = (extra?: {
      v0?: string;
      v1?: string;
    }): CpmmRawSnapshotBundle | undefined => {
      if (!poolRecord) return undefined;
      return {
        poolAccountRpc: poolRecord,
        vaultAccountsRpc: vaultsRecord,
        requestedPoolAddress: poolAddress,
        requestedVault0Address: extra?.v0,
        requestedVault1Address: extra?.v1,
        totalRpcCalls: callsExecuted,
        maxRpcCallsBudget: this.maxRequestsBudget ?? 2,
      };
    };

    if (!isCanonicalSolanaBase58(poolAddress)) {
      this.poolsFailed++;
      return {
        poolAddress,
        rpcUrl: this.sanitizedRpcUrl,
        endpointFingerprint: this.endpointFingerprint,
        endpointHost: this.endpointHost,
        requestedCommitment: this.commitment,
        verificationStatus: "MALFORMED_POOL_DATA",
        verified: false,
        onChainSlot: null,
        poolSlot: null,
        vault0Slot: null,
        vault1Slot: null,
        slotDiscrepancy: false,
        error: "Invalid base58 pool address format",
      };
    }

    try {
      // 1. Fetch Pool State Account (Call 1 of 2 in standard budget)
      callsExecuted++;
      let rawPoolResponse: Record<string, unknown> | null = null;
      try {
        const res = await this.executeRpcCallWithRecord("getAccountInfo", [
          poolAddress,
          { encoding: "base64", commitment: this.commitment },
        ]);
        rawPoolResponse = res.response as Record<string, unknown> | null;
        poolRecord = res.record;
      } catch (err) {
        poolRecord = (err as { rpcRecord?: RawRpcInteractionRecord })?.rpcRecord ?? null;
        throw err;
      }

      const poolInfoResponse =
        (rawPoolResponse?.result as {
          context?: { slot?: number };
          value?: {
            data?: [string, string];
            owner?: string;
            lamports?: number;
          } | null;
        } | null) ??
        (rawPoolResponse as {
          context?: { slot?: number };
          value?: {
            data?: [string, string];
            owner?: string;
            lamports?: number;
          } | null;
        } | null);

      const poolVal = poolInfoResponse?.value;
      const rawPoolSlot = poolInfoResponse?.context?.slot;
      const poolSlot =
        typeof rawPoolSlot === "number" && Number.isInteger(rawPoolSlot) && rawPoolSlot > 0
          ? rawPoolSlot
          : null;

      if (!poolVal) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "NULL_ACCOUNT",
          verified: false,
          onChainSlot: poolSlot,
          poolSlot,
          vault0Slot: null,
          vault1Slot: null,
          slotDiscrepancy: false,
          error: "CPMM pool account not found on-chain",
          rawCaptureBundle: buildCaptureBundle(),
        };
      }

      if (poolVal.owner !== RAYDIUM_CPMM_PROGRAM_ID) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "UNAUTHORIZED_PROGRAM_ID",
          verified: false,
          onChainSlot: poolSlot,
          poolSlot,
          vault0Slot: null,
          vault1Slot: null,
          slotDiscrepancy: false,
          programOwner: poolVal.owner,
          error: `Unauthorized pool owner: expected ${RAYDIUM_CPMM_PROGRAM_ID}, got ${poolVal.owner}`,
          rawCaptureBundle: buildCaptureBundle(),
        };
      }

      const poolDataB64 = poolVal.data?.[0];
      if (!poolDataB64) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "MALFORMED_POOL_DATA",
          verified: false,
          onChainSlot: poolSlot,
          poolSlot,
          vault0Slot: null,
          vault1Slot: null,
          slotDiscrepancy: false,
          error: "Empty pool account data payload",
          rawCaptureBundle: buildCaptureBundle(),
        };
      }

      const poolBuffer = Buffer.from(poolDataB64, "base64");
      const cpmmParseResult = parseRaydiumCpmmAccount(
        poolBuffer,
        poolAddress,
        poolVal.owner,
        poolSlot ?? undefined,
      );

      if (!cpmmParseResult.ok) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "MALFORMED_POOL_DATA",
          verified: false,
          onChainSlot: poolSlot,
          poolSlot,
          vault0Slot: null,
          vault1Slot: null,
          slotDiscrepancy: false,
          error: `Failed to decode CPMM pool state: ${cpmmParseResult.message}`,
          rawCaptureBundle: buildCaptureBundle(),
        };
      }

      const poolState = cpmmParseResult.state;

      // 2. Fetch Vault Accounts (Call 2 of 2 in standard budget)
      callsExecuted++;
      let rawVaultsResponse: Record<string, unknown> | null = null;
      try {
        const res = await this.executeRpcCallWithRecord("getMultipleAccounts", [
          [poolState.token0Vault, poolState.token1Vault],
          { encoding: "base64", commitment: this.commitment },
        ]);
        rawVaultsResponse = res.response as Record<string, unknown> | null;
        vaultsRecord = res.record;
      } catch (err) {
        vaultsRecord = (err as { rpcRecord?: RawRpcInteractionRecord })?.rpcRecord ?? null;
        throw err;
      }

      const vaultsResponse =
        (rawVaultsResponse?.result as {
          context?: { slot?: number };
          value?: Array<{
            data?: [string, string];
            owner?: string;
            lamports?: number;
          } | null>;
        } | null) ??
        (rawVaultsResponse as {
          context?: { slot?: number };
          value?: Array<{
            data?: [string, string];
            owner?: string;
            lamports?: number;
          } | null>;
        } | null);

      const rawVaultsSlot = vaultsResponse?.context?.slot;
      const vaultsSlot =
        typeof rawVaultsSlot === "number" && Number.isInteger(rawVaultsSlot) && rawVaultsSlot > 0
          ? rawVaultsSlot
          : null;
      const v0Account = vaultsResponse?.value?.[0];
      const v1Account = vaultsResponse?.value?.[1];

      if (!v0Account || !v1Account || !v0Account.data?.[0] || !v1Account.data?.[0]) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "VAULT_VERIFICATION_FAILED",
          verified: false,
          onChainSlot: vaultsSlot ?? poolSlot,
          poolSlot,
          vault0Slot: vaultsSlot,
          vault1Slot: vaultsSlot,
          slotDiscrepancy: false,
          programOwner: poolVal.owner,
          token0Mint: poolState.token0Mint,
          token1Mint: poolState.token1Mint,
          token0Vault: poolState.token0Vault,
          token1Vault: poolState.token1Vault,
          error: "One or both CPMM vault accounts not found on-chain",
          rawCaptureBundle: buildCaptureBundle({
            v0: poolState.token0Vault,
            v1: poolState.token1Vault,
          }),
        };
      }

      const v0Buf = Buffer.from(v0Account.data[0], "base64");
      const v1Buf = Buffer.from(v1Account.data[0], "base64");

      const v0Parsed = parseCpmmVaultAccount(
        v0Buf,
        poolState.token0Vault,
        poolState.token0Vault,
        poolState.token0Mint,
        poolState.token0Program,
        v0Account.owner ?? "",
        vaultsSlot ?? undefined,
      );

      const v1Parsed = parseCpmmVaultAccount(
        v1Buf,
        poolState.token1Vault,
        poolState.token1Vault,
        poolState.token1Mint,
        poolState.token1Program,
        v1Account.owner ?? "",
        vaultsSlot ?? undefined,
      );

      if (!v0Parsed.ok) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "VAULT_VERIFICATION_FAILED",
          verified: false,
          onChainSlot: vaultsSlot ?? poolSlot,
          poolSlot,
          vault0Slot: vaultsSlot,
          vault1Slot: vaultsSlot,
          slotDiscrepancy: false,
          programOwner: poolVal.owner,
          token0Mint: poolState.token0Mint,
          token1Mint: poolState.token1Mint,
          token0Vault: poolState.token0Vault,
          token1Vault: poolState.token1Vault,
          error: `Vault 0 verification failed: ${v0Parsed.category} - ${v0Parsed.message}`,
          rawCaptureBundle: buildCaptureBundle({
            v0: poolState.token0Vault,
            v1: poolState.token1Vault,
          }),
        };
      }

      if (!v1Parsed.ok) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "VAULT_VERIFICATION_FAILED",
          verified: false,
          onChainSlot: vaultsSlot ?? poolSlot,
          poolSlot,
          vault0Slot: vaultsSlot,
          vault1Slot: vaultsSlot,
          slotDiscrepancy: false,
          programOwner: poolVal.owner,
          token0Mint: poolState.token0Mint,
          token1Mint: poolState.token1Mint,
          token0Vault: poolState.token0Vault,
          token1Vault: poolState.token1Vault,
          error: `Vault 1 verification failed: ${v1Parsed.category} - ${v1Parsed.message}`,
          rawCaptureBundle: buildCaptureBundle({
            v0: poolState.token0Vault,
            v1: poolState.token1Vault,
          }),
        };
      }

      // 3. Slot Provenance & Discrepancy Checks (BREADY-02)
      // Missing or invalid context slots remain explicitly unavailable and must not produce INDEPENDENTLY_COHERENT or VERIFIED_RAYDIUM_CPMM
      if (poolSlot === null || vaultsSlot === null) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "SLOT_PROVENANCE_UNAVAILABLE",
          verified: false,
          verificationTier: "PARTIALLY_VERIFIED",
          onChainSlot: vaultsSlot ?? poolSlot,
          poolSlot,
          vault0Slot: vaultsSlot,
          vault1Slot: vaultsSlot,
          slotDiscrepancy: false,
          decodedPoolStateActivationTimeSec: poolState.swapActivationTimeSec,
          programOwner: poolVal.owner,
          token0Mint: poolState.token0Mint,
          token1Mint: poolState.token1Mint,
          token0Vault: poolState.token0Vault,
          token1Vault: poolState.token1Vault,
          error: `Missing authentic slot provenance: poolSlot=${poolSlot}, vaultsSlot=${vaultsSlot}`,
          rawCaptureBundle: buildCaptureBundle({
            v0: poolState.token0Vault,
            v1: poolState.token1Vault,
          }),
        };
      }

      const slotDelta = Math.abs(poolSlot - vaultsSlot);
      const slotDiscrepancy = slotDelta > 2;

      if (slotDiscrepancy) {
        this.poolsFailed++;
        this.slotDiscrepancies++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "SLOT_DISCREPANT",
          verified: false,
          verificationTier: "SLOT_DISCREPANT",
          onChainSlot: vaultsSlot,
          poolSlot,
          vault0Slot: vaultsSlot,
          vault1Slot: vaultsSlot,
          slotDiscrepancy: true,
          decodedPoolStateActivationTimeSec: poolState.swapActivationTimeSec,
          programOwner: poolVal.owner,
          token0Mint: poolState.token0Mint,
          token1Mint: poolState.token1Mint,
          token0Vault: poolState.token0Vault,
          token1Vault: poolState.token1Vault,
          error: `Slot discrepancy between pool observation (${poolSlot}) and vault observation (${vaultsSlot}): delta=${slotDelta}`,
          rawCaptureBundle: buildCaptureBundle({
            v0: poolState.token0Vault,
            v1: poolState.token1Vault,
          }),
        };
      }

      // 4. Compute Reserve Accounting
      const reserveResult = computeCpmmReserveAccounting(
        poolState,
        v0Parsed.snapshot,
        v1Parsed.snapshot,
      );

      if (!reserveResult.ok) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          endpointHost: this.endpointHost,
          requestedCommitment: this.commitment,
          verificationStatus: "VAULT_VERIFICATION_FAILED",
          verified: false,
          onChainSlot: vaultsSlot,
          poolSlot,
          vault0Slot: vaultsSlot,
          vault1Slot: vaultsSlot,
          slotDiscrepancy: false,
          decodedPoolStateActivationTimeSec: poolState.swapActivationTimeSec,
          programOwner: poolVal.owner,
          token0Mint: poolState.token0Mint,
          token1Mint: poolState.token1Mint,
          token0Vault: poolState.token0Vault,
          token1Vault: poolState.token1Vault,
          error: `Reserve accounting failed: ${reserveResult.message}`,
          rawCaptureBundle: buildCaptureBundle({
            v0: poolState.token0Vault,
            v1: poolState.token1Vault,
          }),
        };
      }

      const accounting = reserveResult.accounting;
      const isCoherent = accounting.verificationTier === "INDEPENDENTLY_COHERENT";

      this.poolsSuccessful++;

      return {
        poolAddress,
        rpcUrl: this.sanitizedRpcUrl,
        endpointFingerprint: this.endpointFingerprint,
        endpointHost: this.endpointHost,
        requestedCommitment: this.commitment,
        verificationStatus: isCoherent ? "VERIFIED_RAYDIUM_CPMM" : "VAULT_VERIFICATION_FAILED",
        verified: isCoherent,
        verificationTier: accounting.verificationTier,
        onChainSlot: vaultsSlot,
        poolSlot,
        vault0Slot: vaultsSlot,
        vault1Slot: vaultsSlot,
        slotDiscrepancy: false,
        decodedPoolStateActivationTimeSec: poolState.swapActivationTimeSec,
        programOwner: poolVal.owner,
        token0Mint: poolState.token0Mint,
        token1Mint: poolState.token1Mint,
        token0Vault: poolState.token0Vault,
        token1Vault: poolState.token1Vault,
        token0Decimals: poolState.mint0Decimals,
        token1Decimals: poolState.mint1Decimals,
        cpmmReserveAccounting: accounting,
        spotPriceSol: isCoherent ? accounting.spotPriceSol : null,
        spotPrice0Per1: isCoherent ? accounting.spotPrice0Per1 : null,
        hostElapsedMs: Date.now() - requestEpochMs,
        rawCaptureBundle: buildCaptureBundle({
          v0: poolState.token0Vault,
          v1: poolState.token1Vault,
        }),
      };
    } catch (err: unknown) {
      this.poolsFailed++;
      if (!poolRecord && err && typeof err === "object" && "rpcRecord" in err) {
        poolRecord = (err as { rpcRecord: RawRpcInteractionRecord }).rpcRecord;
      }
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = this.sanitizeErrorMessage(rawErrMsg);
      const is429 = errMsg.includes("429");
      const isTimeout =
        errMsg.includes("timeout") || (err instanceof Error && err.name === "AbortError");
      const status = is429 ? "RATE_LIMITED_429" : isTimeout ? "RPC_ERROR" : "RPC_ERROR";
      this.onLog?.(`Failed to verify CPMM pool ${poolAddress}: ${errMsg}`);
      return {
        poolAddress,
        rpcUrl: this.sanitizedRpcUrl,
        endpointFingerprint: this.endpointFingerprint,
        endpointHost: this.endpointHost,
        requestedCommitment: this.commitment,
        verificationStatus: status,
        verified: false,
        onChainSlot: null,
        poolSlot: null,
        vault0Slot: null,
        vault1Slot: null,
        slotDiscrepancy: false,
        hostElapsedMs: Date.now() - requestEpochMs,
        error: errMsg,
        rawCaptureBundle: buildCaptureBundle(),
      };
    }
  }

  /**
   * Executes an allowlisted Solana JSON-RPC 2.0 call and captures complete request/response records (B1-PREP-01).
   * Enforces outbound request budget at the transport boundary for every call (D24F-05 / B1-PREP-03).
   */
  public async executeRpcCallWithRecord(
    method: string,
    params: unknown[],
  ): Promise<{ response: unknown; record: RawRpcInteractionRecord }> {
    if (!ALLOWLISTED_RPC_METHODS.has(method)) {
      throw new Error(
        `[FORBIDDEN_RPC_METHOD] Method '${method}' is not permitted. Only read-only methods [getAccountInfo, getMultipleAccounts] are authorized.`,
      );
    }

    if (this.maxRequestsBudget !== undefined && this.totalCalls >= this.maxRequestsBudget) {
      throw new Error(
        `[REQUEST_BUDGET_EXCEEDED] Outbound RPC call rejected: exceeded strict budget of ${this.maxRequestsBudget} requests (totalCalls: ${this.totalCalls})`,
      );
    }

    const now = Date.now();
    if (now < this.retryAfterUntilEpochMs) {
      throw new Error(
        `[RPC_THROTTLED] Solana RPC rate-limited until ${new Date(this.retryAfterUntilEpochMs).toISOString()}`,
      );
    }

    // D24F-05: Enforce rate budget on EVERY outbound RPC call
    this.enforceRateBudget();

    this.totalCalls++;
    this.lastCallEpochMs = now;
    this.methodsCalled[method] = (this.methodsCalled[method] ?? 0) + 1;

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      this.timeoutsEncountered++;
      controller.abort();
    }, this.httpTimeoutMs);

    const reqId = `pilot-req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rpcBody = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method,
      params,
    };

    const callStartEpochMs = Date.now();
    try {
      const res = await this.transport.post(this.rawRpcUrl, rpcBody, {
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - callStartEpochMs;
      this.successfulCalls++;
      this.onLog?.(`${method} call succeeded`);

      const resObj =
        res && typeof res === "object" ? (res as Record<string, unknown>) : { result: res };
      const payloadSizeBytes = Buffer.byteLength(JSON.stringify(resObj), "utf8");

      const record: RawRpcInteractionRecord = {
        request: {
          jsonrpc: "2.0",
          id: reqId,
          method,
          params,
          endpoint: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          timestampIso: new Date(callStartEpochMs).toISOString(),
          timestampEpochMs: callStartEpochMs,
        },
        response: resObj,
        timing: {
          elapsedMs,
          payloadSizeBytes,
        },
      };

      return { response: res, record };
    } catch (err) {
      const elapsedMs = Date.now() - callStartEpochMs;
      this.failedCalls++;
      if (err instanceof Error && err.message.includes("429")) {
        this.rateLimitsEncountered++;
        this.retryAfterUntilEpochMs = Date.now() + 10_000;
      }
      if (err instanceof Error && (err.name === "AbortError" || err.message.includes("timeout"))) {
        this.timeoutsEncountered++;
      }
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = this.sanitizeErrorMessage(rawErrMsg);
      this.onLog?.(`${method} call failed: ${errMsg}`);

      const record: RawRpcInteractionRecord = {
        request: {
          jsonrpc: "2.0",
          id: reqId,
          method,
          params,
          endpoint: this.sanitizedRpcUrl,
          endpointFingerprint: this.endpointFingerprint,
          timestampIso: new Date(callStartEpochMs).toISOString(),
          timestampEpochMs: callStartEpochMs,
        },
        response: null,
        timing: {
          elapsedMs,
          payloadSizeBytes: 0,
        },
        error: errMsg,
      };

      const sanitizedErr = new Error(errMsg);
      sanitizedErr.name = err instanceof Error ? err.name : "RpcError";
      if (err instanceof Error && err.stack) {
        sanitizedErr.stack = this.sanitizeErrorMessage(err.stack);
      }
      (sanitizedErr as { rpcRecord?: RawRpcInteractionRecord }).rpcRecord = record;
      throw sanitizedErr;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Executes an allowlisted Solana JSON-RPC 2.0 call.
   * Enforces outbound request budget at the transport boundary for every call (D24F-05).
   */
  public async executeRpcCall(method: string, params: unknown[]): Promise<unknown> {
    const { response } = await this.executeRpcCallWithRecord(method, params);
    return response;
  }

  private enforceRateBudget(): void {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 60_000);
    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      throw new Error(
        `[RPC_RATE_BUDGET_EXCEEDED] Solana RPC client exceeded budget of ${this.maxRequestsPerMinute} req/min`,
      );
    }
    this.requestTimestamps.push(now);
  }
}
