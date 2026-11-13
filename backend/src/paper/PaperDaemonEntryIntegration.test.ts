/**
 * PAPER entry integration (offline, synthetic): the actual rolling flow provider, the actual security
 * composition and the existing entry and retest evaluators, connected through the daemon's entry helper.
 *
 * - Flow: `PaperRollingCandidateFlowProvider` driven by the shared virtual scheduler with in-memory HTTP
 *   and WebSocket mocks and a SYNTHETIC chain (no network, no socket).
 * - Security: `evaluatePaperCandidateSecurityContext` over SYNTHETIC evidence returned by a mocked loader.
 * - Entry: `retrieveAndEvaluatePaperDaemonEntry` with an injected PAPER security path and mocked spot
 *   retrieval. Decisions are returned only; no buy is executed and no position is created.
 * Every favourable candidate, price and security value below is SYNTHETIC.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import {
  evaluatePaperDaemonEntryDecision,
  retrieveAndEvaluatePaperDaemonEntry,
  type PaperDaemonEntryEvaluation,
  type PaperDaemonEntrySecurityPath,
} from "../scripts/paper-trading-daemon.js";
import {
  evaluateCandidateDecisionPoints,
  type CandidateFlowProvider,
  type CandidateFlowResult,
} from "../candidate-scanner/CandidateFlowProvider.js";
import {
  BuyGateTriggerService,
  type ArmedPullbackState,
} from "../candidate-scanner/BuyGateTriggerService.js";
import { PaperRollingCandidateFlowProvider } from "../candidate-scanner/PaperRollingCandidateFlowProvider.js";
import type { PaperCandidateSecurityEvidence } from "../candidate-scanner/PaperCandidateSecurityContext.js";
import {
  MINT,
  OFFLINE_TEST_LIMITS,
  POOL_ID,
  START_MS,
  TARGET,
  TEST_RPC_URL,
  createHarness,
  drive,
  expectExecutionInvariants,
  read,
  runUntil,
  sig,
  type Harness,
} from "../candidate-scanner/PaperRollingCandidateFlowProvider.test-support.js";
import { validateSyntheticRaydiumAmmV4Snapshot } from "../candidate-scanner/fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import {
  SYNTHETIC_ACTIVE_AUTHORITY,
  SYNTHETIC_OTHER_MINT,
  syntheticMintAccountEvidence,
  syntheticMintAccountResponse,
  syntheticRugCheckReport,
  syntheticSolanaTrackerBundlersPayload,
} from "../candidate-scanner/fixtures/SyntheticPaperSecurityEvidenceFixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const iso = (ms: number) => new Date(ms).toISOString();
const PEAK_SOL = 0.0001;
/** SYNTHETIC: three swaps whose 60 s window stays complete for cutoffs between 55 s and 105 s. */
const ACTIVE_SWAPS = [
  { signature: sig(21), atMs: 45_000, side: "BUY" as const },
  { signature: sig(22), atMs: 50_000, side: "BUY" as const },
  { signature: sig(23), atMs: 55_000, side: "SELL" as const },
];

/** SYNTHETIC micro-cap candidate. `lpBurnPct: 100` is a provider-reported placeholder that must not reach the gates. */
const synthCandidate = (overrides: Partial<WatchlistCandidateItem> = {}): WatchlistCandidateItem =>
  ({
    poolId: POOL_ID,
    mintAddress: MINT,
    symbol: "SYNTH",
    liquidityUsd: 65_000,
    marketCapUsd: 250_000,
    lmcRatio: 0.26,
    lpBurnPct: 100,
    assetAgeSeconds: 600,
    volume5mUsd: 15_000,
    buys5m: 40,
    sells5m: 15,
    buyToSellRatio: 40 / 15,
    status: "WATCHING",
    discoveredAt: iso(START_MS),
    lastEvaluatedAt: iso(START_MS),
    ...overrides,
  }) as WatchlistCandidateItem;

const synthSpot = (spotPriceSol: number, liquidityUsd = 65_000) => ({
  spotPriceSol,
  spotPriceUsd: 0.015,
  liquidityUsd,
  momentum5mBps: 0,
  priceChange1hPct: 4.2,
});

