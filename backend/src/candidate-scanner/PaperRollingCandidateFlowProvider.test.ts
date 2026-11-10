/**
 * PaperRollingCandidateFlowProvider (offline, synthetic).
 *
 * Every chain, transaction, candidate, price and security input below is SYNTHETIC. Time is a virtual clock;
 * HTTP and WebSocket transports are in-memory mocks. No network, socket, daemon, wallet or session is used.
 * The 600-second lifetime is simulated in virtual time.
 */
import { describe, expect, it } from "vitest";
import {
  PaperRollingCandidateFlowProvider,
  type PaperRollingFlowLimits,
  type PaperRollingFlowStatus,
} from "./PaperRollingCandidateFlowProvider.js";
import {
  validateAndSnapshotCandidateFlowResult,
  type CandidateFlowResult,
} from "./CandidateFlowProvider.js";
import {
  CAPTURED_RAY_WSOL_IDENTITIES,
  RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE,
} from "./fixtures/CapturedRaydiumAmmV4SnapshotFixture.js";
import {
  buildSyntheticFailedTransactionResult,
  buildSyntheticSwapTransactionResult,
  SYNTHETIC_FAILED_TRANSACTION_ERROR,
} from "./fixtures/SyntheticRaydiumSwapTransactionFixture.js";
import { encodeBase58 } from "../providers/solana-rpc/SolanaRpcMintAccountParser.js";
import type { ISolanaKeepaliveWebSocketTransport } from "./RaydiumTransportObservationProbe.js";
import type { ArmedPullbackState } from "./BuyGateTriggerService.js";
import type { WatchlistCandidateItem } from "@nexustrade/shared";
import { evaluatePaperDaemonEntryDecision } from "../scripts/paper-trading-daemon.js";

/** OFFLINE TEST CONFIGURATION ONLY (§8.29). Not approved for live execution. */
const OFFLINE_TEST_LIMITS: PaperRollingFlowLimits = Object.freeze({
  lifetimeMs: 600_000,
  maxHttpAttempts: 300,
  maxNotifications: 60,
  maxTransactionRetrievals: 60,
  maxReconnects: 1,
  maxRetrievalsPerCycle: 4,
  queueCeiling: 13,
  rpcPacingMs: 2_500,
  requestTimeoutMs: 5_000,
  subscriptionAckTimeoutMs: 5_000,
  keepalivePingIntervalMs: 20_000,
  keepalivePongTimeoutMs: 10_000,
  // 600 s / 20 s = 30 pings at most (including one reconnect); 32 leaves no room for more than the lifetime.
  maxKeepalivePings: 32,
  // At most 2 acks (one reconnect) + 60 notifications; the remainder absorbs unrelated frames.
  maxWsMessages: 80,
  maxWsMessageBytes: 1_048_576,
  // Pongs (<= 32) plus occasional server pings.
  maxWsControlFrames: 80,
});

const START_MS = 1_791_931_000_000; // SYNTHETIC
const BASE_SLOT = 461_970_000; // SYNTHETIC
const SLOT_MS = 400;
const TEST_RPC_URL = "http://127.0.0.1:8899";
const POOL_ID = CAPTURED_RAY_WSOL_IDENTITIES.poolId;
const MINT = CAPTURED_RAY_WSOL_IDENTITIES.expectedTokenMint!;
const WSOL = "So11111111111111111111111111111111111111112";
const TARGET = Object.freeze({ poolAddress: POOL_ID, tokenMint: MINT });
const POOL_CONTEXT = {
  poolId: POOL_ID,
  candidateTokenMint: MINT,
  quoteTokenMint: WSOL,
  baseVault: CAPTURED_RAY_WSOL_IDENTITIES.baseVault,
  quoteVault: CAPTURED_RAY_WSOL_IDENTITIES.quoteVault,
  baseMint: MINT,
  quoteMint: WSOL,
  orientation: "TOKEN_BASE_SOL_QUOTE" as const,
};

/** SYNTHETIC distinct 64-byte Base58 signatures. */
const sig = (k: number) =>
  encodeBase58(Uint8Array.from({ length: 64 }, (_, i) => (i * 31 + k * 17 + 1) % 256));
const GENESIS_SIG = sig(1);

interface SyntheticSwap {
  readonly signature: string;
  /** Chain time relative to START_MS. */
  readonly atMs: number;
  readonly side: "BUY" | "SELL";
  /** Stream notification emitted (default true). */
  readonly notify?: boolean;
  /** Notification receipt delay after the chain time (default 300 ms). */
  readonly notifyDelayMs?: number;
  /** History indexing delay after the chain time (default 0). */
  readonly indexDelayMs?: number;
  /** SYNTHETIC complete, explicitly failed transaction (validated zero-swap path). */
  readonly validFailure?: boolean;
  /** SYNTHETIC malformed transaction error (cannot be resolved). */
  readonly malformedErr?: boolean;
}

interface MockWs extends ISolanaKeepaliveWebSocketTransport {
  readonly subscriptionId: number;
  subscribed: boolean;
  closed: boolean;
  emitNotification(signature: string, slot: number): void;
  emitRaw(data: string): void;
  emitClose(): void;
}

function txSlot(atMs: number): number {
  return BASE_SLOT + Math.floor(atMs / SLOT_MS);
}

