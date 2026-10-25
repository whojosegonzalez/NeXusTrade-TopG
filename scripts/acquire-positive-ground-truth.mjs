#!/usr/bin/env node
/**
 * Phase 12.94-D.2.9-C2: Bounded Read-Only Historical Ground-Truth Positive Acquisition
 *
 * Implements bounded, read-only acquisition of authentic historical Raydium AMM v4 and CPMM
 * pool initialization transactions from Solana mainnet ledger history.
 *
 * Requirements & Audited Constraints:
 * 1. Read-Only Methods: Strictly getSignaturesForAddress, getTransaction, and getAccountInfo.
 * 2. Version Support (Correction 1): maxSupportedTransactionVersion: 1 (supports legacy, v0, v1).
 * 3. History Boundary (Correction 2): Up to 2 pages of getSignaturesForAddress per seed; if
 *    history is incomplete within budget or oldest tx is not initialization, seed is marked
 *    UNRESOLVED_GENESIS_NOT_REACHED; never invent or assume a creation signature.
 * 4. Independent Ground Truth (Correction 3): Positive status established strictly from
 *    on-chain instruction discriminators, program IDs, and pool address accounts, independent
 *    of production parser result. Does not require SystemProgram.createAccount. Missed
 *    initializations by production parser are recorded as FALSE_NEGATIVE.
 * 5. Resource Ceilings & Retries (Correction 4):
 *    - Max 12 candidate seeds.
 *    - Max 24 getSignaturesForAddress calls (max 2 per seed).
 *    - Max 20 getTransaction calls.
 *    - Max 10 getAccountInfo calls.
 *    - Hard ceiling of 54 TOTAL RPC requests. Every retry counts toward all applicable ceilings.
 *    - getTransaction: null classified as UNAVAILABLE (not automatically proven pruned).
 *    - Early termination when target >= 5 AMM v4 and >= 5 CPMM initializations reached.
 *    - 1,000ms inter-request pacing; 10,000ms timeout; exponential 429 backoff; circuit breaker at 3 consecutive errors.
 * 6. Cryptographic Manifest Sealing: Generates canonical SHA-256 session-manifest.json.
 * 7. Operator Authorization Gate: Requires explicit --authorize-c2-acquisition AND --network=enabled flags.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "backend", "dist");

// Dynamic imports from compiled backend
let classifyNotificationLogs;
let identifyPoolInitializationInstructions;
let SolanaRpcTransactionFetcher;
let decodeBase58;

export async function loadBackendDependencies() {
  if (classifyNotificationLogs && identifyPoolInitializationInstructions) {
    return;
  }
  const engineMod = await import(
    pathToFileURL(path.join(distDir, "research", "pilot", "EventDiscoveryIngestionEngine.js")).href
  );
  classifyNotificationLogs = engineMod.classifyNotificationLogs;

  const parserMod = await import(
    pathToFileURL(path.join(distDir, "research", "pilot", "PoolInitializationParser.js")).href
  );
  identifyPoolInitializationInstructions = parserMod.identifyPoolInitializationInstructions;

  const fetcherMod = await import(
    pathToFileURL(path.join(distDir, "research", "pilot", "SolanaRpcTransactionFetcher.js")).href
  );
  SolanaRpcTransactionFetcher = fetcherMod.SolanaRpcTransactionFetcher;

  const mintParserMod = await import(
    pathToFileURL(path.join(distDir, "providers", "solana-rpc", "SolanaRpcMintAccountParser.js"))
      .href
  );
  decodeBase58 = mintParserMod.decodeBase58;
}

// Canonical Program IDs and Discriminators
export const RAYDIUM_AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_CPMM_PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
export const RAYDIUM_AMM_V4_INIT2_TAG = 1;
export const RAYDIUM_CPMM_INIT_DISCRIMINATOR = Object.freeze([
  0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed,
]);

// Audited Candidate Seeds from Gate 2 and B1 Snapshot
export const DEFAULT_CANDIDATE_SEEDS = [
  // Primary AMM v4 Candidates (6 seeds)
  {
    poolAddress: "3sjNoCnkkhWPVXYGDtem8rCciHSGc9jSFZuUAzKbvRVp",
    symbol: "ZEREBRO",
    protocol: "RAYDIUM_AMM_V4",
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "J3b6dvheS2Y1cbMtVz5TCWXNegSjJDbUKxdUVDPoqmS7",
    symbol: "arc",
    protocol: "RAYDIUM_AMM_V4",
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "Bzc9NZfMqkXR6fz1DBph7BDf9BroyEf6pnzESP7v5iiw",
    symbol: "Fartcoin",
    protocol: "RAYDIUM_AMM_V4",
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "9Tb2ohu5P16BpBarqd3N27WnkF51Ukfs8Z1GzzLDxVZW",
    symbol: "GOAT",
    protocol: "RAYDIUM_AMM_V4",
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "4AZRPNEfCJ7iw28rJu5aUyeQhYcvdcNm8cswyL51AY9i",
    symbol: "Pnut",
    protocol: "RAYDIUM_AMM_V4",
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "93tjgwff5Ac5ThyMi8C4WejVVQq4tuMeMuYW1LEYZ7bu",
    symbol: "CHILLGUY",
    protocol: "RAYDIUM_AMM_V4",
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  // Primary CPMM Candidates (6 seeds)
  {
    poolAddress: "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp",
    symbol: "USELESS",
    protocol: "RAYDIUM_CPMM",
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    source: "B1 snapshot & Gate 2",
  },
  {
    poolAddress: "G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh",
    symbol: "CYBERLEEK",
    protocol: "RAYDIUM_CPMM",
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "82g6Mib9zrKuJTT1itENfJRU5h6PBRrPr452bQXMaqDW",
    symbol: "DEGO",
    protocol: "RAYDIUM_CPMM",
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "AEZjoUACNSpmYHHRNbfknjL8oiBDw6GhtrMm7tZgBfca",
    symbol: "IDLE",
    protocol: "RAYDIUM_CPMM",
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "CnHqem7jPbjA5p2xHBGPHQG7E9NkZWcQr9q6R9YWb7zf",
    symbol: "ELON",
    protocol: "RAYDIUM_CPMM",
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  {
    poolAddress: "7GrzVeARVvvJKh4mHXdn2QMPffzkPAyiUPXKFsry2Ys6",
    symbol: "MUSK4",
    protocol: "RAYDIUM_CPMM",
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    source: "Gate 2 catalog",
  },
  // Standby Backup Seeds (if primary is unavailable/pruned)
  {
    poolAddress: "8WwcNqdZjCY5Pt7AkhupAFknV2txca9sq6YBkGzLbvdt",
    symbol: "pippin",
    protocol: "RAYDIUM_AMM_V4",
    programId: RAYDIUM_AMM_V4_PROGRAM_ID,
    source: "Gate 2 backup",
  },
  {
    poolAddress: "4GWh5saKgzoukhhj4Rh3p5FmPU6yPuAexV6FaH5JQYfm",
    symbol: "ZEC",
    protocol: "RAYDIUM_CPMM",
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    source: "Gate 2 backup",
  },
];

export const DEFAULT_ACQUISITION_CONFIG = {
  rpcUrl: "https://api.mainnet-beta.solana.com",
  maxSeeds: 12,
  maxSignaturesPerSeed: 2,
  maxHistoryCalls: 24,
  maxTransactionCalls: 20,
  maxAccountCalls: 10,
  maxTotalRpcCalls: 54,
  minRequestIntervalMs: 1000,
  rpcTimeoutMs: 10000,
  targetAmmV4: 5,
  targetCpmm: 5,
  outputDir: ".tmp/c2-historical-captures",
  maxRetriesPerCall: 2,
  circuitBreakerConsecutiveErrors: 3,
  maxSupportedTransactionVersion: 1, // Correction 1: v1 support
};

/**
 * Normalizes instruction data to Buffer.
 */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) return Buffer.from(data);
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (decodeBase58) {
      try {
        return decodeBase58(trimmed);
      } catch {
        // Fall back to base64 if not valid base58
      }
    }
    try {
      return Buffer.from(trimmed, "base64");
    } catch {
      return Buffer.from(trimmed, "utf8");
    }
  }
  return Buffer.alloc(0);
}

