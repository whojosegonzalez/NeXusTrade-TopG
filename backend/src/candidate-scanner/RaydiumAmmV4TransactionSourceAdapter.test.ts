/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 Transaction Source Adapter Tests
 *
 * Verifies Independent Audit Findings 1 - 6:
 * 1. Constructor guards enforcing explicit transport, budget manager, rpcUrl, pool context,
 *    and valid numeric configuration options (timeoutMs, overallTimeoutMs, pacingMs, queue/dedup bounds).
 * 2. Immutable identity binding & snapshotting (mutating notification after enqueue does not
 *    affect retrieval; null/undefined notifications fail closed with INVALID_NOTIFICATION without throwing).
 * 3. Response signature mismatch and metadata contradiction detection (slot/time mismatches reject
 *    with zero ingested events and CONTRADICTORY_METADATA).
 * 4. Deduplication & workload limits (protects active/queued signatures from eviction; direct
 *    processNotification calls obey maxPendingQueueSize).
 * 5. Loss preservation, backlog reporting & partial failure accounting (TRANSACTION_NOT_FOUND,
 *    queue overflows, and partial ingestions record collection gaps protecting established coverage;
 *    queue draining alone does not erase gaps).
 * 6. Deadlines & timeout protection (rechecks deadline before dispatch AND before tracker ingestion;
 *    rejects NaN or ceiling-exceeding overrides; aborts stalled body reads promptly).
 * 7. Effective pacing & capacity reservation (enforces pacingMs >= 2,500 ms even with zero-budget spacing;
 *    default purpose CANDIDATE_ENRICHMENT preserves reserved forward observation requests; redirect: "error").
 * 8. Sanitized diagnostics (redacts API keys and endpoint credentials from all diagnostics and error messages).
 *
 * NOTE: All tests execute strictly offline using labeled synthetic fixtures and fake clocks.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RaydiumAmmV4TransactionSourceAdapter,
  type InjectedTransactionNotification,
} from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { type TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";

// Canonical Base58 Fixtures
const MOCK_RPC_URL = "https://mock-solana-rpc.internal";
const SYNTHETIC_WSOL_MINT = "So11111111111111111111111111111111111111112";
const SYNTHETIC_CANDIDATE_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const SYNTHETIC_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const SYNTHETIC_OTHER_POOL_ID = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const SYNTHETIC_BASE_VAULT = "9UYjh9A2dE1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8F";
const SYNTHETIC_QUOTE_VAULT = "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v";
const SYNTHETIC_AMM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const SYNTHETIC_USER_SOURCE_ATA = "UserSourceTokenAccount1111111111111111111111";
const SYNTHETIC_USER_DEST_ATA = "UserDestTokenAccount111111111111111111111111";
const SYNTHETIC_USER_WALLET = "UserWalletOwner1111111111111111111111111111";

const STANDARD_POOL_CONTEXT: TrackedRaydiumPoolContext = Object.freeze({
  poolId: SYNTHETIC_POOL_ID,
  candidateTokenMint: SYNTHETIC_CANDIDATE_MINT,
  quoteTokenMint: SYNTHETIC_WSOL_MINT,
  baseVault: SYNTHETIC_BASE_VAULT,
  quoteVault: SYNTHETIC_QUOTE_VAULT,
  baseMint: SYNTHETIC_CANDIDATE_MINT,
  quoteMint: SYNTHETIC_WSOL_MINT,
  orientation: "TOKEN_BASE_SOL_QUOTE",
});

function makeSwapBaseInV2Data(amountIn: bigint, minimumOut: bigint): number[] {
  const buf = new Uint8Array(17);
  buf[0] = 16; // SwapBaseInV2 tag
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amountIn, true);
  view.setBigUint64(9, minimumOut, true);
  return Array.from(buf);
}

/**
 * Creates a synthetic RPC transaction payload matching the requested signature and pool.
 */
function createSyntheticBuyPayload(
  signature: string,
  amountInLamports = 50_000_000n, // 0.05 WSOL
  amountOutTokens = 25_000_000_000n, // 25,000 BONK
  poolId = SYNTHETIC_POOL_ID,
  slot = 280_000_100,
  blockTime = 1_700_000_000,
) {
  const accounts = [
    SPL_TOKEN_PROGRAM_ID, // 0
    poolId, // 1
    SYNTHETIC_AMM_AUTHORITY, // 2
    SYNTHETIC_BASE_VAULT, // 3
    SYNTHETIC_QUOTE_VAULT, // 4
    SYNTHETIC_USER_SOURCE_ATA, // 5
    SYNTHETIC_USER_DEST_ATA, // 6
    SYNTHETIC_USER_WALLET, // 7
    RAYDIUM_AMM_V4_PROGRAM_ID, // 8
  ];

  return {
    slot,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: accounts,
        instructions: [
          {
            programIdIndex: 8,
            accounts: [0, 1, 2, 3, 4, 5, 6, 7],
            data: makeSwapBaseInV2Data(amountInLamports, amountOutTokens),
          },
        ],
      },
    },
    meta: {
      err: null,
      preTokenBalances: [
        {
          accountIndex: 4,
          mint: SYNTHETIC_WSOL_MINT,
          uiTokenAmount: { amount: "1000000000", decimals: 9 },
        },
        {
          accountIndex: 3,
          mint: SYNTHETIC_CANDIDATE_MINT,
          uiTokenAmount: { amount: "500000000000", decimals: 5 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 4,
          mint: SYNTHETIC_WSOL_MINT,
          uiTokenAmount: { amount: (1_000_000_000n + amountInLamports).toString(), decimals: 9 },
        },
        {
          accountIndex: 3,
          mint: SYNTHETIC_CANDIDATE_MINT,
          uiTokenAmount: { amount: (500_000_000_000n - amountOutTokens).toString(), decimals: 5 },
        },
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 0,
              accounts: [5, 4, 7],
              data: [
                3,
                ...Array.from(new Uint8Array(new BigUint64Array([amountInLamports]).buffer)),
              ],
            },
            {
              programIdIndex: 0,
              accounts: [3, 6, 2],
              data: [
                3,
                ...Array.from(new Uint8Array(new BigUint64Array([amountOutTokens]).buffer)),
              ],
            },
          ],
        },
      ],
    },
  };
}

/**
 * Creates a synthetic RPC transaction payload containing 2 Raydium swaps on the tracked pool.
 */
