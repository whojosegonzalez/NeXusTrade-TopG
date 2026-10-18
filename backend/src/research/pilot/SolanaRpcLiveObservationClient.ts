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
import { RAYDIUM_AMM_V4_PROGRAM_ID, computeReserveAccounting } from "./RaydiumAmmParser.js";
import type { D23ObservationRecord, D23ReserveAccounting } from "./PilotTypes.js";

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
