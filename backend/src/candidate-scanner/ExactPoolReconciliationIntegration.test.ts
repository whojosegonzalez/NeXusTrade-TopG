/**
 * Phase 12.94-D Milestone D.3.3: Exact-Pool Reconciliation Offline Integration Suite
 *
 * Verifies the complete offline candidate reconciliation stack working together:
 * - RaydiumCandidateSubscriptionCoordinator (WebSocket lifecycle, frame routing, uncertainty preservation)
 * - ExactPoolHistoryEnumerator (bounded backward traversal, frozen target, positive boundary evidence)
 * - ExactPoolTransactionResolutionBridge (chronological replay, candidate binding, fail-closed guards)
 * - RaydiumAmmV4TransactionSourceAdapter (bounded retrieval, deduplication, pacing, decode & ingest)
 * - RollingTradeFlowTracker (rolling 60s micro-flow accumulator, stream gaps, invariant preservation)
 * - GlobalResourceBudgetManager (shared provider pacing, global ceilings, reserved forward capacity)
 *
 * Scenarios Tested:
 * 1. Recover a missed transaction (Anchor A, Missed B, Delivered C; honest partial result without double counting)
 * 2. Preserve lifecycle isolation (disconnects and epoch advances prevent stale recovery dispatch/ingestion; prior work preserved)
 * 3. Verify combined resource accounting (shared budget, attempt counting, shared pacing, forward reservations, bounded denial)
 * 4. Preserve unavailable production coverage (collection gaps retained, cursors not advanced, production completeness unproven)
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  RaydiumCandidateSubscriptionCoordinator,
  type SourceCompletenessProof,
} from "./RaydiumCandidateSubscriptionCoordinator.js";
import {
  ExactPoolHistoryEnumerator,
  type HistorySignatureRecord,
  type HistoryPageQueryParams,
} from "./ExactPoolHistoryEnumerator.js";
import { ExactPoolTransactionResolutionBridge } from "./ExactPoolTransactionResolutionBridge.js";
import { RaydiumAmmV4TransactionSourceAdapter } from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import type { ISolanaWebSocketTransport } from "../research/pilot/SolanaWebSocketSubscriptionClient.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";

// Canonical Base58 Fixtures
const MOCK_RPC_URL = "https://mock-solana-rpc.internal";
const SYNTHETIC_WSOL_MINT = "So11111111111111111111111111111111111111112";
const SYNTHETIC_CANDIDATE_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const SYNTHETIC_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const SYNTHETIC_BASE_VAULT = "9UYjh9A2dE1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8F";
const SYNTHETIC_QUOTE_VAULT = "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v";
const SYNTHETIC_AMM_AUTHORITY = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const SYNTHETIC_USER_SOURCE_ATA = "UserSourceTokenAccount1111111111111111111111";
const SYNTHETIC_USER_DEST_ATA = "UserDestTokenAccount111111111111111111111111";
const SYNTHETIC_USER_WALLET = "UserWalletOwner1111111111111111111111111111";

// 64-byte Ed25519 Canonical Signatures
const SIG_ANCHOR =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUc";
const SIG_B =
  "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3vB";
const SIG_B2 =
  "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2";
const SIG_C =
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6C";

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

function createSyntheticBuyPayload(
  signature: string,
  amountInLamports = 50_000_000n,
  amountOutTokens = 25_000_000_000n,
  poolId = SYNTHETIC_POOL_ID,
  slot = 101,
  blockTime = 1_700_000_040,
) {
  const accounts = [
    SPL_TOKEN_PROGRAM_ID,
    poolId,
    SYNTHETIC_AMM_AUTHORITY,
    SYNTHETIC_BASE_VAULT,
    SYNTHETIC_QUOTE_VAULT,
    SYNTHETIC_USER_SOURCE_ATA,
    SYNTHETIC_USER_DEST_ATA,
    SYNTHETIC_USER_WALLET,
    RAYDIUM_AMM_V4_PROGRAM_ID,
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
          uiTokenAmount: {
            amount: (1_000_000_000n + amountInLamports).toString(),
            decimals: 9,
          },
        },
        {
          accountIndex: 3,
          mint: SYNTHETIC_CANDIDATE_MINT,
          uiTokenAmount: {
            amount: (500_000_000_000n - amountOutTokens).toString(),
            decimals: 5,
          },
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

class FakeWebSocketTransport implements ISolanaWebSocketTransport {
  public sentMessages: string[] = [];
  public closed = false;
  public closeCode?: number | undefined;
  public closeReason?: string | undefined;

  private readonly listeners: {
    open: (() => void)[];
    message: ((data: string | Buffer) => void)[];
    error: ((err: Error) => void)[];
    close: ((code: number, reason: string) => void)[];
  } = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  public send(data: string): void {
    this.sentMessages.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    for (const listener of [...this.listeners.close]) listener(code ?? 1000, reason ?? "");
  }

  public on(event: "open", listener: () => void): void;
  public on(event: "message", listener: (data: string | Buffer) => void): void;
  public on(event: "error", listener: (err: Error) => void): void;
  public on(event: "close", listener: (code: number, reason: string) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public on(event: string, listener: any): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.listeners as any)[event].push(listener);
  }

  public triggerOpen(): void {
    for (const listener of [...this.listeners.open]) listener();
  }

  public triggerMessage(data: string | Buffer): void {
    for (const listener of [...this.listeners.message]) listener(data);
  }

  public triggerError(err: Error): void {
    for (const listener of [...this.listeners.error]) listener(err);
  }

  public triggerClose(code = 1000, reason = ""): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    for (const listener of [...this.listeners.close]) listener(code, reason);
  }
}

function makeLogsNotificationFrame(signature: string, slot: number, subId = 42): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription: subId,
      result: {
        context: { slot },
        value: {
          signature,
          err: null,
          logs: [
            "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]",
            "Program log: initialize2: InitializeInstruction2",
            "Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 success",
          ],
        },
      },
    },
  });
}

describe("Exact-Pool Offline Reconciliation Integration", () => {
  let simulatedTime: number;
  let clock: () => number;
  let sleepFn: (ms: number) => Promise<void>;

  beforeEach(() => {
    // Set simulated clock to 50 seconds past 1,700,000,000s so transactions at
    // 1,700,000,010s and 1,700,000,020s fall within the rolling 60s window without future skew.
    simulatedTime = 1_700_000_050_000;
    clock = () => simulatedTime;
    sleepFn = async (ms: number) => {
      simulatedTime += ms;
    };
  });

  describe("Scenario 1: Recover a missed transaction", () => {
    it("recovers missed transaction B and preserves live notification C without double counting C", async () => {
      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 0,
        maxTotalRequests: 50,
      });

      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      let httpAttempts = 0;
      const httpPayloads: Record<string, unknown> = {
        [SIG_C]: createSyntheticBuyPayload(
          SIG_C,
          60_000_000n,
          30_000_000_000n,
          SYNTHETIC_POOL_ID,
          102,
          1700000048,
        ),
        [SIG_B]: createSyntheticBuyPayload(
          SIG_B,
          40_000_000n,
          20_000_000_000n,
          SYNTHETIC_POOL_ID,
          101,
          1700000045,
        ),
      };

      const fakeTransport: typeof fetch = async (_input, init) => {
        httpAttempts++;
        const bodyStr = typeof init?.body === "string" ? init.body : "{}";
        const parsed = JSON.parse(bodyStr);
        const sig = parsed.params?.[0];
        const payload = httpPayloads[sig];
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? 1, result: payload ?? null }),
          {
            status: 200,
          },
        );
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const fakeWs = new FakeWebSocketTransport();
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
        allowSyntheticCompletenessProofs: false,
      });

      // 1. Establish subscription for the candidate pool
      fakeWs.triggerOpen();
      // Coordinator sends logsSubscribe (id: 1)
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");
      expect(coordinator.getActiveSubscriptionId()).toBe(42);
      expect(coordinator.getConnectionEpoch()).toBe(1);

      // 2. Normally delivered notification C arrives via active WebSocket
      fakeWs.triggerMessage(makeLogsNotificationFrame(SIG_C, 102, 42));
      expect(coordinator.getMetrics().totalNotificationsReceived).toBe(1);
      expect(coordinator.getMetrics().totalNotificationsRouted).toBe(1);
      expect(adapter.getPendingQueueLength()).toBe(1);

      // Drain notification C through adapter into tracker
      const drainResult = await coordinator.processNextPending();
      expect(drainResult?.ok).toBe(true);
      expect(drainResult?.signature).toBe(SIG_C);
      expect(drainResult?.outcome).toBe("SUCCESS");
      expect(drainResult?.ingestedEventsCount).toBe(1);
      expect(tracker.getEventsCount()).toBe(1);
      expect(httpAttempts).toBe(1);

      // 3. Witnessed history enumeration: Anchor A, Missed B, Head C
      // Page query returns [C, B, A]
      const fakePageFetcher = async (
        params: HistoryPageQueryParams,
      ): Promise<readonly HistorySignatureRecord[]> => {
        expect(params.address).toBe(SYNTHETIC_POOL_ID);
        return [
          { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000048 },
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000045 },
          { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000040 },
        ];
      };

      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: STANDARD_POOL_CONTEXT,
        knownAnchorSignature: SIG_ANCHOR,
        pageFetcher: fakePageFetcher,
        budgetManager,
        clock,
        lifecycleTarget: coordinator,
        dispatchEpoch: coordinator.getConnectionEpoch(),
        sleepFn,
      });

      const enumResult = await enumerator.enumerate();
      expect(enumResult.outcome).toBe("ANCHOR_WITNESSED");
      expect(enumResult.anchorWitnessed).toBe(true);
      expect(enumResult.frozenTargetSignature).toBe(SIG_C);
      expect(enumResult.discoveredSignatures).toHaveLength(2);
      expect(enumResult.discoveredSignatures.map((s) => s.signature)).toEqual([SIG_C, SIG_B]);
      expect(enumResult.isProductionCompletenessEstablished).toBe(false);

      // 4. Resolve discovered enumeration through bridge into same tracker
      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: coordinator.getConnectionEpoch(),
        clock,
      });

      const resolutionResult = await bridge.resolve(enumResult);

      // The bridge resolves in chronological order: B (slot 101) first, then C (slot 102).
      // B was not seen previously -> successfully resolved and ingested!
      // C was already processed by adapter from the earlier WebSocket notification -> adapter returns DUPLICATE_NOTIFICATION!
      // The bridge retains DUPLICATE_UNRESOLVED and reports PARTIAL_RESOLUTION (honest partial result without manufacturing ALL_RESOLVED).
      expect(resolutionResult.outcome).toBe("PARTIAL_RESOLUTION");
      expect(resolutionResult.totalDiscoveredSignatures).toBe(2);
      expect(resolutionResult.totalProcessed).toBe(2);
      expect(resolutionResult.totalResolved).toBe(1); // B resolved
      expect(resolutionResult.totalFailed).toBe(1); // C unresolved duplicate
      expect(resolutionResult.totalDuplicatesUnresolved).toBe(1);
      expect(resolutionResult.totalDuplicatesResolved).toBe(0);
      expect(resolutionResult.totalIngestedSwaps).toBe(1); // Exactly 1 new swap ingested (B)

      // Signature-level verification
      const sigBResult = resolutionResult.perSignatureResults.find((r) => r.signature === SIG_B);
      expect(sigBResult?.status).toBe("RESOLVED");
      expect(sigBResult?.ingestedEventsCount).toBe(1);

      const sigCResult = resolutionResult.perSignatureResults.find((r) => r.signature === SIG_C);
      expect(sigCResult?.status).toBe("DUPLICATE_UNRESOLVED");
      expect(sigCResult?.ingestedEventsCount).toBe(0);

      // Tracker state verification:
      // Exactly 2 swaps exist in tracker: C (from WebSocket live delivery) and B (from resolution recovery).
      // C was NOT double counted!
      expect(tracker.getEventsCount()).toBe(2);

      // Total HTTP calls: 1 (live fetch for C) + 1 (recovery fetch for B) = 2. C was not re-fetched!
      expect(httpAttempts).toBe(2);

      // Completeness invariant strictly preserved
      expect(resolutionResult.isProductionCompletenessEstablished).toBe(false);
    });

    it("returns ALL_RESOLVED when all discovered signatures are previously unobserved", async () => {
      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 0,
      });

      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const fakeTransport: typeof fetch = async (_input, init) => {
        const bodyStr = typeof init?.body === "string" ? init.body : "{}";
        const parsed = JSON.parse(bodyStr);
        const sig = parsed.params?.[0];
        const payload = createSyntheticBuyPayload(
          sig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          101,
          1700000040,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const fakeWs = new FakeWebSocketTransport();
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => [
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000035 },
      ];

      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: STANDARD_POOL_CONTEXT,
        knownAnchorSignature: SIG_ANCHOR,
        pageFetcher: fakePageFetcher,
        budgetManager,
        clock,
        lifecycleTarget: coordinator,
        dispatchEpoch: 1,
        sleepFn,
      });

      const enumResult = await enumerator.enumerate();
      expect(enumResult.outcome).toBe("ANCHOR_WITNESSED");

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const res = await bridge.resolve(enumResult);
      expect(res.outcome).toBe("ALL_RESOLVED");
      expect(res.totalResolved).toBe(1);
      expect(res.totalFailed).toBe(0);
      expect(res.totalIngestedSwaps).toBe(1);
      expect(tracker.getEventsCount()).toBe(1);
    });
  });

  describe("Scenario 2: Preserve lifecycle isolation", () => {
    it("prevents stale recovery dispatch when coordinator disconnects before resolution", async () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      let httpCalls = 0;
      const fakeTransport: typeof fetch = async () => {
        httpCalls++;
        return new Response("{}", { status: 200 });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const fakeWs = new FakeWebSocketTransport();
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      expect(coordinator.getStatus()).toBe("SUBSCRIBED");

      // Enumeration performed while active in epoch 1
      const enumResult = {
        outcome: "ANCHOR_WITNESSED" as const,
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B,
        discoveredSignatures: [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false as const,
      };

      // Disconnect occurs before bridge resolution
      fakeWs.triggerClose(1006, "Connection lost unexpectedly");
      expect(coordinator.getStatus()).toBe("DISCONNECTED");

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const res = await bridge.resolve(enumResult);
      expect(res.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(res.totalProcessed).toBe(0);
      expect(res.totalIngestedSwaps).toBe(0);
      expect(httpCalls).toBe(0); // Zero outbound HTTP calls!
      expect(tracker.getEventsCount()).toBe(0);
    });

    it("prevents stale recovery dispatch when coordinator connection epoch advances", async () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      let httpCalls = 0;
      const fakeTransport: typeof fetch = async () => {
        httpCalls++;
        return new Response("{}", { status: 200 });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const fakeWs1 = new FakeWebSocketTransport();
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs1,
        clock,
      });

      fakeWs1.triggerOpen();
      fakeWs1.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
      expect(coordinator.getConnectionEpoch()).toBe(1);

      // Reconnect with new transport advances epoch to 2
      const fakeWs2 = new FakeWebSocketTransport();
      coordinator.attachTransport(fakeWs2);
      fakeWs2.triggerOpen();
      fakeWs2.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 2 }));
      expect(coordinator.getConnectionEpoch()).toBe(2);

      // Attempting to resolve epoch 1 enumeration with bridge expecting epoch 1
      const bridgeEpoch1 = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const enumResultEpoch1 = {
        outcome: "ANCHOR_WITNESSED" as const,
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B,
        discoveredSignatures: [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false as const,
      };

      const res1 = await bridgeEpoch1.resolve(enumResultEpoch1);
      expect(res1.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(httpCalls).toBe(0);

      // Attempting to pass epoch 1 enumeration to bridge expecting epoch 2
      const bridgeEpoch2 = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 2,
        clock,
      });

      const res2 = await bridgeEpoch2.resolve(enumResultEpoch1);
      expect(res2.outcome).toBe("PROVENANCE_MISMATCH");
      expect(httpCalls).toBe(0);
    });

    it("strictly preserves work completed before mid-resolution invalidation", async () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      let httpCalls = 0;
      const fakeWs = new FakeWebSocketTransport();

      const fakeTransport: typeof fetch = async (_input, init) => {
        httpCalls++;
        const bodyStr = typeof init?.body === "string" ? init.body : "{}";
        const parsed = JSON.parse(bodyStr);
        const sig = parsed.params?.[0];

        if (sig === SIG_B) {
          // First signature succeeds and ingests
          const payload = createSyntheticBuyPayload(
            SIG_B,
            50_000_000n,
            25_000_000_000n,
            SYNTHETIC_POOL_ID,
            101,
            1700000040,
          );
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
            status: 200,
          });
        }

        // Before or during second signature, coordinator drops
        fakeWs.triggerClose(1006, "Dropped mid-batch");
        const payload = createSyntheticBuyPayload(
          SIG_B2,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          102,
          1700000045,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      const enumResult = {
        outcome: "ANCHOR_WITNESSED" as const,
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B2,
        discoveredSignatures: [
          { signature: SIG_B2, slot: 102, err: null, memo: null, blockTime: 1700000045 },
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000040 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false as const,
      };

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const res = await bridge.resolve(enumResult);
      expect(res.outcome).toBe("LIFECYCLE_CANCELLED");

      // Invariant: Work completed before invalidation is strictly preserved!
      expect(res.totalResolved).toBe(1);
      expect(res.totalIngestedSwaps).toBe(1);
      expect(tracker.getEventsCount()).toBe(1);
      const bResult = res.perSignatureResults.find((r) => r.signature === SIG_B);
      expect(bResult?.status).toBe("RESOLVED");
      expect(bResult?.ingestedEventsCount).toBe(1);
      expect(httpCalls).toBe(2);
    });

    it("prevents swap ingestion when validateState throws during in-flight fetch", async () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const fakeWs = new FakeWebSocketTransport();
      const fakeTransport: typeof fetch = async () => {
        // Disconnect transport while fetch is awaiting response
        fakeWs.triggerClose(1006, "Severed mid-flight");
        const payload = createSyntheticBuyPayload(SIG_B);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      const enumResult = {
        outcome: "ANCHOR_WITNESSED" as const,
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B,
        discoveredSignatures: [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false as const,
      };

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const res = await bridge.resolve(enumResult);
      expect(res.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(res.totalIngestedSwaps).toBe(0);
      expect(tracker.getEventsCount()).toBe(0); // Ingestion strictly aborted!
    });
  });

  describe("Scenario 3: Verify combined resource accounting", () => {
    it("shares budget accounting across history enumeration and transaction retrieval with 1-to-1 attempt counts", async () => {
      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 0,
        maxTotalRequests: 20,
        maxEnrichmentAttempts: 10,
        minReservedForwardRequests: 4,
      });

      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const fakeTransport: typeof fetch = async (_input, init) => {
        const bodyStr = typeof init?.body === "string" ? init.body : "{}";
        const parsed = JSON.parse(bodyStr);
        const sig = parsed.params?.[0];
        const payload = createSyntheticBuyPayload(
          sig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          101,
          1700000040,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const fakeWs = new FakeWebSocketTransport();
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      expect(budgetManager.getTotalRequests()).toBe(0);

      // Step 1: Enumerator issues 1 page fetch
      const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => [
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000035 },
      ];

      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: STANDARD_POOL_CONTEXT,
        knownAnchorSignature: SIG_ANCHOR,
        pageFetcher: fakePageFetcher,
        budgetManager,
        clock,
        lifecycleTarget: coordinator,
        dispatchEpoch: 1,
        sleepFn,
      });

      const enumRes = await enumerator.enumerate();
      expect(enumRes.outcome).toBe("ANCHOR_WITNESSED");
      expect(enumRes.requestCount).toBe(1);

      // Usage after enumeration: 1 request recorded under CANDIDATE_ENRICHMENT
      const statsAfterEnum = budgetManager.getStats();
      expect(statsAfterEnum.totalRequests).toBe(1);
      expect(statsAfterEnum.enrichmentRequests).toBe(1);

      // Step 2: Bridge issues 1 transaction retrieval via adapter
      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const res = await bridge.resolve(enumRes);
      expect(res.outcome).toBe("ALL_RESOLVED");
      expect(res.totalProcessed).toBe(1);

      // Usage after resolution: exactly 2 requests recorded under CANDIDATE_ENRICHMENT
      const statsAfterResolution = budgetManager.getStats();
      expect(statsAfterResolution.totalRequests).toBe(2);
      expect(statsAfterResolution.enrichmentRequests).toBe(2);
      expect(budgetManager.getTotalRequests()).toBe(2);
    });

    it("enforces shared provider pacing (>=2500ms) between enumeration and transaction retrieval", async () => {
      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 2500,
        maxTotalRequests: 20,
      });

      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const transportCalledAt: number[] = [];
      const fakeTransport: typeof fetch = async () => {
        transportCalledAt.push(clock());
        const payload = createSyntheticBuyPayload(SIG_B);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        clock,
        sleepFn,
      });

      const fakeWs = new FakeWebSocketTransport();
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Enumerator runs at t = 1,700,000,000,000
      let enumPageFetchedAt = 0;
      const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => {
        enumPageFetchedAt = clock();
        return [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000040 },
          { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000035 },
        ];
      };

      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: STANDARD_POOL_CONTEXT,
        knownAnchorSignature: SIG_ANCHOR,
        pageFetcher: fakePageFetcher,
        budgetManager,
        clock,
        lifecycleTarget: coordinator,
        dispatchEpoch: 1,
        sleepFn,
      });

      const enumRes = await enumerator.enumerate();
      expect(enumRes.outcome).toBe("ANCHOR_WITNESSED");
      expect(enumPageFetchedAt).toBe(1_700_000_050_000);

      // Now bridge attempts transaction retrieval immediately after.
      // Shared pacing enforces >= 2500ms spacing between SOLANA_RPC requests.
      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const resolutionRes = await bridge.resolve(enumRes);
      expect(resolutionRes.outcome).toBe("ALL_RESOLVED");

      // Verify adapter waited the required 2500ms before dispatching
      expect(transportCalledAt).toHaveLength(1);
      expect(transportCalledAt[0]! - enumPageFetchedAt).toBeGreaterThanOrEqual(2500);
    });

    it("strictly preserves forward reservations when candidate enrichment budget is exhausted", async () => {
      // 5 total requests, with 4 reserved for forward observation -> only 1 available for enrichment!
      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 0,
        maxTotalRequests: 5,
        minReservedForwardRequests: 4,
      });

      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      let httpCalls = 0;
      const fakeTransport: typeof fetch = async () => {
        httpCalls++;
        return new Response("{}", { status: 200 });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const fakeWs = new FakeWebSocketTransport();
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Enumerator uses 1 request (the only allowed enrichment request)
      const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => [
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000035 },
      ];

      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: STANDARD_POOL_CONTEXT,
        knownAnchorSignature: SIG_ANCHOR,
        pageFetcher: fakePageFetcher,
        budgetManager,
        clock,
        lifecycleTarget: coordinator,
        dispatchEpoch: 1,
        sleepFn,
      });

      const enumRes = await enumerator.enumerate();
      expect(enumRes.outcome).toBe("ANCHOR_WITNESSED");
      expect(budgetManager.getTotalRequests()).toBe(1);

      // Now candidate enrichment has 0 remaining quota (1 used + 4 reserved = 5).
      // Bridge must be denied to protect reserved forward capacity!
      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const res = await bridge.resolve(enumRes);
      expect(res.outcome).toBe("BUDGET_EXHAUSTED");
      expect(res.totalProcessed).toBe(1);
      expect(res.totalResolved).toBe(0);
      expect(res.totalFailed).toBe(1);
      expect(res.perSignatureResults[0]?.status).toBe("BUDGET_DENIED");
      expect(httpCalls).toBe(0); // Zero unauthorized HTTP dispatches!

      // Forward reservation is intact
      expect(
        budgetManager.canMakeRequest("SOLANA_RPC", clock(), "FORWARD_OBSERVATION").allowed,
      ).toBe(true);
      expect(
        budgetManager.canMakeRequest("SOLANA_RPC", clock(), "CANDIDATE_ENRICHMENT").allowed,
      ).toBe(false);
    });

    it("terminates fail-closed with zero outbound dispatches on exhausted budget", async () => {
      const budgetManager = new GlobalResourceBudgetManager({
        minProviderSpacingMs: 0,
        maxTotalRequests: 0, // Zero total quota
      });

      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      let httpCalls = 0;
      const fakeTransport: typeof fetch = async () => {
        httpCalls++;
        return new Response("{}", { status: 200 });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const fakeWs = new FakeWebSocketTransport();
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      let fetchPageCalls = 0;
      const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => {
        fetchPageCalls++;
        return [];
      };

      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: STANDARD_POOL_CONTEXT,
        knownAnchorSignature: SIG_ANCHOR,
        pageFetcher: fakePageFetcher,
        budgetManager,
        clock,
        lifecycleTarget: coordinator,
        dispatchEpoch: 1,
        sleepFn,
      });

      const enumRes = await enumerator.enumerate();
      expect(enumRes.outcome).toBe("BUDGET_EXHAUSTED");
      expect(fetchPageCalls).toBe(0);

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const dummyEnumResult = {
        outcome: "ANCHOR_WITNESSED" as const,
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B,
        discoveredSignatures: [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false as const,
      };

      const bridgeRes = await bridge.resolve(dummyEnumResult);
      expect(bridgeRes.outcome).toBe("BUDGET_EXHAUSTED");
      expect(httpCalls).toBe(0);
    });
  });

  describe("Scenario 4: Preserve unavailable production coverage", () => {
    it("preserves collection gaps, retains null flow counts, and does not establish production completeness", async () => {
      const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
      const tracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const fakeTransport: typeof fetch = async (_input, init) => {
        const bodyStr = typeof init?.body === "string" ? init.body : "{}";
        const parsed = JSON.parse(bodyStr);
        const sig = parsed.params?.[0];
        const payload = createSyntheticBuyPayload(sig);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: fakeTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const fakeWs = new FakeWebSocketTransport();
      // Coordinator created with default allowSyntheticCompletenessProofs: false
      const coordinator = new RaydiumCandidateSubscriptionCoordinator({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        transport: fakeWs,
        clock,
        allowSyntheticCompletenessProofs: false, // Default production configuration
      });

      fakeWs.triggerOpen();
      fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));

      // Record a disconnect collection gap in the tracker (e.g. from an earlier connection drop)
      tracker.recordCollectionGap({
        gapStartMs: clock() - 10_000,
        gapEndMs: clock() - 5_000,
        reason: "SUBSCRIPTION_DISCONNECT",
      });
      expect(tracker.getRecordedGaps()).toHaveLength(1);

      // Perform enumeration and transaction recovery
      const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => [
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000035 },
      ];

      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: STANDARD_POOL_CONTEXT,
        knownAnchorSignature: SIG_ANCHOR,
        pageFetcher: fakePageFetcher,
        budgetManager,
        clock,
        lifecycleTarget: coordinator,
        dispatchEpoch: 1,
        sleepFn,
      });

      const enumRes = await enumerator.enumerate();
      expect(enumRes.outcome).toBe("ANCHOR_WITNESSED");
      // Enumerator result contract invariant
      expect(enumRes.isProductionCompletenessEstablished).toBe(false);

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: coordinator,
        expectedEpoch: 1,
        clock,
      });

      const bridgeRes = await bridge.resolve(enumRes);
      expect(bridgeRes.outcome).toBe("ALL_RESOLVED");
      expect(bridgeRes.totalIngestedSwaps).toBe(1);
      // Bridge result contract invariant
      expect(bridgeRes.isProductionCompletenessEstablished).toBe(false);

      // Invariant 1: Stream gap is NOT erased by recovery
      expect(tracker.getRecordedGaps()).toHaveLength(1);
      expect(tracker.getRecordedGaps()[0]?.reason).toBe("SUBSCRIPTION_DISCONNECT");

      // Invariant 2: Coordinator coverage diagnostic reports production completeness unproven
      const diag = coordinator.getCoverageDiagnostic();
      expect(diag.isProductionCompletenessEstablished).toBe(false);
      expect(diag.isCoverageSufficient).toBe(false);
      expect(diag.recentBuys60s).toBeNull();
      expect(diag.recentSells60s).toBeNull();
      expect(diag.flowRatio).toBeNull();
      expect(diag.limitationReason).toContain("Production source completeness is unproven");

      // Invariant 3: evaluateFlow() retains unavailable (null) counts
      const evalFlow = coordinator.evaluateFlow();
      expect(evalFlow.isCoverageSufficient).toBe(false);
      expect(evalFlow.recentBuys60s).toBeNull();
      expect(evalFlow.recentSells60s).toBeNull();
      expect(evalFlow.flowRatio).toBeNull();

      // Invariant 4: createRetestSpotInfo() retains unavailable (null) counts
      const spotInfo = coordinator.createRetestSpotInfo({
        spotPriceSol: 0.001,
        spotPriceUsd: 0.15,
        liquidityUsd: 65_000,
      });
      expect(spotInfo.flowCoverage).not.toBe("SUFFICIENT");
      expect(spotInfo.recentBuys60s).toBeNull();
      expect(spotInfo.recentSells60s).toBeNull();

      // Invariant 5: Synthetic completeness proofs are strictly rejected under default configuration
      const syntheticProof: SourceCompletenessProof = {
        mode: "SYNTHETIC_TEST_FIXTURE",
        poolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        rangeStartMs: clock() - 60_000,
        rangeEndMs: clock(),
      };
      const advanceResult = coordinator.advanceCoverage({
        checkpointMs: clock(),
        proof: syntheticProof,
      });
      expect(advanceResult.ok).toBe(false);
      expect(advanceResult.reason).toBe("SYNTHETIC_PROOFS_DISALLOWED");
    });
  });
});
