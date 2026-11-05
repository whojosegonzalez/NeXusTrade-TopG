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
 * 3. Injected Transport Contract: Requires an injected HistoryPageFetcher; zero default networking.
 * 4. Shared Resource Identity & Pacing:
 *    - Defaults to providerName="SOLANA_RPC" matching RaydiumAmmV4TransactionSourceAdapter.
 *    - Accounts all history queries strictly under CANDIDATE_ENRICHMENT with GlobalResourceBudgetManager.
 *    - Automatically handles recoverable pacing waits (PROVIDER_PACING_NOT_MET) within the operation
 *      deadline, re-checking admission after waiting. Quota and reservation denials remain terminal.
 *    - Zero retries, no purpose switching, and no automatic budget resets.
 * 5. In-Flight Cancellation & Deadline Enforcement:
 *    - Races in-flight fetch requests against operation deadlines, caller cancellation signals,
 *      cancellation callbacks, and coordinator lifecycle transitions.
 *    - Propagates cancellation to cooperative fetchers via AbortSignal.
 *    - Discards stale/late fetch responses immediately, ensuring they cannot alter retained records.
 *    - Cleans up timers and event listeners in all code paths.
 * 6. Frozen Target & Positive Boundary Evidence:
 *    - Head signature of the first RPC history page is frozen as candidate target.
 *    - Traverses backward with `before` requiring actual anchor appearance in returned records.
 *    - Rejects pages exceeding requested pageSize, newest-first ordering inversions, and before-boundary violations.
 *    - Validates canonical 64-byte Ed25519 signatures, documented RPC fields, and commitment consistency.
 * 7. Bounded Retention & Immutable Deep-Freezing:
 *    - Enforces maxRetainedRecords capacity before record insertion; failure results respect bounds.
 *    - Clones and deeply freezes all retained records upon receipt to prevent external mutation.
 * 8. Return Contract:
 *    - Returns immutable HistoryEnumerationResult with anchorWitnessed, frozenTargetSignature,
 *      discoveredSignatures, requestCount, pagesQueried, typed outcome, and permanently:
 *      isProductionCompletenessEstablished = false.
 */

