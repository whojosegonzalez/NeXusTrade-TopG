/**
 * Phase 12.94-D D.3.3: Bounded PAPER security-evidence loader for one fixed pool and mint
 * (offline-tested only; not installed).
 *
 * Retrieves, through ONE shared PaperRequestSession (one HTTP-attempt ceiling, one ledger, and the
 * Solana lane's serialization and >= 2,500 ms pacing shared with the rolling flow provider):
 *
 * - LP: the accepted RaydiumAmmV4LpEvidenceAdapter (snapshot acquisition: pool account, then the
 *   account batch), with the session's budget and a session-routed transport;
 * - the mint account: one jsonParsed getAccountInfo on the Solana lane;
 * - the RugCheck report: one GET on the RUGCHECK lane;
 * - the Solana Tracker bundler response: one GET on the SOLANA_TRACKER lane, with an injected key.
 *
 * It returns PaperCandidateSecurityEvidence for evaluatePaperCandidateSecurityContext; it validates
 * nothing itself. Every component records its request identity, request id, original retrieval
 * time (the dispatch time, i.e. request initiation), HTTP status and body completeness. A body that
 * was not read completely is never parsed. Credentials never appear in evidence, status or ledger.
 *
 * Boundaries: import and construction are inert; acquisition happens only in load(), only for the
 * fixed target, only under PAPER_SIMULATION, and only while the shared session is open. Status reads
 * never start acquisition.
 */

import { isCanonicalSolanaBase58, type ValidatedLpEvidenceInput } from "./LpScreeningBridge.js";
import { RaydiumAmmV4LpEvidenceAdapter } from "./RaydiumAmmV4LpEvidenceAdapter.js";
import {
  PAPER_SECURITY_CONTEXT_POLICY,
  type PaperCandidateSecurityEvidence,
  type PaperMintAccountEvidence,
  type PaperProviderResponseEvidence,
  type PaperSecurityEvidenceComponent,
  type PaperSecurityTarget,
} from "./PaperCandidateSecurityContext.js";
import {
  PaperRequestSession,
  type PaperRequestExchange,
  type PaperRequestLane,
} from "./PaperRequestSession.js";
import { PreDispatchError } from "../research/pilot/RaydiumAmmV4SnapshotAcquisition.js";
import type { EvidenceOrigin } from "../research/pilot/RaydiumAmmV4SnapshotValidator.js";

/** Explicit loader limits. Every field is mandatory; no value is approved for live execution. */
export interface PaperSecurityEvidenceLoaderLimits {
  /** Overall bound passed to the LP acquisition (>= the Solana pacing; at most 60,000 ms). */
  readonly lpAcquisitionTimeoutMs: number;
  /** Loads allowed in this loader's lifetime (each load uses at most 3 Solana, 1 RugCheck, 1 bundler request). */
  readonly maxLoads: number;
}

export interface PaperSecurityEvidenceLoaderOptions {
  readonly executionContext: "PAPER_SIMULATION";
  readonly target: PaperSecurityTarget;
  readonly session: PaperRequestSession;
  readonly solanaRpcUrl: string;
  /** RugCheck API base (the report path is appended). */
  readonly rugCheckApiUrl: string;
  /** Solana Tracker API base (the bundlers path is appended). */
  readonly solanaTrackerApiUrl: string;
  /** Injected Solana Tracker credential; sent only as a request header, never recorded. */
  readonly solanaTrackerApiKey?: string | undefined;
  /** Truthful provenance for the LP acquisition (e.g. SYNTHETIC_FIXTURE in offline tests). */
  readonly lpEvidenceOrigin: EvidenceOrigin;
  readonly limits: PaperSecurityEvidenceLoaderLimits;
}

export type PaperSecurityEvidenceComponentOutcome =
  | { readonly status: "RETRIEVED"; readonly sessionSeqs: readonly number[] }
  | { readonly status: "NOT_REQUESTED"; readonly sessionSeqs: readonly number[] }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: string;
      readonly sessionSeqs: readonly number[];
    };

