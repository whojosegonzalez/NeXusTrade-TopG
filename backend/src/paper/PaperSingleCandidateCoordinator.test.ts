/**
 * PaperSingleCandidateCoordinator (offline, synthetic, virtual time).
 *
 * The coordinator builds the accepted components on one request session (rolling flow provider,
 * security-evidence loader and cache, validated-LP scanner, entry helper) and schedules them for ONE
 * fixed candidate. Transports are the shared in-memory mocks on the shared virtual scheduler; every
 * chain, market, security and candidate value is SYNTHETIC. No network, socket, daemon, position or
 * order is involved; decisions are records only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PaperSingleCandidateCoordinator,
  type PaperCoordinatorLimits,
  type PaperCoordinatorMarketParser,
  type PaperSingleCandidateCoordinatorOptions,
} from "../candidate-scanner/PaperSingleCandidateCoordinator.js";
import { PAPER_REQUEST_LANES } from "../candidate-scanner/PaperRequestSession.js";
import { CANDIDATE_SCANNER_DEFAULTS } from "../candidate-scanner/CandidateScannerConfig.js";
import {
  MINT,
  OFFLINE_TEST_LIMITS,
  POOL_ID,
  START_MS,
  TEST_RPC_URL,
  createHarness,
  drive,
  sig,
  type Harness,
} from "../candidate-scanner/PaperRollingCandidateFlowProvider.test-support.js";
import {
  SYNTHETIC_QUALIFIED_RAW_PAYLOAD,
  createSyntheticRayCandidatePool,
  createSyntheticRaydiumAmmV4RawBatchPayload,
} from "../candidate-scanner/fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import {
  SYNTHETIC_ACTIVE_AUTHORITY,
  SYNTHETIC_OTHER_MINT,
  syntheticMintAccountResponse,
  syntheticRugCheckReport,
  syntheticSolanaTrackerBundlersPayload,
} from "../candidate-scanner/fixtures/SyntheticPaperSecurityEvidenceFixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const RUGCHECK_URL = "http://rugcheck.synthetic.test";
const TRACKER_URL = "http://solanatracker.synthetic.test";
const MARKET_URL = `http://dexscreener.synthetic.test/latest/dex/tokens/${MINT}`;
const PEAK_SOL = 0.0001;
const OTHER_POOL = "Em6rHi68trYgBFyJ5261A2nhwuQWfLcirgzZZYoRcrkX"; // canonical, not the candidate
/** SYNTHETIC: three swaps whose 60 s window stays complete for cutoffs between 55 s and 105 s. */
const ACTIVE_SWAPS = [
  { signature: sig(41), atMs: 45_000, side: "BUY" as const },
  { signature: sig(42), atMs: 50_000, side: "BUY" as const },
  { signature: sig(43), atMs: 55_000, side: "SELL" as const },
];

/** OFFLINE TEST CONFIGURATION ONLY. Not approved for live execution. */
const TEST_LIMITS: PaperCoordinatorLimits = Object.freeze({
  session: {
    lifetimeMs: 150_000,
    maxHttpAttempts: 120,
    requestTimeoutMs: 5_000,
    lanes: {
      SOLANA_RPC: { maxAttempts: 110, pacingMs: 2_500, maxResponseBytes: 65_536 },
      RUGCHECK: { maxAttempts: 5, pacingMs: 5_000, maxResponseBytes: 262_144 },
      SOLANA_TRACKER: { maxAttempts: 5, pacingMs: 5_000, maxResponseBytes: 262_144 },
      DEXSCREENER: { maxAttempts: 10, pacingMs: 1_000, maxResponseBytes: 65_536 },
    },
  },
  flow: { ...OFFLINE_TEST_LIMITS, lifetimeMs: 150_000, maxHttpAttempts: 100 },
  loader: { lpAcquisitionTimeoutMs: 30_000, maxLoads: 4 },
  cache: { maxRefreshes: 4 },
  schedule: {
    prefetchLeadMs: 6_000,
    confirmDelayMs: 5_000,
    decisionIntervalMs: 5_000,
    decisionLeadMs: 500,
    refreshHorizonMs: 10_000,
    tickMs: 250,
    maxDecisions: 6,
    maxPrefetchEpochs: 2,
  },
});

