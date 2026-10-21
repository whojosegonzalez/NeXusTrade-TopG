/**
 * Phase 12.94-D Milestone D.2.9-B2: Solana RPC Read-Only Transaction Fetcher
 *
 * Implements decoupled read-only transaction fetching (getTransaction) over Solana JSON-RPC.
 * Conforms to ITransactionFetcher for direct ingestion by EventDiscoveryIngestionEngine.
 *
 * Core Guarantees:
 * 1. Allowlisted Method: Strictly calls 'getTransaction'.
 * 2. Versioned Transaction Decoding: Parses legacy and version 0 (v0) transactions, Address Lookup Tables (ALTs),
 *    compiled instructions, inner instructions (CPI), and execution logs.
 * 3. Budget Boundary: Hard ceiling on total transaction fetches; rejects calls exceeding budget.
 * 4. Raw Wire Record Preservation: Records full JSON-RPC request and response payloads for immutable evidence sealing.
 * 5. Credential Sanitization: Guaranteed zero credential leakage into recorded metadata or logs.
 */

import type {
  CompiledInstruction,
  InnerInstructionGroup,
  VersionedTransactionAccountResolution,
  VersionedTransactionMetadata,
} from "./EventDiscoveryContracts.js";
import type { ITransactionFetcher } from "./EventDiscoveryIngestionEngine.js";
import {
  type ISolanaRpcTransport,
  type RawRpcInteractionRecord,
  sanitizeSolanaRpcUrl,
} from "./SolanaRpcLiveObservationClient.js";

export interface SolanaRpcTransactionFetcherOptions {
  readonly rpcUrl?: string | undefined;
  readonly transport: ISolanaRpcTransport;
  readonly commitment?: "confirmed" | "finalized" | undefined;
  readonly maxTransactionsBudget?: number | undefined; // Hard ceiling on getTransaction calls (default: 25)
  readonly httpTimeoutMs?: number | undefined; // Request timeout in ms (default: 10000)
  readonly onLog?: ((msg: string) => void) | undefined;
}

export class SolanaRpcTransactionFetcher implements ITransactionFetcher {
  private readonly rawRpcUrl: string;
  private readonly sanitizedRpcUrl: string;
  private readonly endpointHost: string;
  private readonly endpointFingerprint: string;
  private readonly transport: ISolanaRpcTransport;
  private readonly commitment: "confirmed" | "finalized";
  private readonly maxTransactionsBudget: number;
  private readonly httpTimeoutMs: number;
  private readonly onLog?: ((msg: string) => void) | undefined;

  private totalCallsExecuted = 0;
  private successfulCalls = 0;
  private failedCalls = 0;
  private readonly capturedTransactions: RawRpcInteractionRecord[] = [];

  constructor(options: SolanaRpcTransactionFetcherOptions) {
    const rawUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
    const sanitized = sanitizeSolanaRpcUrl(rawUrl);
    this.rawRpcUrl = rawUrl;
    this.sanitizedRpcUrl = sanitized.sanitizedUrl;
    this.endpointHost = sanitized.host;
    this.endpointFingerprint = sanitized.endpointFingerprint;
    this.transport = options.transport;
    this.commitment = options.commitment ?? "confirmed";
    this.maxTransactionsBudget = options.maxTransactionsBudget ?? 25;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 10_000;
    this.onLog = options.onLog;
  }