function createSyntheticMultiSwapPayload(
  signature: string,
  slot = 280_000_100,
  blockTime = 1_700_000_000,
) {
  const accounts = [
    SPL_TOKEN_PROGRAM_ID, // 0
    SYNTHETIC_POOL_ID, // 1
    SYNTHETIC_AMM_AUTHORITY, // 2
    SYNTHETIC_BASE_VAULT, // 3
    SYNTHETIC_QUOTE_VAULT, // 4
    SYNTHETIC_USER_SOURCE_ATA, // 5
    SYNTHETIC_USER_DEST_ATA, // 6
    SYNTHETIC_USER_WALLET, // 7
    RAYDIUM_AMM_V4_PROGRAM_ID, // 8
  ];

  return {
    slot,
    blockTime,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: accounts,
        instructions: [
          {
            programIdIndex: 8,
            accounts: [0, 1, 2, 3, 4, 5, 6, 7],
            data: makeSwapBaseInV2Data(10_000_000n, 5_000_000_000n),
          },
          {
            programIdIndex: 8,
            accounts: [0, 1, 2, 3, 4, 5, 6, 7],
            data: makeSwapBaseInV2Data(20_000_000n, 10_000_000_000n),
          },
        ],
      },
    },
    meta: {
      err: null,
      preTokenBalances: [
        {
          accountIndex: 4,
          mint: SYNTHETIC_WSOL_MINT,
          uiTokenAmount: { amount: "1000000000", decimals: 9 },
        },
        {
          accountIndex: 3,
          mint: SYNTHETIC_CANDIDATE_MINT,
          uiTokenAmount: { amount: "500000000000", decimals: 5 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 4,
          mint: SYNTHETIC_WSOL_MINT,
          uiTokenAmount: { amount: "1030000000", decimals: 9 },
        },
        {
          accountIndex: 3,
          mint: SYNTHETIC_CANDIDATE_MINT,
          uiTokenAmount: { amount: "485000000000", decimals: 5 },
        },
      ],
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 0,
              accounts: [5, 4, 7],
              data: [3, ...Array.from(new Uint8Array(new BigUint64Array([10_000_000n]).buffer))],
            },
            {
              programIdIndex: 0,
              accounts: [3, 6, 2],
              data: [3, ...Array.from(new Uint8Array(new BigUint64Array([5_000_000_000n]).buffer))],
            },
          ],
        },
        {
          index: 1,
          instructions: [
            {
              programIdIndex: 0,
              accounts: [5, 4, 7],
              data: [3, ...Array.from(new Uint8Array(new BigUint64Array([20_000_000n]).buffer))],
            },
            {
              programIdIndex: 0,
              accounts: [3, 6, 2],
              data: [
                3,
                ...Array.from(new Uint8Array(new BigUint64Array([10_000_000_000n]).buffer)),
              ],
            },
          ],
        },
      ],
    },
  };
}