/** SYNTHETIC market parser (the caller's pure mapping of the one accounted market request). */
const parseMarket: PaperCoordinatorMarketParser = (json) => {
  const m = json as Record<string, number | string | null> | null;
  if (!m || (m as { SYNTHETIC?: unknown }).SYNTHETIC !== true) return null;
  return {
    pool: createSyntheticRayCandidatePool({
      poolId: String(m.poolId),
      mintAddress: String(m.mintAddress),
      liquidityUsd: Number(m.liquidityUsd),
      marketCapUsd: Number(m.marketCapUsd),
      openTimeSec: Number(m.openTimeSec),
      volume5mUsd: Number(m.volume5mUsd),
      txCount5m: Number(m.txCount5m),
      buys5m: Number(m.buys5m),
      sells5m: Number(m.sells5m),
      lpBurnPct: Number(m.lpBurnPct), // provider placeholder; the validated path replaces it
      mintAuthority: null, // provider-assumed; the validated path replaces it
      freezeAuthority: null,
    }),
    spot: {
      spotPriceSol: Number(m.priceSol),
      spotPriceUsd: 0.015,
      liquidityUsd: Number(m.liquidityUsd),
      momentum5mBps: 0,
      priceChange1hPct: 4.2,
    },
  };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type EnvOptions = {
  readonly limits?: Partial<{
    [K in keyof PaperCoordinatorLimits]: Partial<PaperCoordinatorLimits[K]>;
  }>;
  readonly lanes?: Partial<PaperCoordinatorLimits["session"]["lanes"]>;
  readonly batchResult?: () => unknown;
  readonly mintResult?: () => unknown;
  readonly rugCheck?: (call: number, now: number) => Response;
  readonly market?: (now: number) => Record<string, unknown>;
  readonly latencyFor?: (methodOrPath: string, now: number) => number | undefined;
};

/** Harness transports + one coordinator over them. The harness's own provider is never started. */
function coordinatorEnv(o: EnvOptions = {}) {
  let rugCheckCalls = 0;
  const ref: { coordinator?: PaperSingleCandidateCoordinator } = {};
  const h: Harness = createHarness({
    swaps: ACTIVE_SWAPS,
    ...(o.latencyFor ? { latencyFor: o.latencyFor } : {}),
    rpcResult: (method, params) => {
      if (method === "getAccountInfo" && params[0] === MINT) {
        return {
          result: ((o.mintResult?.() ?? syntheticMintAccountResponse()) as { result: unknown })
            .result,
        };
      }
      if (method === "getMultipleAccounts") {
        return {
          result: ((o.batchResult?.() ?? SYNTHETIC_QUALIFIED_RAW_PAYLOAD) as { result: unknown })
            .result,
        };
      }
      return undefined;
    },
    otherHttp: ({ path, now }) => {
      if (path === `/v1/tokens/${MINT}/report`) {
        rugCheckCalls++;
        return o.rugCheck?.(rugCheckCalls, now) ?? json(syntheticRugCheckReport());
      }
      if (path === `/tokens/${MINT}/bundlers`) return json(syntheticSolanaTrackerBundlersPayload());
      if (path === `/latest/dex/tokens/${MINT}`) {
        // SYNTHETIC: the price pulls back 12% once the candidate is armed.
        const armed = ref.coordinator?.getStatus().armedAtMs != null;
        return json({
          SYNTHETIC: true,
          poolId: POOL_ID,
          mintAddress: MINT,
          priceSol: armed ? PEAK_SOL * 0.88 : PEAK_SOL,
          liquidityUsd: 65_000,
          marketCapUsd: 250_000,
          openTimeSec: Math.floor(now / 1000) - 600,
          volume5mUsd: 15_000,
          txCount5m: 55,
          buys5m: 40,
          sells5m: 15,
          lpBurnPct: 100,
          ...(o.market?.(now) ?? {}),
        });
      }
      return undefined;
    },
  });
  const l = o.limits ?? {};
  const limits: PaperCoordinatorLimits = {
    session: {
      ...TEST_LIMITS.session,
      ...(l.session ?? {}),
      lanes: { ...TEST_LIMITS.session.lanes, ...(o.lanes ?? {}) },
    } as PaperCoordinatorLimits["session"],
    flow: { ...TEST_LIMITS.flow, ...(l.flow ?? {}) } as PaperCoordinatorLimits["flow"],
    loader: { ...TEST_LIMITS.loader, ...(l.loader ?? {}) } as PaperCoordinatorLimits["loader"],
    cache: { ...TEST_LIMITS.cache, ...(l.cache ?? {}) } as PaperCoordinatorLimits["cache"],
    schedule: {
      ...TEST_LIMITS.schedule,
      ...(l.schedule ?? {}),
    } as PaperCoordinatorLimits["schedule"],
  };
  const options: PaperSingleCandidateCoordinatorOptions = {
    executionContext: "PAPER_SIMULATION",
    target: { poolId: POOL_ID, mintAddress: MINT },
    transports: { fetchFn: h.fetchFn, createWebSocketTransport: h.createWebSocketTransport },
    endpoints: {
      solanaRpcUrl: TEST_RPC_URL,
      rugCheckApiUrl: RUGCHECK_URL,
      solanaTrackerApiUrl: TRACKER_URL,
      marketUrl: MARKET_URL,
    },
    credentials: { solanaTrackerApiKey: "SYNTHETIC-TRACKER-KEY-0000" },
    market: { parse: parseMarket },
    scannerConfig: CANDIDATE_SCANNER_DEFAULTS,
    lpEvidenceOrigin: "SYNTHETIC_FIXTURE",
    limits,
    clock: h.clock,
    timers: h.timers,
  };
  const coordinator = new PaperSingleCandidateCoordinator(options);
  ref.coordinator = coordinator;
  return { h, coordinator, options, rugCheckCalls: () => rugCheckCalls };
}

const run = (env: ReturnType<typeof coordinatorEnv>) => drive(env.h.sched, env.coordinator.start());

/** One ledger; counted once; each lane paced and serialized; nothing after the deadline. */
function expectSessionInvariants(env: ReturnType<typeof coordinatorEnv>) {
  const status = env.coordinator.getSessionStatus();
  const ledger = status.ledger;
  expect(ledger.map((e) => e.seq)).toEqual(ledger.map((_, i) => i + 1));
  expect(status.budgetManagerAttempts).toBe(status.httpAttempts);
  expect(env.h.fetchLog.length).toBe(status.httpAttempts); // every transport call is in the ledger
  for (const lane of PAPER_REQUEST_LANES) {
    const entries = ledger.filter((e) => e.lane === lane);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.dispatchedAtMs - entries[i - 1]!.dispatchedAtMs).toBeGreaterThanOrEqual(
        TEST_LIMITS.session.lanes[lane].pacingMs,
      );
      expect(entries[i - 1]!.completedAtMs!).toBeLessThanOrEqual(entries[i]!.dispatchedAtMs);
    }
  }
  expect(status.maxConcurrentByLane.SOLANA_RPC).toBeLessThanOrEqual(1);
  expect(ledger.every((e) => e.dispatchedAtMs < status.deadlineMs!)).toBe(true);
}

