/**
 * Phase 12.94-D Milestone D.3.3: Exact-Pool Window Reconciliation Integration Suite
 *
 * Verifies end-to-end exact-pool window reconciliation connecting:
 * - RaydiumCandidateSubscriptionCoordinator (lifecycle, epoch isolation, disconnect gap permanence)
 * - ExactPoolHistoryEnumerator (asynchronous backward traversal, anchor witnessing, request accounting)
 * - ExactPoolTransactionResolutionBridge (asynchronous chronological resolution into tracker)
 * - ExactPoolWindowReconciliationEvaluator (4-dimensional temporal contract, evidence consistency)
 * - CandidateFlowProvider (decision boundary snapshot validation, fail-closed production defaults)
 *
 * Scenarios Tested:
 * 1. Complete Activity: Stream observation + witnessed anchor + backfilled burst -> RECONCILED in diagnostic, production counts unavailable.
 * 2. Quiet Window: Stream observation + older boundary anchor outside window -> RECONCILED (0 BUY / 0 SELL), dispatches accurately count older boundary resolution.
 * 3. Warm-Up Rejection: Observation started < 60s before cutoff -> WARM_UP, counts remain null.
 * 4. Processing Backlog: Active adapter pending queue at evaluation -> PROCESSING_BACKLOG, counts remain null.
 * 5. Disconnects & Gap Permanence: Disconnect gap recorded mid-window -> STREAM_GAP, backfill does not erase recorded gap.
 * 6. Unresolved Transactions: In-window transaction fails decode/resolution -> UNRESOLVED_TRANSACTIONS, counts null.
 * 7. Stale Evidence: Decision time - cutoff time > 15s -> STALE_DATA, counts null.
 * 8. Budget Exhaustion: Shared budget manager quota exhausted -> BUDGET_EXHAUSTED, counts null.
 * 9. Epoch Change During Awaits: Epoch advance during history/resolution await -> fails closed (STREAM_GAP / LIFECYCLE_CANCELLED).
 * 10. Causality Violation: Evidence retrieved after decision timestamp -> FUTURE_DATED_EVIDENCE, counts null.
 * 11. Capped Collection Incomplete: Bridge transaction limit leaves in-window transactions unresolved -> UNRESOLVED_TRANSACTIONS (sampling never yields RECONCILED).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { RaydiumCandidateSubscriptionCoordinator } from "./RaydiumCandidateSubscriptionCoordinator.js";
import {
  ExactPoolHistoryEnumerator,
  type HistorySignatureRecord,
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
import {
  type SourceCutoffEvidence,
  toCandidateFlowResult,
} from "./ExactPoolWindowReconciliationEvaluator.js";
import { CoordinatorCandidateFlowProvider } from "./CandidateFlowProvider.js";

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
  buf[0] = 16;
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
  blockTime = 1_700_000_045,
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

function createValidCutoff(
  slot = 280_000_200,
  blockTimeSec = 1_700_000_065,
  retrievedAtMs = 1_700_000_065_040,
): SourceCutoffEvidence {
  return {
    sourceMethod: "getBlockTime",
    responseField: "result",
    commitment: "confirmed",
    provenance: "ON_CHAIN_BLOCK_TIME",
    slot,
    cutoffTimestampMs: blockTimeSec * 1000,
    retrievedAtMs,
    responsePayload: {
      jsonrpc: "2.0",
      id: 1,
      result: blockTimeSec,
    },
    requestContext: {
      slot,
    },
  };
}

const defaultFakeTransport: typeof fetch = async () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), { status: 200 });

describe("Phase 12.94-D Milestone D.3.3: Exact-Pool Window Reconciliation Integration", () => {
  let simulatedTime: number;
  let clock: () => number;
  let sleepFn: (ms: number) => Promise<void>;

  const recordObservation = (
    targetTracker: RollingTradeFlowTracker,
    timestampMs: number,
    slot?: number,
  ): void => {
    simulatedTime = timestampMs;
    targetTracker.recordHeartbeat(timestampMs, slot);
  };

  const recordObservationRange = (
    targetTracker: RollingTradeFlowTracker,
    fromMs: number,
    toMs: number,
    stepMs = 10_000,
  ): void => {
    for (let t = fromMs; t <= toMs; t += stepMs) {
      simulatedTime = t;
      targetTracker.recordHeartbeat(t);
    }
    if (simulatedTime < toMs) {
      simulatedTime = toMs;
      targetTracker.recordHeartbeat(toMs);
    }
  };

  beforeEach(() => {
    // Baseline simulated clock at T = 1,700,000,000,000 ms
    simulatedTime = 1_700_000_000_000;
    clock = () => simulatedTime;
    sleepFn = async (ms: number) => {
      simulatedTime += ms;
    };
  });

  it("1. Complete Activity: reconciles witnessed burst in research diagnostic while production flow remains unavailable", async () => {
    const budgetManager = new GlobalResourceBudgetManager({
      minProviderSpacingMs: 0,
      maxTotalRequests: 50,
    });

    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000, // T = 0s
      clock,
    });

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
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr);
      const sig = parsed.params?.[0];
      const payload = httpPayloads[sig];
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? 1, result: payload ?? null }),
        { status: 200 },
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

    // Establish subscription
    fakeWs.triggerOpen();
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
    expect(coordinator.getStatus()).toBe("SUBSCRIBED");

    // Continuous observation heartbeats
    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    // At T = 65s, cutoff evidence retrieved for confirmed slot 105 (blockTime 1700000065)
    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => [
      { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000048 },
      { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000045 },
      { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 }, // T = 4s (before window start 5s)
    ];

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: fakePageFetcher,
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
      sleepFn,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    // Reconcile candidate window using default decision timestamp (evaluated post-acquisition)
    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
    });

    // Research result is RECONCILED with 2 BUYS
    expect(reconResult.status).toBe("RECONCILED");
    expect(reconResult.flowCoverage).toBe("SUFFICIENT");
    expect(reconResult.flowCounts.recentBuys60s).toBe(2);
    expect(reconResult.flowCounts.recentSells60s).toBe(0);
    expect(reconResult.flowCounts.flowRatio).toBe(2);
    expect(reconResult.isCoverageSufficient).toBe(true);

    // Research diagnostic exposes reconciled result
    const diag = coordinator.getCoverageDiagnostic();
    expect(diag.lastReconciliationResult?.status).toBe("RECONCILED");

    // CRITICAL: Production candidate flow remains strictly UNAVAILABLE (null)
    const spotInfo = coordinator.createRetestSpotInfo({ spotPriceSol: 1 }, 1_700_000_066_000);
    expect(spotInfo.recentBuys60s).toBeNull();
    expect(spotInfo.recentSells60s).toBeNull();
    expect(spotInfo.flowCoverage).toBe("COLLECTION_GAP");

    const flowProvider = new CoordinatorCandidateFlowProvider(coordinator);
    const candidateFlow = flowProvider.getCandidateFlow(
      { poolAddress: SYNTHETIC_POOL_ID, tokenMint: SYNTHETIC_CANDIDATE_MINT },
      1_700_000_066_000,
    );
    expect(candidateFlow.recentBuys60s).toBeNull();
    expect(candidateFlow.recentSells60s).toBeNull();
    expect(candidateFlow.isCoverageSufficient).toBe(false);
    expect(candidateFlow.flowCoverage).toBe("COLLECTION_GAP");

    const mappedFlow = toCandidateFlowResult(reconResult);
    expect(mappedFlow.recentBuys60s).toBeNull();
    expect(mappedFlow.isCoverageSufficient).toBe(false);
  });

  it("2. Quiet Window: counts evidenced dispatches for older boundary transaction outside evaluated window", async () => {
    const budgetManager = new GlobalResourceBudgetManager({
      minProviderSpacingMs: 0,
      maxTotalRequests: 50,
    });

    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000, // T = 0s
      clock,
    });

    const SIG_OLDER =
      "2v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3vA";
    const httpPayloads: Record<string, unknown> = {
      [SIG_OLDER]: createSyntheticBuyPayload(
        SIG_OLDER,
        10_000_000n,
        5_000_000_000n,
        SYNTHETIC_POOL_ID,
        100,
        1700000004,
      ),
    };

    const fakeTransport: typeof fetch = async (_input, init) => {
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr);
      const sig = parsed.params?.[0];
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: httpPayloads[sig] ?? null }),
        { status: 200 },
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
    });

    fakeWs.triggerOpen();
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    // Continuous observation heartbeats in quiet window
    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040); // Window: [5s, 65s]

    // Enumeration returns 1 older boundary transaction at T = 4s (outside window [5s, 65s]) and prior anchor at T = 0s
    const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => [
      { signature: SIG_OLDER, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      { signature: SIG_ANCHOR, slot: 99, err: null, memo: null, blockTime: 1700000000 },
    ];

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: fakePageFetcher,
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
      sleepFn,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    simulatedTime = 1_700_000_066_000;
    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    expect(reconResult.status).toBe("RECONCILED");
    expect(reconResult.flowCounts.recentBuys60s).toBe(0);
    expect(reconResult.flowCounts.recentSells60s).toBe(0);
    expect(reconResult.flowCounts.flowRatio).toBe(1.0);
    // 1 history request + 1 boundary resolution request = 2 dispatches
    expect(reconResult.resourceMetrics.actualRequestsDispatched).toBe(2);
  });

  it("3. Warm-Up Rejection: fails closed with WARM_UP when observation started < 60s before cutoff", async () => {
    const budgetManager = new GlobalResourceBudgetManager();
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_020_000, // T = 20s (window starts at T = 5s)
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_030_000, 1_700_000_065_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040); // Window: [5s, 65s]

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: async () => [
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ],
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    expect(reconResult.status).toBe("WARM_UP");
    expect(reconResult.flowCoverage).toBe("WARM_UP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("4. Processing Backlog: fails closed with PROCESSING_BACKLOG when adapter has pending workload", async () => {
    const budgetManager = new GlobalResourceBudgetManager();
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    // Backlog item queued in adapter
    fakeWs.triggerMessage(makeLogsNotificationFrame(SIG_C, 102, 42));
    expect(adapter.getPendingQueueLength()).toBe(1);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: async () => [
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ],
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    expect(reconResult.status).toBe("PROCESSING_BACKLOG");
    expect(reconResult.flowCoverage).toBe("PROCESSING_BACKLOG");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("5. Disconnects & Gap Permanence: preserves recorded stream gap in tracker, failing closed despite backfill", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservation(tracker, 1_700_000_010_000);
    recordObservation(tracker, 1_700_000_020_000);

    // Socket disconnect mid-window at T = 30s
    simulatedTime = 1_700_000_030_000;
    fakeWs.triggerClose(1006, "Abnormal closure");
    expect(tracker.getGapsCount()).toBe(1);

    // Reconnect at T = 35s
    simulatedTime = 1_700_000_035_000;
    fakeWs.triggerOpen();
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 43 }));
    expect(coordinator.getStatus()).toBe("SUBSCRIBED");

    recordObservation(tracker, 1_700_000_045_000);
    recordObservation(tracker, 1_700_000_055_000);
    recordObservation(tracker, 1_700_000_065_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: async () => [
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ],
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    // Gap at T = 30s overlaps window [5s, 65s] -> fails closed with STREAM_GAP
    expect(reconResult.status).toBe("STREAM_GAP");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(tracker.getGapsCount()).toBe(1); // Gap was NOT erased!
  });

  it("6. Unresolved Transactions: fails closed with STREAM_GAP (collection loss) when in-window transaction decode fails", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    // Adapter returns on-chain transaction error
    const fakeTransport: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 101,
            blockTime: 1700000045,
            meta: { err: { InstructionError: [0, "Custom"] } },
            transaction: { signatures: [SIG_B], message: { accountKeys: [], instructions: [] } },
          },
        }),
        { status: 200 },
      );

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: fakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: async () => [
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000045 },
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ],
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    expect(reconResult.status).toBe("STREAM_GAP");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("7. Stale Evidence: fails closed with STALE_DATA when decision timestamp exceeds 15s limit from cutoff", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    // Cutoff at T = 65s
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: async () => [
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ],
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    // Decision at T = 81s (81s - 65s = 16s > 15s limit!)
    recordObservation(tracker, 1_700_000_075_000);
    recordObservation(tracker, 1_700_000_081_000);
    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_081_000,
    });

    expect(reconResult.status).toBe("STALE_DATA");
    expect(reconResult.flowCoverage).toBe("STALE_DATA");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("8. Budget Exhaustion: terminates fail-closed with BUDGET_EXHAUSTED when budget manager quota is exceeded", async () => {
    // Budget allowing only 0 enrichment requests
    const budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 1,
      minReservedForwardRequests: 1,
    });

    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: async () => [
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ],
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    expect(reconResult.status).toBe("BUDGET_EXHAUSTED");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("9. Epoch Changes During Awaits: rejects results invalidated by transport disconnect and epoch advance", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));
    expect(coordinator.getConnectionEpoch()).toBe(1);

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_050_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    // Enumerator triggers replacement transport and epoch advance DURING await!
    const pageFetcherWithLifecycleDrop = async (): Promise<readonly HistorySignatureRecord[]> => {
      const newWs = new FakeWebSocketTransport();
      coordinator.attachTransport(newWs);
      newWs.triggerOpen();
      newWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 2, result: 99 }));
      expect(coordinator.getConnectionEpoch()).toBe(2);
      return [{ signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 }];
    };

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: pageFetcherWithLifecycleDrop,
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    // Invalidation during await fails closed with STREAM_GAP
    expect(reconResult.status).toBe("STREAM_GAP");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("10. Causality Violation: fails closed with FUTURE_DATED_EVIDENCE when evidence is retrieved after decision time", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_050_000);

    // Cutoff retrieved at T = 65_040ms
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: async () => [
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ],
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    // Decision timestamp set to T = 50_000ms (earlier than evidence retrieval!)
    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_050_000,
    });

    expect(reconResult.status).toBe("FUTURE_DATED_EVIDENCE");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("11. Capped Collection Incomplete: bridge transaction limit leaves in-window transactions unresolved, sampling never yields RECONCILED", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

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
      const bodyStr = typeof init?.body === "string" ? init.body : "{}";
      const parsed = JSON.parse(bodyStr);
      const sig = parsed.params?.[0];
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: httpPayloads[sig] ?? null }),
        { status: 200 },
      );
    };

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: fakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    // Two in-window transactions: SIG_C and SIG_B
    const fakePageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => [
      { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000048 },
      { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000045 },
      { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
    ];

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: fakePageFetcher,
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    // Bridge capped to maxTransactionsToProcess: 1 (cannot resolve all 2 in-window transactions!)
    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      maxTransactionsToProcess: 1,
      clock,
    });

    simulatedTime = 1_700_000_066_000;
    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    // Incomplete coverage strictly fails closed with UNRESOLVED_TRANSACTIONS
    expect(reconResult.status).toBe("UNRESOLVED_TRANSACTIONS");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("12. Overlapping Queue Overflow Gap: fails closed with STREAM_GAP despite successful history and resolution evidence", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    // Record an overlapping queue overflow loss gap in the tracker
    tracker.recordCollectionGap({
      gapStartMs: 1_700_000_030_000,
      gapEndMs: 1_700_000_035_000,
      reason: "SOURCE_ADAPTER_LOSS:QUEUE_OVERFLOW",
    });

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: async () => [
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ],
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    simulatedTime = 1_700_000_066_000;
    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
    });

    // Invalidation due to overlapping collection gap strictly fails closed with STREAM_GAP
    expect(reconResult.status).toBe("STREAM_GAP");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
    expect(reconResult.flowCounts.recentSells60s).toBeNull();
  });

  it("13. Delayed History Acquisition Causality: fails closed with FUTURE_DATED_EVIDENCE when history completes after explicit decision timestamp", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: defaultFakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    // Page fetcher introduces delay past the explicit decision time
    const delayedPageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => {
      simulatedTime = 1_700_000_070_000; // Advancing time to 70s
      return [{ signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 }];
    };

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: delayedPageFetcher,
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    // Explicit decision timestamp set before history completion
    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000, // 66s < 70s
    });

    expect(reconResult.status).toBe("FUTURE_DATED_EVIDENCE");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });

  it("14. Delayed Resolution Acquisition Causality: fails closed with FUTURE_DATED_EVIDENCE when resolution completes after explicit decision timestamp", async () => {
    const budgetManager = new GlobalResourceBudgetManager({ minProviderSpacingMs: 0 });
    const tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      trackingStartedMs: 1_700_000_000_000,
      clock,
    });

    const fakeTransport: typeof fetch = async () => {
      simulatedTime = 1_700_000_072_000; // Advancing time during resolution to 72s
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: createSyntheticBuyPayload(
            SIG_B,
            50_000_000n,
            25_000_000_000n,
            SYNTHETIC_POOL_ID,
            101,
            1700000045,
          ),
        }),
        { status: 200 },
      );
    };

    const adapter = new RaydiumAmmV4TransactionSourceAdapter({
      poolContext: STANDARD_POOL_CONTEXT,
      rpcUrl: MOCK_RPC_URL,
      budgetManager,
      transport: fakeTransport,
      clock,
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
    fakeWs.triggerMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 42 }));

    recordObservationRange(tracker, 1_700_000_010_000, 1_700_000_065_000);

    simulatedTime = 1_700_000_065_000;
    const sourceCutoff = createValidCutoff(105, 1700000065, 1_700_000_065_040);

    // History finishes on time at 65.5s with an in-window transaction (SIG_B) to resolve
    const timelyPageFetcher = async (): Promise<readonly HistorySignatureRecord[]> => {
      simulatedTime = 1_700_000_065_500;
      return [
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000045 },
        { signature: SIG_ANCHOR, slot: 100, err: null, memo: null, blockTime: 1700000004 },
      ];
    };

    const historyEnumerator = new ExactPoolHistoryEnumerator({
      poolContext: STANDARD_POOL_CONTEXT,
      knownAnchorSignature: SIG_ANCHOR,
      pageFetcher: timelyPageFetcher,
      budgetManager,
      clock,
      lifecycleTarget: coordinator,
    });

    const resolutionBridge = new ExactPoolTransactionResolutionBridge({
      poolContext: STANDARD_POOL_CONTEXT,
      adapter,
      tracker,
      budgetManager,
      lifecycleTarget: coordinator,
      clock,
    });

    // Explicit decision timestamp set to 66s, but resolution completes at 72s
    const reconResult = await coordinator.reconcileCandidateWindow(sourceCutoff, {
      knownAnchorSignature: SIG_ANCHOR,
      historyEnumerator,
      resolutionBridge,
      decisionTimestampMs: 1_700_000_066_000,
    });

    expect(reconResult.status).toBe("FUTURE_DATED_EVIDENCE");
    expect(reconResult.flowCoverage).toBe("COLLECTION_GAP");
    expect(reconResult.flowCounts.recentBuys60s).toBeNull();
  });
});