export interface PaperSecurityEvidenceLoadRecord {
  readonly load: number;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly lp: PaperSecurityEvidenceComponentOutcome;
  readonly mintAccount: PaperSecurityEvidenceComponentOutcome;
  readonly rugCheck: PaperSecurityEvidenceComponentOutcome;
  readonly bundler: PaperSecurityEvidenceComponentOutcome;
}

export interface PaperSecurityEvidenceLoaderStatus {
  readonly loadsStarted: number;
  readonly loadsCompleted: number;
  readonly inFlight: boolean;
  readonly cancelledReason: string | null;
  readonly records: readonly PaperSecurityEvidenceLoadRecord[];
}

const ALL_COMPONENTS: readonly PaperSecurityEvidenceComponent[] = Object.freeze([
  "LP",
  "MINT_ACCOUNT",
  "RUGCHECK",
  "BUNDLER",
]);
const NOT_REQUESTED: PaperSecurityEvidenceComponentOutcome = Object.freeze({
  status: "NOT_REQUESTED",
  sessionSeqs: Object.freeze([]) as readonly number[],
});

function parseJson(text: string | undefined): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

function validateLimits(
  limits: unknown,
  solanaPacingMs: number,
): PaperSecurityEvidenceLoaderLimits {
  const l = (limits ?? {}) as Record<string, unknown>;
  const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (!positive(l.maxLoads)) {
    throw new Error("[PAPER_SECURITY_LOADER_INIT] limits.maxLoads must be a positive safe integer");
  }
  if (
    !positive(l.lpAcquisitionTimeoutMs) ||
    (l.lpAcquisitionTimeoutMs as number) < solanaPacingMs ||
    (l.lpAcquisitionTimeoutMs as number) > 60_000
  ) {
    throw new Error(
      "[PAPER_SECURITY_LOADER_INIT] limits.lpAcquisitionTimeoutMs must be between the Solana pacing and 60,000 ms",
    );
  }
  return Object.freeze({
    maxLoads: l.maxLoads as number,
    lpAcquisitionTimeoutMs: l.lpAcquisitionTimeoutMs as number,
  });
}

export class PaperCandidateSecurityEvidenceLoader {
  private readonly target: PaperSecurityTarget;
  private readonly session: PaperRequestSession;
  private readonly solanaRpcUrl: string;
  private readonly rugCheckApiUrl: string;
  private readonly solanaTrackerApiUrl: string;
  private readonly solanaTrackerApiKey: string | undefined;
  private readonly lpEvidenceOrigin: EvidenceOrigin;
  private readonly limits: PaperSecurityEvidenceLoaderLimits;
  private readonly cancel = new AbortController();
  private cancelledReason: string | null = null;
  private loadsStarted = 0;
  private loadsCompleted = 0;
  private inFlight = false;
  private readonly records: PaperSecurityEvidenceLoadRecord[] = [];

