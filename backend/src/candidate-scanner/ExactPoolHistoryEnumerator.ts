/**
 * Phase 12.94-D Milestone D.3.3: Bounded Exact-Pool History Enumerator
 *
 * Implements an isolated, offline-tested history enumeration helper that discovers
 * transaction signatures between witnessed on-chain boundaries for a single validated
 * Raydium candidate pool.
 *
 * SCOPE & CONTRACT INVARIANTS:
 * 1. Scope: Discovers transaction signatures between witnessed boundaries only.
 *    Transaction retrieval (getTransaction) and swap ingestion (RollingTradeFlowTracker.ingestTrade)
 *    remain strictly separate future integration work.
 * 2. Exact Candidate Binding: Bound exclusively to one validated TrackedRaydiumPoolContext.
 *    Validates pool address, token mints, vaults, and orientations via validateTrackedPoolContext.
 * 3. Injected Page Fetcher: Requires an injected HistoryPageFetcher; zero default networking.
 * 4. Strict CANDIDATE_ENRICHMENT Accounting:
 *    - Accounts all history page queries strictly under CANDIDATE_ENRICHMENT with the shared
 *      GlobalResourceBudgetManager.
 *    - Enforces existing enrichment cap (maxEnrichmentAttempts = 10), global session ceiling,
 *      reserved forward quote capacity (minReservedForwardRequests = 4), and provider pacing (>= 2500ms).
 *    - Prohibits purpose switching (no attempting to re-classify as RETRY or FORWARD_OBSERVATION).
 *    - No automatic budget resets and zero unbudgeted retries.
 * 5. Frozen Target:
 *    - Head signature of the first RPC history page is frozen as candidate target.
 *    - WebSocket notification hints never establish the target alone.
 * 6. Positive Boundary Evidence:
 *    - Traverses backward with `before` until the known anchor signature actually appears in returned records.
 *    - Empty or short pages without the anchor remain unresolved (anchorWitnessed = false).
 * 7. Lifecycle & Epoch Cancellation:
 *    - Validates coordinator lifecycle status and connectionEpoch before dispatch and after await.
 *    - If status is no longer SUBSCRIBED or connectionEpoch changes, in-flight results are discarded immediately.
 * 8. Return Contract:
 *    - Returns immutable HistoryEnumerationResult with anchorWitnessed, frozenTargetSignature,
 *      discoveredSignatures, requestCount, pagesQueried, typed outcome, and permanently:
 *      isProductionCompletenessEstablished = false.
 *    - Does NOT advance verified watermark cursor, clear tracker gaps, or enable production retest inputs.
 */