/** SYNTHETIC security evidence, every component retrieved at `atMs` (98.5% LP, disabled authorities). */
async function syntheticEvidence(
  atMs: number,
  overrides: Partial<PaperCandidateSecurityEvidence> = {},
): Promise<PaperCandidateSecurityEvidence> {
  const provider = (payload: unknown) => ({
    requestedMint: MINT,
    retrievedAtMs: atMs,
    httpStatus: 200,
    bodyComplete: true,
    payload,
  });
  return {
    lp: await validateSyntheticRaydiumAmmV4Snapshot(1_000_000_000_000n, 15_000_000_000n, {
      retrievedAtIso: iso(atMs),
    }),
    mintAccount: syntheticMintAccountEvidence(atMs),
    rugCheck: provider(syntheticRugCheckReport()),
    bundler: provider(syntheticSolanaTrackerBundlersPayload()),
    ...overrides,
  };
}

const vdelay = (h: Harness, ms: number) =>
  new Promise<void>((resolve) => h.sched.add(resolve, ms, "harness"));

type Entry = PaperDaemonEntryEvaluation<ReturnType<typeof synthSpot>, never>;

interface EntryOptions {
  readonly spotPriceSol?: number;
  readonly liquidityUsd?: number;
  readonly armed?: () => ArmedPullbackState | undefined;
  readonly candidate?: WatchlistCandidateItem;
  readonly spotLatencyMs?: number;
  readonly loadLatencyMs?: number;
  /** Builds evidence when the mocked loader completes (time = virtual now). */
  readonly evidence?: (nowMs: number) => Promise<PaperCandidateSecurityEvidence>;
  readonly security?: Partial<PaperDaemonEntrySecurityPath>;
  readonly clock?: () => number;
  /** Runs inside the mocked spot retrieval, before it resolves. */
  readonly duringSpotRetrieval?: () => void;
}

/** Counting wrapper around the actual provider: records every read time and the snapshots then held. */
function recordingProvider(h: Harness) {
  const reads: number[] = [];
  const snapshotsAtRead: ReturnType<typeof h.provider.getStatus>["snapshots"][] = [];
  const provider: CandidateFlowProvider = {
    getCandidateFlow(target, evalMs) {
      reads.push(evalMs);
      snapshotsAtRead.push(h.provider.getStatus().snapshots);
      return h.provider.getCandidateFlow(target, evalMs);
    },
  };
  return { provider, reads, snapshotsAtRead };
}

function createEntryRunner(h: Harness) {
  const gateService = new BuyGateTriggerService();
  const gateSpy = vi.spyOn(gateService, "evaluateCandidate");
  const flow = recordingProvider(h);
  let directRugCheckCalls = 0;
  const launch = (opts: EntryOptions = {}): Promise<Entry> =>
    retrieveAndEvaluatePaperDaemonEntry({
      candidate: opts.candidate ?? synthCandidate(),
      flowProvider: flow.provider,
      buyGateService: gateService,
      getExistingArmedState: () => opts.armed?.(),
      clock: opts.clock ?? h.clock,
      retrievals: {
        fetchSpotInfo: async () => {
          await vdelay(h, opts.spotLatencyMs ?? 200);
          opts.duringSpotRetrieval?.();
          return synthSpot(opts.spotPriceSol ?? PEAK_SOL, opts.liquidityUsd);
        },
        fetchRugCheckMetrics: async () => {
          directRugCheckCalls++;
          throw new Error("the direct RugCheck retrieval must not be used with a security path");
        },
      },
      security: {
        executionContext: "PAPER_SIMULATION",
        loadEvidence: async () => {
          await vdelay(h, opts.loadLatencyMs ?? 300);
          return (opts.evidence ?? syntheticEvidence)(h.clock());
        },
        ...opts.security,
      } as PaperDaemonEntrySecurityPath,
    }) as Promise<Entry>;
  return { launch, gateSpy, flow, directRugCheckCalls: () => directRugCheckCalls };
}

const isFreshActive = (r: CandidateFlowResult) =>
  r.isCoverageSufficient && r.paperQualificationContext?.qualificationKind === "ACTIVE_WINDOW";

/**
 * Runs collection over the SYNTHETIC active chain and launches entries relative to the first tick at
 * which a fresh ACTIVE_WINDOW snapshot is readable. Returns the collection report and the entries.
 */