  constructor(options: PaperSecurityEvidenceLoaderOptions) {
    const fail = (msg: string): never => {
      throw new Error(`[PAPER_SECURITY_LOADER_INIT] ${msg}`);
    };
    if (!options || typeof options !== "object") fail("options are mandatory");
    if (options.executionContext !== "PAPER_SIMULATION") {
      fail("executionContext must be PAPER_SIMULATION");
    }
    const t = options.target;
    if (
      !t ||
      typeof t.poolId !== "string" ||
      typeof t.mintAddress !== "string" ||
      !isCanonicalSolanaBase58(t.poolId) ||
      !isCanonicalSolanaBase58(t.mintAddress)
    ) {
      fail("target must name one canonical pool and mint");
    }
    if (!(options.session instanceof PaperRequestSession)) {
      fail("session must be a PaperRequestSession");
    }
    for (const key of ["solanaRpcUrl", "rugCheckApiUrl", "solanaTrackerApiUrl"] as const) {
      if (typeof options[key] !== "string" || options[key].length === 0)
        fail(`${key} is mandatory`);
    }
    if (
      options.solanaTrackerApiKey !== undefined &&
      (typeof options.solanaTrackerApiKey !== "string" || options.solanaTrackerApiKey.length === 0)
    ) {
      fail("solanaTrackerApiKey must be a non-empty string when supplied");
    }
    if (!["SYNTHETIC_FIXTURE", "CAPTURED_RPC", "UNKNOWN"].includes(options.lpEvidenceOrigin)) {
      fail("lpEvidenceOrigin must be an accepted evidence origin");
    }
    this.target = Object.freeze({ poolId: t.poolId, mintAddress: t.mintAddress });
    this.session = options.session;
    this.solanaRpcUrl = options.solanaRpcUrl;
    this.rugCheckApiUrl = options.rugCheckApiUrl.replace(/\/+$/, "");
    this.solanaTrackerApiUrl = options.solanaTrackerApiUrl.replace(/\/+$/, "");
    this.solanaTrackerApiKey = options.solanaTrackerApiKey;
    this.lpEvidenceOrigin = options.lpEvidenceOrigin;
    this.limits = validateLimits(options.limits, this.session.limits.lanes.SOLANA_RPC.pacingMs);
  }

  /** The shared session's clock. */
  public now(): number {
    return this.session.now();
  }

  /** Read-only status (never starts acquisition; contains no credentials or URLs). */
  public getStatus(): PaperSecurityEvidenceLoaderStatus {
    return Object.freeze({
      loadsStarted: this.loadsStarted,
      loadsCompleted: this.loadsCompleted,
      inFlight: this.inFlight,
      cancelledReason: this.cancelledReason,
      records: Object.freeze([...this.records]),
    });
  }

  /** Cancels in-flight and future loads (their pending requests are not sent). */
  public cancelLoads(reason = "LOADER_CANCELLED"): void {
    if (this.cancelledReason === null) this.cancelledReason = reason;
    this.cancel.abort();
  }