/**
 * Resolves account keys for a transaction across static and loaded addresses.
 */
export function resolveTransactionKeys(txResult) {
  const transaction = txResult?.transaction;
  const message = transaction?.message;
  const meta = txResult?.meta;
  if (!message) return [];

  let keys = [];
  if (Array.isArray(message.accountKeys)) {
    // legacy or v0 string[] or object[]
    keys = message.accountKeys.map((k) => (typeof k === "string" ? k : (k?.pubkey ?? String(k))));
  } else if (Array.isArray(message.staticAccountKeys)) {
    keys = message.staticAccountKeys.map((k) =>
      typeof k === "string" ? k : (k?.pubkey ?? String(k)),
    );
  }

  const loaded = meta?.loadedAddresses;
  if (loaded) {
    if (Array.isArray(loaded.writable)) {
      keys.push(...loaded.writable);
    }
    if (Array.isArray(loaded.readonly)) {
      keys.push(...loaded.readonly);
    }
  }

  return keys;
}

/**
 * Independent Ground-Truth Evaluator (Correction 3):
 * Strictly inspects on-chain instruction discriminators and account vectors.
 * Does NOT rely on production parser output and does NOT require SystemProgram.createAccount.
 */
export function evaluateIndependentGroundTruth(txResult, expectedPoolAddress, expectedProtocol) {
  if (!txResult || typeof txResult !== "object") {
    return { isPositive: false, reason: "NULL_OR_INVALID_TRANSACTION_PAYLOAD" };
  }

  // Transaction must have succeeded on-chain
  if (txResult.meta?.err !== null) {
    return {
      isPositive: false,
      reason: "TRANSACTION_FAILED_ON_CHAIN",
      err: txResult.meta?.err,
    };
  }

  const allKeys = resolveTransactionKeys(txResult);
  if (allKeys.length === 0) {
    return { isPositive: false, reason: "UNRESOLVABLE_ACCOUNT_KEYS" };
  }

  const instructions = [];
  // Top-level instructions
  const topLevel = txResult.transaction?.message?.instructions ?? [];
  for (let i = 0; i < topLevel.length; i++) {
    instructions.push({ inst: topLevel[i], outerIdx: i, innerIdx: undefined });
  }

  // Inner instructions (CPI)
  const innerGroups = txResult.meta?.innerInstructions ?? [];
  for (const group of innerGroups) {
    const outerIdx = group.index;
    const inners = group.instructions ?? [];
    for (let j = 0; j < inners.length; j++) {
      instructions.push({ inst: inners[j], outerIdx, innerIdx: j });
    }
  }

  for (const { inst, outerIdx, innerIdx } of instructions) {
    const programId =
      typeof inst.programId === "string"
        ? inst.programId
        : allKeys[inst.programIdIndex ?? inst.programId];

    if (!programId) continue;

    const dataBuffer = toBuffer(inst.data);

    // Resolve instruction accounts
    let accounts = [];
    if (Array.isArray(inst.accounts)) {
      accounts = inst.accounts.map((acc) =>
        typeof acc === "string" ? acc : (allKeys[acc] ?? String(acc)),
      );
    } else if (Array.isArray(inst.accountKeyIndexes)) {
      accounts = inst.accountKeyIndexes.map((idx) => allKeys[idx] ?? `idx_${idx}`);
    }

    // AMM v4 Independent Verification
    if (
      programId === RAYDIUM_AMM_V4_PROGRAM_ID &&
      (!expectedProtocol || expectedProtocol === "RAYDIUM_AMM_V4")
    ) {
      if (dataBuffer.length >= 26) {
        const tag = dataBuffer.readUInt8(0);
        if (tag === RAYDIUM_AMM_V4_INIT2_TAG) {
          // In AMM v4 initialize2 (21 accounts):
          // index 4 is the pool state account (AMM PDA)
          // index 8 is coin mint, index 9 is pc mint
          // index 10 is coin vault, index 11 is pc vault
          const poolIdInIx = accounts[4];
          if (
            accounts.length >= 21 &&
            (!expectedPoolAddress || poolIdInIx === expectedPoolAddress)
          ) {
            return {
              isPositive: true,
              protocol: "RAYDIUM_AMM_V4",
              programId: RAYDIUM_AMM_V4_PROGRAM_ID,
              instructionType: "initialize2",
              instructionDiscriminator: "0x01",
              outerIdx,
              innerIdx,
              poolAddress: poolIdInIx,
              token0Mint: accounts[8],
              token1Mint: accounts[9],
              token0Vault: accounts[10],
              token1Vault: accounts[11],
              lpMint: accounts[7],
              accountsCount: accounts.length,
              payloadBytes: dataBuffer.length,
            };
          }
        }
      }
    }

    // CPMM Independent Verification
    if (
      programId === RAYDIUM_CPMM_PROGRAM_ID &&
      (!expectedProtocol || expectedProtocol === "RAYDIUM_CPMM")
    ) {
      if (dataBuffer.length >= 32) {
        let isAnchorInit = true;
        for (let d = 0; d < 8; d++) {
          if (dataBuffer.readUInt8(d) !== RAYDIUM_CPMM_INIT_DISCRIMINATOR[d]) {
            isAnchorInit = false;
            break;
          }
        }
        if (isAnchorInit) {
          // In CPMM initialize (20 accounts):
          // index 3 is pool_state (Pool ID)
          // index 4 is token_0_mint, index 5 is token_1_mint
          // index 10 is token_0_vault, index 11 is token_1_vault
          const poolIdInIx = accounts[3];
          if (
            accounts.length >= 20 &&
            (!expectedPoolAddress || poolIdInIx === expectedPoolAddress)
          ) {
            return {
              isPositive: true,
              protocol: "RAYDIUM_CPMM",
              programId: RAYDIUM_CPMM_PROGRAM_ID,
              instructionType: "initialize",
              instructionDiscriminator: "0xafaf6d1f0d989bed",
              outerIdx,
              innerIdx,
              poolAddress: poolIdInIx,
              token0Mint: accounts[4],
              token1Mint: accounts[5],
              token0Vault: accounts[10],
              token1Vault: accounts[11],
              lpMint: accounts[6],
              accountsCount: accounts.length,
              payloadBytes: dataBuffer.length,
            };
          }
        }
      }
    }
  }

  return {
    isPositive: false,
    reason: "NO_MATCHING_POOL_INITIALIZATION_INSTRUCTION",
    details: `Scanned ${instructions.length} instructions; zero matched canonical initialize2 or Anchor initialize for target pool`,
  };
}

