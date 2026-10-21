/**
 * Phase 12.94-D Milestone D.2.9-B2: Solana RPC Recording Account Fetcher
 *
 * Implements IOnChainAccountFetcher for read-only pool and vault account verification.
 * Strictly allowlists 'getAccountInfo' and 'getMultipleAccounts'.
 * Records raw wire JSON-RPC payloads for immutable B2 evidence sealing.
 *
 * Core Guarantees:
 * 1. Allowlisted Methods: Only 'getAccountInfo' and 'getMultipleAccounts' are permitted.
 * 2. Budget Ceiling: Enforces maxAccountCallsBudget; drops or rejects requests beyond budget.
 * 3. Raw Wire Preservation: Records full request, response, slot, latency, and payload size.
 * 4. Credential Redaction: Sanitizes endpoints and error messages using sanitizeSolanaRpcUrl.
 * 5. Deterministic Offline Transport: Fully injectable ISolanaRpcTransport for offline testing.
 */

import type {
  DiscoveredPoolAccountPayload,
  IOnChainAccountFetcher,
} from "./EventDiscoveryContracts.js";
import {
  type ISolanaRpcTransport,
  type RawRpcInteractionRecord,
  sanitizeSolanaRpcUrl,
} from "./SolanaRpcLiveObservationClient.js";
import type { ISharedRpcBudget } from "./SolanaRpcTransactionFetcher.js";

export const ALLOWLISTED_ACCOUNT_RPC_METHODS = new Set(["getAccountInfo", "getMultipleAccounts"]);

export interface SolanaRpcRecordingAccountFetcherOptions {
  readonly rpcUrl?: string | undefined;
  readonly transport: ISolanaRpcTransport;
  readonly commitment?: "confirmed" | "finalized" | undefined;
  readonly maxAccountCallsBudget?: number | undefined; // Hard ceiling on total account RPC calls (default: 20)
  readonly sharedBudget?: ISharedRpcBudget | undefined; // Shared cross-client RPC call budget (B2-READY-02)
  readonly httpTimeoutMs?: number | undefined;
  readonly minRequestIntervalMs?: number | undefined; // Minimum interval between outbound calls (default: 200)
  readonly onLog?: ((msg: string) => void) | undefined;
}

export class SolanaRpcRecordingAccountFetcher implements IOnChainAccountFetcher {
  private readonly rawRpcUrl: string;
  private readonly sanitizedRpcUrl: string;
  private readonly endpointHost: string;
  private readonly endpointFingerprint: string;
  private readonly sensitiveTokens: readonly string[];
  private readonly transport: ISolanaRpcTransport;
  private readonly commitment: "confirmed" | "finalized";
  private readonly maxAccountCallsBudget: number;
  private sharedBudget?: ISharedRpcBudget | undefined;
  private readonly httpTimeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly onLog?: ((msg: string) => void) | undefined;

  private totalCallsExecuted = 0;
  private maxObservedSlot = 0;
  private lastRequestEpochMs = 0;
  private retryAfterUntilEpochMs = 0;
  private readonly capturedInteractions: RawRpcInteractionRecord[] = [];

  constructor(options: SolanaRpcRecordingAccountFetcherOptions) {
    const rawUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
    const sanitized = sanitizeSolanaRpcUrl(rawUrl);
    this.rawRpcUrl = rawUrl;
    this.sanitizedRpcUrl = sanitized.sanitizedUrl;
    this.endpointHost = sanitized.host;
    this.endpointFingerprint = sanitized.endpointFingerprint;
    this.sensitiveTokens = sanitized.sensitiveTokens;
    this.transport = options.transport;
    this.commitment = options.commitment ?? "confirmed";
    this.maxAccountCallsBudget = options.maxAccountCallsBudget ?? 20;
    this.sharedBudget = options.sharedBudget;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 10_000;
    this.minRequestIntervalMs = Math.max(0, options.minRequestIntervalMs ?? 0);
    this.onLog = options.onLog;
  }

  public getCapturedInteractions(): readonly RawRpcInteractionRecord[] {
    return this.capturedInteractions;
  }

  public getCallsExecutedCount(): number {
    return this.totalCallsExecuted;
  }

  public getMinRequestIntervalMs(): number {
    return this.minRequestIntervalMs;
  }

  public getRetryAfterUntilEpochMs(): number {
    return this.retryAfterUntilEpochMs;
  }

  public getSanitizedEndpoint(): string {
    return this.sanitizedRpcUrl;
  }

  public getEndpointFingerprint(): string {
    return this.endpointFingerprint;
  }

  public setSharedBudget(sharedBudget: ISharedRpcBudget): void {
    this.sharedBudget = sharedBudget;
  }

  public sanitizeErrorMessage(text: string): string {
    if (!text) return text;
    let out = text.split(this.rawRpcUrl).join(this.sanitizedRpcUrl);
    for (const token of this.sensitiveTokens) {
      if (token && token.length > 0) {
        out = out.split(token).join("[REDACTED]");
      }
    }
    return out;
  }