  /**
   * Retrieves evidence for the fixed target. Throws for another target, a second concurrent load,
   * the load ceiling or a cancelled loader; otherwise every component is retrieved or explicitly
   * unavailable (null), and the accepted composition decides what is usable.
   */
  public async load(
    target: PaperSecurityTarget,
    signal?: AbortSignal,
    components: readonly PaperSecurityEvidenceComponent[] = ALL_COMPONENTS,
  ): Promise<PaperCandidateSecurityEvidence> {
    const wanted = new Set(components);
    if (wanted.size === 0 || [...wanted].some((c) => !ALL_COMPONENTS.includes(c))) {
      throw new Error("PAPER_SECURITY_LOADER_INVALID_COMPONENTS");
    }
    if (target?.poolId !== this.target.poolId || target?.mintAddress !== this.target.mintAddress) {
      throw new Error("PAPER_SECURITY_LOADER_TARGET_MISMATCH");
    }
    if (this.cancelledReason !== null) {
      throw new Error(`PAPER_SECURITY_LOADER_CANCELLED: ${this.cancelledReason}`);
    }
    if (this.inFlight) throw new Error("PAPER_SECURITY_LOADER_LOAD_IN_PROGRESS");
    if (this.loadsStarted >= this.limits.maxLoads) {
      throw new Error("PAPER_SECURITY_LOADER_LOAD_CEILING_REACHED");
    }
    this.inFlight = true;
    const load = ++this.loadsStarted;
    const startedAtMs = this.session.now();
    const signals = [this.cancel.signal, ...(signal ? [signal] : [])];
    try {
      // Different lanes run concurrently; the Solana lane serializes and paces the LP acquisition and
      // the mint account with every other Solana request in the session (including flow).
      // Only the requested components are retrieved (selective refresh); the others are untouched.
      const skip = <T>(): Promise<{
        readonly evidence: T | null;
        readonly outcome: PaperSecurityEvidenceComponentOutcome;
      }> => Promise.resolve({ evidence: null, outcome: NOT_REQUESTED });
      const [lp, mintAccount, rugCheck, bundler] = await Promise.all([
        wanted.has("LP") ? this.loadLp(signals) : skip<ValidatedLpEvidenceInput>(),
        wanted.has("MINT_ACCOUNT")
          ? this.loadMintAccount(signals)
          : skip<PaperMintAccountEvidence>(),
        !wanted.has("RUGCHECK")
          ? skip<PaperProviderResponseEvidence>()
          : this.loadProviderResponse(
              "RUGCHECK",
              "RUGCHECK_REPORT",
              `${this.rugCheckApiUrl}/v1/tokens/${encodeURIComponent(this.target.mintAddress)}/report`,
              { Accept: "application/json" },
              signals,
            ),
        !wanted.has("BUNDLER")
          ? skip<PaperProviderResponseEvidence>()
          : this.loadProviderResponse(
              "SOLANA_TRACKER",
              "SOLANA_TRACKER_BUNDLERS",
              `${this.solanaTrackerApiUrl}/tokens/${encodeURIComponent(this.target.mintAddress)}/bundlers`,
              {
                Accept: "application/json",
                ...(this.solanaTrackerApiKey ? { "x-api-key": this.solanaTrackerApiKey } : {}),
              },
              signals,
            ),
      ]);
      this.records.push(
        Object.freeze({
          load,
          startedAtMs,
          completedAtMs: this.session.now(),
          lp: lp.outcome,
          mintAccount: mintAccount.outcome,
          rugCheck: rugCheck.outcome,
          bundler: bundler.outcome,
        }),
      );
      this.loadsCompleted++;
      return {
        ...(wanted.has("LP") ? { lp: lp.evidence } : {}),
        ...(wanted.has("MINT_ACCOUNT") ? { mintAccount: mintAccount.evidence } : {}),
        ...(wanted.has("RUGCHECK") ? { rugCheck: rugCheck.evidence } : {}),
        ...(wanted.has("BUNDLER") ? { bundler: bundler.evidence } : {}),
      };
    } finally {
      this.inFlight = false;
    }
  }

  private dispatch(
    lane: PaperRequestLane,
    purpose: string,
    init: {
      readonly url: string;
      readonly method: "GET" | "POST";
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string | undefined;
      readonly jsonRpcId?: number | string | null | undefined;
      readonly requestedIdentity: string;
    },
    signals: readonly AbortSignal[],
    onDispatched?: () => void,
  ): Promise<PaperRequestExchange> {
    return this.session.dispatch({
      lane,
      owner: "SECURITY",
      purpose,
      requestedIdentity: init.requestedIdentity,
      url: init.url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      jsonRpcId: init.jsonRpcId ?? null,
      refusal: () => (signals.some((s) => s.aborted) ? "LOADER_CANCELLED" : null),
      waitSignals: signals,
      linkSignals: () => signals,
      onDispatched: onDispatched ? () => onDispatched() : undefined,
    });
  }

