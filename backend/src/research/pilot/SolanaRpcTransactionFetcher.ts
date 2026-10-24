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
  TransactionVersion,
  Version1TransactionConfig,
  VersionedTransactionAccountResolution,
  VersionedTransactionMetadata,
} from "./EventDiscoveryContracts.js";
import type { ITransactionFetcher } from "./EventDiscoveryIngestionEngine.js";
import {
  type ISolanaRpcTransport,
  type RawRpcInteractionRecord,
  sanitizeSolanaRpcUrl,
} from "./SolanaRpcLiveObservationClient.js";

export interface ISharedRpcBudget {
  canExecute(): boolean;
  recordCall(): void;
  getRemaining(): number;
  getTotalExecuted(): number;
}

export interface SolanaRpcTransactionFetcherOptions {
  readonly rpcUrl?: string | undefined;
  readonly transport: ISolanaRpcTransport;
  readonly commitment?: "confirmed" | "finalized" | undefined;
  readonly maxTransactionsBudget?: number | undefined; // Hard ceiling on getTransaction calls (default: 25)
  readonly sharedBudget?: ISharedRpcBudget | undefined; // Shared cross-client RPC call budget (B2-READY-02)
  readonly httpTimeoutMs?: number | undefined; // Request timeout in ms (default: 10000)
  readonly maxSupportedTransactionVersion?: 0 | 1 | undefined; // Supported Solana tx version (default: 1)
  readonly minRequestIntervalMs?: number | undefined; // Minimum interval between outbound calls (default: 200)
  readonly onLog?: ((msg: string) => void) | undefined;
}

export class SolanaRpcTransactionFetcher implements ITransactionFetcher {
  private readonly rawRpcUrl: string;
  private readonly sanitizedRpcUrl: string;
  private readonly endpointHost: string;
  private readonly endpointFingerprint: string;
  private readonly sensitiveTokens: readonly string[];
  private readonly transport: ISolanaRpcTransport;
  private readonly commitment: "confirmed" | "finalized";
  private readonly maxTransactionsBudget: number;
  private sharedBudget?: ISharedRpcBudget | undefined;
  private readonly httpTimeoutMs: number;
  private readonly maxSupportedTransactionVersion: 0 | 1;
  private readonly minRequestIntervalMs: number;
  private readonly onLog?: ((msg: string) => void) | undefined;

  private totalCallsExecuted = 0;
  private successfulCalls = 0;
  private failedCalls = 0;
  private lastRequestEpochMs = 0;
  private retryAfterUntilEpochMs = 0;
  private readonly capturedTransactions: RawRpcInteractionRecord[] = [];