import {
  type TrackedRaydiumPoolContext,
  validateTrackedPoolContext,
} from "./RaydiumAmmV4SwapDecoder.js";
import { decodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import type { GlobalResourceBudgetManager } from "../research/prospective/GlobalResourceBudgetManager.js";
import type { SubscriptionCoordinatorStatus } from "./RaydiumCandidateSubscriptionCoordinator.js";

const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Validates whether a given value is a canonical Base58 Solana transaction signature string,
 * strictly verifying that it decodes to exactly 64 bytes.
 */
export function isValidSolanaSignature(sig: unknown): sig is string {
  if (typeof sig !== "string") return false;
  const trimmed = sig.trim();
  if (trimmed !== sig || trimmed.length === 0) return false;
  if (!BASE58_REGEX.test(trimmed)) return false;
  try {
    const bytes = decodeBase58(trimmed);
    return bytes.length === 64;
  } catch {
    return false;
  }
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
  readonly signal?: AbortSignal | undefined;
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
  readonly providerName?: string | undefined; // default: "SOLANA_RPC"
  readonly clock?: (() => number) | undefined;
  readonly pageSize?: number | undefined; // default: 20
  readonly maxPages?: number | undefined; // default: 5
  readonly maxRetainedRecords?: number | undefined; // default: 50
  readonly operationDeadlineMs?: number | undefined; // default: 10,000 ms
  readonly lifecycleTarget?: EnumerationLifecycleTarget | undefined;
  readonly dispatchEpoch?: number | undefined;
  readonly isCancelled?: (() => boolean) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly sleepFn?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly checkIntervalMs?: number | undefined; // default: 5 ms
  readonly commitment?: "confirmed" | "finalized" | undefined; // default: "confirmed"
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
 * Deep freezes an object and its nested properties.
 */
function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (
      val !== null &&
      (typeof val === "object" || typeof val === "function") &&
      !Object.isFrozen(val)
    ) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Clones and deeply freezes a signature record so external mutations cannot alter retained data.
 */
function cloneAndDeepFreezeRecord(rec: HistorySignatureRecord): Readonly<HistorySignatureRecord> {
  const clonedErr =
    rec.err !== null && typeof rec.err === "object" ? JSON.parse(JSON.stringify(rec.err)) : rec.err;

  const cloned: HistorySignatureRecord = {
    signature: rec.signature,
    slot: rec.slot,
    err: clonedErr,
    memo: rec.memo !== undefined ? rec.memo : null,
    blockTime: rec.blockTime,
    ...(rec.confirmationStatus !== undefined ? { confirmationStatus: rec.confirmationStatus } : {}),
  };

  return deepFreeze(cloned);
}

interface InFlightRaceResult {
  readonly outcome:
    | "SUCCESS"
    | "FETCH_ERROR"
    | "OPERATION_DEADLINE_EXCEEDED"
    | "OPERATION_CANCELLED"
    | "LIFECYCLE_CANCELLED";
  readonly records?: readonly HistorySignatureRecord[];
  readonly error?: unknown;
  readonly message?: string;
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
  private readonly signal?: AbortSignal | undefined;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly checkIntervalMs: number;
  private readonly commitment: "confirmed" | "finalized";

  constructor(options: ExactPoolHistoryEnumeratorOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("[ENUMERATOR_INIT] Options object is required");
    }

    validateTrackedPoolContext(options.poolContext);
    this.poolContext = deepFreeze({ ...options.poolContext });

    if (!isValidSolanaSignature(options.knownAnchorSignature)) {
      throw new Error(
        `[ENUMERATOR_INIT] knownAnchorSignature must be a valid 64-byte Solana Base58 signature string`,
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

    // Use SOLANA_RPC as canonical shared provider identity matching transaction source adapter
    this.providerName = (options.providerName && options.providerName.trim()) || "SOLANA_RPC";
    this.clock = options.clock ?? (() => Date.now());
    this.lifecycleTarget = options.lifecycleTarget;
    this.dispatchEpoch = options.dispatchEpoch;
    this.isCancelled = options.isCancelled;
    this.signal = options.signal;
    this.checkIntervalMs = options.checkIntervalMs ?? 5;
    this.commitment = options.commitment ?? "confirmed";

    this.sleepFn =
      options.sleepFn ??
      (async (ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
            resolve();
          }, ms);
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        });
      });
  }

  /**
   * Races a pacing wait against operation deadline, caller signal, and coordinator lifecycle.
   */
  private async waitForPacing(
    waitMs: number,
    deadlineMs: number,
    expectedEpoch: number,
  ): Promise<{
    ok: boolean;
    outcome?: HistoryEnumerationOutcome;
    error?: string;
    budgetReason?: string;
  }> {
    const waitAbortController = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let callerAbortHandler: (() => void) | undefined;
    let isSettled = false;

    try {
      return await new Promise<{
        ok: boolean;
        outcome?: HistoryEnumerationOutcome;
        error?: string;
        budgetReason?: string;
      }>((resolve) => {
        const remainingDeadline = Math.max(0, deadlineMs - this.clock());

        if (waitMs >= remainingDeadline) {
          deadlineTimer = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            waitAbortController.abort();
            resolve({
              ok: false,
              outcome: "OPERATION_DEADLINE_EXCEEDED",
              error: `Pacing wait of ${waitMs}ms exceeded operation deadline (${this.operationDeadlineMs}ms)`,
            });
          }, remainingDeadline);
        }

        if (this.signal) {
          if (this.signal.aborted) {
            isSettled = true;
            waitAbortController.abort();
            resolve({
              ok: false,
              outcome: "OPERATION_CANCELLED",
              error: "Operation cancelled by caller during pacing wait",
            });
            return;
          }
          callerAbortHandler = () => {
            if (isSettled) return;
            isSettled = true;
            waitAbortController.abort();
            resolve({
              ok: false,
              outcome: "OPERATION_CANCELLED",
              error: "Operation cancelled by caller during pacing wait",
            });
          };
          this.signal.addEventListener("abort", callerAbortHandler, { once: true });
        }

        pollTimer = setInterval(() => {
          if (isSettled) return;

          if (this.clock() >= deadlineMs) {
            isSettled = true;
            waitAbortController.abort();
            resolve({
              ok: false,
              outcome: "OPERATION_DEADLINE_EXCEEDED",
              error: `Operation deadline exceeded (${this.operationDeadlineMs}ms) during pacing wait`,
            });
            return;
          }

          if (this.isCancelled?.()) {
            isSettled = true;
            waitAbortController.abort();
            resolve({
              ok: false,
              outcome: "OPERATION_CANCELLED",
              error: "Operation cancelled by caller during pacing wait",
            });
            return;
          }

          if (this.lifecycleTarget) {
            const currentStatus = this.lifecycleTarget.getStatus();
            if (currentStatus !== "SUBSCRIBED") {
              isSettled = true;
              waitAbortController.abort();
              resolve({
                ok: false,
                outcome: "LIFECYCLE_CANCELLED",
                error: `Coordinator status changed to ${currentStatus} during pacing wait`,
              });
              return;
            }
            const currentEpoch = this.lifecycleTarget.getConnectionEpoch();
            if (currentEpoch !== expectedEpoch) {
              isSettled = true;
              waitAbortController.abort();
              resolve({
                ok: false,
                outcome: "LIFECYCLE_CANCELLED",
                error: `Coordinator epoch changed to ${currentEpoch} during pacing wait`,
              });
              return;
            }
          }
        }, this.checkIntervalMs);

        this.sleepFn(waitMs, waitAbortController.signal)
          .then(() => {
            if (isSettled) return;
            isSettled = true;
            resolve({ ok: true });
          })
          .catch((err: unknown) => {
            if (isSettled) return;
            isSettled = true;
            resolve({
              ok: false,
              outcome: "OPERATION_CANCELLED",
              error: err instanceof Error ? err.message : String(err),
            });
          });
      });
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (callerAbortHandler && this.signal) {
        this.signal.removeEventListener("abort", callerAbortHandler);
      }
    }
  }

  /**
   * Dispatches fetchPage racing against operation deadline, caller signal, and coordinator lifecycle.
   */
  private async raceFetchPage(
    cursorBefore: string | undefined,
    deadlineMs: number,
    expectedEpoch: number,
  ): Promise<InFlightRaceResult> {
    const fetchAbortController = new AbortController();
    let isSettled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let callerAbortHandler: (() => void) | undefined;

    try {
      return await new Promise<InFlightRaceResult>((resolve) => {
        const remainingDeadline = Math.max(0, deadlineMs - this.clock());

        deadlineTimer = setTimeout(() => {
          if (isSettled) return;
          isSettled = true;
          fetchAbortController.abort(new Error("OPERATION_DEADLINE_EXCEEDED"));
          resolve({
            outcome: "OPERATION_DEADLINE_EXCEEDED",
            message: `Operation deadline exceeded (${this.operationDeadlineMs}ms) while awaiting fetch`,
          });
        }, remainingDeadline);

        if (this.signal) {
          if (this.signal.aborted) {
            isSettled = true;
            fetchAbortController.abort(this.signal.reason);
            resolve({
              outcome: "OPERATION_CANCELLED",
              message: "Operation cancelled by caller",
            });
            return;
          }
          callerAbortHandler = () => {
            if (isSettled) return;
            isSettled = true;
            fetchAbortController.abort(this.signal?.reason);
            resolve({
              outcome: "OPERATION_CANCELLED",
              message: "Operation cancelled by caller signal",
            });
          };
          this.signal.addEventListener("abort", callerAbortHandler, { once: true });
        }

        pollTimer = setInterval(() => {
          if (isSettled) return;

          if (this.clock() >= deadlineMs) {
            isSettled = true;
            fetchAbortController.abort(new Error("OPERATION_DEADLINE_EXCEEDED"));
            resolve({
              outcome: "OPERATION_DEADLINE_EXCEEDED",
              message: `Operation deadline exceeded (${this.operationDeadlineMs}ms) while awaiting fetch`,
            });
            return;
          }

          if (this.isCancelled?.()) {
            isSettled = true;
            fetchAbortController.abort(new Error("OPERATION_CANCELLED"));
            resolve({
              outcome: "OPERATION_CANCELLED",
              message: "Operation cancelled by caller",
            });
            return;
          }

          if (this.lifecycleTarget) {
            const currentStatus = this.lifecycleTarget.getStatus();
            if (currentStatus !== "SUBSCRIBED") {
              isSettled = true;
              fetchAbortController.abort(new Error("LIFECYCLE_CANCELLED"));
              resolve({
                outcome: "LIFECYCLE_CANCELLED",
                message: `Coordinator status transitioned to ${currentStatus} while awaiting fetch; results discarded`,
              });
              return;
            }
            const currentEpoch = this.lifecycleTarget.getConnectionEpoch();
            if (currentEpoch !== expectedEpoch) {
              isSettled = true;
              fetchAbortController.abort(new Error("LIFECYCLE_CANCELLED"));
              resolve({
                outcome: "LIFECYCLE_CANCELLED",
                message: `Coordinator epoch transitioned to ${currentEpoch} (expected: ${expectedEpoch}) while awaiting fetch; results discarded`,
              });
              return;
            }
          }
        }, this.checkIntervalMs);

        this.pageFetcher
          .fetchPage({
            address: this.poolContext.poolId,
            limit: this.pageSize,
            before: cursorBefore,
            commitment: this.commitment,
            signal: fetchAbortController.signal,
          })
          .then((records) => {
            if (isSettled) return;
            isSettled = true;
            resolve({ outcome: "SUCCESS", records });
          })
          .catch((error: unknown) => {
            if (isSettled) return;
            isSettled = true;
            resolve({ outcome: "FETCH_ERROR", error });
          });
      });
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (callerAbortHandler && this.signal) {
        this.signal.removeEventListener("abort", callerAbortHandler);
      }
    }
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
    const seenSignatures = new Map<string, HistorySignatureRecord>();
    let previousOldestRecord: HistorySignatureRecord | null = null;
    let cursorBefore: string | undefined = undefined;
    let pagesQueried = 0;
    let requestCount = 0;

    const createFailureResult = (
      outcome: HistoryEnumerationOutcome,
      errorMsg?: string,
      budgetReason?: string,
    ): HistoryEnumerationResult => {
      return deepFreeze({
        outcome,
        anchorWitnessed: false,
        knownAnchorSignature: this.knownAnchorSignature,
        frozenTargetSignature,
        discoveredSignatures: deepFreeze([...accumulatedRecords]),
        pagesQueried,
        requestCount,
        isProductionCompletenessEstablished: false,
        ...(errorMsg ? { error: errorMsg } : {}),
        ...(budgetReason ? { budgetDenialReason: budgetReason } : {}),
      });
    };

    while (true) {
      // 1. Pre-dispatch admission loop with recoverable pacing wait
      while (true) {
        if (this.isCancelled?.() || this.signal?.aborted) {
          return createFailureResult("OPERATION_CANCELLED", "Operation cancelled by caller");
        }

        const preNow = this.clock();
        if (preNow >= deadlineMs) {
          return createFailureResult(
            "OPERATION_DEADLINE_EXCEEDED",
            `Operation deadline exceeded (${this.operationDeadlineMs}ms)`,
          );
        }

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

        const budgetCheck = this.budgetManager.canMakeRequest(
          this.providerName,
          preNow,
          "CANDIDATE_ENRICHMENT",
        );

        if (!budgetCheck.allowed) {
          // Handle recoverable pacing wait
          if (
            budgetCheck.reason === "PROVIDER_PACING_NOT_MET" &&
            typeof budgetCheck.waitMs === "number" &&
            budgetCheck.waitMs > 0
          ) {
            if (preNow + budgetCheck.waitMs >= deadlineMs) {
              return createFailureResult(
                "OPERATION_DEADLINE_EXCEEDED",
                `Pacing wait of ${budgetCheck.waitMs}ms exceeds operation deadline (${this.operationDeadlineMs}ms)`,
              );
            }

            const waitRes = await this.waitForPacing(budgetCheck.waitMs, deadlineMs, expectedEpoch);
            if (!waitRes.ok) {
              return createFailureResult(
                waitRes.outcome ?? "OPERATION_CANCELLED",
                waitRes.error,
                waitRes.budgetReason,
              );
            }
            continue; // Re-check admission after wait
          }

          // Genuine quota or reservation denial (terminal)
          return createFailureResult(
            "BUDGET_EXHAUSTED",
            budgetCheck.reason ?? "BUDGET_DENIED",
            budgetCheck.reason,
          );
        }

        const recorded = this.budgetManager.recordRequestAttempt(
          this.providerName,
          "CANDIDATE_ENRICHMENT",
          preNow,
        );
        if (!recorded) {
          continue; // Re-check if concurrent dispatch took slot
        }

        requestCount++;
        break; // Admission granted
      }

      // 2. Dispatch page fetch racing against deadline, signal, and lifecycle
      const fetchRace = await this.raceFetchPage(cursorBefore, deadlineMs, expectedEpoch);

      if (fetchRace.outcome !== "SUCCESS") {
        pagesQueried++;
        if (fetchRace.outcome === "FETCH_ERROR") {
          return createFailureResult(
            "FETCH_ERROR",
            fetchRace.error instanceof Error ? fetchRace.error.message : String(fetchRace.error),
          );
        }
        return createFailureResult(fetchRace.outcome, fetchRace.message);
      }

      pagesQueried++;
      const rawRecords = fetchRace.records;

      // 3. Record integrity and schema validation
      if (!Array.isArray(rawRecords)) {
        return createFailureResult("MALFORMED_RECORD", "RPC history page response is not an array");
      }

      // Reject pages exceeding the requested page size
      if (rawRecords.length > this.pageSize) {
        return createFailureResult(
          "MALFORMED_RECORD",
          `Page ${pagesQueried} returned ${rawRecords.length} records exceeding requested pageSize (${this.pageSize})`,
        );
      }

      for (let i = 0; i < rawRecords.length; i++) {
        const rec = rawRecords[i];
        if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} is not a valid non-null object`,
          );
        }

        if (!isValidSolanaSignature(rec.signature)) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} has invalid 64-byte Base58 signature: ${String(rec.signature)}`,
          );
        }

        // Required err property must exist
        if (!("err" in rec) || rec.err === undefined) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} is missing required 'err' property`,
          );
        }
        if (rec.err !== null && typeof rec.err !== "object" && typeof rec.err !== "string") {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} has invalid err payload representation`,
          );
        }

        if (typeof rec.slot !== "number" || !Number.isSafeInteger(rec.slot) || rec.slot < 0) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} has invalid non-negative integer slot: ${String(rec.slot)}`,
          );
        }

        if (
          rec.blockTime !== null &&
          (typeof rec.blockTime !== "number" ||
            !Number.isSafeInteger(rec.blockTime) ||
            rec.blockTime <= 0)
        ) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} has invalid blockTime: ${String(rec.blockTime)}`,
          );
        }

        // Validate confirmationStatus against requested commitment
        if (rec.confirmationStatus !== undefined && rec.confirmationStatus !== null) {
          if (typeof rec.confirmationStatus !== "string") {
            return createFailureResult(
              "MALFORMED_RECORD",
              `Record at index ${i} has non-string confirmationStatus`,
            );
          }
          const status = rec.confirmationStatus.toLowerCase();
          if (this.commitment === "confirmed") {
            if (status !== "confirmed" && status !== "finalized") {
              return createFailureResult(
                "MALFORMED_RECORD",
                `Record at index ${i} confirmationStatus '${rec.confirmationStatus}' contradicts requested commitment 'confirmed'`,
              );
            }
          } else if (this.commitment === "finalized") {
            if (status !== "finalized") {
              return createFailureResult(
                "MALFORMED_RECORD",
                `Record at index ${i} confirmationStatus '${rec.confirmationStatus}' contradicts requested commitment 'finalized'`,
              );
            }
          }
        }

        if (rec.memo !== undefined && rec.memo !== null && typeof rec.memo !== "string") {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Record at index ${i} has non-string memo`,
          );
        }
      }

      // 4. Traversal Ordering & Boundary Verification
      // A. Within-page newest-first ordering
      for (let i = 1; i < rawRecords.length; i++) {
        const prevSlot = rawRecords[i - 1]?.slot ?? 0;
        const currSlot = rawRecords[i]?.slot ?? 0;
        if (currSlot > prevSlot) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Page ${pagesQueried} violated newest-first slot ordering at index ${i} (slot ${currSlot} > ${prevSlot})`,
          );
        }
      }

      // B. Across-page before-boundary check
      if (previousOldestRecord !== null && rawRecords.length > 0) {
        const pageHeadSlot = rawRecords[0]?.slot ?? 0;
        if (pageHeadSlot > previousOldestRecord.slot) {
          return createFailureResult(
            "MALFORMED_RECORD",
            `Page ${pagesQueried} violated before-boundary: newest record slot ${pageHeadSlot} exceeds previous page oldest slot ${previousOldestRecord.slot}`,
          );
        }
      }

      // C. Duplicate signature conflicting metadata check
      for (let i = 0; i < rawRecords.length; i++) {
        const r = rawRecords[i]!;
        if (seenSignatures.has(r.signature)) {
          const existing = seenSignatures.get(r.signature)!;
          const isSlotMatch = existing.slot === r.slot;
          const isBlockTimeMatch = existing.blockTime === r.blockTime;
          const isStatusMatch = existing.confirmationStatus === r.confirmationStatus;
          const isErrMatch = JSON.stringify(existing.err) === JSON.stringify(r.err);

          if (!isSlotMatch || !isBlockTimeMatch || !isStatusMatch || !isErrMatch) {
            return createFailureResult(
              "MALFORMED_RECORD",
              `Conflicting metadata encountered for duplicate signature ${r.signature}`,
            );
          }
        }
      }

      // 5. Target Freezing from RPC Head of Page 1
      if (pagesQueried === 1) {
        if (rawRecords.length === 0) {
          return createFailureResult(
            "ANCHOR_NOT_FOUND",
            "Initial history query returned zero records; anchor unobserved",
          );
        }
        frozenTargetSignature = rawRecords[0]?.signature ?? null;
      }

      // 6. Anchor Verification & Bounded Capacity-Checked Insertion
      const anchorIndex = rawRecords.findIndex((r) => r.signature === this.knownAnchorSignature);

      if (anchorIndex !== -1) {
        const newDiscovered = rawRecords.slice(0, anchorIndex);
        for (const raw of newDiscovered) {
          if (!seenSignatures.has(raw.signature)) {
            if (accumulatedRecords.length >= this.maxRetainedRecords) {
              return createFailureResult(
                "MAX_RECORDS_EXCEEDED",
                `Retained records reached maximum limit (${this.maxRetainedRecords})`,
              );
            }
            const frozen = cloneAndDeepFreezeRecord(raw);
            seenSignatures.set(frozen.signature, frozen);
            accumulatedRecords.push(frozen);
          }
        }

        return deepFreeze({
          outcome: "ANCHOR_WITNESSED",
          anchorWitnessed: true,
          knownAnchorSignature: this.knownAnchorSignature,
          frozenTargetSignature,
          discoveredSignatures: deepFreeze([...accumulatedRecords]),
          pagesQueried,
          requestCount,
          isProductionCompletenessEstablished: false,
        });
      }

      // Anchor not found in this page
      if (rawRecords.length < this.pageSize) {
        return createFailureResult(
          "ANCHOR_NOT_FOUND",
          `Page ${pagesQueried} returned ${rawRecords.length} records (< ${this.pageSize}) without reaching anchor`,
        );
      }

      // Full page: buffer records with capacity check
      const oldestRec = rawRecords[rawRecords.length - 1]!;
      let newlyAdded = 0;

      for (const raw of rawRecords) {
        if (!seenSignatures.has(raw.signature)) {
          if (accumulatedRecords.length >= this.maxRetainedRecords) {
            return createFailureResult(
              "MAX_RECORDS_EXCEEDED",
              `Retained records reached maximum limit (${this.maxRetainedRecords})`,
            );
          }
          const frozen = cloneAndDeepFreezeRecord(raw);
          seenSignatures.set(frozen.signature, frozen);
          accumulatedRecords.push(frozen);
          newlyAdded++;
        }
      }

      if (newlyAdded === 0 || cursorBefore === oldestRec.signature) {
        return createFailureResult(
          "NON_PROGRESSING_PAGE",
          `Page ${pagesQueried} produced zero new signatures or repeated previous oldest signature`,
        );
      }

      if (pagesQueried >= this.maxPages) {
        return createFailureResult(
          "MAX_PAGES_EXHAUSTED",
          `Pagination reached maxPages limit (${this.maxPages}) without encountering anchor`,
        );
      }

      previousOldestRecord = oldestRec;
      cursorBefore = oldestRec.signature;
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