  private async loadLp(signals: readonly AbortSignal[]): Promise<{
    readonly evidence: ValidatedLpEvidenceInput;
    readonly outcome: PaperSecurityEvidenceComponentOutcome;
  }> {
    const seqs: number[] = [];
    let lastFailure: string | null = null;
    // Session-routed transport for the accepted acquisition: counted once by the session at dispatch;
    // a refused request throws PreDispatchError (never sent); an incomplete body is never returned.
    const transport = (async (_input: unknown, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : undefined;
      const rpcId = (parseJson(body) as { id?: unknown } | undefined)?.id;
      const callerSignal = init?.signal ?? undefined;
      const exchange = await this.dispatch(
        "SOLANA_RPC",
        "LP_ACQUISITION",
        {
          url: this.solanaRpcUrl,
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          jsonRpcId: typeof rpcId === "number" || typeof rpcId === "string" ? rpcId : null,
          requestedIdentity: this.target.poolId,
        },
        callerSignal ? [...signals, callerSignal] : signals,
      );
      if (exchange.entry) seqs.push(exchange.entry.seq);
      if (!exchange.dispatched) {
        lastFailure = exchange.error ?? "NOT_DISPATCHED";
        throw new PreDispatchError(lastFailure);
      }
      if (!exchange.bodyComplete || exchange.text === undefined || exchange.status === undefined) {
        lastFailure = exchange.error ?? "RESPONSE_INCOMPLETE";
        throw new Error(lastFailure);
      }
      return new Response(exchange.text, { status: exchange.status });
    }) as unknown as typeof fetch;

    const remainingMs =
      this.session.getDeadlineMs() === null
        ? 0
        : this.session.getDeadlineMs()! - this.session.now();
    const overallTimeoutMs = Math.min(this.limits.lpAcquisitionTimeoutMs, remainingMs);
    const pacingMs = this.session.limits.lanes.SOLANA_RPC.pacingMs;
    if (!this.session.isOpen() || overallTimeoutMs < pacingMs) {
      return {
        evidence: null,
        outcome: {
          status: "UNAVAILABLE",
          reason: this.session.isOpen() ? "INSUFFICIENT_SESSION_TIME" : "REQUEST_SESSION_NOT_OPEN",
          sessionSeqs: seqs,
        },
      };
    }
    const adapter = new RaydiumAmmV4LpEvidenceAdapter({
      rpcUrl: this.solanaRpcUrl,
      budgetManager: this.session.budget,
      transport,
      providerName: "SOLANA_RPC",
      requestPurpose: "CANDIDATE_ENRICHMENT",
      pacingMs,
      timeoutMs: this.session.limits.requestTimeoutMs,
      overallTimeoutMs,
      evidenceOrigin: this.lpEvidenceOrigin,
      isSyntheticFixture: this.lpEvidenceOrigin === "SYNTHETIC_FIXTURE" ? true : undefined,
      clock: () => this.session.now(),
      sleepFn: (ms) => this.session.sleep(ms, signals),
    });
    let evidence: ValidatedLpEvidenceInput = null;
    try {
      evidence = await adapter.resolveLpEvidence({
        poolId: this.target.poolId,
        mintAddress: this.target.mintAddress,
      });
    } catch (err) {
      lastFailure = `LP_ADAPTER_THREW: ${err instanceof Error ? err.message : String(err)}`;
      evidence = null;
    }
    const failed =
      evidence === null ||
      evidence === undefined ||
      ("failureReason" in evidence && typeof evidence.failureReason === "string");
    return {
      evidence: failed ? null : evidence,
      outcome: failed
        ? {
            status: "UNAVAILABLE",
            reason:
              lastFailure ??
              (evidence && "failureReason" in evidence && typeof evidence.failureReason === "string"
                ? evidence.failureReason
                : "LP_ACQUISITION_UNAVAILABLE"),
            sessionSeqs: seqs,
          }
        : { status: "RETRIEVED", sessionSeqs: seqs },
    };
  }