async function runWithEntries(
  h: Harness,
  plan: readonly {
    readonly offsetMs: number;
    readonly launch: (firstActiveMs: number) => Promise<Entry> | undefined;
  }[],
  stopAtMs = 140_000,
) {
  let firstActiveMs: number | null = null;
  const launched: (Promise<Entry> | undefined)[] = plan.map(() => undefined);
  const launchedAt: (number | undefined)[] = plan.map(() => undefined);
  const report = await runUntil(h, stopAtMs, {
    everyMs: 250,
    onSample: (t, r) => {
      if (firstActiveMs === null && isFreshActive(r)) firstActiveMs = t;
      if (firstActiveMs === null) return;
      plan.forEach((step, i) => {
        if (launchedAt[i] === undefined && t >= firstActiveMs! + step.offsetMs) {
          launchedAt[i] = t;
          launched[i] = step.launch(firstActiveMs!);
        }
      });
    },
  });
  expect(firstActiveMs).not.toBeNull();
  // Entries still awaiting a virtual timer when collection ends are driven to completion.
  const entries = await drive(
    h.sched,
    Promise.all(launched.map((p) => p ?? Promise.resolve(undefined))),
  );
  return { report, entries, launchedAt, firstActiveMs: firstActiveMs! };
}

const evaluated = (e: Entry | undefined) => {
  if (!e || e.kind !== "EVALUATED") throw new Error(`expected EVALUATED, got ${e?.kind}`);
  return e;
};
const securityRejected = (e: Entry | undefined) => {
  if (!e || e.kind !== "SECURITY_REJECTED")
    throw new Error(`expected SECURITY_REJECTED, got ${e?.kind}`);
  return e;
};

