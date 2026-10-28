/**
 * Phase 12.94-D Milestone D.3.3: Raydium AMM v4 LP Evidence Adapter (Hardened)
 *
 * Composition adapter connecting the bounded Raydium AMM v4 snapshot acquisition
 * client to CandidateStreamEngine's injected LpEvidenceResolver interface.
 *
 * Operational and Safety Invariants:
 * 1. Kept outside pure scanner validation/accounting modules.
 * 2. Strict canonical identity binding: binds acquisition strictly to candidate.poolId
 *    and candidate.mintAddress with zero reference-pool fallback or substitution.
 * 3. Explicit transport requirement: an explicit transport (fetch implementation) is
 *    strictly mandatory at this stage; live networking is disabled.
 * 4. Metered request accounting: meters every outbound request attempt through a shared
 *    GlobalResourceBudgetManager, preserving global ceilings, purpose reservations,
 *    and shared host pacing across candidates.
 * 5. Dispatched failure counting & pre-dispatch reconciliation: dispatched attempts are counted
 *    regardless of HTTP outcome; pre-dispatch budget denials and deadline denials prevent dispatch
 *    and do not increment dispatched attempt counts.
 * 6. Single effective deadline: one unified deadline covers initial shared pacing, acquisition,
 *    and transport-wrapper pacing waits. Pacing waits respect abort signals and remaining time.
 * 7. Respect unsuccessful acquisition results: fails closed on acquisition failure (e.g. storage error)
 *    while preserving diagnostics, without allowing failed results to qualify candidates.
 * 8. Truthful provenance: passes explicit origin and synthetic flags through to evidence.
 * 9. Fail-closed: invalid identities, transport exceptions, and budget denials strictly fail closed.
 */

import { isCanonicalSolanaBase58 } from "./LpScreeningBridge.js";
import type { CandidateLpEvidenceResolver } from "./CandidateStreamEngine.js";
import type { ScannedPoolRecord } from "./CandidateScannerTypes.js";
import type { ValidatedLpEvidenceInput } from "./LpScreeningBridge.js";
import {
  acquireRaydiumAmmV4Snapshot,
  MIN_HOST_PACING_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_OVERALL_TIMEOUT_MS,
  type SnapshotAcquisitionResult,
  BudgetDeniedError,
  PreDispatchError,
  createTransportDispatchTracker,
} from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import type { EvidenceOrigin } from "../research/pilot/RaydiumAmmV4SnapshotValidator.js";
import type {
  GlobalResourceBudgetManager,
  RequestPurpose,
} from "../research/prospective/GlobalResourceBudgetManager.js";

/**
 * Helper to race a pacing wait against an optional AbortSignal.
 */