  private async loadMintAccount(signals: readonly AbortSignal[]): Promise<{
    readonly evidence: PaperMintAccountEvidence | null;
    readonly outcome: PaperSecurityEvidenceComponentOutcome;
  }> {
    const id = this.session.nextJsonRpcId();
    const exchange = await this.dispatch(
      "SOLANA_RPC",
      "CANDIDATE_MINT_ACCOUNT",
      {
        url: this.solanaRpcUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "getAccountInfo",
          params: [this.target.mintAddress, { encoding: "jsonParsed", commitment: "confirmed" }],
        }),
        jsonRpcId: id,
        requestedIdentity: this.target.mintAddress,
      },
      signals,
    );
    const seqs = exchange.entry ? [exchange.entry.seq] : [];
    if (!exchange.dispatched || !exchange.entry) {
      return {
        evidence: null,
        outcome: {
          status: "UNAVAILABLE",
          reason: exchange.error ?? "NOT_DISPATCHED",
          sessionSeqs: seqs,
        },
      };
    }
    // Retrieval time is the dispatch (request initiation) time; a partial body is never parsed.
    const evidence: PaperMintAccountEvidence = Object.freeze({
      requestedMint: this.target.mintAddress,
      retrievedAtMs: exchange.entry.dispatchedAtMs,
      httpStatus: exchange.status ?? 0,
      bodyComplete: exchange.bodyComplete,
      expectedRequestId: id,
      response: exchange.bodyComplete ? (parseJson(exchange.text) ?? null) : null,
    });
    return {
      evidence,
      outcome: exchange.bodyComplete
        ? { status: "RETRIEVED", sessionSeqs: seqs }
        : {
            status: "UNAVAILABLE",
            reason: exchange.error ?? "RESPONSE_INCOMPLETE",
            sessionSeqs: seqs,
          },
    };
  }

  private async loadProviderResponse(
    lane: "RUGCHECK" | "SOLANA_TRACKER",
    purpose: string,
    url: string,
    headers: Readonly<Record<string, string>>,
    signals: readonly AbortSignal[],
  ): Promise<{
    readonly evidence: PaperProviderResponseEvidence | null;
    readonly outcome: PaperSecurityEvidenceComponentOutcome;
  }> {
    const exchange = await this.dispatch(
      lane,
      purpose,
      { url, method: "GET", headers, requestedIdentity: this.target.mintAddress },
      signals,
    );
    const seqs = exchange.entry ? [exchange.entry.seq] : [];
    if (!exchange.dispatched || !exchange.entry) {
      return {
        evidence: null,
        outcome: {
          status: "UNAVAILABLE",
          reason: exchange.error ?? "NOT_DISPATCHED",
          sessionSeqs: seqs,
        },
      };
    }
    const evidence: PaperProviderResponseEvidence = Object.freeze({
      requestedMint: this.target.mintAddress,
      retrievedAtMs: exchange.entry.dispatchedAtMs,
      httpStatus: exchange.status ?? 0,
      bodyComplete: exchange.bodyComplete,
      payload: exchange.bodyComplete ? (parseJson(exchange.text) ?? null) : null,
    });
    return {
      evidence,
      outcome:
        exchange.bodyComplete && exchange.ok
          ? { status: "RETRIEVED", sessionSeqs: seqs }
          : {
              status: "UNAVAILABLE",
              reason: exchange.error ?? `HTTP_${String(exchange.status)}`,
              sessionSeqs: seqs,
            },
    };
  }
}

// =============================================================================================
// Candidate-bound prefetch cache with selective refresh
// =============================================================================================

export interface PaperSecurityEvidenceCacheLimits {
  /** Refresh calls allowed in this cache's lifetime (each is one loader load). Never renewed. */
  readonly maxRefreshes: number;
}

export interface PaperSecurityEvidenceCacheRefreshRecord {
  readonly refresh: number;
  readonly requestedAtMs: number;
  readonly plannedDecisionMs: number;
  readonly components: readonly PaperSecurityEvidenceComponent[];
  readonly completedAtMs: number;
}

export interface PaperSecurityEvidenceCacheStatus {
  readonly refreshes: number;
  readonly refusedRefreshes: number;
  readonly records: readonly PaperSecurityEvidenceCacheRefreshRecord[];
  /** Original retrieval time of each cached component (null when absent or not usable). */
  readonly retrievedAtMs: Readonly<Record<PaperSecurityEvidenceComponent, number | null>>;
  /** Components withheld from readers while their refresh is pending. */
  readonly pendingComponents: readonly PaperSecurityEvidenceComponent[];
}

const COMPONENT_KEY: Readonly<
  Record<PaperSecurityEvidenceComponent, keyof PaperCandidateSecurityEvidence>
> = Object.freeze({
  LP: "lp",
  MINT_ACCOUNT: "mintAccount",
  RUGCHECK: "rugCheck",
  BUNDLER: "bundler",
});

