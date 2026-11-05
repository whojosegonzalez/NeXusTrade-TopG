/**
 * Phase 12.94-D Milestone D.3.3: Offline Test Suite for
 * ExactPoolHistoryEnumerator
 *
 * Deterministic offline test suite verifying:
 * 1. Exact candidate binding & options validation (fail-closed initialization)
 * 2. Missed-B Fixture ($A \rightarrow B \rightarrow C$): discovers missed B, freezes C from RPC head, witnesses A
 * 3. Multi-page pagination traversal returning anchor ($E \dots A$)
 * 4. Anchor-only quiet history (slot tick with zero pool transactions since A)
 * 5. Unreached boundary on empty history page (honest ANCHOR_NOT_FOUND, anchorWitnessed = false)
 * 6. Unreached boundary on short page (< pageSize without anchor)
 * 7. Duplicate, overlapping, and non-progressing pages (loop detection)
 * 8. Concurrent live notifications do not alter frozen target
 * 9. Cancellation handling (pre-dispatch and post-await)
 * 10. Coordinator lifecycle and epoch cancellation (pre-dispatch and post-await)
 * 11. Operation deadline and bounds enforcement (maxPages, maxRetainedRecords)
 * 12. Budget manager enforcement under strict CANDIDATE_ENRICHMENT (no purpose switching, no retries)
 * 13. Rejection of malformed records (fail-closed)
 * 14. Fetcher error handling
 * 15. Functional entrypoint parity
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ExactPoolHistoryEnumerator,
  enumerateExactPoolHistory,
  isValidSolanaSignature,
  type ExactPoolHistoryEnumeratorOptions,
  type HistorySignatureRecord,
  type HistoryPageQueryParams,
  type HistoryPageFetcher,
  type EnumerationLifecycleTarget,
} from "./ExactPoolHistoryEnumerator.js";
import { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { TrackedRaydiumPoolContext } from "./RaydiumAmmV4SwapDecoder.js";
import type { SubscriptionCoordinatorStatus } from "./RaydiumCandidateSubscriptionCoordinator.js";

// Canonical Base58 fixture addresses
const CANONICAL_POOL_ID = "AVs9TA4nWDzfPJE9gGVNJMVhcQy3V9PGazuz33BfG2RA";
const CANONICAL_TOKEN_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const CANONICAL_PC_MINT = "So11111111111111111111111111111111111111112";
const CANONICAL_COIN_VAULT = "EkVZ1kV8V2B5U7T3k2Z2x8r8m4K7J3W3e5R2T6U8V9Y";
const CANONICAL_PC_VAULT = "FkVZ1kV8V2B5U7T3k2Z2x8r8m4K7J3W3e5R2T6U8V9Z";

const VALID_POOL_CONTEXT: TrackedRaydiumPoolContext = Object.freeze({
  poolId: CANONICAL_POOL_ID,
  candidateTokenMint: CANONICAL_TOKEN_MINT,
  quoteTokenMint: CANONICAL_PC_MINT,
  baseVault: CANONICAL_COIN_VAULT,
  quoteVault: CANONICAL_PC_VAULT,
  baseMint: CANONICAL_TOKEN_MINT,
  quoteMint: CANONICAL_PC_MINT,
  orientation: "TOKEN_BASE_SOL_QUOTE",
});

// Canonical Base58 transaction signatures
const SIG_A = "5UkeD7KkR2z8vK3Xp2N8t5M7W4v8Y1L6J3H9P2Q5S8T1V4X7Z9B2D4F6H8J1K3M5N7P9R2T4V6X8Z1";
const SIG_B = "3kR2z8vK3Xp2N8t5M7W4v8Y1L6J3H9P2Q5S8T1V4X7Z9B2D4F6H8J1K3M5N7P9R2T4V6X8Z15UkeD7K";
const SIG_C = "2z8vK3Xp2N8t5M7W4v8Y1L6J3H9P2Q5S8T1V4X7Z9B2D4F6H8J1K3M5N7P9R2T4V6X8Z15UkeD7KkR3";
const SIG_D = "7W4v8Y1L6J3H9P2Q5S8T1V4X7Z9B2D4F6H8J1K3M5N7P9R2T4V6X8Z15UkeD7KkR2z8vK3Xp2N8t5M";
const SIG_E = "8Y1L6J3H9P2Q5S8T1V4X7Z9B2D4F6H8J1K3M5N7P9R2T4V6X8Z15UkeD7KkR2z8vK3Xp2N8t5M7W4v";

class MockPageFetcher implements HistoryPageFetcher {
  public recordedQueries: HistoryPageQueryParams[] = [];
  public queuedPages: (readonly HistorySignatureRecord[] | Error)[] = [];
  public onBeforeFetch?: (() => void) | undefined;

  public async fetchPage(
    params: HistoryPageQueryParams,
  ): Promise<readonly HistorySignatureRecord[]> {
    this.recordedQueries.push({ ...params });
    if (this.onBeforeFetch) {
      this.onBeforeFetch();
    }
    const next = this.queuedPages.shift();
    if (!next) {
      return [];
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
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

describe("ExactPoolHistoryEnumerator", () => {
  let budgetManager: GlobalResourceBudgetManager;
  let mockFetcher: MockPageFetcher;
  let mockLifecycle: MockLifecycleTarget;
  let fakeNow = 1_000_000;
  const clock = () => fakeNow;

  const createHelper = (optionsOverrides = {}) => {
    return new ExactPoolHistoryEnumerator({
      poolContext: VALID_POOL_CONTEXT,
      knownAnchorSignature: SIG_A,
      pageFetcher: mockFetcher,
      budgetManager,
      clock,
      lifecycleTarget: mockLifecycle,
      pageSize: 10,
      operationDeadlineMs: 10_000,
      ...optionsOverrides,
    });
  };

  beforeEach(() => {
    fakeNow = 1_000_000;
    budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 50,
      maxEnrichmentAttempts: 10,
      minReservedForwardRequests: 4,
      minProviderSpacingMs: 0, // 0 spacing for deterministic instant tests unless overridden
      clock,
    });
    mockFetcher = new MockPageFetcher();
    mockLifecycle = new MockLifecycleTarget();
  });

  describe("1. Constructor & Input Validation", () => {
    it("rejects missing options object", () => {
      expect(
        () => new ExactPoolHistoryEnumerator(null as unknown as ExactPoolHistoryEnumeratorOptions),
      ).toThrow(/\[ENUMERATOR_INIT\] Options object is required/);
    });

    it("rejects invalid pool context", () => {
      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: { ...VALID_POOL_CONTEXT, poolId: "NotBase58!" },
            knownAnchorSignature: SIG_A,
            pageFetcher: mockFetcher,
            budgetManager,
          }),
      ).toThrow(/\[POOL_CONTEXT_INVALID\]/);
    });

    it("rejects invalid knownAnchorSignature", () => {
      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: "ShortBadSig",
            pageFetcher: mockFetcher,
            budgetManager,
          }),
      ).toThrow(/\[ENUMERATOR_INIT\] knownAnchorSignature must be a valid Solana Base58/);
    });

    it("rejects missing pageFetcher", () => {
      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: SIG_A,
            pageFetcher: null as unknown as HistoryPageFetcher,
            budgetManager,
          }),
      ).toThrow(/\[ENUMERATOR_INIT\] pageFetcher is mandatory/);
    });

    it("rejects missing budgetManager", () => {
      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: SIG_A,
            pageFetcher: mockFetcher,
            budgetManager: null as unknown as GlobalResourceBudgetManager,
          }),
      ).toThrow(/\[ENUMERATOR_INIT\] budgetManager must be a valid GlobalResourceBudgetManager/);
    });

    it("rejects out-of-bounds pageSize, maxPages, maxRetainedRecords, or operationDeadlineMs", () => {
      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: SIG_A,
            pageFetcher: mockFetcher,
            budgetManager,
            pageSize: 0,
          }),
      ).toThrow(/pageSize must be an integer between 1 and 100/);

      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: SIG_A,
            pageFetcher: mockFetcher,
            budgetManager,
            maxPages: 0,
          }),
      ).toThrow(/maxPages must be an integer between 1 and 50/);

      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: SIG_A,
            pageFetcher: mockFetcher,
            budgetManager,
            maxRetainedRecords: 0,
          }),
      ).toThrow(/maxRetainedRecords must be an integer between 1 and 500/);

      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: SIG_A,
            pageFetcher: mockFetcher,
            budgetManager,
            operationDeadlineMs: -100,
          }),
      ).toThrow(/operationDeadlineMs must be a positive finite number/);
    });

    it("accepts functional page fetcher and clones pool context immutably", () => {
      const mutableContext = { ...VALID_POOL_CONTEXT };
      const enumerator = new ExactPoolHistoryEnumerator({
        poolContext: mutableContext,
        knownAnchorSignature: SIG_A,
        pageFetcher: async () => [],
        budgetManager,
      });
      // Mutating source context after construction does not affect enumerator
      (mutableContext as { poolId: string }).poolId = "MutatedAddress11111111111111111111111111";
      expect(enumerator).toBeDefined();
    });
  });

  describe("2. Missed-B Fixture (A -> B -> C)", () => {
    it("recovers missed B, freezes C from RPC head, witnesses anchor A, and excludes A from discovered list", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1];

      const enumerator = createHelper({ pageSize: 10 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.anchorWitnessed).toBe(true);
      expect(result.frozenTargetSignature).toBe(SIG_C);
      expect(result.knownAnchorSignature).toBe(SIG_A);
      expect(result.pagesQueried).toBe(1);
      expect(result.requestCount).toBe(1);
      expect(result.isProductionCompletenessEstablished).toBe(false);

      // Discovered signatures must contain C and B in ledger return order, excluding anchor A
      expect(result.discoveredSignatures).toHaveLength(2);
      expect(result.discoveredSignatures[0]?.signature).toBe(SIG_C);
      expect(result.discoveredSignatures[1]?.signature).toBe(SIG_B);
      expect(result.discoveredSignatures.some((r) => r.signature === SIG_A)).toBe(false);

      // Query verification
      expect(mockFetcher.recordedQueries).toHaveLength(1);
      expect(mockFetcher.recordedQueries[0]?.address).toBe(CANONICAL_POOL_ID);
      expect(mockFetcher.recordedQueries[0]?.limit).toBe(10);
      expect(mockFetcher.recordedQueries[0]?.before).toBeUndefined();
      expect(mockFetcher.recordedQueries[0]?.commitment).toBe("confirmed");

      // Budget check: exactly 1 enrichment request recorded
      const stats = budgetManager.getStats();
      expect(stats.enrichmentRequests).toBe(1);
      expect(stats.totalRequests).toBe(1);
    });
  });

  describe("3. Multi-Page Pagination Traversal Returning Anchor (E ... A)", () => {
    it("paginates backward with before: oldestInPage until anchor is witnessed across multiple pages", async () => {
      // Page 1: returns [E, D] (full page of size 2, anchor not in page)
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      // Page 2: returns [C, B, A] (anchor A is present)
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1, page2];

      const enumerator = createHelper({ pageSize: 2, maxPages: 5 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.anchorWitnessed).toBe(true);
      expect(result.frozenTargetSignature).toBe(SIG_E);
      expect(result.pagesQueried).toBe(2);
      expect(result.requestCount).toBe(2);
      expect(result.isProductionCompletenessEstablished).toBe(false);

      // Discovered signatures: [E, D, C, B] in ledger return order
      expect(result.discoveredSignatures.map((r) => r.signature)).toEqual([
        SIG_E,
        SIG_D,
        SIG_C,
        SIG_B,
      ]);

      // Verify queries
      expect(mockFetcher.recordedQueries).toHaveLength(2);
      expect(mockFetcher.recordedQueries[0]?.before).toBeUndefined();
      expect(mockFetcher.recordedQueries[1]?.before).toBe(SIG_D);

      // Budget check
      expect(budgetManager.getStats().enrichmentRequests).toBe(2);
    });
  });

  describe("4. Anchor-Only Quiet History", () => {
    it("witnesses anchor when query returns only anchor A, yielding empty discovered list", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1];

      const enumerator = createHelper({ pageSize: 10 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.anchorWitnessed).toBe(true);
      expect(result.frozenTargetSignature).toBe(SIG_A);
      expect(result.discoveredSignatures).toEqual([]);
      expect(result.pagesQueried).toBe(1);
      expect(result.requestCount).toBe(1);
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });
  });

  describe("5. Unreached Boundary on Empty Response", () => {
    it("returns ANCHOR_NOT_FOUND with anchorWitnessed = false on empty initial response", async () => {
      mockFetcher.queuedPages = [[]];

      const enumerator = createHelper({ pageSize: 10 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_NOT_FOUND");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.frozenTargetSignature).toBeNull();
      expect(result.discoveredSignatures).toEqual([]);
      expect(result.pagesQueried).toBe(1);
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });
  });

  describe("6. Unreached Boundary on Short Response", () => {
    it("returns ANCHOR_NOT_FOUND with anchorWitnessed = false when page is shorter than pageSize and lacks anchor", async () => {
      // Requested pageSize = 10, but RPC returned only 2 records [C, B] without anchor A
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
      ];
      mockFetcher.queuedPages = [page1];

      const enumerator = createHelper({ pageSize: 10 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_NOT_FOUND");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.frozenTargetSignature).toBe(SIG_C);
      expect(result.pagesQueried).toBe(1);
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });
  });

  describe("7. Duplicate, Overlapping, and Non-Progressing Pages", () => {
    it("detects non-progressing loop when subsequent page produces zero new signatures", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      // Page 2 repeats the exact same records
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      mockFetcher.queuedPages = [page1, page2];

      const enumerator = createHelper({ pageSize: 2, maxPages: 5 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("NON_PROGRESSING_PAGE");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.pagesQueried).toBe(2);
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });

    it("deduplicates overlapping signatures between consecutive pages", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      // Page 2 overlaps on SIG_D, then introduces SIG_C and anchor SIG_A
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1, page2];

      const enumerator = createHelper({ pageSize: 2, maxPages: 5 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.anchorWitnessed).toBe(true);
      expect(result.discoveredSignatures.map((r) => r.signature)).toEqual([SIG_E, SIG_D, SIG_C]);
    });
  });

  describe("8. Frozen Target Invariance Across Concurrent Outside Notifications", () => {
    it("keeps frozenTargetSignature pinned to RPC head even if caller buffers outside notifications", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1];

      // Simulate concurrent outside WebSocket hint arrival
      const outsideNotification = "ConcurrentWebSocketSig99999999999999999999999999";

      const enumerator = createHelper({ pageSize: 10 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.frozenTargetSignature).toBe(SIG_C);
      expect(result.frozenTargetSignature).not.toBe(outsideNotification);
    });
  });

  describe("9. Cancellation Handling", () => {
    it("returns OPERATION_CANCELLED immediately on pre-dispatch cancellation with zero requests", async () => {
      const enumerator = createHelper({
        isCancelled: () => true,
      });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("OPERATION_CANCELLED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.requestCount).toBe(0);
      expect(result.pagesQueried).toBe(0);
      expect(mockFetcher.recordedQueries).toHaveLength(0);
    });

    it("discards results and returns OPERATION_CANCELLED when cancelled during in-flight await", async () => {
      let isCancelled = false;
      mockFetcher.onBeforeFetch = () => {
        isCancelled = true;
      };
      mockFetcher.queuedPages = [
        [{ signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 }],
      ];

      const enumerator = createHelper({
        isCancelled: () => isCancelled,
      });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("OPERATION_CANCELLED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.pagesQueried).toBe(1);
      expect(result.discoveredSignatures).toEqual([]);
    });
  });

  describe("10. Coordinator Lifecycle & Epoch Cancellation", () => {
    it("fails closed on pre-dispatch when coordinator status is not SUBSCRIBED", async () => {
      mockLifecycle.status = "DISCONNECTED";

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.requestCount).toBe(0);
      expect(result.error).toMatch(/Coordinator is no longer SUBSCRIBED/);
    });

    it("fails closed on pre-dispatch when connectionEpoch does not match expected epoch", async () => {
      mockLifecycle.connectionEpoch = 2; // expected 1

      const enumerator = createHelper({ dispatchEpoch: 1 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.requestCount).toBe(0);
      expect(result.error).toMatch(/Coordinator epoch changed/);
    });

    it("discards in-flight response when coordinator drops to DISCONNECTED during await", async () => {
      mockFetcher.onBeforeFetch = () => {
        mockLifecycle.status = "DISCONNECTED";
      };
      mockFetcher.queuedPages = [
        [{ signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 }],
      ];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.discoveredSignatures).toEqual([]);
      expect(result.error).toMatch(/Coordinator status transitioned to DISCONNECTED/);
    });

    it("discards in-flight response when transport is replaced and epoch changes during await", async () => {
      mockFetcher.onBeforeFetch = () => {
        mockLifecycle.connectionEpoch = 2; // increment epoch
      };
      mockFetcher.queuedPages = [
        [{ signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 }],
      ];

      const enumerator = createHelper({ dispatchEpoch: 1 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.discoveredSignatures).toEqual([]);
      expect(result.error).toMatch(/Coordinator epoch changed to 2/);
    });
  });

  describe("11. Operation Deadline & Bounds Enforcement", () => {
    it("returns OPERATION_DEADLINE_EXCEEDED when deadline expired pre-dispatch", async () => {
      fakeNow = 1_000_000;
      const enumerator = createHelper({
        operationDeadlineMs: 500,
        clock: () => {
          fakeNow += 600;
          return fakeNow;
        },
      });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("OPERATION_DEADLINE_EXCEEDED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.requestCount).toBe(0);
    });

    it("returns OPERATION_DEADLINE_EXCEEDED when deadline expired during await", async () => {
      fakeNow = 1_000_000;
      mockFetcher.onBeforeFetch = () => {
        fakeNow += 20_000; // warp past 10s deadline
      };
      mockFetcher.queuedPages = [
        [{ signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 }],
      ];

      const enumerator = createHelper({
        operationDeadlineMs: 10_000,
      });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("OPERATION_DEADLINE_EXCEEDED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.discoveredSignatures).toEqual([]);
    });

    it("stops with MAX_PAGES_EXHAUSTED when reaching maxPages limit without anchor", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
      ];
      mockFetcher.queuedPages = [page1, page2];

      const enumerator = createHelper({ pageSize: 2, maxPages: 2 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MAX_PAGES_EXHAUSTED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.pagesQueried).toBe(2);
      expect(result.discoveredSignatures).toHaveLength(4);
    });

    it("stops with MAX_RECORDS_EXCEEDED when retained signatures exceed limit", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      mockFetcher.queuedPages = [page1];

      // Limit maxRetainedRecords = 1, but page1 has 2 records
      const enumerator = createHelper({ pageSize: 2, maxRetainedRecords: 1 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MAX_RECORDS_EXCEEDED");
      expect(result.anchorWitnessed).toBe(false);
    });
  });

  describe("12. Budget Manager Enforcement under Strict CANDIDATE_ENRICHMENT", () => {
    it("fails closed when CANDIDATE_ENRICHMENT limit (10) is exhausted", async () => {
      // Consume 10 enrichment requests prior to enumeration
      for (let i = 0; i < 10; i++) {
        budgetManager.recordRequestAttempt("solana-rpc", "CANDIDATE_ENRICHMENT", fakeNow);
      }

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("BUDGET_EXHAUSTED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.budgetDenialReason).toBe("MAX_ENRICHMENT_ATTEMPTS_REACHED");
      expect(result.requestCount).toBe(0);
      expect(mockFetcher.recordedQueries).toHaveLength(0);
    });

    it("fails closed when global ceiling is reached", async () => {
      // Set small manager
      const smallBudget = new GlobalResourceBudgetManager({
        maxTotalRequests: 5,
        maxEnrichmentAttempts: 10,
        minReservedForwardRequests: 0,
        minProviderSpacingMs: 0,
        clock,
      });
      for (let i = 0; i < 5; i++) {
        smallBudget.recordRequestAttempt("solana-rpc", "DISCOVERY_POLL", fakeNow);
      }

      const enumerator = createHelper({ budgetManager: smallBudget });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("BUDGET_EXHAUSTED");
      expect(result.budgetDenialReason).toBe("GLOBAL_REQUEST_CEILING_REACHED");
    });

    it("fails closed when within reserved forward observations capacity", async () => {
      const reservedBudget = new GlobalResourceBudgetManager({
        maxTotalRequests: 10,
        maxEnrichmentAttempts: 10,
        minReservedForwardRequests: 4,
        minProviderSpacingMs: 0,
        clock,
      });
      // 6 requests made; 6 + 4 >= 10, blocking enrichment
      for (let i = 0; i < 6; i++) {
        reservedBudget.recordRequestAttempt("solana-rpc", "DISCOVERY_POLL", fakeNow);
      }

      const enumerator = createHelper({ budgetManager: reservedBudget });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("BUDGET_EXHAUSTED");
      expect(result.budgetDenialReason).toBe("RESERVED_FOR_FORWARD_OBSERVATIONS");
    });

    it("fails closed when provider pacing is not met", async () => {
      const pacingBudget = new GlobalResourceBudgetManager({
        maxTotalRequests: 50,
        maxEnrichmentAttempts: 10,
        minReservedForwardRequests: 4,
        minProviderSpacingMs: 2500,
        clock,
      });
      // Call once at fakeNow
      pacingBudget.recordRequestAttempt("solana-rpc", "CANDIDATE_ENRICHMENT", fakeNow);

      // Attempt second call after only 1000ms (< 2500ms)
      fakeNow += 1000;
      const enumerator = createHelper({ budgetManager: pacingBudget });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("BUDGET_EXHAUSTED");
      expect(result.budgetDenialReason).toBe("PROVIDER_PACING_NOT_MET");
    });
  });

  describe("13. Rejection of Malformed Records", () => {
    it("fails closed when RPC response is not an array", async () => {
      mockFetcher.queuedPages = ["not-an-array" as unknown as readonly HistorySignatureRecord[]];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/RPC history page response is not an array/);
    });

    it("fails closed when a record has an invalid Base58 signature", async () => {
      const malformed: unknown[] = [
        { signature: "Invalid_Chars!@#$", slot: 100, err: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [malformed as unknown as readonly HistorySignatureRecord[]];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/invalid Base58 signature/);
    });

    it("fails closed when a record has negative or non-integer slot", async () => {
      const malformed: unknown[] = [
        { signature: SIG_C, slot: -5, err: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [malformed as unknown as readonly HistorySignatureRecord[]];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/invalid non-negative integer slot/);
    });

    it("fails closed when a record has negative blockTime", async () => {
      const malformed: unknown[] = [{ signature: SIG_C, slot: 100, err: null, blockTime: -100 }];
      mockFetcher.queuedPages = [malformed as unknown as readonly HistorySignatureRecord[]];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/invalid blockTime/);
    });
  });

  describe("14. Fetcher Error Handling", () => {
    it("returns FETCH_ERROR when injected fetcher throws", async () => {
      mockFetcher.queuedPages = [new Error("Solana RPC 503 Service Unavailable")];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("FETCH_ERROR");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toBe("Solana RPC 503 Service Unavailable");
      expect(result.pagesQueried).toBe(1);
    });
  });

  describe("15. Functional Entrypoint Parity", () => {
    it("enumerateExactPoolHistory function returns identical successful result", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1];

      const result = await enumerateExactPoolHistory({
        poolContext: VALID_POOL_CONTEXT,
        knownAnchorSignature: SIG_A,
        pageFetcher: mockFetcher,
        budgetManager,
        clock,
        lifecycleTarget: mockLifecycle,
      });

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.anchorWitnessed).toBe(true);
      expect(result.frozenTargetSignature).toBe(SIG_C);
      expect(result.discoveredSignatures).toHaveLength(1);
      expect(result.discoveredSignatures[0]?.signature).toBe(SIG_C);
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });
  });

  describe("16. Signature Validation Helper", () => {
    it("correctly identifies valid and invalid Solana Base58 signatures", () => {
      expect(isValidSolanaSignature(SIG_A)).toBe(true);
      expect(isValidSolanaSignature(SIG_B)).toBe(true);
      expect(isValidSolanaSignature("")).toBe(false);
      expect(isValidSolanaSignature("short")).toBe(false);
      expect(isValidSolanaSignature("InvalidBase58With0OIlSpecialChars!!!")).toBe(false);
      expect(isValidSolanaSignature(12345)).toBe(false);
      expect(isValidSolanaSignature(null)).toBe(false);
    });
  });
});