/**
 * Core Positive Ground-Truth Acquisition Collector
 */
export class PositiveGroundTruthAcquisitionCollector {
  constructor(options = {}) {
    this.options = { ...DEFAULT_ACQUISITION_CONFIG, ...options };
    this.customTransport = options.transport ?? null;
    this.onLog = options.onLog ?? console.log;

    this.totalRpcCallsExecuted = 0;
    this.historyCallsExecuted = 0;
    this.transactionCallsExecuted = 0;
    this.accountCallsExecuted = 0;
    this.consecutiveRpcErrors = 0;
    this.lastRequestEpochMs = 0;

    this.rawTransactions = [];
    this.candidateHistoryLog = [];
    this.positiveRegistry = [];
    this.evaluatedSeeds = [];

    this.discoveredAmmV4Count = 0;
    this.discoveredCpmmCount = 0;
    this.stopReason = null;
  }

  log(msg) {
    this.onLog(`[C2_ACQUISITION] ${msg}`);
  }

  /**
   * Dispatches an outbound JSON-RPC request with pacing, timeout, rate-limit backoff,
   * error circuit breaking, and strict budget ceiling enforcement.
   * Every retry counts against both the specific method ceiling and the total ceiling (Correction 4).
   */
  async executeRpcCall(method, params, callType) {
    // 1. Check total budget ceiling (Hard ceiling of 54)
    if (this.totalRpcCallsExecuted >= this.options.maxTotalRpcCalls) {
      this.stopReason = `TOTAL_RPC_BUDGET_EXCEEDED (${this.totalRpcCallsExecuted}/${this.options.maxTotalRpcCalls})`;
      throw new Error(
        `[BUDGET_EXCEEDED] Cannot dispatch ${method}: reached total ceiling of ${this.options.maxTotalRpcCalls} calls`,
      );
    }

    // 2. Check method-specific budget ceilings
    if (callType === "history" && this.historyCallsExecuted >= this.options.maxHistoryCalls) {
      throw new Error(
        `[BUDGET_EXCEEDED] Cannot dispatch getSignaturesForAddress: reached history ceiling of ${this.options.maxHistoryCalls} calls`,
      );
    }
    if (
      callType === "transaction" &&
      this.transactionCallsExecuted >= this.options.maxTransactionCalls
    ) {
      throw new Error(
        `[BUDGET_EXCEEDED] Cannot dispatch getTransaction: reached transaction ceiling of ${this.options.maxTransactionCalls} calls`,
      );
    }
    if (callType === "account" && this.accountCallsExecuted >= this.options.maxAccountCalls) {
      throw new Error(
        `[BUDGET_EXCEEDED] Cannot dispatch getAccountInfo: reached account ceiling of ${this.options.maxAccountCalls} calls`,
      );
    }

    let attempt = 0;
    const maxRetries = this.options.maxRetriesPerCall ?? 2;

    while (attempt <= maxRetries) {
      // Re-verify budget before each attempt (including retries)
      if (this.totalRpcCallsExecuted >= this.options.maxTotalRpcCalls) {
        this.stopReason = `TOTAL_RPC_BUDGET_EXCEEDED (${this.totalRpcCallsExecuted}/${this.options.maxTotalRpcCalls})`;
        throw new Error(
          `[BUDGET_EXCEEDED] Cannot dispatch retry for ${method}: reached total ceiling of ${this.options.maxTotalRpcCalls} calls`,
        );
      }
      if (callType === "history" && this.historyCallsExecuted >= this.options.maxHistoryCalls) {
        throw new Error(
          `[BUDGET_EXCEEDED] Cannot retry getSignaturesForAddress: reached history ceiling of ${this.options.maxHistoryCalls}`,
        );
      }
      if (
        callType === "transaction" &&
        this.transactionCallsExecuted >= this.options.maxTransactionCalls
      ) {
        throw new Error(
          `[BUDGET_EXCEEDED] Cannot retry getTransaction: reached transaction ceiling of ${this.options.maxTransactionCalls}`,
        );
      }

      // Enforce inter-request pacing
      if (this.options.minRequestIntervalMs > 0 && this.lastRequestEpochMs > 0) {
        const elapsed = Date.now() - this.lastRequestEpochMs;
        if (elapsed < this.options.minRequestIntervalMs) {
          const waitMs = this.options.minRequestIntervalMs - elapsed;
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }

      this.lastRequestEpochMs = Date.now();
      this.totalRpcCallsExecuted++;
      if (callType === "history") this.historyCallsExecuted++;
      if (callType === "transaction") this.transactionCallsExecuted++;
      if (callType === "account") this.accountCallsExecuted++;

      const reqId = `c2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const requestPayload = {
        jsonrpc: "2.0",
        id: reqId,
        method,
        params,
      };

      try {
        let responseData;
        if (this.customTransport) {
          responseData = await this.customTransport(method, params, requestPayload);
        } else {
          // Standard live fetch with timeout
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(new Error(`RPC timeout after ${this.options.rpcTimeoutMs}ms`)),
            this.options.rpcTimeoutMs,
          );
          try {
            const resp = await fetch(this.options.rpcUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestPayload),
              signal: controller.signal,
            });

            if (resp.status === 429) {
              throw new Error(`HTTP_429_TOO_MANY_REQUESTS`);
            }
            if (!resp.ok) {
              throw new Error(`HTTP_${resp.status}_${resp.statusText}`);
            }
            responseData = await resp.json();
          } finally {
            clearTimeout(timer);
          }
        }

        // Check for JSON-RPC error
        if (responseData?.error) {
          const errCode = responseData.error.code;
          if (errCode === 429 || String(responseData.error.message).includes("Too many requests")) {
            throw new Error(`RPC_429_RATE_LIMITED: ${responseData.error.message}`);
          }
          throw new Error(`RPC_ERROR_${errCode}: ${responseData.error.message}`);
        }

        // Call succeeded: reset circuit breaker
        this.consecutiveRpcErrors = 0;
        return responseData;
      } catch (err) {
        this.consecutiveRpcErrors++;
        const errMsg = err instanceof Error ? err.message : String(err);
        this.log(`Call to ${method} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg}`);

        // Circuit breaker check
        if (this.consecutiveRpcErrors >= this.options.circuitBreakerConsecutiveErrors) {
          this.stopReason = `CIRCUIT_BREAKER_TRIGGERED (${this.consecutiveRpcErrors} consecutive errors)`;
          throw new Error(
            `[CIRCUIT_BREAKER] Halting session: ${this.consecutiveRpcErrors} consecutive RPC errors encountered`,
          );
        }

        // If rate limited or transient error, apply backoff if retries remain
        const isRateLimit = errMsg.includes("429");
        if (attempt < maxRetries) {
          attempt++;
          const backoffBase = isRateLimit ? 2000 : 1000;
          const backoffMs = backoffBase * Math.pow(2, attempt - 1);
          this.log(`Backing off for ${backoffMs}ms before retry...`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        throw err;
      }
    }

    throw new Error(`[MAX_RETRIES_EXCEEDED] Failed ${method} after ${maxRetries} retries`);
  }

  /**
   * Evaluates a single candidate pool seed.
   */
  async evaluateSeed(seed) {
    this.log(`Evaluating seed pool '${seed.symbol}' (${seed.poolAddress}) on ${seed.protocol}...`);

    let candidateSignatures = [];
    let isHistoryTruncated = false;

    // Page 1: Query getSignaturesForAddress
    try {
      const page1Resp = await this.executeRpcCall(
        "getSignaturesForAddress",
        [seed.poolAddress, { limit: 100, commitment: "confirmed" }],
        "history",
      );
      const page1Sigs = Array.isArray(page1Resp?.result) ? page1Resp.result : [];
      candidateSignatures.push(...page1Sigs);
      this.candidateHistoryLog.push({
        poolAddress: seed.poolAddress,
        symbol: seed.symbol,
        page: 1,
        signaturesReturned: page1Sigs.length,
        oldestSigInPage: page1Sigs[page1Sigs.length - 1]?.signature ?? null,
      });

      // Page 2: If page 1 returned exactly 100 and pagination allowed
      if (
        page1Sigs.length === 100 &&
        this.options.maxSignaturesPerSeed >= 2 &&
        this.historyCallsExecuted < this.options.maxHistoryCalls
      ) {
        const oldestPage1 = page1Sigs[page1Sigs.length - 1]?.signature;
        if (oldestPage1) {
          const page2Resp = await this.executeRpcCall(
            "getSignaturesForAddress",
            [seed.poolAddress, { limit: 100, before: oldestPage1, commitment: "confirmed" }],
            "history",
          );
          const page2Sigs = Array.isArray(page2Resp?.result) ? page2Resp.result : [];
          candidateSignatures.push(...page2Sigs);
          this.candidateHistoryLog.push({
            poolAddress: seed.poolAddress,
            symbol: seed.symbol,
            page: 2,
            signaturesReturned: page2Sigs.length,
            oldestSigInPage: page2Sigs[page2Sigs.length - 1]?.signature ?? null,
          });

          // If page 2 also returned 100, history is deeper than our 200 signature budget window
          if (page2Sigs.length === 100) {
            isHistoryTruncated = true;
          }
        }
      }
    } catch (err) {
      this.log(`Error querying signatures for seed ${seed.symbol}: ${err.message}`);
      this.evaluatedSeeds.push({
        ...seed,
        status: "SIGNATURES_QUERY_FAILED",
        error: err.message,
      });
      return;
    }

    if (candidateSignatures.length === 0) {
      this.log(`Seed ${seed.symbol} has 0 signatures in history. Marking EMPTY_HISTORY.`);
      this.evaluatedSeeds.push({
        ...seed,
        status: "EMPTY_HISTORY",
        candidateSignaturesSeen: 0,
      });
      return;
    }

    // Identify candidate earliest signature
    const earliestSigEntry = candidateSignatures[candidateSignatures.length - 1];
    const candidateSig = earliestSigEntry?.signature;

    this.log(
      `Seed ${seed.symbol}: ${candidateSignatures.length} signatures retrieved. Oldest candidate: ${candidateSig}`,
    );

    // Fetch candidate transaction (Correction 1: maxSupportedTransactionVersion: 1)
    let txResp;
    try {
      txResp = await this.executeRpcCall(
        "getTransaction",
        [
          candidateSig,
          {
            encoding: "json",
            maxSupportedTransactionVersion: this.options.maxSupportedTransactionVersion,
            commitment: "confirmed",
          },
        ],
        "transaction",
      );
    } catch (err) {
      this.log(`Failed to fetch candidate transaction ${candidateSig}: ${err.message}`);
      this.evaluatedSeeds.push({
        ...seed,
        status: "TRANSACTION_FETCH_FAILED",
        candidateSig,
        error: err.message,
      });
      return;
    }

    // Correction 4: getTransaction: null classified as UNAVAILABLE (not automatically proven pruned)
    if (!txResp || txResp.result === null) {
      this.log(`Transaction ${candidateSig} returned null from RPC. Classified as UNAVAILABLE.`);
      this.evaluatedSeeds.push({
        ...seed,
        status: "UNAVAILABLE",
        candidateSig,
        details: "RPC returned null result for candidate transaction signature",
      });
      return;
    }

    // Record raw wire transaction response
    this.rawTransactions.push({
      seedPoolAddress: seed.poolAddress,
      symbol: seed.symbol,
      protocol: seed.protocol,
      signature: candidateSig,
      response: txResp,
      capturedAtEpochMs: Date.now(),
    });

    // Correction 3: Independent Ground Truth Evaluation
    const independentEval = evaluateIndependentGroundTruth(
      txResp.result,
      seed.poolAddress,
      seed.protocol,
    );

    if (independentEval.isPositive) {
      this.log(
        `[AUTHENTIC_POSITIVE_CONFIRMED] Seed ${seed.symbol} confirmed on-chain positive pool initialization!`,
      );

      // Evaluate against production parser if available
      let parserEvaluation = null;
      if (identifyPoolInitializationInstructions && SolanaRpcTransactionFetcher) {
        try {
          const parsedMetadata = SolanaRpcTransactionFetcher.parseTransactionResponse(
            candidateSig,
            txResp,
          );
          if (parsedMetadata) {
            const scanResult = identifyPoolInitializationInstructions(parsedMetadata);
            parserEvaluation = {
              ok: scanResult.ok,
              eventsDiscovered: scanResult.ok ? scanResult.events.length : 0,
              productionParserVerdict: scanResult.ok ? "TRUE_POSITIVE" : "FALSE_NEGATIVE",
              failureReason: scanResult.ok ? null : scanResult.reason,
            };
          } else {
            parserEvaluation = {
              ok: false,
              productionParserVerdict: "FALSE_NEGATIVE",
              failureReason: "METADATA_TRANSLATION_FAILED",
            };
          }
        } catch (err) {
          parserEvaluation = {
            ok: false,
            productionParserVerdict: "FALSE_NEGATIVE",
            failureReason: `PARSER_EXCEPTION: ${err.message}`,
          };
        }
      }

      // Evaluate log messages against production log classifier
      let logPrioritizationVerdict = null;
      if (classifyNotificationLogs && Array.isArray(txResp.result?.meta?.logMessages)) {
        const logs = txResp.result.meta.logMessages;
        logPrioritizationVerdict = {
          classification: classifyNotificationLogs(logs),
          logMessagesCount: logs.length,
          annotation: "HISTORICAL_LOG_SENSITIVITY_DERIVED (NOT_LIVE_WS_OBSERVATION)",
        };
      }

      const positiveRecord = {
        signature: candidateSig,
        slot: txResp.result.slot,
        blockTime: txResp.result.blockTime ?? null,
        protocol: independentEval.protocol,
        programId: independentEval.programId,
        instructionType: independentEval.instructionType,
        instructionDiscriminator: independentEval.instructionDiscriminator,
        outerInstructionIndex: independentEval.outerIdx,
        innerInstructionIndex: independentEval.innerIdx,
        poolAddress: independentEval.poolAddress,
        token0Mint: independentEval.token0Mint,
        token1Mint: independentEval.token1Mint,
        token0Vault: independentEval.token0Vault,
        token1Vault: independentEval.token1Vault,
        lpMint: independentEval.lpMint,
        independentVerificationSource: "SOLANA_MAINNET_GENESIS_INSTRUCTION_MATCH",
        productionParserEvaluation: parserEvaluation,
        logPrioritizationEvaluation: logPrioritizationVerdict,
        payloadSha256: crypto.createHash("sha256").update(JSON.stringify(txResp)).digest("hex"),
      };

      this.positiveRegistry.push(positiveRecord);
      if (independentEval.protocol === "RAYDIUM_AMM_V4") {
        this.discoveredAmmV4Count++;
      } else if (independentEval.protocol === "RAYDIUM_CPMM") {
        this.discoveredCpmmCount++;
      }

      this.evaluatedSeeds.push({
        ...seed,
        status: "CONFIRMED_POSITIVE_INITIALIZATION",
        signature: candidateSig,
        protocol: independentEval.protocol,
        productionParserVerdict: parserEvaluation?.productionParserVerdict ?? "NOT_EVALUATED",
      });
    } else {
      // Correction 2: If oldest retrieved signature is NOT pool initialization, do NOT invent creation sig
      this.log(
        `Seed ${seed.symbol} oldest candidate transaction ${candidateSig} is NOT a pool initialization (${independentEval.reason}).`,
      );
      this.evaluatedSeeds.push({
        ...seed,
        status: isHistoryTruncated
          ? "UNRESOLVED_GENESIS_NOT_REACHED (HISTORY_PAGINATION_LIMIT_REACHED)"
          : "UNRESOLVED_GENESIS_NOT_REACHED (OLDEST_TX_NOT_INITIALIZATION)",
        oldestSigEvaluated: candidateSig,
        historyTruncated: isHistoryTruncated,
        independentEvaluation: independentEval,
      });
    }
  }

  /**
   * Executes the full bounded acquisition runbook.
   */
  async runAcquisition(candidateSeeds = DEFAULT_CANDIDATE_SEEDS) {
    await loadBackendDependencies();

    const maxSeeds = Math.min(candidateSeeds.length, this.options.maxSeeds);
    this.log(`Starting bounded positive acquisition runbook across up to ${maxSeeds} seeds...`);

    for (let i = 0; i < maxSeeds; i++) {
      if (this.stopReason) break;

      // Check if target yields are reached (Early Termination)
      if (
        this.discoveredAmmV4Count >= this.options.targetAmmV4 &&
        this.discoveredCpmmCount >= this.options.targetCpmm
      ) {
        this.stopReason = `TARGET_YIELD_REACHED (${this.discoveredAmmV4Count} AMM v4, ${this.discoveredCpmmCount} CPMM)`;
        this.log(`[EARLY_TERMINATION] Target yield reached! Halting acquisition.`);
        break;
      }

      // Check total call budget
      if (this.totalRpcCallsExecuted >= this.options.maxTotalRpcCalls) {
        this.stopReason = `TOTAL_RPC_BUDGET_EXCEEDED (${this.totalRpcCallsExecuted}/${this.options.maxTotalRpcCalls})`;
        this.log(
          `[BUDGET_HALT] Reached total RPC call ceiling of ${this.options.maxTotalRpcCalls}.`,
        );
        break;
      }

      const seed = candidateSeeds[i];
      try {
        await this.evaluateSeed(seed);
      } catch (err) {
        this.log(`Evaluation of seed ${seed.symbol} failed: ${err.message}`);
      }
      if (this.stopReason) break;
    }

    if (!this.stopReason) {
      this.stopReason = "ALL_SEEDS_EVALUATED";
    }

    return this.finalizeAndSeal();
  }

  /**
   * Finalizes output files and seals cryptographic manifest.
   */
  finalizeAndSeal() {
    const timestamp = Date.now();
    const sessionId = `c2-positive-ground-truth-${timestamp}`;
    const targetDir = path.resolve(rootDir, this.options.outputDir, sessionId);

    fs.mkdirSync(targetDir, { recursive: true });

    // 1. session-metadata.json
    const metadata = {
      sessionId,
      manifestType: "C2_GROUND_TRUTH",
      createdAtIso: new Date(timestamp).toISOString(),
      createdAtEpochMs: timestamp,
      stopReason: this.stopReason,
      rpcUrl: this.options.rpcUrl,
      targetAmmV4: this.options.targetAmmV4,
      targetCpmm: this.options.targetCpmm,
      discoveredAmmV4Count: this.discoveredAmmV4Count,
      discoveredCpmmCount: this.discoveredCpmmCount,
      totalRpcCallsExecuted: this.totalRpcCallsExecuted,
      historyCallsExecuted: this.historyCallsExecuted,
      transactionCallsExecuted: this.transactionCallsExecuted,
      accountCallsExecuted: this.accountCallsExecuted,
      consecutiveRpcErrors: this.consecutiveRpcErrors,
      options: {
        maxSeeds: this.options.maxSeeds,
        maxHistoryCalls: this.options.maxHistoryCalls,
        maxTransactionCalls: this.options.maxTransactionCalls,
        maxTotalRpcCalls: this.options.maxTotalRpcCalls,
        maxSupportedTransactionVersion: this.options.maxSupportedTransactionVersion,
      },
    };
    fs.writeFileSync(
      path.join(targetDir, "session-metadata.json"),
      JSON.stringify(metadata, null, 2),
      "utf8",
    );

    // 2. candidate-history-log.jsonl
    const historyLogContent =
      this.candidateHistoryLog.map((item) => JSON.stringify(item)).join("\n") +
      (this.candidateHistoryLog.length > 0 ? "\n" : "");
    fs.writeFileSync(
      path.join(targetDir, "candidate-history-log.jsonl"),
      historyLogContent,
      "utf8",
    );

    // 3. raw-transactions.jsonl
    const rawTxContent =
      this.rawTransactions.map((item) => JSON.stringify(item)).join("\n") +
      (this.rawTransactions.length > 0 ? "\n" : "");
    fs.writeFileSync(path.join(targetDir, "raw-transactions.jsonl"), rawTxContent, "utf8");

    // 4. positive-ground-truth-registry.json
    fs.writeFileSync(
      path.join(targetDir, "positive-ground-truth-registry.json"),
      JSON.stringify(this.positiveRegistry, null, 2),
      "utf8",
    );

    // 5. acquisition-summary.json
    const summary = {
      sessionId,
      status: "FINALIZED",
      stopReason: this.stopReason,
      totalSeedsEvaluated: this.evaluatedSeeds.length,
      confirmedPositivesCount: this.positiveRegistry.length,
      ammV4PositivesCount: this.discoveredAmmV4Count,
      cpmmPositivesCount: this.discoveredCpmmCount,
      totalRpcCalls: this.totalRpcCallsExecuted,
      historyCalls: this.historyCallsExecuted,
      transactionCalls: this.transactionCallsExecuted,
      accountCalls: this.accountCallsExecuted,
      evaluatedSeedsSummary: this.evaluatedSeeds,
    };
    fs.writeFileSync(
      path.join(targetDir, "acquisition-summary.json"),
      JSON.stringify(summary, null, 2),
      "utf8",
    );

    // 6. Compute Cryptographic Manifest (session-manifest.json and c2-manifest.json)
    const filesToManifest = [
      "acquisition-summary.json",
      "candidate-history-log.jsonl",
      "positive-ground-truth-registry.json",
      "raw-transactions.jsonl",
      "session-metadata.json",
    ];

    const fileEntries = [];
    let totalBytes = 0;
    for (const filename of filesToManifest) {
      const filePath = path.join(targetDir, filename);
      const content = fs.readFileSync(filePath);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      fileEntries.push({
        filename,
        sha256: hash,
        byteSize: content.length,
      });
      totalBytes += content.length;
    }

    fileEntries.sort((a, b) => a.filename.localeCompare(b.filename));
    const manifestPayload = fileEntries.map((f) => `${f.filename}:${f.sha256}`).join("\n");
    const manifestSha256 = crypto.createHash("sha256").update(manifestPayload).digest("hex");

    const manifest = {
      manifestVersion: "1.0",
      sessionId,
      manifestType: "C2_GROUND_TRUTH",
      createdAtIso: new Date(timestamp).toISOString(),
      status: "FINALIZED",
      totalFiles: fileEntries.length,
      totalBytes,
      files: fileEntries,
      manifestSha256,
    };

    const manifestContent = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(targetDir, "session-manifest.json"), manifestContent, "utf8");
    fs.writeFileSync(path.join(targetDir, "c2-manifest.json"), manifestContent, "utf8");

    this.log(`Session sealed successfully in: ${targetDir}`);
    this.log(`Canonical Manifest SHA-256: ${manifestSha256}`);

    return {
      sessionId,
      targetDir,
      manifestSha256,
      stopReason: this.stopReason,
      positivesCount: this.positiveRegistry.length,
      ammV4Count: this.discoveredAmmV4Count,
      cpmmCount: this.discoveredCpmmCount,
      totalCalls: this.totalRpcCallsExecuted,
    };
  }
}

/**
 * Validates a C2 Session Manifest cryptographically.
 */
export function verifyC2SessionManifest(sessionDir) {
  const manifestPath = path.join(sessionDir, "session-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[C2_MANIFEST_MISSING] Manifest not found in ${sessionDir}`);
  }

