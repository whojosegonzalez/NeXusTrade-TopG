/**
 * Shared request session: rolling flow + bounded security-evidence loader + accounted spot request
 * (offline, synthetic, virtual time).
 *
 * One PaperRequestSession is shared by the actual PaperRollingCandidateFlowProvider, the actual
 * PaperCandidateSecurityEvidenceLoader and a session-routed spot-price mock. Everything runs on the
 * shared virtual scheduler with in-memory HTTP and WebSocket mocks; every chain, response, credential
 * and candidate value is SYNTHETIC. No network or socket is used. Decisions are returned only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import {
  retrieveAndEvaluatePaperDaemonEntry,
  type PaperDaemonEntryEvaluation,
} from "../scripts/paper-trading-daemon.js";
import {
  PaperRequestSession,
  PAPER_REQUEST_LANES,
  type PaperRequestSessionLimits,
  type PaperRequestSessionStatus,
} from "../candidate-scanner/PaperRequestSession.js";
import {
  PaperCandidateSecurityEvidenceLoader,
  type PaperSecurityEvidenceLoaderLimits,
} from "../candidate-scanner/PaperCandidateSecurityEvidenceLoader.js";
import {
  evaluatePaperCandidateSecurityContext,
  type PaperCandidateSecurityEvidence,
} from "../candidate-scanner/PaperCandidateSecurityContext.js";
import type { CandidateFlowResult } from "../candidate-scanner/CandidateFlowProvider.js";
import {
  MINT,
  POOL_ID,
  START_MS,
  TARGET,
  TEST_RPC_URL,
  createHarness,
  drive,
  sig,
  type Harness,
} from "../candidate-scanner/PaperRollingCandidateFlowProvider.test-support.js";
import { SYNTHETIC_QUALIFIED_RAW_PAYLOAD } from "../candidate-scanner/fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import {
  SYNTHETIC_OTHER_MINT,
  syntheticMintAccountResponse,
  syntheticRugCheckReport,
  syntheticSolanaTrackerBundlersPayload,
} from "../candidate-scanner/fixtures/SyntheticPaperSecurityEvidenceFixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * OFFLINE TEST CONFIGURATION ONLY. Not approved for live execution.
 * Solana: the flow provider's own ceiling is 300 (OFFLINE_TEST_LIMITS); each security load adds at
 * most 3 Solana requests (LP pool account, LP account batch, mint account).
 */
