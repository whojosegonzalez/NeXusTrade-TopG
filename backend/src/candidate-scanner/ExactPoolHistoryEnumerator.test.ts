/**
 * Phase 12.94-D Milestone D.3.3: Offline Test Suite for
 * ExactPoolHistoryEnumerator
 *
 * Deterministic offline test suite verifying:
 * 1. Exact candidate binding & options validation (fail-closed initialization)
 * 2. Shared resource identity ("SOLANA_RPC") and recoverable pacing waits across pagination
 * 3. In-flight deadline and cancellation enforcement (stalled-fetch timeouts, caller cancellation, lifecycle invalidation)
 * 4. Bounded capacity enforcement (checked before insertion) and immutable deep-freezing
 * 5. Full record & traversal schema validation (64-byte Ed25519 signatures, missing err, contradictory confirmationStatus)
 * 6. Traversal slot ordering and before-boundary violation rejection (Page 1 [5, 4] -> Page 2 [6, anchor])
 * 7. Duplicate signature consistency (rejecting conflicting metadata, preserving legitimate overlap)
 * 8. Missed-B Fixture ($A \rightarrow B \rightarrow C$) and multi-page pagination traversal
 * 9. Anchor-only quiet history and unreached boundaries (empty / short pages)
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

// Canonical Base58 fixture addresses (32 bytes public keys)
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

// Canonical 64-byte Ed25519 transaction signatures (decoding to exactly 64 bytes)
const SIG_A =
  "CeD7gRMFdZKnrBxCWczhvDmfAz4ke5NFKvqAi9jSwzCQReUhecVgBJb112WuuR9eVmzFDwMsQDWEa1WWhbF3aoB";
const SIG_B =
  "QHREMqhWG7eahNuQ2EzQqSYKLy8WH9jVerfLRJTttyPorHxQJDzMMcB1142poqJHzYyVSsijoS1U9222QBV6AbM";
const SIG_C =
  "bvdM3G3ktfyNYZrbXrz7kfJyWxCFvE6jynVW8TCLqxbDGwS6wqV2Xum115YjiFSwVKxjfp5cCeWhi2XY6mj8kPX";
const SIG_D =
  "oZqTigQ1XEJAPkoo3Uypft5dgwG1ZJTzJiKfqbvnnwnchauobSyhiDM1174ecfbaz6wytkSUbs1wH333oMyBLBh";
const SIG_E =
  "21D3aQ6kG9ncxEwkzZ6yXb6rHrvKmCNqEde9qYkfEjvz28EPWF4UNtWw118aZX5kEUswE7goM15XAr3YZVxDDuys";
const SIG_F =
  "2CrFh5X6WnLwk68iC4iyEWKcx2uPWqTCUxZz1FuPggvBRYssCtfy44pX11A6URVtsyevULdADQJ2QR445CYTGVn3";

class MockPageFetcher implements HistoryPageFetcher {
  public recordedQueries: HistoryPageQueryParams[] = [];
  public queuedPages: (
    | readonly HistorySignatureRecord[]
    | Error
    | Promise<readonly HistorySignatureRecord[]>
  )[] = [];
  public onBeforeFetch?: (() => void) | undefined;
  public lastReceivedSignal?: AbortSignal | undefined;

  public async fetchPage(
    params: HistoryPageQueryParams,
  ): Promise<readonly HistorySignatureRecord[]> {
    this.recordedQueries.push({ ...params });
    this.lastReceivedSignal = params.signal;
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
    if (next instanceof Promise) {
      return next;
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

  const createHelper = (optionsOverrides: Partial<ExactPoolHistoryEnumeratorOptions> = {}) => {
    return new ExactPoolHistoryEnumerator({
      poolContext: VALID_POOL_CONTEXT,
      knownAnchorSignature: SIG_A,
      pageFetcher: mockFetcher,
      budgetManager,
      clock,
      lifecycleTarget: mockLifecycle,
      pageSize: 10,
      operationDeadlineMs: 10_000,
      checkIntervalMs: 5,
      sleepFn: async (ms: number) => {
        fakeNow += ms;
      },
      ...optionsOverrides,
    });
  };

  beforeEach(() => {
    fakeNow = 1_000_000;
    budgetManager = new GlobalResourceBudgetManager({
      maxTotalRequests: 50,
      maxEnrichmentAttempts: 10,
      minReservedForwardRequests: 4,
      minProviderSpacingMs: 2500, // Standard 2500ms spacing enabled!
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

    it("rejects invalid knownAnchorSignature (32-byte pubkey or non-64-byte signature)", () => {
      // 32-byte public key is not a 64-byte signature
      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: CANONICAL_POOL_ID,
            pageFetcher: mockFetcher,
            budgetManager,
          }),
      ).toThrow(/\[ENUMERATOR_INIT\] knownAnchorSignature must be a valid 64-byte Solana Base58/);

      // Untrimmed or arbitrary string
      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: "ShortBadSig",
            pageFetcher: mockFetcher,
            budgetManager,
          }),
      ).toThrow(/\[ENUMERATOR_INIT\] knownAnchorSignature must be a valid 64-byte Solana Base58/);
    });

    it("rejects missing pageFetcher or missing budgetManager", () => {
      expect(
        () =>
          new ExactPoolHistoryEnumerator({
            poolContext: VALID_POOL_CONTEXT,
            knownAnchorSignature: SIG_A,
            pageFetcher: null as unknown as HistoryPageFetcher,
            budgetManager,
          }),
      ).toThrow(/\[ENUMERATOR_INIT\] pageFetcher is mandatory/);

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
  });

  describe("2. Shared Resource Identity & Pacing Waits (Area 1)", () => {
    it("shares the 'SOLANA_RPC' pacing bucket with the transaction source adapter", async () => {
      // Simulate request already dispatched under SOLANA_RPC at fakeNow
      budgetManager.recordRequestAttempt("SOLANA_RPC", "CANDIDATE_ENRICHMENT", fakeNow);

      // Verify that after 1,000ms (< 2500ms), default enumerator (without override) detects pacing wait
      fakeNow += 1000;
      let sleepCalledWithMs = 0;
      const enumerator = createHelper({
        sleepFn: async (ms: number) => {
          sleepCalledWithMs = ms;
          fakeNow += ms;
        },
      });

      mockFetcher.queuedPages = [
        [{ signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 }],
      ];

      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.anchorWitnessed).toBe(true);
      // Pacing wait of 1500ms was handled automatically
      expect(sleepCalledWithMs).toBe(1500);
      expect(budgetManager.getStats().totalRequests).toBe(2);
    });

    it("handles multi-page pagination pacing with standard 2500ms spacing using fake clocks", async () => {
      // Page 1: returns [E, D] (full page of size 2)
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      // Page 2: returns [C, A] (full page of size 2, anchor witnessed)
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1, page2];

      let sleepPacingCalls = 0;
      const enumerator = createHelper({
        pageSize: 2,
        maxPages: 5,
        sleepFn: async (ms: number) => {
          sleepPacingCalls++;
          fakeNow += ms;
        },
      });

      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.anchorWitnessed).toBe(true);
      expect(result.pagesQueried).toBe(2);
      expect(result.requestCount).toBe(2);
      expect(sleepPacingCalls).toBe(1); // Exactly 1 pacing wait of 2500ms between page 1 and page 2
      expect(result.discoveredSignatures.map((r) => r.signature)).toEqual([SIG_E, SIG_D, SIG_C]);
    });

    it("terminates with OPERATION_DEADLINE_EXCEEDED if pacing wait exceeds remaining deadline", async () => {
      // Prior request made at fakeNow
      budgetManager.recordRequestAttempt("SOLANA_RPC", "CANDIDATE_ENRICHMENT", fakeNow);

      // Only 500ms deadline, but pacing wait is 2500ms
      const enumerator = createHelper({
        operationDeadlineMs: 500,
      });

      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("OPERATION_DEADLINE_EXCEEDED");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.requestCount).toBe(0);
      expect(result.error).toMatch(/exceeds operation deadline/);
    });

    it("keeps genuine quota and reservation denials terminal", async () => {
      // Exhaust 10 enrichment attempts
      for (let i = 0; i < 10; i++) {
        fakeNow += 2500;
        budgetManager.recordRequestAttempt("SOLANA_RPC", "CANDIDATE_ENRICHMENT", fakeNow);
      }

      fakeNow += 2500;
      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("BUDGET_EXHAUSTED");
      expect(result.budgetDenialReason).toBe("MAX_ENRICHMENT_ATTEMPTS_REACHED");
      expect(result.requestCount).toBe(0);
    });
  });

  describe("3. In-Flight Deadlines & Cancellation Enforcement (Area 2)", () => {
    it("returns OPERATION_DEADLINE_EXCEEDED before stalled fetch completes (40ms deadline vs unresolved fetch)", async () => {
      // Stalled fetch that does not resolve
      const stalledFetchPromise = new Promise<readonly HistorySignatureRecord[]>(() => {
        // never resolves
      });
      mockFetcher.queuedPages = [stalledFetchPromise];

      const enumerator = createHelper({
        operationDeadlineMs: 40,
        checkIntervalMs: 5,
        clock: () => Date.now(), // Real wall-clock for timeout race
      });

      const start = Date.now();
      const result = await enumerator.enumerate();
      const elapsed = Date.now() - start;

      expect(result.outcome).toBe("OPERATION_DEADLINE_EXCEEDED");
      expect(result.anchorWitnessed).toBe(false);
      expect(elapsed).toBeLessThan(120); // Resolves promptly around 40ms, well before 150ms
      expect(mockFetcher.lastReceivedSignal?.aborted).toBe(true);
    });

    it("returns OPERATION_CANCELLED before stalled fetch completes when caller aborts signal", async () => {
      const abortController = new AbortController();
      const stalledFetchPromise = new Promise<readonly HistorySignatureRecord[]>(() => {});
      mockFetcher.queuedPages = [stalledFetchPromise];

      const enumerator = createHelper({
        signal: abortController.signal,
        operationDeadlineMs: 10_000,
        clock: () => Date.now(),
      });

      setTimeout(() => {
        abortController.abort(new Error("Caller cancelled"));
      }, 20);

      const start = Date.now();
      const result = await enumerator.enumerate();
      const elapsed = Date.now() - start;

      expect(result.outcome).toBe("OPERATION_CANCELLED");
      expect(result.anchorWitnessed).toBe(false);
      expect(elapsed).toBeLessThan(100);
      expect(mockFetcher.lastReceivedSignal?.aborted).toBe(true);
    });

    it("returns LIFECYCLE_CANCELLED before stalled fetch completes when coordinator disconnects", async () => {
      const stalledFetchPromise = new Promise<readonly HistorySignatureRecord[]>(() => {});
      mockFetcher.queuedPages = [stalledFetchPromise];

      const enumerator = createHelper({
        checkIntervalMs: 5,
        operationDeadlineMs: 10_000,
        clock: () => Date.now(),
      });

      setTimeout(() => {
        mockLifecycle.status = "DISCONNECTED";
      }, 15);

      const start = Date.now();
      const result = await enumerator.enumerate();
      const elapsed = Date.now() - start;

      expect(result.outcome).toBe("LIFECYCLE_CANCELLED");
      expect(result.anchorWitnessed).toBe(false);
      expect(elapsed).toBeLessThan(100);
      expect(mockFetcher.lastReceivedSignal?.aborted).toBe(true);
      expect(result.error).toMatch(/Coordinator status transitioned to DISCONNECTED/);
    });

    it("discards late response from stalled fetch without altering returned records", async () => {
      let lateResolve: ((records: readonly HistorySignatureRecord[]) => void) | undefined;
      const delayedPromise = new Promise<readonly HistorySignatureRecord[]>((resolve) => {
        lateResolve = resolve;
      });
      mockFetcher.queuedPages = [delayedPromise];

      const enumerator = createHelper({
        operationDeadlineMs: 40,
        clock: () => Date.now(),
      });

      const result = await enumerator.enumerate();
      expect(result.outcome).toBe("OPERATION_DEADLINE_EXCEEDED");
      expect(result.discoveredSignatures).toEqual([]);

      // Late resolution arrives AFTER enumerator finished
      if (lateResolve) {
        lateResolve([
          { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        ]);
      }
      expect(result.discoveredSignatures).toEqual([]);
    });
  });

  describe("4. Bounded Capacity & Immutable Deep-Freezing (Area 3)", () => {
    it("respects maxRetainedRecords=1 in failure result by checking capacity before insertion", async () => {
      // Page 1 has 2 records, but maxRetainedRecords is 1
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      mockFetcher.queuedPages = [page1];

      const enumerator = createHelper({
        pageSize: 2,
        maxRetainedRecords: 1,
      });

      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MAX_RECORDS_EXCEEDED");
      expect(result.anchorWitnessed).toBe(false);
      // Capacity bound strictly respected in failure result: exactly 1 record retained
      expect(result.discoveredSignatures).toHaveLength(1);
      expect(result.discoveredSignatures[0]?.signature).toBe(SIG_E);
    });

    it("rejects oversized pages exceeding requested pageSize fail-closed", async () => {
      // Requested pageSize = 2, but fetcher returned 3 records
      const oversizedPage: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
      ];
      mockFetcher.queuedPages = [oversizedPage];

      const enumerator = createHelper({ pageSize: 2 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/exceeding requested pageSize/);
    });

    it("deeply clones and freezes returned records against post-enumeration mutation", async () => {
      const mutableErr: Record<string, unknown> = {
        InstructionError: [0, { Custom: 101 }],
      };
      const mutableRecord: HistorySignatureRecord = {
        signature: SIG_C,
        slot: 102,
        err: mutableErr,
        memo: "Original Memo",
        blockTime: 1700000020,
      };
      const anchorRecord: HistorySignatureRecord = {
        signature: SIG_A,
        slot: 100,
        err: null,
        memo: null,
        blockTime: 1700000000,
      };

      mockFetcher.queuedPages = [[mutableRecord, anchorRecord]];

      const enumerator = createHelper({ pageSize: 10 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      const discovered = result.discoveredSignatures[0];
      expect(discovered).toBeDefined();

      // Mutate the source record and nested err object
      (mutableRecord as { slot: number }).slot = 999999;
      (mutableErr.InstructionError as unknown[])[0] = 999;

      // Returned record and nested err must remain completely unchanged!
      expect(discovered?.slot).toBe(102);
      expect(((discovered?.err as Record<string, unknown>).InstructionError as unknown[])[0]).toBe(
        0,
      );

      // Verify returned objects are frozen
      expect(Object.isFrozen(discovered)).toBe(true);
      expect(Object.isFrozen(discovered?.err)).toBe(true);
    });
  });

  describe("5. Record & Traversal Validation (Area 4)", () => {
    it("rejects record missing required 'err' property", async () => {
      const recordMissingErr = {
        signature: SIG_C,
        slot: 102,
        blockTime: 1700000020,
        // err property omitted
      };
      mockFetcher.queuedPages = [[recordMissingErr as unknown as HistorySignatureRecord]];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/missing required 'err' property/);
    });

    it("rejects record with confirmationStatus='processed' contradicting commitment 'confirmed'", async () => {
      const processedRecord: HistorySignatureRecord = {
        signature: SIG_C,
        slot: 102,
        err: null,
        confirmationStatus: "processed",
        blockTime: 1700000020,
      };
      mockFetcher.queuedPages = [[processedRecord]];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/contradicts requested commitment 'confirmed'/);
    });

    it("rejects traversal slot ordering inversion within a page (slot 4 followed by slot 5)", async () => {
      const invertedPage: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        { signature: SIG_B, slot: 105, err: null, memo: null, blockTime: 1700000050 }, // Newer slot after older!
      ];
      mockFetcher.queuedPages = [invertedPage];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/violated newest-first slot ordering/);
    });

    it("rejects across-page before-boundary violation (Page 1 [5, 4] followed by Page 2 [6, anchor])", async () => {
      // Page 1 ends at slot 104
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 105, err: null, memo: null, blockTime: 1700000050 },
        { signature: SIG_D, slot: 104, err: null, memo: null, blockTime: 1700000040 },
      ];
      // Page 2 erroneously returns a record from slot 106 (> 104)!
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 106, err: null, memo: null, blockTime: 1700000060 },
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1, page2];

      const enumerator = createHelper({ pageSize: 2 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(
        /violated before-boundary: newest record slot 106 exceeds previous page oldest slot 104/,
      );
    });

    it("rejects conflicting metadata for duplicate signatures while preserving identical overlap", async () => {
      // Page 1 contains SIG_D with slot 103
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      // Page 2 contains SIG_D with conflicting blockTime!
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1799999999 }, // Conflicting blockTime
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1, page2];

      const enumerator = createHelper({ pageSize: 2 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("MALFORMED_RECORD");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toMatch(/Conflicting metadata encountered for duplicate signature/);
    });

    it("preserves legitimate overlap when duplicate signatures share identical metadata", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
      ];
      // Page 2 overlaps on SIG_C with identical metadata
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
        { signature: SIG_B, slot: 101, err: null, memo: null, blockTime: 1700000010 },
        { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
      ];
      mockFetcher.queuedPages = [page1, page2];

      const enumerator = createHelper({ pageSize: 3 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_WITNESSED");
      expect(result.anchorWitnessed).toBe(true);
      expect(result.discoveredSignatures.map((r) => r.signature)).toEqual([
        SIG_E,
        SIG_D,
        SIG_C,
        SIG_B,
      ]);
    });
  });

  describe("6. Protocol Fixtures & Unreached Boundaries", () => {
    it("recovers missed B in A -> B -> C fixture, freezing C and witnessing anchor A", async () => {
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
      expect(result.discoveredSignatures.map((r) => r.signature)).toEqual([SIG_C, SIG_B]);
    });

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
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });

    it("returns ANCHOR_NOT_FOUND with anchorWitnessed=false on empty initial response", async () => {
      mockFetcher.queuedPages = [[]];

      const enumerator = createHelper({ pageSize: 10 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_NOT_FOUND");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.frozenTargetSignature).toBeNull();
      expect(result.discoveredSignatures).toEqual([]);
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });

    it("returns ANCHOR_NOT_FOUND with anchorWitnessed=false on short response without anchor", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_C, slot: 102, err: null, memo: null, blockTime: 1700000020 },
      ];
      mockFetcher.queuedPages = [page1];

      const enumerator = createHelper({ pageSize: 10 });
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("ANCHOR_NOT_FOUND");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.isProductionCompletenessEstablished).toBe(false);
    });

    it("returns NON_PROGRESSING_PAGE when subsequent page yields zero new signatures", async () => {
      const page1: HistorySignatureRecord[] = [
        { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
      ];
      // Page 2 repeats SIG_D at slot 103 (same slot <= 103, yielding zero new signatures)
      const page2: HistorySignatureRecord[] = [
        { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
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

    it("returns FETCH_ERROR when injected fetcher throws", async () => {
      mockFetcher.queuedPages = [new Error("Solana RPC 503 Service Unavailable")];

      const enumerator = createHelper();
      const result = await enumerator.enumerate();

      expect(result.outcome).toBe("FETCH_ERROR");
      expect(result.anchorWitnessed).toBe(false);
      expect(result.error).toBe("Solana RPC 503 Service Unavailable");
      expect(result.pagesQueried).toBe(1);
    });

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

    it("functional entrypoint enumerateExactPoolHistory returns identical result", async () => {
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
    });
  });

  describe("7. Signature Validation Helper", () => {
    it("strictly accepts 64-byte Solana signatures and rejects 32-byte public keys and invalid strings", () => {
      expect(isValidSolanaSignature(SIG_A)).toBe(true);
      expect(isValidSolanaSignature(SIG_B)).toBe(true);
      expect(isValidSolanaSignature(SIG_C)).toBe(true);
      expect(isValidSolanaSignature(SIG_F)).toBe(true);

      // Rejects 32-byte public keys
      expect(isValidSolanaSignature(CANONICAL_POOL_ID)).toBe(false);
      expect(isValidSolanaSignature(CANONICAL_TOKEN_MINT)).toBe(false);

      // Rejects empty, whitespace, short, or invalid chars
      expect(isValidSolanaSignature("")).toBe(false);
      expect(isValidSolanaSignature("   ")).toBe(false);
      expect(isValidSolanaSignature(` ${SIG_A} `)).toBe(false);
      expect(isValidSolanaSignature("NotBase58With0OIlSpecialChars!!!")).toBe(false);
      expect(isValidSolanaSignature(12345)).toBe(false);
      expect(isValidSolanaSignature(null)).toBe(false);

      // Rejects 128-character strings
      const longStr = "1".repeat(128);
      expect(isValidSolanaSignature(longStr)).toBe(false);
    });
  });

  describe("8. Independent Review Follow-up Regressions", () => {
    describe("Post-Await Validity Checks (Fast Responses)", () => {
      it("discards response and returns OPERATION_DEADLINE_EXCEEDED when fetch callback advances clock past deadline", async () => {
        fakeNow = 1_000_000;
        mockFetcher.onBeforeFetch = () => {
          fakeNow += 20_000; // Warp past 10,000ms deadline before returning
        };
        mockFetcher.queuedPages = [
          [{ signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 }],
        ];

        const enumerator = createHelper({ operationDeadlineMs: 10_000 });
        const result = await enumerator.enumerate();

        expect(result.outcome).toBe("OPERATION_DEADLINE_EXCEEDED");
        expect(result.anchorWitnessed).toBe(false);
        expect(result.discoveredSignatures).toEqual([]);
      });

      it("discards response and returns LIFECYCLE_CANCELLED when fetch callback disconnects coordinator", async () => {
        mockFetcher.onBeforeFetch = () => {
          mockLifecycle.status = "DISCONNECTED"; // Disconnect before returning
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

      it("discards response and returns OPERATION_CANCELLED when fetch callback sets isCancelled to true", async () => {
        let isCancelled = false;
        mockFetcher.onBeforeFetch = () => {
          isCancelled = true; // Cancel before returning
        };
        mockFetcher.queuedPages = [
          [{ signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 }],
        ];

        const enumerator = createHelper({ isCancelled: () => isCancelled });
        const result = await enumerator.enumerate();

        expect(result.outcome).toBe("OPERATION_CANCELLED");
        expect(result.anchorWitnessed).toBe(false);
        expect(result.discoveredSignatures).toEqual([]);
        expect(result.error).toMatch(/Operation cancelled by caller/);
      });

      it("discards response and returns LIFECYCLE_CANCELLED when fetch callback replaces transport epoch", async () => {
        mockFetcher.onBeforeFetch = () => {
          mockLifecycle.connectionEpoch = 2; // Increment epoch before returning
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

    describe("Pagination Control State Freezing", () => {
      it("preserves immutable slot boundary decision even when fetcher mutates prior page source record", async () => {
        const sourceRecSlot5: HistorySignatureRecord = {
          signature: SIG_E,
          slot: 5,
          err: null,
          memo: null,
          blockTime: 1700000050,
        };
        const sourceRecSlot4: HistorySignatureRecord = {
          signature: SIG_D,
          slot: 4,
          err: null,
          memo: null,
          blockTime: 1700000040,
        };

        const page1 = [sourceRecSlot5, sourceRecSlot4];
        // Page 2 erroneously sends slot 6 (> slot 4) followed by anchor
        const page2: HistorySignatureRecord[] = [
          { signature: SIG_C, slot: 6, err: null, memo: null, blockTime: 1700000060 },
          { signature: SIG_A, slot: 1, err: null, memo: null, blockTime: 1700000010 },
        ];
        mockFetcher.queuedPages = [page1, page2];

        const enumerator = createHelper({
          pageSize: 2,
          sleepFn: async (ms: number) => {
            fakeNow += ms;
            // Caller attempts to mutate the source record from page 1 to slot 999 during pacing wait!
            (sourceRecSlot4 as { slot: number }).slot = 999;
          },
        });

        const result = await enumerator.enumerate();

        // The boundary violation must STILL be caught because previousOldestRecord was snapshotted at slot 4
        expect(result.outcome).toBe("MALFORMED_RECORD");
        expect(result.anchorWitnessed).toBe(false);
        expect(result.error).toMatch(
          /violated before-boundary: newest record slot 6 exceeds previous page oldest slot 4/,
        );
      });
    });

    describe("Exception Containment (Synchronous Throws & Cyclic Metadata)", () => {
      it("contains synchronously thrown fetchPage error within FETCH_ERROR outcome", async () => {
        const syncThrowFetcher: HistoryPageFetcher = {
          fetchPage: () => {
            throw new Error("Immediate synchronous network failure");
          },
        };

        const enumerator = createHelper({ pageFetcher: syncThrowFetcher });
        const result = await enumerator.enumerate();

        expect(result.outcome).toBe("FETCH_ERROR");
        expect(result.anchorWitnessed).toBe(false);
        expect(result.error).toBe("Immediate synchronous network failure");
      });

      it("contains cyclic err metadata within MALFORMED_RECORD outcome without throwing", async () => {
        const cyclicErr: Record<string, unknown> = {};
        cyclicErr.self = cyclicErr;

        const cyclicRecord: HistorySignatureRecord = {
          signature: SIG_C,
          slot: 102,
          err: cyclicErr,
          blockTime: 1700000020,
        };
        mockFetcher.queuedPages = [[cyclicRecord]];

        const enumerator = createHelper();
        const result = await enumerator.enumerate();

        expect(result.outcome).toBe("MALFORMED_RECORD");
        expect(result.anchorWitnessed).toBe(false);
        expect(result.error).toMatch(/could not be serialized or cloned/);
      });

      it("contains duplicate signature with cyclic err metadata within MALFORMED_RECORD outcome", async () => {
        const page1: HistorySignatureRecord[] = [
          { signature: SIG_E, slot: 104, err: null, memo: null, blockTime: 1700000040 },
          { signature: SIG_D, slot: 103, err: null, memo: null, blockTime: 1700000030 },
        ];

        const cyclicErr: Record<string, unknown> = {};
        cyclicErr.self = cyclicErr;
        const page2: HistorySignatureRecord[] = [
          { signature: SIG_D, slot: 103, err: cyclicErr, memo: null, blockTime: 1700000030 },
          { signature: SIG_A, slot: 100, err: null, memo: null, blockTime: 1700000000 },
        ];
        mockFetcher.queuedPages = [page1, page2];

        const enumerator = createHelper({ pageSize: 2 });
        const result = await enumerator.enumerate();

        expect(result.outcome).toBe("MALFORMED_RECORD");
        expect(result.anchorWitnessed).toBe(false);
      });
    });

    describe("Nullable ConfirmationStatus Preservation", () => {
      it("preserves null confirmationStatus without string coercion in returned immutable records", async () => {
        mockFetcher.queuedPages = [
          [
            {
              signature: SIG_B,
              slot: 101,
              err: null,
              memo: null,
              blockTime: 1700000010,
              confirmationStatus: null,
            },
            {
              signature: SIG_A,
              slot: 100,
              err: null,
              memo: null,
              blockTime: 1700000000,
              confirmationStatus: "confirmed",
            },
          ],
        ];

        const enumerator = createHelper();
        const result = await enumerator.enumerate();

        expect(result.outcome).toBe("ANCHOR_WITNESSED");
        expect(result.anchorWitnessed).toBe(true);
        expect(result.candidatePoolId).toBe(CANONICAL_POOL_ID);
        expect(result.connectionEpoch).toBe(1);
        expect(result.discoveredSignatures).toHaveLength(1);
        expect(result.discoveredSignatures[0]?.signature).toBe(SIG_B);
        expect(result.discoveredSignatures[0]?.confirmationStatus).toBeNull();
        expect(result.discoveredSignatures[0]?.confirmationStatus).not.toBe("null");
      });

      it("handles overlapping pages containing identical null-status records without duplicate conflict", async () => {
        const page1: HistorySignatureRecord[] = [
          {
            signature: SIG_C,
            slot: 102,
            err: null,
            memo: null,
            blockTime: 1700000020,
            confirmationStatus: null,
          },
          {
            signature: SIG_B,
            slot: 101,
            err: null,
            memo: null,
            blockTime: 1700000010,
            confirmationStatus: null,
          },
        ];
        const page2: HistorySignatureRecord[] = [
          {
            signature: SIG_B,
            slot: 101,
            err: null,
            memo: null,
            blockTime: 1700000010,
            confirmationStatus: null,
          },
          {
            signature: SIG_A,
            slot: 100,
            err: null,
            memo: null,
            blockTime: 1700000000,
            confirmationStatus: null,
          },
        ];
        mockFetcher.queuedPages = [page1, page2];

        const enumerator = createHelper({ pageSize: 2 });
        const result = await enumerator.enumerate();

        expect(result.outcome).toBe("ANCHOR_WITNESSED");
        expect(result.anchorWitnessed).toBe(true);
        expect(result.discoveredSignatures).toHaveLength(2);
        expect(result.discoveredSignatures[0]?.signature).toBe(SIG_C);
        expect(result.discoveredSignatures[0]?.confirmationStatus).toBeNull();
        expect(result.discoveredSignatures[1]?.signature).toBe(SIG_B);
        expect(result.discoveredSignatures[1]?.confirmationStatus).toBeNull();
      });
    });
  });
});