describe("RaydiumAmmV4TransactionSourceAdapter", () => {
  describe("Constructor & Configuration Validation", () => {
    it("rejects initialization without an explicit transport implementation", () => {
      const budgetManager = new GlobalResourceBudgetManager();
      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: MOCK_RPC_URL,
            budgetManager,
            transport: undefined as unknown as typeof fetch,
          }),
      ).toThrow("Explicit transport is required");
    });

    it("rejects initialization without an explicit GlobalResourceBudgetManager", () => {
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });
      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: MOCK_RPC_URL,
            budgetManager: undefined as unknown as GlobalResourceBudgetManager,
            transport: mockTransport,
          }),
      ).toThrow("Shared GlobalResourceBudgetManager is required");
    });

    it("rejects initialization without an RPC URL", () => {
      const budgetManager = new GlobalResourceBudgetManager();
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });
      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: "",
            budgetManager,
            transport: mockTransport,
          }),
      ).toThrow("rpcUrl is required");
    });

    it("rejects invalid numeric constructor configuration settings", () => {
      const budgetManager = new GlobalResourceBudgetManager();
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });

      // Invalid maxPendingQueueSize
      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: MOCK_RPC_URL,
            budgetManager,
            transport: mockTransport,
            maxPendingQueueSize: 0,
          }),
      ).toThrow("maxPendingQueueSize must be an integer >= 1");

      // Invalid maxDeduplicationKeys
      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: MOCK_RPC_URL,
            budgetManager,
            transport: mockTransport,
            maxDeduplicationKeys: NaN,
          }),
      ).toThrow("maxDeduplicationKeys must be an integer >= 1");

      // Invalid timeoutMs
      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: MOCK_RPC_URL,
            budgetManager,
            transport: mockTransport,
            timeoutMs: -10,
          }),
      ).toThrow("timeoutMs must be a positive integer");

      // Invalid overallTimeoutMs
      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: MOCK_RPC_URL,
            budgetManager,
            transport: mockTransport,
            overallTimeoutMs: -5,
          }),
      ).toThrow("overallTimeoutMs must be a positive integer");

      // Invalid pacingMs
      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: MOCK_RPC_URL,
            budgetManager,
            transport: mockTransport,
            pacingMs: -500,
          }),
      ).toThrow("pacingMs must be a non-negative integer");
    });
  });

  describe("Finding 1: Immutable Identity Binding & Input Validation", () => {
    it("fetches, decodes, and ingests a valid Raydium BUY transaction into the tracker", async () => {
      const signature = "SigBuy1111111111111111111111111111111111111111111111111111";
      const payload = createSyntheticBuyPayload(signature);

      let capturedBody: string | undefined;
      const mockTransport: typeof fetch = async (_url, init) => {
        capturedBody = String(init?.body);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      const result = await adapter.processNotification(signature, tracker);

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe("SUCCESS");
      expect(result.ingestedEventsCount).toBe(1);
      expect(result.diagnostics.httpAttempts).toBe(1);
      expect(result.diagnostics.httpStatus).toBe(200);

      // Verify RPC payload
      expect(capturedBody).toBeDefined();
      const rpcJson = JSON.parse(capturedBody!);
      expect(rpcJson.method).toBe("getTransaction");
      expect(rpcJson.params[0]).toBe(signature);
      expect(rpcJson.params[1].encoding).toBe("json");

      // Verify tracker state
      expect(tracker.getEventsCount()).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);
      // Finding 5: default purpose is CANDIDATE_ENRICHMENT
      expect(budgetManager.getStats().enrichmentRequests).toBe(1);
    });

    it("freezes notification on enqueue so caller mutation does not change fetched signature", async () => {
      const originalSig = "SigFreezeA11111111111111111111111111111111111111111111111";
      const mutatedSig = "SigFreezeB22222222222222222222222222222222222222222222222";
      const payload = createSyntheticBuyPayload(originalSig);

      let requestedSig = "";
      const mockTransport: typeof fetch = async (_url, init) => {
        const bodyObj = JSON.parse(String(init?.body));
        requestedSig = bodyObj.params[0];
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      const mutableNotif = { signature: originalSig };
      const enq = adapter.enqueueNotification(mutableNotif);
      expect(enq.ok).toBe(true);

      // Mutate caller object immediately after enqueue
      mutableNotif.signature = mutatedSig;

      // Process queued notification
      const procRes = await adapter.processNextPending(tracker);
      expect(procRes?.ok).toBe(true);

      // CRITICAL CHECK: Ingested and fetched signature MUST be originalSig, NOT mutatedSig
      expect(requestedSig).toBe(originalSig);
      expect(procRes?.signature).toBe(originalSig);
      expect(tracker.getEventsCount()).toBe(1);
    });

    it("rejects null, undefined, and non-object notifications with INVALID_NOTIFICATION without throwing", async () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
      });

      // Direct processNotification checks
      const resNull = await adapter.processNotification(null, tracker);
      expect(resNull.ok).toBe(false);
      expect(resNull.outcome).toBe("INVALID_NOTIFICATION");
      expect(resNull.ingestedEventsCount).toBe(0);

      const resUndef = await adapter.processNotification(undefined, tracker);
      expect(resUndef.ok).toBe(false);
      expect(resUndef.outcome).toBe("INVALID_NOTIFICATION");

      const resEmptyObj = await adapter.processNotification({}, tracker);
      expect(resEmptyObj.ok).toBe(false);
      expect(resEmptyObj.outcome).toBe("INVALID_NOTIFICATION");

      // enqueueNotification checks
      const enqNull = adapter.enqueueNotification(null);
      expect(enqNull.ok).toBe(false);
      expect(enqNull.reason).toBe("INVALID_NOTIFICATION");

      const enqNum = adapter.enqueueNotification(12345);
      expect(enqNum.ok).toBe(false);
      expect(enqNum.reason).toBe("INVALID_NOTIFICATION");

      const procBadSig = await adapter.processNotification("NotBase58!!", tracker);
      expect(procBadSig.ok).toBe(false);
      expect(procBadSig.outcome).toBe("INVALID_NOTIFICATION");
    });

    it("rejects response when returned transaction signature mismatches requested signature", async () => {
      const requestedSig = "SigRequested111111111111111111111111111111111111111111111";
      const differentSig = "SigDifferent222222222222222222222222222222222222222222222";
      const payload = createSyntheticBuyPayload(differentSig);

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      const res = await adapter.processNotification(requestedSig, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("RESPONSE_SIGNATURE_MISMATCH");
      expect(res.ingestedEventsCount).toBe(0);
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(tracker.getEventsCount()).toBe(0); // Zero ingested events!
    });

    it("rejects transaction with contradictory slot metadata without ingesting", async () => {
      const signature = "SigSwapMismatch1111111111111111111111111111111111111111111";
      const payload = createSyntheticBuyPayload(
        signature,
        50_000_000n,
        25_000_000_000n,
        SYNTHETIC_POOL_ID,
        300_000_000,
      );

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      // Notification claims slot 100, response contains slot 300_000_000
      const notif: InjectedTransactionNotification = {
        signature,
        slot: 100,
      };

      const res = await adapter.processNotification(notif, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("CONTRADICTORY_METADATA");
      expect(res.ingestedEventsCount).toBe(0);
      expect(tracker.getEventsCount()).toBe(0);
    });

    it("rejects transaction with contradictory blockTime metadata without ingesting", async () => {
      const signature = "SigTimeMismatch111111111111111111111111111111111111111111";
      const payload = createSyntheticBuyPayload(
        signature,
        50_000_000n,
        25_000_000_000n,
        SYNTHETIC_POOL_ID,
        280_000_100,
        1_700_000_000,
      );

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      // Notification claims blockTime 1_600_000_000, response contains 1_700_000_000
      const notif: InjectedTransactionNotification = {
        signature,
        blockTime: 1_600_000_000,
      };

      const res = await adapter.processNotification(notif, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("CONTRADICTORY_METADATA");
      expect(res.ingestedEventsCount).toBe(0);
      expect(tracker.getEventsCount()).toBe(0);
    });
  });

  describe("Finding 2: Loss Preservation, Backlog & Partial Ingestion", () => {
    it("records collection gap when TRANSACTION_NOT_FOUND occurs, invalidating false SUFFICIENT coverage", async () => {
      const baseEpoch = 1_700_000_060_000;
      const clock = () => baseEpoch;
      const signature = "SigNotFoundGap1111111111111111111111111111111111111111111";

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });

      // Establish tracker with continuous observation coverage across [baseEpoch - 60s, baseEpoch]
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        trackingStartedMs: baseEpoch - 60_000,
        clock,
      });
      tracker.recordCompletedRange(baseEpoch - 60_000, baseEpoch);

      // Verify coverage was SUFFICIENT before the failed transaction
      const evalBefore = tracker.evaluateWindow(baseEpoch);
      expect(evalBefore.coverage).toBe("SUFFICIENT");
      expect(evalBefore.recentBuys60s).toBe(0);

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("TRANSACTION_NOT_FOUND");

      // CRITICAL CHECK: Collection gap was recorded in tracker; coverage is NO LONGER SUFFICIENT
      const evalAfter = tracker.evaluateWindow(baseEpoch);
      expect(evalAfter.coverage).toBe("COLLECTION_GAP");
      expect(evalAfter.recentBuys60s).toBeNull(); // Trade count is withheld due to missing transaction!
    });

    it("buffers loss gap on queue overflow and flushes to tracker on intake; draining queue does not erase gap", async () => {
      const baseEpoch = 1_700_000_060_000;
      const clock = () => baseEpoch;
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        maxPendingQueueSize: 1, // Only 1 item fits
        clock,
      });

      const sig1 = "SigQueueA11111111111111111111111111111111111111111111111111";
      const sig2 = "SigQueueB22222222222222222222222222222222222222222222222222";

      const enq1 = adapter.enqueueNotification(sig1);
      expect(enq1.ok).toBe(true);

      // Enqueueing second item before tracker is supplied causes QUEUE_OVERFLOW loss
      const enq2 = adapter.enqueueNotification(sig2);
      expect(enq2.ok).toBe(false);
      expect(enq2.reason).toBe("QUEUE_OVERFLOW");
      expect(adapter.getPendingGapsCount()).toBe(1); // Gap buffered in adapter!

      // Now create tracker with continuous coverage
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        trackingStartedMs: baseEpoch - 60_000,
        clock,
      });
      tracker.recordCompletedRange(baseEpoch - 60_000, baseEpoch);

      // Pass tracker to adapter and drain queue
      const batchResult = await adapter.processAllPending(tracker);
      expect(batchResult.totalProcessed).toBe(1);
      expect(adapter.getPendingQueueLength()).toBe(0); // Queue drained!
      expect(adapter.getPendingGapsCount()).toBe(0); // Gap was flushed to tracker!

      // CRITICAL CHECK: Queue draining does NOT erase the gap in tracker
      const evalWindow = tracker.evaluateWindow(baseEpoch);
      expect(evalWindow.coverage).toBe("COLLECTION_GAP");
    });

    it("accurately reports PARTIAL_INGEST_FAILED when tracker capacity limit rejects a subset of decoded swaps", async () => {
      const baseEpoch = 1_700_000_000_000;
      const clock = () => baseEpoch;
      const signature = "SigPartSwap2222222222222222222222222222222222222222222222";

      // Create payload with 2 BUY swaps in 1 transaction
      const multiSwapPayload = createSyntheticMultiSwapPayload(signature);

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: multiSwapPayload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });

      // Create tracker with maxEventsRetained = 10, prefilled with 9 events so the second swap is rejected at capacity
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        maxEventsRetained: 10,
        trackingStartedMs: baseEpoch - 60_000,
        clock,
      });

      // Pre-fill tracker with 9 events
      for (let i = 0; i < 9; i++) {
        tracker.ingestTrade({
          eventId: `prefill-${i}`,
          signature: `SigPre${i}11111111111111111111111111111111111111111111111111111`,
          swapIndex: 0,
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          side: "BUY",
          slot: 280_000_100,
          blockTimeSec: null,
          eventTimestampMs: baseEpoch - 10_000 + i,
          receiptTimestampMs: baseEpoch,
          timestampProvenance: "SYNTHETIC_FIXTURE",
          tokenAmount: 1000n,
          solAmount: 100n,
        });
      }
      expect(tracker.getEventsCount()).toBe(9);

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("PARTIAL_INGEST_FAILED");
      expect(res.ingestedEventsCount).toBe(1); // Preserves exact count ingested!
      expect(res.diagnostics.decodedEventsCount).toBe(2);
      expect(res.diagnostics.error).toMatch(/Partial tracker ingestion failure: 1\/2/);
      expect(tracker.getEventsCount()).toBe(10); // 9 prefill + 1 ingested
    });
  });

  describe("Finding 3: Deduplication & Workload Bounds", () => {
    it("protects queued/in-flight signatures from eviction when maxDeduplicationKeys is small", () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        maxDeduplicationKeys: 1, // Historical cache limit of 1
        maxPendingQueueSize: 10,
      });

      const sigA = "SigDedupA11111111111111111111111111111111111111111111111";
      const sigB = "SigDedupB22222222222222222222222222222222222222222222222";

      const enqA1 = adapter.enqueueNotification(sigA);
      expect(enqA1.ok).toBe(true);

      const enqB = adapter.enqueueNotification(sigB);
      expect(enqB.ok).toBe(true);

      // While A is still pending in the queue, enqueueing A again MUST be rejected as duplicate
      const enqA2 = adapter.enqueueNotification(sigA);
      expect(enqA2.ok).toBe(false);
      expect(enqA2.reason).toBe("DUPLICATE_NOTIFICATION");
      expect(adapter.getPendingQueueLength()).toBe(2);
    });

    it("enforces maxPendingQueueSize across direct processNotification calls", async () => {
      const signature = "SigWorkA11111111111111111111111111111111111111111111111111";
      const payload = createSyntheticBuyPayload(signature);

      let releaseTransport: (() => void) | undefined;
      const mockTransport: typeof fetch = async () => {
        await new Promise<void>((resolve) => {
          releaseTransport = resolve;
        });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        maxPendingQueueSize: 1, // Hard ceiling of 1 active item
      });

      // Call 1: starts processing and enters in-flight state
      const promise1 = adapter.processNotification(signature, tracker);
      expect(adapter.getInFlightCount()).toBe(1);
      expect(adapter.getActiveWorkload()).toBe(1);

      // Call 2 (different signature): attempted while call 1 is in-flight -> rejected with QUEUE_OVERFLOW
      const sig2 = "SigWorkB22222222222222222222222222222222222222222222222222";
      const res2 = await adapter.processNotification(sig2, tracker);
      expect(res2.ok).toBe(false);
      expect(res2.outcome).toBe("QUEUE_OVERFLOW");

      // Release call 1
      releaseTransport?.();
      const res1 = await promise1;
      expect(res1.ok).toBe(true);
      expect(adapter.getInFlightCount()).toBe(0);
    });

    it("enforces bounded FIFO eviction on completed signatures", async () => {
      let currentEpoch = 10_000;
      const clock = () => currentEpoch;
      const sleepFn = async (ms: number) => {
        currentEpoch += ms;
      };

      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 0,
        clock,
      });
      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
          status: 200,
        });
      };
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        maxDeduplicationKeys: 2, // Bounded completed history of 2
        clock,
        sleepFn,
      });

      const s1 = "SigHist111111111111111111111111111111111111111111111111111";
      const s2 = "SigHist222222222222222222222222222222222222222222222222222";
      const s3 = "SigHist333333333333333333333333333333333333333333333333333";

      await adapter.processNotification(s1, tracker);
      await adapter.processNotification(s2, tracker);
      expect(adapter.getCompletedDeduplicationKeysCount()).toBe(2);

      // 3rd item completed: s1 is evicted from completed history
      await adapter.processNotification(s3, tracker);
      expect(adapter.getCompletedDeduplicationKeysCount()).toBe(2);
      expect(adapter.isDuplicate(s1)).toBe(false); // s1 evicted
      expect(adapter.isDuplicate(s2)).toBe(true);
      expect(adapter.isDuplicate(s3)).toBe(true);
    });
  });

  describe("Finding 4: Deadlines & Timeout Protection", () => {
    it("rejects pre-ingestion when transport latency advances clock past overall deadline", async () => {
      const signature = "SigTimeExpired111111111111111111111111111111111111111";
      const payload = createSyntheticBuyPayload(signature);

      let currentEpoch = 10_000;
      const clock = () => currentEpoch;

      const mockTransport: typeof fetch = async () => {
        // Transport artificially delays by 5,000 ms
        currentEpoch += 5_000;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0, clock });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        overallTimeoutMs: 2_500, // 2,500 ms limit
        clock,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("REQUEST_TIMEOUT");
      expect(res.ingestedEventsCount).toBe(0);
      expect(tracker.getEventsCount()).toBe(0); // Ingestion was BLOCKED!
    });

    it("rejects invalid per-operation overallTimeoutMs (NaN or exceeding ceiling) before dispatch", async () => {
      const sigNaN = "SigBadParamA111111111111111111111111111111111111111111111";
      const sigExceed = "SigBadParamB222222222222222222222222222222222222222222222";
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      let transportCalls = 0;
      const mockTransport: typeof fetch = async () => {
        transportCalls++;
        return new Response("{}", { status: 200 });
      };
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        overallTimeoutMs: 10_000,
      });

      // NaN override
      const resNaN = await adapter.processNotification(sigNaN, tracker, { overallTimeoutMs: NaN });
      expect(resNaN.ok).toBe(false);
      expect(resNaN.outcome).toBe("PRE_DISPATCH_DEADLINE_EXCEEDED");
      expect(transportCalls).toBe(0);

      // Exceeding ceiling override (20,000 > 10,000)
      const resExceed = await adapter.processNotification(sigExceed, tracker, {
        overallTimeoutMs: 20_000,
      });
      expect(resExceed.ok).toBe(false);
      expect(resExceed.outcome).toBe("PRE_DISPATCH_DEADLINE_EXCEEDED");
      expect(transportCalls).toBe(0);
    });

    it("aborts stalled response body read promptly and classifies as REQUEST_TIMEOUT (httpAttempts: 1)", async () => {
      const signature = "SigTimeout111111111111111111111111111111111111111111111111";
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      let abortSignalFired = false;
      const mockTransport: typeof fetch = async (_url, init) => {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: () =>
            new Promise<string>((_, reject) => {
              if (init?.signal) {
                init.signal.addEventListener("abort", () => {
                  abortSignalFired = true;
                  const abortErr = new Error("AbortError: The operation was aborted");
                  abortErr.name = "AbortError";
                  reject(abortErr);
                });
              }
            }),
        } as unknown as Response;
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        timeoutMs: 50, // 50ms timeout for rapid offline verification
      });

      const res = await adapter.processNotification(signature, tracker);

      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("REQUEST_TIMEOUT");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(abortSignalFired).toBe(true);
    });
  });

  describe("Finding 5: Pacing, Budget Reservations & Transport Policy", () => {
    it("enforces pacingMs = 5000 spacing even if budgetManager has 2500 ms spacing", async () => {
      const sig = "SharedPacingSig111111111111111111111111111111111111111111111";

      let currentEpoch = 10_000;
      const clock = () => currentEpoch;

      let sleepWaitRecorded = 0;
      const sleepFn = async (ms: number) => {
        sleepWaitRecorded += ms;
        currentEpoch += ms;
      };

      const mockTransport: typeof fetch = async (_url, init) => {
        const bodyObj = JSON.parse(String(init?.body)) as { params?: [string] };
        const reqSig = bodyObj?.params?.[0] ?? sig;
        const dynamicPayload = createSyntheticBuyPayload(
          reqSig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          280_000_100,
          Math.floor(currentEpoch / 1000),
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: dynamicPayload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 2500, // Budget manager configured with 2,500 ms
        clock,
      });

      const sig0 = "SharedPacingZero1111111111111111111111111111111111111111111";
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      // Adapter configured with pacingMs: 5000
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 5000,
        clock,
        sleepFn,
      });

      // First dispatch occurs at 10_000 without pacing wait
      const res0 = await adapter.processNotification(sig0, tracker);
      expect(res0.ok).toBe(true);
      expect(sleepWaitRecorded).toBe(0);

      // Advance clock by 1,000 ms to 11_000
      currentEpoch = 11_000;

      const res = await adapter.processNotification(sig, tracker);
      expect(res.ok).toBe(true);

      // Must wait remaining 4,000 ms (5,000 - 1,000), NOT just 1,500 ms!
      expect(sleepWaitRecorded).toBe(4000);
      expect(currentEpoch).toBe(15_000);
    });

    it("enforces adapter 2,500 ms minimum host pacing even when budgetManager has zero spacing", async () => {
      const sig = "SigPacingZeroBudget111111111111111111111111111111111111111";

      let currentEpoch = 10_000;
      const clock = () => currentEpoch;

      let sleepWaitRecorded = 0;
      const sleepFn = async (ms: number) => {
        sleepWaitRecorded += ms;
        currentEpoch += ms;
      };

      const mockTransport: typeof fetch = async (_url, init) => {
        const bodyObj = JSON.parse(String(init?.body)) as { params?: [string] };
        const reqSig = bodyObj?.params?.[0] ?? sig;
        const dynamicPayload = createSyntheticBuyPayload(
          reqSig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          280_000_100,
          Math.floor(currentEpoch / 1000),
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: dynamicPayload }), {
          status: 200,
        });
      };

      // Budget manager configured with 0 spacing
      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 0,
        clock,
      });

      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const sig0 = "SharedPacingZero2222222222222222222222222222222222222222222";

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
        sleepFn,
      });

      // First dispatch occurs at 10_000 without pacing wait
      const res0 = await adapter.processNotification(sig0, tracker);
      expect(res0.ok).toBe(true);
      expect(sleepWaitRecorded).toBe(0);

      // Advance clock by 500 ms to 10_500
      currentEpoch = 10_500;

      const res = await adapter.processNotification(sig, tracker);
      expect(res.ok).toBe(true);

      // Adapter must wait 2,000 ms (2,500 - 500) despite budgetManager having 0 spacing!
      expect(sleepWaitRecorded).toBe(2000);
      expect(currentEpoch).toBe(12_500);
    });

    it("preserves reserved forward observation capacity by defaulting routine trade retrieval to CANDIDATE_ENRICHMENT", async () => {
      const sig1 = "SigReserve11111111111111111111111111111111111111111111111";
      const sig2 = "SigReserve22222222222222222222222222222222222222222222222";
      const payload = createSyntheticBuyPayload(sig1);

      let transportCalls = 0;
      const mockTransport: typeof fetch = async () => {
        transportCalls++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      // Set maxTotalRequests = 5 and minReservedForwardRequests = 4 (default).
      // Only 1 unreserved request is available for CANDIDATE_ENRICHMENT.
      const budgetManager = new GlobalResourceBudgetManager({
        maxTotalRequests: 5,
        minReservedForwardRequests: 4,
        minProviderSpacingMs: 0,
      });

      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
      });

      // Request 1: succeeds and consumes the 1 allowable CANDIDATE_ENRICHMENT request
      const res1 = await adapter.processNotification(sig1, tracker);
      expect(res1.ok).toBe(true);
      expect(transportCalls).toBe(1);

      // Request 2: PRE_DISPATCH_BUDGET_DENIED because 4 remaining requests are strictly reserved for FORWARD_OBSERVATION
      const res2 = await adapter.processNotification(sig2, tracker);
      expect(res2.ok).toBe(false);
      expect(res2.outcome).toBe("PRE_DISPATCH_BUDGET_DENIED");
      expect(res2.diagnostics.httpAttempts).toBe(0); // Zero dispatch!
      expect(transportCalls).toBe(1);
    });
  });

  describe("Finding 6: Sanitized Diagnostics & Failure Classifications", () => {
    it("redacts endpoint API-key sentinels and query secrets from diagnostics and error messages", async () => {
      const secretRpcUrl = "https://solana-mainnet.g.alchemy.com/v2/SECRET_KEY_12345?auth=TOKEN_99";
      const signature = "SigSanitize1111111111111111111111111111111111111111111111";

      const mockTransport: typeof fetch = async () => {
        throw new Error(
          "Network failure connecting to https://solana-mainnet.g.alchemy.com/v2/SECRET_KEY_12345?auth=TOKEN_99",
        );
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: secretRpcUrl,
        budgetManager,
        transport: mockTransport,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("NETWORK_ERROR");

      // Verify that secret tokens are redacted to [REDACTED]
      expect(res.diagnostics.error).toBeDefined();
      expect(res.diagnostics.error).not.toContain("SECRET_KEY_12345");
      expect(res.diagnostics.error).not.toContain("TOKEN_99");
      expect(res.diagnostics.error).toContain("[REDACTED]");
    });

    it("classifies HTTP 500 error as HTTP_ERROR with attempt counted (httpAttempts: 1)", async () => {
      const signature = "SigErrFive111111111111111111111111111111111111111111111111";
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const mockTransport: typeof fetch = async () => {
        return new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      const res = await adapter.processNotification(signature, tracker);

      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("HTTP_ERROR");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(res.diagnostics.httpStatus).toBe(500);
      expect(tracker.getEventsCount()).toBe(0);
    });

    it("classifies non-JSON body as MALFORMED_RESPONSE with httpAttempts: 1", async () => {
      const signature = "SigNonJson111111111111111111111111111111111111111111111111";
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const mockTransport: typeof fetch = async () => {
        return new Response("<html><head><title>Bad Gateway</title></head></html>", {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      const res = await adapter.processNotification(signature, tracker);

      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("MALFORMED_RESPONSE");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(res.diagnostics.error).toMatch(/JSON parse error/);
    });

    it("classifies RPC error response as RPC_ERROR with httpAttempts: 1", async () => {
      const signature = "SigRpcErr1111111111111111111111111111111111111111111111111";
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });

      const mockTransport: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "Invalid request" },
          }),
          { status: 200 },
        );
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
      });

      const res = await adapter.processNotification(signature, tracker);

      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("RPC_ERROR");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(res.diagnostics.error).toMatch(/RPC returned error/);
    });

    it("classifies non-matching pool transaction as DECODE_FAILED (NO_MATCHING_SWAPS_FOUND)", async () => {
      const signature = "SigDiff1111111111111111111111111111111111111111111111111111";
      const baseEpoch = 1_700_000_000_000;
      const clock = () => baseEpoch;

      // Payload contains a different pool ID (SYNTHETIC_OTHER_POOL_ID)
      const payload = createSyntheticBuyPayload(
        signature,
        50_000_000n,
        25_000_000_000n,
        SYNTHETIC_OTHER_POOL_ID,
      );

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("DECODE_FAILED");
      expect(res.diagnostics.error).toMatch(/NO_MATCHING_SWAPS_FOUND/);
    });

    it("preserves notification receiptTimestampMs and provenance on the resulting TradeEvent", async () => {
      const baseEpoch = 1_700_000_000_000;
      const clock = () => baseEpoch + 2_000;

      const signature = "SigProv111111111111111111111111111111111111111111111111111";
      const payload = createSyntheticBuyPayload(signature);

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      let capturedEvent: unknown = null;
      const origIngest = tracker.ingestTrade.bind(tracker);
      tracker.ingestTrade = (event) => {
        capturedEvent = event;
        return origIngest(event);
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        clock,
      });

      const customReceiptMs = baseEpoch + 1_500;
      const notif: InjectedTransactionNotification = {
        signature,
        receivedAtMs: customReceiptMs,
        provenance: "HOST_OBSERVED",
      };

      const res = await adapter.processNotification(notif, tracker);
      expect(res.ok).toBe(true);

      expect(capturedEvent).not.toBeNull();
      const trade = capturedEvent as {
        signature: string;
        receiptTimestampMs: number;
        timestampProvenance: string;
      };
      expect(trade.signature).toBe(signature);
      expect(trade.receiptTimestampMs).toBe(customReceiptMs);
      expect(trade.timestampProvenance).toBe("HOST_OBSERVED");
    });
  });

  describe("Follow-up Audit Corrections: Backlog, Concurrency Admission, Bounded Gaps, and Envelope Diagnostics", () => {
    // Finding 1: Universal backlog protection
    describe("Finding 1: Universal Backlog Protection", () => {
      it("enqueueing an unprocessed notification immediately invalidates SUFFICIENT coverage to PROCESSING_BACKLOG", async () => {
        const baseEpoch = 1_700_000_000_000;
        const currentEpoch = baseEpoch + 60_000;
        const clock = () => currentEpoch;

        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          trackingStartedMs: baseEpoch,
          clock,
        });

        // Establish complete observation range [baseEpoch, currentEpoch]
        tracker.recordCompletedRange(baseEpoch, currentEpoch);
        let evalRes = tracker.evaluateWindow(currentEpoch);
        expect(evalRes.coverage).toBe("SUFFICIENT");
        expect(evalRes.isCoverageSufficient).toBe(true);
        expect(evalRes.recentBuys60s).toBe(0);
        expect(evalRes.diagnostics.hasActiveBacklog).toBe(false);

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          tracker,
          clock,
        });

        // Enqueue an unprocessed notification
        const sig = "SigQueuedA2222222222222222222222222222222222222222222222222";
        const enqRes = adapter.enqueueNotification(sig);
        expect(enqRes.ok).toBe(true);
        expect(enqRes.queued).toBe(true);

        // Tracker coverage must now report PROCESSING_BACKLOG and null buy counts!
        evalRes = tracker.evaluateWindow(currentEpoch);
        expect(evalRes.diagnostics.hasActiveBacklog).toBe(true);
        expect(evalRes.coverage).toBe("PROCESSING_BACKLOG");
        expect(evalRes.isCoverageSufficient).toBe(false);
        expect(evalRes.recentBuys60s).toBeNull();
      });

      it("direct in-flight processNotification keeps PROCESSING_BACKLOG active while awaiting response", async () => {
        const baseEpoch = 1_700_000_000_000;
        const currentEpoch = baseEpoch + 60_000;
        const clock = () => currentEpoch;

        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          trackingStartedMs: baseEpoch,
          clock,
        });

        tracker.recordCompletedRange(baseEpoch, currentEpoch);
        expect(tracker.evaluateWindow(currentEpoch).coverage).toBe("SUFFICIENT");

        const sig = "SigProcAct22222222222222222222222222222222222222222222222";
        let releaseTransport!: () => void;
        const mockTransport: typeof fetch = async () => {
          await new Promise<void>((resolve) => {
            releaseTransport = resolve;
          });
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: createSyntheticBuyPayload(sig),
            }),
            { status: 200 },
          );
        };

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          tracker,
          clock,
        });

        const procPromise = adapter.processNotification(sig, tracker);

        // While in-flight, tracker coverage must report PROCESSING_BACKLOG
        expect(adapter.getInFlightCount()).toBe(1);
        const inFlightEval = tracker.evaluateWindow(currentEpoch);
        expect(inFlightEval.diagnostics.hasActiveBacklog).toBe(true);
        expect(inFlightEval.coverage).toBe("PROCESSING_BACKLOG");
        expect(inFlightEval.isCoverageSufficient).toBe(false);

        // Complete the in-flight request
        releaseTransport();
        const res = await procPromise;
        expect(res.ok).toBe(true);

        // After completion and zero active workload, backlog is cleared
        expect(adapter.getActiveWorkload()).toBe(0);
        const afterEval = tracker.evaluateWindow(currentEpoch);
        expect(afterEval.diagnostics.hasActiveBacklog).toBe(false);
      });

      it("notifications queued before tracker association mark backlog immediately upon association", async () => {
        const baseEpoch = 1_700_000_000_000;
        const currentEpoch = baseEpoch + 60_000;
        const clock = () => currentEpoch;

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          clock,
        });

        // Queue notification before tracker exists
        const sig = "SigPreAssoc11111111111111111111111111111111111111111111111";
        adapter.enqueueNotification(sig);
        expect(adapter.getActiveWorkload()).toBe(1);

        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          trackingStartedMs: baseEpoch,
          clock,
        });
        tracker.recordCompletedRange(baseEpoch, currentEpoch);

        // Associating tracker must immediately propagate backlog!
        adapter.associateTracker(tracker);
        const evalRes = tracker.evaluateWindow(currentEpoch);
        expect(evalRes.diagnostics.hasActiveBacklog).toBe(true);
        expect(evalRes.coverage).toBe("PROCESSING_BACKLOG");
      });

      it("draining the queue clears backlog but preserves recorded collection gaps", async () => {
        const baseEpoch = 1_700_000_000_000;
        const currentEpoch = baseEpoch + 60_000;
        const clock = () => currentEpoch;

        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          trackingStartedMs: baseEpoch,
          clock,
        });
        tracker.recordCompletedRange(baseEpoch, currentEpoch);

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        // Transport returns not found for sig1, producing a collection gap
        const mockTransport: typeof fetch = async () => {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
            status: 200,
          });
        };

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          tracker,
          clock,
        });

        const sig1 = "SigDrainGap11111111111111111111111111111111111111111111111";
        adapter.enqueueNotification(sig1);

        // Before drain: backlog is active
        expect(tracker.evaluateWindow(currentEpoch).coverage).toBe("PROCESSING_BACKLOG");

        // Drain queue
        const batchRes = await adapter.processAllPending(tracker);
        expect(batchRes.totalProcessed).toBe(1);
        expect(batchRes.totalFailed).toBe(1);

        // Workload is now 0, backlog is false, but collection gap MUST be preserved fail-closed!
        expect(adapter.getActiveWorkload()).toBe(0);
        const evalRes = tracker.evaluateWindow(currentEpoch);
        expect(evalRes.diagnostics.hasActiveBacklog).toBe(false);
        expect(evalRes.coverage).toBe("COLLECTION_GAP");
        expect(evalRes.isCoverageSufficient).toBe(false);
      });
    });

    // Finding 2: Safe Dispatch Admission Under Concurrency
    describe("Finding 2: Safe Dispatch Admission Under Concurrency", () => {
      it("serializes concurrent dispatches deterministically to offsets 0, 5000, 10000, 15000 ms", async () => {
        const baseEpoch = 1_700_000_000_000;
        let currentEpoch = baseEpoch;
        const clock = () => currentEpoch;
        const sleepFn = async (ms: number) => {
          currentEpoch += ms;
        };

        const recordedDispatchOffsets: number[] = [];

        const mockTransport: typeof fetch = async (_url, init) => {
          recordedDispatchOffsets.push(clock() - baseEpoch);
          const reqBody = JSON.parse(String(init?.body));
          const requestedSig = reqBody.params[0];
          const payload = createSyntheticBuyPayload(requestedSig);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
            status: 200,
          });
        };

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          clock,
        });

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          pacingMs: 5000,
          maxPendingQueueSize: 10,
          clock,
          sleepFn,
        });

        const sigs = [
          "SigConcA1111111111111111111111111111111111111111111111111",
          "SigConcB2222222222222222222222222222222222222222222222222",
          "SigConcC3333333333333333333333333333333333333333333333333",
          "SigConcD4444444444444444444444444444444444444444444444444",
        ];

        // Fire all 4 requests concurrently
        const results = await Promise.all(
          sigs.map((sig) => adapter.processNotification(sig, tracker)),
        );

        expect(results.every((r) => r.ok)).toBe(true);
        expect(recordedDispatchOffsets).toEqual([0, 5000, 10000, 15000]);
      });

      it("waiting operations remain bounded by maxPendingQueueSize during concurrent bursts", async () => {
        let shouldRelease = false;
        const pendingResolves: (() => void)[] = [];
        const payload = createSyntheticBuyPayload(
          "SigBurstWait11111111111111111111111111111111111111111111",
        );

        const mockTransport: typeof fetch = async () => {
          if (!shouldRelease) {
            await new Promise<void>((resolve) => {
              pendingResolves.push(resolve);
            });
          }
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
            status: 200,
          });
        };

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
        });

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          maxPendingQueueSize: 2, // Only 2 concurrent operations allowed
        });

        const p1 = adapter.processNotification(
          "SigBurstWait11111111111111111111111111111111111111111111",
          tracker,
        );
        const p2 = adapter.processNotification(
          "SigBurstWait22222222222222222222222222222222222222222222",
          tracker,
        );

        // 3rd call exceeds maxPendingQueueSize (2) -> rejected immediately with QUEUE_OVERFLOW
        const res3 = await adapter.processNotification(
          "SigBurstWait33333333333333333333333333333333333333333333",
          tracker,
        );
        expect(res3.ok).toBe(false);
        expect(res3.outcome).toBe("QUEUE_OVERFLOW");

        shouldRelease = true;
        for (const resolve of pendingResolves) {
          resolve();
        }
        await Promise.all([p1, p2]);
      });

      it("cancellation of a middle waiter preserves predecessor ordering and spacing", async () => {
        const baseEpoch = 1_700_000_000_000;
        let currentEpoch = baseEpoch;
        const clock = () => currentEpoch;

        let resolveASleep!: () => void;
        let aSleepStarted = false;
        const aSleepPromise = new Promise<void>((resolve) => {
          resolveASleep = resolve;
        });

        // sleepFn intercepts Request A's 5000ms pacing wait so A holds admission while B and C queue
        const sleepFn = async (ms: number) => {
          if (!aSleepStarted && ms === 5000) {
            aSleepStarted = true;
            await aSleepPromise;
          }
          currentEpoch += ms;
        };

        const recordedDispatchOffsets: number[] = [];

        const mockTransport: typeof fetch = async (_url, init) => {
          recordedDispatchOffsets.push(clock() - baseEpoch);
          const reqBody = JSON.parse(String(init?.body));
          const requestedSig = reqBody.params[0];
          const payload = createSyntheticBuyPayload(requestedSig);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
            status: 200,
          });
        };

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          clock,
        });

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          pacingMs: 5000,
          maxPendingQueueSize: 10,
          clock,
          sleepFn,
        });

        const sigInit = "SigPaceHead111111111111111111111111111111111111111111111";
        const sigA = "SigPaceA111111111111111111111111111111111111111111111111";
        const sigB = "SigPaceB222222222222222222222222222222222222222222222222";
        const sigC = "SigPaceC333333333333333333333333333333333333333333333333";

        // 1. Complete initial dispatch at offset 0
        const initRes = await adapter.processNotification(sigInit, tracker);
        expect(initRes.ok).toBe(true);
        expect(recordedDispatchOffsets).toEqual([0]);

        // 2. Request A enters its 5000 ms pacing wait and holds admission
        const promiseA = adapter.processNotification(sigA, tracker);

        // 3. Request B waits behind A with an AbortController
        const abortB = new AbortController();
        const promiseB = adapter.processNotification(sigB, tracker, { signal: abortB.signal });

        // 4. Request C waits behind B
        const promiseC = adapter.processNotification(sigC, tracker);

        expect(adapter.getInFlightCount()).toBe(3);

        // 5. Cancel B before A releases admission
        abortB.abort();

        const resB = await promiseB;
        expect(resB.ok).toBe(false);
        expect(resB.outcome).toBe("PRE_DISPATCH_DEADLINE_EXCEEDED");
        expect(resB.diagnostics.httpAttempts).toBe(0);
        // B's workload is released promptly!
        expect(adapter.getInFlightCount()).toBe(2);

        // Assert that C has NOT bypassed A while A still holds admission
        expect(recordedDispatchOffsets).toEqual([0]);

        // 6. Release A's pacing wait
        resolveASleep();

        const [resA, resC] = await Promise.all([promiseA, promiseC]);
        expect(resA.ok).toBe(true);
        expect(resC.ok).toBe(true);

        // Verified dispatch offsets: 0, 5000, 10000 ms (NEVER 0, 5000, 5000 ms)
        expect(recordedDispatchOffsets).toEqual([0, 5000, 10000]);
        expect(adapter.getInFlightCount()).toBe(0);
      });

      it("admission waiting expires at operation's own deadline and releases workload capacity promptly", async () => {
        const baseEpoch = 1_700_000_000_000;
        let currentEpoch = baseEpoch;
        const clock = () => currentEpoch;

        let releaseASleep!: () => void;
        let aSleepStarted = false;
        const aSleepPromise = new Promise<void>((resolve) => {
          releaseASleep = resolve;
        });

        // sleepFn intercepts predecessor A so A remains in its 5000 ms pacing wait
        const sleepFn = async (ms: number) => {
          if (!aSleepStarted && ms > 0) {
            aSleepStarted = true;
            await aSleepPromise;
          }
          currentEpoch += ms;
        };

        let transportCalls = 0;
        const mockTransport: typeof fetch = async (_url, init) => {
          transportCalls++;
          const reqBody = JSON.parse(String(init?.body));
          const requestedSig = reqBody.params[0];
          const payload = createSyntheticBuyPayload(requestedSig);
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
            status: 200,
          });
        };

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          clock,
        });

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          pacingMs: 5000,
          maxPendingQueueSize: 10,
          clock,
          sleepFn,
        });

        const sigInit = "SigDeadHead111111111111111111111111111111111111111111111";
        const sigA = "SigDeadA111111111111111111111111111111111111111111111111";
        const sigB = "SigDeadB222222222222222222222222222222222222222222222222";
        const sigC = "SigDeadC333333333333333333333333333333333333333333333333";

        // Complete initial dispatch
        await adapter.processNotification(sigInit, tracker);
        expect(transportCalls).toBe(1);

        // Predecessor A enters 5000 ms pacing wait and is held
        const promiseA = adapter.processNotification(sigA, tracker);

        // Operation B has overallTimeoutMs = 50 and waits behind A
        const promiseB = adapter.processNotification(sigB, tracker, { overallTimeoutMs: 50 });

        // Operation C waits behind B
        const promiseC = adapter.processNotification(sigC, tracker);

        expect(adapter.getInFlightCount()).toBe(3);

        // Operation B must expire promptly at its 50 ms deadline while A is STILL waiting!
        const resB = await promiseB;
        expect(resB.ok).toBe(false);
        expect(resB.outcome).toBe("PRE_DISPATCH_DEADLINE_EXCEEDED");
        expect(resB.diagnostics.httpAttempts).toBe(0);
        expect(resB.diagnostics.durationMs).toBeLessThan(1000); // Exited at ~50 ms, NOT 5000 ms

        // B released its workload bookkeeping immediately
        expect(adapter.getInFlightCount()).toBe(2);

        // Neither B nor C dispatched while A is unresolved
        expect(transportCalls).toBe(1);

        // Release predecessor A
        releaseASleep();

        const [resA, resC] = await Promise.all([promiseA, promiseC]);
        expect(resA.ok).toBe(true);
        expect(resC.ok).toBe(true);
        expect(transportCalls).toBe(3);

        expect(adapter.getInFlightCount()).toBe(0);
      });
    });

    // Finding 3: Bounded Pending Gaps & Ingested Events Count
    describe("Finding 3: Bounded Loss Metadata & Batch Counting", () => {
      it("bounds and coalesces pending gaps to maxPendingQueueSize, preserving [min(start), max(end)]", () => {
        let currentEpoch = 1_000_000;
        const clock = () => currentEpoch;

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          maxPendingQueueSize: 3, // Bound pending buffer to 3 gaps
          clock,
        });

        // Fill queue to capacity (3 items)
        adapter.enqueueNotification("SigBoundQ11111111111111111111111111111111111111111111111");
        adapter.enqueueNotification("SigBoundQ22222222222222222222222222222222222222222222222");
        adapter.enqueueNotification("SigBoundQ33333333333333333333333333333333333333333333333");

        const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        // Now trigger 100 queue overflows across time
        for (let i = 0; i < 100; i++) {
          currentEpoch += 1000;
          const char1 = B58[Math.floor(i / 50)]!;
          const char2 = B58[i % 50]!;
          const overflowSig = `SigDrop${char1}${char2}22222222222222222222222222222222222222222222`;
          const res = adapter.enqueueNotification(overflowSig);
          expect(res.reason).toBe("QUEUE_OVERFLOW");
        }

        // pendingGaps must be bounded by maxPendingQueueSize (3)
        expect(adapter.getPendingGapsCount()).toBeLessThanOrEqual(3);

        // Flushed to tracker evaluates to COLLECTION_GAP
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          trackingStartedMs: 900_000,
          clock,
        });
        tracker.recordCompletedRange(900_000, currentEpoch);
        adapter.flushPendingGaps(tracker);

        const evalRes = tracker.evaluateWindow(currentEpoch);
        expect(evalRes.coverage).toBe("COLLECTION_GAP");
        expect(evalRes.isCoverageSufficient).toBe(false);
      });

      it("processAllPending accumulates totalIngestedEvents even when res.ok === false", async () => {
        const baseEpoch = 1_700_000_000_000;
        const currentEpoch = baseEpoch;
        const clock = () => currentEpoch;

        const sig = "SigPartBatch111111111111111111111111111111111111111111111";
        const multiSwapPayload = createSyntheticMultiSwapPayload(sig);

        const mockTransport: typeof fetch = async () => {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: multiSwapPayload }), {
            status: 200,
          });
        };

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          maxEventsRetained: 10,
          clock,
        });

        // Pre-fill tracker with 9 events so the 2-swap payload partially fails on capacity
        for (let i = 0; i < 9; i++) {
          tracker.ingestTrade({
            eventId: `filler_${i}`,
            signature: `SigFiller${String(i).padStart(3, "2")}22222222222222222222222222222222222222222`,
            swapIndex: 0,
            poolId: SYNTHETIC_POOL_ID,
            tokenMint: SYNTHETIC_CANDIDATE_MINT,
            side: "BUY",
            slot: 100,
            blockTimeSec: null,
            eventTimestampMs: baseEpoch + i,
            receiptTimestampMs: baseEpoch + i,
            timestampProvenance: "SYNTHETIC_FIXTURE",
          });
        }

        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
          clock,
        });

        adapter.enqueueNotification(sig);
        const batchRes = await adapter.processAllPending(tracker);

        expect(batchRes.totalProcessed).toBe(1);
        expect(batchRes.totalSucceeded).toBe(0);
        expect(batchRes.totalFailed).toBe(1);
        expect(batchRes.results[0]!.outcome).toBe("PARTIAL_INGEST_FAILED");
        expect(batchRes.results[0]!.ingestedEventsCount).toBe(1);

        // CRITICAL: totalIngestedEvents must be 1, not 0!
        expect(batchRes.totalIngestedEvents).toBe(1);
      });
    });

    // Finding 4: JSON-RPC Envelope Validation & Audit Diagnostics
    describe("Finding 4: JSON-RPC Envelope Validation and Audit Diagnostics", () => {
      it("rejects invalid JSON-RPC version ('1.0') with MALFORMED_RESPONSE", async () => {
        const mockTransport: typeof fetch = async () => {
          return new Response(JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} }), {
            status: 200,
          });
        };
        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
        });
        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
        });
        const res = await adapter.processNotification(
          "SigEnvVer111111111111111111111111111111111111111111111111",
          tracker,
        );
        expect(res.ok).toBe(false);
        expect(res.outcome).toBe("MALFORMED_RESPONSE");
        expect(res.ingestedEventsCount).toBe(0);
        expect(res.diagnostics.error).toContain("Invalid JSON-RPC version");
      });

      it("rejects mismatched JSON-RPC id (id !== 1) with MALFORMED_RESPONSE", async () => {
        const mockTransport: typeof fetch = async () => {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }), {
            status: 200,
          });
        };
        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
        });
        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
        });
        const res = await adapter.processNotification(
          "SigEnvReqNum222222222222222222222222222222222222222222222222",
          tracker,
        );
        expect(res.ok).toBe(false);
        expect(res.outcome).toBe("MALFORMED_RESPONSE");
        expect(res.ingestedEventsCount).toBe(0);
        expect(res.diagnostics.error).toContain("RPC response id mismatch");
      });

      it("rejects contradictory envelope with both result and error with MALFORMED_RESPONSE", async () => {
        const mockTransport: typeof fetch = async () => {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {},
              error: { code: -32600, message: "err" },
            }),
            { status: 200 },
          );
        };
        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
        });
        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: MOCK_RPC_URL,
          budgetManager,
          transport: mockTransport,
        });
        const res = await adapter.processNotification(
          "SigEnvContra111111111111111111111111111111111111111111111",
          tracker,
        );
        expect(res.ok).toBe(false);
        expect(res.outcome).toBe("MALFORMED_RESPONSE");
        expect(res.ingestedEventsCount).toBe(0);
        expect(res.diagnostics.error).toContain("Contradictory JSON-RPC envelope");
      });

      it("exposes sanitized endpointUrl, request/response timestamps, and responseSha256 on diagnostics", async () => {
        const baseEpoch = 1_700_000_000_000;
        let currentEpoch = baseEpoch;
        const clock = () => currentEpoch;

        const sig = "SigDiagAudit1111111111111111111111111111111111111111111111";
        const payload = createSyntheticBuyPayload(sig);
        const rawResponseBody = JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload });
        const expectedSha256 = createHash("sha256").update(rawResponseBody).digest("hex");

        const mockTransport: typeof fetch = async () => {
          currentEpoch += 250; // 250ms network roundtrip
          return new Response(rawResponseBody, { status: 200 });
        };

        const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
        const tracker = new RollingTradeFlowTracker({
          poolId: SYNTHETIC_POOL_ID,
          tokenMint: SYNTHETIC_CANDIDATE_MINT,
          clock,
        });

        const sensitiveRpcUrl = "https://mock-solana-rpc.internal/?api-key=supersecret123";
        const adapter = new RaydiumAmmV4TransactionSourceAdapter({
          poolContext: STANDARD_POOL_CONTEXT,
          rpcUrl: sensitiveRpcUrl,
          budgetManager,
          transport: mockTransport,
          clock,
        });

        const res = await adapter.processNotification(sig, tracker);
        expect(res.ok).toBe(true);
        expect(res.diagnostics.endpointUrl).toBe(
          "https://mock-solana-rpc.internal/?api-key=[REDACTED]",
        );
        expect(res.diagnostics.requestSentAtMs).toBe(baseEpoch);
        expect(res.diagnostics.responseReceivedAtMs).toBe(baseEpoch + 250);
        expect(res.diagnostics.responseSha256).toBe(expectedSha256);
      });
    });
  });
});
