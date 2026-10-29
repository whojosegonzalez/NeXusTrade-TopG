/**
 * Phase 12.94-D Milestone D.3.3: Bounded Raydium AMM v4 Transaction Source Adapter Tests
 *
 * Verifies:
 * 1. Constructor guards enforcing explicit transport, budget manager, rpcUrl, and pool context.
 * 2. Successful decode-to-tracker ingestion (getTransaction -> RaydiumAmmV4SwapDecoder -> RollingTradeFlowTracker).
 * 3. Duplicate notification deduplication (zero duplicate dispatches, zero duplicate trade counts).
 * 4. Failed request classification (HTTP 500 error, network error, request timeout).
 * 5. Null and malformed RPC results (result: null, invalid JSON, RPC error, decode failure).
 * 6. Global resource budget exhaustion preventing dispatch upfront (httpAttempts: 0).
 * 7. Shared provider pacing with LP adapter across candidates through GlobalResourceBudgetManager.
 * 8. Stalled response-body streams aborted promptly via timeout protection (httpAttempts: 1).
 * 9. Bounded backlog (queue overflow rejection and bounded FIFO deduplication cache eviction).
 * 10. Coverage invariant: Successful retrieval, an empty queue, or notification receipt alone
 *     NEVER establishes complete 60-second window coverage.
 * 11. Strict identity binding and timestamp/provenance preservation.
 *
 * NOTE: All tests execute strictly offline using labeled synthetic fixtures and fake clocks.
 */

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

function makeSplTransferData(amount: bigint): number[] {
  const buf = new Uint8Array(9);
  buf[0] = 3; // Transfer tag
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amount, true);
  return Array.from(buf);
}

function makeRayLogLine(
  logType: 3 | 4,
  direction: "Coin2PC" | "PC2Coin",
  amountIn: bigint,
  amountOut: bigint,
): string {
  const buf = Buffer.alloc(57);
  buf[0] = logType;
  const view = new DataView(buf.buffer);
  view.setBigUint64(1, amountIn, true);
  view.setBigUint64(9, 0n, true);
  view.setBigUint64(17, direction === "PC2Coin" ? 1n : 2n, true);
  view.setBigUint64(49, amountOut, true);
  return `Program log: ray_log: ${buf.toString("base64")}`;
}

