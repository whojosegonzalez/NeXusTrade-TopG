/**
 * Phase 12.94-D Milestone D.3.3: Exact-Pool Transaction Resolution Bridge Test Suite
 *
 * Verifies bounded offline resolution of discovered signatures through the accepted
 * transaction-source adapter into decoded swap events and trade flow tracker ingestion.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ExactPoolTransactionResolutionBridge,
  type TransactionResolutionBridgeOptions,
} from "./ExactPoolTransactionResolutionBridge.js";
import {
  RaydiumAmmV4TransactionSourceAdapter,
  type ProcessNotificationResult,
} from "./RaydiumAmmV4TransactionSourceAdapter.js";
import { RollingTradeFlowTracker } from "./RollingTradeFlowTracker.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import type {
  HistoryEnumerationResult,
  EnumerationLifecycleTarget,
} from "./ExactPoolHistoryEnumerator.js";
import type { SubscriptionCoordinatorStatus } from "./RaydiumCandidateSubscriptionCoordinator.js";
import {
  RAYDIUM_AMM_V4_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
} from "../research/pilot/RaydiumAmmParser.js";

// Canonical Base58 Fixtures
const MOCK_RPC_URL = "https://mock-solana-rpc.internal";
const SYNTHETIC_WSOL_MINT = "So11111111111111111111111111111111111111112";
const SYNTHETIC_CANDIDATE_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const SYNTHETIC_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const OTHER_POOL_ID = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
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
const SIG_D =
  "2Q1nNwSZnnxTwCvfK8frYnLRDGJ61R1Nd4vvuBcEnVMy2Y1nNwSZnnxTwCvfK8frYnLRDGJ61R1Nd4vvuBcEnVMyD";

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
  blockTime = 1_700_000_010,
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

function createSyntheticMultiSwapPayload(signature: string, slot = 101, blockTime = 1_700_000_010) {
  const accounts = [
    SPL_TOKEN_PROGRAM_ID,
    SYNTHETIC_POOL_ID,
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

class MockLifecycleTarget implements EnumerationLifecycleTarget {
  public status: SubscriptionCoordinatorStatus = "SUBSCRIBED";
  public connectionEpoch = 1;

  public getStatus(): SubscriptionCoordinatorStatus {
    return this.status;
  }

  public getConnectionEpoch(): number {
    return this.connectionEpoch;
  }
}

describe("ExactPoolTransactionResolutionBridge", () => {
  let budgetManager: GlobalResourceBudgetManager;
  let tracker: RollingTradeFlowTracker;
  let mockLifecycle: MockLifecycleTarget;
  let fakeNow: number;
  const clock = () => fakeNow;
  const sleepFn = async (ms: number) => {
    fakeNow += ms;
  };

  beforeEach(() => {
    fakeNow = 1_700_000_050_000;
    budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 50,
      maxEnrichmentAttempts: 10,
      minReservedForwardRequests: 4,
      minProviderSpacingMs: 0,
      clock,
    });
    tracker = new RollingTradeFlowTracker({
      poolId: SYNTHETIC_POOL_ID,
      tokenMint: SYNTHETIC_CANDIDATE_MINT,
      clock,
    });
    mockLifecycle = new MockLifecycleTarget();
  });

  describe("1. Constructor & Binding Validation", () => {
    it("rejects initialization without options object", () => {
      expect(
        () =>
          new ExactPoolTransactionResolutionBridge(
            null as unknown as TransactionResolutionBridgeOptions,
          ),
      ).toThrow("[RESOLUTION_BRIDGE_INIT] Options object is required");
    });

    it("rejects invalid pool context", () => {
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        sleepFn,
      });
      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: { ...STANDARD_POOL_CONTEXT, poolId: "NotBase58!" },
            adapter,
            tracker,
            budgetManager,
          }),
      ).toThrow(/\[POOL_CONTEXT_INVALID\]/);
    });

    it("rejects missing adapter", () => {
      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter: undefined as unknown as RaydiumAmmV4TransactionSourceAdapter,
            tracker,
            budgetManager,
          }),
      ).toThrow("Explicit transaction source adapter is required");
    });

    it("rejects adapter bound to a different pool ID", () => {
      const otherAdapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: { ...STANDARD_POOL_CONTEXT, poolId: OTHER_POOL_ID },
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        sleepFn,
      });
      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter: otherAdapter,
            tracker,
            budgetManager,
          }),
      ).toThrow(/Adapter pool ID .* does not match bridge pool ID/);
    });

    it("rejects missing tracker", () => {
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        sleepFn,
      });
      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter,
            tracker: undefined as unknown as RollingTradeFlowTracker,
            budgetManager,
          }),
      ).toThrow("Explicit RollingTradeFlowTracker is required");
    });

    it("rejects tracker bound to a different pool ID", () => {
      const otherTracker = new RollingTradeFlowTracker({
        poolId: OTHER_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
      });
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        sleepFn,
      });
      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter,
            tracker: otherTracker,
            budgetManager,
          }),
      ).toThrow(/Tracker pool ID .* does not match bridge pool ID/);
    });

    it("rejects missing budgetManager", () => {
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        sleepFn,
      });
      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter,
            tracker,
            budgetManager: undefined as unknown as GlobalResourceBudgetManager,
          }),
      ).toThrow("Shared GlobalResourceBudgetManager is required");
    });

    it("rejects invalid numeric limits for maxTransactionsToProcess or operationDeadlineMs", () => {
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        sleepFn,
      });
      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter,
            tracker,
            budgetManager,
            maxTransactionsToProcess: 0,
          }),
      ).toThrow(/maxTransactionsToProcess must be a positive integer <= 100/);

      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter,
            tracker,
            budgetManager,
            operationDeadlineMs: -100,
          }),
      ).toThrow(/operationDeadlineMs must be a positive integer <= 120000/);
    });

    it("snapshots and deep freezes poolContext so caller mutations after construction do not alter validation", () => {
      const mutableContext: TrackedRaydiumPoolContext = { ...STANDARD_POOL_CONTEXT };
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: mutableContext,
        adapter,
        tracker,
        budgetManager,
      });

      // Mutate original context
      (mutableContext as { poolId: string }).poolId = OTHER_POOL_ID;

      // Bridge internal poolContext remains immutable and bound to original poolId
      expect(bridge.getPoolContext().poolId).toBe(SYNTHETIC_POOL_ID);
      expect(Object.isFrozen(bridge.getPoolContext())).toBe(true);
    });

    it("rejects adapter with mismatched candidate pool context identity fields", () => {
      const testCases: { field: keyof TrackedRaydiumPoolContext; value: unknown }[] = [
        { field: "candidateTokenMint", value: "3v2A2E1bA6LqF2m8R8Fwz3v2A2E1bA6LqF2m8R8Fwz3v" },
        { field: "quoteTokenMint", value: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6C" },
        { field: "baseVault", value: "2Q1nNwSZnnxTwCvfK8frYnLRDGJ61R1Nd4vvuBcEnVMyD" },
        { field: "quoteVault", value: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnb" },
        { field: "baseMint", value: "So11111111111111111111111111111111111111112" },
        { field: "quoteMint", value: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
        { field: "orientation", value: "SOL_BASE_TOKEN_QUOTE" },
      ];

      for (const { field, value } of testCases) {
        const mismatchedAdapter = {
          getPoolContext: () => ({
            ...STANDARD_POOL_CONTEXT,
            [field]: value,
          }),
          getBudgetManager: () => budgetManager,
          getProviderName: () => "SOLANA_RPC",
          getRequestPurpose: () => "CANDIDATE_ENRICHMENT",
        } as unknown as RaydiumAmmV4TransactionSourceAdapter;

        expect(
          () =>
            new ExactPoolTransactionResolutionBridge({
              poolContext: STANDARD_POOL_CONTEXT,
              adapter: mismatchedAdapter,
              tracker,
              budgetManager,
            }),
        ).toThrow(
          new RegExp(
            `\\[RESOLUTION_BRIDGE_INIT\\] Adapter pool context field '${field}' .* does not match bridge pool context`,
          ),
        );
      }
    });

    it("rejects tracker with mismatched token mint", () => {
      const mismatchedTracker = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_WSOL_MINT, // Quote mint instead of candidateTokenMint
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        sleepFn,
      });

      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter,
            tracker: mismatchedTracker,
            budgetManager,
          }),
      ).toThrow(/Tracker token mint .* does not match bridge candidateTokenMint/);
    });

    it("rejects adapter configured with a different GlobalResourceBudgetManager instance", () => {
      const otherBudgetManager = new GlobalResourceBudgetManager();
      const otherAdapter = {
        getPoolContext: () => STANDARD_POOL_CONTEXT,
        getBudgetManager: () => otherBudgetManager,
        getProviderName: () => "SOLANA_RPC",
        getRequestPurpose: () => "CANDIDATE_ENRICHMENT",
      } as unknown as RaydiumAmmV4TransactionSourceAdapter;

      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter: otherAdapter,
            tracker,
            budgetManager,
          }),
      ).toThrow(
        "[RESOLUTION_BRIDGE_INIT] Adapter must share the identical GlobalResourceBudgetManager instance supplied to the bridge",
      );
    });

    it("rejects adapter configured with non-canonical providerName or requestPurpose", () => {
      const nonCanonicalProviderAdapter = {
        getPoolContext: () => STANDARD_POOL_CONTEXT,
        getBudgetManager: () => budgetManager,
        getProviderName: () => "solana-rpc", // Non-canonical lowercase
        getRequestPurpose: () => "CANDIDATE_ENRICHMENT",
      } as unknown as RaydiumAmmV4TransactionSourceAdapter;

      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter: nonCanonicalProviderAdapter,
            tracker,
            budgetManager,
          }),
      ).toThrow(
        "[RESOLUTION_BRIDGE_INIT] Adapter providerName must be canonical 'SOLANA_RPC', received: 'solana-rpc'",
      );

      const nonCanonicalPurposeAdapter = {
        getPoolContext: () => STANDARD_POOL_CONTEXT,
        getBudgetManager: () => budgetManager,
        getProviderName: () => "SOLANA_RPC",
        getRequestPurpose: () => "DISCOVERY_POLL", // Non-canonical purpose for resolution
      } as unknown as RaydiumAmmV4TransactionSourceAdapter;

      expect(
        () =>
          new ExactPoolTransactionResolutionBridge({
            poolContext: STANDARD_POOL_CONTEXT,
            adapter: nonCanonicalPurposeAdapter,
            tracker,
            budgetManager,
          }),
      ).toThrow(
        "[RESOLUTION_BRIDGE_INIT] Adapter requestPurpose must be 'CANDIDATE_ENRICHMENT', received: 'DISCOVERY_POLL'",
      );
    });
  });

  describe("2. Provenance & Unwitnessed Anchor Guards", () => {
    let bridge: ExactPoolTransactionResolutionBridge;

    beforeEach(() => {
      const mockFetch: typeof fetch = async () => new Response("{}", { status: 200 });
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockFetch,
        pacingMs: 0,
        sleepFn,
      });
      bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });
    });

    it("rejects enumeration result when candidatePoolId does not match bridge pool context", async () => {
      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: OTHER_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B,
        discoveredSignatures: [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("PROVENANCE_MISMATCH");
      expect(result.totalProcessed).toBe(0);
      expect(result.totalResolved).toBe(0);
      expect(result.isProductionCompletenessEstablished).toBe(false);
      expect(result.error).toMatch(/Candidate pool ID mismatch/);
    });

    it("rejects enumeration result when connectionEpoch does not match expected epoch", async () => {
      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 2, // mismatch with expected 1
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B,
        discoveredSignatures: [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("PROVENANCE_MISMATCH");
      expect(result.totalProcessed).toBe(0);
      expect(result.error).toMatch(/Connection epoch mismatch/);
    });

    it("rejects enumeration result when connectionEpoch is missing, negative, or non-integer", async () => {
      const baseEnumResult = {
        outcome: "ANCHOR_WITNESSED" as const,
        candidatePoolId: SYNTHETIC_POOL_ID,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B,
        discoveredSignatures: [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const invalidEpochCases = [undefined, -1, 1.5, Number.NaN, "1" as unknown as number];

      for (const invalidEpoch of invalidEpochCases) {
        const enumResult = {
          ...baseEnumResult,
          connectionEpoch: invalidEpoch as unknown as number,
        } as HistoryEnumerationResult;

        const result = await bridge.resolve(enumResult);

        expect(result.outcome).toBe("PROVENANCE_MISMATCH");
        expect(result.totalProcessed).toBe(0);
        expect(result.totalResolved).toBe(0);
        expect(result.error).toMatch(
          /Enumeration result must explicitly specify a valid non-negative integer connectionEpoch/,
        );
      }
    });

    it("rejects enumeration result without a witnessed anchor before making requests", async () => {
      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_NOT_FOUND",
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: false,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_B,
        discoveredSignatures: [
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("UNWITNESSED_ANCHOR_REJECTED");
      expect(result.totalProcessed).toBe(0);
      expect(result.totalResolved).toBe(0);
      expect(result.error).toMatch(/does not contain a witnessed anchor/);
    });
  });

  describe("3. Quiet Period & Discovered Ordering", () => {
    it("handles zero discovered signatures on witnessed anchor immediately (Quiet Period Fixture 3)", async () => {
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        pacingMs: 0,
        sleepFn,
      });
      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: null,
        discoveredSignatures: [],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);
      expect(result.outcome).toBe("ALL_RESOLVED");
      expect(result.totalDiscoveredSignatures).toBe(0);
      expect(result.totalProcessed).toBe(0);
      expect(result.totalResolved).toBe(0);
      expect(result.totalIngestedSwaps).toBe(0);
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });
  });

  describe("4. Real Accepted Adapter Integration Tests (Fake HTTP transport)", () => {
    it("recovers Missed-B in A -> B -> C fixture, resolving oldest-first into decoded trades", async () => {
      const dispatchedSignatures: string[] = [];
      const mockTransport: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const sig = body.params[0] as string;
        dispatchedSignatures.push(sig);

        const slot = sig === SIG_B ? 101 : 102;
        const blockTime = sig === SIG_B ? 1700000010 : 1700000020;
        const payload = createSyntheticBuyPayload(
          sig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          slot,
          blockTime,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      // Discovered signatures from RPC pagination are newest-first: [C, B]
      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_C,
        discoveredSignatures: [
          { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);
      expect(result.outcome).toBe("ALL_RESOLVED");
      expect(result.totalDiscoveredSignatures).toBe(2);
      expect(result.totalProcessed).toBe(2);
      expect(result.totalResolved).toBe(2);
      expect(result.totalFailed).toBe(0);
      expect(result.totalIngestedSwaps).toBe(2);
      expect(result.isProductionCompletenessEstablished).toBe(false);

      // Verifies chronological ordering: B dispatched before C
      expect(dispatchedSignatures).toEqual([SIG_B, SIG_C]);

      // Verifies real tracker received trades
      expect(tracker.getEventsCount()).toBe(2);
      expect(result.perSignatureResults[0]?.signature).toBe(SIG_B);
      expect(result.perSignatureResults[0]?.status).toBe("RESOLVED");
      expect(result.perSignatureResults[1]?.signature).toBe(SIG_C);
      expect(result.perSignatureResults[1]?.status).toBe("RESOLVED");
    });

    it("resolves multiple swaps within a single transaction without double counting", async () => {
      const mockTransport: typeof fetch = async () => {
        const payload = createSyntheticMultiSwapPayload(SIG_B, 101, 1700000010);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);
      expect(result.outcome).toBe("ALL_RESOLVED");
      expect(result.totalProcessed).toBe(1);
      expect(result.totalResolved).toBe(1);
      expect(result.totalIngestedSwaps).toBe(2); // 2 swaps in 1 transaction
      expect(result.perSignatureResults[0]?.decodedEventsCount).toBe(2);
      expect(result.perSignatureResults[0]?.ingestedEventsCount).toBe(2);
      expect(tracker.getEventsCount()).toBe(2);
    });
  });

  describe("5. Honest Duplicate Reporting", () => {
    it("classifies duplicate notification as DUPLICATE_UNRESOLVED and failed when prior evidence is absent", async () => {
      // Populate adapter deduplication cache with SIG_B
      const originalPayload = createSyntheticBuyPayload(
        SIG_B,
        50_000_000n,
        25_000_000_000n,
        SYNTHETIC_POOL_ID,
        101,
        1700000010,
      );
      const successfulAdapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: originalPayload }), {
            status: 200,
          }),
        pacingMs: 0,
        clock,
        sleepFn,
      });
      await successfulAdapter.processNotification(
        { signature: SIG_B, slot: 101, blockTime: 1700000010 },
        tracker,
      );

      // Now create bridge using successfulAdapter (which already cached SIG_B)
      // but without providing priorSuccessfulSignatures evidence to the bridge
      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter: successfulAdapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("PARTIAL_RESOLUTION");
      expect(result.totalProcessed).toBe(1);
      expect(result.totalResolved).toBe(0); // Not counted as resolved!
      expect(result.totalFailed).toBe(1);
      expect(result.totalDuplicatesUnresolved).toBe(1);
      expect(result.totalDuplicatesResolved).toBe(0);
      expect(result.perSignatureResults[0]?.status).toBe("DUPLICATE_UNRESOLVED");
    });

    it("prevents prior success on Tracker A from falsely resolving duplicate on fresh Tracker B", async () => {
      const originalPayload = createSyntheticBuyPayload(
        SIG_B,
        50_000_000n,
        25_000_000_000n,
        SYNTHETIC_POOL_ID,
        101,
        1700000010,
      );
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: originalPayload }), {
            status: 200,
          }),
        pacingMs: 0,
        clock,
        sleepFn,
      });

      // 1. Tracker A resolves SIG_B and ingests one swap
      const trackerA = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const bridgeA = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker: trackerA,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const resultA = await bridgeA.resolve(enumResult);
      expect(resultA.outcome).toBe("ALL_RESOLVED");
      expect(resultA.totalProcessed).toBe(1);
      expect(resultA.totalResolved).toBe(1);
      expect(resultA.totalFailed).toBe(0);
      expect(resultA.totalIngestedSwaps).toBe(1);
      expect(trackerA.getEventsCount()).toBe(1);

      // 2. Create fresh Tracker B for the same pool and mint
      const trackerB = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });
      expect(trackerB.getEventsCount()).toBe(0);

      // 3. Resolve same enumeration with Tracker B using the same adapter (which cached SIG_B)
      const bridgeB = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker: trackerB,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const resultB = await bridgeB.resolve(enumResult);

      // Conservative DUPLICATE_UNRESOLVED: Must NOT return ALL_RESOLVED or DUPLICATE_RESOLVED!
      expect(resultB.outcome).toBe("PARTIAL_RESOLUTION");
      expect(resultB.totalProcessed).toBe(1);
      expect(resultB.totalResolved).toBe(0); // Not resolved for Tracker B!
      expect(resultB.totalFailed).toBe(1);
      expect(resultB.totalDuplicatesUnresolved).toBe(1);
      expect(resultB.totalDuplicatesResolved).toBe(0);
      expect(resultB.totalIngestedSwaps).toBe(0);
      expect(resultB.perSignatureResults[0]?.status).toBe("DUPLICATE_UNRESOLVED");

      // Invariant: Tracker B must contain zero swaps, Tracker A's work is preserved
      expect(trackerB.getEventsCount()).toBe(0);
      expect(trackerA.getEventsCount()).toBe(1);
    });
  });

  describe("6. Failure & Partial Ingestion Handling", () => {
    it("handles TRANSACTION_NOT_FOUND on RPC node fail-closed as TRANSACTION_UNAVAILABLE", async () => {
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
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("PARTIAL_RESOLUTION");
      expect(result.totalFailed).toBe(1);
      expect(result.totalResolved).toBe(0);
      expect(result.perSignatureResults[0]?.status).toBe("TRANSACTION_UNAVAILABLE");
    });

    it("handles decode failure and marks signature as FAILED_DECODE", async () => {
      const mockTransport: typeof fetch = async () => {
        // Return payload for a different pool to trigger DECODE_FAILED (NO_MATCHING_SWAPS_FOUND)
        const payload = createSyntheticBuyPayload(
          SIG_B,
          50_000_000n,
          25_000_000_000n,
          OTHER_POOL_ID,
          101,
          1700000010,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("PARTIAL_RESOLUTION");
      expect(result.totalFailed).toBe(1);
      expect(result.perSignatureResults[0]?.status).toBe("FAILED_DECODE");
    });

    it("preserves partial-ingestion counts on PARTIAL_INGEST_FAILED without classifying as successful recovery", async () => {
      const mockAdapter = {
        getPoolContext: () => STANDARD_POOL_CONTEXT,
        getBudgetManager: () => budgetManager,
        getProviderName: () => "SOLANA_RPC",
        getRequestPurpose: () => "CANDIDATE_ENRICHMENT",
        processNotification: async (): Promise<ProcessNotificationResult> => {
          return {
            ok: false,
            signature: SIG_B,
            outcome: "PARTIAL_INGEST_FAILED",
            ingestedEventsCount: 1, // 1 succeeded, 1 failed
            diagnostics: {
              signature: SIG_B,
              httpAttempts: 1,
              durationMs: 5,
              outcome: "PARTIAL_INGEST_FAILED",
              decodedEventsCount: 2,
              ingestedCount: 1,
              error: "Tracker capacity reached during second swap ingestion",
            },
          };
        },
      } as unknown as RaydiumAmmV4TransactionSourceAdapter;

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter: mockAdapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("PARTIAL_RESOLUTION");
      expect(result.totalProcessed).toBe(1);
      expect(result.totalResolved).toBe(0); // Not counted as recovery
      expect(result.totalFailed).toBe(1);
      expect(result.totalIngestedSwaps).toBe(1); // Partial count preserved!
      expect(result.perSignatureResults[0]?.status).toBe("PARTIAL_INGEST");
      expect(result.perSignatureResults[0]?.ingestedEventsCount).toBe(1);
      expect(result.perSignatureResults[0]?.decodedEventsCount).toBe(2);
    });
  });

  describe("7. Resource Bounds & Budget Exhaustion", () => {
    it("bounds transactions processed up to maxTransactionsToProcess", async () => {
      const mockTransport: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const sig = body.params[0] as string;
        const slot = sig === SIG_B ? 101 : sig === SIG_C ? 102 : 103;
        const blockTime = sig === SIG_B ? 1700000010 : sig === SIG_C ? 1700000020 : 1700000030;
        const payload = createSyntheticBuyPayload(
          sig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          slot,
          blockTime,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
        maxTransactionsToProcess: 2,
      });

      // 3 discovered signatures
      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_D,
        discoveredSignatures: [
          { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
          { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("MAX_TRANSACTIONS_EXCEEDED");
      expect(result.totalDiscoveredSignatures).toBe(3);
      expect(result.totalProcessed).toBe(2);
      expect(result.totalResolved).toBe(2);
      expect(result.perSignatureResults).toHaveLength(2);
    });

    it("terminates with BUDGET_EXHAUSTED when budget manager denies request", async () => {
      // Create budget manager with 0 enrichment requests allowed
      const limitedBudgetManager = new GlobalResourceBudgetManager({
        maxTotalRequests: 50,
        maxEnrichmentAttempts: 0,
        minReservedForwardRequests: 4,
        minProviderSpacingMs: 0,
        clock,
      });

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager: limitedBudgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager: limitedBudgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("BUDGET_EXHAUSTED");
      expect(result.totalProcessed).toBe(1);
      expect(result.totalResolved).toBe(0);
      expect(result.totalFailed).toBe(1);
      expect(result.perSignatureResults[0]?.status).toBe("BUDGET_DENIED");
    });

    it("enforces that per-call overrides can reduce limits but never raise constructor ceilings", async () => {
      const mockTransport: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const sig = body.params[0] as string;
        const slot = sig === SIG_B ? 101 : 102;
        const blockTime = sig === SIG_B ? 1700000010 : 1700000020;
        const payload = createSyntheticBuyPayload(
          sig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          slot,
          blockTime,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      // Constructor configured with maxTransactionsToProcess: 1
      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
        maxTransactionsToProcess: 1,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_C,
        discoveredSignatures: [
          { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      // Attempting to raise limit to 2 via call overrides must be clamped to constructor ceiling 1
      const result = await bridge.resolve(enumResult, { maxTransactionsToProcess: 2 });
      expect(result.outcome).toBe("MAX_TRANSACTIONS_EXCEEDED");
      expect(result.totalProcessed).toBe(1); // Clamped to 1!

      // Bridge with constructor limit 5 can be reduced to 1 via call overrides
      const adapter2 = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });
      const tracker2 = new RollingTradeFlowTracker({
        poolId: SYNTHETIC_POOL_ID,
        tokenMint: SYNTHETIC_CANDIDATE_MINT,
        clock,
      });

      const higherCeilingBridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter: adapter2,
        tracker: tracker2,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
        maxTransactionsToProcess: 5,
      });

      const reducedResult = await higherCeilingBridge.resolve(enumResult, {
        maxTransactionsToProcess: 1,
      });
      expect(reducedResult.outcome).toBe("MAX_TRANSACTIONS_EXCEEDED");
      expect(reducedResult.totalProcessed).toBe(1); // Reduced to 1!
    });

    it("rejects invalid per-call numeric limits as RESOLUTION_CALL_INVALID", async () => {
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      // Invalid maxTransactionsToProcess
      await expect(() =>
        bridge.resolve(enumResult, { maxTransactionsToProcess: 0 }),
      ).rejects.toThrow(/\[RESOLUTION_CALL_INVALID\] per-call maxTransactionsToProcess/);

      await expect(() =>
        bridge.resolve(enumResult, { maxTransactionsToProcess: -1 }),
      ).rejects.toThrow(/\[RESOLUTION_CALL_INVALID\] per-call maxTransactionsToProcess/);

      await expect(() =>
        bridge.resolve(enumResult, { maxTransactionsToProcess: 1.5 }),
      ).rejects.toThrow(/\[RESOLUTION_CALL_INVALID\] per-call maxTransactionsToProcess/);

      // Invalid operationDeadlineMs
      await expect(() => bridge.resolve(enumResult, { operationDeadlineMs: 0 })).rejects.toThrow(
        /\[RESOLUTION_CALL_INVALID\] per-call operationDeadlineMs/,
      );

      await expect(() => bridge.resolve(enumResult, { operationDeadlineMs: -50 })).rejects.toThrow(
        /\[RESOLUTION_CALL_INVALID\] per-call operationDeadlineMs/,
      );

      await expect(() =>
        bridge.resolve(enumResult, { operationDeadlineMs: 100.5 }),
      ).rejects.toThrow(/\[RESOLUTION_CALL_INVALID\] per-call operationDeadlineMs/);
    });
  });

  describe("8. Cancellation, Deadlines & Stale Lifecycle (Around Awaited Work)", () => {
    it("returns OPERATION_CANCELLED before dispatch when caller cancelled", async () => {
      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
        isCancelled: () => true,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("OPERATION_CANCELLED");
      expect(result.totalProcessed).toBe(0);
    });

    it("returns OPERATION_DEADLINE_EXCEEDED before dispatch when deadline already passed", async () => {
      let callCount = 0;
      const warpedClock = () => {
        callCount++;
        // First call sets startTime = 1_000_000. Subsequent calls return 1_000_500 (> 100ms deadline)
        return callCount === 1 ? 1_000_000 : 1_000_500;
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        pacingMs: 0,
        clock: warpedClock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock: warpedClock,
        operationDeadlineMs: 100,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("OPERATION_DEADLINE_EXCEEDED");
      expect(result.totalProcessed).toBe(0);
    });

    it("returns LIFECYCLE_CANCELLED post-await when coordinator disconnects during in-flight fetch", async () => {
      const mockTransport: typeof fetch = async () => {
        // Disconnect coordinator during in-flight fetch before returning
        mockLifecycle.status = "DISCONNECTED";
        const payload = createSyntheticBuyPayload(
          SIG_B,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          101,
          1700000010,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(result.totalProcessed).toBe(1);
      expect(result.totalResolved).toBe(0);
      expect(result.totalFailed).toBe(1);
      expect(result.perSignatureResults[0]?.status).toBe("LIFECYCLE_CANCELLED");
      expect(result.totalIngestedSwaps).toBe(0);
      expect(tracker.getEventsCount()).toBe(0);
      expect(result.perSignatureResults[0]?.ingestedEventsCount).toBe(0);
    });

    it("prevents HTTP dispatch and swap ingestion when epoch increments during provider pacing wait", async () => {
      let httpDispatchedForC = false;
      const mockTransport: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const sig = body.params[0] as string;
        if (sig === SIG_C) {
          httpDispatchedForC = true;
        }
        const slot = sig === SIG_B ? 101 : 102;
        const blockTime = sig === SIG_B ? 1700000010 : 1700000020;
        const payload = createSyntheticBuyPayload(
          sig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          slot,
          blockTime,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      // Custom sleepFn that simulates connection epoch increment during pacing wait for second transaction
      const pacingSleepFn = async (ms: number) => {
        if (ms > 0) {
          mockLifecycle.connectionEpoch = 2; // Invalidate epoch during pacing wait!
        }
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 2500,
        clock,
        sleepFn: pacingSleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      // Discovered signatures: [C, B] -> chronological order processes B first, then C
      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_C,
        discoveredSignatures: [
          { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(httpDispatchedForC).toBe(false); // HTTP dispatch for SIG_C was prevented!
      expect(result.totalProcessed).toBe(2);
      expect(result.totalResolved).toBe(1);
      expect(result.totalFailed).toBe(1);
      // Work for SIG_B is preserved
      expect(result.totalIngestedSwaps).toBe(1);
      expect(tracker.getEventsCount()).toBe(1);
      expect(result.perSignatureResults[0]?.signature).toBe(SIG_B);
      expect(result.perSignatureResults[0]?.ingestedEventsCount).toBe(1);
      expect(result.perSignatureResults[1]?.signature).toBe(SIG_C);
      expect(result.perSignatureResults[1]?.ingestedEventsCount).toBe(0);
    });

    it("prevents swap ingestion when caller cancels via callback during in-flight fetch and preserves zero count parity", async () => {
      let isCancelledFlag = false;
      const mockTransport: typeof fetch = async () => {
        // Caller cancels during in-flight fetch
        isCancelledFlag = true;
        const payload = createSyntheticBuyPayload(
          SIG_B,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          101,
          1700000010,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
        isCancelled: () => isCancelledFlag,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("OPERATION_CANCELLED");
      expect(result.totalIngestedSwaps).toBe(0);
      expect(tracker.getEventsCount()).toBe(0);
      expect(result.perSignatureResults[0]?.ingestedEventsCount).toBe(0);
    });

    it("preserves all work that actually occurred in totalIngestedSwaps and tracker when operation terminates prematurely on second signature", async () => {
      const mockTransport: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const sig = body.params[0] as string;

        if (sig === SIG_C) {
          // Invalidate lifecycle during second transaction fetch
          mockLifecycle.connectionEpoch = 2;
        }

        const slot = sig === SIG_B ? 101 : 102;
        const blockTime = sig === SIG_B ? 1700000010 : 1700000020;
        const payload = createSyntheticBuyPayload(
          sig,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          slot,
          blockTime,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      // Discovered signatures: [C, B] -> chronological order processes B first, then C
      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
        candidatePoolId: SYNTHETIC_POOL_ID,
        connectionEpoch: 1,
        anchorWitnessed: true,
        knownAnchorSignature: SIG_ANCHOR,
        frozenTargetSignature: SIG_C,
        discoveredSignatures: [
          { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
          { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        ],
        pagesQueried: 1,
        requestCount: 1,
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);

      expect(result.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(result.totalProcessed).toBe(2);
      expect(result.totalResolved).toBe(1);
      expect(result.totalFailed).toBe(1);
      // Signature B work is preserved in aggregate totalIngestedSwaps and tracker
      expect(result.totalIngestedSwaps).toBe(1);
      expect(tracker.getEventsCount()).toBe(1);
      expect(result.perSignatureResults[0]?.signature).toBe(SIG_B);
      expect(result.perSignatureResults[0]?.status).toBe("RESOLVED");
      expect(result.perSignatureResults[0]?.ingestedEventsCount).toBe(1);
      expect(result.perSignatureResults[1]?.signature).toBe(SIG_C);
      expect(result.perSignatureResults[1]?.status).toBe("LIFECYCLE_CANCELLED");
      expect(result.perSignatureResults[1]?.ingestedEventsCount).toBe(0);
    });

    it("ensures an un-aborted per-call signal or callback cannot override an already-aborted constructor signal", async () => {
      const constructorController = new AbortController();
      constructorController.abort(new Error("Pre-aborted in constructor"));

      const freshPerCallController = new AbortController();

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: async () => new Response("{}", { status: 200 }),
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
        signal: constructorController.signal,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult, {
        signal: freshPerCallController.signal,
        isCancelled: () => false,
      });

      expect(result.outcome).toBe("OPERATION_CANCELLED");
      expect(result.totalProcessed).toBe(0);
      expect(result.totalIngestedSwaps).toBe(0);
    });
  });

  describe("9. Production Completeness Separation", () => {
    it("leaves tracker stream gaps untouched and permanently retains isProductionCompletenessEstablished = false", async () => {
      // Record a valid stream gap in tracker before resolution
      tracker.recordCollectionGap({
        gapStartMs: fakeNow - 10_000,
        gapEndMs: fakeNow - 5_000,
        reason: "DROPPED_FRAMES",
      });
      expect(tracker.getGapsCount()).toBe(1);

      const mockTransport: typeof fetch = async () => {
        const payload = createSyntheticBuyPayload(
          SIG_B,
          50_000_000n,
          25_000_000_000n,
          SYNTHETIC_POOL_ID,
          101,
          1700000010,
        );
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: payload }), {
          status: 200,
        });
      };

      const adapter = new RaydiumAmmV4TransactionSourceAdapter({
        poolContext: STANDARD_POOL_CONTEXT,
        rpcUrl: MOCK_RPC_URL,
        budgetManager,
        transport: mockTransport,
        pacingMs: 0,
        clock,
        sleepFn,
      });

      const bridge = new ExactPoolTransactionResolutionBridge({
        poolContext: STANDARD_POOL_CONTEXT,
        adapter,
        tracker,
        budgetManager,
        lifecycleTarget: mockLifecycle,
        expectedEpoch: 1,
        clock,
      });

      const enumResult: HistoryEnumerationResult = {
        outcome: "ANCHOR_WITNESSED",
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
        isProductionCompletenessEstablished: false,
      };

      const result = await bridge.resolve(enumResult);
      expect(result.outcome).toBe("ALL_RESOLVED");
      // Tracker gap must NOT be cleared by resolution
      expect(tracker.getGapsCount()).toBe(1);
      // Production completeness remains strictly false
      expect(result.isProductionCompletenessEstablished).toBe(false);
      // Object is deep frozen
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.perSignatureResults)).toBe(true);
    });
  });
});