/**
 * Candidate-bound prefetch state on top of the loader (no other acquisition path).
 *
 * - refreshFor(plannedDecisionMs) retrieves, before a decision, only the components that are
 *   missing, were not retrieved, or would be older than the unchanged 15 s limit at the planned
 *   decision time. Calls are explicit and bounded (maxRefreshes, plus the loader's own ceiling).
 * - getEvidence() and the security path's loadEvidence() are pure reads of the cache: they never
 *   acquire. Evidence keeps its original retrieval time; the composition alone decides validity at
 *   the actual decision time, so nothing is extended or re-stamped.
 * - A dispatched refresh attempt always replaces the cached component (fail closed, even when the
 *   new response is unusable); a refused, never-sent attempt leaves the earlier evidence to age out.
 * - While a refresh is pending, every requested component is withheld from readers (absent, hence
 *   unavailable to the composition), so an earlier favourable component is never served after a
 *   newer response may already contradict it. Pending state is cleared on settlement, cancellation
 *   and exceptions; a load that fails after it started drops the requested components.
 */
export class PaperSecurityEvidenceCache {
  private readonly loader: PaperCandidateSecurityEvidenceLoader;
  private readonly target: PaperSecurityTarget;
  private readonly maxRefreshes: number;
  private evidence: PaperCandidateSecurityEvidence = Object.freeze({});
  private readonly retrievedAt: Record<PaperSecurityEvidenceComponent, number | null> = {
    LP: null,
    MINT_ACCOUNT: null,
    RUGCHECK: null,
    BUNDLER: null,
  };
  private readonly pending = new Set<PaperSecurityEvidenceComponent>();
  private refreshes = 0;
  private refusedRefreshes = 0;
  private readonly records: PaperSecurityEvidenceCacheRefreshRecord[] = [];