  public async getSlot(): Promise<number> {
    return this.maxObservedSlot;
  }

  /**
   * Fetches a single account via allowlisted getAccountInfo.
   */
  public async getAccountInfo(address: string): Promise<DiscoveredPoolAccountPayload | null> {
    // 1. Shared total RPC ceiling check (B2-READY-02)
    if (this.sharedBudget && !this.sharedBudget.canExecute()) {
      this.onLog?.(
        `[TOTAL_RPC_BUDGET_EXCEEDED] Cannot fetch account '${address}': shared RPC ceiling reached`,
      );
      return null;
    }

    // 2. Individual account calls budget ceiling check (B2-READY-02)
    if (this.totalCallsExecuted >= this.maxAccountCallsBudget) {
      this.onLog?.(
        `[ACCOUNT_BUDGET_EXCEEDED] Cannot fetch account '${address}': reached budget ceiling of ${this.maxAccountCallsBudget} calls`,
      );
      return null;
    }

    // 3. Provider rate-limit backoff pacing
    const now = Date.now();
    if (this.retryAfterUntilEpochMs > 0 && now < this.retryAfterUntilEpochMs) {
      const backoffMs = this.retryAfterUntilEpochMs - now;
      this.onLog?.(
        `[RATE_LIMIT_BACKOFF] Pausing getAccountInfo for ${backoffMs}ms due to provider throttling`,
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, this.httpTimeoutMs)));
    }

    // 4. Inter-request pacing: enforce minimum spacing between outbound calls
    if (this.minRequestIntervalMs > 0 && this.lastRequestEpochMs > 0) {
      const elapsed = Date.now() - this.lastRequestEpochMs;
      if (elapsed < this.minRequestIntervalMs) {
        const waitMs = this.minRequestIntervalMs - elapsed;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    this.lastRequestEpochMs = Date.now();
    this.totalCallsExecuted++;
    this.sharedBudget?.recordCall();

    const reqId = `pilot-acc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rpcBody = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "getAccountInfo",
      params: [
        address,
        {
          encoding: "base64",
          commitment: this.commitment,
        },
      ],
    };

    const callStartEpochMs = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(
        new Error(`[RPC_TIMEOUT] getAccountInfo request timed out after ${this.httpTimeoutMs}ms`),
      );
    }, this.httpTimeoutMs);

    try {
      const res = await this.transport.post(this.rawRpcUrl, rpcBody, { signal: controller.signal });
      const elapsedMs = Date.now() - callStartEpochMs;

      const resObj =
        res && typeof res === "object" ? (res as Record<string, unknown>) : { result: res };
      const payloadSizeBytes = Buffer.byteLength(JSON.stringify(resObj), "utf8");

      const record: RawRpcInteractionRecord = {
        request: {
          jsonrpc: "2.0",
          id: reqId,
          method: "getAccountInfo",
          params: rpcBody.params,
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
      this.capturedInteractions.push(record);

      return this.parseAccountInfoResponse(address, resObj);
    } catch (err) {
      const elapsedMs = Date.now() - callStartEpochMs;
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = this.sanitizeErrorMessage(rawErrMsg);

      if (rawErrMsg.includes("429") || rawErrMsg.includes("RATE_LIMIT")) {
        this.retryAfterUntilEpochMs = Date.now() + 2000;
        this.onLog?.(
          `[RPC_429_THROTTLED] Provider rate limit encountered for account ${address}; backoff set to 2000ms`,
        );
      }

      this.onLog?.(`getAccountInfo failed for ${address}: ${errMsg}`);

      const record: RawRpcInteractionRecord = {
        request: {
          jsonrpc: "2.0",
          id: reqId,
          method: "getAccountInfo",
          params: rpcBody.params,
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
      this.capturedInteractions.push(record);
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Fetches multiple accounts in a single RPC round-trip via allowlisted getMultipleAccounts.
   */
  public async getMultipleAccounts(
    addresses: readonly string[],
  ): Promise<readonly (DiscoveredPoolAccountPayload | null)[]> {
    if (addresses.length === 0) {
      return [];
    }

    // 1. Shared total RPC ceiling check (B2-READY-02)
    if (this.sharedBudget && !this.sharedBudget.canExecute()) {
      this.onLog?.(
        `[TOTAL_RPC_BUDGET_EXCEEDED] Cannot fetch ${addresses.length} accounts: shared RPC ceiling reached`,
      );
      return addresses.map(() => null);
    }

    // 2. Individual account calls budget ceiling check (B2-READY-02)
    if (this.totalCallsExecuted >= this.maxAccountCallsBudget) {
      this.onLog?.(
        `[ACCOUNT_BUDGET_EXCEEDED] Cannot fetch ${addresses.length} accounts: reached budget ceiling of ${this.maxAccountCallsBudget} calls`,
      );
      return addresses.map(() => null);
    }

    // 3. Provider rate-limit backoff pacing
    const now = Date.now();
    if (this.retryAfterUntilEpochMs > 0 && now < this.retryAfterUntilEpochMs) {
      const backoffMs = this.retryAfterUntilEpochMs - now;
      this.onLog?.(
        `[RATE_LIMIT_BACKOFF] Pausing getMultipleAccounts for ${backoffMs}ms due to provider throttling`,
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, this.httpTimeoutMs)));
    }

    // 4. Inter-request pacing: enforce minimum spacing between outbound calls
    if (this.minRequestIntervalMs > 0 && this.lastRequestEpochMs > 0) {
      const elapsed = Date.now() - this.lastRequestEpochMs;
      if (elapsed < this.minRequestIntervalMs) {
        const waitMs = this.minRequestIntervalMs - elapsed;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    this.lastRequestEpochMs = Date.now();
    this.totalCallsExecuted++;
    this.sharedBudget?.recordCall();

    const reqId = `pilot-multacc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rpcBody = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "getMultipleAccounts",
      params: [
        [...addresses],
        {
          encoding: "base64",
          commitment: this.commitment,
        },
      ],
    };

    const callStartEpochMs = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(
        new Error(
          `[RPC_TIMEOUT] getMultipleAccounts request timed out after ${this.httpTimeoutMs}ms`,
        ),
      );
    }, this.httpTimeoutMs);

    try {
      const res = await this.transport.post(this.rawRpcUrl, rpcBody, { signal: controller.signal });
      const elapsedMs = Date.now() - callStartEpochMs;

      const resObj =
        res && typeof res === "object" ? (res as Record<string, unknown>) : { result: res };
      const payloadSizeBytes = Buffer.byteLength(JSON.stringify(resObj), "utf8");

      const record: RawRpcInteractionRecord = {
        request: {
          jsonrpc: "2.0",
          id: reqId,
          method: "getMultipleAccounts",
          params: rpcBody.params,
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
      this.capturedInteractions.push(record);

      return this.parseMultipleAccountsResponse(addresses, resObj);
    } catch (err) {
      const elapsedMs = Date.now() - callStartEpochMs;
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = this.sanitizeErrorMessage(rawErrMsg);

      if (rawErrMsg.includes("429") || rawErrMsg.includes("RATE_LIMIT")) {
        this.retryAfterUntilEpochMs = Date.now() + 2000;
        this.onLog?.(
          `[RPC_429_THROTTLED] Provider rate limit encountered for multiple accounts; backoff set to 2000ms`,
        );
      }

      this.onLog?.(`getMultipleAccounts failed for ${addresses.join(",")}: ${errMsg}`);

      const record: RawRpcInteractionRecord = {
        request: {
          jsonrpc: "2.0",
          id: reqId,
          method: "getMultipleAccounts",
          params: rpcBody.params,
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
      this.capturedInteractions.push(record);
      return addresses.map(() => null);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private parseAccountInfoResponse(
    address: string,
    resObj: Record<string, unknown>,
  ): DiscoveredPoolAccountPayload | null {
    const result = resObj.result as Record<string, unknown> | null | undefined;
    if (!result || typeof result !== "object") return null;

    const context = result.context as Record<string, unknown> | undefined;
    const slot = typeof context?.slot === "number" ? context.slot : 0;
    if (slot > this.maxObservedSlot) this.maxObservedSlot = slot;

    const value = result.value as Record<string, unknown> | null | undefined;
    if (!value || typeof value !== "object") return null;

    const owner = typeof value.owner === "string" ? value.owner : "";
    const lamports =
      typeof value.lamports === "number" || typeof value.lamports === "bigint" ? value.lamports : 0;

    let data: Buffer = Buffer.alloc(0);
    if (Array.isArray(value.data) && typeof value.data[0] === "string") {
      data = Buffer.from(value.data[0], "base64");
    }

    return {
      address,
      data,
      owner,
      lamports,
      slot,
    };
  }

  private parseMultipleAccountsResponse(
    addresses: readonly string[],
    resObj: Record<string, unknown>,
  ): readonly (DiscoveredPoolAccountPayload | null)[] {
    const result = resObj.result as Record<string, unknown> | null | undefined;
    if (!result || typeof result !== "object") {
      return addresses.map(() => null);
    }

    const context = result.context as Record<string, unknown> | undefined;
    const slot = typeof context?.slot === "number" ? context.slot : 0;
    if (slot > this.maxObservedSlot) this.maxObservedSlot = slot;

    const values = result.value;
    if (!Array.isArray(values)) {
      return addresses.map(() => null);
    }

    return addresses.map((address, i) => {
      const val = values[i] as Record<string, unknown> | null | undefined;
      if (!val || typeof val !== "object") return null;

      const owner = typeof val.owner === "string" ? val.owner : "";
      const lamports =
        typeof val.lamports === "number" || typeof val.lamports === "bigint" ? val.lamports : 0;

      let data: Buffer = Buffer.alloc(0);
      if (Array.isArray(val.data) && typeof val.data[0] === "string") {
        data = Buffer.from(val.data[0], "base64");
      }

      return {
        address,
        data,
        owner,
        lamports,
        slot,
      };
    });
  }
}