async function sleepWithSignal(
  ms: number,
  sleepFn: (ms: number) => Promise<void>,
  signal?: AbortSignal | null | undefined,
): Promise<void> {
  if (signal?.aborted) {
    throw new PreDispatchError("ABORTED: Request was cancelled before pacing wait");
  }
  if (!signal) {
    await sleepFn(ms);
    return;
  }
  let abortListener: (() => void) | undefined;
  try {
    await Promise.race([
      sleepFn(ms),
      new Promise<never>((_, reject) => {
        abortListener = () => {
          reject(new PreDispatchError("ABORTED: Request was cancelled during pacing wait"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export interface RaydiumAmmV4LpEvidenceAdapterOptions {
  /**
   * Explicit RPC URL (e.g. mock RPC URL in tests or configured Solana RPC). Mandatory.
   */
  readonly rpcUrl: string;

  /**
   * Shared session resource budget manager. Mandatory.
   */
  readonly budgetManager: GlobalResourceBudgetManager;

  /**
   * Explicitly supplied transport implementation.
   * Strictly required at this offline integration stage; live networking is disabled.
   */
  readonly transport: typeof fetch;

  /**
   * Provider identifier for budget tracking and shared pacing. Default: "SOLANA_RPC".
   */
  readonly providerName?: string | undefined;

  /**
   * Request purpose for budget reservation. Default: "CANDIDATE_ENRICHMENT".
   */
  readonly requestPurpose?: RequestPurpose | undefined;

  /**
   * Host pacing in milliseconds between calls to the same provider.
   * Default: 2,500 ms (MIN_HOST_PACING_MS).
   */
  readonly pacingMs?: number | undefined;

  /**
   * Per-request timeout in milliseconds. Default: 10,000 ms.
   */
  readonly timeoutMs?: number | undefined;

  /**
   * Overall execution timeout ceiling in milliseconds. Default: 60,000 ms.
   */
  readonly overallTimeoutMs?: number | undefined;

  /**
   * Optional directory to persist sealed evidence and manifests.
   */
  readonly outDir?: string | undefined;

  /**
   * Explicit evidence origin for truthful provenance.
   */
  readonly evidenceOrigin?: EvidenceOrigin | undefined;

  /**
   * Whether this acquisition produces synthetic fixture evidence.
   */
  readonly isSyntheticFixture?: boolean | undefined;

  /**
   * Monotonic clock function returning epoch milliseconds.
   */
  readonly clock?: (() => number) | undefined;

  /**
   * Sleeper function for pacing delays. Default: setTimeout.
   */
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
}

export class RaydiumAmmV4LpEvidenceAdapter implements CandidateLpEvidenceResolver {
  private readonly rpcUrl: string;
  private readonly budgetManager: GlobalResourceBudgetManager;
  private readonly underlyingTransport: typeof fetch;
  private readonly providerName: string;
  private readonly requestPurpose: RequestPurpose;
  private readonly pacingMs: number;
  private readonly timeoutMs: number;
  private readonly overallTimeoutMs: number;
  private readonly outDir: string | undefined;
  private readonly evidenceOrigin: EvidenceOrigin | undefined;
  private readonly isSyntheticFixture: boolean | undefined;
  private readonly clock: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private lastResult: SnapshotAcquisitionResult | null = null;

  constructor(options: RaydiumAmmV4LpEvidenceAdapterOptions) {
    if (!options.transport) {
      throw new Error(
        "Explicit transport is required for RaydiumAmmV4LpEvidenceAdapter; default live networking is disabled at this stage",
      );
    }
    if (!options.budgetManager) {
      throw new Error(
        "Shared GlobalResourceBudgetManager is required for RaydiumAmmV4LpEvidenceAdapter",
      );
    }
    if (!options.rpcUrl || options.rpcUrl.trim() === "") {
      throw new Error("rpcUrl is required for RaydiumAmmV4LpEvidenceAdapter");
    }

    this.rpcUrl = options.rpcUrl;
    this.budgetManager = options.budgetManager;
    this.underlyingTransport = options.transport;
    this.providerName = options.providerName ?? "SOLANA_RPC";
    this.requestPurpose = options.requestPurpose ?? "CANDIDATE_ENRICHMENT";
    this.pacingMs = Math.max(MIN_HOST_PACING_MS, options.pacingMs ?? MIN_HOST_PACING_MS);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
    this.outDir = options.outDir;
    this.evidenceOrigin = options.evidenceOrigin;
    this.isSyntheticFixture = options.isSyntheticFixture;
    this.clock = options.clock ?? (() => Date.now());
    this.sleepFn =
      options.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public async resolveLpEvidence(
    candidate: Pick<ScannedPoolRecord, "poolId" | "mintAddress">,
  ): Promise<ValidatedLpEvidenceInput> {
    // 1. Strict Identity Binding: Bind to exact canonical candidate pool and token mint.
    // Zero fallback to reference pool or reference mint.
    if (
      !candidate ||
      typeof candidate.poolId !== "string" ||
      typeof candidate.mintAddress !== "string" ||
      !isCanonicalSolanaBase58(candidate.poolId) ||
      !isCanonicalSolanaBase58(candidate.mintAddress)
    ) {
      return null;
    }

    // 2. Establish one effective deadline covering initial shared pacing, acquisition, and transport wrapper waits
    const startEpoch = this.clock();
    const effectiveDeadlineEpoch = startEpoch + this.overallTimeoutMs;

    const getRemainingEffectiveBudgetMs = (): number => {
      return effectiveDeadlineEpoch - this.clock();
    };

    let remainingBudget = getRemainingEffectiveBudgetMs();
    if (remainingBudget <= 0) {
      return null;
    }

    // 3. Pre-check budget permission and pacing across candidates before initiating acquisition
    let initialCheck = this.budgetManager.canMakeRequest(
      this.providerName,
      this.clock(),
      this.requestPurpose,
    );

    if (
      !initialCheck.allowed &&
      initialCheck.reason === "PROVIDER_PACING_NOT_MET" &&
      typeof initialCheck.waitMs === "number" &&
      initialCheck.waitMs > 0
    ) {
      if (initialCheck.waitMs >= remainingBudget) {
        // Insufficient time for initial pacing within effective deadline
        return null;
      }
      await this.sleepFn(initialCheck.waitMs);
      remainingBudget = getRemainingEffectiveBudgetMs();
      if (remainingBudget <= 0) {
        return null;
      }
      initialCheck = this.budgetManager.canMakeRequest(
        this.providerName,
        this.clock(),
        this.requestPurpose,
      );
    }

    if (!initialCheck.allowed) {
      // Budget denial prevents dispatch upfront
      return null;
    }

    // 4. Create explicit execution dispatch tracker for trusted wrapper contract
    const dispatchTracker = createTransportDispatchTracker();

    // 5. Construct metered fetch transport bound to shared session budget and effective deadline
    const meteredFetch: typeof fetch = async (input, init) => {
      // Check cancellation upfront
      if (init?.signal?.aborted) {
        throw new PreDispatchError("ABORTED: Request was cancelled before dispatch");
      }

      // Check remaining effective budget
      let remaining = getRemainingEffectiveBudgetMs();
      if (remaining <= 0) {
        throw new PreDispatchError(
          `DEADLINE_EXCEEDED: Overall timeout of ${this.overallTimeoutMs}ms exceeded before dispatch`,
        );
      }

      const callNow = this.clock();
      let check = this.budgetManager.canMakeRequest(
        this.providerName,
        callNow,
        this.requestPurpose,
      );

      if (
        !check.allowed &&
        check.reason === "PROVIDER_PACING_NOT_MET" &&
        typeof check.waitMs === "number" &&
        check.waitMs > 0
      ) {
        if (check.waitMs >= remaining) {
          throw new PreDispatchError(
            `DEADLINE_EXCEEDED: Remaining budget (${remaining}ms) is insufficient for shared pacing wait (${check.waitMs}ms)`,
          );
        }

        if (init?.signal?.aborted) {
          throw new PreDispatchError("ABORTED: Request was cancelled before pacing wait");
        }

        await sleepWithSignal(check.waitMs, this.sleepFn, init?.signal);

        if (init?.signal?.aborted) {
          throw new PreDispatchError("ABORTED: Request was cancelled during pacing wait");
        }

        remaining = getRemainingEffectiveBudgetMs();
        if (remaining <= 0) {
          throw new PreDispatchError(
            `DEADLINE_EXCEEDED: Overall timeout of ${this.overallTimeoutMs}ms exceeded during shared pacing wait`,
          );
        }

        check = this.budgetManager.canMakeRequest(
          this.providerName,
          this.clock(),
          this.requestPurpose,
        );
      }

      if (!check.allowed) {
        // Budget denial must prevent dispatch!
        throw new BudgetDeniedError(
          `BUDGET_DENIED: ${check.reason ?? "Request denied by shared session budget"}`,
        );
      }

      if (init?.signal?.aborted) {
        throw new PreDispatchError("ABORTED: Request was cancelled before dispatch recording");
      }
      if (getRemainingEffectiveBudgetMs() <= 0) {
        throw new PreDispatchError(
          `DEADLINE_EXCEEDED: Overall timeout of ${this.overallTimeoutMs}ms exceeded before dispatch recording`,
        );
      }

      // Record request attempt in shared session budget BEFORE actual dispatch.
      const recorded = this.budgetManager.recordRequestAttempt(
        this.providerName,
        this.requestPurpose,
        this.clock(),
      );

      if (!recorded) {
        throw new BudgetDeniedError(
          "BUDGET_DENIED: Failed to record request attempt in shared session budget",
        );
      }

      // Explicit execution state: Mark transport as dispatched immediately before invocation
      dispatchTracker.markDispatched();

      const response = await this.underlyingTransport(input, init);

      // Record response status in budgetManager (tracks consecutive 429 halts)
      this.budgetManager.recordResponseStatus(response.status);

      return response;
    };

    const remainingForAcquisition = Math.max(0, getRemainingEffectiveBudgetMs());
    const acquisitionClock = () => new Date(this.clock());

    try {
      const result: SnapshotAcquisitionResult = await acquireRaydiumAmmV4Snapshot({
        rpcUrl: this.rpcUrl,
        poolId: candidate.poolId,
        expectedTokenMint: candidate.mintAddress,
        pacingMs: this.pacingMs,
        timeoutMs: this.timeoutMs,
        overallTimeoutMs: remainingForAcquisition,
        outDir: this.outDir,
        evidenceOrigin: this.evidenceOrigin,
        isSyntheticFixture: this.isSyntheticFixture,
        fetch: meteredFetch,
        dispatchTracker,
        clock: acquisitionClock,
        sleeper: (ms) => sleepWithSignal(ms, this.sleepFn),
      });

      this.lastResult = result;

      // 1. Respect unsuccessful acquisition results (storage failures, network drops, deadline expirations)
      if (!result.ok) {
        // Fail closed at adapter boundary while preserving diagnostics without allowing failed acquisition results to qualify candidates.
        if (result.evidence) {
          return {
            ...result.evidence,
            outcomes: {
              ...result.evidence.outcomes,
              structuralValidationOk: false,
              meetsNinetyPercentThreshold: false,
            },
            failureReason: result.evidence.failureReason ?? "ACQUISITION_UNSUCCESSFUL",
          };
        }
        return null;
      }

      return result.evidence;
    } catch {
      return null;
    }
  }

  public getBudgetManager(): GlobalResourceBudgetManager {
    return this.budgetManager;
  }

  public getLastResult(): SnapshotAcquisitionResult | null {
    return this.lastResult;
  }
}