  const raw = fs.readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(raw);

  if (manifest.manifestType !== "C2_GROUND_TRUTH" && !manifest.sessionId?.startsWith("c2-")) {
    throw new Error(`[C2_MANIFEST_INVALID_TYPE] Manifest is not a C2 ground truth manifest`);
  }

  const seen = new Set();
  let computedBytes = 0;
  for (const entry of manifest.files) {
    if (seen.has(entry.filename)) {
      throw new Error(`[C2_MANIFEST_DUPLICATE_FILE] Duplicate entry: ${entry.filename}`);
    }
    seen.add(entry.filename);
    computedBytes += entry.byteSize;

    const filePath = path.join(sessionDir, entry.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`[C2_MANIFEST_FILE_MISSING] File missing on disk: ${entry.filename}`);
    }
    const diskBytes = fs.readFileSync(filePath);
    if (diskBytes.length !== entry.byteSize) {
      throw new Error(
        `[C2_MANIFEST_SIZE_MISMATCH] ${entry.filename}: expected ${entry.byteSize} bytes, got ${diskBytes.length}`,
      );
    }
    const diskHash = crypto.createHash("sha256").update(diskBytes).digest("hex");
    if (diskHash !== entry.sha256) {
      throw new Error(
        `[C2_MANIFEST_HASH_MISMATCH] ${entry.filename}: expected ${entry.sha256}, got ${diskHash}`,
      );
    }
  }

  if (manifest.totalBytes !== computedBytes) {
    throw new Error(
      `[C2_MANIFEST_TOTAL_BYTES_MISMATCH] Declared ${manifest.totalBytes}, sum is ${computedBytes}`,
    );
  }

  const sorted = [...manifest.files].sort((a, b) => a.filename.localeCompare(b.filename));
  const payload = sorted.map((f) => `${f.filename}:${f.sha256}`).join("\n");
  const computedManifestSha256 = crypto.createHash("sha256").update(payload).digest("hex");

  if (computedManifestSha256 !== manifest.manifestSha256) {
    throw new Error(
      `[C2_MANIFEST_CANONICAL_HASH_MISMATCH] Expected ${manifest.manifestSha256}, computed ${computedManifestSha256}`,
    );
  }

  return { valid: true, manifest };
}