function createHarness(
  opts: {
    readonly swaps?: readonly SyntheticSwap[];
    readonly latencyMs?: number;
    readonly cutoffSkewMs?: number;
    readonly dropPongs?: boolean;
    readonly disconnectAtMs?: readonly number[];
    readonly rawMessagesAtMs?: readonly { readonly atMs: number; readonly data: string }[];
    readonly hangMethod?: string;
    readonly limits?: Partial<PaperRollingFlowLimits>;
  } = {},
) {
  let now = START_MS;
  const clock = () => now;
  const swaps = opts.swaps ?? [];
  const chainTxs = [
    { signature: GENESIS_SIG, atMs: -75_000, side: "BUY" as const, notify: false } as SyntheticSwap,
    ...swaps,
  ];
  const latencyMs = opts.latencyMs ?? 100;
  const transports: MockWs[] = [];
  const handled = new Set<string>();
  const deliveredAt = new Map<string, number>();
  const raw = [...(opts.rawMessagesAtMs ?? [])];
  const disconnects = [...(opts.disconnectAtMs ?? [])];
  let fetchCalls = 0;
  let factoryCalls = 0;
  let observer: ((t: number) => void) | undefined;
  let preObserver: ((t: number) => void) | undefined;

  const current = () => transports[transports.length - 1];

  const processEvents = () => {
    const ws = current();
    for (const s of swaps) {
      if (s.notify === false || handled.has(s.signature)) continue;
      if (now >= START_MS + s.atMs + (s.notifyDelayMs ?? 300)) {
        handled.add(s.signature); // a notification due while unsubscribed is lost (as on a real stream)
        if (ws && ws.subscribed && !ws.closed) {
          deliveredAt.set(s.signature, now);
          ws.emitNotification(s.signature, txSlot(s.atMs));
        }
      }
    }
    while (raw.length > 0 && now >= START_MS + raw[0]!.atMs) {
      const m = raw.shift()!;
      if (ws && ws.subscribed && !ws.closed) ws.emitRaw(m.data);
    }
    while (disconnects.length > 0 && now >= START_MS + disconnects[0]!) {
      disconnects.shift();
      if (ws && !ws.closed) ws.emitClose();
    }
  };
  const advance = (ms: number) => {
    now += ms;
    preObserver?.(now);
    processEvents();
    observer?.(now);
  };
  const sleep = async (ms: number) => {
    advance(Math.max(1, ms));
    await new Promise((resolve) => setImmediate(resolve));
  };

  const createWs = (): MockWs => {
    factoryCalls++;
    const listeners: Record<string, ((...args: never[]) => void)[]> = {};
    const fire = (event: string, ...args: unknown[]) => {
      for (const fn of listeners[event] ?? []) (fn as (...a: unknown[]) => void)(...args);
    };
    const ws: MockWs = {
      subscriptionId: 100 + transports.length + 1,
      subscribed: false,
      closed: false,
      send(data: string) {
        const parsed = JSON.parse(data) as { id?: number; method?: string };
        if (parsed.method === "logsSubscribe") {
          queueMicrotask(() => {
            if (ws.closed) return;
            ws.subscribed = true;
            fire(
              "message",
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: ws.subscriptionId }),
            );
          });
        }
      },
      close() {
        if (ws.closed) return;
        ws.closed = true;
        fire("close", 1000, "client close");
      },
      ping(data?: Buffer) {
        if (opts.dropPongs || !data || ws.closed) return;
        queueMicrotask(() => fire("pong", data));
      },
      on: ((event: string, listener: (...args: never[]) => void) => {
        (listeners[event] ??= []).push(listener);
        if (event === "open") queueMicrotask(() => !ws.closed && (listener as () => void)());
      }) as ISolanaKeepaliveWebSocketTransport["on"],
      emitNotification(signature: string, slot: number) {
        fire(
          "message",
          JSON.stringify({
            jsonrpc: "2.0",
            method: "logsNotification",
            params: {
              subscription: ws.subscriptionId,
              result: {
                context: { slot },
                value: {
                  signature,
                  err: null,
                  logs: ["Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]"],
                },
              },
            },
          }),
        );
      },
      emitRaw(data: string) {
        fire("message", data);
      },
      emitClose() {
        if (ws.closed) return;
        ws.closed = true;
        fire("close", 1006, "SYNTHETIC_DISCONNECT");
      },
    };
    transports.push(ws);
    return ws;
  };

  const historyRecord = (s: SyntheticSwap) => ({
    signature: s.signature,
    slot: txSlot(s.atMs),
    err: s.validFailure ? SYNTHETIC_FAILED_TRANSACTION_ERROR : null,
    blockTime: Math.floor((START_MS + s.atMs) / 1000),
  });

  const fetchFn = (async (_input: unknown, init?: RequestInit) => {
    fetchCalls++;
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    if (opts.hangMethod === body.method) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    let result: unknown;
    if (body.method === "getAccountInfo") {
      const rawJson = JSON.parse(RAW_CAPTURED_RAY_WSOL_BOOTSTRAP_ACCOUNT_RPC_RESPONSE) as {
        result: unknown;
      };
      result = rawJson.result;
    } else if (body.method === "getSignaturesForAddress") {
      const limit = (body.params[1] as { limit: number }).limit;
      result = chainTxs
        .filter((t) => START_MS + t.atMs + (t.indexDelayMs ?? 0) <= now)
        .sort((a, b) => txSlot(b.atMs) - txSlot(a.atMs))
        .slice(0, limit)
        .map(historyRecord);
    } else if (body.method === "getSlot") {
      result = BASE_SLOT + Math.floor((now - START_MS) / SLOT_MS);
    } else if (body.method === "getBlockTime") {
      const slot = body.params[0] as number;
      result = Math.floor(
        (START_MS + (slot - BASE_SLOT) * SLOT_MS + (opts.cutoffSkewMs ?? 0)) / 1000,
      );
    } else if (body.method === "getTransaction") {
      const s = swaps.find((x) => x.signature === body.params[0]);
      if (!s) {
        result = null;
      } else {
        const identity = {
          poolContext: POOL_CONTEXT,
          signature: s.signature,
          slot: txSlot(s.atMs),
          blockTime: Math.floor((START_MS + s.atMs) / 1000),
        };
        if (s.validFailure) {
          result = buildSyntheticFailedTransactionResult(identity);
        } else {
          const tx = buildSyntheticSwapTransactionResult({ ...identity, side: s.side });
          if (s.malformedErr) (tx.meta as Record<string, unknown>).err = 5;
          result = tx;
        }
      }
    }
    advance(latencyMs);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new PaperRollingCandidateFlowProvider({
    target: TARGET,
    executionContext: "PAPER_SIMULATION",
    rpcUrl: TEST_RPC_URL,
    fetchFn,
    createWebSocketTransport: createWs,
    limits: { ...OFFLINE_TEST_LIMITS, ...(opts.limits ?? {}) },
    clock,
    sleep,
  });

  return {
    provider,
    clock,
    transports,
    setObserver: (fn: (t: number) => void) => {
      observer = fn;
    },
    /** Runs before scheduled events are delivered at each clock advance. */
    setPreObserver: (fn: (t: number) => void) => {
      preObserver = fn;
    },
    counts: () => ({ fetchCalls, factoryCalls }),
    deliveredAt,
  };
}

const read = (h: { provider: PaperRollingCandidateFlowProvider }, t: number): CandidateFlowResult =>
  h.provider.getCandidateFlow(TARGET, t);

/** Runs until `stopAtMs` (relative to START_MS) or natural stop, sampling reads on a grid. */
async function runUntil(
  h: ReturnType<typeof createHarness>,
  stopAtMs: number,
  sample?: {
    readonly everyMs: number;
    readonly onSample: (t: number, r: CandidateFlowResult) => void;
  },
) {
  let nextSample = START_MS;
  h.setObserver((t) => {
    if (sample) {
      while (nextSample <= t) {
        sample.onSample(t, read(h, t));
        nextSample += sample.everyMs;
      }
    }
    if (t >= START_MS + stopAtMs) h.provider.stop("TEST_WINDOW_END");
  });
  return h.provider.start();
}

function solanaSpacingOk(status: PaperRollingFlowStatus): boolean {
  for (let i = 1; i < status.ledger.length; i++) {
    const prev = status.ledger[i - 1]!;
    const cur = status.ledger[i]!;
    if (cur.dispatchedAtMs - prev.dispatchedAtMs < 2_500) return false;
    if (prev.completedAtMs === null || prev.completedAtMs > cur.dispatchedAtMs) return false;
  }
  return true;
}

// SYNTHETIC micro-cap candidate and security context that passes every buy gate with verified flow.
const SYNTH_CANDIDATE = {
  poolId: POOL_ID,
  mintAddress: MINT,
  symbol: "SYNTH",
  liquidityUsd: 65_000,
  marketCapUsd: 250_000,
  lmcRatio: 0.26,
  lpBurnPct: 99.9,
  assetAgeSeconds: 600,
  volume5mUsd: 15_000,
  buys5m: 40,
  sells5m: 15,
  buyToSellRatio: 40 / 15,
  status: "WATCHING",
  discoveredAt: new Date(START_MS).toISOString(),
  lastEvaluatedAt: new Date(START_MS).toISOString(),
} as WatchlistCandidateItem;
const SYNTH_RUG = {
  rugScore: 150,
  hasDangerRisk: false,
  top10HolderPct: 0.09,
  holdersCount: 450,
  bundlerPct: 0.05,
};
const PEAK_SOL = 0.0001;
const entryDecision = (
  provider: PaperRollingCandidateFlowProvider,
  t: number,
  spotPriceSol: number,
  armed?: ArmedPullbackState,
) =>
  evaluatePaperDaemonEntryDecision({
    candidate: SYNTH_CANDIDATE,
    baseSpotInfo: {
      spotPriceSol,
      spotPriceUsd: 0.015,
      liquidityUsd: 65_000,
      momentum5mBps: 0,
      priceChange1hPct: 4.2,
    },
    rugMetrics: SYNTH_RUG,
    flowProvider: provider,
    existingArmedState: armed,
    currentNowMs: t,
    requireVerifiedHolders: true,
  });

describe("PaperRollingCandidateFlowProvider (synthetic, offline)", () => {
  it("R1. Import and construction are inert; reads before start are unavailable; limits are validated", async () => {
    const h = createHarness();
    for (let i = 0; i < 1_000; i++) {
      const r = read(h, START_MS + i);
      expect(r.isCoverageSufficient).toBe(false);
      expect(r.diagnosticReason).toBe("PAPER_ROLLING_FLOW_NOT_STARTED");
    }
    expect(h.counts()).toEqual({ fetchCalls: 0, factoryCalls: 0 });

    const base = {
      target: TARGET,
      executionContext: "PAPER_SIMULATION" as const,
      rpcUrl: TEST_RPC_URL,
      fetchFn: (async () => new Response("{}")) as unknown as typeof fetch,
      createWebSocketTransport: () => {
        throw new Error("not used");
      },
    };
    expect(
      () =>
        new PaperRollingCandidateFlowProvider({
          ...base,
          limits: { ...OFFLINE_TEST_LIMITS, rpcPacingMs: 2_499 },
        }),
    ).toThrow(/rpcPacingMs/);
    const missing: Record<string, unknown> = { ...OFFLINE_TEST_LIMITS };
    delete missing["maxWsControlFrames"];
    expect(
      () =>
        new PaperRollingCandidateFlowProvider({
          ...base,
          limits: missing as unknown as PaperRollingFlowLimits,
        }),
    ).toThrow(/maxWsControlFrames/);
    expect(
      () =>
        new PaperRollingCandidateFlowProvider({
          ...base,
          executionContext: "PRODUCTION" as unknown as "PAPER_SIMULATION",
          limits: OFFLINE_TEST_LIMITS,
        }),
    ).toThrow(/PAPER_SIMULATION/);

    const report = await runUntil(h, 1);
    expect(report.stopReason).toBe("TEST_WINDOW_END");
    await expect(h.provider.start()).rejects.toThrow(/only once/);
  });

  it("R2. Warm-up schedule, repeated fresh reads of one snapshot, identity and context rejection", async () => {
    const h = createHarness();
    const samples: { t: number; r: CandidateFlowResult }[] = [];
    const report = await runUntil(h, 95_000, {
      everyMs: 250,
      onSample: (t, r) => samples.push({ t, r }),
    });
    const s = report.status;
    const obsStart = s.observationStartMs!;
    expect(s.ledger.map((e) => e.purpose).slice(0, 5)).toEqual([
      "POOL_LAYOUT",
      "PRIOR_ANCHOR",
      "GET_SLOT",
      "GET_BLOCK_TIME",
      "HISTORY_ENUMERATION",
    ]);
    expect(s.ledger[0]!.dispatchedAtMs).toBe(START_MS);
    expect(s.ledger[1]!.dispatchedAtMs).toBe(START_MS + 2_500);
    expect(s.ledger[2]!.dispatchedAtMs).toBeGreaterThanOrEqual(obsStart + 65_000);
    expect(s.ledger[2]!.dispatchedAtMs).toBeLessThan(obsStart + 65_000 + 300);
    expect(s.ledger[3]!.dispatchedAtMs - s.ledger[2]!.dispatchedAtMs).toBe(2_500);
    expect(s.ledger[4]!.dispatchedAtMs - s.ledger[3]!.dispatchedAtMs).toBe(2_500);
    expect(solanaSpacingOk(s)).toBe(true);
    expect(s.maxConcurrentRpc).toBe(1);

    expect(s.refreshesPublished).toBeGreaterThanOrEqual(2);
    const published = samples.filter((x) => x.r.isCoverageSufficient);
    expect(
      samples
        .filter((x) => x.t < s.ledger[4]!.completedAtMs!)
        .every((x) => !x.r.isCoverageSufficient),
    ).toBe(true);
    expect(samples.find((x) => x.t < s.ledger[4]!.completedAtMs!)?.r.diagnosticReason).toContain(
      "WARMING_UP",
    );
    for (const p of published) {
      expect(p.r.recentBuys60s).toBe(0);
      expect(p.r.recentSells60s).toBe(0);
      const ctx = p.r.paperQualificationContext!;
      expect(ctx.qualificationKind).toBe("QUIET_WINDOW");
      expect(ctx.cutoffAgeMs).toBe(p.t - ctx.researchWindowSpan.windowEndMs);
      expect(ctx.cutoffAgeMs).toBeLessThanOrEqual(15_000);
    }

    // Two eligible ticks 5 s apart may consume the same still-fresh snapshot (no new evidence between).
    const pubTimes = s.cycleLog.filter((c) => c.outcome === "PUBLISHED").map((c) => c.endedAtMs);
    const p1 = pubTimes[0]!;
    const tickA = samples.find((x) => x.t >= p1 + 250)!;
    const tickB = samples.find((x) => x.t >= tickA.t + 5_000 && x.t < pubTimes[1]!)!;
    expect(tickA.r.isCoverageSufficient && tickB.r.isCoverageSufficient).toBe(true);
    expect(tickB.r.paperQualificationContext!.researchWindowSpan.windowEndMs).toBe(
      tickA.r.paperQualificationContext!.researchWindowSpan.windowEndMs,
    );

    // Identity and context: other pool/mint unavailable; production rejects PAPER evidence.
    const live = published[published.length - 1]!;
    const other = h.provider.getCandidateFlow(
      { poolAddress: GENESIS_SIG, tokenMint: MINT },
      live.t,
    );
    expect(other.isCoverageSufficient).toBe(false);
    expect(
      validateAndSnapshotCandidateFlowResult(live.r, TARGET, live.t, {
        executionContext: "PAPER_SIMULATION",
      }).isCoverageSufficient,
    ).toBe(true);
    expect(
      validateAndSnapshotCandidateFlowResult(live.r, TARGET, live.t, {
        executionContext: "PRODUCTION",
      }).diagnosticReason,
    ).toBe("PAPER_QUALIFIED_EVIDENCE_REJECTED_IN_PRODUCTION");
    expect(
      validateAndSnapshotCandidateFlowResult(live.r, TARGET, live.t).isCoverageSufficient,
    ).toBe(false);

    // After stop every read is unavailable.
    expect(read(h, live.t).diagnosticReason).toContain("PAPER_ROLLING_FLOW_STOPPED");
  });

  it("R3. Quiet continuity is conditional: continuous under favourable timing, gaps (and disarming) otherwise", async () => {
    // Favourable: 100 ms latency, no cutoff skew.
    const good = createHarness({ latencyMs: 100 });
    const goodSamples: { t: number; r: CandidateFlowResult }[] = [];
    const goodReport = await runUntil(good, 160_000, {
      everyMs: 250,
      onSample: (t, r) => goodSamples.push({ t, r }),
    });
    const firstPub = goodReport.status.cycleLog.find((c) => c.outcome === "PUBLISHED")!.endedAtMs;
    const afterFirst = goodSamples.filter((x) => x.t > firstPub && x.t < START_MS + 159_000);
    expect(afterFirst.length).toBeGreaterThan(300);
    expect(afterFirst.every((x) => x.r.isCoverageSufficient)).toBe(true);

    // Unfavourable: cutoff block time 2 s behind and 600 ms latency -> the next snapshot is published after the
    // previous one has expired; reads in between are STALE, never re-stamped.
    const bad = createHarness({ latencyMs: 600, cutoffSkewMs: -2_000 });
    const badSamples: { t: number; r: CandidateFlowResult; decision?: string }[] = [];
    let armed: ArmedPullbackState | undefined;
    let nextTickAt = START_MS;
    const badReport = await runUntil(bad, 160_000, {
      everyMs: 250,
      onSample: (t, r) => {
        // A 5-second daemon tick: ARMED on fresh flow, then BUY_GATE_REJECTED (the caller disarms) in a gap.
        let decision: string | undefined;
        if (t >= nextTickAt) {
          nextTickAt = t + 5_000;
          const d = entryDecision(bad.provider, t, PEAK_SOL, armed);
          decision = d.outcome;
          if (d.outcome === "ARMED_FIRST_TICK") armed = d.retestResult.updatedArmedState;
          if (d.outcome === "BUY_GATE_REJECTED") armed = undefined;
        }
        badSamples.push({ t, r, ...(decision ? { decision } : {}) });
      },
    });
    const published = new Set(badReport.status.snapshots.map((x) => x.windowEndMs));
    const pubTimes = badReport.status.cycleLog
      .filter((c) => c.outcome === "PUBLISHED")
      .map((c) => c.endedAtMs);
    const between = badSamples.filter(
      (x) => x.t > pubTimes[0]! && x.t < pubTimes[pubTimes.length - 1]!,
    );
    const stale = between.filter((x) => !x.r.isCoverageSufficient);
    expect(stale.length).toBeGreaterThan(0);
    expect(
      stale.every((x) => x.r.diagnosticReason.startsWith("STALE_RECONCILIATION_EVIDENCE")),
    ).toBe(true);
    for (const x of between.filter((y) => y.r.isCoverageSufficient)) {
      const span = x.r.paperQualificationContext!.researchWindowSpan;
      expect(x.t - span.windowEndMs).toBeLessThanOrEqual(15_000);
      // Only the two most recent snapshots are retained, so compare against the cutoff grid instead.
      expect(span.windowEndMs % 1_000).toBe(0);
    }
    expect(published.size).toBeGreaterThan(0);
    const decisions = badSamples.filter((x) => x.decision).map((x) => x.decision);
    expect(decisions).toContain("ARMED_FIRST_TICK");
    const armedIdx = decisions.indexOf("ARMED_FIRST_TICK");
    expect(decisions.slice(armedIdx)).toContain("BUY_GATE_REJECTED");
  });

  it("R4. Active window: retrievals before GET_SLOT, one retrieval per signature, exact counts, favourable retest, ageing into a quiet window with an advanced anchor", async () => {
    const BUY_1 = sig(11);
    const BUY_2 = sig(12);
    const SELL_1 = sig(13);
    const h = createHarness({
      swaps: [
        { signature: BUY_1, atMs: 20_000, side: "BUY" },
        { signature: BUY_2, atMs: 30_000, side: "BUY" },
        { signature: SELL_1, atMs: 40_000, side: "SELL" },
      ],
    });
    const decisions: string[] = [];
    let armed: ArmedPullbackState | undefined;
    let firstActivePub: number | null = null;
    const report = await runUntil(h, 140_000, {
      everyMs: 250,
      onSample: (t, r) => {
        if (
          firstActivePub === null &&
          r.isCoverageSufficient &&
          r.paperQualificationContext?.qualificationKind === "ACTIVE_WINDOW"
        ) {
          firstActivePub = t;
          const a = entryDecision(h.provider, t, PEAK_SOL);
          decisions.push(a.outcome);
          if (a.outcome === "ARMED_FIRST_TICK") armed = a.retestResult.updatedArmedState;
        } else if (firstActivePub !== null && armed && t >= firstActivePub + 5_000) {
          // Second eligible tick 5 s later on still-fresh active flow with a 12% pullback.
          const b = entryDecision(h.provider, t, PEAK_SOL * 0.88, armed);
          decisions.push(b.outcome);
          armed = undefined;
        }
      },
    });
    const s = report.status;
    const retrievals = s.ledger.filter((e) => e.purpose === "TRANSACTION_RETRIEVAL");
    expect(retrievals).toHaveLength(3);
    const firstGetSlot = s.ledger.find((e) => e.purpose === "GET_SLOT")!;
    expect(retrievals.every((e) => e.dispatchedAtMs < firstGetSlot.dispatchedAtMs)).toBe(true);
    expect(decisions).toEqual(["ARMED_FIRST_TICK", "RETEST_CONFIRMED"]);

    const firstActive = s.cycleLog.find((c) => c.outcome === "PUBLISHED");
    expect(firstActive).toBeDefined();
    // Later windows exclude all swaps: quiet qualification with the anchor advanced to the SELL.
    const last = s.snapshots[s.snapshots.length - 1]!;
    expect(last.qualificationKind).toBe("QUIET_WINDOW");
    expect(h.provider.getSnapshotResult(last.id)!.underlyingOutcomes.knownAnchorSignature).toBe(
      SELL_1,
    );
    expect(s.cycleLog.some((c) => c.outcome === "PUBLISHED")).toBe(true);
    expect(s.budgetManagerAttempts).toBe(s.httpAttempts);
    expect(solanaSpacingOk(s)).toBe(true);
  });

  it("R5. Delayed contradictory evidence withdraws published snapshots immediately without rewriting them", async () => {
    // (a) A delayed notification for a transaction inside the published window (slot <= cutoff slot).
    const LATE = sig(21);
    const a = createHarness({
      swaps: [
        { signature: LATE, atMs: 60_000, side: "BUY", notifyDelayMs: 14_500, indexDelayMs: 20_000 },
      ],
    });
    const aSamples: { t: number; r: CandidateFlowResult }[] = [];
    let frozenBefore: string | null = null;
    let availableBeforeArrival = false;
    a.setPreObserver((t) => {
      // Captured before the delayed notification is delivered at this clock advance.
      const r1 = a.provider.getSnapshotResult(1);
      if (r1 && frozenBefore === null) {
        frozenBefore = JSON.stringify(r1);
        availableBeforeArrival = read(a, t).isCoverageSufficient;
      }
    });
    const aReport = await runUntil(a, 79_000, {
      everyMs: 100,
      onSample: (t, r) => aSamples.push({ t, r }),
    });
    expect(availableBeforeArrival).toBe(true);
    const snap1 = aReport.status.snapshots.find((x) => x.id === 1)!;
    expect(snap1.withdrawnReason).toBe("DELAYED_SIGNATURE_AT_OR_BEFORE_CUTOFF_SLOT");
    // Delivered when the virtual clock reaches or passes the scheduled arrival (+14.5 s).
    const arrival = a.deliveredAt.get(LATE)!;
    expect(arrival).toBeGreaterThanOrEqual(START_MS + 74_500);
    expect(snap1.withdrawnAtMs).toBe(arrival);
    expect(arrival - snap1.windowEndMs).toBeLessThan(15_000); // withdrawn while still nominally fresh
    const after = aSamples.filter((x) => x.t >= arrival && x.t < START_MS + 79_000);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((x) => !x.r.isCoverageSufficient)).toBe(true);
    expect(after[0]!.r.diagnosticReason).toContain("SNAPSHOT_WITHDRAWN");
    expect(JSON.stringify(a.provider.getSnapshotResult(1))).toBe(frozenBefore);

    // (b) A transaction the stream never reported, indexed late: history reveals it inside a published window.
    const MISSED = sig(22);
    const b = createHarness({
      swaps: [
        { signature: MISSED, atMs: 60_000, side: "BUY", notify: false, indexDelayMs: 15_000 },
      ],
    });
    const bReport = await runUntil(b, 84_000);
    const b1 = bReport.status.snapshots.find((x) => x.id === 1)!;
    expect(b1.withdrawnReason).toBe("DELAYED_SIGNATURE_IN_HISTORY");
    expect(b1.withdrawnAtMs! - b1.windowEndMs).toBeLessThan(15_000);
    const second = bReport.status.cycleLog.filter((c) => c.getSlotDispatchedAtMs !== null)[1]!;
    expect(second.outcome).toContain("UNRESOLVED_TRANSACTIONS");

    // (c) A recorded gap (corrupt frame on the active subscription) withdraws every snapshot.
    const c = createHarness({ rawMessagesAtMs: [{ atMs: 76_000, data: "{not-json" }] });
    const cReport = await runUntil(c, 78_000);
    const withdrawn = cReport.status.snapshots.filter(
      (x) =>
        x.withdrawnAtMs !== null &&
        x.withdrawnAtMs >= START_MS + 76_000 &&
        x.withdrawnAtMs < START_MS + 78_000,
    );
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn[0]!.withdrawnReason).toContain("RECORDED_GAP:ACTIVE_SOURCE_CORRUPTION");
  });

  it("R6. Backlog, per-cycle retrieval allowance, refresh-time arrivals and failed transactions", async () => {
    // Six notifications at once: 4 retrievals, the refresh is skipped, the backlog is kept and drained next cycle.
    const burst = Array.from({ length: 6 }, (_, i) => ({
      signature: sig(40 + i),
      atMs: 30_000,
      side: (i % 2 === 0 ? "BUY" : "SELL") as "BUY" | "SELL",
    }));
    const h = createHarness({ swaps: burst });
    const r1 = await runUntil(h, 75_000);
    const s1 = r1.status;
    expect(s1.ledger.filter((e) => e.purpose === "TRANSACTION_RETRIEVAL")).toHaveLength(6);
    expect(s1.cycleLog[0]!.outcome).toBe("REFRESH_SKIPPED_RETRIEVAL_ALLOWANCE_EXHAUSTED");
    expect(s1.cycleLog[0]!.retrievals).toBe(4);
    expect(s1.refreshesSkipped).toBe(1);
    const pub = s1.snapshots[0]!;
    expect(pub.qualificationKind).toBe("ACTIVE_WINDOW");
    expect([pub.recentBuys60s, pub.recentSells60s]).toEqual([3, 3]);

    // A notification arriving between GET_SLOT and evaluation: that refresh does not publish.
    const DURING = sig(50);
    const d = createHarness({
      swaps: [{ signature: DURING, atMs: 68_500, side: "BUY", notifyDelayMs: 0 }],
    });
    const rd = await runUntil(d, 74_000);
    const firstRefresh = rd.status.cycleLog.find((c) => c.getSlotDispatchedAtMs !== null)!;
    expect(firstRefresh.outcome).not.toBe("PUBLISHED");
    expect(firstRefresh.outcome).toMatch(/PROCESSING_BACKLOG|notification received during refresh/);

    // A validated failed transaction counts zero swaps; a malformed one leaves the window unavailable.
    const FAILED = sig(60);
    const SWAP = sig(61);
    const f = createHarness({
      swaps: [
        { signature: FAILED, atMs: 30_000, side: "BUY", validFailure: true },
        { signature: SWAP, atMs: 35_000, side: "BUY" },
      ],
    });
    const rf = await runUntil(f, 75_000);
    const fs = rf.status.snapshots[0]!;
    expect(fs.qualificationKind).toBe("ACTIVE_WINDOW");
    expect([fs.recentBuys60s, fs.recentSells60s]).toEqual([1, 0]);
    expect(f.provider.getSnapshotResult(fs.id)!.paperQualificationReason).toContain(
      "1 validated failed on-chain transaction(s) contributed zero committed swaps",
    );

    const m = createHarness({
      swaps: [{ signature: sig(62), atMs: 30_000, side: "BUY", malformedErr: true }],
    });
    const rm = await runUntil(m, 75_000);
    expect(rm.status.refreshesPublished).toBe(0);
    expect(rm.status.cycleLog.find((c) => c.getSlotDispatchedAtMs !== null)!.outcome).toMatch(
      /UNRESOLVED_TRANSACTIONS|STREAM_GAP/,
    );
  });

  it("R7. Disconnect, reconnect warm-up, missing pong, and the reconnect ceiling (no counter reset, no deadline extension)", async () => {
    const h = createHarness({ disconnectAtMs: [100_000, 200_000] });
    const samples: { t: number; r: CandidateFlowResult }[] = [];
    const report = await runUntil(h, 300_000, {
      everyMs: 250,
      onSample: (t, r) => samples.push({ t, r }),
    });
    const s = report.status;
    expect(report.stopReason).toBe("RECONNECT_CEILING_REACHED");
    expect(s.reconnects).toBe(1);
    expect(s.deadlineMs).toBe(START_MS + 600_000);
    expect(s.ledger.map((e) => e.seq)).toEqual(s.ledger.map((_, i) => i + 1));
    const anchors = s.ledger.filter((e) => e.purpose === "PRIOR_ANCHOR");
    expect(anchors).toHaveLength(2);
    const reAnchor = anchors[1]!.dispatchedAtMs;
    const nextSlot = s.ledger.find((e) => e.purpose === "GET_SLOT" && e.dispatchedAtMs > reAnchor)!;
    expect(nextSlot.dispatchedAtMs - reAnchor).toBeGreaterThanOrEqual(65_000);
    // Fresh before the disconnect; withdrawn at once after it (not served until expiry); fresh again only after
    // the new epoch's full warm-up.
    expect(
      samples
        .filter((x) => x.t >= START_MS + 90_000 && x.t < START_MS + 100_000)
        .every((x) => x.r.isCoverageSufficient),
    ).toBe(true);
    const afterDrop = samples.filter(
      (x) => x.t >= START_MS + 100_000 && x.t < nextSlot.dispatchedAtMs,
    );
    expect(afterDrop.length).toBeGreaterThan(100);
    expect(afterDrop.every((x) => !x.r.isCoverageSufficient)).toBe(true);
    expect(afterDrop[0]!.r.diagnosticReason).toContain("EPOCH_INVALIDATED");
    expect(
      samples.some(
        (x) =>
          x.t > nextSlot.dispatchedAtMs + 6_000 &&
          x.t < START_MS + 200_000 &&
          x.r.isCoverageSufficient,
      ),
    ).toBe(true);

    const p = createHarness({ dropPongs: true });
    const pr = await runUntil(p, 300_000);
    expect(pr.stopReason).toBe("RECONNECT_CEILING_REACHED");
    expect(pr.status.keepalive.matchedPongs).toBe(0);
    expect(pr.status.ledger.filter((e) => e.purpose === "PRIOR_ANCHOR")).toHaveLength(2);
    expect(pr.status.refreshesPublished).toBe(0); // missing pongs end each epoch before its warm-up completes
  });

  it("R8. Shared ceilings stop collection exactly once without resets", async () => {
    const http = createHarness({ limits: { maxHttpAttempts: 12, maxTransactionRetrievals: 12 } });
    const hr = await runUntil(http, 300_000);
    expect(hr.stopReason).toBe("HTTP_ATTEMPT_CEILING_REACHED");
    expect(hr.status.httpAttempts).toBe(12);
    expect(hr.status.budgetManagerAttempts).toBe(12);

    const many = Array.from({ length: 6 }, (_, i) => ({
      signature: sig(70 + i),
      atMs: 10_000 + i * 3_000,
      side: "BUY" as const,
    }));
    const notif = createHarness({ swaps: many, limits: { maxNotifications: 5 } });
    const nr = await runUntil(notif, 300_000);
    expect(nr.stopReason).toBe("NOTIFICATION_CEILING_REACHED");

    const retr = createHarness({ swaps: many, limits: { maxTransactionRetrievals: 3 } });
    const rr = await runUntil(retr, 300_000);
    expect(rr.stopReason).toBe("TRANSACTION_RETRIEVAL_CEILING_REACHED");
    expect(rr.status.transactionRetrievals).toBe(3);

    const ws = createHarness({ swaps: many, limits: { maxWsMessages: 3 } });
    const wr = await runUntil(ws, 300_000);
    expect(wr.stopReason).toBe("WS_MESSAGE_CEILING_REACHED");
    expect(wr.status.ws.messages).toBe(4);
  });

  it("R9. Simulated 600-second lifetime: absolute deadline, pacing, no overlap, exact accounting, cleanup", async () => {
    const h = createHarness();
    const report = await h.provider.start();
    const s = report.status;
    expect(report.stopReason).toBe("LIFETIME_EXPIRED");
    expect(s.state).toBe("STOPPED");
    expect(s.ledger.every((e) => e.dispatchedAtMs < s.deadlineMs!)).toBe(true);
    expect(s.stoppedAtMs!).toBeGreaterThanOrEqual(s.deadlineMs!);
    expect(solanaSpacingOk(s)).toBe(true);
    expect(s.maxConcurrentRpc).toBe(1);
    expect(s.budgetManagerAttempts).toBe(s.httpAttempts);
    // Planning estimate (quiet, measured-like latency): 2 setup requests + 3 per refresh, below the 300 ceiling.
    expect(s.httpAttempts).toBe(2 + 3 * s.refreshesAttempted);
    expect(s.httpAttempts).toBeLessThanOrEqual(218);
    expect(s.refreshesPublished).toBe(s.refreshesAttempted);
    expect(s.keepalive.pingsSent).toBeLessThanOrEqual(30);
    expect(s.keepalive.matchedPongs).toBe(s.keepalive.pingsSent);
    expect(
      s.snapshots.every((x) => x.withdrawnReason === "PROVIDER_STOPPED:LIFETIME_EXPIRED"),
    ).toBe(true);
    expect(h.transports.every((t) => t.closed)).toBe(true);
    expect(read(h, h.clock()).diagnosticReason).toBe(
      "PAPER_ROLLING_FLOW_STOPPED: LIFETIME_EXPIRED",
    );
  });

  it("R10. Cancellation: stop() and an external abort cancel an in-flight request and close everything", async () => {
    const h = createHarness({ hangMethod: "getSlot" });
    h.setObserver(() => undefined);
    const run = h.provider.start();
    const timer = setInterval(() => {
      const st = h.provider.getStatus();
      if (st.ledger.some((e) => e.purpose === "GET_SLOT")) h.provider.stop("TEST_CANCEL");
    }, 5);
    const report = await run;
    clearInterval(timer);
    expect(report.stopReason).toBe("TEST_CANCEL");
    const last = report.status.ledger[report.status.ledger.length - 1]!;
    expect(last.purpose).toBe("GET_SLOT");
    expect(last.error).toBe("REQUEST_ABORTED_OR_TIMED_OUT");
    expect(h.transports.every((t) => t.closed)).toBe(true);

    const e = createHarness();
    const controller = new AbortController();
    e.setObserver((t) => {
      if (t >= START_MS + 30_000) controller.abort();
    });
    const er = await e.provider.start(controller.signal);
    expect(er.stopReason).toBe("EXTERNAL_ABORT");
    expect(er.status.ledger.every((x) => x.dispatchedAtMs <= START_MS + 30_000)).toBe(true);
  });
});