  public getCapturedTransactions(): readonly RawRpcInteractionRecord[] {
    return this.capturedTransactions;
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

  public getEndpointHost(): string {
    return this.endpointHost;
  }

  /**
   * Fetches and parses a versioned transaction from Solana RPC.
   * Enforces maxTransactionsBudget boundary and records raw wire evidence.
   */
  public async fetchTransaction(signature: string): Promise<VersionedTransactionMetadata | null> {
    if (this.totalCallsExecuted >= this.maxTransactionsBudget) {
      this.onLog?.(
        `[TRANSACTION_BUDGET_EXCEEDED] Cannot fetch signature '${signature}': exceeded ceiling of ${this.maxTransactionsBudget} calls`,
      );
      return null;
    }

    this.totalCallsExecuted++;
    const reqId = `pilot-tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rpcBody = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "getTransaction",
      params: [
        signature,
        {
          encoding: "json",
          maxSupportedTransactionVersion: 0,
          commitment: this.commitment,
        },
      ],
    };

    const callStartEpochMs = Date.now();
    try {
      const res = await this.transport.post(this.rawRpcUrl, rpcBody);
      const elapsedMs = Date.now() - callStartEpochMs;
      this.successfulCalls++;

      const resObj =
        res && typeof res === "object" ? (res as Record<string, unknown>) : { result: res };
      const payloadSizeBytes = Buffer.byteLength(JSON.stringify(resObj), "utf8");

      const record: RawRpcInteractionRecord = {
        request: {
          jsonrpc: "2.0",
          id: reqId,
          method: "getTransaction",
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
      this.capturedTransactions.push(record);

      return this.parseTransactionResponse(signature, resObj);
    } catch (err) {
      const elapsedMs = Date.now() - callStartEpochMs;
      this.failedCalls++;
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = rawErrMsg.split(this.rawRpcUrl).join(this.sanitizedRpcUrl);
      this.onLog?.(`getTransaction failed for ${signature}: ${errMsg}`);

      const record: RawRpcInteractionRecord = {
        request: {
          jsonrpc: "2.0",
          id: reqId,
          method: "getTransaction",
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
      this.capturedTransactions.push(record);
      return null;
    }
  }

  /**
   * Translates raw getTransaction JSON response into VersionedTransactionMetadata.
   */
  private parseTransactionResponse(
    signature: string,
    response: Record<string, unknown>,
  ): VersionedTransactionMetadata | null {
    const result = response.result as Record<string, unknown> | null | undefined;
    if (!result || typeof result !== "object") {
      return null;
    }

    const slot = typeof result.slot === "number" ? result.slot : 0;
    const blockTime = typeof result.blockTime === "number" ? result.blockTime : null;
    const meta = result.meta as Record<string, unknown> | null | undefined;
    const transaction = result.transaction as Record<string, unknown> | null | undefined;
    const message = transaction?.message as Record<string, unknown> | null | undefined;

    if (!message) {
      return null;
    }

    const err = meta?.err ?? null;
    const rawVersion = result.version;
    const version: "legacy" | 0 = rawVersion === 0 ? 0 : "legacy";

    // 1. Account Keys resolution (Static + ALTs)
    const rawAccountKeys = message.accountKeys;
    const staticAccountKeys: string[] = Array.isArray(rawAccountKeys)
      ? rawAccountKeys.map((k) => (typeof k === "string" ? k : (k?.pubkey ?? "")))
      : [];

    let loadedAddresses: VersionedTransactionAccountResolution["loadedAddresses"] = undefined;
    const rawLoaded = meta?.loadedAddresses as Record<string, unknown> | undefined;
    if (rawLoaded && (Array.isArray(rawLoaded.writable) || Array.isArray(rawLoaded.readonly))) {
      loadedAddresses = {
        writable: Array.isArray(rawLoaded.writable) ? (rawLoaded.writable as string[]) : [],
        readonly: Array.isArray(rawLoaded.readonly) ? (rawLoaded.readonly as string[]) : [],
      };
    }

    const accountKeys: VersionedTransactionAccountResolution = {
      staticAccountKeys,
      loadedAddresses,
    };

    // 2. Compiled Instructions
    const rawInstructions = message.instructions;
    const instructions: CompiledInstruction[] = [];
    if (Array.isArray(rawInstructions)) {
      for (const inst of rawInstructions) {
        if (!inst || typeof inst !== "object") continue;
        const programIdIndex = typeof inst.programIdIndex === "number" ? inst.programIdIndex : 0;
        const accountKeyIndexes = Array.isArray(inst.accounts)
          ? (inst.accounts as number[])
          : Array.isArray(inst.accountKeyIndexes)
            ? (inst.accountKeyIndexes as number[])
            : [];
        const data = inst.data ?? "";
        instructions.push({
          programIdIndex,
          accountKeyIndexes,
          data,
          dataEncoding: typeof data === "string" ? "base58" : "raw",
        });
      }
    }

    // 3. Inner Instructions (CPI calls)
    let innerInstructions: InnerInstructionGroup[] | undefined = undefined;
    const rawInner = meta?.innerInstructions;
    if (Array.isArray(rawInner)) {
      innerInstructions = [];
      for (const group of rawInner) {
        if (!group || typeof group !== "object") continue;
        const index = typeof group.index === "number" ? group.index : 0;
        const groupInstructions: CompiledInstruction[] = [];
        if (Array.isArray(group.instructions)) {
          for (const inst of group.instructions) {
            if (!inst || typeof inst !== "object") continue;
            groupInstructions.push({
              programIdIndex: typeof inst.programIdIndex === "number" ? inst.programIdIndex : 0,
              accountKeyIndexes: Array.isArray(inst.accounts) ? (inst.accounts as number[]) : [],
              data: inst.data ?? "",
              dataEncoding: typeof inst.data === "string" ? "base58" : "raw",
            });
          }
        }
        innerInstructions.push({
          index,
          instructions: groupInstructions,
        });
      }
    }

    // 4. Log Messages
    const logMessages = Array.isArray(meta?.logMessages)
      ? (meta.logMessages as string[])
      : undefined;

    return {
      signature,
      slot,
      blockTime,
      err,
      version,
      accountKeys,
      instructions,
      innerInstructions,
      logMessages,
    };
  }
}