/**
 * CLI Argument Parser
 */
export function parseAcquisitionCliArgs(argv) {
  let authorized = false;
  let networkEnabled = false;
  const options = {};

  for (const arg of argv.slice(2)) {
    if (arg === "--authorize-c2-acquisition") {
      authorized = true;
    } else if (arg === "--network=enabled") {
      networkEnabled = true;
    } else if (arg.startsWith("--rpc-url=")) {
      options.rpcUrl = arg.slice("--rpc-url=".length).trim();
    } else if (arg.startsWith("--max-seeds=")) {
      options.maxSeeds = parseInt(arg.slice("--max-seeds=".length), 10);
    } else if (arg.startsWith("--max-signatures-per-seed=")) {
      options.maxSignaturesPerSeed = parseInt(arg.slice("--max-signatures-per-seed=".length), 10);
    } else if (arg.startsWith("--max-history-calls=")) {
      options.maxHistoryCalls = parseInt(arg.slice("--max-history-calls=".length), 10);
    } else if (arg.startsWith("--max-transaction-calls=")) {
      options.maxTransactionCalls = parseInt(arg.slice("--max-transaction-calls=".length), 10);
    } else if (arg.startsWith("--max-total-rpc-calls=")) {
      options.maxTotalRpcCalls = parseInt(arg.slice("--max-total-rpc-calls=".length), 10);
    } else if (arg.startsWith("--min-request-interval-ms=")) {
      options.minRequestIntervalMs = parseInt(arg.slice("--min-request-interval-ms=".length), 10);
    } else if (arg.startsWith("--rpc-timeout-ms=")) {
      options.rpcTimeoutMs = parseInt(arg.slice("--rpc-timeout-ms=".length), 10);
    } else if (arg.startsWith("--target-amm-v4=")) {
      options.targetAmmV4 = parseInt(arg.slice("--target-amm-v4=".length), 10);
    } else if (arg.startsWith("--target-cpmm=")) {
      options.targetCpmm = parseInt(arg.slice("--target-cpmm=".length), 10);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length).trim();
    }
  }

  return { authorized, networkEnabled, options };
}

