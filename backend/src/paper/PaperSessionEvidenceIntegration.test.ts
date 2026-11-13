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
  PaperSecurityEvidenceCache,
  type PaperSecurityEvidenceLoaderLimits,
} from "../candidate-scanner/PaperCandidateSecurityEvidenceLoader.js";
import type { ArmedPullbackState } from "../candidate-scanner/BuyGateTriggerService.js";
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
  readonly respond?: Parameters<typeof createHarness>[0] extends infer O
    ? O extends { readonly respond?: infer R }
      ? R
      : never
    : never;
  readonly providerLimits?: Parameters<typeof createHarness>[0] extends infer O
    ? O extends { readonly limits?: infer L }
      ? L
      : never
    : never;
};

/** Harness with one shared session over the SYNTHETIC transport (flow, security and spot). */
function sharedHarness(o: Overrides = {}) {
  const h = createHarness({
    swaps: ACTIVE_SWAPS,
    ...(o.latencyFor ? { latencyFor: o.latencyFor } : {}),
    ...(o.respond ? { respond: o.respond } : {}),
    ...(o.providerLimits ? { limits: o.providerLimits } : {}),
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

// ---------------------------------------------------------------------------------------------
// Boundary corrections and prefetch with selective refresh
// ---------------------------------------------------------------------------------------------

type PrefetchTimeline = {
  prefetchAtMs?: number;
  prefetchRetrievedAt?: Readonly<Record<string, number | null>>;
  armAtMs?: number;
  armFlowCutoffAgeMs?: number | null;
  armSecurityAgesMs?: Record<string, number | null>;
  refreshComponents?: readonly string[];
  refreshError?: string;
  refreshCompletedAtMs?: number;
  confirmAtMs?: number;
  confirmFlowCutoffAgeMs?: number | null;
  confirmSecurityAgesMs?: Record<string, number | null>;
};

const ages = (cache: PaperSecurityEvidenceCache, atMs: number) =>
  Object.fromEntries(
    Object.entries(cache.getStatus().retrievedAtMs).map(([k, v]) => [
      k,
      v === null ? null : atMs - v,
    ]),
  );
const cutoffAge = (e: Entry | undefined) =>
  e && e.kind === "EVALUATED"
    ? (e.decision.flowResult.paperQualificationContext?.cutoffAgeMs ?? null)
    : null;

/**
 * SYNTHETIC prefetch schedule: one prefetch, an arm at the first fresh active tick, an optional
 * selective refresh for a confirmation `confirmDelayMs` later, then the confirmation.
 */
async function runPrefetchSchedule(
  env: ReturnType<typeof sharedHarness>,
  opts: {
    readonly prefetchAtMs: number;
    readonly confirmDelayMs: number;
    readonly refreshBeforeConfirm: boolean;
    readonly maxRefreshes?: number;
    readonly afterArm?: () => void;
  },
) {
  const { h, session } = env;
  const cache = new PaperSecurityEvidenceCache({
    loader: env.loader,
    target: { poolId: POOL_ID, mintAddress: MINT },
    limits: { maxRefreshes: opts.maxRefreshes ?? 3 },
  });
  const timeline: PrefetchTimeline = {};
  let armed: ArmedPullbackState | undefined;
  let arm: Entry | undefined;
  let confirm: Entry | undefined;
  let prefetched = false;
  let armLaunched = false;
  const pending: Promise<unknown>[] = [];
  const decide = (spotPriceSol: number, existing?: ArmedPullbackState) =>
    retrieveAndEvaluatePaperDaemonEntry({
      candidate: synthCandidate(),
      flowProvider: h.provider,
      getExistingArmedState: () => existing,
      clock: h.clock,
      retrievals: {
        fetchSpotInfo: sessionSpot(session, spotPriceSol),
        fetchRugCheckMetrics: async () => {
          throw new Error("the direct RugCheck retrieval must not be used");
        },
      },
      security: cache.asSecurityPath(),
    }) as Promise<Entry>;

  session.open();
  const collection = h.provider.start();
  h.sched.at(START_MS + opts.prefetchAtMs, () => {
    timeline.prefetchAtMs = opts.prefetchAtMs;
    pending.push(
      cache.refreshFor(START_MS + opts.prefetchAtMs + 15_000).then(() => {
        prefetched = true;
        timeline.prefetchRetrievedAt = Object.fromEntries(
          Object.entries(cache.getStatus().retrievedAtMs).map(([k, v]) => [
            k,
            v === null ? null : v - START_MS,
          ]),
        );
      }),
    );
  });
  const tick = () => {
    if (h.provider.getStatus().state === "STOPPED") return;
    if (
      !armLaunched &&
      prefetched &&
      isFreshActive(h.provider.getCandidateFlow(TARGET, h.sched.now))
    ) {
      armLaunched = true;
      pending.push(
        decide(PEAK_SOL).then(async (e) => {
          if (e.kind === "NO_ACTIVE_DEX_PAIR") throw new Error("SYNTHETIC spot missing");
          arm = e;
          timeline.armAtMs = e.decisionNowMs - START_MS;
          timeline.armFlowCutoffAgeMs = cutoffAge(e);
          timeline.armSecurityAgesMs = ages(cache, e.decisionNowMs);
          if (e.kind === "EVALUATED" && e.decision.outcome === "ARMED_FIRST_TICK") {
            armed = e.decision.retestResult.updatedArmedState;
          }
          opts.afterArm?.();
          const planned = e.decisionNowMs + opts.confirmDelayMs;
          if (opts.refreshBeforeConfirm) {
            try {
              timeline.refreshComponents = await cache.refreshFor(planned);
            } catch (err) {
              timeline.refreshError = err instanceof Error ? err.message : String(err);
            }
            timeline.refreshCompletedAtMs = h.clock() - START_MS;
          }
          const at = Math.max(planned, h.clock());
          await new Promise<void>((resolve) => h.sched.at(at, () => resolve()));
          const c = await decide(PEAK_SOL * 0.88, armed);
          if (c.kind === "NO_ACTIVE_DEX_PAIR") throw new Error("SYNTHETIC spot missing");
          confirm = c;
          timeline.confirmAtMs = c.decisionNowMs - START_MS;
          timeline.confirmFlowCutoffAgeMs = cutoffAge(c);
          timeline.confirmSecurityAgesMs = ages(cache, c.decisionNowMs);
        }),
      );
    }
    h.sched.add(tick, 250, "harness", true);
  };
  h.sched.add(tick, 0, "harness", true);
  h.sched.at(START_MS + 140_000, () => h.provider.stop("TEST_WINDOW_END"), true);
  const report = await drive(h.sched, collection);
  await drive(h.sched, Promise.all(pending));
  session.stop("TEST_END");
  await drive(h.sched, Promise.resolve());
  return { report, cache, timeline, arm, confirm };
}

describe("Shared-session boundary corrections and evidence prefetch (synthetic, offline)", () => {
  it("B-08: an exhausted Solana lane during a refresh ends flow collection once, while global and provider capacity remain", async () => {
    const env = sharedHarness({
      lanes: { SOLANA_RPC: { maxAttempts: 6, pacingMs: 2_500, maxResponseBytes: 65_536 } },
    });
    env.session.open();
    // Collection ends by itself (no test stop is scheduled), promptly and exactly once.
    const report = await drive(env.h.sched, env.h.provider.start());
    // Other lanes keep working after the Solana lane is exhausted; the session is still open.
    expect(env.session.isOpen()).toBe(true);
    await drive(
      env.h.sched,
      env.loader.load({ poolId: POOL_ID, mintAddress: MINT }, undefined, ["RUGCHECK"]),
    );
    env.session.stop("TEST_END");
    const status = env.session.getStatus();
    // Setup (2) + three retrievals + GET_SLOT = 6; the refresh's GET_BLOCK_TIME is refused.
    expect(report.status.ledger.map((e) => e.purpose).at(-1)).toBe("GET_SLOT");
    expect(report.stopReason).toBe("SOLANA_RPC_ATTEMPT_CEILING_REACHED");
    expect(status.refusalsByReason.SOLANA_RPC_ATTEMPT_CEILING_REACHED).toBe(1);
    expect(report.status.stoppedAtMs).toBe(report.status.ledger.at(-1)!.completedAtMs);
    expect(report.status.snapshots.every((s) => s.withdrawnReason !== null)).toBe(true);
    expect(env.h.provider.getCandidateFlow(TARGET, env.h.clock()).diagnosticReason).toContain(
      "PAPER_ROLLING_FLOW_STOPPED: SOLANA_RPC_ATTEMPT_CEILING_REACHED",
    );
    // Global (330) and provider-local (300) capacity remained; counters were not reset.
    expect(status.httpAttempts).toBeLessThan(SESSION_TEST_LIMITS.maxHttpAttempts);
    expect(report.status.httpAttempts).toBeLessThan(300);
    expect(status.attemptsByLane.SOLANA_RPC).toBe(6);
    expect(status.attemptsByLane.RUGCHECK).toBe(1);
    expect(env.loader.getStatus().records[0]!.rugCheck.status).toBe("RETRIEVED");
    expect(status.stopReason).toBe("TEST_END"); // the session itself was not stopped by the lane
    expectSessionInvariants(status);
  });

  it("B-09: the provider's stricter timeout and response limit apply inside a looser shared session", async () => {
    // Shared timeout 9,000 ms; provider timeout 5,000 ms; the first GET_SLOT takes 6,000 ms.
    const slow = sharedHarness({
      session: { requestTimeoutMs: 9_000 },
      latencyFor: (m, now) => (m === "getSlot" && now < START_MS + 70_000 ? 6_000 : undefined),
    });
    await runShared(slow, { stopAtMs: 90_000 });
    const slot = slow.session.getStatus().ledger.find((e) => e.purpose === "GET_SLOT")!;
    expect(slot.error).toBe("REQUEST_TIMED_OUT");
    expect(slot.completedAtMs! - slot.dispatchedAtMs).toBe(5_000);
    expect(slot.bodyComplete).toBe(false);

    // Shared Solana body limit 131,072 bytes; provider limit 65,536; the first GET_SLOT is ~90 KB.
    const large = sharedHarness({
      lanes: { SOLANA_RPC: { maxAttempts: 315, pacingMs: 2_500, maxResponseBytes: 131_072 } },
      respond: (ctx) =>
        ctx.method === "getSlot" && ctx.call === 1
          ? new Response(
              JSON.stringify({ jsonrpc: "2.0", id: ctx.id, result: 1, pad: "x".repeat(90_000) }),
              { status: 200 },
            )
          : undefined,
    });
    await runShared(large, { stopAtMs: 90_000 });
    const big = large.session.getStatus().ledger.find((e) => e.purpose === "GET_SLOT")!;
    expect(big).toMatchObject({ error: "RESPONSE_TOO_LARGE", bodyComplete: false });
    // The loader's requests still use the session's own (looser) lane limit.
    for (const env of [slow, large]) expectSessionInvariants(env.session.getStatus());
  });

  it("B-10: prefetch with selective refresh keeps flow and every security component fresh at both the arm and the confirmation", async () => {
    const env = sharedHarness();
    const run = await runPrefetchSchedule(env, {
      prefetchAtMs: 59_000,
      confirmDelayMs: 5_000,
      refreshBeforeConfirm: true,
    });
    const { arm, confirm, timeline, cache } = run;
    expect(arm?.kind).toBe("EVALUATED");
    expect(confirm?.kind).toBe("EVALUATED");
    if (arm?.kind !== "EVALUATED" || confirm?.kind !== "EVALUATED") return;
    expect(arm.decision.outcome).toBe("ARMED_FIRST_TICK");
    expect(confirm.decision.outcome).toBe("RETEST_CONFIRMED");
    for (const e of [arm, confirm]) {
      const ctx = e.security!.context;
      expect(ctx.preAdmission.passed).toBe(true);
      expect([
        ctx.lp.status,
        ctx.authorities.status,
        ctx.rugCheck.status,
        ctx.bundler.status,
      ]).toEqual(["AVAILABLE_QUALIFIED", "AVAILABLE", "AVAILABLE", "QUALIFIED_PAPER_PROXY"]);
      expect(e.decision.flowResult.isCoverageSufficient).toBe(true);
      expect(e.decision.flowResult.paperQualificationContext!.cutoffAgeMs).toBeLessThanOrEqual(
        15_000,
      );
    }
    for (const a of [timeline.armSecurityAgesMs!, timeline.confirmSecurityAgesMs!]) {
      for (const age of Object.values(a)) expect(age!).toBeLessThanOrEqual(15_000);
    }
    // Selective: only the components that would expire before the confirmation were refreshed.
    expect(timeline.refreshComponents).toEqual(["MINT_ACCOUNT", "RUGCHECK", "BUNDLER"]);
    // The due rule is the unchanged 15 s limit, exactly: 15,000 ms is reusable, 15,001 ms is not.
    const retrieved = cache.getStatus().retrievedAtMs;
    expect(cache.componentsDueAt(retrieved.MINT_ACCOUNT! + 15_000)).not.toContain("MINT_ACCOUNT");
    expect(cache.componentsDueAt(retrieved.MINT_ACCOUNT! + 15_001)).toContain("MINT_ACCOUNT");
    expect(cache.componentsDueAt(retrieved.LP! + 15_000)).not.toContain("LP");
    expect(cache.componentsDueAt(retrieved.LP! + 15_001)).toContain("LP");
    const security = env.session.getStatus().ledger.filter((e) => e.owner === "SECURITY");
    expect(security.filter((e) => e.purpose === "LP_ACQUISITION")).toHaveLength(2); // prefetch only
    expect(security).toHaveLength(5 + 3);
    expect(cache.getStatus().refreshes).toBe(2);
    // Decision reads never acquired: every security request belongs to one of the two refreshes.
    const refreshWindows = cache.getStatus().records.map((r) => [r.requestedAtMs, r.completedAtMs]);
    expect(
      security.every((e) =>
        refreshWindows.some(([from, to]) => e.dispatchedAtMs >= from! && e.dispatchedAtMs <= to!),
      ),
    ).toBe(true);
    expectSessionInvariants(env.session.getStatus());
  });

  it("B-11: without a refresh, after a withdrawal, or with the refresh budget spent, the confirmation is rejected", async () => {
    // Scheduling regression: prefetch at +60 s, arm, then confirm 5 s later without a refresh.
    const noRefresh = await runPrefetchSchedule(sharedHarness(), {
      prefetchAtMs: 60_000,
      confirmDelayMs: 5_000,
      refreshBeforeConfirm: false,
    });
    expect(noRefresh.arm?.kind === "EVALUATED" && noRefresh.arm.decision.outcome).toBe(
      "ARMED_FIRST_TICK",
    );
    expect(noRefresh.confirm?.kind).toBe("SECURITY_REJECTED");
    if (noRefresh.confirm?.kind === "SECURITY_REJECTED") {
      expect(noRefresh.confirm.security?.context.authorities.status).toBe(
        "STALE_RETRIEVAL_EVIDENCE",
      );
      expect(noRefresh.confirm.reason).toBe(
        "PRE_ADMISSION_REJECTED:REJECTED_UNKNOWN_FREEZE_AUTHORITY",
      );
    }

    // Withdrawal: a disconnect right after the arm withdraws the flow; fresh security cannot confirm.
    const withdrawnEnv = sharedHarness();
    const withdrawn = await runPrefetchSchedule(withdrawnEnv, {
      prefetchAtMs: 59_000,
      confirmDelayMs: 5_000,
      refreshBeforeConfirm: true,
      afterArm: () => withdrawnEnv.h.transports.at(-1)!.emitClose(),
    });
    expect(withdrawn.confirm?.kind).toBe("EVALUATED");
    if (withdrawn.confirm?.kind === "EVALUATED") {
      expect(withdrawn.confirm.security?.context.preAdmission.passed).toBe(true);
      expect(withdrawn.confirm.decision.flowResult.diagnosticReason).toContain("EPOCH_INVALIDATED");
      expect(withdrawn.confirm.decision.outcome).toBe("BUY_GATE_REJECTED");
    }

    // Refresh budget spent (one refresh only): no further request, and the confirmation is rejected.
    const spentEnv = sharedHarness();
    const spent = await runPrefetchSchedule(spentEnv, {
      prefetchAtMs: 59_000,
      confirmDelayMs: 5_000,
      refreshBeforeConfirm: true,
      maxRefreshes: 1,
    });
    expect(spent.timeline.refreshError).toBe("PAPER_SECURITY_CACHE_REFRESH_CEILING_REACHED");
    expect(spent.cache.getStatus().refusedRefreshes).toBe(1);
    expect(spentEnv.session.getStatus().ledger.filter((e) => e.owner === "SECURITY")).toHaveLength(
      5,
    );
    expect(spent.confirm?.kind).toBe("SECURITY_REJECTED");
    for (const env of [withdrawnEnv, spentEnv]) expectSessionInvariants(env.session.getStatus());
  });
});

// ---------------------------------------------------------------------------------------------
// Security-cache refresh race (offline, synthetic; no flow collection is needed here)
// ---------------------------------------------------------------------------------------------

const DANGER_REPORT = syntheticRugCheckReport({
  risks: [{ name: "SYNTHETIC danger risk", level: "danger" }],
});

/** Session + loader + cache, with everything prefetched clean at START (t = 0). */
async function prefetchedCache(o: Overrides) {
  const env = sharedHarness(o);
  const cache = new PaperSecurityEvidenceCache({
    loader: env.loader,
    target: { poolId: POOL_ID, mintAddress: MINT },
    limits: { maxRefreshes: 3 },
  });
  env.session.open();
  await drive(env.h.sched, cache.refreshFor(START_MS + 15_000));
  const until = (atMs: number) =>
    drive(env.h.sched, new Promise<void>((resolve) => env.h.sched.at(START_MS + atMs, resolve)));
  const evaluate = (atMs = env.h.clock()) =>
    evaluatePaperCandidateSecurityContext({
      executionContext: "PAPER_SIMULATION",
      target: { poolId: POOL_ID, mintAddress: MINT },
      decisionTimeMs: atMs,
      evidence: cache.getEvidence(),
    });
  const entry = () =>
    retrieveAndEvaluatePaperDaemonEntry({
      candidate: synthCandidate(),
      flowProvider: env.h.provider, // not started: flow stays unavailable throughout
      getExistingArmedState: () => undefined,
      clock: env.h.clock,
      retrievals: {
        fetchSpotInfo: sessionSpot(env.session),
        fetchRugCheckMetrics: async () => {
          throw new Error("the direct RugCheck retrieval must not be used");
        },
      },
      security: cache.asSecurityPath(),
    }) as Promise<Entry>;
  return { env, cache, until, evaluate, entry };
}

const rugCheckLedger = (env: ReturnType<typeof sharedHarness>) =>
  env.session.getStatus().ledger.filter((e) => e.lane === "RUGCHECK");

describe("Security-cache refresh race (synthetic, offline)", () => {
  it("B-12: an adverse RugCheck arriving while the mint refresh is pending is never masked by the earlier clean report", async () => {
    let rugCheckCalls = 0;
    const { env, cache, until, evaluate, entry } = await prefetchedCache({
      rugCheck: () =>
        ++rugCheckCalls === 1 ? json(syntheticRugCheckReport()) : json(DANGER_REPORT),
      // The refreshed mint account (from 6 s) takes 4 s.
      latencyFor: (m, now) =>
        m === "getAccountInfo" && now >= START_MS + 6_000 ? 4_000 : undefined,
    });
    const clean = cache.getEvidence().rugCheck!;
    const cleanSnapshot = JSON.stringify(clean);
    expect((await evaluate()).rugCheck.metrics?.hasDangerRisk).toBe(false);

    await until(6_000);
    const refresh = cache.refreshFor(START_MS + 16_000);
    expect(cache.getStatus().pendingComponents).toEqual(["MINT_ACCOUNT", "RUGCHECK", "BUNDLER"]);

    // 6.5 s: the danger report has arrived; the mint request has not completed.
    let midEntry: Entry | undefined;
    let midVisible: string[] = [];
    let midSecurityRequests: { rugCheckCompleted: boolean; mintCompleted: boolean } | undefined;
    env.h.sched.at(START_MS + 6_500, () => {
      midVisible = Object.keys(cache.getEvidence());
      const ledger = env.session.getStatus().ledger;
      midSecurityRequests = {
        rugCheckCompleted: rugCheckLedger(env).at(-1)!.completedAtMs !== null,
        // The refresh's own mint request (sent at or after 6 s) has not completed.
        mintCompleted: ledger.some(
          (e) =>
            e.purpose === "CANDIDATE_MINT_ACCOUNT" &&
            e.dispatchedAtMs >= START_MS + 6_000 &&
            e.completedAtMs !== null &&
            e.completedAtMs <= START_MS + 6_500,
        ),
      };
      void entry().then((e) => (midEntry = e));
    });
    await until(7_000);
    expect(midSecurityRequests).toEqual({ rugCheckCompleted: true, mintCompleted: false });
    expect(midVisible).toEqual(["lp"]); // mint, RugCheck and bundler are withheld while pending
    expect(midEntry?.kind).toBe("SECURITY_REJECTED");
    if (midEntry?.kind === "SECURITY_REJECTED") {
      const ctx = midEntry.security!.context;
      expect(ctx.rugCheck.status).toBe("EVIDENCE_MISSING"); // not the earlier clean report
      expect(ctx.rugCheck.metrics).toBeNull();
      expect(ctx.lp.status).toBe("AVAILABLE_QUALIFIED"); // unaffected component stays available
      expect(midEntry.reason).toBe("PRE_ADMISSION_REJECTED:REJECTED_UNKNOWN_FREEZE_AUTHORITY");
    }

    // After settlement: the adverse report is published with its own retrieval time.
    await drive(env.h.sched, refresh);
    expect(cache.getStatus().pendingComponents).toEqual([]);
    expect(cache.getStatus().retrievedAtMs.RUGCHECK).toBe(START_MS + 6_000);
    expect(cache.getEvidence().rugCheck?.retrievedAtMs).toBe(START_MS + 6_000);
    const after = await evaluate();
    expect(after.rugCheck.status).toBe("AVAILABLE");
    expect(after.rugCheck.metrics?.hasDangerRisk).toBe(true);
    expect(after.preAdmission.passed).toBe(true);
    const afterEntry = await drive(env.h.sched, entry());
    // The adverse report reaches Gate 11, which fails on it (flow is not collected in this test).
    expect(afterEntry.kind).toBe("EVALUATED");
    if (afterEntry.kind === "EVALUATED") {
      expect(afterEntry.rugMetrics).toMatchObject({ hasDangerRisk: true });
      expect(
        afterEntry.decision.buyGateResult.gates.find((g) => g.name === "BUNDLER_CONCENTRATION_GATE")
          ?.passed,
      ).toBe(false);
      expect(afterEntry.decision.outcome).toBe("BUY_GATE_REJECTED");
    }
    // The earlier clean evidence object was never rewritten.
    expect(JSON.stringify(clean)).toBe(cleanSnapshot);
    env.session.stop("TEST_END");
    expectSessionInvariants(env.session.getStatus());
  });

  it("B-13: failed, cancelled and never-sent refreshes; a failure after start drops rather than restores", async () => {
    // (a) A dispatched refresh that fails (HTTP 500) replaces the clean report; it is not restored.
    let failedCalls = 0;
    const failed = await prefetchedCache({
      rugCheck: () =>
        ++failedCalls === 1
          ? json(syntheticRugCheckReport())
          : new Response("SYNTHETIC", { status: 500 }),
    });
    await failed.until(6_000);
    const failedRefresh = failed.cache.refreshFor(START_MS + 16_000);
    await failed.until(6_050);
    expect(failed.cache.getEvidence().rugCheck).toBeUndefined();
    await drive(failed.env.h.sched, failedRefresh);
    expect(failed.cache.getEvidence().rugCheck?.httpStatus).toBe(500);
    expect(failed.cache.getStatus().retrievedAtMs.RUGCHECK).toBeNull();
    expect((await failed.evaluate()).rugCheck.status).toBe("REQUEST_NOT_OK");
    failed.env.session.stop("TEST_END");

    // (b) Cancellation mid-refresh: the in-flight RugCheck (sent) is aborted and replaced; the mint
    // request still waiting for Solana pacing is never sent, so the earlier mint evidence is kept on
    // its original time; pending state is cleared; a later refresh is refused before it starts.
    const cancelled = await prefetchedCache({
      latencyFor: (m, now) =>
        m.endsWith("/report") && now >= START_MS + 6_000 ? 3_000 : undefined,
    });
    const mintBefore = cancelled.cache.getEvidence().mintAccount;
    await cancelled.until(6_000);
    const cancelledRefresh = cancelled.cache.refreshFor(START_MS + 16_000);
    cancelled.env.h.sched.at(START_MS + 6_500, () =>
      cancelled.env.loader.cancelLoads("TEST_CANCEL"),
    );
    await drive(cancelled.env.h.sched, cancelledRefresh);
    expect(cancelled.cache.getStatus().pendingComponents).toEqual([]);
    expect(rugCheckLedger(cancelled.env).at(-1)).toMatchObject({
      error: "REQUEST_ABORTED",
      bodyComplete: false,
    });
    expect(cancelled.cache.getEvidence().rugCheck?.bodyComplete).toBe(false);
    // Aborted before headers arrived: no status, so the composition reports REQUEST_NOT_OK.
    expect(cancelled.cache.getEvidence().rugCheck?.httpStatus).toBe(0);
    expect((await cancelled.evaluate()).rugCheck.status).toBe("REQUEST_NOT_OK");
    expect(cancelled.env.loader.getStatus().records.at(-1)!.mintAccount).toMatchObject({
      reason: "LOADER_CANCELLED",
      sessionSeqs: [],
    });
    expect(cancelled.cache.getEvidence().mintAccount).toBe(mintBefore);
    expect((await cancelled.evaluate(START_MS + 15_000)).authorities.status).toBe("AVAILABLE");
    expect((await cancelled.evaluate(START_MS + 15_001)).authorities.status).toBe(
      "STALE_RETRIEVAL_EVIDENCE",
    );
    const sentBefore = cancelled.env.h.fetchLog.length;
    const evidenceBefore = cancelled.cache.getEvidence();
    await expect(cancelled.cache.refreshFor(START_MS + 30_000)).rejects.toThrow(
      "PAPER_SECURITY_LOADER_CANCELLED",
    );
    expect(cancelled.cache.getStatus().pendingComponents).toEqual([]);
    expect(cancelled.cache.getEvidence()).toBe(evidenceBefore);
    expect(cancelled.env.h.fetchLog.length).toBe(sentBefore);
    cancelled.env.session.stop("TEST_END");

    // (c) Never-sent refusal (RugCheck lane ceiling of 1): the clean report is kept, only on its
    // original 15 s, and stays due for refresh.
    const refused = await prefetchedCache({
      lanes: { RUGCHECK: { maxAttempts: 1, pacingMs: 5_000, maxResponseBytes: 262_144 } },
    });
    const cleanBefore = refused.cache.getEvidence().rugCheck;
    await refused.until(6_000);
    await drive(refused.env.h.sched, refused.cache.refreshFor(START_MS + 16_000));
    expect(refused.env.loader.getStatus().records.at(-1)!.rugCheck).toMatchObject({
      reason: "RUGCHECK_ATTEMPT_CEILING_REACHED",
      sessionSeqs: [],
    });
    expect(refused.cache.getEvidence().rugCheck).toBe(cleanBefore);
    expect((await refused.evaluate(START_MS + 15_000)).rugCheck.status).toBe("AVAILABLE");
    expect((await refused.evaluate(START_MS + 15_001)).rugCheck.status).toBe(
      "STALE_RETRIEVAL_EVIDENCE",
    );
    expect(refused.cache.componentsDueAt(START_MS + 16_000)).toContain("RUGCHECK");
    refused.env.session.stop("TEST_END");

    // (d) A load that fails after it started: pending cleared, requested components dropped.
    const thrown = await prefetchedCache({});
    await thrown.until(6_000);
    const original = thrown.env.loader.load.bind(thrown.env.loader);
    vi.spyOn(thrown.env.loader, "load").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("SYNTHETIC failure after the load started");
    });
    await expect(
      drive(thrown.env.h.sched, thrown.cache.refreshFor(START_MS + 16_000)),
    ).rejects.toThrow("SYNTHETIC failure after the load started");
    expect(thrown.cache.getStatus().pendingComponents).toEqual([]);
    const visible = thrown.cache.getEvidence();
    expect([visible.mintAccount, visible.rugCheck, visible.bundler]).toEqual([null, null, null]);
    expect(visible.lp).not.toBeNull(); // not requested, unaffected
    const dropped = await thrown.evaluate();
    expect([dropped.authorities.status, dropped.rugCheck.status, dropped.bundler.status]).toEqual([
      "EVIDENCE_MISSING",
      "EVIDENCE_MISSING",
      "EVIDENCE_MISSING",
    ]);
    thrown.env.session.stop("TEST_END");
    for (const e of [failed, cancelled, refused, thrown])
      expectSessionInvariants(e.env.session.getStatus());
  });
});