describe("PAPER entry integration: rolling flow + security composition + entry/retest evaluators (synthetic, offline)", () => {
  it("I-01: valid security and a qualified active window arm and then confirm under unchanged rules", async () => {
    const h = createHarness({ swaps: ACTIVE_SWAPS });
    const runner = createEntryRunner(h);
    let armed: ArmedPullbackState | undefined;
    const first = { value: undefined as Entry | undefined };
    const { report, entries, launchedAt } = await runWithEntries(h, [
      {
        offsetMs: 0,
        launch: () =>
          runner.launch().then((e) => {
            first.value = e;
            if (e.kind === "EVALUATED" && e.decision.outcome === "ARMED_FIRST_TICK") {
              armed = e.decision.retestResult.updatedArmedState;
            }
            return e;
          }),
      },
      {
        offsetMs: 5_000,
        launch: () => runner.launch({ spotPriceSol: PEAK_SOL * 0.88, armed: () => armed }),
      },
    ]);
    expectExecutionInvariants(report.status);

    const arm = evaluated(entries[0]);
    expect(arm.decision.outcome).toBe("ARMED_FIRST_TICK");
    // The final decision time is the clock after the awaited retrievals (200 + 300 ms), not the launch time.
    expect(arm.decisionNowMs).toBe(launchedAt[0]! + 500);
    expect(arm.decision.flowResult.evaluationTimestampMs).toBe(arm.decisionNowMs);
    expect(arm.decision.flowResult.isCoverageSufficient).toBe(true);
    expect(arm.decision.flowResult.recentBuys60s).toBe(2);
    expect(arm.decision.flowResult.recentSells60s).toBe(1);
    // Original cutoff and publication preserved: the window end is a published snapshot's own value.
    const windowEnd =
      arm.decision.flowResult.paperQualificationContext?.researchWindowSpan.windowEndMs;
    expect(
      runner.flow.snapshotsAtRead[0]!.some(
        (s) =>
          s.windowEndMs === windowEnd &&
          s.publishedAtMs <= arm.decisionNowMs &&
          s.withdrawnAtMs === null,
      ),
    ).toBe(true);
    // Security: evaluated at the evidence time, pre-admission passed, validated inputs used.
    expect(arm.security?.context.preAdmission.passed).toBe(true);
    expect(arm.security?.evaluatedAtMs).toBe(arm.decisionNowMs);
    expect(arm.rugMetrics).toEqual({
      rugScore: 150,
      hasDangerRisk: false,
      top10HolderPct: 0.09,
      holdersCount: 450,
      bundlerPct: 0.02,
    });
    const [gateItem, gateContext] = runner.gateSpy.mock.calls[0]!;
    expect(gateItem.lpBurnPct).toBe(98.5); // validated LP, not the provider placeholder (100)
    expect(gateContext?.bundlerPct).toBe(0.02);
    expect(gateContext?.holdersCount).toBe(450);
    expect(
      arm.decision.buyGateResult.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE")?.passed,
    ).toBe(true);

    const confirm = evaluated(entries[1]);
    expect(confirm.decision.outcome).toBe("RETEST_CONFIRMED");
    if (confirm.decision.outcome === "RETEST_CONFIRMED") {
      expect(confirm.decision.retestResult.confirmReason).toBe("RETEST_PULLBACK_DISCOUNT");
      expect(confirm.decision.retestResult.updatedArmedState.armedAtMs).toBe(arm.decisionNowMs);
    }
    expect(runner.flow.reads).toEqual([arm.decisionNowMs, confirm.decisionNowMs]);
    expect(runner.directRugCheckCalls()).toBe(0);
  });

  it("I-02: failed pre-admission blocks arming and confirmation despite favourable Gate 11 inputs", async () => {
    const h = createHarness({ swaps: ACTIVE_SWAPS });
    const runner = createEntryRunner(h);
    const activeMint = (now: number) =>
      syntheticEvidence(now, {
        mintAccount: syntheticMintAccountEvidence(now, {
          response: syntheticMintAccountResponse({
            info: { mintAuthority: SYNTHETIC_ACTIVE_AUTHORITY },
          }),
        }),
      });
    const belowLp = async (now: number) =>
      syntheticEvidence(now, {
        lp: await validateSyntheticRaydiumAmmV4Snapshot(1_000_000_000_000n, 100_000_000_001n, {
          retrievedAtIso: iso(now),
        }),
      });
    const omittedFreeze = (now: number) =>
      syntheticEvidence(now, {
        mintAccount: syntheticMintAccountEvidence(now, {
          response: syntheticMintAccountResponse({ omit: ["freezeAuthority"] }),
        }),
      });
    const armedState = (): ArmedPullbackState => ({
      mintAddress: MINT,
      armedAtMs: h.clock() - 10_000,
      peakPriceSol: PEAK_SOL,
      peakPriceUsd: 0.015,
      ticksObserved: 1,
    });
    const { entries } = await runWithEntries(h, [
      { offsetMs: 0, launch: () => runner.launch({ evidence: activeMint }) },
      {
        offsetMs: 0,
        launch: () =>
          runner.launch({ evidence: activeMint, spotPriceSol: PEAK_SOL * 0.88, armed: armedState }),
      },
      { offsetMs: 0, launch: () => runner.launch({ evidence: belowLp }) },
      { offsetMs: 0, launch: () => runner.launch({ evidence: omittedFreeze }) },
    ]);
    const reasons = entries.map((e) => securityRejected(e).reason);
    expect(reasons).toEqual([
      "PRE_ADMISSION_REJECTED:REJECTED_ACTIVE_MINT_AUTHORITY",
      "PRE_ADMISSION_REJECTED:REJECTED_ACTIVE_MINT_AUTHORITY",
      "PRE_ADMISSION_REJECTED:REJECTED_UNLOCKED_LP_RISK",
      "PRE_ADMISSION_REJECTED:REJECTED_UNKNOWN_FREEZE_AUTHORITY",
    ]);
    // Gate 11 inputs were favourable, yet no gate or flow read was reached.
    expect(securityRejected(entries[0]).security?.context.gateInputs.rugMetrics).toMatchObject({
      holdersCount: 450,
      bundlerPct: 0.02,
    });
    expect(runner.gateSpy).not.toHaveBeenCalled();
    expect(runner.flow.reads).toEqual([]);
  });

  it("I-03: stale security, warm-up flow and withdrawn flow block entry", async () => {
    const h = createHarness({ swaps: ACTIVE_SWAPS });
    const runner = createEntryRunner(h);
    const results: Promise<Entry>[] = [];
    // During warm-up (no snapshot yet), with fully valid security.
    h.sched.at(START_MS + 30_000, () => results.push(runner.launch()), true);
    const { entries } = await runWithEntries(h, [
      // Every component retrieved 15,001 ms before evaluation: LP and authorities stale.
      {
        offsetMs: 0,
        launch: () => runner.launch({ evidence: (now) => syntheticEvidence(now - 15_001) }),
      },
      // Only RugCheck stale: pre-admission passes, Gate 11 rejects.
      {
        offsetMs: 0,
        launch: () =>
          runner.launch({
            evidence: async (now) => {
              const fresh = await syntheticEvidence(now);
              return { ...fresh, rugCheck: { ...fresh.rugCheck!, retrievedAtMs: now - 15_001 } };
            },
          }),
      },
      // Fresh at launch, withdrawn during the awaited spot retrieval by a disconnect (epoch loss).
      {
        offsetMs: 1_000,
        launch: () =>
          runner.launch({
            duringSpotRetrieval: () => {
              expect(isFreshActive(read(h, h.clock()))).toBe(true);
              h.transports.at(-1)!.emitClose();
            },
          }),
      },
    ]);
    const warmUp = evaluated(await results[0]);
    expect(warmUp.decision.flowResult.isCoverageSufficient).toBe(false);
    expect(warmUp.decision.outcome).toBe("BUY_GATE_REJECTED");

    expect(securityRejected(entries[0]).reason).toBe(
      "PRE_ADMISSION_REJECTED:REJECTED_UNLOCKED_LP_RISK",
    );
    expect(securityRejected(entries[0]).security?.context.lp.status).toBe("STALE_EVIDENCE");

    const staleRug = evaluated(entries[1]);
    expect(staleRug.security?.context.rugCheck.status).toBe("STALE_RETRIEVAL_EVIDENCE");
    expect(staleRug.rugMetrics).toEqual({ bundlerPct: 0.02 });
    expect(staleRug.decision.outcome).toBe("BUY_GATE_REJECTED");
    expect(staleRug.decision.rejectionReason).toBe(
      "REJECTED_RUGCHECK_UNINDEXED_OR_HOLDERS_UNKNOWN",
    );

    const withdrawn = evaluated(entries[2]);
    expect(withdrawn.decision.flowResult.isCoverageSufficient).toBe(false);
    expect(withdrawn.decision.flowResult.diagnosticReason).toContain("EPOCH_INVALIDATED");
    expect(withdrawn.decision.outcome).toBe("BUY_GATE_REJECTED");
  });

  it("I-04: evidence that expires during awaited work is rejected at the final decision time", async () => {
    const h = createHarness({ swaps: ACTIVE_SWAPS });
    const runner = createEntryRunner(h);
    /** Injected clock: reports `elapsedMs` of awaited validation after the security evaluation's read. */
    const clockWithValidationTime = (elapsedMs: number) => {
      let reads = 0;
      return () => h.clock() + (reads++ >= 1 ? elapsedMs : 0);
    };
    const aged = (now: number) => syntheticEvidence(now - 14_000); // 14 s old when evaluated
    const { entries } = await runWithEntries(h, [
      {
        offsetMs: 0,
        launch: () => runner.launch({ evidence: aged, clock: clockWithValidationTime(2_000) }),
      },
      {
        offsetMs: 0,
        launch: () => runner.launch({ evidence: aged, clock: clockWithValidationTime(1_000) }),
      },
      // Flow fresh at launch, collection stopped during the awaited spot retrieval.
      {
        offsetMs: 2_000,
        launch: () =>
          runner.launch({
            duringSpotRetrieval: () => {
              expect(isFreshActive(read(h, h.clock()))).toBe(true);
              h.provider.stop("TEST_STOP_DURING_RETRIEVAL");
            },
          }),
      },
    ]);

    const expired = securityRejected(entries[0]);
    expect(expired.reason).toBe(
      "SECURITY_EVIDENCE_EXPIRED_AT_DECISION:LP,MINT_ACCOUNT,RUGCHECK,BUNDLER",
    );
    expect(expired.security?.context.preAdmission.passed).toBe(true); // valid at evaluation time
    expect(expired.decisionNowMs - expired.security!.evaluatedAtMs).toBe(2_000);

    // 14 s + 1 s = 15 s: still within the unchanged limit at the final time.
    const atLimit = evaluated(entries[1]);
    expect(atLimit.decisionNowMs - atLimit.security!.evaluatedAtMs).toBe(1_000);
    expect(atLimit.decision.outcome).toBe("ARMED_FIRST_TICK");
    expect(atLimit.decision.flowResult.evaluationTimestampMs).toBe(atLimit.decisionNowMs);

    const stopped = evaluated(entries[2]);
    expect(stopped.decision.flowResult.isCoverageSufficient).toBe(false);
    expect(stopped.decision.flowResult.diagnosticReason).toContain("PAPER_ROLLING_FLOW_STOPPED");
    expect(stopped.decision.outcome).toBe("BUY_GATE_REJECTED");
    // The expired entry never read flow or reached a gate; the two others each read flow once.
    expect(runner.flow.reads).toEqual([atLimit.decisionNowMs, stopped.decisionNowMs]);
  });

  it("I-05: missing evidence, identity mismatch and prohibited contexts stay rejected", async () => {
    const h = createHarness({ swaps: ACTIVE_SWAPS });
    const runner = createEntryRunner(h);
    let genericChecked = false;
    const { entries } = await runWithEntries(h, [
      { offsetMs: 0, launch: () => runner.launch({ evidence: async () => ({}) }) },
      {
        offsetMs: 0,
        launch: () =>
          runner.launch({
            evidence: () => {
              throw new Error("SYNTHETIC loader failure");
            },
          }),
      },
      {
        offsetMs: 0,
        launch: () =>
          runner.launch({
            evidence: (now) =>
              syntheticEvidence(now, {
                mintAccount: syntheticMintAccountEvidence(now, {
                  requestedMint: SYNTHETIC_OTHER_MINT,
                }),
              }),
          }),
      },
      {
        offsetMs: 0,
        launch: () =>
          runner.launch({ candidate: synthCandidate({ mintAddress: SYNTHETIC_OTHER_MINT }) }),
      },
      {
        offsetMs: 0,
        launch: () =>
          runner.launch({
            security: { executionContext: "PRODUCTION" as unknown as "PAPER_SIMULATION" },
          }),
      },
      {
        offsetMs: 0,
        launch: () => {
          // The generic production path rejects the provider's fresh PAPER evidence.
          for (const executionContext of [undefined, "PRODUCTION"] as const) {
            const generic = evaluateCandidateDecisionPoints({
              candidate: synthCandidate({ lpBurnPct: 98.5 }),
              baseSpotInfo: synthSpot(PEAK_SOL),
              rugMetrics: {
                rugScore: 150,
                hasDangerRisk: false,
                top10HolderPct: 0.09,
                holdersCount: 450,
                bundlerPct: 0.02,
              },
              flowProvider: h.provider,
              currentNowMs: h.clock(),
              requireVerifiedHolders: true,
              executionContext,
            });
            expect(generic.flowResult.diagnosticReason).toBe(
              "PAPER_QUALIFIED_EVIDENCE_REJECTED_IN_PRODUCTION",
            );
            expect(generic.outcome).toBe("BUY_GATE_REJECTED");
          }
          // A flow read for another pool or mint is unavailable.
          expect(
            h.provider.getCandidateFlow({ ...TARGET, tokenMint: SYNTHETIC_OTHER_MINT }, h.clock())
              .isCoverageSufficient,
          ).toBe(false);
          genericChecked = true;
          return undefined;
        },
      },
    ]);
    expect(entries.slice(0, 5).map((e) => securityRejected(e).reason)).toEqual([
      "PRE_ADMISSION_REJECTED:REJECTED_UNLOCKED_LP_RISK",
      "SECURITY_EVIDENCE_LOAD_FAILED: SYNTHETIC loader failure",
      "PRE_ADMISSION_REJECTED:REJECTED_UNKNOWN_FREEZE_AUTHORITY",
      "PRE_ADMISSION_REJECTED:REJECTED_UNLOCKED_LP_RISK",
      "SECURITY_CONTEXT_NOT_EVALUATED:EXECUTION_CONTEXT_PROHIBITED",
    ]);
    expect(securityRejected(entries[3]).security?.context.lp.status).toBe("IDENTITY_MISMATCH");
    expect(genericChecked).toBe(true);
    expect(runner.gateSpy).not.toHaveBeenCalled();

    // The rolling provider itself refuses any other context at construction.
    for (const executionContext of ["PRODUCTION", "BACKTEST", undefined]) {
      expect(
        () =>
          new PaperRollingCandidateFlowProvider({
            target: TARGET,
            executionContext,
            rpcUrl: TEST_RPC_URL,
            fetchFn: (() => {
              throw new Error("no fetch");
            }) as unknown as typeof fetch,
            createWebSocketTransport: () => {
              throw new Error("no socket");
            },
            limits: OFFLINE_TEST_LIMITS,
          } as unknown as ConstructorParameters<typeof PaperRollingCandidateFlowProvider>[0]),
      ).toThrow(/PAPER_SIMULATION/);
    }
  });

  it("I-06: another strategy gate rejects otherwise valid flow and security", async () => {
    const h = createHarness({ swaps: ACTIVE_SWAPS });
    const runner = createEntryRunner(h);
    const { entries } = await runWithEntries(h, [
      {
        offsetMs: 0,
        launch: () => runner.launch({ candidate: synthCandidate({ liquidityUsd: 1_000 }) }),
      },
      { offsetMs: 0, launch: () => runner.launch({ liquidityUsd: 19_999 }) },
    ]);
    const minLiquidity = evaluated(entries[0]);
    expect(minLiquidity.security?.context.preAdmission.passed).toBe(true);
    expect(minLiquidity.decision.flowResult.isCoverageSufficient).toBe(true);
    expect(
      minLiquidity.decision.buyGateResult.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE")
        ?.passed,
    ).toBe(true);
    expect(minLiquidity.decision.outcome).toBe("BUY_GATE_REJECTED");
    expect(minLiquidity.decision.rejectionReason).toBe("MIN_LIQUIDITY_GATE_FAILED");

    const thinLive = evaluated(entries[1]);
    expect(thinLive.security?.context.preAdmission.passed).toBe(true);
    expect(thinLive.decision.outcome).toBe("INSUFFICIENT_LIVE_LIQUIDITY");
  });

  it("I-07: reads add no network requests, and stopping collection leaves flow unavailable", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const h = createHarness({ swaps: ACTIVE_SWAPS });
    let checkedAt: number | null = null;
    const report = await runUntil(h, 140_000, {
      everyMs: 250,
      onSample: (t, r) => {
        if (checkedAt !== null || !isFreshActive(r)) return;
        checkedAt = t;
        const before = { ...h.counts(), fetchLog: h.fetchLog.length };
        for (let i = 0; i < 500; i++) h.provider.getCandidateFlow(TARGET, t);
        for (let i = 0; i < 5; i++) {
          evaluatePaperDaemonEntryDecision({
            candidate: synthCandidate({ lpBurnPct: 98.5 }),
            baseSpotInfo: synthSpot(PEAK_SOL),
            rugMetrics: {
              rugScore: 150,
              hasDangerRisk: false,
              top10HolderPct: 0.09,
              holdersCount: 450,
              bundlerPct: 0.02,
            },
            flowProvider: h.provider,
            currentNowMs: t,
            requireVerifiedHolders: true,
          });
        }
        expect({ ...h.counts(), fetchLog: h.fetchLog.length }).toEqual(before);
      },
    });
    expect(checkedAt).not.toBeNull();
    expectExecutionInvariants(report.status);

    // After stop: unavailable, no further requests, and the entry path cannot arm.
    const fetchesAtStop = h.fetchLog.length;
    const afterStop = h.clock();
    expect(read(h, afterStop).diagnosticReason).toContain("PAPER_ROLLING_FLOW_STOPPED");
    const runner = createEntryRunner(h);
    const entry = evaluated(await drive(h.sched, runner.launch()));
    expect(entry.decision.flowResult.isCoverageSufficient).toBe(false);
    expect(entry.decision.outcome).toBe("BUY_GATE_REJECTED");
    expect(h.fetchLog.length).toBe(fetchesAtStop);
    expect(h.provider.getStatus().activeTimers).toBe(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