  constructor(options: SolanaRpcTransactionFetcherOptions) {
    const rawUrl = options.rpcUrl ?? "https://api.mainnet-beta.solana.com";
    const sanitized = sanitizeSolanaRpcUrl(rawUrl);
    this.rawRpcUrl = rawUrl;
    this.sanitizedRpcUrl = sanitized.sanitizedUrl;
    this.endpointHost = sanitized.host;
    this.endpointFingerprint = sanitized.endpointFingerprint;
    this.sensitiveTokens = sanitized.sensitiveTokens;
    this.transport = options.transport;
    this.commitment = options.commitment ?? "confirmed";
    this.maxTransactionsBudget = options.maxTransactionsBudget ?? 25;
    this.sharedBudget = options.sharedBudget;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 10_000;
    this.maxSupportedTransactionVersion = options.maxSupportedTransactionVersion ?? 1;
    this.minRequestIntervalMs = Math.max(0, options.minRequestIntervalMs ?? 0);
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

  public getMinRequestIntervalMs(): number {
    return this.minRequestIntervalMs;
  }

  public getRetryAfterUntilEpochMs(): number {
    return this.retryAfterUntilEpochMs;
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

  /**
   * Fetches and parses a versioned transaction from Solana RPC.
   * Enforces maxTransactionsBudget boundary, shared RPC budget, per-request timeout,
   * provider-aware pacing, rate-limit backoff, and records raw wire evidence.
   */
  public async fetchTransaction(
    signature: string,
    options?: { readonly deadlineEpochMs?: number | undefined },
  ): Promise<VersionedTransactionMetadata | null> {
    const now = Date.now();
    if (options?.deadlineEpochMs !== undefined && now >= options.deadlineEpochMs) {
      this.onLog?.(
        `[RPC_DEADLINE_EXCEEDED] Skipping getTransaction for ${signature}: session deadline reached`,
      );
      return null;
    }

    // 1. Shared total RPC ceiling check (B2-READY-02)
    if (this.sharedBudget && !this.sharedBudget.canExecute()) {
      this.onLog?.(
        `[TOTAL_RPC_BUDGET_EXCEEDED] Cannot fetch transaction '${signature}': shared RPC ceiling reached`,
      );
      return null;
    }

    // 2. Individual transaction budget ceiling check (B2-READY-02)
    if (this.totalCallsExecuted >= this.maxTransactionsBudget) {
      this.onLog?.(
        `[TRANSACTION_BUDGET_EXCEEDED] Cannot fetch signature '${signature}': exceeded ceiling of ${this.maxTransactionsBudget} calls`,
      );
      return null;
    }

    // 3. Provider rate-limit backoff pacing (respect 429 retry-after bounded by deadline)
    if (this.retryAfterUntilEpochMs > 0 && now < this.retryAfterUntilEpochMs) {
      const backoffMs = this.retryAfterUntilEpochMs - now;
      if (options?.deadlineEpochMs !== undefined && now + backoffMs >= options.deadlineEpochMs) {
        this.onLog?.(
          `[RPC_DEADLINE_EXCEEDED] Skipping getTransaction for ${signature}: rate limit backoff ${backoffMs}ms would exceed deadline`,
        );
        return null;
      }
      this.onLog?.(
        `[RATE_LIMIT_BACKOFF] Pausing getTransaction for ${backoffMs}ms due to provider throttling`,
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, this.httpTimeoutMs)));
    }

    // 4. Inter-request pacing: enforce minimum spacing between outbound calls (bounded by deadline)
    if (this.minRequestIntervalMs > 0 && this.lastRequestEpochMs > 0) {
      const elapsed = Date.now() - this.lastRequestEpochMs;
      if (elapsed < this.minRequestIntervalMs) {
        const waitMs = this.minRequestIntervalMs - elapsed;
        if (
          options?.deadlineEpochMs !== undefined &&
          Date.now() + waitMs >= options.deadlineEpochMs
        ) {
          this.onLog?.(
            `[RPC_DEADLINE_EXCEEDED] Skipping getTransaction for ${signature}: pacing wait ${waitMs}ms would exceed deadline`,
          );
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }

    // Post-wait deadline check
    if (options?.deadlineEpochMs !== undefined && Date.now() >= options.deadlineEpochMs) {
      this.onLog?.(
        `[RPC_DEADLINE_EXCEEDED] Skipping getTransaction for ${signature}: session deadline reached after wait`,
      );
      return null;
    }

    this.lastRequestEpochMs = Date.now();
    this.totalCallsExecuted++;
    this.sharedBudget?.recordCall();

    const reqId = `pilot-tx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rpcBody = {
      jsonrpc: "2.0" as const,
      id: reqId,
      method: "getTransaction",
      params: [
        signature,
        {
          encoding: "json",
          maxSupportedTransactionVersion: this.maxSupportedTransactionVersion,
          commitment: this.commitment,
        },
      ],
    };

    const callStartEpochMs = Date.now();
    const remainingToDeadline =
      options?.deadlineEpochMs !== undefined
        ? Math.max(1, options.deadlineEpochMs - callStartEpochMs)
        : this.httpTimeoutMs;
    const effectiveTimeoutMs = Math.min(this.httpTimeoutMs, remainingToDeadline);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort(
        new Error(`[RPC_TIMEOUT] getTransaction request timed out after ${effectiveTimeoutMs}ms`),
      );
    }, effectiveTimeoutMs);

    try {
      const res = await this.transport.post(this.rawRpcUrl, rpcBody, { signal: controller.signal });
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

      return SolanaRpcTransactionFetcher.parseTransactionResponse(signature, resObj, this.onLog);
    } catch (err) {
      const elapsedMs = Date.now() - callStartEpochMs;
      this.failedCalls++;
      const rawErrMsg = err instanceof Error ? err.message : String(err);
      const errMsg = this.sanitizeErrorMessage(rawErrMsg);

      // Provider rate limit tracking: bounded retry-after header or fixed fallback (B2-NEXT-02)
      if (rawErrMsg.includes("429") || rawErrMsg.includes("RATE_LIMIT")) {
        const match = rawErrMsg.match(/retryAfter=(\d+)s/);
        const parsedSecs = match ? parseInt(match[1]!, 10) : undefined;
        const delaySecs =
          parsedSecs && Number.isFinite(parsedSecs) && parsedSecs > 0
            ? Math.min(parsedSecs, 10)
            : 2;
        this.retryAfterUntilEpochMs = Date.now() + delaySecs * 1000;
        this.onLog?.(
          `[RPC_429_THROTTLED] Provider rate limit encountered for ${signature}; backoff set to ${delaySecs * 1000}ms (${parsedSecs ? "from header" : "fixed fallback"})`,
        );
      }

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
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /**
   * Translates raw getTransaction JSON response into VersionedTransactionMetadata.
   */
  public static parseTransactionResponse(
    signature: string,
    response: Record<string, unknown>,
    onLog?: ((msg: string) => void) | undefined,
  ): VersionedTransactionMetadata | null {
    const result = response.result as Record<string, unknown> | null | undefined;
    if (!result || typeof result !== "object") {
      return null;
    }

    // B2-READY-03: Never assign fabricated slot 0; fail closed on missing or non-positive slot
    if (typeof result.slot !== "number" || result.slot <= 0 || Number.isNaN(result.slot)) {
      onLog?.(
        `[MALFORMED_TRANSACTION_SLOT] Rejecting getTransaction for '${signature}': slot is missing, non-numeric, or zero`,
      );
      return null;
    }
    const slot = result.slot;
    const blockTime = typeof result.blockTime === "number" ? result.blockTime : null;
    const meta = result.meta as Record<string, unknown> | null | undefined;
    const transaction = result.transaction as Record<string, unknown> | null | undefined;
    const message = transaction?.message as Record<string, unknown> | null | undefined;

    if (!message) {
      return null;
    }

    const err = meta?.err ?? null;
    const rawVersion = result.version;
    const version: TransactionVersion =
      rawVersion === 1
        ? 1
        : rawVersion === 0
          ? 0
          : typeof rawVersion === "number"
            ? rawVersion
            : "legacy";

    // 1. Account Keys resolution (Static + ALTs)
    // Note: Version 1 transactions (SIMD-0385) store all addresses inline and drop ALTs.
    // Address Lookup Tables (ALTs) are strictly supported for version 0 (v0).
    const rawAccountKeys = message.accountKeys;
    const staticAccountKeys: string[] = Array.isArray(rawAccountKeys)
      ? rawAccountKeys.map((k) => (typeof k === "string" ? k : (k?.pubkey ?? "")))
      : [];

    let loadedAddresses: VersionedTransactionAccountResolution["loadedAddresses"] = undefined;
    if (version !== 1) {
      const rawLoaded = meta?.loadedAddresses as Record<string, unknown> | undefined;
      if (rawLoaded && (Array.isArray(rawLoaded.writable) || Array.isArray(rawLoaded.readonly))) {
        loadedAddresses = {
          writable: Array.isArray(rawLoaded.writable) ? (rawLoaded.writable as string[]) : [],
          readonly: Array.isArray(rawLoaded.readonly) ? (rawLoaded.readonly as string[]) : [],
        };
      }
    }

    const accountKeys: VersionedTransactionAccountResolution = {
      staticAccountKeys,
      loadedAddresses,
    };

    // First-class resource configuration for Version 1 transactions (SIMD-0385 / txv1)
    let transactionConfig: Version1TransactionConfig | undefined = undefined;
    const rawTxConfig =
      (message.transactionConfig as Record<string, unknown> | undefined) ??
      (transaction?.transactionConfig as Record<string, unknown> | undefined);
    if (rawTxConfig && typeof rawTxConfig === "object") {
      const rawFee = rawTxConfig.priorityFee ?? rawTxConfig.priorityFeeLamports;
      transactionConfig = {
        computeUnitLimit:
          typeof rawTxConfig.computeUnitLimit === "number"
            ? rawTxConfig.computeUnitLimit
            : undefined,
        priorityFeeLamports:
          typeof rawFee === "number" || typeof rawFee === "bigint" ? rawFee : undefined,
        loadedAccountsDataSizeLimit:
          typeof rawTxConfig.loadedAccountsDataSizeLimit === "number"
            ? rawTxConfig.loadedAccountsDataSizeLimit
            : undefined,
        heapSize: typeof rawTxConfig.heapSize === "number" ? rawTxConfig.heapSize : undefined,
      };
    }

    // 2. Compiled Instructions
    const rawInstructions = message.instructions;
    const instructions: CompiledInstruction[] = [];
    if (Array.isArray(rawInstructions)) {
      for (const inst of rawInstructions) {
        if (!inst || typeof inst !== "object") continue;
        const programIdIndex = typeof inst.programIdIndex === "number" ? inst.programIdIndex : -1;
        if (programIdIndex < 0) {
          onLog?.(
            `[MALFORMED_INSTRUCTION] Invalid programIdIndex for instruction in signature '${signature}'`,
          );
          return null;
        }
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
            const programIdIndex =
              typeof inst.programIdIndex === "number" ? inst.programIdIndex : -1;
            if (programIdIndex < 0) continue;
            groupInstructions.push({
              programIdIndex,
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
      ...(transactionConfig ? { transactionConfig } : {}),
    };
  }
}