/** Nothing left: no active collection, request or timer, and nothing more is ever sent. */
async function expectCleanStop(env: ReturnType<typeof coordinatorEnv>) {
  const sent = env.h.fetchLog.length;
  expect(env.coordinator.getStatus().state).toBe("STOPPED");
  expect(env.coordinator.getStatus().activeTimers).toBe(0);
  expect(env.coordinator.getSessionStatus().state).toBe("STOPPED");
  expect(env.coordinator.getSessionStatus().inFlight).toBe(0);
  expect(env.coordinator.getSessionStatus().activeTimers).toBe(0);
  expect(env.coordinator.getFlowStatus().state).toBe("STOPPED");
  expect(env.coordinator.getFlowStatus().activeTimers).toBe(0);
  expect(env.h.sched.count("provider")).toBe(0);
  // Let any remaining harness timers run: no further request may follow.
  await drive(env.h.sched, new Promise<void>((r) => env.h.sched.at(env.h.clock() + 60_000, r)));
  expect(env.h.fetchLog.length).toBe(sent);
  await expect(env.coordinator.start()).rejects.toThrow("start() may be called only once");
}

const decisionsOf = (env: ReturnType<typeof coordinatorEnv>) =>
  env.coordinator.getStatus().decisions;

describe("PaperSingleCandidateCoordinator (synthetic, offline)", () => {
  it("C-01: the coordinator schedules a passing arm-and-confirm from the warm-up lifecycle", async () => {
    const env = coordinatorEnv();
    const report = await run(env);
    const status = report.status;
    // Prefetch derived from the subscription: observation start + 65 s warm-up - 6 s lead.
    const [prefetch] = status.schedule.prefetches;
    expect(prefetch!.atMs).toBe(prefetch!.observationStartMs + 65_000 - 6_000);
    expect(status.intake).toMatchObject({ state: "ADMITTED", reason: null });
    expect(status.decisions.map((d) => [d.outcome, d.action])).toEqual([
      ["ARMED_FIRST_TICK", "ARMED"],
      ["RETEST_CONFIRMED", "CONFIRMED"],
    ]);
    expect(report.stopReason).toBe("ENTRY_CONFIRMED_NO_EXECUTION");
    for (const d of status.decisions) {
      expect(d.preAdmissionPassed).toBe(true);
      expect(d.securityStatuses).toEqual({
        lp: "AVAILABLE_QUALIFIED",
        authorities: "AVAILABLE",
        rugCheck: "AVAILABLE",
        bundler: "QUALIFIED_PAPER_PROXY",
      });
      expect(d.flowCutoffAgeMs!).toBeLessThanOrEqual(15_000);
    }
    const [arm, confirm] = status.decisions;
    // The confirmation is launched no earlier than its planned time (arm + confirmDelayMs).
    expect(confirm!.launchedAtMs).toBeGreaterThanOrEqual(arm!.decisionAtMs! + 5_000);
    // Selective refresh after the arm (LP reused), and one prefetch for the one epoch.
    const refreshes = env.coordinator.getCacheStatus().records;
    expect(refreshes[0]!.components).toEqual(["LP", "MINT_ACCOUNT", "RUGCHECK", "BUNDLER"]);
    expect(refreshes.slice(1).every((r) => !r.components.includes("LP"))).toBe(true);
    // Market requests: one intake + one per decision, all in the session ledger.
    const market = env.coordinator
      .getSessionStatus()
      .ledger.filter((e) => e.lane === "DEXSCREENER");
    expect(market.map((e) => e.purpose)).toEqual(["MARKET_INTAKE", "SPOT_PRICE", "SPOT_PRICE"]);
    expectSessionInvariants(env);
    await expectCleanStop(env);
  });

  it("C-02: latency, expired evidence, pending refreshes, adverse replacements and withdrawn flow are rejected", async () => {
    // Expired evidence: one refresh allowed (the prefetch). The mint evidence would be stale at the
    // planned confirmation and cannot be refreshed: no decision consumes it, and the coordinator stops.
    const expired = coordinatorEnv({ limits: { cache: { maxRefreshes: 1 } } });
    const er = await run(expired);
    const ed = decisionsOf(expired);
    expect(ed.map((d) => d.outcome)).toEqual(["ARMED_FIRST_TICK"]);
    expect(er.stopReason).toBe(
      "SECURITY_REFRESH_BUDGET_EXHAUSTED:PAPER_SECURITY_CACHE_REFRESH_CEILING_REACHED",
    );
    expect(expired.coordinator.getStatus().refreshErrors).toEqual([
      "PAPER_SECURITY_CACHE_REFRESH_CEILING_REACHED",
    ]);
    expect(ed.some((d) => d.action === "CONFIRMED")).toBe(false);
    await expectCleanStop(expired);

    // Pending refresh with an adverse replacement: the refreshed RugCheck reports danger while the
    // slow mint request is pending; no decision runs while pending, and the confirmation fails Gate 11.
    const adverse = coordinatorEnv({
      rugCheck: (call) =>
        call === 1
          ? json(syntheticRugCheckReport())
          : json(
              syntheticRugCheckReport({ risks: [{ name: "SYNTHETIC danger", level: "danger" }] }),
            ),
      // Only the post-arm mint request (sent between 75 s and 80 s) is slow: 1.5 s.
      latencyFor: (m, now) =>
        m === "getAccountInfo" && now >= START_MS + 75_000 && now < START_MS + 80_000
          ? 1_500
          : undefined,
    });
    await run(adverse);
    const ad = decisionsOf(adverse);
    expect(ad[0]).toMatchObject({ outcome: "ARMED_FIRST_TICK" });
    expect(adverse.coordinator.getStatus().skippedTicks.REFRESH_PENDING).toBeGreaterThan(0);
    const refresh = adverse.coordinator.getCacheStatus().records[1]!;
    expect(
      ad.every(
        (d) => d.launchedAtMs < refresh.requestedAtMs || d.launchedAtMs >= refresh.completedAtMs,
      ),
    ).toBe(true);
    expect(ad[1]).toMatchObject({
      outcome: "BUY_GATE_REJECTED",
      reason: "RUGCHECK_DANGER_FLAG_FAILED",
      action: "DISARMED",
    });
    expect(ad.some((d) => d.action === "CONFIRMED")).toBe(false);
    await expectCleanStop(adverse);

    // Withdrawn flow: a disconnect right after the arm; the confirmation is rejected and disarms;
    // the reconnect's new epoch gets its own derived prefetch.
    let disconnected = false;
    const withdrawn = coordinatorEnv({
      market: () => {
        if (!disconnected && withdrawn.coordinator.getStatus().armedAtMs !== null) {
          disconnected = true;
          withdrawn.h.transports.at(-1)!.emitClose();
        }
        return {};
      },
    });
    await run(withdrawn);
    const wd = decisionsOf(withdrawn);
    expect(wd[0]).toMatchObject({ outcome: "ARMED_FIRST_TICK" });
    expect(wd[1]).toMatchObject({ outcome: "BUY_GATE_REJECTED", action: "DISARMED" });
    expect(wd[1]!.flowReason).toContain("EPOCH_INVALIDATED");
    const prefetches = withdrawn.coordinator.getStatus().schedule.prefetches;
    expect(prefetches.map((p) => p.epoch)).toEqual([1, 2]);
    expect(prefetches[1]!.atMs).toBe(prefetches[1]!.observationStartMs + 65_000 - 6_000);
    expect(wd.some((d) => d.action === "CONFIRMED")).toBe(false);
    await expectCleanStop(withdrawn);

    // Latency: slow security Solana responses hold the shared lane; nothing stale is accepted.
    const slow = coordinatorEnv({
      latencyFor: (m) =>
        m === "getAccountInfo" || m === "getMultipleAccounts" ? 4_900 : undefined,
    });
    await run(slow);
    const sd = decisionsOf(slow);
    expect(sd.some((d) => d.action === "CONFIRMED")).toBe(false);
    for (const d of sd.filter((x) => x.kind === "EVALUATED" && x.outcome !== "BUY_GATE_REJECTED")) {
      expect(d.preAdmissionPassed).toBe(true);
      expect(d.flowCutoffAgeMs!).toBeLessThanOrEqual(15_000);
    }
    await expectCleanStop(slow);
    for (const env of [expired, adverse, withdrawn, slow]) expectSessionInvariants(env);
  });

  it("C-03: the validated-LP scanner rejects missing, mismatched and below-threshold LP, and assumed authorities", async () => {
    const cases: readonly (readonly [string, EnvOptions, RegExp])[] = [
      [
        "below threshold (one more circulating unit than 90%)",
        {
          batchResult: () =>
            createSyntheticRaydiumAmmV4RawBatchPayload(1_000_000_000_000n, 100_000_000_001n),
        },
        /^SCANNER_REJECTED:REJECTED_UNLOCKED_LP_RISK$/,
      ],
      [
        "missing (account batch answered with an RPC error)",
        { batchResult: () => ({ result: null }) },
        /^SCANNER_REJECTED:REJECTED_UNLOCKED_LP_RISK$/,
      ],
      [
        "mismatched (pool accounts for another base mint)",
        {
          batchResult: () =>
            createSyntheticRaydiumAmmV4RawBatchPayload(1_000_000_000_000n, 15_000_000_000n, {
              baseMint: SYNTHETIC_OTHER_MINT,
            }),
        },
        /^SCANNER_REJECTED:/,
      ],
      [
        "active mint authority (provider assumed null)",
        {
          mintResult: () =>
            syntheticMintAccountResponse({ info: { mintAuthority: SYNTHETIC_ACTIVE_AUTHORITY } }),
        },
        /^SCANNER_REJECTED:REJECTED_ACTIVE_MINT_AUTHORITY$/,
      ],
      [
        "omitted freeze authority (provider assumed null)",
        { mintResult: () => syntheticMintAccountResponse({ omit: ["freezeAuthority"] }) },
        /^SCANNER_REJECTED:REJECTED_ACTIVE_FREEZE_AUTHORITY$/,
      ],
      [
        "market snapshot for another pool",
        { market: () => ({ poolId: OTHER_POOL }) },
        /^MARKET_IDENTITY_MISMATCH$/,
      ],
    ];
    for (const [label, opts, reason] of cases) {
      const env = coordinatorEnv(opts);
      const report = await run(env);
      expect(report.status.intake.state, label).toBe("REJECTED");
      expect(report.status.intake.reason, label).toMatch(reason);
      expect(report.stopReason, label).toBe(`INTAKE_REJECTED:${report.status.intake.reason}`);
      expect(report.status.decisions, label).toEqual([]);
      const market = env.coordinator
        .getSessionStatus()
        .ledger.filter((e) => e.lane === "DEXSCREENER");
      expect(
        market.map((e) => e.purpose),
        label,
      ).toEqual(["MARKET_INTAKE"]); // no spot request
      expectSessionInvariants(env);
      await expectCleanStop(env);
    }
  });

  it("C-04: construction is inert; stop, exhaustion, deadline and session failure end everything", async () => {
    // Inert construction and status reads.
    const inert = coordinatorEnv();
    for (let i = 0; i < 100; i++) inert.coordinator.getStatus();
    expect(inert.h.fetchLog.length).toBe(0);
    expect(inert.h.sched.count("provider")).toBe(0);
    expect(inert.coordinator.getSessionStatus().state).toBe("NOT_OPEN");

    // Explicit stop during the prefetch: pending requests are not sent; nothing follows.
    const stopped = coordinatorEnv({
      latencyFor: (m) => (m === "getAccountInfo" ? 2_000 : undefined),
    });
    const done = stopped.coordinator.start();
    let sentAtStop = 0;
    stopped.h.sched.at(START_MS + 62_500, () => {
      sentAtStop = stopped.h.fetchLog.length;
      stopped.coordinator.stop("TEST_STOP");
    });
    const sr = await drive(stopped.h.sched, done);
    expect(sr.stopReason).toBe("TEST_STOP");
    expect(stopped.h.fetchLog.length).toBe(sentAtStop);
    expect(sr.status.decisions).toEqual([]);
    await expectCleanStop(stopped);

    // Solana-lane exhaustion ends collection, which ends the coordinator.
    const exhausted = coordinatorEnv({
      // Four Solana requests: flow's setup (2) and two retrievals; the third retrieval is refused.
      lanes: { SOLANA_RPC: { maxAttempts: 4, pacingMs: 2_500, maxResponseBytes: 65_536 } },
    });
    const er = await run(exhausted);
    expect(er.stopReason).toBe("FLOW_COLLECTION_ENDED:SOLANA_RPC_ATTEMPT_CEILING_REACHED");
    await expectCleanStop(exhausted);

    // Session deadline.
    const short = coordinatorEnv({
      limits: { session: { lifetimeMs: 70_000 }, flow: { lifetimeMs: 70_000 } },
    });
    const dr = await run(short);
    expect(dr.stopReason).toMatch(/LIFETIME_EXPIRED/);
    expect(
      short.coordinator
        .getSessionStatus()
        .ledger.every((e) => e.dispatchedAtMs < START_MS + 70_000),
    ).toBe(true);
    await expectCleanStop(short);

    // Terminal session failure: the first 429 (RugCheck) stops the session and the coordinator.
    const throttled = coordinatorEnv({
      rugCheck: () => new Response("SYNTHETIC", { status: 429 }),
    });
    const tr = await run(throttled);
    expect(tr.stopReason).toBe("REQUEST_SESSION_STOPPED:HTTP_429_RECEIVED");
    expect(tr.status.decisions).toEqual([]);
    await expectCleanStop(throttled);

    // Construction boundaries.
    for (const bad of [
      { executionContext: "PRODUCTION" },
      { target: { poolId: "not-base58", mintAddress: MINT } },
      { target: { poolId: MINT, mintAddress: MINT } },
      { limits: { ...TEST_LIMITS, schedule: { ...TEST_LIMITS.schedule, maxDecisions: 0 } } },
      {
        limits: { ...TEST_LIMITS, schedule: { ...TEST_LIMITS.schedule, refreshHorizonMs: 15_001 } },
      },
    ]) {
      expect(
        () =>
          new PaperSingleCandidateCoordinator({
            ...inert.options,
            ...bad,
          } as unknown as PaperSingleCandidateCoordinatorOptions),
      ).toThrow(/PAPER_COORDINATOR_INIT|PAPER_SIMULATION/);
    }
  });

  it("C-05: reads never acquire, and nothing reruns automatically", async () => {
    const env = coordinatorEnv();
    let checked = false;
    env.h.sched.at(START_MS + 75_000, () => {
      const sent = env.h.fetchLog.length;
      for (let i = 0; i < 200; i++) {
        env.coordinator.getStatus();
        env.coordinator.getSessionStatus();
        env.coordinator.getFlowStatus();
        env.coordinator.getCacheStatus();
        env.coordinator.getLoaderStatus();
      }
      expect(env.h.fetchLog.length).toBe(sent);
      checked = true;
    });
    const report = await run(env);
    expect(checked).toBe(true);
    // Bounded: one prefetch per epoch, at most maxDecisions decisions, one intake, no rerun.
    expect(report.status.schedule.prefetches).toHaveLength(1);
    expect(report.status.decisions.length).toBeLessThanOrEqual(TEST_LIMITS.schedule.maxDecisions);
    expect(env.coordinator.getCacheStatus().refreshes).toBeLessThanOrEqual(
      TEST_LIMITS.cache.maxRefreshes,
    );
    expect(
      env.coordinator.getSessionStatus().ledger.filter((e) => e.purpose === "MARKET_INTAKE"),
    ).toHaveLength(1);
    await expectCleanStop(env);
  });
});