function createSyntheticBuyPayload(
  signature: string,
  solIn = 50_000_000n,
  candidateOut = 25_000_000_000n,
  poolId = SYNTHETIC_POOL_ID,
  slot = 280_000_100,
  blockTime = 1_700_000_000,
) {
  const accounts = [
    SPL_TOKEN_PROGRAM_ID, // 0
    poolId, // 1: poolId
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
            programIdIndex: 8, // Raydium SwapBaseInV2
            accounts: [0, 1, 2, 3, 4, 5, 6, 7],
            data: makeSwapBaseInV2Data(solIn, candidateOut),
          },
        ],
      },
    },
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [SYNTHETIC_USER_SOURCE_ATA, SYNTHETIC_QUOTE_VAULT, SYNTHETIC_USER_WALLET],
              data: makeSplTransferData(solIn),
            },
            {
              programId: SPL_TOKEN_PROGRAM_ID,
              accounts: [SYNTHETIC_BASE_VAULT, SYNTHETIC_USER_DEST_ATA, SYNTHETIC_AMM_AUTHORITY],
              data: makeSplTransferData(candidateOut),
            },
          ],
        },
      ],
      logMessages: [
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} invoke [1]`,
        makeRayLogLine(3, "PC2Coin", solIn, candidateOut),
        `Program ${RAYDIUM_AMM_V4_PROGRAM_ID} success`,
      ],
    },
  };
}

describe("RaydiumAmmV4TransactionSourceAdapter", () => {
  describe("Constructor & Configuration Guards", () => {
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

    it("rejects invalid maxPendingQueueSize or maxDeduplicationKeys", () => {
      const budgetManager = new GlobalResourceBudgetManager();
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });

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

      expect(
        () =>
          new RaydiumAmmV4TransactionSourceAdapter({
            poolContext: STANDARD_POOL_CONTEXT,
            rpcUrl: MOCK_RPC_URL,
            budgetManager,
            transport: mockTransport,
            maxDeduplicationKeys: -5,
          }),
      ).toThrow("maxDeduplicationKeys must be an integer >= 1");
    });
  });

  describe("Successful Decode-to-Tracker Ingestion", () => {
    it("fetches, decodes, and ingests a valid Raydium BUY transaction into the tracker", async () => {
      const signature = "SigBuy1111111111111111111111111111111111111111111111111111";
      const payload = createSyntheticBuyPayload(signature);

      let transportCalls = 0;
      const mockTransport: typeof fetch = async (_url, init) => {
        transportCalls++;
        const bodyObj = JSON.parse(String(init?.body));
        expect(bodyObj.method).toBe("getTransaction");
        expect(bodyObj.params[0]).toBe(signature);
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
        pacingMs: 0,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(true);
      expect(res.outcome).toBe("SUCCESS");
      expect(res.ingestedEventsCount).toBe(1);
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(transportCalls).toBe(1);

      // Verify trade event was ingested into tracker
      const trackerCounts = tracker.getEventsCount();
      expect(trackerCounts).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);
      expect(budgetManager.getStats().forwardObservationRequests).toBe(1);
    });
  });

  describe("Duplicate Notification Deduplication", () => {
    it("skips duplicate notifications with zero HTTP dispatches and zero duplicate trade counts", async () => {
      const signature = "SigDup1111111111111111111111111111111111111111111111111111";
      const payload = createSyntheticBuyPayload(signature);

      let transportCalls = 0;
      const mockTransport: typeof fetch = async () => {
        transportCalls++;
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
        pacingMs: 0,
      });

      // First notification: processed
      const res1 = await adapter.processNotification(signature, tracker);
      expect(res1.ok).toBe(true);
      expect(res1.outcome).toBe("SUCCESS");
      expect(transportCalls).toBe(1);
      expect(tracker.getEventsCount()).toBe(1);

      // Second notification with SAME signature: rejected as duplicate
      const res2 = await adapter.processNotification(signature, tracker);
      expect(res2.ok).toBe(false);
      expect(res2.outcome).toBe("DUPLICATE_NOTIFICATION");
      expect(res2.diagnostics.httpAttempts).toBe(0);
      expect(transportCalls).toBe(1); // Transport call count must remain 1!
      expect(tracker.getEventsCount()).toBe(1); // Tracker event count must remain 1!

      // Enqueueing duplicate also fails closed
      const enqRes = adapter.enqueueNotification(signature);
      expect(enqRes.ok).toBe(false);
      expect(enqRes.queued).toBe(false);
      expect(enqRes.reason).toBe("DUPLICATE_NOTIFICATION");

      expect(adapter.getMetrics().totalDuplicatesSkipped).toBe(2);
    });
  });

  describe("Failed Requests & Error Classification", () => {
    it("classifies HTTP 500 error as HTTP_ERROR with attempt counted (httpAttempts: 1)", async () => {
      const signature = "SigErrFive111111111111111111111111111111111111111111111111";

      let transportCalls = 0;
      const mockTransport: typeof fetch = async () => {
        transportCalls++;
        return new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
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
        pacingMs: 0,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("HTTP_ERROR");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(res.diagnostics.httpStatus).toBe(500);
      expect(transportCalls).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);
      expect(tracker.getEventsCount()).toBe(0);
    });

    it("classifies transport exception as NETWORK_ERROR with attempt counted (httpAttempts: 1)", async () => {
      const signature = "NetworkErrTestSig111111111111111111111111111111111111111111";

      let transportCalls = 0;
      const mockTransport: typeof fetch = async () => {
        transportCalls++;
        throw new TypeError("Failed to fetch: ECONNRESET");
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
        pacingMs: 0,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("NETWORK_ERROR");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(res.diagnostics.error).toMatch(/Failed to fetch/);
      expect(transportCalls).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);
    });
  });

  describe("Null & Malformed RPC Results", () => {
    it("classifies result: null as TRANSACTION_NOT_FOUND with httpAttempts: 1", async () => {
      const signature = "MissingTxTestSig1111111111111111111111111111111111111111111";

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
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
        pacingMs: 0,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("TRANSACTION_NOT_FOUND");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(res.diagnostics.error).toMatch(/not found on-chain/);
    });

    it("classifies non-JSON body as MALFORMED_RESPONSE with httpAttempts: 1", async () => {
      const signature = "NonJsonTestSig111111111111111111111111111111111111111111111";

      const mockTransport: typeof fetch = async () => {
        return new Response("<html>Bad Gateway</html>", { status: 200 });
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
        pacingMs: 0,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("MALFORMED_RESPONSE");
      expect(res.diagnostics.httpAttempts).toBe(1);
    });

    it("classifies RPC error response as RPC_ERROR with httpAttempts: 1", async () => {
      const signature = "RpcErrTestSig111111111111111111111111111111111111111111111";

      const mockTransport: typeof fetch = async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "Invalid Request" },
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
        pacingMs: 0,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("RPC_ERROR");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(res.diagnostics.error).toMatch(/Invalid Request/);
    });

    it("classifies non-matching pool transaction as DECODE_FAILED (NO_MATCHING_SWAPS_FOUND)", async () => {
      const signature = "SigDiff1111111111111111111111111111111111111111111111111111";
      // Payload targeting SYNTHETIC_OTHER_POOL_ID
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
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("DECODE_FAILED");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(res.diagnostics.error).toMatch(/NO_MATCHING_SWAPS_FOUND/);
      expect(tracker.getEventsCount()).toBe(0);
    });
  });

  describe("Shared Session Budget & Provider Pacing", () => {
    it("stops pre-dispatch on budget exhaustion without dispatching (httpAttempts: 0)", async () => {
      const sig1 = "SigBudget111111111111111111111111111111111111111111111111111";
      const sig2 = "SigBudget222222222222222222222222222222222222222222222222222";
      const payload = createSyntheticBuyPayload(sig1);

      let transportCalls = 0;
      const mockTransport: typeof fetch = async () => {
        transportCalls++;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      // Ceiling of exactly 1 total request
      const budgetManager = new GlobalResourceBudgetManager({
        maxTotalRequests: 1,
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

      // Request 1: succeeds and consumes the 1 allowable request
      const res1 = await adapter.processNotification(sig1, tracker);
      expect(res1.ok).toBe(true);
      expect(transportCalls).toBe(1);

      // Request 2: denied upfront by budget manager
      const res2 = await adapter.processNotification(sig2, tracker);
      expect(res2.ok).toBe(false);
      expect(res2.outcome).toBe("PRE_DISPATCH_BUDGET_DENIED");
      expect(res2.diagnostics.httpAttempts).toBe(0);
      expect(transportCalls).toBe(1); // Zero transport dispatch for request 2!
      expect(budgetManager.getStats().totalRequests).toBe(1);
    });

    it("shares host pacing (>= 2,500 ms) with LP adapter on the same provider", async () => {
      const sig = "SharedPacingSig111111111111111111111111111111111111111111111";

      let currentEpoch = 10_000;
      const clock = () => currentEpoch;
      const payload = createSyntheticBuyPayload(
        sig,
        50_000_000n,
        25_000_000_000n,
        SYNTHETIC_POOL_ID,
        280_000_100,
        Math.floor(currentEpoch / 1000),
      );

      let sleepWaitRecorded = 0;
      const sleepFn = async (ms: number) => {
        sleepWaitRecorded += ms;
        currentEpoch += ms; // Advance fake clock
      };

      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 2500,
        clock,
      });

      // Simulate a prior LP request made on "SOLANA_RPC" at currentEpoch = 10_000
      budgetManager.recordRequestAttempt("SOLANA_RPC", "CANDIDATE_ENRICHMENT", 10_000);

      // Advance clock by 500 ms (elapsed = 500 ms < 2500 ms)
      currentEpoch = 10_500;

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
        providerName: "SOLANA_RPC",
        pacingMs: 2500,
        clock,
        sleepFn,
      });

      const res = await adapter.processNotification(sig, tracker);
      expect(res.ok).toBe(true);
      expect(res.outcome).toBe("SUCCESS");

      // Verify sleepFn was called for exactly the remaining 2,000 ms spacing
      expect(sleepWaitRecorded).toBe(2000);
      expect(currentEpoch).toBe(12_500); // 10_500 + 2_000
    });
  });

  describe("Timeout Protection & Stalled Body Reads", () => {
    it("aborts stalled response body read promptly and classifies as REQUEST_TIMEOUT (httpAttempts: 1)", async () => {
      const signature = "SigTimeout111111111111111111111111111111111111111111111111";

      let transportCalls = 0;
      const mockTransport: typeof fetch = async (_url, init) => {
        transportCalls++;
        // Return headers immediately, but body text stalls indefinitely until aborted
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: () =>
            new Promise<string>((_, reject) => {
              if (init?.signal) {
                init.signal.addEventListener("abort", () => {
                  const abortErr = new Error("AbortError: The operation was aborted");
                  abortErr.name = "AbortError";
                  reject(abortErr);
                });
              }
            }),
        } as unknown as Response;
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
        pacingMs: 0,
        timeoutMs: 50, // Short 50ms timeout
      });

      const res = await adapter.processNotification(signature, tracker);
      expect(res.ok).toBe(false);
      expect(res.outcome).toBe("REQUEST_TIMEOUT");
      expect(res.diagnostics.httpAttempts).toBe(1);
      expect(transportCalls).toBe(1);
      expect(budgetManager.getStats().totalRequests).toBe(1);
    });
  });

  describe("Bounded Backlog & Queue Overflow", () => {
    it("rejects notifications with QUEUE_OVERFLOW when pending queue ceiling is exceeded", () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const mockTransport: typeof fetch = async () => new Response("{}", { status: 200 });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        maxPendingQueueSize: 2, // Hard ceiling of 2 pending items
      });

      const enq1 = adapter.enqueueNotification(
        "SigQueue11111111111111111111111111111111111111111111111",
      );
      const enq2 = adapter.enqueueNotification(
        "SigQueue22222222222222222222222222222222222222222222222",
      );
      const enq3 = adapter.enqueueNotification(
        "SigQueue33333333333333333333333333333333333333333333333",
      );

      expect(enq1.ok).toBe(true);
      expect(enq1.queued).toBe(true);

      expect(enq2.ok).toBe(true);
      expect(enq2.queued).toBe(true);

      expect(enq3.ok).toBe(false);
      expect(enq3.queued).toBe(false);
      expect(enq3.reason).toBe("QUEUE_OVERFLOW");

      expect(adapter.getPendingQueueLength()).toBe(2);
      expect(adapter.getMetrics().totalQueueOverflows).toBe(1);
    });

    it("enforces maxDeduplicationKeys bound with FIFO eviction without unbounded memory growth", async () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const mockTransport: typeof fetch = async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
          status: 200,
        });
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
        pacingMs: 0,
        maxDeduplicationKeys: 3, // Bounded cache size of 3
      });

      const s1 = "SigEvict11111111111111111111111111111111111111111111111";
      const s2 = "SigEvict22222222222222222222222222222222222222222222222";
      const s3 = "SigEvict33333333333333333333333333333333333333333333333";
      const s4 = "SigEvict44444444444444444444444444444444444444444444444";

      await adapter.processNotification(s1, tracker);
      await adapter.processNotification(s2, tracker);
      await adapter.processNotification(s3, tracker);
      expect(adapter.getDeduplicationKeysCount()).toBe(3);

      // Ingest 4th: s1 should be evicted (FIFO), s4 added, count stays at 3
      await adapter.processNotification(s4, tracker);
      expect(adapter.getDeduplicationKeysCount()).toBe(3);
      expect(adapter.isDuplicate(s1)).toBe(false); // s1 was evicted
      expect(adapter.isDuplicate(s2)).toBe(true);
      expect(adapter.isDuplicate(s3)).toBe(true);
      expect(adapter.isDuplicate(s4)).toBe(true);
    });

    it("drains all pending items via processAllPending within effective deadline", async () => {
      const baseEpoch = 1_700_000_000_000;
      const clock = () => baseEpoch;

      const sig1 = "BatchSig1111111111111111111111111111111111111111111111111";
      const sig2 = "BatchSig2222222222222222222222222222222222222222222222222";

      const p1 = createSyntheticBuyPayload(sig1);
      const p2 = createSyntheticBuyPayload(sig2);

      const mockTransport: typeof fetch = async (_url, init) => {
        const bodyObj = JSON.parse(String(init?.body));
        const requestedSig = bodyObj.params[0];
        const payload = requestedSig === sig1 ? p1 : p2;
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
        pacingMs: 0,
        clock,
      });

      adapter.enqueueNotification(sig1);
      adapter.enqueueNotification(sig2);
      expect(adapter.getPendingQueueLength()).toBe(2);

      const batchResult = await adapter.processAllPending(tracker);
      expect(batchResult.totalProcessed).toBe(2);
      expect(batchResult.totalSucceeded).toBe(2);
      expect(batchResult.totalFailed).toBe(0);
      expect(batchResult.totalIngestedEvents).toBe(2);
      expect(adapter.getPendingQueueLength()).toBe(0);
      expect(tracker.getEventsCount()).toBe(2);
    });
  });

  describe("Fail-Closed Coverage Guarantee", () => {
    it("confirms that successful retrieval, queue draining, or notifications alone NEVER fabricate window coverage", async () => {
      const baseEpoch = 1_700_000_100_000;
      const clock = () => baseEpoch;

      const sig1 = "CoverageSig111111111111111111111111111111111111111111111";
      const sig2 = "CoverageSig222222222222222222222222222222222222222222222";

      // 2 trades within the window [baseEpoch - 60s, baseEpoch]
      const p1 = createSyntheticBuyPayload(
        sig1,
        50_000_000n,
        25_000_000_000n,
        SYNTHETIC_POOL_ID,
        280_000_100,
        Math.floor((baseEpoch - 30_000) / 1000),
      );
      const p2 = createSyntheticBuyPayload(
        sig2,
        10_000_000n,
        5_000_000_000n,
        SYNTHETIC_POOL_ID,
        280_000_105,
        Math.floor((baseEpoch - 10_000) / 1000),
      );

      const mockTransport: typeof fetch = async (_url, init) => {
        const bodyObj = JSON.parse(String(init?.body));
        const payload = bodyObj.params[0] === sig1 ? p1 : p2;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });

      // Start tracker 60 seconds earlier
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        trackingStartedMs: baseEpoch - 60_000,
        clock,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
      });

      // Enqueue and drain all pending notifications
      adapter.enqueueNotification(sig1);
      adapter.enqueueNotification(sig2);
      const batchResult = await adapter.processAllPending(tracker);

      expect(batchResult.totalSucceeded).toBe(2);
      expect(adapter.getPendingQueueLength()).toBe(0); // Queue is completely drained!
      expect(tracker.getEventsCount()).toBe(2); // Both trades ingested!

      // CRITICAL CHECK: Ingesting trades and draining queue must NOT advance stream checkpoints
      // or fabricate observation coverage.
      const windowEvaluation = tracker.evaluateWindow(baseEpoch);

      // Coverage must NOT be SUFFICIENT! Because no continuous observation checkpoints were recorded.
      expect(windowEvaluation.coverage).not.toBe("SUFFICIENT");
      // Indeed, the tracker correctly reports WARM_UP or COLLECTION_GAP due to lack of stream checkpoints
      expect(["WARM_UP", "COLLECTION_GAP", "STALE_DATA"]).toContain(windowEvaluation.coverage);
    });
  });

  describe("Identity Binding & Provenance Preservation", () => {
    it("preserves notification receiptTimestampMs and provenance on the resulting TradeEvent", async () => {
      const baseEpoch = 1_700_000_000_000;
      const clock = () => baseEpoch + 2_000;
      const customReceiptMs = baseEpoch + 2_000;

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

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
      });

      const notif: InjectedTransactionNotification = {
        signature,
        receivedAtMs: customReceiptMs,
        provenance: "HOST_OBSERVED",
      };

      let capturedEvent: unknown = null;
      const originalIngestTrade = tracker.ingestTrade.bind(tracker);
      tracker.ingestTrade = (event) => {
        capturedEvent = event;
        return originalIngestTrade(event);
      };

      const res = await adapter.processNotification(notif, tracker);
      expect(res.ok).toBe(true);

      // Verify receiptTimestampMs and provenance were preserved on the ingested event
      expect(capturedEvent).not.toBeNull();
      const trade = capturedEvent as {
        signature: string;
        receiptTimestampMs: number;
        timestampProvenance: string;
      };
      expect(trade.signature).toBe(signature);
      expect(trade.receiptTimestampMs).toBe(customReceiptMs);
      expect(trade.timestampProvenance).toBe("HOST_OBSERVED");
      expect(tracker.getEventsCount()).toBe(1);
    });
  });
});
