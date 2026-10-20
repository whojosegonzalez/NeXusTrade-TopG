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

export interface ISolanaRpcTransport {
  post(url: string, body: Record<string, unknown>, init?: RequestInit): Promise<unknown>;
}

export interface SolanaRpcClientOptions {
  readonly rpcUrl?: string | undefined;
  readonly httpTimeoutMs?: number | undefined;
  readonly maxRequestsPerMinute?: number | undefined;
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
  readonly verificationStatus:
    | "VERIFIED_RAYDIUM_CPMM"
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
}

export class SolanaRpcLiveObservationClient {
  private readonly rpcUrl: string;
  private readonly httpTimeoutMs: number;
  private readonly maxRequestsPerMinute: number;
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
    this.rpcUrl = options?.rpcUrl ?? DEFAULT_SOLANA_MAINNET_RPC;
    this.httpTimeoutMs = options?.httpTimeoutMs ?? 5_000;
    this.maxRequestsPerMinute = options?.maxRequestsPerMinute ?? 60;
    this.transport = options?.transport ?? {
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
          this.retryAfterUntilEpochMs = Date.now() + (Number.isFinite(secs) ? secs : 10) * 1000;
          throw new Error(`[RPC_RATE_LIMIT_429] Solana RPC responded with 429 Too Many Requests`);
        }
        if (!res.ok) {
          throw new Error(`[RPC_HTTP_ERROR] Solana RPC HTTP status ${res.status}`);
        }
        return await res.json();
      },
    };
    this.onLog = options?.onLog;
  }

  public getRpcUrl(): string {
    return this.rpcUrl;
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
        providerIdentity: `solana_rpc:${new URL(this.rpcUrl).hostname}`,
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
      const errMsg = err instanceof Error ? err.message : String(err);
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
        rpcUrl: this.rpcUrl,
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
        rpcUrl: this.rpcUrl,
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
          rpcUrl: this.rpcUrl,
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
          rpcUrl: this.rpcUrl,
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
          rpcUrl: this.rpcUrl,
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
        rpcUrl: this.rpcUrl,
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
      const errMsg = err instanceof Error ? err.message : String(err);
      const is429 = errMsg.includes("429");
      const isTimeout =
        errMsg.includes("timeout") || (err instanceof Error && err.name === "AbortError");
      const status = is429 ? "RATE_LIMITED_429" : isTimeout ? "RPC_ERROR" : "RPC_ERROR";
      return {
        poolAddress,
        rpcUrl: this.rpcUrl,
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

    if (!isCanonicalSolanaBase58(poolAddress)) {
      this.poolsFailed++;
      return {
        poolAddress,
        rpcUrl: this.rpcUrl,
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
      // 1. Fetch Pool State Account
      const rawPoolResponse = (await this.executeRpcCall("getAccountInfo", [
        poolAddress,
        { encoding: "base64" },
      ])) as Record<string, unknown> | null;

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
      const poolSlot = poolInfoResponse?.context?.slot ?? null;

      if (!poolVal) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.rpcUrl,
          verificationStatus: "NULL_ACCOUNT",
          verified: false,
          onChainSlot: poolSlot,
          poolSlot,
          vault0Slot: null,
          vault1Slot: null,
          slotDiscrepancy: false,
          error: "CPMM pool account not found on-chain",
        };
      }

      if (poolVal.owner !== RAYDIUM_CPMM_PROGRAM_ID) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.rpcUrl,
          verificationStatus: "UNAUTHORIZED_PROGRAM_ID",
          verified: false,
          onChainSlot: poolSlot,
          poolSlot,
          vault0Slot: null,
          vault1Slot: null,
          slotDiscrepancy: false,
          programOwner: poolVal.owner,
          error: `Unauthorized pool owner: expected ${RAYDIUM_CPMM_PROGRAM_ID}, got ${poolVal.owner}`,
        };
      }

      const poolDataB64 = poolVal.data?.[0];
      if (!poolDataB64) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.rpcUrl,
          verificationStatus: "MALFORMED_POOL_DATA",
          verified: false,
          onChainSlot: poolSlot,
          poolSlot,
          vault0Slot: null,
          vault1Slot: null,
          slotDiscrepancy: false,
          error: "Empty pool account data payload",
        };
      }

      const poolBuffer = Buffer.from(poolDataB64, "base64");
      const cpmmParseResult = parseRaydiumCpmmAccount(
        poolBuffer,
        poolAddress,
        poolVal.owner,
        poolSlot ?? 0,
      );

      if (!cpmmParseResult.ok) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.rpcUrl,
          verificationStatus: "MALFORMED_POOL_DATA",
          verified: false,
          onChainSlot: poolSlot,
          poolSlot,
          vault0Slot: null,
          vault1Slot: null,
          slotDiscrepancy: false,
          error: `Failed to decode CPMM pool state: ${cpmmParseResult.message}`,
        };
      }

      const poolState = cpmmParseResult.state;

      // 2. Fetch Vault Accounts
      const rawVaultsResponse = (await this.executeRpcCall("getMultipleAccounts", [
        [poolState.token0Vault, poolState.token1Vault],
        { encoding: "base64" },
      ])) as Record<string, unknown> | null;

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

      const vaultsSlot = vaultsResponse?.context?.slot ?? null;
      const v0Account = vaultsResponse?.value?.[0];
      const v1Account = vaultsResponse?.value?.[1];

      if (!v0Account || !v1Account || !v0Account.data?.[0] || !v1Account.data?.[0]) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.rpcUrl,
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
        vaultsSlot ?? poolSlot ?? 0,
      );

      const v1Parsed = parseCpmmVaultAccount(
        v1Buf,
        poolState.token1Vault,
        poolState.token1Vault,
        poolState.token1Mint,
        poolState.token1Program,
        v1Account.owner ?? "",
        vaultsSlot ?? poolSlot ?? 0,
      );

      if (!v0Parsed.ok) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.rpcUrl,
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
        };
      }

      if (!v1Parsed.ok) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.rpcUrl,
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
        };
      }

      // 3. Compute Reserve Accounting
      const slotDiscrepancy = Boolean(
        poolSlot !== null && vaultsSlot !== null && Math.abs(poolSlot - vaultsSlot) > 2,
      );

      const reserveResult = computeCpmmReserveAccounting(
        poolState,
        v0Parsed.snapshot,
        v1Parsed.snapshot,
      );

      if (!reserveResult.ok) {
        this.poolsFailed++;
        return {
          poolAddress,
          rpcUrl: this.rpcUrl,
          verificationStatus: "VAULT_VERIFICATION_FAILED",
          verified: false,
          onChainSlot: vaultsSlot ?? poolSlot,
          poolSlot,
          vault0Slot: vaultsSlot,
          vault1Slot: vaultsSlot,
          slotDiscrepancy,
          programOwner: poolVal.owner,
          token0Mint: poolState.token0Mint,
          token1Mint: poolState.token1Mint,
          token0Vault: poolState.token0Vault,
          token1Vault: poolState.token1Vault,
          error: `Reserve accounting failed: ${reserveResult.message}`,
        };
      }

      const accounting = reserveResult.accounting;
      const isCoherent =
        accounting.verificationTier === "INDEPENDENTLY_COHERENT" && !slotDiscrepancy;

      this.poolsSuccessful++;
      if (slotDiscrepancy) {
        this.slotDiscrepancies++;
      }

      return {
        poolAddress,
        rpcUrl: this.rpcUrl,
        verificationStatus: isCoherent ? "VERIFIED_RAYDIUM_CPMM" : "VAULT_VERIFICATION_FAILED",
        verified: isCoherent,
        verificationTier: accounting.verificationTier,
        onChainSlot: vaultsSlot ?? poolSlot,
        poolSlot,
        vault0Slot: vaultsSlot,
        vault1Slot: vaultsSlot,
        slotDiscrepancy,
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
      };
    } catch (err: unknown) {
      this.poolsFailed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      const is429 = errMsg.includes("429");
      const isTimeout =
        errMsg.includes("timeout") || (err instanceof Error && err.name === "AbortError");
      const status = is429 ? "RATE_LIMITED_429" : isTimeout ? "RPC_ERROR" : "RPC_ERROR";
      return {
        poolAddress,
        rpcUrl: this.rpcUrl,
        verificationStatus: status,
        verified: false,
        onChainSlot: null,
        poolSlot: null,
        vault0Slot: null,
        vault1Slot: null,
        slotDiscrepancy: false,
        hostElapsedMs: Date.now() - requestEpochMs,
        error: errMsg,
      };
    }
  }

  /**
   * Executes an allowlisted Solana JSON-RPC 2.0 call.
   * Enforces outbound request budget at the transport boundary for every call (D24F-05).
   */
  public async executeRpcCall(method: string, params: unknown[]): Promise<unknown> {
    if (!ALLOWLISTED_RPC_METHODS.has(method)) {
      throw new Error(
        `[FORBIDDEN_RPC_METHOD] Method '${method}' is not permitted. Only read-only methods [getAccountInfo, getMultipleAccounts] are authorized.`,
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

    const rpcBody = {
      jsonrpc: "2.0",
      id: `pilot-req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      method,
      params,
    };

    try {
      const res = await this.transport.post(this.rpcUrl, rpcBody, {
        signal: controller.signal,
      });
      this.successfulCalls++;
      this.onLog?.(`${method} call succeeded`);
      return res;
    } catch (err) {
      this.failedCalls++;
      if (err instanceof Error && err.message.includes("429")) {
        this.rateLimitsEncountered++;
        this.retryAfterUntilEpochMs = Date.now() + 10_000;
      }
      if (err instanceof Error && (err.name === "AbortError" || err.message.includes("timeout"))) {
        this.timeoutsEncountered++;
      }
      this.onLog?.(`${method} call failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      clearTimeout(timeout);
    }
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