import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import type { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { SubscriptionCoordinatorStatus } from "./RaydiumCandidateSubscriptionCoordinator.js";

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Validates whether a given value is a canonical Base58 Solana transaction signature string.
 */
export function isValidSolanaSignature(sig: unknown): sig is string {
  if (typeof sig !== "string") return false;
  const trimmed = sig.trim();
  return trimmed.length >= 32 && trimmed.length <= 128 && BASE58_REGEX.test(trimmed);
}

/**
 * Normalized transaction signature record from Solana getSignaturesForAddress RPC.
 */
export interface HistorySignatureRecord {
  readonly signature: string;
  readonly slot: number;
  readonly err: unknown | null;
  readonly memo?: string | null | undefined;
  readonly blockTime: number | null;
  readonly confirmationStatus?: string | undefined;
}

/**
 * Query parameters dispatched to the injected history page fetcher.
 */
export interface HistoryPageQueryParams {
  readonly address: string;
  readonly limit: number;
  readonly before?: string | undefined;
  readonly commitment?: "confirmed" | "finalized" | undefined;
}

/**
 * Injected transport contract for fetching history pages. Zero default networking.
 */
export interface HistoryPageFetcher {
  fetchPage(params: HistoryPageQueryParams): Promise<readonly HistorySignatureRecord[]>;
}

/**
 * Functional interface for page fetching.
 */
export type HistoryPageFetcherFn = (
  params: HistoryPageQueryParams,
) => Promise<readonly HistorySignatureRecord[]>;

/**
 * Typed outcomes of an exact-pool history enumeration run.
 */
export type HistoryEnumerationOutcome =
  | "ANCHOR_WITNESSED"
  | "ANCHOR_NOT_FOUND"
  | "MAX_PAGES_EXHAUSTED"
  | "MAX_RECORDS_EXCEEDED"
  | "NON_PROGRESSING_PAGE"
  | "LIFECYCLE_CANCELLED"
  | "OPERATION_CANCELLED"
  | "OPERATION_DEADLINE_EXCEEDED"
  | "BUDGET_EXHAUSTED"
  | "MALFORMED_RECORD"
  | "FETCH_ERROR";

/**
 * Lifecycle target providing subscription coordinator status and connection epoch telemetry.
 */
export interface EnumerationLifecycleTarget {
  getStatus(): SubscriptionCoordinatorStatus | string;
  getConnectionEpoch(): number;
}

/**
 * Configuration options for ExactPoolHistoryEnumerator.
 */
export interface ExactPoolHistoryEnumeratorOptions {
  readonly poolContext: TrackedRaydiumPoolContext;
  readonly knownAnchorSignature: string;
  readonly pageFetcher: HistoryPageFetcher | HistoryPageFetcherFn;
  readonly budgetManager: GlobalResourceBudgetManager;
  readonly providerName?: string | undefined;
  readonly clock?: (() => number) | undefined;
  readonly pageSize?: number | undefined;
  readonly maxPages?: number | undefined;
  readonly maxRetainedRecords?: number | undefined;
  readonly operationDeadlineMs?: number | undefined;
  readonly lifecycleTarget?: EnumerationLifecycleTarget | undefined;
  readonly dispatchEpoch?: number | undefined;
  readonly isCancelled?: (() => boolean) | undefined;
}

/**
 * Evidence-only result contract for exact-pool history enumeration.
 * Note: isProductionCompletenessEstablished is permanently literal `false`.
 */
export interface HistoryEnumerationResult {
  readonly outcome: HistoryEnumerationOutcome;
  readonly anchorWitnessed: boolean;
  readonly knownAnchorSignature: string;
  readonly frozenTargetSignature: string | null;
  readonly discoveredSignatures: readonly HistorySignatureRecord[];
  readonly pagesQueried: number;
  readonly requestCount: number;
  readonly isProductionCompletenessEstablished: false;
  readonly error?: string | undefined;
  readonly budgetDenialReason?: string | undefined;
}

/**
 * Isolated exact-pool history enumerator helper.
 */
export class ExactPoolHistoryEnumerator {
  private readonly poolContext: TrackedRaydiumPoolContext;
  private readonly knownAnchorSignature: string;
  private readonly pageFetcher: HistoryPageFetcher;
  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly providerName: string;
  private readonly clock: () => number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRetainedRecords: number;
  private readonly operationDeadlineMs: number;
  private readonly lifecycleTarget?: EnumerationLifecycleTarget | undefined;
  private readonly dispatchEpoch?: number | undefined;
  private readonly isCancelled?: (() => boolean) | undefined;

  constructor(options: ExactPoolHistoryEnumeratorOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("[ENUMERATOR_INIT] Options object is required");
    }

    validateTrackedPoolContext(options.poolContext);
    this.poolContext = Object.freeze({ ...options.poolContext });

    if (!isValidSolanaSignature(options.knownAnchorSignature)) {
      throw new Error(
        `[ENUMERATOR_INIT] knownAnchorSignature must be a valid Solana Base58 signature string`,
      );
    }
    this.knownAnchorSignature = options.knownAnchorSignature.trim();

    if (!options.pageFetcher) {
      throw new Error(
        `[ENUMERATOR_INIT] pageFetcher is mandatory; zero default networking allowed`,
      );
    }
    if (typeof options.pageFetcher === "function") {
      this.pageFetcher = { fetchPage: options.pageFetcher };
    } else if (typeof options.pageFetcher.fetchPage === "function") {
      this.pageFetcher = options.pageFetcher;
    } else {
      throw new Error(`[ENUMERATOR_INIT] pageFetcher must provide a fetchPage function`);
    }

    if (
      !options.budgetManager ||
      typeof options.budgetManager.canMakeRequest !== "function" ||
      typeof options.budgetManager.recordRequestAttempt !== "function"
    ) {
      throw new Error(
        `[ENUMERATOR_INIT] budgetManager must be a valid GlobalResourceBudgetManager instance`,
      );
    }
    this.budgetManager = options.budgetManager;

    const ps = options.pageSize ?? 20;
    if (!Number.isInteger(ps) || ps < 1 || ps > 100) {
      throw new Error(`[ENUMERATOR_INIT] pageSize must be an integer between 1 and 100`);
    }
    this.pageSize = ps;

    const mp = options.maxPages ?? 5;
    if (!Number.isInteger(mp) || mp < 1 || mp > 50) {
      throw new Error(`[ENUMERATOR_INIT] maxPages must be an integer between 1 and 50`);
    }
    this.maxPages = mp;

    const mr = options.maxRetainedRecords ?? 50;
    if (!Number.isInteger(mr) || mr < 1 || mr > 500) {
      throw new Error(`[ENUMERATOR_INIT] maxRetainedRecords must be an integer between 1 and 500`);
    }
    this.maxRetainedRecords = mr;

    const od = options.operationDeadlineMs ?? 10_000;
    if (typeof od !== "number" || !Number.isFinite(od) || od <= 0) {
      throw new Error(`[ENUMERATOR_INIT] operationDeadlineMs must be a positive finite number`);
    }
    this.operationDeadlineMs = od;

    this.providerName = (options.providerName && options.providerName.trim()) || "solana-rpc";
    this.clock = options.clock ?? (() => Date.now());
    this.lifecycleTarget = options.lifecycleTarget;
    this.dispatchEpoch = options.dispatchEpoch;
    this.isCancelled = options.isCancelled;
  }

  /**
   * Executes bounded history enumeration discovering signatures between witnessed boundaries.
   */
  public async enumerate(): Promise<HistoryEnumerationResult> {
    const startTime = this.clock();
    const deadlineMs = startTime + this.operationDeadlineMs;
    const expectedEpoch =
      this.dispatchEpoch ?? (this.lifecycleTarget ? this.lifecycleTarget.getConnectionEpoch() : 0);

    let frozenTargetSignature: string | null = null;
    const accumulatedRecords: HistorySignatureRecord[] = [];
    const seenSignatures = new Set<string>();
    let cursorBefore: string | undefined = undefined;
    let pagesQueried = 0;
    let requestCount = 0;

    const createFailureResult = (
      outcome: HistoryEnumerationOutcome,
      errorMsg?: string,
      budgetReason?: string,
    ): HistoryEnumerationResult => {
      return Object.freeze({
        outcome,
        anchorWitnessed: false,
        knownAnchorSignature: this.knownAnchorSignature,
        frozenTargetSignature,
        discoveredSignatures: Object.freeze([...accumulatedRecords]),
        pagesQueried,
        requestCount,
        isProductionCompletenessEstablished: false,
        ...(errorMsg ? { error: errorMsg } : {}),
        ...(budgetReason ? { budgetDenialReason: budgetReason } : {}),
      });
    };

    while (true) {
      // 1. Pre-dispatch cancellation check
      if (this.isCancelled?.()) {
        return createFailureResult("OPERATION_CANCELLED", "Operation cancelled by caller");
      }

      // 2. Pre-dispatch deadline check
      const preNow = this.clock();
      if (preNow >= deadlineMs) {
        return createFailureResult(
          "OPERATION_DEADLINE_EXCEEDED",
          `Operation deadline exceeded (${this.operationDeadlineMs}ms)`,
        );
      }

      // 3. Pre-dispatch lifecycle and epoch check
      if (this.lifecycleTarget) {
        const currentStatus = this.lifecycleTarget.getStatus();
        if (currentStatus !== "SUBSCRIBED") {
          return createFailureResult(
            "LIFECYCLE_CANCELLED",
            `Coordinator is no longer SUBSCRIBED (current: ${currentStatus})`,
          );
        }
        const currentEpoch = this.lifecycleTarget.getConnectionEpoch();
        if (currentEpoch !== expectedEpoch) {
          return createFailureResult(
            "LIFECYCLE_CANCELLED",
            `Coordinator epoch changed (expected: ${expectedEpoch}, current: ${currentEpoch})`,
          );
        }
      }

      // 4. Pre-dispatch budget admission check under CANDIDATE_ENRICHMENT
      const budgetCheck = this.budgetManager.canMakeRequest(
        this.providerName,
        preNow,
        "CANDIDATE_ENRICHMENT",
      );
      if (!budgetCheck.allowed) {
        return createFailureResult(
          "BUDGET_EXHAUSTED",
          budgetCheck.reason ?? "BUDGET_DENIED",
          budgetCheck.reason,
        );
      }

      // 5. Record attempt in shared budget manager
      const recorded = this.budgetManager.recordRequestAttempt(
        this.providerName,
        "CANDIDATE_ENRICHMENT",
        preNow,
      );
      if (!recorded) {
        return createFailureResult(
          "BUDGET_EXHAUSTED",
          "RECORD_ATTEMPT_DENIED",
          "RECORD_ATTEMPT_DENIED",
        );
      }
      requestCount++;

      // 6. Dispatch page fetch via injected transport
      let rawRecords: readonly HistorySignatureRecord[];
      try {
        rawRecords = await this.pageFetcher.fetchPage({
          address: this.poolContext.poolId,
          limit: this.pageSize,
          before: cursorBefore,
          commitment: "confirmed",
        });
      } catch (err: unknown) {
        pagesQueried++;
        return createFailureResult("FETCH_ERROR", err instanceof Error ? err.message : String(err));
      }
      pagesQueried++;

      // 7. Post-await cancellation check
      if (this.isCancelled?.()) {
        return createFailureResult("OPERATION_CANCELLED", "Operation cancelled by caller");
      }

      // 8. Post-await deadline check
      const postNow = this.clock();
      if (postNow >= deadlineMs) {
        return createFailureResult(
          "OPERATION_DEADLINE_EXCEEDED",
          `Operation deadline exceeded (${this.operationDeadlineMs}ms)`,
        );
      }

      // 9. Post-await lifecycle check: discard results if transport dropped or epoch changed during await
      if (this.lifecycleTarget) {
        const postStatus = this.lifecycleTarget.getStatus();
        if (postStatus !== "SUBSCRIBED") {
          return createFailureResult(
            "LIFECYCLE_CANCELLED",
            `Coordinator status transitioned to ${postStatus} during in-flight RPC await; results discarded`,
          );
        }
        const postEpoch = this.lifecycleTarget.getConnectionEpoch();
        if (postEpoch !== expectedEpoch) {
          return createFailureResult(
            "LIFECYCLE_CANCELLED",
            `Coordinator epoch changed to ${postEpoch} (expected: ${expectedEpoch}) during in-flight RPC await; results discarded`,
          );
        }
      }

      // 10. Record integrity validation
      if (!Array.isArray(rawRecords)) {
        return createFailureResult("MALFORMED_RECORD", "RPC history page response is not an array");
      }

      for (let i = 0; i < rawRecords.length; i++) {
        const rec = rawRecords[i];
        if (!rec || typeof rec !== "object") {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} is not a valid object`,
          );
        }
        if (!isValidSolanaSignature(rec.signature)) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} has invalid Base58 signature: ${String(rec.signature)}`,
          );
        }
        if (typeof rec.slot !== "number" || !Number.isInteger(rec.slot) || rec.slot < 0) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} has invalid non-negative integer slot: ${String(rec.slot)}`,
          );
        }
        if (
          rec.blockTime !== null &&
          (typeof rec.blockTime !== "number" ||
            !Number.isInteger(rec.blockTime) ||
            rec.blockTime <= 0)
        ) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} has invalid blockTime: ${String(rec.blockTime)}`,
          );
        }
      }

      // 11. Target freezing: freeze newest signature from head of page 1
      if (pagesQueried === 1) {
        if (rawRecords.length === 0) {
          // Empty page on initial query: anchor unreached and unverified
          return createFailureResult(
            "ANCHOR_NOT_FOUND",
            "Initial history query returned zero records; anchor unobserved",
          );
        }
        frozenTargetSignature = rawRecords[0].signature;
      }

      // 12. Boundary continuity check: look for known anchor signature in current page
      const anchorIndex = rawRecords.findIndex((r) => r.signature === this.knownAnchorSignature);

      if (anchorIndex !== -1) {
        // Positive boundary established!
        // Sift records strictly newer than anchor (before anchorIndex in page)
        const newDiscovered = rawRecords.slice(0, anchorIndex);
        for (const r of newDiscovered) {
          if (!seenSignatures.has(r.signature)) {
            seenSignatures.add(r.signature);
            accumulatedRecords.push(r);
          }
        }

        if (accumulatedRecords.length > this.maxRetainedRecords) {
          return createFailureResult(
            "MAX_RECORDS_EXCEEDED",
            `Retained records (${accumulatedRecords.length}) exceeded maximum limit (${this.maxRetainedRecords})`,
          );
        }

        return Object.freeze({
          outcome: "ANCHOR_WITNESSED",
          anchorWitnessed: true,
          knownAnchorSignature: this.knownAnchorSignature,
          frozenTargetSignature,
          discoveredSignatures: Object.freeze([...accumulatedRecords]),
          pagesQueried,
          requestCount,
          isProductionCompletenessEstablished: false,
        });
      }

      // Anchor was not found in this page
      // Check if page was short (< pageSize)
      if (rawRecords.length < this.pageSize) {
        return createFailureResult(
          "ANCHOR_NOT_FOUND",
          `Page ${pagesQueried} returned ${rawRecords.length} records (< ${this.pageSize}) without reaching anchor`,
        );
      }

      // Page was full (=== pageSize). Verify progress and buffer records
      const oldestSig = rawRecords[rawRecords.length - 1].signature;
      let newlyAdded = 0;
      for (const r of rawRecords) {
        if (!seenSignatures.has(r.signature)) {
          seenSignatures.add(r.signature);
          accumulatedRecords.push(r);
          newlyAdded++;
        }
      }

      if (newlyAdded === 0 || cursorBefore === oldestSig) {
        return createFailureResult(
          "NON_PROGRESSING_PAGE",
          `Page ${pagesQueried} produced zero new signatures or repeated previous oldest signature`,
        );
      }

      if (accumulatedRecords.length > this.maxRetainedRecords) {
        return createFailureResult(
          "MAX_RECORDS_EXCEEDED",
          `Retained records (${accumulatedRecords.length}) exceeded maximum limit (${this.maxRetainedRecords})`,
        );
      }

      if (pagesQueried >= this.maxPages) {
        return createFailureResult(
          "MAX_PAGES_EXHAUSTED",
          `Pagination reached maxPages limit (${this.maxPages}) without encountering anchor`,
        );
      }

      // Advance backward pagination cursor
      cursorBefore = oldestSig;
    }
  }
}

/**
 * Functional entrypoint for exact-pool history enumeration.
 */
export async function enumerateExactPoolHistory(
  options: ExactPoolHistoryEnumeratorOptions,
): Promise<HistoryEnumerationResult> {
  const enumerator = new ExactPoolHistoryEnumerator(options);
  return enumerator.enumerate();
}