const SESSION_TEST_LIMITS: PaperRequestSessionLimits = Object.freeze({
  lifetimeMs: 600_000,
  maxHttpAttempts: 330,
  requestTimeoutMs: 5_000,
  lanes: Object.freeze({
    SOLANA_RPC: { maxAttempts: 315, pacingMs: 2_500, maxResponseBytes: 65_536 },
    RUGCHECK: { maxAttempts: 5, pacingMs: 5_000, maxResponseBytes: 262_144 },
    SOLANA_TRACKER: { maxAttempts: 5, pacingMs: 5_000, maxResponseBytes: 262_144 },
    DEXSCREENER: { maxAttempts: 5, pacingMs: 1_000, maxResponseBytes: 65_536 },
  }),
});
const LOADER_TEST_LIMITS: PaperSecurityEvidenceLoaderLimits = Object.freeze({
  lpAcquisitionTimeoutMs: 30_000,
  maxLoads: 3,
});
const SYNTHETIC_TRACKER_KEY = "SYNTHETIC-TRACKER-KEY-0000";
const RUGCHECK_URL = "http://rugcheck.synthetic.test";
const TRACKER_URL = "http://solanatracker.synthetic.test";
const SPOT_URL = "http://dexscreener.synthetic.test";
const PEAK_SOL = 0.0001;
/** SYNTHETIC: three swaps whose 60 s window stays complete for cutoffs between 55 s and 105 s. */
const ACTIVE_SWAPS = [
  { signature: sig(31), atMs: 45_000, side: "BUY" as const },
  { signature: sig(32), atMs: 50_000, side: "BUY" as const },
  { signature: sig(33), atMs: 55_000, side: "SELL" as const },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Overrides = {
  readonly session?: Partial<PaperRequestSessionLimits>;
  readonly lanes?: Partial<PaperRequestSessionLimits["lanes"]>;
  readonly rugCheck?: (now: number) => Response;
  readonly bundlers?: (now: number) => Response;
  readonly latencyFor?: (methodOrPath: string, now: number) => number | undefined;
};

/** Harness with one shared session over the SYNTHETIC transport (flow, security and spot). */
function sharedHarness(o: Overrides = {}) {
  const h = createHarness({
    swaps: ACTIVE_SWAPS,
    ...(o.latencyFor ? { latencyFor: o.latencyFor } : {}),
    rpcResult: (method, params) => {
      if (method === "getAccountInfo" && params[0] === MINT) {
        return { result: (syntheticMintAccountResponse() as { result: unknown }).result };
      }
      if (method === "getMultipleAccounts") {
        return { result: (SYNTHETIC_QUALIFIED_RAW_PAYLOAD as { result: unknown }).result };
      }
      return undefined;
    },
    otherHttp: ({ path, now }) => {
      if (path === `/v1/tokens/${MINT}/report`) {
        return o.rugCheck?.(now) ?? json(syntheticRugCheckReport());
      }
      if (path === `/tokens/${MINT}/bundlers`) {
        return o.bundlers?.(now) ?? json(syntheticSolanaTrackerBundlersPayload());
      }
      if (path === `/latest/dex/tokens/${MINT}`) {
        return json({ SYNTHETIC: true, spotPriceSol: PEAK_SOL, liquidityUsd: 65_000 });
      }
      return undefined;
    },
    session: ({ fetchFn, clock, timers }) =>
      new PaperRequestSession({
        executionContext: "PAPER_SIMULATION",
        fetchFn,
        limits: {
          ...SESSION_TEST_LIMITS,
          ...(o.session ?? {}),
          lanes: { ...SESSION_TEST_LIMITS.lanes, ...(o.lanes ?? {}) },
        },
        clock,
        timers,
      }),
  });
  const session = h.session!;
  const loader = new PaperCandidateSecurityEvidenceLoader({
    executionContext: "PAPER_SIMULATION",
    target: { poolId: POOL_ID, mintAddress: MINT },
    session,
    solanaRpcUrl: TEST_RPC_URL,
    rugCheckApiUrl: RUGCHECK_URL,
    solanaTrackerApiUrl: TRACKER_URL,
    solanaTrackerApiKey: SYNTHETIC_TRACKER_KEY,
    lpEvidenceOrigin: "SYNTHETIC_FIXTURE",
    limits: LOADER_TEST_LIMITS,
  });
  return { h, session, loader };
}

/** Session-routed SYNTHETIC spot retrieval: the spot request is counted in the same ledger. */
const sessionSpot =
  (session: PaperRequestSession, spotPriceSol = PEAK_SOL) =>
  async () => {
    const exchange = await session.dispatch({
      lane: "DEXSCREENER",
      owner: "SPOT",
      purpose: "SPOT_PRICE",
      requestedIdentity: MINT,
      url: `${SPOT_URL}/latest/dex/tokens/${MINT}`,
      method: "GET",
    });
    if (!exchange.ok || !exchange.bodyComplete) return null;
    const body = JSON.parse(exchange.text!) as { spotPriceSol: number; liquidityUsd: number };
    return {
      spotPriceSol: spotPriceSol ?? body.spotPriceSol,
      spotPriceUsd: 0.015,
      liquidityUsd: body.liquidityUsd,
      momentum5mBps: 0,
      priceChange1hPct: 4.2,
    };
  };

const synthCandidate = (): WatchlistCandidateItem =>
  ({
    poolId: POOL_ID,
    mintAddress: MINT,
    symbol: "SYNTH",
    liquidityUsd: 65_000,
    marketCapUsd: 250_000,
    lmcRatio: 0.26,
    lpBurnPct: 100, // provider-reported placeholder; replaced by validated LP
    assetAgeSeconds: 600,
    volume5mUsd: 15_000,
    buys5m: 40,
    sells5m: 15,
    buyToSellRatio: 40 / 15,
    status: "WATCHING",
    discoveredAt: new Date(START_MS).toISOString(),
    lastEvaluatedAt: new Date(START_MS).toISOString(),
  }) as WatchlistCandidateItem;

type Entry = PaperDaemonEntryEvaluation<
  Awaited<ReturnType<ReturnType<typeof sessionSpot>>> & object,
  never
>;

const launchEntry = (env: ReturnType<typeof sharedHarness>): Promise<Entry> =>
  retrieveAndEvaluatePaperDaemonEntry({
    candidate: synthCandidate(),
    flowProvider: env.h.provider,
    getExistingArmedState: () => undefined,
    clock: env.h.clock,
    retrievals: {
      fetchSpotInfo: sessionSpot(env.session),
      fetchRugCheckMetrics: async () => {
        throw new Error("the direct RugCheck retrieval must not be used");
      },
    },
    security: {
      executionContext: "PAPER_SIMULATION",
      loadEvidence: (target) => env.loader.load(target),
    },
  }) as Promise<Entry>;

const isFreshActive = (r: CandidateFlowResult) =>
  r.isCoverageSufficient && r.paperQualificationContext?.qualificationKind === "ACTIVE_WINDOW";

/**
 * Opens the session, starts flow collection, launches work at the first fresh active tick (or at a
 * fixed time), then stops flow and the session and drives everything to completion.
 */
async function runShared(
  env: ReturnType<typeof sharedHarness>,
  plan: {
    readonly atFirstActive?: (firstActiveMs: number) => Promise<unknown>;
    readonly atMs?: { readonly atMs: number; readonly run: () => Promise<unknown> };
    readonly stopAtMs?: number;
  },
) {
  const { h, session } = env;
  session.open();
  const collection = h.provider.start();
  let firstActiveMs: number | null = null;
  let launched: Promise<unknown> | undefined;
  const tick = () => {
    if (h.provider.getStatus().state === "STOPPED") return;
    const r = h.provider.getCandidateFlow(TARGET, h.sched.now);
    if (firstActiveMs === null && isFreshActive(r)) {
      firstActiveMs = h.sched.now;
      if (plan.atFirstActive) launched = plan.atFirstActive(firstActiveMs);
    }
    h.sched.add(tick, 250, "harness", true);
  };
  h.sched.add(tick, 0, "harness", true);
  if (plan.atMs) h.sched.at(START_MS + plan.atMs.atMs, () => (launched = plan.atMs!.run()), true);
  h.sched.at(START_MS + (plan.stopAtMs ?? 140_000), () => h.provider.stop("TEST_WINDOW_END"), true);
  const report = await drive(h.sched, collection);
  const result = await drive(h.sched, Promise.resolve(launched));
  session.stop("TEST_END");
  await drive(h.sched, Promise.resolve());
  return { report, result, firstActiveMs };
}

/** One ledger; counted once; lane pacing; no Solana overlap; nothing after the deadline. */
function expectSessionInvariants(status: PaperRequestSessionStatus) {
  const { ledger } = status;
  expect(ledger.map((e) => e.seq)).toEqual(ledger.map((_, i) => i + 1));
  expect(status.budgetManagerAttempts).toBe(status.httpAttempts);
  expect(status.httpAttempts).toBe(ledger.length);
  for (const lane of PAPER_REQUEST_LANES) {
    const entries = ledger.filter((e) => e.lane === lane);
    expect(status.attemptsByLane[lane]).toBe(entries.length);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.dispatchedAtMs - entries[i - 1]!.dispatchedAtMs).toBeGreaterThanOrEqual(
        SESSION_TEST_LIMITS.lanes[lane].pacingMs,
      );
      // Serialized lanes: each request completes before the next is sent.
      expect(entries[i - 1]!.completedAtMs!).toBeLessThanOrEqual(entries[i]!.dispatchedAtMs);
    }
  }
  expect(status.maxConcurrentByLane.SOLANA_RPC).toBeLessThanOrEqual(1);
  expect(ledger.every((e) => e.dispatchedAtMs < status.deadlineMs!)).toBe(true);
}

