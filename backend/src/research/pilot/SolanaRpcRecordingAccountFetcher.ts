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

export const ALLOWLISTED_ACCOUNT_RPC_METHODS = new Set(["getAccountInfo", "getMultipleAccounts"]);

export interface SolanaRpcRecordingAccountFetcherOptions {
  readonly rpcUrl?: string | undefined;
  readonly transport: ISolanaRpcTransport;
  readonly commitment?: "confirmed" | "finalized" | undefined;
  readonly maxAccountCallsBudget?: number | undefined; // Hard ceiling on total account RPC calls (default: 20)
  readonly httpTimeoutMs?: number | undefined;
  readonly onLog?: ((msg: string) => void) | undefined;
}

export class SolanaRpcRecordingAccountFetcher implements IOnChainAccountFetcher {
  private readonly rawRpcUrl: string;
  private readonly sanitizedRpcUrl: string;
  private readonly endpointHost: string;
  private readonly endpointFingerprint: string;
  private readonly transport: ISolanaRpcTransport;
  private readonly commitment: "confirmed" | "finalized";
  private readonly maxAccountCallsBudget: number;
  private readonly httpTimeoutMs: number;
  private readonly onLog?: ((msg: string) => void) | undefined;

  private totalCallsExecuted = 0;
  private maxObservedSlot = 0;
  private readonly capturedInteractions: RawRpcInteractionRecord[] = [];

  constructor(options: SolanaRpcRecordingAccountFetcherOptions) {
    const rawUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
    const sanitized = sanitizeSolanaRpcUrl(rawUrl);
    this.rawRpcUrl = rawUrl;
    this.sanitizedRpcUrl = sanitized.sanitizedUrl;
    this.endpointHost = sanitized.host;
    this.endpointFingerprint = sanitized.endpointFingerprint;
    this.transport = options.transport;
    this.commitment = options.commitment ?? "confirmed";
    this.maxAccountCallsBudget = options.maxAccountCallsBudget ?? 20;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 10_000;
    this.onLog = options.onLog;
  }

  public getCapturedInteractions(): readonly RawRpcInteractionRecord[] {
    return this.capturedInteractions;
  }

  public getCallsExecutedCount(): number {
    return this.totalCallsExecuted;
  }

  public getSanitizedEndpoint(): string {
    return this.sanitizedRpcUrl;
  }

  public getEndpointFingerprint(): string {
    return this.endpointFingerprint;
  }

  public async getSlot(): Promise<number> {
    return this.maxObservedSlot;
  }

  /**
   * Fetches a single account via allowlisted getAccountInfo.
   */
  public async getAccountInfo(address: string): Promise<DiscoveredPoolAccountPayload | null> {
    if (this.totalCallsExecuted >= this.maxAccountCallsBudget) {
      this.onLog?.(
        `[ACCOUNT_BUDGET_EXCEEDED] Cannot fetch account '${address}': reached budget ceiling of ${this.maxAccountCallsBudget} calls`,
      );
      return null;
    }

    this.totalCallsExecuted++;
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
    try {
      const res = await this.transport.post(this.rawRpcUrl, rpcBody);
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
      const errMsg = rawErrMsg.split(this.rawRpcUrl).join(this.sanitizedRpcUrl);
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

    if (this.totalCallsExecuted >= this.maxAccountCallsBudget) {
      this.onLog?.(
        `[ACCOUNT_BUDGET_EXCEEDED] Cannot fetch ${addresses.length} accounts: reached budget ceiling of ${this.maxAccountCallsBudget} calls`,
      );
      return addresses.map(() => null);
    }

    this.totalCallsExecuted++;
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
    try {
      const res = await this.transport.post(this.rawRpcUrl, rpcBody);
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
      const errMsg = rawErrMsg.split(this.rawRpcUrl).join(this.sanitizedRpcUrl);
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