/**
 * Main CLI entrypoint
 */
export async function runAcquisitionCli(argv = process.argv, customOptions = {}) {
  const { authorized, networkEnabled, options } = parseAcquisitionCliArgs(argv);

  if (!authorized) {
    console.error(
      "[ERROR] Operator authorization required: missing '--authorize-c2-acquisition' flag.",
    );
    console.error("Execution halted fail-closed without network activity.");
    return 1;
  }

  if (!networkEnabled) {
    console.error("[ERROR] Network execution gate required: missing '--network=enabled' flag.");
    console.error("Execution halted fail-closed without network activity.");
    return 1;
  }

  const mergedOptions = { ...options, ...customOptions };
  const collector = new PositiveGroundTruthAcquisitionCollector(mergedOptions);

  try {
    const result = await collector.runAcquisition();
    console.log(`\n================================================================`);
    console.log(`  Phase 12.94-D.2.9-C2 Ground Truth Acquisition Complete!        `);
    console.log(`================================================================`);
    console.log(`Session ID:          ${result.sessionId}`);
    console.log(`Directory:           ${result.targetDir}`);
    console.log(`Stop Reason:         ${result.stopReason}`);
    console.log(
      `Positives Confirmed: ${result.positivesCount} (AMM v4: ${result.ammV4Count}, CPMM: ${result.cpmmCount})`,
    );
    console.log(`Total RPC Calls:     ${result.totalCalls}`);
    console.log(`Manifest SHA-256:    ${result.manifestSha256}`);
    console.log(`================================================================\n`);
    return 0;
  } catch (err) {
    console.error(`[FATAL] Acquisition failed: ${err.message}`);
    return 1;
  }
}

// Auto-run when executed directly
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runAcquisitionCli(process.argv).then((code) => {
    process.exitCode = code;
  });
}