  constructor(options: {
    readonly loader: PaperCandidateSecurityEvidenceLoader;
    readonly target: PaperSecurityTarget;
    readonly limits: PaperSecurityEvidenceCacheLimits;
  }) {
    if (!(options?.loader instanceof PaperCandidateSecurityEvidenceLoader)) {
      throw new Error("[PAPER_SECURITY_CACHE_INIT] loader is mandatory");
    }
    const max = options.limits?.maxRefreshes;
    if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
      throw new Error(
        "[PAPER_SECURITY_CACHE_INIT] limits.maxRefreshes must be a positive safe integer",
      );
    }
    this.loader = options.loader;
    this.target = Object.freeze({ ...options.target });
    this.maxRefreshes = max;
  }

  /** Pure read of the cached evidence (no acquisition); components being refreshed are withheld. */
  public getEvidence(): PaperCandidateSecurityEvidence {
    if (this.pending.size === 0) return this.evidence;
    const visible: Record<string, unknown> = { ...this.evidence };
    for (const component of this.pending) delete visible[COMPONENT_KEY[component]];
    return Object.freeze(visible as PaperCandidateSecurityEvidence);
  }

  /** Components that must be retrieved before a decision at `plannedDecisionMs` (pure). */
  public componentsDueAt(plannedDecisionMs: number): readonly PaperSecurityEvidenceComponent[] {
    return ALL_COMPONENTS.filter((c) => {
      const at = this.retrievedAt[c];
      return (
        at === null ||
        plannedDecisionMs - at > PAPER_SECURITY_CONTEXT_POLICY.maxEvidenceAgeMs ||
        plannedDecisionMs < at
      );
    });
  }

  /** Security path for the entry helper: a pure cache read, never an acquisition. */
  public asSecurityPath(): {
    readonly executionContext: "PAPER_SIMULATION";
    readonly loadEvidence: (target: PaperSecurityTarget) => Promise<PaperCandidateSecurityEvidence>;
  } {
    return {
      executionContext: "PAPER_SIMULATION",
      loadEvidence: (target) => {
        if (
          target?.poolId !== this.target.poolId ||
          target?.mintAddress !== this.target.mintAddress
        ) {
          return Promise.reject(new Error("PAPER_SECURITY_CACHE_TARGET_MISMATCH"));
        }
        return Promise.resolve(this.getEvidence());
      },
    };
  }

  public getStatus(): PaperSecurityEvidenceCacheStatus {
    return Object.freeze({
      refreshes: this.refreshes,
      refusedRefreshes: this.refusedRefreshes,
      records: Object.freeze([...this.records]),
      retrievedAtMs: Object.freeze({ ...this.retrievedAt }),
      pendingComponents: Object.freeze([...this.pending]),
    });
  }

  /**
   * Retrieves the components due at the planned decision time. Returns the components refreshed
   * (empty when nothing is due). Throws when the refresh ceiling is reached.
   */
  public async refreshFor(
    plannedDecisionMs: number,
    signal?: AbortSignal,
  ): Promise<readonly PaperSecurityEvidenceComponent[]> {
    const due = this.componentsDueAt(plannedDecisionMs);
    if (due.length === 0) return due;
    if (this.pending.size > 0) throw new Error("PAPER_SECURITY_CACHE_REFRESH_IN_PROGRESS");
    if (this.refreshes >= this.maxRefreshes) {
      this.refusedRefreshes++;
      throw new Error("PAPER_SECURITY_CACHE_REFRESH_CEILING_REACHED");
    }
    this.refreshes++;
    const requestedAtMs = this.loader.now();
    const loadsBefore = this.loader.getStatus().loadsStarted;
    for (const component of due) this.pending.add(component);
    let loaded: PaperCandidateSecurityEvidence;
    try {
      loaded = await this.loader.load(this.target, signal, due);
    } catch (err) {
      // Refused before it started (nothing sent): earlier evidence is kept on its original time.
      // Failed after it started: requests may have been sent, so the requested components are
      // dropped rather than restored.
      if (this.loader.getStatus().loadsStarted !== loadsBefore) {
        const dropped: Record<string, unknown> = { ...this.evidence };
        for (const component of due) {
          dropped[COMPONENT_KEY[component]] = null;
          this.retrievedAt[component] = null;
        }
        this.evidence = Object.freeze(dropped as PaperCandidateSecurityEvidence);
      }
      throw err;
    } finally {
      this.pending.clear();
    }
    const record = this.loader.getStatus().records.at(-1);
    const next: Record<string, unknown> = { ...this.evidence };
    const apply = (
      component: PaperSecurityEvidenceComponent,
      key: keyof PaperCandidateSecurityEvidence,
      outcome: PaperSecurityEvidenceComponentOutcome | undefined,
      retrievedAtMs: number | null,
    ) => {
      if (!due.includes(component) || !outcome) return;
      // Never sent: keep the earlier evidence (it ages out on its original time).
      if (outcome.status !== "RETRIEVED" && outcome.sessionSeqs.length === 0) return;
      next[key] = loaded[key] ?? null;
      this.retrievedAt[component] = outcome.status === "RETRIEVED" ? retrievedAtMs : null;
    };
    const lp = loaded.lp as { retrievedAtIso?: unknown } | null | undefined;
    apply(
      "LP",
      "lp",
      record?.lp,
      typeof lp?.retrievedAtIso === "string" ? Date.parse(lp.retrievedAtIso) : null,
    );
    apply(
      "MINT_ACCOUNT",
      "mintAccount",
      record?.mintAccount,
      loaded.mintAccount?.retrievedAtMs ?? null,
    );
    apply("RUGCHECK", "rugCheck", record?.rugCheck, loaded.rugCheck?.retrievedAtMs ?? null);
    apply("BUNDLER", "bundler", record?.bundler, loaded.bundler?.retrievedAtMs ?? null);
    this.evidence = Object.freeze(next as PaperCandidateSecurityEvidence);
    this.records.push(
      Object.freeze({
        refresh: this.refreshes,
        requestedAtMs,
        plannedDecisionMs,
        components: Object.freeze([...due]),
        completedAtMs: this.loader.now(),
      }),
    );
    return due;
  }
}