const sentAfter = (h: Harness, count: number) => h.fetchLog.length - count;

describe("Shared PAPER request session: flow + security loader + spot (synthetic, offline)", () => {
  it("B-01: valid evidence reaches the composition and the entry helper; flow and security interleave on one paced Solana lane", async () => {
    const env = sharedHarness();
    const { report, result, firstActiveMs } = await runShared(env, {
      atFirstActive: () => launchEntry(env),
    });
    expect(firstActiveMs).not.toBeNull();
    const entry = result as Entry;
    expect(entry.kind).toBe("EVALUATED");
    if (entry.kind !== "EVALUATED") return;
    const ctx = entry.security!.context;
    expect(ctx.lp.status).toBe("AVAILABLE_QUALIFIED");
    expect(ctx.lp.lpBurnPct).toBe(98.5);
    expect(ctx.lp.screening?.evidenceOrigin).toBe("SYNTHETIC_FIXTURE");
    expect(ctx.authorities.status).toBe("AVAILABLE");
    expect(ctx.rugCheck.status).toBe("AVAILABLE");
    expect(ctx.bundler.status).toBe("QUALIFIED_PAPER_PROXY");
    expect(ctx.preAdmission.passed).toBe(true);
    expect(entry.decision.flowResult.evaluationTimestampMs).toBe(entry.decisionNowMs);
    // Security evidence is valid and still within 15 s at the final time (it reached the gates).
    const record = env.loader.getStatus().records[0]!;
    expect(record.completedAtMs - record.startedAtMs).toBeLessThan(15_000);
    expect(entry.security!.evaluatedAtMs).toBe(entry.decisionNowMs);
    // Finding: the load's three Solana requests are paced into the middle of a flow refresh, which
    // delays the next publication past the final decision; the newest snapshot is then older than
    // 15 s, and the final decision rejects it under the unchanged rules.
    expect(entry.decision.flowResult.isCoverageSufficient).toBe(false);
    expect(entry.decision.flowResult.diagnosticReason).toContain("STALE_RECONCILIATION_EVIDENCE");
    expect(entry.decision.outcome).toBe("BUY_GATE_REJECTED");

    const status = env.session.getStatus();
    expectSessionInvariants(status);
    const owners = new Set(status.ledger.map((e) => e.owner));
    expect(owners).toEqual(new Set(["FLOW", "SECURITY", "SPOT"]));
    // Security Solana requests sit between flow Solana requests on the same lane.
    const solana = status.ledger.filter((e) => e.lane === "SOLANA_RPC");
    const firstSecurity = solana.findIndex((e) => e.owner === "SECURITY");
    expect(firstSecurity).toBeGreaterThan(0);
    expect(solana.slice(firstSecurity).some((e) => e.owner === "FLOW")).toBe(true);
    // One flow refresh (GET_SLOT ... GET_BLOCK_TIME) has security requests paced inside it.
    const slotIdx = solana
      .map((e, i) => (i < firstSecurity && e.purpose === "GET_SLOT" ? i : -1))
      .reduce((a, b) => Math.max(a, b), -1);
    expect(slotIdx).toBeGreaterThanOrEqual(0);
    const blockIdx = solana.findIndex((e, i) => i > slotIdx && e.purpose === "GET_BLOCK_TIME");
    expect(solana.slice(slotIdx + 1, blockIdx).every((e) => e.owner === "SECURITY")).toBe(true);
    expect(blockIdx - slotIdx - 1).toBeGreaterThanOrEqual(2);
    expect(
      solana
        .filter((e) => e.owner === "SECURITY")
        .map((e) => e.purpose)
        .sort(),
    ).toEqual(["CANDIDATE_MINT_ACCOUNT", "LP_ACQUISITION", "LP_ACQUISITION"]);
    // Request identity, ids, original times, status and completeness recorded for each component.
    const mintEntry = status.ledger.find((e) => e.purpose === "CANDIDATE_MINT_ACCOUNT")!;
    expect(mintEntry).toMatchObject({
      requestedIdentity: MINT,
      httpStatus: 200,
      bodyComplete: true,
    });
    expect(ctx.authorities.provenance?.retrievedAtMs).toBe(mintEntry.dispatchedAtMs);
    expect(ctx.authorities.provenance?.requestId).toBe(mintEntry.jsonRpcId);
    expect(report.status.sessionHttpAttempts).toBe(status.httpAttempts);
    expect(report.status.httpAttempts).toBe(status.ledger.filter((e) => e.owner === "FLOW").length);
    // The credential is sent as a header only; it never appears in evidence, status or ledger.
    const trackerCall = env.h.fetchLog.find((c) => c.url.startsWith(TRACKER_URL))!;
    expect((trackerCall.init?.headers as Record<string, string>)["x-api-key"]).toBe(
      SYNTHETIC_TRACKER_KEY,
    );
    const serialized = JSON.stringify(
      [status, env.loader.getStatus(), entry.security, report.status],
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
    );
    expect(serialized).not.toContain(SYNTHETIC_TRACKER_KEY);
    expect(serialized).not.toContain(TEST_RPC_URL);
    // Every HTTP call went through the session: transport calls equal ledger dispatches.
    expect(env.h.fetchLog.length).toBe(status.httpAttempts);
  });

  it("B-02: imports, construction, status reads and decision reads do not acquire; boundaries are enforced", async () => {
    const env = sharedHarness();
    expect(env.h.fetchLog.length).toBe(0);
    expect(env.loader.getStatus().loadsStarted).toBe(0);
    // Before open(): nothing can be sent.
    const early = await drive(env.h.sched, env.loader.load({ poolId: POOL_ID, mintAddress: MINT }));
    expect(early.lp).toBeNull();
    expect(early.mintAccount).toBeNull();
    expect(early.rugCheck).toBeNull();
    expect(env.loader.getStatus().records[0]!.rugCheck).toMatchObject({
      status: "UNAVAILABLE",
      reason: "REQUEST_SESSION_NOT_OPEN",
    });
    expect(env.h.fetchLog.length).toBe(0);

    // Prohibited contexts, identities and missing transports.
    expect(
      () =>
        new PaperRequestSession({
          executionContext: "PRODUCTION",
          fetchFn: env.h.fetchFn,
          limits: SESSION_TEST_LIMITS,
        } as unknown as ConstructorParameters<typeof PaperRequestSession>[0]),
    ).toThrow(/PAPER_SIMULATION/);
    expect(
      () =>
        new PaperRequestSession({
          executionContext: "PAPER_SIMULATION",
          fetchFn: env.h.fetchFn,
          limits: {
            ...SESSION_TEST_LIMITS,
            lanes: {
              ...SESSION_TEST_LIMITS.lanes,
              SOLANA_RPC: { maxAttempts: 5, pacingMs: 2_499, maxResponseBytes: 1 },
            },
          },
        }),
    ).toThrow(/2500/);
    const loaderOptions = {
      executionContext: "PAPER_SIMULATION" as const,
      target: { poolId: POOL_ID, mintAddress: MINT },
      session: env.session,
      solanaRpcUrl: TEST_RPC_URL,
      rugCheckApiUrl: RUGCHECK_URL,
      solanaTrackerApiUrl: TRACKER_URL,
      lpEvidenceOrigin: "SYNTHETIC_FIXTURE" as const,
      limits: LOADER_TEST_LIMITS,
    };
    for (const bad of [
      { executionContext: "PRODUCTION" },
      { executionContext: "BACKTEST" },
      { target: { poolId: "not-base58", mintAddress: MINT } },
      { target: { poolId: POOL_ID, mintAddress: "" } },
      { session: {} },
      { limits: { ...LOADER_TEST_LIMITS, lpAcquisitionTimeoutMs: 2_000 } },
    ]) {
      expect(
        () =>
          new PaperCandidateSecurityEvidenceLoader({
            ...loaderOptions,
            ...bad,
          } as unknown as ConstructorParameters<typeof PaperCandidateSecurityEvidenceLoader>[0]),
      ).toThrow(/PAPER_SECURITY_LOADER_INIT/);
    }
    await expect(
      env.loader.load({ poolId: POOL_ID, mintAddress: SYNTHETIC_OTHER_MINT }),
    ).rejects.toThrow("PAPER_SECURITY_LOADER_TARGET_MISMATCH");

    // During collection: status reads, flow reads and re-evaluating loaded evidence send nothing.
    let evidence: PaperCandidateSecurityEvidence | undefined;
    let checked = false;
    await runShared(env, {
      atFirstActive: async () => {
        evidence = await env.loader.load({ poolId: POOL_ID, mintAddress: MINT });
        const before = env.h.fetchLog.length;
        const ledgerBefore = env.session.getStatus().httpAttempts;
        for (let i = 0; i < 200; i++) {
          env.loader.getStatus();
          env.session.getStatus();
          env.h.provider.getCandidateFlow(TARGET, env.h.clock());
        }
        for (let i = 0; i < 3; i++) {
          await evaluatePaperCandidateSecurityContext({
            executionContext: "PAPER_SIMULATION",
            target: { poolId: POOL_ID, mintAddress: MINT },
            decisionTimeMs: env.h.clock(),
            evidence: evidence!,
          });
        }
        expect(env.h.fetchLog.length).toBe(before);
        expect(env.session.getStatus().httpAttempts).toBe(ledgerBefore);
        checked = true;
      },
    });
    expect(checked).toBe(true);
    expectSessionInvariants(env.session.getStatus());
  });

  it("B-03: the shared ceiling stops everything; a lane ceiling refuses only its lane; refusals are not counted", async () => {
    // Session-wide ceiling of 6: flow setup (2) + one security load (5) cannot both fit.
    const tight = sharedHarness({
      session: { maxHttpAttempts: 6 },
      lanes: {
        SOLANA_RPC: { maxAttempts: 6, pacingMs: 2_500, maxResponseBytes: 65_536 },
        RUGCHECK: { maxAttempts: 5, pacingMs: 5_000, maxResponseBytes: 262_144 },
        SOLANA_TRACKER: { maxAttempts: 5, pacingMs: 5_000, maxResponseBytes: 262_144 },
        DEXSCREENER: { maxAttempts: 5, pacingMs: 1_000, maxResponseBytes: 65_536 },
      },
    });
    let evidence: PaperCandidateSecurityEvidence | undefined;
    const { report } = await runShared(tight, {
      atMs: {
        atMs: 1_000,
        run: async () =>
          (evidence = await tight.loader.load({ poolId: POOL_ID, mintAddress: MINT })),
      },
    });
    const status = tight.session.getStatus();
    expect(status.httpAttempts).toBe(6);
    expect(tight.h.fetchLog.length).toBe(6);
    expect(status.stopReason).toBe("HTTP_ATTEMPT_CEILING_REACHED");
    expect(report.stopReason).toBe("HTTP_ATTEMPT_CEILING_REACHED");
    const outcomes = tight.loader.getStatus().records[0]!;
    expect(
      [outcomes.lp, outcomes.mintAccount, outcomes.rugCheck, outcomes.bundler].some(
        (o) => o.status === "UNAVAILABLE",
      ),
    ).toBe(true);
    expect(evidence).toBeDefined();
    expectSessionInvariants(status);

    // A lane ceiling of 0 for RugCheck: refused and not counted; flow and other lanes continue.
    const laneCap = sharedHarness({
      lanes: { RUGCHECK: { maxAttempts: 0, pacingMs: 5_000, maxResponseBytes: 262_144 } },
    });
    let laneEntry: Entry | undefined;
    const laneRun = await runShared(laneCap, {
      atFirstActive: async () => (laneEntry = await launchEntry(laneCap)),
    });
    expect(laneCap.loader.getStatus().records[0]!.rugCheck).toMatchObject({
      status: "UNAVAILABLE",
      reason: "RUGCHECK_ATTEMPT_CEILING_REACHED",
    });
    expect(laneCap.session.getStatus().attemptsByLane.RUGCHECK).toBe(0);
    expect(laneRun.report.stopReason).toBe("TEST_WINDOW_END");
    expect(laneEntry?.kind === "EVALUATED" && laneEntry.security?.context.rugCheck.status).toBe(
      "EVIDENCE_MISSING",
    );
    expect(laneEntry?.kind === "EVALUATED" && laneEntry.decision.outcome).toBe("BUY_GATE_REJECTED");
    expectSessionInvariants(laneCap.session.getStatus());
  });

  it("B-04: the first 429, the session deadline and loader cancellation prevent later sends", async () => {
    // First 429 on RugCheck: the whole session stops at its headers; flow stops with it.
    let at429: number | null = null;
    const throttled = sharedHarness({
      rugCheck: (now) => {
        at429 = now;
        return new Response("SYNTHETIC throttled", { status: 429 });
      },
    });
    let throttledEntry: Entry | undefined;
    const t = await runShared(throttled, {
      atFirstActive: async () => (throttledEntry = await launchEntry(throttled)),
    });
    expect(throttled.session.getStatus().stopReason).toBe("HTTP_429_RECEIVED");
    expect(throttled.session.getStatus().stoppedAtMs).toBe(at429);
    expect(t.report.status.stoppedAtMs).toBe(at429);
    expect(t.report.stopReason).toBe("HTTP_429_RECEIVED");
    expect(
      throttled.h.provider.getCandidateFlow(TARGET, throttled.h.clock()).diagnosticReason,
    ).toContain("PAPER_ROLLING_FLOW_STOPPED");
    const ledger = throttled.session.getStatus().ledger;
    expect(ledger.every((e) => e.dispatchedAtMs <= at429!)).toBe(true);
    expect(throttledEntry?.kind).not.toBe(undefined);
    expect(
      throttledEntry?.kind === "EVALUATED" ? throttledEntry.decision.outcome : throttledEntry?.kind,
    ).not.toBe("ARMED_FIRST_TICK");
    expectSessionInvariants(throttled.session.getStatus());

    // Session lifetime of 70 s: no dispatch at or after the deadline; flow stops with the session.
    // The RugCheck response takes 4.9 s, so that request is still in flight at the deadline.
    const short = sharedHarness({
      session: { lifetimeMs: 70_000 },
      latencyFor: (m) => (m.endsWith("/report") ? 4_900 : undefined),
    });
    const s = await runShared(short, {
      atMs: { atMs: 66_000, run: () => short.loader.load({ poolId: POOL_ID, mintAddress: MINT }) },
    });
    const shortStatus = short.session.getStatus();
    expect(shortStatus.stopReason).toBe("LIFETIME_EXPIRED");
    // Stopped at the deadline itself, not at a later dispatch attempt.
    expect(shortStatus.stoppedAtMs).toBe(START_MS + 70_000);
    expect(s.report.status.stoppedAtMs).toBe(START_MS + 70_000);
    expect(s.report.stopReason).toBe("LIFETIME_EXPIRED");
    expect(shortStatus.ledger.every((e) => e.dispatchedAtMs < START_MS + 70_000)).toBe(true);
    // Loader alone (no flow, no pacing wait pending): only the session's own deadline can end the
    // in-flight RugCheck request.
    const lone = sharedHarness({
      session: { lifetimeMs: 2_000 },
      lanes: { SOLANA_RPC: { maxAttempts: 0, pacingMs: 2_500, maxResponseBytes: 65_536 } },
      latencyFor: (m) => (m.endsWith("/report") ? 4_900 : undefined),
    });
    lone.session.open();
    await drive(lone.h.sched, lone.loader.load({ poolId: POOL_ID, mintAddress: MINT }));
    const loneStatus = lone.session.getStatus();
    expect(loneStatus.stopReason).toBe("LIFETIME_EXPIRED");
    expect(loneStatus.stoppedAtMs).toBe(START_MS + 2_000);
    expect(loneStatus.ledger.find((e) => e.lane === "RUGCHECK")).toMatchObject({
      completedAtMs: START_MS + 2_000,
      error: "REQUEST_ABORTED",
    });
    expect(loneStatus.activeTimers).toBe(0);
    expect(lone.loader.getStatus().records[0]!.mintAccount).toMatchObject({
      reason: "SOLANA_RPC_ATTEMPT_CEILING_REACHED",
    });

    // In-flight work is aborted at the deadline: nothing completes after it.
    expect(shortStatus.ledger.every((e) => e.completedAtMs! <= START_MS + 70_000)).toBe(true);
    expect(shortStatus.ledger.find((e) => e.lane === "RUGCHECK")).toMatchObject({
      completedAtMs: START_MS + 70_000,
      error: "REQUEST_ABORTED",
      bodyComplete: false,
    });
    expectSessionInvariants(shortStatus);

    // Loader cancellation during a load: its pending requests are never sent or counted.
    const cancelled = sharedHarness({
      latencyFor: (m) => (m === "getAccountInfo" ? 2_000 : undefined),
    });
    let sentAtCancel = 0;
    const c = await runShared(cancelled, {
      atMs: {
        atMs: 1_000,
        run: async () => {
          const load = cancelled.loader.load({ poolId: POOL_ID, mintAddress: MINT });
          cancelled.h.sched.at(START_MS + 1_100, () => {
            sentAtCancel = cancelled.h.fetchLog.length;
            cancelled.loader.cancelLoads("TEST_CANCEL");
          });
          return load;
        },
      },
      stopAtMs: 30_000,
    });
    const cancelledStatus = cancelled.session.getStatus();
    const securityAfter = cancelledStatus.ledger.filter(
      (e) => e.owner === "SECURITY" && e.dispatchedAtMs > START_MS + 1_100,
    );
    expect(securityAfter).toEqual([]);
    expect(sentAfter(cancelled.h, sentAtCancel)).toBe(
      cancelledStatus.ledger.filter((e) => e.dispatchedAtMs > START_MS + 1_100).length,
    );
    expect(c.report.stopReason).toBe("TEST_WINDOW_END"); // flow is unaffected by a loader cancel
    await expect(cancelled.loader.load({ poolId: POOL_ID, mintAddress: MINT })).rejects.toThrow(
      "PAPER_SECURITY_LOADER_CANCELLED",
    );
    expectSessionInvariants(cancelledStatus);
  });

  it("B-05: oversized, partial, redirected and mismatched responses stay unavailable", async () => {
    // Oversized RugCheck body (lane limit 256 bytes) and a bundler body that never completes.
    const bounded = sharedHarness({
      lanes: { RUGCHECK: { maxAttempts: 5, pacingMs: 5_000, maxResponseBytes: 256 } },
      bundlers: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"total": 12, "balance": '));
            },
          }),
          { status: 200 },
        ),
    });
    let boundedEntry: Entry | undefined;
    await runShared(bounded, {
      atFirstActive: async () => (boundedEntry = await launchEntry(bounded)),
    });
    const b = boundedEntry?.kind === "EVALUATED" ? boundedEntry : undefined;
    expect(b?.security?.context.rugCheck.status).toBe("RESPONSE_INCOMPLETE");
    expect(b?.security?.context.bundler.status).toBe("RESPONSE_INCOMPLETE");
    const boundedLedger = bounded.session.getStatus().ledger;
    expect(boundedLedger.find((e) => e.lane === "RUGCHECK")).toMatchObject({
      bodyComplete: false,
      error: "RESPONSE_TOO_LARGE",
    });
    expect(boundedLedger.find((e) => e.lane === "SOLANA_TRACKER")).toMatchObject({
      bodyComplete: false,
      error: "REQUEST_TIMED_OUT",
    });
    expect(b?.decision.outcome).toBe("BUY_GATE_REJECTED");

    // A RugCheck report for another mint.
    const mismatched = sharedHarness({
      rugCheck: () => json(syntheticRugCheckReport({ mint: SYNTHETIC_OTHER_MINT })),
    });
    let mismatchedEntry: Entry | undefined;
    await runShared(mismatched, {
      atFirstActive: async () => (mismatchedEntry = await launchEntry(mismatched)),
    });
    expect(
      mismatchedEntry?.kind === "EVALUATED" && mismatchedEntry.security?.context.rugCheck.status,
    ).toBe("PAYLOAD_MINT_MISMATCH");

    // A redirect from Solana Tracker: never followed, and the session stops.
    const redirected = sharedHarness({
      bundlers: () =>
        new Response(null, { status: 302, headers: { location: "http://elsewhere.test/" } }),
    });
    await runShared(redirected, { atFirstActive: () => launchEntry(redirected) });
    expect(redirected.session.getStatus().stopReason).toBe("HTTP_REDIRECT_REJECTED");
    expect(redirected.h.fetchLog.every((c) => !c.url.startsWith("http://elsewhere.test"))).toBe(
      true,
    );
    expect(redirected.h.fetchLog.find((c) => c.url.startsWith(TRACKER_URL))?.init?.redirect).toBe(
      "manual",
    );
    for (const env of [bounded, mismatched, redirected])
      expectSessionInvariants(env.session.getStatus());
  });

  it("B-06: acquisition delays on the shared lane make evidence or flow stale, and the final decision rejects it", async () => {
    // Slow SYNTHETIC Solana responses for the security requests (4.9 s each) hold the shared lane.
    const slow = sharedHarness({
      latencyFor: (m) =>
        m === "getAccountInfo" || m === "getMultipleAccounts" ? 4_900 : undefined,
    });
    let entry: Entry | undefined;
    let launchedAt = 0;
    await runShared(slow, {
      atFirstActive: async (t) => {
        launchedAt = t;
        entry = await launchEntry(slow);
      },
    });
    if (!entry || entry.kind === "NO_ACTIVE_DEX_PAIR") throw new Error("expected a decision");
    const final = entry.decisionNowMs;
    const record = slow.loader.getStatus().records[0]!;
    expect(record.completedAtMs - record.startedAtMs).toBeGreaterThan(15_000);
    const ctx = entry.security?.context;
    // The RugCheck and bundler requests were sent at the start of the load: more than 15 s old.
    expect(ctx?.rugCheck.status).toBe("STALE_RETRIEVAL_EVIDENCE");
    expect(ctx?.bundler.status).toBe("ADAPTER_REJECTED:STALE_RETRIEVAL_EVIDENCE");
    if (entry.kind === "EVALUATED") {
      expect(entry.decision.outcome).toBe("BUY_GATE_REJECTED");
      expect(entry.decision.flowResult.evaluationTimestampMs).toBe(final);
    }
    expect(final - launchedAt).toBeGreaterThan(15_000);
    expectSessionInvariants(slow.session.getStatus());
  });

  it("B-07: cleanup leaves no active collection, request or timer, and a stopped session sends nothing", async () => {
    const env = sharedHarness();
    await runShared(env, { atFirstActive: () => launchEntry(env) });
    const status = env.session.getStatus();
    expect(status.state).toBe("STOPPED");
    expect(status.inFlight).toBe(0);
    expect(status.activeTimers).toBe(0);
    expect(env.h.provider.getStatus().state).toBe("STOPPED");
    expect(env.h.provider.getStatus().activeTimers).toBe(0);
    expect(env.h.sched.count("provider")).toBe(0);
    expect(env.loader.getStatus().inFlight).toBe(false);
    const sent = env.h.fetchLog.length;
    const after = await drive(env.h.sched, env.loader.load({ poolId: POOL_ID, mintAddress: MINT }));
    expect([after.lp, after.mintAccount, after.rugCheck, after.bundler]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(env.loader.getStatus().records.at(-1)!.mintAccount).toMatchObject({
      reason: "REQUEST_SESSION_STOPPED",
    });
    expect(env.h.fetchLog.length).toBe(sent);
    expect(env.session.getStatus().activeTimers).toBe(0);
  });
});
